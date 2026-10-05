import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
test('all compaction paths notify only after context installation', () => {
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	const body = app.slice(
		app.indexOf('const compactHistory = async'),
		app.indexOf('const tryAutoCompactHistory'),
	);
	expect(body).toContain('await installCompactedContext');
	expect(body).toContain('setContext(compacted)');
	expect(body).toContain('return commitScopedContext(compacted)');
	expect(app).not.toContain(
		"void runHooks({event: 'SessionStart', sessionSource: 'compact'})",
	);
	expect(app).toContain('await sessionLifecycleReady');
});
test('resume readiness includes asynchronous context restoration', () => {
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	const resume = app.slice(
		app.indexOf('const startNewSession'),
		app.indexOf('// `--resume'),
	);
	expect(resume).toContain('const restoreSession = (async () =>');
	expect(resume).toMatch(
		/Promise\.all\(\[\s*sessionLifecycleReady,\s*restoreSession,?\s*\]\)/,
	);
	expect(resume).toMatch(/if\s*\(controller\.signal\.aborted\) return;/);
	expect(resume).not.toContain('const restoringSessionId = hookSessionId()');
});
