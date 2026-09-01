import {expect, test} from 'bun:test';
import {
	persistentProcessStatus,
	startPersistentProcess,
	stopPersistentProcess,
	writePersistentProcess,
} from './persistent-process';
import {
	activeBgCount,
	activeBlockingBgCount,
	bgTasks,
	setBgTasks,
} from './bash';

test('persistent process accepts input, reports output, and stops', async () => {
	setBgTasks([]);
	let completed = false;
	const row = startPersistentProcess(
		'while read line; do echo "got:$line"; done',
		process.cwd(),
		'user',
		() => {
			completed = true;
		},
	);
	expect(activeBgCount()).toBe(1);
	expect(activeBlockingBgCount()).toBe(0);
	expect(bgTasks()[0]?.id).toBe(row.id);
	expect(bgTasks()[0]?.blocksCompletion).toBe(false);
	expect(writePersistentProcess(row.id, 'hello\n')).toContain('Wrote');
	await Bun.sleep(100);
	expect(persistentProcessStatus(row.id)).toContain('got:hello');
	expect(stopPersistentProcess(row.id)).toContain('Stopped');
	await Bun.sleep(100);
	expect(activeBgCount()).toBe(0);
	expect(completed).toBe(true);
	setBgTasks([]);
});
