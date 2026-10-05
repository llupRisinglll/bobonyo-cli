import {Worker} from 'node:worker_threads';
import type {SessionData, SessionMeta} from './session';
import type {PreparedResume} from './resume-preparation';

/** Keep filesystem scans and large JSON parsing off the UI thread. */
async function readInWorker<T>(
	signal?: AbortSignal,
	id?: string,
	resume?: {ref?: string; session?: SessionData; maxMessages: number},
): Promise<T> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Session loading cancelled', 'AbortError'));
			return;
		}
		const worker = new Worker(
			new URL('./session-list.worker.ts', import.meta.url),
			{workerData: {id, resume}},
		);
		let settled = false;
		const finish = (error: Error | null, value?: T) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener('abort', abort);
			void worker.terminate();
			if (error) reject(error);
			else resolve(value!);
		};
		const abort = () =>
			finish(new DOMException('Session loading cancelled', 'AbortError'));
		signal?.addEventListener('abort', abort, {once: true});
		worker.once('message', (value: T) => finish(null, value));
		worker.once('error', error =>
			finish(error instanceof Error ? error : new Error(String(error))),
		);
		worker.once('exit', code => {
			if (!settled)
				finish(new Error(`Session loading worker exited (${code})`));
		});
	});
}

export function listSessionsAsync(
	signal?: AbortSignal,
): Promise<SessionMeta[]> {
	return readInWorker(signal);
}

export function loadSessionAsync(
	id: string,
	signal?: AbortSignal,
): Promise<SessionData | null> {
	return readInWorker(signal, id);
}

export function prepareSessionAsync(
	ref: string,
	maxMessages: number,
	signal?: AbortSignal,
	session?: SessionData,
): Promise<PreparedResume | null> {
	return readInWorker(signal, undefined, {ref, session, maxMessages});
}
