import {Database} from 'bun:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';

export type WorkNodeStatus =
	| 'pending'
	| 'ready'
	| 'running'
	| 'waiting'
	| 'completed'
	| 'failed'
	| 'cancelled';

export interface WorkNode {
	id: string;
	graphId: string;
	kind: string;
	status: WorkNodeStatus;
	title: string;
	result?: string;
	metadata?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface WorkGraphSnapshot {
	graphId: string;
	nodes: WorkNode[];
	edges: Array<{fromNodeId: string; toNodeId: string; kind: string}>;
}

export interface ResearchMemory {
	id: string;
	scope: 'project' | 'session' | 'user';
	key: string;
	text: string;
	sourceNodeId?: string;
	inputHash?: string;
	createdAt: number;
	updatedAt: number;
}

let database: Database | undefined;

function db(): Database {
	if (database) return database;
	const dir = bobonyoDataDir();
	mkdirSync(dir, {recursive: true});
	database = new Database(join(dir, 'bobonyo.sqlite'));
	database.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS work_graphs (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS work_nodes (
			id TEXT PRIMARY KEY,
			graph_id TEXT NOT NULL REFERENCES work_graphs(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			status TEXT NOT NULL,
			title TEXT NOT NULL,
			result TEXT,
			metadata TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS work_edges (
			from_node_id TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
			to_node_id TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			PRIMARY KEY (from_node_id, to_node_id, kind)
		);
		CREATE TABLE IF NOT EXISTS work_events (
			id TEXT PRIMARY KEY,
			graph_id TEXT NOT NULL,
			node_id TEXT,
			type TEXT NOT NULL,
			payload TEXT,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS research_memory (
			id TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			key TEXT NOT NULL,
			text TEXT NOT NULL,
			source_node_id TEXT,
			input_hash TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE (scope, key)
		);
	`);
	try {
		database.exec('ALTER TABLE work_nodes ADD COLUMN metadata TEXT');
	} catch {
		// Column already exists.
	}
	return database;
}

export function createWorkGraph(
	id: string,
	sessionId: string,
	title: string,
	now = Date.now(),
): void {
	db()
		.query(
			'INSERT OR IGNORE INTO work_graphs (id, session_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
		)
		.run(id, sessionId, title, 'running', now, now);
}

export function upsertWorkNode(node: WorkNode): void {
	db()
		.query(
			`INSERT INTO work_nodes
			(id, graph_id, kind, status, title, result, metadata, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET status=excluded.status, result=excluded.result, metadata=excluded.metadata, updated_at=excluded.updated_at`,
		)
		.run(
			node.id,
			node.graphId,
			node.kind,
			node.status,
			node.title,
			node.result ?? null,
			node.metadata ? JSON.stringify(node.metadata) : null,
			node.createdAt,
			node.updatedAt,
		);
}

export function getWorkGraph(graphId: string): WorkGraphSnapshot {
	const database = db();
	const nodes = database
		.query(
			`SELECT id, graph_id as graphId, kind, status, title, result,
			 metadata, created_at as createdAt, updated_at as updatedAt
			 FROM work_nodes WHERE graph_id = ? ORDER BY created_at, id`,
		)
		.all(graphId)
		.map(row => {
			const value = row as WorkNode & {metadata?: string | null};
			return {
				...value,
				...(value.metadata
					? {metadata: JSON.parse(value.metadata) as Record<string, unknown>}
					: {}),
			};
		});
	const edges = database
		.query(
			' SELECT from_node_id as fromNodeId, to_node_id as toNodeId, kind FROM work_edges WHERE from_node_id IN (SELECT id FROM work_nodes WHERE graph_id = ?) OR to_node_id IN (SELECT id FROM work_nodes WHERE graph_id = ?)',
		)
		.all(graphId, graphId) as Array<{
		fromNodeId: string;
		toNodeId: string;
		kind: string;
	}>;
	return {graphId, nodes, edges};
}

export function requiredNodesSettled(graphId: string, nodeId: string): boolean {
	const snapshot = getWorkGraph(graphId);
	const required = new Set(
		snapshot.edges
			.filter(edge => edge.toNodeId === nodeId && edge.kind === 'depends_on')
			.map(edge => edge.fromNodeId),
	);
	return snapshot.nodes
		.filter(node => required.has(node.id))
		.every(node => ['completed', 'failed', 'cancelled'].includes(node.status));
}

export function consolidationInput(
	graphId: string,
	nodeId: string,
): Array<{nodeId: string; status: WorkNodeStatus; result?: string}> {
	const snapshot = getWorkGraph(graphId);
	const ids = new Set(
		snapshot.edges
			.filter(edge => edge.toNodeId === nodeId && edge.kind === 'depends_on')
			.map(edge => edge.fromNodeId),
	);
	return snapshot.nodes
		.filter(node => ids.has(node.id))
		.sort((left, right) => left.id.localeCompare(right.id))
		.map(node => ({nodeId: node.id, status: node.status, result: node.result}));
}

export function addWorkEdge(
	fromNodeId: string,
	toNodeId: string,
	kind = 'depends_on',
): void {
	db()
		.query(
			'INSERT OR IGNORE INTO work_edges (from_node_id, to_node_id, kind) VALUES (?, ?, ?)',
		)
		.run(fromNodeId, toNodeId, kind);
}

export function recordWorkEvent(
	id: string,
	graphId: string,
	type: string,
	nodeId?: string,
	payload?: unknown,
	now = Date.now(),
): boolean {
	const result = db()
		.query(
			'INSERT OR IGNORE INTO work_events (id, graph_id, node_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
		)
		.run(
			id,
			graphId,
			nodeId ?? null,
			type,
			payload ? JSON.stringify(payload) : null,
			now,
		);
	return result.changes > 0;
}

export function saveResearchMemory(memory: ResearchMemory): void {
	db()
		.query(
			`INSERT INTO research_memory
			(id, scope, key, text, source_node_id, input_hash, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(scope, key) DO UPDATE SET text=excluded.text,
			 source_node_id=excluded.source_node_id, input_hash=excluded.input_hash,
			 updated_at=excluded.updated_at`,
		)
		.run(
			memory.id,
			memory.scope,
			memory.key,
			memory.text,
			memory.sourceNodeId ?? null,
			memory.inputHash ?? null,
			memory.createdAt,
			memory.updatedAt,
		);
}

export function findResearchMemory(
	scope: ResearchMemory['scope'],
	key: string,
	inputHash?: string,
): ResearchMemory | undefined {
	const row = db()
		.query(
			' SELECT id, scope, key, text, source_node_id as sourceNodeId, input_hash as inputHash, created_at as createdAt, updated_at as updatedAt FROM research_memory WHERE scope = ? AND key = ? AND (? IS NULL OR input_hash = ?) LIMIT 1',
		)
		.get(
			scope,
			key,
			inputHash ?? null,
			inputHash ?? null,
		) as ResearchMemory | null;
	return row ?? undefined;
}

export function researchMemoryKey(topic: string): string {
	return topic
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.slice(0, 240);
}

export function boundedResearchText(text: string): string {
	const safe = text
		.replace(
			/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
			'$1=[redacted]',
		)
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
		.trim();
	return safe.length > 16_000
		? `${safe.slice(0, 16_000)}\n… [finding truncated]`
		: safe;
}

export function researchInputHash(cwd: string): string {
	try {
		const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd});
		const status = Bun.spawnSync(['git', 'status', '--short'], {cwd});
		return `${head.stdout.toString().trim()}\n${status.stdout.toString()}`;
	} catch {
		return cwd;
	}
}
