import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {RGBA, type CapturedFrame} from '@opentui/core';
import {testRender} from '@opentui/solid';
import {
	DetailsModal,
	detailsBodyInset,
	detailsCardWidth,
} from './components/details-modal';
import {colors, setThemeName} from './theme';

const rows = (frame: CapturedFrame) =>
	frame.lines.map(line => line.spans.map(span => span.text).join(''));
const cells = (frame: CapturedFrame, row: number) =>
	frame.lines[row]!.spans.flatMap(span =>
		Array.from(span.text, text => ({text, bg: span.bg, fg: span.fg})),
	);

for (const theme of ['omnicode', 'tokyo-night']) {
	test(`details pad all four sides without shrinking the colored title bar (${theme})`, async () => {
		setThemeName(theme);
		const ui = await testRender(
			() => (
				<DetailsModal
					title="Tool details"
					content={'first line\n  indented output'}
					onClose={() => {}}
				/>
			),
			{width: 110, height: 30},
		);
		try {
			await ui.flush();
			const frame = ui.captureSpans();
			const text = rows(frame);
			const title = text.findIndex(line => line.includes('Tool details'));
			const left = Math.floor(
				(110 - detailsCardWidth('Tool details', 110)) / 2,
			);
			const inset = detailsBodyInset();
			expect(text[title]!.indexOf('Tool details')).toBe(left + inset);
			expect(text[title]!.trim()).not.toBe('');
			expect(text[title - 1]!.trim()).toBe('▄'.repeat(96));
			expect(text[title + 1]!.trim()).toBe('▀'.repeat(96));
			expect(text[title + 3]!.indexOf('first line')).toBe(left + inset);
			expect(text[title + 4]!.indexOf('indented output')).toBe(
				left + inset + 2,
			);
			expect(text.join('\n')).not.toMatch(/[╭╮╰╯│─]/);
			const header = cells(frame, title).slice(left, left + 96);
			expect(header).toHaveLength(96);
			for (const cell of header)
				expect(cell.bg).toEqual(RGBA.fromHex(colors().primary));
			const topPadding = cells(frame, title - 1).slice(left, left + 96);
			expect(topPadding).toHaveLength(96);
			for (const cell of topPadding) {
				expect(cell.text).toBe('▄');
				expect(cell.fg).toEqual(RGBA.fromHex(colors().primary));
				expect(cell.bg).toEqual(RGBA.fromHex(colors().base));
			}
			const bottomPadding = cells(frame, title + 1).slice(left, left + 96);
			expect(bottomPadding).toHaveLength(96);
			for (const cell of bottomPadding) {
				expect(cell.text).toBe('▀');
				expect(cell.fg).toEqual(RGBA.fromHex(colors().primary));
				expect(cell.bg).toEqual(RGBA.fromHex(colors().base));
			}
			const nextBodyPaddingRow = cells(frame, title + 2).slice(left, left + 96);
			for (const cell of nextBodyPaddingRow) {
				expect(cell.text).toBe(' ');
				expect(cell.bg).toEqual(RGBA.fromHex(colors().base));
			}
			expect(text[title + 5]!.trim()).toBe('');
			const bodyBottom = cells(frame, title + 6).slice(left, left + 96);
			for (const cell of bodyBottom) {
				expect(cell.text).toBe(' ');
				expect(cell.bg).toEqual(RGBA.fromHex(colors().base));
			}
			expect(header.at(-1)!.text).toBe(' ');
			expect(header[0]!.text).toBe(' ');
			expect(header[0]!.bg).toEqual(RGBA.fromHex(colors().primary));
			expect(header.find(cell => cell.text === 'T')!.fg).toEqual(
				RGBA.fromHex(colors().base),
			);
		} finally {
			ui.renderer.destroy();
			setThemeName('omnicode');
		}
	});
}

test('full-height body renders recovered chrome rows and retains keyboard scrolling and Escape', async () => {
	let closed = false;
	const ui = await testRender(
		() => (
			<DetailsModal
				title="Tool details"
				content={Array.from({length: 40}, (_, i) => `line-${i}`).join('\n')}
				onClose={() => {
					closed = true;
				}}
			/>
		),
		{width: 100, height: 20, kittyKeyboard: true},
	);
	try {
		await ui.flush();
		const text = () => rows(ui.captureSpans()).join('\n');
		expect(text()).toContain('line-11');
		ui.mockInput.pressArrow('down');
		await ui.flush();
		expect(text()).not.toMatch(/line-0\s/);
		expect(text()).toContain('line-12');
		ui.mockInput.pressArrow('up');
		await ui.flush();
		expect(text()).toContain('line-0');
		ui.mockInput.pressKeys(['\x1b[6~']);
		await ui.flush();
		expect(text()).toContain('line-10');
		ui.mockInput.pressKeys(['\x1b[5~']);
		await ui.flush();
		expect(text()).toContain('line-0');
		for (let index = 0; index < 50; index++) ui.mockInput.pressArrow('down');
		await ui.flush();
		expect(text()).toContain('line-28');
		expect(text()).toContain('line-39');
		expect(text()).toContain('40/40');
		const painted = rows(ui.captureSpans());
		const counter = painted.findIndex(line => line.includes('40/40'));
		expect(painted[counter + 1]!.trim()).toBe('');
		ui.resize(100, 30);
		await ui.flush();
		expect(text()).toContain('line-18');
		expect(text()).toContain('line-39');
		ui.mockInput.pressEscape();
		await ui.flush();
		expect(closed).toBe(true);
	} finally {
		ui.renderer.destroy();
	}
});

test('opening mouse release stays ignored; content clicks stay open and backdrop closes', async () => {
	let closed = false;
	const started = Date.now();
	const ui = await testRender(
		() => (
			<DetailsModal
				title="Tool details"
				content="first line"
				onClose={() => {
					closed = true;
				}}
			/>
		),
		{width: 110, height: 30},
	);
	try {
		await ui.flush();
		await ui.mockMouse.click(0, 0);
		expect(closed).toBe(false);
		await Bun.sleep(Math.max(0, 450 - (Date.now() - started)));
		const text = rows(ui.captureSpans());
		const title = text.findIndex(line => line.includes('Tool details'));
		await ui.mockMouse.click(8, title + 3);
		expect(closed).toBe(false);
		await ui.mockMouse.click(0, 0);
		expect(closed).toBe(true);
	} finally {
		ui.renderer.destroy();
	}
});

test('Usage family retains older/newer pages and flush content after narrow resize', async () => {
	const ui = await testRender(
		() => (
			<DetailsModal
				title="Usage"
				content={'recent totals\n---USAGE_PAGE---\nolder totals'}
				onClose={() => {}}
			/>
		),
		{width: 140, height: 25, kittyKeyboard: true},
	);
	try {
		await ui.flush();
		const text = () => rows(ui.captureSpans());
		expect(text().join('\n')).toContain('recent totals');
		ui.mockInput.pressArrow('left');
		await ui.flush();
		expect(text().join('\n')).toContain('older totals');
		ui.mockInput.pressArrow('right');
		await ui.flush();
		expect(text().join('\n')).toContain('recent totals');
		ui.resize(32, 12);
		await ui.flush();
		const title = text().findIndex(line => line.includes('Usage'));
		expect(text()[title + 3]!.indexOf('recent totals')).toBe(
			1 + detailsBodyInset(),
		);
		expect(text()[title]).toContain('Esc');
	} finally {
		ui.renderer.destroy();
	}
});

for (const height of [3, 6, 8]) {
	test(`small ${height}-row terminal keeps title and final content reachable`, async () => {
		const ui = await testRender(
			() => (
				<DetailsModal
					title="Tool details"
					content={'row-0\nrow-1\nrow-2\nrow-3\nrow-4\nrow-5\nrow-6\nrow-7'}
					onClose={() => {}}
				/>
			),
			{width: 40, height, kittyKeyboard: true},
		);
		try {
			await ui.flush();
			expect(rows(ui.captureSpans()).join('\n')).toContain('Tool details');
			for (let index = 0; index < 20; index++) ui.mockInput.pressArrow('down');
			await ui.flush();
			const text = rows(ui.captureSpans());
			expect(text.join('\n')).toContain('row-7');
			if (height >= 7) {
				expect(text.join('\n')).toContain('8/8');
				expect(text.at(-1)!.trim()).toBe('');
			}
		} finally {
			ui.renderer.destroy();
		}
	});
}
