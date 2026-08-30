import {expect, test} from 'bun:test';
import {
	persistentProcessStatus,
	startPersistentProcess,
	stopPersistentProcess,
	writePersistentProcess,
} from './persistent-process';

test('persistent process accepts input, reports output, and stops', async () => {
	const row = startPersistentProcess(
		'while read line; do echo "got:$line"; done',
		process.cwd(),
	);
	expect(writePersistentProcess(row.id, 'hello\n')).toContain('Wrote');
	await Bun.sleep(100);
	expect(persistentProcessStatus(row.id)).toContain('got:hello');
	expect(stopPersistentProcess(row.id)).toContain('Stopped');
});
