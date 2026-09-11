import '@opentui/solid/preload';
import {afterEach, describe, expect, test} from 'bun:test';
import {testRender, useKeyboard} from '@opentui/solid';
import {RGBA} from '@opentui/core';
import type {TestRendererSetup} from '@opentui/core/testing';
import {InputBox} from './components/input-box';
import type {PendingWorkItem} from './background-notification';
import {
	input,
	pendingQueue,
	setBusy,
	setInput,
	setPendingQueue,
	setHistoryIndex,
	setPromptHistory,
} from './state';
import {activeRowPalette} from './row-highlight';
import {colors} from './theme';

let setup: TestRendererSetup | undefined;
async function mountQueue(
	items: PendingWorkItem[],
	onSubmit: (
		value: string,
		attachments?: Record<string, string>,
	) => void = () => {},
) {
	setInput('');
	setHistoryIndex(-1);
	setPromptHistory(['history must not steal queue arrows']);
	setBusy(true);
	setPendingQueue(items);
	setup = await testRender(() => <InputBox onSubmit={onSubmit} />, {
		width: 100,
		height: 16,
		kittyKeyboard: true,
	});
	await setup.flush();
	return setup;
}

function selectedText() {
	return setup!
		.captureSpans()
		.lines.map(line => line.spans.map(span => span.text).join(''))
		.find(line => /▸ \((?:next round|after current)\)/.test(line))
		?.trim();
}

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
	setPendingQueue([]);
	setInput('');
	setBusy(false);
	setPromptHistory([]);
	setHistoryIndex(-1);
});

describe('queued input keyboard behavior', () => {
	test('arrows select reactively with active foreground and background', async () => {
		const render = await mountQueue([
			{value: 'first queued'},
			{value: 'last queued'},
		]);
		render.mockInput.pressArrow('up');
		await render.flush();
		expect(input()).toBe('');
		expect(selectedText()).toContain('last queued');
		const span = render
			.captureSpans()
			.lines.flatMap(line => line.spans)
			.find(span => span.text.includes('last queued'))!;
		const palette = activeRowPalette(colors());
		for (const channel of ['r', 'g', 'b'] as const) {
			expect((span.bg as RGBA)[channel]).toBeCloseTo(palette.bg[channel], 2);
			expect((span.fg as RGBA)[channel]).toBeCloseTo(palette.fg[channel], 2);
		}
		render.mockInput.pressArrow('up');
		await render.flush();
		expect(selectedText()).toContain('first queued');
		render.mockInput.pressArrow('up');
		await render.flush();
		expect(selectedText()).toContain('first queued');
		render.mockInput.pressArrow('down');
		render.mockInput.pressArrow('down');
		await render.flush();
		expect(selectedText()).toBeUndefined();
		render.mockInput.pressArrow('down');
		await render.flush();
		expect(selectedText()).toContain('first queued');
	});

	test('selection follows item identity when earlier work drains', async () => {
		const first = {value: 'duplicate'};
		const selected = {value: 'duplicate', attachments: {'1': '/selected.png'}};
		const last = {value: 'last'};
		const render = await mountQueue([first, selected, last]);
		render.mockInput.pressArrow('down');
		render.mockInput.pressArrow('down');
		await render.flush();
		setPendingQueue([selected, last]);
		await render.flush();
		render.mockInput.pressEnter();
		await render.flush();
		expect(input()).toBe('duplicate');
		expect(pendingQueue()).toEqual([last]);
	});

	test('draining selected item never transfers selection to its successor', async () => {
		const first = {value: 'first'};
		const last = {value: 'last'};
		const render = await mountQueue([first, last]);
		render.mockInput.pressArrow('down');
		await render.flush();
		setPendingQueue([last]);
		await render.flush();
		expect(selectedText()).toBeUndefined();
		render.mockInput.pressEnter();
		await render.flush();
		expect(input()).toBe('');
		expect(pendingQueue()).toEqual([last]);
	});

	test('editing restores attachments for resubmission', async () => {
		const submitted: Array<{
			value: string;
			attachments?: Record<string, string>;
		}> = [];
		const attachments = {'1': '/queued.png'};
		const render = await mountQueue(
			[{value: 'look [Image #1]', attachments}],
			(value, attachments) => submitted.push({value, attachments}),
		);
		render.mockInput.pressArrow('up');
		render.mockInput.pressEnter();
		await render.flush();
		expect(input()).toBe('look [Image #1]');
		expect(pendingQueue()).toEqual([]);
		expect(submitted).toEqual([]);
		render.mockInput.pressEnter();
		await render.flush();
		expect(submitted).toEqual([{value: 'look [Image #1]', attachments}]);
	});

	test('typing and external draft edits clear selection instead of losing draft on Enter', async () => {
		const queued = {value: 'queued'};
		const submitted: string[] = [];
		const render = await mountQueue([queued], value => submitted.push(value));
		render.mockInput.pressArrow('down');
		await render.mockInput.typeText('new draft');
		await render.flush();
		expect(selectedText()).toBeUndefined();
		render.mockInput.pressEnter();
		await render.flush();
		expect(submitted).toEqual(['new draft']);
		expect(pendingQueue()).toEqual([queued]);
		render.mockInput.pressArrow('down');
		await render.flush();
		setInput('external draft');
		await render.flush();
		expect(selectedText()).toBeUndefined();
		render.mockInput.pressEnter();
		await render.flush();
		expect(submitted).toEqual(['new draft', 'external draft']);
		expect(pendingQueue()).toEqual([queued]);
	});

	test('only explicit Delete removes selected work; Backspace and Ctrl+H do not', async () => {
		const queued = {value: 'keep until Delete'};
		const render = await mountQueue([queued]);
		render.mockInput.pressArrow('down');
		render.mockInput.pressBackspace();
		render.mockInput.pressKey('h', {ctrl: true});
		await render.flush();
		expect(pendingQueue()).toEqual([queued]);
		render.mockInput.pressKey('DELETE');
		await render.flush();
		expect(pendingQueue()).toEqual([]);
	});

	test('global Escape hook deselects before abort and unregisters on disposal', async () => {
		setInput('');
		setPendingQueue([{value: 'queued'}]);
		let escapeHandler: (() => boolean) | null = null;
		let aborts = 0;
		function Host() {
			useKeyboard(event => {
				if (event.name !== 'escape') return;
				if (escapeHandler?.()) {
					event.preventDefault();
					return;
				}
				aborts++;
			});
			return (
				<InputBox
					onSubmit={() => {}}
					onQueueEscapeHandler={handler => {
						escapeHandler = handler;
					}}
				/>
			);
		}
		setup = await testRender(() => <Host />, {
			width: 100,
			height: 16,
			kittyKeyboard: true,
		});
		setup.mockInput.pressArrow('down');
		await setup.flush();
		expect(selectedText()).toContain('queued');
		setup.mockInput.pressEscape();
		await setup.flush();
		expect(selectedText()).toBeUndefined();
		expect(aborts).toBe(0);
		setup.mockInput.pressEscape();
		await setup.flush();
		expect(aborts).toBe(1);
		setup.renderer.destroy();
		setup = undefined;
		expect(escapeHandler).toBeNull();
	});
});
