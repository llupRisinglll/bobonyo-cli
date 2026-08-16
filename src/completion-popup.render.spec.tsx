import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {CompletionPopup} from './components/completion-popup';

/**
 * RENDER-LEVEL guards for the COMPLETED attention modal.
 *
 * The user-visible contract: a centered success card saying COMPLETED (with
 * the "Worked for …" line), dismissed by ANY mouse move OR any key — and the
 * key must NOT be claimed (typing the next prompt works immediately).
 */

function frameHas(frame: CapturedFrame, needle: string): boolean {
	return frame.lines.some(line =>
		line.spans.some(span => span.text.includes(needle)),
	);
}

describe('CompletionPopup (COMPLETED attention modal)', () => {
	test('paints a centered COMPLETED card with the completion line', async () => {
		const setup = await testRender(
			() => (
				<CompletionPopup
					message="✦ Worked for a snappy 16s."
					onDismiss={() => {}}
				/>
			),
			{width: 80, height: 24},
		);
		await setup.flush();
		const frame = setup.captureSpans();
		expect(frameHas(frame, 'COMPLETED')).toBe(true);
		expect(frameHas(frame, 'Worked for a snappy 16s.')).toBe(true);
		// ONE combined dismiss hint covers BOTH dismissal paths (any key OR
		// mouse movement) — no separate ESC/key line is needed.
		expect(frameHas(frame, 'move the mouse or press any key to dismiss')).toBe(
			true,
		);
		// The redundant per-path hints are GONE.
		expect(frameHas(frame, 'move the mouse to dismiss')).toBe(false);
		expect(frameHas(frame, 'press any key to continue')).toBe(false);
		expect(frameHas(frame, 'Esc')).toBe(false);
		setup.renderer.destroy();
	});

	test('ANY key dismisses it (without claiming the key)', async () => {
		let dismissed = 0;
		const setup = await testRender(
			() => (
				<CompletionPopup
					message="✦ Worked for a snappy 16s."
					onDismiss={() => {
						dismissed++;
					}}
				/>
			),
			{width: 80, height: 24},
		);
		await setup.flush();
		setup.mockInput.pressKey('h');
		await setup.flush();
		expect(dismissed).toBe(1);
		setup.renderer.destroy();
	});

	test('a MOUSE MOVE anywhere dismisses it (the user came back)', async () => {
		let dismissed = 0;
		const setup = await testRender(
			() => (
				<CompletionPopup
					message="✦ Worked for a snappy 16s."
					onDismiss={() => {
						dismissed++;
					}}
				/>
			),
			{width: 80, height: 24},
		);
		await setup.flush();
		// Move over the middle of the screen (over the card itself).
		await setup.mockMouse.moveTo(40, 12);
		await setup.flush();
		expect(dismissed).toBe(1);
		setup.renderer.destroy();
	});

	test('a click anywhere dismisses it too', async () => {
		let dismissed = 0;
		const setup = await testRender(
			() => (
				<CompletionPopup
					message="✦ Worked for a snappy 16s."
					onDismiss={() => {
						dismissed++;
					}}
				/>
			),
			{width: 80, height: 24},
		);
		await setup.flush();
		await setup.mockMouse.click(10, 3);
		await setup.flush();
		// A click = down + up, both on the backdrop — either dismisses.
		expect(dismissed).toBeGreaterThanOrEqual(1);
		setup.renderer.destroy();
	});

	test('a long message splits its ` · ` stats onto separate SPACED lines', async () => {
		const setup = await testRender(
			() => (
				<CompletionPopup
					message="✦ Worked for a keen 0s. · 1.2K tokens · 80% hit"
					onDismiss={() => {}}
				/>
			),
			{width: 60, height: 20},
		);
		await setup.flush();
		const frame = setup.captureSpans();
		// Each segment lands on its OWN line — never a cluttered single
		// line wrapping mid-segment into the dismiss hint.
		const trimmed = frame.lines.map(line =>
			line.spans
				.map(span => span.text)
				.join('')
				.trim(),
		);
		expect(trimmed.some(line => line.includes('✦ Worked for a keen 0s.'))).toBe(
			true,
		);
		expect(trimmed.some(line => line.includes('1.2K tokens'))).toBe(true);
		expect(trimmed.some(line => line.includes('80% hit'))).toBe(true);
		expect(
			trimmed.some(line =>
				line.includes('move the mouse or press any key to dismiss'),
			),
		).toBe(true);
		// The joined single line (and any `·` separator) is GONE.
		expect(trimmed.some(line => line.includes('·'))).toBe(false);
		setup.renderer.destroy();
	});
});
