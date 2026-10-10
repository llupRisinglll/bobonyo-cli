import {afterEach, beforeEach, expect, test} from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChatMessage} from './state';
import {
	archiveTranscript,
	TRANSCRIPT_PAGE_BYTES,
	transcriptArchiveInfo,
} from './transcript-archive';
import {exportTranscript} from './transcript-export';

let root: string;
let previous: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'transcript-export-'));
	previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = root;
});
afterEach(() => {
	if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
	else process.env.BOBONYO_DATA_DIR = previous;
	rmSync(root, {recursive: true, force: true});
});
const row = (id: string, content = 'same'): ChatMessage => ({
	role: 'user',
	transcriptId: id,
	content,
});

test('exports forward across pages, preserves repeated content and row metadata, and merges running tail by identity', () => {
	const archived = Array.from({length: 235}, (_, i) =>
		row(`id-${i}`, `界🙂 repeated ${i % 3}`),
	);
	archived[0] = {
		...archived[0]!,
		role: 'assistant',
		kind: 'info',
		error: 'notice',
	};
	archived[234] = {
		...archived[234]!,
		role: 'tool',
		toolId: 'call',
		tool: {
			name: 'execute_bash',
			detail: 'echo 🙂',
			args: {command: 'echo 🙂'},
			output: 'in progress',
		},
	};
	archiveTranscript('session', archived);
	const finished = {
		...archived[234]!,
		tool: {...archived[234]!.tool!, output: 'complete 界🙂'},
	};
	const tail = row('tail', 'x'.repeat(16383) + '🙂界'.repeat(20000));
	const active = [archived[233]!, finished, tail, {...tail}];
	const before = JSON.stringify(active);
	const path = join(root, 'export.json');
	expect(exportTranscript('session', active, path)).toEqual({path, count: 236});
	expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
		id: 'session',
		messages: [...archived.slice(0, 234), finished, tail],
	});
	expect(JSON.stringify(active)).toBe(before);
	expect(transcriptArchiveInfo('session').count).toBe(235);
	expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('exports empty archives and deduplicates only stable identities, not equal content', () => {
	const path = join(root, 'export.json');
	exportTranscript('empty', [row('a'), row('b'), row('a')], path);
	expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
		id: 'empty',
		messages: [row('a'), row('b')],
	});
	exportTranscript('empty', [], path);
	expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
		id: 'empty',
		messages: [],
	});
});

test('exports exact oversized Unicode archive rows across raw chunk boundaries', () => {
	const giant = {
		...row('giant', '界🙂\\"\n'.repeat(TRANSCRIPT_PAGE_BYTES)),
		kind: 'info' as const,
		role: 'assistant' as const,
	};
	const archived = [row('old'), giant, row('new')];
	archiveTranscript('session', archived);
	const path = join(root, 'export.json');
	writeFileSync(path, 'previous');
	expect(exportTranscript('session', [], path).count).toBe(3);
	expect(readFileSync(path, 'utf8')).toBe(
		`{"id":"session","messages":${JSON.stringify(archived)}}\n`,
	);
	expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('skips archived oversized active IDs and exports only the updated active tail', () => {
	archiveTranscript('session', [
		row('old'),
		row('running', '界'.repeat(TRANSCRIPT_PAGE_BYTES)),
	]);
	const current = row('running', 'finished 🙂');
	const path = join(root, 'export.json');
	expect(exportTranscript('session', [current], path).count).toBe(2);
	expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
		id: 'session',
		messages: [row('old'), current],
	});
});

test('corrupted archive and active serialization failures preserve existing output', () => {
	archiveTranscript('session', [row('one')]);
	const path = join(root, 'export.json');
	writeFileSync(path, 'previous');
	const circular = row('circular');
	(circular as unknown as {self: unknown}).self = circular;
	expect(() => exportTranscript('empty', [circular], path)).toThrow();
	writeFileSync(
		join(transcriptArchiveInfo('session').directory, 'page-0.json'),
		'broken',
	);
	expect(() => exportTranscript('session', [], path)).toThrow();
	expect(readFileSync(path, 'utf8')).toBe('previous');
	expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('rejects symlink targets and ancestors without touching their destinations', () => {
	const victim = join(root, 'victim');
	writeFileSync(victim, 'untouched');
	const target = join(root, 'link');
	symlinkSync(victim, target);
	expect(() => exportTranscript('empty', [], target)).toThrow(
		'Unsafe export target',
	);
	const directoryLink = join(root, 'directory-link');
	symlinkSync(root, directoryLink);
	expect(() =>
		exportTranscript('empty', [], join(directoryLink, 'output')),
	).toThrow('Unsafe export directory');
	expect(readFileSync(victim, 'utf8')).toBe('untouched');
	expect(existsSync(join(root, 'output'))).toBe(false);
});

test('requires identities and preserves output on validation failure', () => {
	const path = join(root, 'export.json');
	writeFileSync(path, 'previous');
	expect(() =>
		exportTranscript('empty', [{role: 'user', content: 'missing'}], path),
	).toThrow('stable transcriptId');
	expect(readFileSync(path, 'utf8')).toBe('previous');
});
