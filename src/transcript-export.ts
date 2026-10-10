/** Display-only export. Never inserts archived rows into provider context. */
import {randomUUID} from 'node:crypto';
import {
	closeSync,
	constants,
	fsyncSync,
	lstatSync,
	openSync,
	renameSync,
	rmSync,
	writeSync,
} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import type {ChatMessage} from './state';
import {exportTranscriptRecords} from './transcript-archive';

function checkDirectory(path: string): void {
	const parent = dirname(path);
	if (parent !== path) checkDirectory(parent);
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`Unsafe export directory: ${path}`);
}

function checkTarget(path: string): void {
	try {
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
			throw new Error(`Unsafe export target: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

/** Bound encoding buffers without splitting UTF-16 surrogate pairs. */
function writeBuffer(fd: number, buffer: Buffer): void {
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(fd, buffer, offset, buffer.length - offset);
		if (!written) throw new Error('Short transcript export write');
		offset += written;
	}
}

function writeText(fd: number, text: string): void {
	for (let start = 0; start < text.length;) {
		let end = Math.min(text.length, start + 16384);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		const buffer = Buffer.from(text.slice(start, end), 'utf8');
		writeBuffer(fd, buffer);
		start = end;
	}
}

/**
 * Atomically replace a JSON export after successful serialization and file sync.
 * Archive memory is bounded to 64KiB raw chunks; identity tracking is active-tail only.
 * Archived copies of active IDs are skipped; the current tail follows archived rows.
 * Serialization uses at most one full active row, never the complete transcript.
 * Concurrent archive appends after the initial count are excluded from this snapshot.
 * Oversized archived records are copied exactly without decoding or parsing them.
 * Rename publication is atomic, not a guarantee against a subsequent power failure.
 */
export function exportTranscript(
	sessionId: string,
	activeRows: readonly ChatMessage[],
	targetPath: string,
): {path: string; count: number} {
	const active = new Map<string, ChatMessage>();
	for (const row of activeRows) {
		if (!row.transcriptId)
			throw new Error('Transcript export requires stable transcriptId values');
		active.set(row.transcriptId, row);
	}
	const target = resolve(targetPath);
	checkDirectory(dirname(target));
	checkTarget(target);
	const temporary = join(
		dirname(target),
		`.${basename(target)}.${randomUUID()}.tmp`,
	);
	let fd: number | undefined;
	let created = false;
	let count = 0;
	try {
		fd = openSync(
			temporary,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		created = true;
		writeText(fd, `{"id":${JSON.stringify(sessionId)},"messages":[`);
		count = exportTranscriptRecords(
			sessionId,
			chunk => {
				if (typeof chunk === 'string') writeText(fd!, chunk);
				else writeBuffer(fd!, chunk);
			},
			new Set(active.keys()),
		);
		const emit = (row: ChatMessage) => {
			const text = JSON.stringify(row);
			if (count) writeText(fd!, ',');
			writeText(fd!, text);
			count++;
		};
		for (const row of active.values()) emit(row);
		writeText(fd, ']}\n');
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		checkTarget(target);
		renameSync(temporary, target);
		created = false;
		return {path: target, count};
	} finally {
		try {
			if (fd !== undefined) closeSync(fd);
		} finally {
			if (created) rmSync(temporary, {force: true});
		}
	}
}
