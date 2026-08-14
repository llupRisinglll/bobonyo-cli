import {describe, expect, test} from 'bun:test';
import {
	anyModalOpen,
	glyphBlinkOn,
	loadingDots,
	setAgentsOpen,
	setCommandsOpen,
	setConnectOpen,
	setDetailsOpen,
	setEffortOpen,
	setModelOpen,
	setPendingTrust,
	setResumeOpen,
	setSettingsOpen,
	setStatusOpen,
} from './state';

function closeEveryModal(): void {
	setSettingsOpen(false);
	setCommandsOpen(false);
	setStatusOpen(false);
	setModelOpen(false);
	setAgentsOpen(false);
	setDetailsOpen(false);
	setResumeOpen(false);
	setConnectOpen(null);
	setEffortOpen(false);
	setPendingTrust(null);
}

describe('anyModalOpen (modal isolation gate)', () => {
	test('false when every modal is closed', () => {
		closeEveryModal();
		expect(anyModalOpen()).toBe(false);
	});

	test('true when ANY modal surface is open', () => {
		const opens: Array<() => void> = [
			() => setSettingsOpen(true),
			() => setCommandsOpen(true),
			() => setStatusOpen(true),
			() => setModelOpen(true),
			() => setAgentsOpen(true),
			() => setDetailsOpen(true),
			() => setResumeOpen(true),
			() => setConnectOpen({}),
			() => setEffortOpen(true),
			() => setPendingTrust({directory: '/x', resolve: () => {}}),
		];
		for (const open of opens) {
			closeEveryModal();
			open();
			expect(anyModalOpen()).toBe(true);
		}
		closeEveryModal();
	});
});

describe('glyphBlinkOn', () => {
	test('blinks on a 500ms cadence (4 frames per 100ms tick)', () => {
		// Frames 0-3 (0-300ms) visible, 4-7 (400-700ms) hidden, 8+ visible.
		expect(glyphBlinkOn(0)).toBe(true);
		expect(glyphBlinkOn(2)).toBe(true);
		expect(glyphBlinkOn(3)).toBe(true);
		expect(glyphBlinkOn(4)).toBe(false);
		expect(glyphBlinkOn(6)).toBe(false);
		expect(glyphBlinkOn(7)).toBe(false);
		expect(glyphBlinkOn(8)).toBe(true);
	});
});

describe('loadingDots', () => {
	test('cycles 1→2→3 every 200ms', () => {
		expect(loadingDots(0)).toBe('.');
		expect(loadingDots(1)).toBe('.');
		expect(loadingDots(2)).toBe('..');
		expect(loadingDots(3)).toBe('..');
		expect(loadingDots(4)).toBe('...');
		expect(loadingDots(5)).toBe('...');
		expect(loadingDots(6)).toBe('.');
	});
});
