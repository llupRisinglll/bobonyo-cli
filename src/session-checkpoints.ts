import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';
import type {ChatMessageLike} from './client';
import type {ChatMessage} from './state';
import type {GraphContextSnapshot} from './graph-context';

function checkpointsDir(): string {
	return join(bobonyoDataDir(), 'checkpoints');
}

export interface CheckpointData {
	id: string;
	name: string;
	createdAt: number;
	messages: ChatMessage[];
	context: ChatMessageLike[];
	graphContexts?: GraphContextSnapshot;
}

/** A4: save a named checkpoint snapshot of the current conversation. */
export function saveCheckpoint(
	name: string,
	messages: ChatMessage[],
	context: ChatMessageLike[],
	graphContexts?: GraphContextSnapshot,
): string {
	const dir = checkpointsDir();
	mkdirSync(dir, {recursive: true});
	const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
	const data: CheckpointData = {
		id: `ckpt_${Date.now().toString(36)}`,
		name: safe,
		createdAt: Date.now(),
		messages,
		context,
		graphContexts,
	};
	writeFileSync(
		join(dir, `${safe}.json`),
		`${JSON.stringify(data, null, 2)}\n`,
		'utf8',
	);
	return safe;
}

export function listCheckpoints(): CheckpointData[] {
	const dir = checkpointsDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(file => file.endsWith('.json'))
		.map(file => {
			try {
				return JSON.parse(
					readFileSync(join(dir, file), 'utf8'),
				) as CheckpointData;
			} catch {
				return null;
			}
		})
		.filter((data): data is CheckpointData => data !== null)
		.sort((a, b) => b.createdAt - a.createdAt);
}

export function loadCheckpoint(name: string): CheckpointData | null {
	const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
	const file = join(checkpointsDir(), `${safe}.json`);
	try {
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, 'utf8')) as CheckpointData;
	} catch {
		return null;
	}
}
