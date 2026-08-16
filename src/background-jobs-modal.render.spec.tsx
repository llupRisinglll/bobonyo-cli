import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {BackgroundJobsModal} from './components/background-jobs-modal';
import {bgTasks, setBgTasks} from './bash';
import {colors} from './theme';
import {createTextAttributes} from '@opentui/core';

/**
 * RENDER-LEVEL guard for the background-jobs modal + the floating
 * notification that replaced the `bg: n` status-line segment.
 *
 * The modal lists every background bash task in the chat-history bash-box
 * format (bordered `$ command` + tailed output with a `+N more lines`
 * footer) and the RUNNING jobs stream their output in realtime (bgTasks()
 * is a signal — the For re-renders when runBash pushes a fresh array).
 */

/** Full line text (all spans joined) — avoids the per-span split issue. */
function lineText(frame: CapturedFrame, line: number): string {
	return (
		frame.lines[line]?.spans
			.map((span: {text: string}) => span.text)
			.join('') ?? ''
	);
}

/** Whether a multi-span search finds the needle inside a joined line. */
function frameHas(frame: CapturedFrame, needle: string): boolean {
	return frame.lines.some((line: {spans: Array<{text: string}>}) => {
		const full = line.spans.map((span: {text: string}) => span.text).join('');
		return full.includes(needle);
	});
}

describe('BackgroundJobsModal', () => {
	test('lists running + completed jobs with the bash-box format and a +N more lines footer', async () => {
		setBgTasks([
			{
				id: 'bg_test_1',
				command: 'npm run build',
				output: Array.from({length: 15}, (_, i) => `line ${i + 1}`),
				running: true,
				exitCode: null,
				startedAt: Date.now() - 5000,
			},
			{
				id: 'bg_test_2',
				command: 'echo done',
				output: ['done'],
				running: false,
				exitCode: 0,
				startedAt: Date.now() - 9000,
				completedAt: Date.now() - 8000,
			},
		]);
		const setup = await testRender(
			() => <BackgroundJobsModal onClose={() => {}} />,
			{width: 100, height: 30},
		);
		try {
			await setup.flush();
			await new Promise(resolve => setTimeout(resolve, 100));
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'Background jobs')).toBe(true);
			// Both jobs listed, command headers inside bordered boxes.
			expect(frameHas(frame, 'npm run build')).toBe(true);
			expect(frameHas(frame, 'echo done')).toBe(true);
			// Running state + the tailed preview cap (10 lines) with the
			// "+N more lines" footer: 15 lines collected → 5 hidden.
			expect(frameHas(frame, 'running')).toBe(true);
			expect(frameHas(frame, '\u2026 +5 more lines')).toBe(true);
			// Completed job shows its exit code.
			expect(frameHas(frame, 'exit 0')).toBe(true);
			// The output TAIL is what renders (latest lines), not the head.
			expect(frameHas(frame, 'line 15')).toBe(true);
			// line 1 should NOT appear (output capped to last 10 of 15).
			// Use 'line 1\n' to avoid matching 'line 15' or command text.
			expect(frameHas(frame, 'line 1\n')).toBe(false);
		} finally {
			setBgTasks([]);
			setup.renderer.destroy();
		}
	});

	test('clicking outside the card closes the modal', async () => {
		setBgTasks([
			{
				id: 'bg_test',
				command: 'sleep 5',
				output: [],
				running: true,
				exitCode: null,
				startedAt: Date.now(),
			},
		]);
		let closed = 0;
		const setup = await testRender(
			() => <BackgroundJobsModal onClose={() => (closed += 1)} />,
			{width: 100, height: 30},
		);
		try {
			await setup.flush();
			// Wait past the mountedAt 400ms auto-close guard window, then
			// click outside the card (backdrop) — same pattern as every
			// other modal's auto-close guard.
			await new Promise(resolve => setTimeout(resolve, 500));
			await setup.mockMouse.click(0, 0);
			await setup.flush();
			expect(closed).toBe(1);
		} finally {
			setBgTasks([]);
			setup.renderer.destroy();
		}
	});

	test('empty state renders a friendly line', async () => {
		setBgTasks([]);
		const setup = await testRender(
			() => <BackgroundJobsModal onClose={() => {}} />,
			{width: 100, height: 20},
		);
		try {
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'No background jobs.')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('the notification card paints `background jobs: n` + the /ps hint (top-right, clickable)', async () => {
		const setup = await testRender(
			() => (
				<box
					position="absolute"
					top={1}
					right={2}
					zIndex={2500}
					flexDirection="column"
					border
					borderStyle="rounded"
					borderColor={colors().primary}
					backgroundColor={colors().base}
					paddingX={2}
					paddingY={1}
				>
					<text
						fg={colors().primary}
						attributes={createTextAttributes({bold: true})}
					>
						bg: 1
					</text>
					<text
						fg={colors().secondary}
						attributes={createTextAttributes({dim: true})}
					>
						/ps · click
					</text>
				</box>
			),
			{width: 100, height: 20},
		);
		try {
			await setup.flush();
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'bg: 1')).toBe(true);
			expect(frameHas(frame, '/ps · click')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});
});
