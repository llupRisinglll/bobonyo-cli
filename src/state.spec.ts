import {describe, expect, test} from 'bun:test';
import {
	anyModalOpen,
	compactingLabel,
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

describe('compactingLabel', () => {
	test('base label with ANIMATED dots on the loading cadence', () => {
		expect(compactingLabel(0)).toBe('Compacting context (LLM summary).');
		expect(compactingLabel(2)).toBe('Compacting context (LLM summary)..');
		expect(compactingLabel(4)).toBe('Compacting context (LLM summary)...');
		// The fixed "…" must NOT be baked in: the dots animate 1→2→3, so a
		// literal ellipsis would double the tail.
		expect(compactingLabel(0)).not.toContain('…');
	});
});

describe('capDisplayMessages (lazy display buffer)', () => {
	const msg = (role: 'user' | 'assistant' | 'tool', content: string) => ({
		role,
		content,
	});
	const {DISPLAY_MESSAGE_CAP, capDisplayMessages} = require('./state') as {
		DISPLAY_MESSAGE_CAP: number;
		capDisplayMessages: (m: unknown[]) => unknown[];
	};
	test('under the cap: unchanged (no marker row)', () => {
		const small = [msg('user', 'a'), msg('assistant', 'b')];
		expect(capDisplayMessages(small)).toBe(small);
	});
	test('over the cap: keeps the newest window + a trim marker at the head', () => {
		const many = Array.from({length: DISPLAY_MESSAGE_CAP + 20}, (_, i) =>
			msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`),
		);
		const capped = capDisplayMessages(many) as Array<{
			role: string;
			content: string;
			kind?: string;
		}>;
		// Marker row at the head, then the bounded window.
		expect(capped[0]!.kind).toBe('info');
		expect(capped[0]!.content).toContain('earlier messages trimmed');
		expect(capped.length).toBe(DISPLAY_MESSAGE_CAP + 1);
		// The newest message survives; the oldest non-marker content is the
		// newest window's head.
		expect(capped[capped.length - 1]!.content).toBe(
			`m${DISPLAY_MESSAGE_CAP + 19}`,
		);
	});
	test('never splits a leading tool row (skips it with the trim)', () => {
		const many = Array.from({length: DISPLAY_MESSAGE_CAP + 3}, (_, i) =>
			msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`),
		);
		// The trimmed window is slice(-CAP) = indices 3..; force its HEAD
		// (index 3) to be a tool so the skip logic is actually exercised.
		many[3] = msg('tool', 'orphan result');
		const capped = capDisplayMessages(many) as Array<{
			role: string;
			content: string;
		}>;
		// The leading tool row is skipped so it never renders orphaned, and
		// the marker reports the extra dropped count.
		expect(capped[1]!.role).not.toBe('tool');
		expect(capped[0]!.content).toContain('4 earlier messages trimmed');
	});
});
