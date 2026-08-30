import {expect, test} from 'bun:test';
import {shouldPersistTaskCloseoutReply} from './task-closeout';

test('repeated text after write_tasks still persists', () => {
	expect(shouldPersistTaskCloseoutReply('Done.', 'Done.', true)).toBe(true);
});

test('duplicate closeout text without an intervening task tool stays deduped', () => {
	expect(shouldPersistTaskCloseoutReply('Done.', 'Done.', false)).toBe(false);
});

test('different closeout text always persists', () => {
	expect(shouldPersistTaskCloseoutReply('Finished.', 'Done.', false)).toBe(
		true,
	);
});
