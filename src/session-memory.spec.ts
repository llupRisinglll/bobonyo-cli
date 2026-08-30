import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appendMemory, loadPersistentMemory} from './memory';
import {copySessionMemory} from './memory';

const originalData = process.env.BOBONYO_DATA_DIR;
const roots: string[] = [];

afterEach(() => {
	if (originalData === undefined) delete process.env.BOBONYO_DATA_DIR;
	else process.env.BOBONYO_DATA_DIR = originalData;
	for (const root of roots.splice(0))
		rmSync(root, {recursive: true, force: true});
});

test('forked session memory keeps current-session instructions', () => {
	const root = mkdtempSync(join(tmpdir(), 'bobonyo-session-memory-'));
	roots.push(root);
	process.env.BOBONYO_DATA_DIR = root;
	appendMemory('Keep this branch focused.', 'session', root, 'source');
	copySessionMemory('source', 'fork');
	expect(loadPersistentMemory(root, 'fork').session).toContain(
		'Keep this branch focused.',
	);
});
