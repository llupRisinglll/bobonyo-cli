import {afterEach, beforeEach, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	appendFileSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	lstatSync,
	chmodSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	archiveTranscript,
	deleteTranscriptArchive,
	forkTranscriptArchive,
	exportTranscriptRecords,
	importLegacyCompactionTranscript,
	readTranscriptPage,
	readTranscriptPageById,
	seekTranscriptCursor,
	transcriptArchiveInfo,
	TRANSCRIPT_PAGE_BYTES,
} from './transcript-archive';

let root: string;
let previous: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'transcript-archive-'));
	previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = root;
});
afterEach(() => {
	if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
	else process.env.BOBONYO_DATA_DIR = previous;
	rmSync(root, {recursive: true, force: true});
});
const row = (id: string, content = id) => ({
	transcriptId: id,
	role: 'user' as const,
	content,
});

test('pages outgoing rows chronologically with exclusive cursors and bounded overlap dedupe', () => {
	const rows = Array.from({length: 250}, (_, i) => row(`id-${i}`));
	expect(archiveTranscript('a', rows).count).toBe(250);
	expect(archiveTranscript('a', rows.slice(-50)).appended).toBe(0);
	expect(archiveTranscript('a', [row('new', 'id-249')]).appended).toBe(1);
	const last = readTranscriptPage('a', undefined, 50);
	expect(last.messages).toHaveLength(50);
	expect(last.messages.at(-1)?.content).toBe('id-249');
	expect(last.beforeCursor).toBe(201);
	expect(
		readTranscriptPage('a', last.beforeCursor, 50).messages[0]?.content,
	).toBe('id-151');
	expect(readTranscriptPage('a', 1).messages).toEqual([rows[0]!]);
	expect(readTranscriptPage('a', 0).messages).toEqual([]);
	expect(transcriptArchiveInfo('a').count).toBe(251);
	expect(seekTranscriptCursor('a', 'id-100')).toBe(100);
	expect(
		readTranscriptPageById('a', {beforeId: 'id-100', limit: 2}).messages,
	).toEqual(rows.slice(98, 100));
	expect(
		readTranscriptPageById('a', {afterId: 'id-100', limit: 2}).messages,
	).toEqual(rows.slice(101, 103));
});

test('rejects missing identities and locked writers without committing partial rows', () => {
	expect(() =>
		archiveTranscript('a', [{role: 'user', content: 'missing'}]),
	).toThrow('transcriptId');
	archiveTranscript('a', [row('one')]);
	const directory = transcriptArchiveInfo('a').directory;
	writeFileSync(join(directory, 'writer.lock'), 'occupied');
	expect(() => archiveTranscript('a', [row('two')])).toThrow('locked');
	expect(readTranscriptPage('a').messages).toEqual([row('one')]);
});

test('byte budgets retain exact oversized rows on disk but never parse them', () => {
	const giant = row('giant', '界'.repeat(TRANSCRIPT_PAGE_BYTES));
	archiveTranscript('a', [row('old'), giant, row('new')]);
	const page = readTranscriptPage('a', undefined, 50, 1024);
	expect(page.bytesRead).toBeLessThanOrEqual(1024);
	expect(page.messages).toHaveLength(3);
	expect(page.oversized).toHaveLength(1);
	expect(page.messages[1]?.content).toContain(
		'Oversized archived transcript row',
	);
	const full = JSON.parse(readFileSync(page.oversized[0]!.path, 'utf8'));
	expect(full[0]).toEqual(giant);
	expect(readTranscriptPage('a', undefined, 50, 1).messages).toEqual([]);
});

test('does not read unrelated pages and preserves immutable pages on further appends', () => {
	archiveTranscript(
		'a',
		Array.from({length: 201}, (_, i) => row(`id-${i}`)),
	);
	const dir = transcriptArchiveInfo('a').directory;
	const first = readFileSync(join(dir, 'page-0.json'), 'utf8');
	writeFileSync(join(dir, 'page-0.json'), 'invalid deliberately');
	expect(readTranscriptPage('a', undefined, 1).messages[0]?.content).toBe(
		'id-200',
	);
	writeFileSync(join(dir, 'page-0.json'), first);
	archiveTranscript('a', [row('last')]);
	expect(readFileSync(join(dir, 'page-0.json'), 'utf8')).toBe(first);
});

test('fork copies independent committed archive; delete and unsafe ids stay isolated', () => {
	archiveTranscript('../unsafe', [row('one')]);
	forkTranscriptArchive('../unsafe', 'fork');
	archiveTranscript('fork', [row('two')]);
	expect(transcriptArchiveInfo('../unsafe').count).toBe(1);
	expect(transcriptArchiveInfo('fork').count).toBe(2);
	deleteTranscriptArchive('../unsafe');
	expect(transcriptArchiveInfo('../unsafe').count).toBe(0);
	expect(readTranscriptPage('fork').messages).toHaveLength(2);
	expect(existsSync(join(root, 'unsafe'))).toBe(false);
});

test('bounded legacy import merges ordered overlap without losing legitimate identical rows', () => {
	mkdirSync(join(root, 'compaction-transcripts'));
	const path = join(root, 'compaction-transcripts', 'legacy.jsonl');
	const one = {role: 'user', content: 'same'};
	const two = {role: 'assistant', content: 'reply'};
	writeFileSync(
		path,
		[
			JSON.stringify({sessionId: 'legacy', messages: [one, two], context: []}),
			JSON.stringify({
				sessionId: 'legacy',
				messages: [two, one, one],
				context: [],
			}),
		].join('\n') + '\n',
	);
	expect(importLegacyCompactionTranscript('legacy').status).toBe('imported');
	expect(
		readTranscriptPage('legacy').messages.map(message => message.content),
	).toEqual(['same', 'reply', 'same', 'same']);
	expect(importLegacyCompactionTranscript('legacy').status).toBe(
		'already-present',
	);
	expect(existsSync(path)).toBe(true);
	writeFileSync(
		join(root, 'compaction-transcripts', 'large.jsonl'),
		'x'.repeat(1025),
	);
	expect(importLegacyCompactionTranscript('large', 1024).status).toBe(
		'too-large',
	);
	expect(transcriptArchiveInfo('large').count).toBe(0);
});

test('ignores failed append bytes and stale ID locators without deduping unrelated committed rows', () => {
	archiveTranscript('a', [row('one')]);
	const dir = transcriptArchiveInfo('a').directory;
	const stale = join(
		dir,
		'ids',
		createHash('sha256').update('stale').digest('hex'),
	);
	writeFileSync(stale, '1');
	appendFileSync(join(dir, 'index.bin'), Buffer.alloc(272));
	writeFileSync(join(dir, 'page-1.json'), 'uncommitted');
	archiveTranscript('a', [row('two')]);
	archiveTranscript('a', [row('stale')]);
	expect(
		readTranscriptPage('a').messages.map(message => message.content),
	).toEqual(['one', 'two', 'stale']);
	expect(transcriptArchiveInfo('a').count).toBe(3);
});

test('rejects symlink archive directories without touching victims', () => {
	const victim = join(root, 'victim');
	mkdirSync(victim);
	writeFileSync(join(victim, 'untouched'), 'keep');
	const base = join(root, 'transcript-archives');
	symlinkSync(victim, base);
	expect(() => archiveTranscript('a', [row('one')])).toThrow();
	expect(fs.readdirSync(victim)).toEqual(['untouched']);
	rmSync(base);
	mkdirSync(base);
	symlinkSync(victim, join(base, 'session-a'));
	expect(() => archiveTranscript('a', [row('one')])).toThrow();
	expect(() => readTranscriptPage('a')).toThrow();
	expect(fs.readdirSync(victim)).toEqual(['untouched']);
	rmSync(join(base, 'session-a'));
	archiveTranscript('a', [row('one')]);
	const dir = transcriptArchiveInfo('a').directory;
	rmSync(join(dir, 'ids'), {recursive: true});
	symlinkSync(victim, join(dir, 'ids'));
	expect(() => archiveTranscript('a', [row('two')])).toThrow();
	expect(fs.readdirSync(victim)).toEqual(['untouched']);
});

test('temporary and locator symlinks never truncate victims', () => {
	const victim = join(root, 'victim');
	writeFileSync(victim, 'keep exactly');
	for (const attack of ['page-1.json.tmp', 'manifest.json.tmp', 'locator']) {
		const id = `attack-${attack}`;
		archiveTranscript(id, [row('one')]);
		const dir = transcriptArchiveInfo(id).directory;
		const path =
			attack === 'locator'
				? join(dir, 'ids', createHash('sha256').update('two').digest('hex'))
				: join(dir, attack);
		symlinkSync(victim, path);
		expect(() => archiveTranscript(id, [row('two')])).toThrow();
		expect(readFileSync(victim, 'utf8')).toBe('keep exactly');
		expect(transcriptArchiveInfo(id).count).toBe(1);
	}
});

test('fork rejects symlink sources and destinations and syncs every published file privately', () => {
	archiveTranscript('source', [row('one')]);
	const source = transcriptArchiveInfo('source').directory;
	const victim = join(root, 'victim');
	writeFileSync(victim, 'keep exactly');
	const page = join(source, 'page-0.json');
	const original = readFileSync(page);
	rmSync(page);
	symlinkSync(victim, page);
	expect(() => forkTranscriptArchive('source', 'bad')).toThrow();
	expect(readFileSync(victim, 'utf8')).toBe('keep exactly');
	expect(transcriptArchiveInfo('bad').count).toBe(0);
	rmSync(page);
	writeFileSync(page, original);
	const sourceLocator = join(
		source,
		'ids',
		createHash('sha256').update('one').digest('hex'),
	);
	rmSync(sourceLocator);
	symlinkSync(victim, sourceLocator);
	expect(() => forkTranscriptArchive('source', 'bad-locator')).toThrow();
	expect(readFileSync(victim, 'utf8')).toBe('keep exactly');
	expect(transcriptArchiveInfo('bad-locator').count).toBe(0);
	rmSync(sourceLocator);
	writeFileSync(sourceLocator, '0');
	const target = transcriptArchiveInfo('dest').directory;
	mkdirSync(target);
	symlinkSync(victim, join(target, 'page-0.json'));
	expect(() => forkTranscriptArchive('source', 'dest')).toThrow();
	expect(readFileSync(victim, 'utf8')).toBe('keep exactly');
	const synced: string[] = [];
	const events: string[] = [];
	const realSync = fs.fsyncSync;
	const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
		const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
		synced.push(path);
		events.push(`sync:${path}`);
		realSync(fd);
	});
	const realRename = fs.renameSync;
	const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
		events.push(`publish:${to}`);
		realRename(from, to);
	});
	try {
		forkTranscriptArchive('source', 'good');
	} finally {
		sync.mockRestore();
		rename.mockRestore();
	}
	const good = transcriptArchiveInfo('good').directory;
	for (const suffix of [
		'page-0.json',
		'index.bin',
		`ids/${createHash('sha256').update('one').digest('hex')}`,
		'manifest.json.tmp',
		'ids',
	]) {
		expect(synced).toContain(join(good, suffix));
		expect(events.indexOf(`sync:${join(good, suffix)}`)).toBeLessThan(
			events.indexOf(`publish:${join(good, 'manifest.json')}`),
		);
	}
	expect(synced.at(-1)).toBe(join(root, 'transcript-archives'));
	expect(lstatSync(join(good, 'page-0.json')).mode & 0o777).toBe(0o600);
});

test('existing directories and files become private', () => {
	archiveTranscript('a', [row('one')]);
	const dir = transcriptArchiveInfo('a').directory;
	for (const path of [join(root, 'transcript-archives'), dir, join(dir, 'ids')])
		chmodSync(path, 0o777);
	chmodSync(join(dir, 'index.bin'), 0o666);
	archiveTranscript('a', [row('two')]);
	for (const path of [join(root, 'transcript-archives'), dir, join(dir, 'ids')])
		expect(lstatSync(path).mode & 0o777).toBe(0o700);
	expect(lstatSync(join(dir, 'index.bin')).mode & 0o777).toBe(0o600);
});

test('legacy budget rejects nonfinite, fractional and nonpositive values before reading', () => {
	for (const budget of [NaN, Infinity, -Infinity, 0, -1, 1.5])
		expect(() => importLegacyCompactionTranscript('missing', budget)).toThrow(
			'budget',
		);
});

test('legacy repeated signatures serialize once per row instead of quadratic overlap retries', () => {
	mkdirSync(join(root, 'compaction-transcripts'));
	const repeated = Array.from({length: 2000}, () => ({
		role: 'user',
		content: 'same',
	}));
	const snapshots = [
		{
			sessionId: 'repeat',
			messages: [...repeated, {role: 'assistant', content: 'first'}],
		},
		{
			sessionId: 'repeat',
			messages: [...repeated, {role: 'assistant', content: 'second'}],
		},
	];
	writeFileSync(
		join(root, 'compaction-transcripts', 'repeat.jsonl'),
		snapshots.map(value => JSON.stringify(value)).join('\n'),
	);
	let operations = 0;
	const stringify = JSON.stringify;
	const spy = spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
		if (
			value &&
			typeof value === 'object' &&
			'role' in value &&
			++operations > 12000
		)
			throw new Error('Quadratic legacy serialization');
		return stringify(value);
	});
	try {
		expect(importLegacyCompactionTranscript('repeat').count).toBe(4002);
	} finally {
		spy.mockRestore();
	}
	expect(operations).toBeLessThanOrEqual(8004);
});

test('legacy recovery imports older prefix only, leaving retained overlap and new turns active', () => {
	mkdirSync(join(root, 'compaction-transcripts'));
	const active = [
		row('retained-user', 'same'),
		row('retained-answer', 'answer'),
		row('new', 'new turn'),
	];
	writeFileSync(
		join(root, 'compaction-transcripts', 'recover.jsonl'),
		JSON.stringify({
			sessionId: 'recover',
			messages: [
				{role: 'user', content: 'same'},
				{role: 'assistant', content: 'old answer'},
				{role: 'user', content: 'same'},
				{role: 'assistant', content: 'answer'},
			],
		}),
	);
	const retainedRows = [
		active[0]!,
		{...active[1]!, role: 'assistant' as const},
		active[2]!,
	];
	expect(
		importLegacyCompactionTranscript('recover', 1024 * 1024, retainedRows)
			.count,
	).toBe(2);
	const imported = readTranscriptPage('recover').messages;
	expect(imported.map(value => value.content)).toEqual(['same', 'old answer']);
	expect(seekTranscriptCursor('recover', 'retained-user')).toBeUndefined();
	expect(seekTranscriptCursor('recover', 'retained-answer')).toBeUndefined();
	expect(imported[0]?.transcriptId).not.toBe('retained-user');
	expect(active[2]?.transcriptId).toBe('new');
	expect(archiveTranscript('recover', retainedRows.slice(0, 2)).appended).toBe(
		2,
	);
});

test('legacy import does not freeze an active tool output before final eviction', () => {
	mkdirSync(join(root, 'compaction-transcripts'));
	const tool = {
		transcriptId: 'active-tool',
		role: 'tool' as const,
		content: 'tool result',
		toolId: 'call-one',
		tool: {name: 'execute_bash', detail: 'echo result', output: 'OLD'},
	};
	const active = [row('active-user', 'run it'), tool];
	writeFileSync(
		join(root, 'compaction-transcripts', 'mutation.jsonl'),
		JSON.stringify({
			sessionId: 'mutation',
			messages: [
				{role: 'user', content: 'older'},
				...active.map(value => ({...value, transcriptId: undefined})),
			],
		}),
	);
	importLegacyCompactionTranscript('mutation', 1024 * 1024, active);
	tool.tool.output = 'FINAL';
	archiveTranscript('mutation', active);
	expect(readTranscriptPage('mutation').messages.at(-1)?.tool?.output).toBe(
		'FINAL',
	);
	expect(transcriptArchiveInfo('mutation').count).toBe(3);
});

test('raw export streams oversized exact records in bounded chunks and skips active IDs', () => {
	const giant = row('giant', '界'.repeat(TRANSCRIPT_PAGE_BYTES));
	archiveTranscript('export', [row('old'), giant, row('active')]);
	const chunks: Buffer[] = [];
	const count = exportTranscriptRecords(
		'export',
		chunk => {
			const buffer = Buffer.from(chunk);
			expect(buffer.length).toBeLessThanOrEqual(65536);
			chunks.push(buffer);
		},
		new Set(['active']),
	);
	expect(count).toBe(2);
	expect(JSON.parse(`[${Buffer.concat(chunks).toString('utf8')}]`)).toEqual([
		row('old'),
		giant,
	]);
});
