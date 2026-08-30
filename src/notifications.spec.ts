import {describe, expect, test} from 'bun:test';
import {
	notificationBackend,
	notificationBackends,
	shouldNotifyTurnComplete,
} from './notifications';

describe('notification backend selection', () => {
	test('Herdr keeps its toast but also sends a desktop notification', () => {
		const options = {
			platform: 'linux' as const,
			herdr: true,
			hasNotifySend: true,
		};
		expect(notificationBackend(options)).toBe('herdr');
		expect(notificationBackends(options)).toEqual(['herdr', 'notify-send']);
	});

	test('uses native platform backends outside Herdr', () => {
		expect(
			notificationBackend({
				platform: 'linux',
				herdr: false,
				hasNotifySend: true,
			}),
		).toBe('notify-send');
		expect(notificationBackend({platform: 'darwin', herdr: false})).toBe(
			'osascript',
		);
		expect(notificationBackend({platform: 'win32', herdr: false})).toBe(
			'powershell',
		);
	});

	test('falls back to terminal bell when no desktop notifier exists', () => {
		expect(
			notificationBackend({
				platform: 'linux',
				herdr: false,
				hasNotifySend: false,
			}),
		).toBe('bell');
	});
});

describe('turn completion notification policy', () => {
	test('notifies completed turns even when more work is queued', () => {
		expect(shouldNotifyTurnComplete({interrupted: false})).toBe(true);
	});
	test('does not notify interrupted turns', () => {
		expect(shouldNotifyTurnComplete({interrupted: true})).toBe(false);
	});
});
