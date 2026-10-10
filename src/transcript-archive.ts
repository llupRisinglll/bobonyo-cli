/** Display history only. Never reconstruct provider context from this store. */
import {createHash} from 'node:crypto';
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	lstatSync,
	openSync,
	opendirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';
import type {ChatMessage} from './state';

export const TRANSCRIPT_PAGE_BYTES = 256 * 1024;
export const TRANSCRIPT_PAGE_ROWS = 100;
const INDEX_BYTES = 272;
const MAX_READ_BYTES = 4 * 1024 * 1024;
type Row = ChatMessage & {transcriptId?: string};
interface Manifest {
	version: 1;
	count: number;
	pages: number;
}
const hash = (value: string) =>
	createHash('sha256').update(value).digest('hex');

function directory(sessionId: string): string {
	return join(
		bobonyoDataDir(),
		'transcript-archives',
		`session-${encodeURIComponent(sessionId)}`,
	);
}

/** Check each ancestor: O_NOFOLLOW alone protects only the final component. */
function checkedDirectory(
	path: string,
	create = false,
	privateMode = false,
): boolean {
	const absolute = resolve(path);
	const parent = dirname(absolute);
	if (parent !== absolute && !checkedDirectory(parent, create)) return false;
	try {
		const info = lstatSync(absolute);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error(`Unsafe transcript directory: ${absolute}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		if (!create) return false;
		mkdirSync(absolute, {mode: 0o700});
	}
	if (privateMode) {
		const fd = openSync(
			absolute,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			fchmodSync(fd, 0o700);
		} finally {
			closeSync(fd);
		}
	}
	return true;
}

function checkedArchiveDirectory(dir: string, create = false): boolean {
	if (!checkedDirectory(dirname(dir), create, create)) return false;
	return checkedDirectory(dir, create, create);
}

/** Refuse links, including hardlinks, before any task-owned replacement. */
function checkedExistingFile(path: string): boolean {
	try {
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
			throw new Error(`Unsafe transcript file: ${path}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function exclusiveFile(path: string, replaceUncommitted = false): number {
	if (replaceUncommitted && checkedExistingFile(path)) rmSync(path);
	return openSync(
		path,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
}

function privateWrite(
	path: string,
	text: string,
	replaceUncommitted = false,
): void {
	const fd = exclusiveFile(path, replaceUncommitted);
	try {
		exactWrite(fd, Buffer.from(text), 0);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function safeCopy(source: string, target: string, length?: number): void {
	checkedExistingFile(source);
	const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(input);
		if (!info.isFile() || info.nlink !== 1)
			throw new Error(`Unsafe transcript file: ${source}`);
		const size = length ?? info.size;
		if (info.size < size) throw new Error('Truncated transcript archive');
		const output = exclusiveFile(target, true);
		try {
			for (let pos = 0; pos < size; pos += 65536)
				exactWrite(
					output,
					exactRead(input, Math.min(65536, size - pos), pos),
					pos,
				);
			fsyncSync(output);
		} finally {
			closeSync(output);
		}
	} finally {
		closeSync(input);
	}
}

function manifest(dir: string): Manifest {
	if (!checkedArchiveDirectory(dir)) return {version: 1, count: 0, pages: 0};
	try {
		const fd = openSync(
			join(dir, 'manifest.json'),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			if (fstatSync(fd).size > 1024)
				throw new Error('Invalid transcript archive manifest');
			const value = JSON.parse(readFileSync(fd, 'utf8')) as Manifest;
			if (
				value.version !== 1 ||
				!Number.isSafeInteger(value.count) ||
				value.count < 0 ||
				!Number.isSafeInteger(value.pages) ||
				value.pages < 0
			)
				throw new Error('Invalid transcript archive manifest');
			return value;
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return {version: 1, count: 0, pages: 0};
		throw error;
	}
}

export function transcriptArchiveInfo(sessionId: string) {
	const dir = directory(sessionId);
	const meta = manifest(dir);
	return {...meta, directory: dir, hasHistory: meta.count > 0};
}

function lock<T>(dir: string, work: () => T): T {
	checkedArchiveDirectory(dir, true);
	let fd: number;
	try {
		fd = openSync(
			join(dir, 'writer.lock'),
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST')
			throw new Error(
				`Transcript archive locked: ${dir}. Retain active rows; inspect writer.lock before removing it.`,
			);
		throw error;
	}
	try {
		return work();
	} finally {
		closeSync(fd);
		rmSync(join(dir, 'writer.lock'), {force: true});
	}
}

function locator(dir: string, id: string): string {
	return join(dir, 'ids', hash(id));
}

function ordinal(dir: string, id: string, count: number): number | undefined {
	if (!checkedDirectory(join(dir, 'ids'))) return undefined;
	try {
		const fd = openSync(
			locator(dir, id),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			if (fstatSync(fd).size > 32)
				throw new Error('Invalid transcript ID locator');
			const value = Number(readFileSync(fd, 'utf8'));
			if (!Number.isSafeInteger(value) || value < 0 || value >= count)
				return undefined;
			const index = openSync(
				join(dir, 'index.bin'),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				const entry = exactRead(index, INDEX_BYTES, value * INDEX_BYTES);
				return entry
					.subarray(16, 16 + entry.readUInt32LE(12))
					.toString('utf8') === id
					? value
					: undefined;
			} finally {
				closeSync(index);
			}
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

export function seekTranscriptCursor(
	sessionId: string,
	id: string,
): number | undefined {
	const dir = directory(sessionId);
	return ordinal(dir, id, manifest(dir).count);
}

function exactRead(fd: number, length: number, position: number): Buffer {
	const buffer = Buffer.alloc(length);
	let got = 0;
	while (got < length) {
		const n = readSync(fd, buffer, got, length - got, position + got);
		if (!n) throw new Error('Truncated transcript archive');
		got += n;
	}
	return buffer;
}

function exactWrite(fd: number, data: Buffer, position: number): void {
	let written = 0;
	while (written < data.length) {
		const count = writeSync(
			fd,
			data,
			written,
			data.length - written,
			position + written,
		);
		if (!count) throw new Error('Short transcript archive write');
		written += count;
	}
}

function syncPath(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Synchronous commit-before-evict. Missing IDs and storage failures throw. */
export function archiveTranscript(sessionId: string, rows: Row[]) {
	for (const row of rows)
		if (!row.transcriptId || Buffer.byteLength(row.transcriptId) > 256)
			throw new Error(
				'Archived rows require a stable transcriptId of at most 256 UTF-8 bytes',
			);
	const dir = directory(sessionId);
	if (!rows.length) return {...transcriptArchiveInfo(sessionId), appended: 0};
	return lock(dir, () => {
		const current = manifest(dir);
		const seen = new Set<string>();
		const fresh = rows.filter(row => {
			const id = row.transcriptId!;
			if (seen.has(id) || ordinal(dir, id, current.count) !== undefined)
				return false;
			seen.add(id);
			return true;
		});
		if (!fresh.length) return {...current, appended: 0};
		checkedDirectory(join(dir, 'ids'), true, true);
		checkedExistingFile(join(dir, 'index.bin'));
		const fd = openSync(
			join(dir, 'index.bin'),
			constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1)
				throw new Error('Unsafe transcript archive index');
			fchmodSync(fd, 0o600);
			if (fstatSync(fd).size < current.count * INDEX_BYTES)
				throw new Error('Truncated transcript archive index');
			// Discard only uncommitted index bytes left by a failed append.
			ftruncateSync(fd, current.count * INDEX_BYTES);
			let page = current.pages;
			let count = current.count;
			let pending: Array<{row: Row; text: string}> = [];
			let bytes = 2;
			const flush = () => {
				if (!pending.length) return;
				const text = `[${pending.map(item => item.text).join(',')}]`;
				const path = join(dir, `page-${page}.json`);
				checkedExistingFile(path);
				privateWrite(`${path}.tmp`, text, true);
				renameSync(`${path}.tmp`, path);
				let offset = 1;
				for (const item of pending) {
					const length = Buffer.byteLength(item.text);
					if (length > 0xffffffff)
						throw new Error('Transcript row exceeds supported 4GiB size');
					const entry = Buffer.alloc(INDEX_BYTES);
					entry.writeUInt32LE(page, 0);
					entry.writeUInt32LE(offset, 4);
					entry.writeUInt32LE(length, 8);
					entry.writeUInt32LE(Buffer.byteLength(item.row.transcriptId!), 12);
					entry.write(item.row.transcriptId!, 16, 256, 'utf8');
					exactWrite(fd, entry, count * INDEX_BYTES);
					privateWrite(
						locator(dir, item.row.transcriptId!),
						String(count),
						true,
					);
					count++;
					offset += length + 1;
				}
				page++;
				pending = [];
				bytes = 2;
			};
			for (const row of fresh) {
				const text = JSON.stringify(row);
				const size = Buffer.byteLength(text);
				if (
					pending.length &&
					(pending.length === TRANSCRIPT_PAGE_ROWS ||
						bytes + size + 1 > TRANSCRIPT_PAGE_BYTES)
				)
					flush();
				pending.push({row, text});
				bytes += size + 1;
				if (size + 2 > TRANSCRIPT_PAGE_BYTES) flush();
			}
			flush();
			fsyncSync(fd);
			syncPath(join(dir, 'ids'));
			syncPath(dir);
			const next: Manifest = {version: 1, count, pages: page};
			checkedExistingFile(join(dir, 'manifest.json'));
			privateWrite(join(dir, 'manifest.json.tmp'), JSON.stringify(next), true);
			renameSync(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
			syncPath(dir);
			syncPath(dirname(dir));
			return {...next, appended: fresh.length};
		} finally {
			closeSync(fd);
		}
	});
}

export function appendTranscriptRows(sessionId: string, rows: Row[]): void {
	archiveTranscript(sessionId, rows);
}

export interface TranscriptReadOptions {
	beforeId?: string;
	afterId?: string;
	beforeCursor?: number;
	afterCursor?: number;
	limit?: number;
	maxBytes?: number;
}
export interface OversizedTranscriptRow {
	transcriptId?: string;
	path: string;
	bytes: number;
}
export interface TranscriptPage {
	rows: Row[];
	messages: Row[];
	beforeCursor: number;
	afterCursor: number;
	hasOlder: boolean;
	hasNewer: boolean;
	bytesRead: number;
	oversized: OversizedTranscriptRow[];
}

export function readTranscriptPage(
	sessionId: string,
	options?: TranscriptReadOptions,
): TranscriptPage;
export function readTranscriptPage(
	sessionId: string,
	beforeCursor?: number,
	limit?: number,
	maxBytes?: number,
): TranscriptPage;
export function readTranscriptPage(
	sessionId: string,
	options?: TranscriptReadOptions | number,
	requestedLimit = 50,
	requestedBytes = TRANSCRIPT_PAGE_BYTES,
): TranscriptPage {
	const dir = directory(sessionId);
	const meta = manifest(dir);
	const opts = typeof options === 'object' ? options : undefined;
	if (
		(opts?.beforeId || opts?.beforeCursor !== undefined) &&
		(opts?.afterId || opts?.afterCursor !== undefined)
	)
		throw new Error('Choose before or after, not both');
	const bounded = (value: number, fallback: number, max: number) =>
		Number.isFinite(value)
			? Math.max(1, Math.min(max, Math.floor(value)))
			: fallback;
	const limit = bounded(opts?.limit ?? requestedLimit, 50, 100);
	const maxBytes = bounded(
		opts?.maxBytes ?? requestedBytes,
		TRANSCRIPT_PAGE_BYTES,
		MAX_READ_BYTES,
	);
	const lookup = (id: string) => {
		const result = ordinal(dir, id, meta.count);
		if (result === undefined)
			throw new Error(`Unknown archived transcriptId: ${id}`);
		return result;
	};
	const clampCursor = (value: number) => {
		if (!Number.isSafeInteger(value))
			throw new Error('Invalid transcript archive cursor');
		return Math.max(0, Math.min(meta.count, value));
	};
	const forward = !!opts?.afterId || opts?.afterCursor !== undefined;
	const end = opts?.beforeId
		? lookup(opts.beforeId)
		: clampCursor(
				opts?.beforeCursor ??
					(typeof options === 'number' ? options : meta.count),
			);
	const start = forward
		? opts?.afterId
			? lookup(opts.afterId) + 1
			: clampCursor(opts!.afterCursor!)
		: end;
	const rows: Row[] = [];
	const oversized: OversizedTranscriptRow[] = [];
	let bytesRead = 0;
	let cursor = start;
	if (!meta.count)
		return {
			rows,
			messages: rows,
			beforeCursor: 0,
			afterCursor: 0,
			hasOlder: false,
			hasNewer: false,
			bytesRead,
			oversized,
		};
	const index = openSync(
		join(dir, 'index.bin'),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		for (
			let i = forward ? start : start - 1;
			i >= 0 && i < meta.count && rows.length < limit;
			i += forward ? 1 : -1
		) {
			const entry = exactRead(index, INDEX_BYTES, i * INDEX_BYTES);
			const page = entry.readUInt32LE(0);
			const offset = entry.readUInt32LE(4);
			const length = entry.readUInt32LE(8);
			const idLength = entry.readUInt32LE(12);
			if (page >= meta.pages || !length || !idLength || idLength > 256)
				throw new Error('Invalid transcript archive index entry');
			const transcriptId = entry.subarray(16, 16 + idLength).toString('utf8');
			const path = join(dir, `page-${page}.json`);
			let row: Row;
			if (length > Math.min(TRANSCRIPT_PAGE_BYTES, maxBytes)) {
				const content = `Oversized archived transcript row (${length} bytes). Full content: ${path}`;
				row = {role: 'assistant', kind: 'info', content, transcriptId};
				const noticeBytes = Buffer.byteLength(JSON.stringify(row));
				if (bytesRead + noticeBytes > maxBytes) break;
				oversized.push({path, bytes: length, transcriptId});
				bytesRead += noticeBytes;
			} else {
				if (bytesRead + length > maxBytes) break;
				const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					row = JSON.parse(
						exactRead(fd, length, offset).toString('utf8'),
					) as Row;
					if (
						!row ||
						row.transcriptId !== transcriptId ||
						typeof row.content !== 'string' ||
						!['user', 'assistant', 'tool'].includes(row.role)
					)
						throw new Error('Invalid archived transcript row');
				} finally {
					closeSync(fd);
				}
				bytesRead += length;
			}
			if (forward) rows.push(row);
			else rows.unshift(row);
			cursor = forward ? i + 1 : i;
		}
	} finally {
		closeSync(index);
	}
	const before = forward ? start : cursor;
	const after = forward ? cursor : start;
	return {
		rows,
		messages: rows,
		beforeCursor: before,
		afterCursor: after,
		hasOlder: before > 0,
		hasNewer: after < meta.count,
		bytesRead,
		oversized,
	};
}

/** Identity-based adapter used by the bounded display controller. */
export function readTranscriptPageById(
	sessionId: string,
	options: TranscriptReadOptions = {},
): TranscriptPage {
	return readTranscriptPage(sessionId, options);
}

/** Raw comma-separated records; caller writes surrounding JSON array brackets. */
export function exportTranscriptRecords(
	sessionId: string,
	write: (chunk: Buffer | string) => void,
	skipIds: ReadonlySet<string> = new Set(),
): number {
	const dir = directory(sessionId);
	const meta = manifest(dir);
	if (!meta.count) return 0;
	const index = openSync(
		join(dir, 'index.bin'),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	let count = 0;
	try {
		for (let i = 0; i < meta.count; i++) {
			const entry = exactRead(index, INDEX_BYTES, i * INDEX_BYTES);
			const page = entry.readUInt32LE(0);
			const offset = entry.readUInt32LE(4);
			const length = entry.readUInt32LE(8);
			const idLength = entry.readUInt32LE(12);
			if (
				page >= meta.pages ||
				!offset ||
				!length ||
				!idLength ||
				idLength > 256
			)
				throw new Error('Invalid transcript archive index entry');
			const id = entry.subarray(16, 16 + idLength).toString('utf8');
			if (skipIds.has(id)) continue;
			const path = join(dir, `page-${page}.json`);
			checkedExistingFile(path);
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				if (offset + length >= fstatSync(fd).size)
					throw new Error('Truncated transcript archive page');
				if (count) write(',');
				for (let position = 0; position < length; position += 65536)
					write(
						exactRead(
							fd,
							Math.min(65536, length - position),
							offset + position,
						),
					);
				count++;
			} finally {
				closeSync(fd);
			}
		}
	} finally {
		closeSync(index);
	}
	return count;
}

export function forkTranscriptArchive(
	sourceId: string,
	targetId: string,
): void {
	const source = directory(sourceId);
	const target = directory(targetId);
	if (source === target)
		throw new Error('Cannot fork transcript archive into itself');
	if (!checkedArchiveDirectory(source)) return;
	lock(source, () =>
		lock(target, () => {
			if (manifest(target).count)
				throw new Error('Target transcript archive already exists');
			const meta = manifest(source);
			checkedDirectory(join(source, 'ids'));
			checkedDirectory(join(target, 'ids'), true, true);
			for (let page = 0; page < meta.pages; page++)
				safeCopy(
					join(source, `page-${page}.json`),
					join(target, `page-${page}.json`),
				);
			if (meta.count) {
				safeCopy(
					join(source, 'index.bin'),
					join(target, 'index.bin'),
					meta.count * INDEX_BYTES,
				);
				const ids = opendirSync(join(source, 'ids'));
				try {
					let file;
					while ((file = ids.readSync()))
						safeCopy(
							join(source, 'ids', file.name),
							join(target, 'ids', file.name),
						);
				} finally {
					ids.closeSync();
				}
			}
			syncPath(join(target, 'ids'));
			syncPath(target);
			checkedExistingFile(join(target, 'manifest.json'));
			privateWrite(
				join(target, 'manifest.json.tmp'),
				JSON.stringify(meta),
				true,
			);
			renameSync(
				join(target, 'manifest.json.tmp'),
				join(target, 'manifest.json'),
			);
			syncPath(target);
			syncPath(dirname(target));
		}),
	);
}

export function deleteTranscriptArchive(sessionId: string): void {
	const dir = directory(sessionId);
	if (!checkedArchiveDirectory(dir)) return;
	lock(dir, () => rmSync(dir, {recursive: true, force: true}));
}

/** Explicit bounded migration; oversized legacy snapshots remain untouched. */
export function importLegacyCompactionTranscript(
	sessionId: string,
	maxBytes = 1024 * 1024,
	activeRows: Row[] = [],
): {
	status: 'imported' | 'already-present' | 'missing' | 'too-large';
	count?: number;
} {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		throw new Error(
			'Legacy transcript import budget must be a positive finite integer',
		);
	maxBytes = Math.min(MAX_READ_BYTES, maxBytes);
	if (transcriptArchiveInfo(sessionId).count)
		return {status: 'already-present'};
	const path = join(
		bobonyoDataDir(),
		'compaction-transcripts',
		`${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`,
	);
	if (!checkedDirectory(dirname(path))) return {status: 'missing'};
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return {status: 'missing'};
		throw error;
	}
	try {
		const size = fstatSync(fd).size;
		if (size > maxBytes) return {status: 'too-large'};
		const rows: Row[] = [];
		const signatures: string[] = [];
		for (const line of exactRead(fd, size, 0).toString('utf8').split('\n')) {
			if (!line.trim()) continue;
			let snapshot: {sessionId?: string; messages?: Row[]};
			try {
				snapshot = JSON.parse(line);
			} catch {
				continue;
			}
			if (
				!snapshot ||
				snapshot.sessionId !== sessionId ||
				!Array.isArray(snapshot.messages)
			)
				continue;
			const incoming = snapshot.messages.filter(
				row =>
					row &&
					['user', 'assistant', 'tool'].includes(row.role) &&
					typeof row.content === 'string' &&
					row.kind !== 'info',
			);
			const next = incoming.map(row =>
				JSON.stringify({...row, transcriptId: undefined}),
			);
			const overlap = orderedOverlap(signatures, next);
			rows.push(...incoming.slice(overlap));
			signatures.push(...next.slice(overlap));
		}
		const activeSignatures = activeRows.map(row =>
			JSON.stringify({...row, transcriptId: undefined}),
		);
		const activeOverlap = orderedOverlap(signatures, activeSignatures);
		// Retained rows can still settle or receive final tool outputs. Import only
		// the older prefix; write-before-evict will archive their final versions.
		rows.length -= activeOverlap;
		archiveTranscript(
			sessionId,
			rows.map((row, i) => ({
				...row,
				transcriptId: row.transcriptId ?? `legacy-${hash(sessionId)}-${i}`,
			})),
		);
		return {status: 'imported', count: rows.length};
	} finally {
		closeSync(fd);
	}
}

/** KMP prefix matcher: longest old suffix matching the incoming prefix. */
function orderedOverlap(previous: string[], next: string[]): number {
	if (!next.length) return 0;
	const prefix = new Uint32Array(next.length);
	for (let i = 1, matched = 0; i < next.length; i++) {
		while (matched && next[i] !== next[matched]) matched = prefix[matched - 1]!;
		if (next[i] === next[matched]) matched++;
		prefix[i] = matched;
	}
	let matched = 0;
	for (
		let i = Math.max(0, previous.length - next.length);
		i < previous.length;
		i++
	) {
		while (
			matched &&
			(matched === next.length || previous[i] !== next[matched])
		)
			matched = prefix[matched - 1]!;
		if (previous[i] === next[matched]) matched++;
	}
	return matched;
}
