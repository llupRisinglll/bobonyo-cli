import {describe, expect, test} from 'bun:test';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildExitSummary,
	flushExitSummary,
	rendererExitSummaryOptions,
	queueExitSummary,
	takeExitSummary,
	markRendererFinished,
} from './exit-summary';

describe('exit summary', () => {
	test('builds resume instructions for persisted conversations', () => {
		const summary = buildExitSummary({
			banner: 'BANNER',
			hasConversation: true,
			sessionName: 'Demo',
			createdAt: Date.UTC(2026, 9, 3, 22, 0, 0),
			sessionId: 'sess_demo_1',
		});
		expect(summary).toContain('BANNER');
		expect(summary).toContain('Session   Demo - 2026-10-03T22:00:00.000Z');
		expect(summary).toContain('Continue  bobonyo --resume sess_demo_1');
	});

	test('flushes queued summary exactly once after renderer teardown', () => {
		queueExitSummary('goodbye');
		const writes: string[] = [];
		flushExitSummary(text => writes.push(text));
		flushExitSummary(text => writes.push(text));
		expect(writes).toEqual(['goodbye']);
		expect(takeExitSummary()).toBe('');
	});

	test('renderer options keep shutdown from clearing final summary', () => {
		const options = rendererExitSummaryOptions();
		expect(options.clearOnShutdown).toBe(false);
		expect(typeof options.onDestroy).toBe('function');
	});

	test('only completed renderer teardown acknowledges launcher cleanup', () => {
		const directory = mkdtempSync(join(tmpdir(), 'bobonyo-exit-summary-'));
		const path = join(directory, 'finished');
		const previous = process.env.BOBONYO_RENDERER_FINISHED_FILE;
		try {
			process.env.BOBONYO_RENDERER_FINISHED_FILE = path;
			const options = rendererExitSummaryOptions();
			expect(() => statSync(path)).toThrow();
			options.onDestroy();
			expect(readFileSync(path, 'utf8')).toBe('renderer-finished-v1\n');
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			if (previous === undefined)
				delete process.env.BOBONYO_RENDERER_FINISHED_FILE;
			else process.env.BOBONYO_RENDERER_FINISHED_FILE = previous;
			rmSync(directory, {recursive: true, force: true});
		}
	});

	test('handshake never overwrites existing files or follows symlinks', () => {
		const directory = mkdtempSync(join(tmpdir(), 'bobonyo-exit-summary-'));
		try {
			const target = join(directory, 'target');
			const link = join(directory, 'finished');
			writeFileSync(target, 'unchanged');
			symlinkSync(target, link);
			markRendererFinished(link);
			markRendererFinished(target);
			expect(readFileSync(target, 'utf8')).toBe('unchanged');
			markRendererFinished(join(directory, 'missing', 'finished'));
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});
});
