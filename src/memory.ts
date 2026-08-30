import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {bobonyoConfigDir, bobonyoDataDir} from './bobonyo-paths';
import {projectRoot} from './project-paths';

const USER_MEMORY_FILE = 'MEMORY.md';
const PROJECT_MEMORY_FILE = 'MEMORY.md';
const STRUCTURED_MEMORY_FILE = 'MEMORY.json';
const MAX_MEMORY_CHARS = 24_000;

export type MemoryScope = 'user' | 'project' | 'session';
export type MemoryStatus = 'active' | 'superseded' | 'rejected';

export interface MemoryRecord {
	id: string;
	scope: MemoryScope;
	category: string;
	text: string;
	priority: number;
	status: MemoryStatus;
	createdAt: number;
	updatedAt: number;
	lastConfirmedAt: number;
	source: 'user' | 'model' | 'project';
	supersededBy?: string;
}

function readMemoryFile(path: string): string {
	try {
		if (!existsSync(path)) return '';
		return readFileSync(path, 'utf8').trim();
	} catch {
		return '';
	}
}

function capMemory(text: string): string {
	if (text.length <= MAX_MEMORY_CHARS) return text;
	return `${text.slice(0, MAX_MEMORY_CHARS)}\n\n[MEMORY TRUNCATED — read MEMORY.md for full contents]`;
}

function memoryDir(path: string): string {
	return join(path, '..');
}

function structuredMemoryPath(
	scope: MemoryScope,
	cwd: string,
	sessionId?: string,
): string {
	return scope === 'user'
		? join(bobonyoConfigDir(), STRUCTURED_MEMORY_FILE)
		: scope === 'project'
			? join(projectRoot(cwd), '.bobonyo', STRUCTURED_MEMORY_FILE)
			: sessionMemoryPath(sessionId!).replace(/\.md$/, '.json');
}

function readRecords(path: string): MemoryRecord[] {
	try {
		if (!existsSync(path)) return [];
		const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		return Array.isArray(value) ? (value as MemoryRecord[]) : [];
	} catch {
		return [];
	}
}

function writeRecords(path: string, records: MemoryRecord[]): void {
	mkdirSync(memoryDir(path), {recursive: true});
	writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function scopePath(
	scope: MemoryScope,
	cwd: string,
	sessionId?: string,
): string {
	if (scope === 'session' && !sessionId)
		throw new Error('session memory requires a session id');
	return scope === 'user'
		? userMemoryPath()
		: scope === 'project'
			? projectMemoryPath(cwd)
			: sessionMemoryPath(sessionId!);
}

function legacyMemory(path: string): MemoryRecord[] {
	const text = readMemoryFile(path);
	return text
		.split('\n')
		.map(line => line.match(/^\s*-\s+(.+)$/)?.[1]?.trim())
		.filter((value): value is string => Boolean(value))
		.map((text, index) => ({
			id: `legacy-${index + 1}`,
			scope: 'project' as MemoryScope,
			category: 'legacy',
			text,
			priority: 50,
			status: 'active' as MemoryStatus,
			createdAt: 0,
			updatedAt: 0,
			lastConfirmedAt: 0,
			source: 'user' as const,
		}));
}

export function userMemoryPath(): string {
	return join(bobonyoConfigDir(), USER_MEMORY_FILE);
}

export function projectMemoryPath(cwd = process.cwd()): string {
	return join(projectRoot(cwd), '.bobonyo', PROJECT_MEMORY_FILE);
}

export function sessionMemoryPath(sessionId: string): string {
	const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
	return join(bobonyoDataDir(), 'memory', 'sessions', `${safeId}.md`);
}

export function loadPersistentMemory(
	cwd = process.cwd(),
	sessionId?: string,
): {
	user: string;
	project: string;
	session: string;
} {
	return {
		user: capMemory(readMemoryFile(userMemoryPath())),
		project: capMemory(readMemoryFile(projectMemoryPath(cwd))),
		session: sessionId
			? capMemory(readMemoryFile(sessionMemoryPath(sessionId)))
			: '',
	};
}

export function listMemoryRecords(
	cwd = process.cwd(),
	sessionId?: string,
): MemoryRecord[] {
	const scopes: Array<[MemoryScope, string]> = [
		['user', userMemoryPath()],
		['project', projectMemoryPath(cwd)],
	];
	if (sessionId) scopes.push(['session', sessionMemoryPath(sessionId)]);
	return scopes.flatMap(([scope, markdownPath]) => {
		const records = readRecords(structuredMemoryPath(scope, cwd, sessionId));
		if (records.length) return records;
		return legacyMemory(markdownPath).map(record => ({...record, scope}));
	});
}

export function renderPersistentMemory(
	cwd = process.cwd(),
	sessionId?: string,
): string {
	const records = listMemoryRecords(cwd, sessionId).filter(
		record => record.status === 'active',
	);
	if (!records.length) return '';
	const sections = ['## PERSISTENT USER AND PROJECT MEMORY'];
	for (const scope of ['user', 'project', 'session'] as const) {
		const scoped = records.filter(record => record.scope === scope);
		if (!scoped.length) continue;
		sections.push(
			`### ${scope} memory\n${scoped
				.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
				.map(
					record =>
						`- [${record.id}] (${record.category}, priority ${record.priority}) ${record.text}`,
				)
				.join('\n')}`,
		);
	}
	sections.push(
		'Use memory as durable guidance, not unquestionable truth. Prefer explicit current user instructions and current repository state when they conflict. Do not invent, rewrite, or silently delete memory.',
	);
	return sections.join('\n\n');
}

export function appendMemory(
	text: string,
	scope: MemoryScope,
	cwd = process.cwd(),
	sessionId?: string,
	options: {
		category?: string;
		priority?: number;
		source?: MemoryRecord['source'];
	} = {},
): string {
	const path = scopePath(scope, cwd, sessionId);
	const trimmed = text.trim();
	if (!trimmed) throw new Error('memory text must not be empty');
	const now = Date.now();
	const id = `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const structuredPath = structuredMemoryPath(scope, cwd, sessionId);
	const records = readRecords(structuredPath);
	if (!records.length) {
		for (const legacy of legacyMemory(path)) {
			records.push({
				...legacy,
				scope,
				id: `${scope}-legacy-${records.length + 1}`,
			});
		}
	}
	const category = options.category?.trim() || 'guidance';
	for (const record of records) {
		if (
			category !== 'guidance' &&
			record.status === 'active' &&
			record.category === category
		) {
			record.status = 'superseded';
			record.updatedAt = now;
			record.supersededBy = id;
		}
	}
	records.push({
		id,
		scope,
		category,
		text: trimmed,
		priority: Math.max(0, Math.min(100, options.priority ?? 50)),
		status: 'active',
		createdAt: now,
		updatedAt: now,
		lastConfirmedAt: now,
		source: options.source ?? 'user',
	});
	writeRecords(structuredPath, records);
	// Keep a readable Markdown projection for users and old tooling.
	const active = records.filter(record => record.status === 'active');
	const markdown = active.length
		? `# Bobonyo Memory\n\n${active.map(record => `- [${record.id}] (${record.category}) ${record.text}`).join('\n')}\n`
		: '# Bobonyo Memory\n';
	mkdirSync(memoryDir(path), {recursive: true});
	writeFileSync(path, markdown, 'utf8');
	return path;
}

export function clearMemory(
	scope: MemoryScope,
	cwd = process.cwd(),
	sessionId?: string,
): string {
	const path = scopePath(scope, cwd, sessionId);
	writeRecords(structuredMemoryPath(scope, cwd, sessionId), []);
	mkdirSync(memoryDir(path), {recursive: true});
	writeFileSync(path, '# Bobonyo Memory\n', 'utf8');
	return path;
}

export function forgetMemory(
	selector: string,
	cwd = process.cwd(),
	sessionId?: string,
): number {
	const value = selector.trim();
	if (!value) throw new Error('memory id or scope required');
	const scopes: MemoryScope[] =
		value === 'user' || value === 'project' || value === 'session'
			? [value]
			: ['user', 'project', ...(sessionId ? ['session' as const] : [])];
	let count = 0;
	for (const scope of scopes) {
		const path = structuredMemoryPath(scope, cwd, sessionId);
		const records = readRecords(path);
		for (const record of records) {
			if (
				record.id === value ||
				(value === scope && record.status === 'active')
			) {
				record.status = 'rejected';
				record.updatedAt = Date.now();
				count++;
			}
		}
		writeRecords(path, records);
	}
	return count;
}

export function copySessionMemory(
	fromSessionId: string,
	toSessionId: string,
): void {
	const source = sessionMemoryPath(fromSessionId);
	const target = sessionMemoryPath(toSessionId);
	mkdirSync(join(target, '..'), {recursive: true});
	if (existsSync(source)) copyFileSync(source, target);
	const structuredSource = source.replace(/\.md$/, '.json');
	if (existsSync(structuredSource)) {
		copyFileSync(structuredSource, target.replace(/\.md$/, '.json'));
	}
}
