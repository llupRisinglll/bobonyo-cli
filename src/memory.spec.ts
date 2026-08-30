import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
	appendMemory,
	clearMemory,
	forgetMemory,
	loadPersistentMemory,
	listMemoryRecords,
	renderPersistentMemory,
	sessionMemoryPath,
	userMemoryPath,
} from './memory';

const originalConfig = process.env.BOBONYO_CONFIG_DIR;
const originalData = process.env.BOBONYO_DATA_DIR;
const originalCwd = process.cwd();
const roots: string[] = [];

afterEach(() => {
	process.chdir(originalCwd);
	if (originalConfig === undefined) delete process.env.BOBONYO_CONFIG_DIR;
	else process.env.BOBONYO_CONFIG_DIR = originalConfig;
	if (originalData === undefined) delete process.env.BOBONYO_DATA_DIR;
	else process.env.BOBONYO_DATA_DIR = originalData;
	for (const root of roots.splice(0))
		rmSync(root, {recursive: true, force: true});
});

describe('persistent memory', () => {
	test('loads user and project memory into separate prompt sections', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-memory-'));
		roots.push(root);
		process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
		process.chdir(root);
		const userPath = appendMemory('Prefer concise replies.', 'user');
		const projectPath = appendMemory(
			'Run integration tests before build.',
			'project',
		);
		expect(existsSync(userPath)).toBe(true);
		expect(existsSync(projectPath)).toBe(true);
		const memory = loadPersistentMemory();
		expect(memory.user).toContain('Prefer concise replies.');
		expect(memory.project).toContain('Run integration tests before build.');
		const rendered = renderPersistentMemory();
		expect(rendered).toContain('PERSISTENT USER AND PROJECT MEMORY');
		expect(rendered).toContain('Prefer concise replies.');
		expect(rendered).toContain('Run integration tests before build.');
	});

	test('clearMemory keeps a readable empty memory file', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-memory-'));
		roots.push(root);
		process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
		const path = clearMemory('user');
		expect(path).toBe(userMemoryPath());
		expect(readFileSync(path, 'utf8')).toContain('Bobonyo Memory');
		expect(loadPersistentMemory().user).toBe('# Bobonyo Memory');
	});

	test('session memory is isolated by session id', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-memory-'));
		roots.push(root);
		process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
		process.env.BOBONYO_DATA_DIR = join(root, 'data');
		appendMemory('Keep this active task context.', 'session', root, 'sess-a');
		expect(loadPersistentMemory(root, 'sess-a').session).toContain(
			'Keep this active task context.',
		);
		expect(loadPersistentMemory(root, 'sess-b').session).toBe('');
		expect(sessionMemoryPath('sess-a')).toContain('sess-a.md');
	});

	test('new same-category guidance supersedes old record without deleting it', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-memory-'));
		roots.push(root);
		process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
		process.chdir(root);
		appendMemory('Use terse answers.', 'user', root, undefined, {
			category: 'style',
		});
		appendMemory('Use detailed answers.', 'user', root, undefined, {
			category: 'style',
		});
		const records = listMemoryRecords(root).filter(
			record => record.scope === 'user',
		);
		expect(records).toHaveLength(2);
		expect(records[0]?.status).toBe('superseded');
		expect(records[1]?.status).toBe('active');
		expect(renderPersistentMemory(root)).toContain('Use detailed answers.');
		expect(renderPersistentMemory(root)).not.toContain('Use terse answers.');
	});

	test('forget marks exact record rejected and keeps audit history', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-memory-'));
		roots.push(root);
		process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
		process.chdir(root);
		appendMemory('Do not rewrite user text.', 'user');
		const record = listMemoryRecords(root)[0]!;
		expect(forgetMemory(record.id, root)).toBe(1);
		expect(listMemoryRecords(root)[0]?.status).toBe('rejected');
		expect(renderPersistentMemory(root)).toBe('');
	});
});
