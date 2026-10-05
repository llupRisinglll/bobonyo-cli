import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {RGBA} from '@opentui/core';
import {testRender} from '@opentui/solid';
import {DetailsModal} from './components/details-modal';
import {BackgroundJobsModal} from './components/background-jobs-modal';
import {SettingsListModal} from './components/settings-list-modal';
import {ModelModal} from './components/model-modal';
import {setActiveAgentRuns} from './state';
import {colors} from './theme';

type UI = Awaited<ReturnType<typeof testRender>>;
const rows = (ui: UI) =>
	ui
		.captureSpans()
		.lines.map(line => line.spans.map(span => span.text).join(''));
const text = (ui: UI) => rows(ui).join('\n');

function assertHeader(ui: UI, title: string, color = colors().primary) {
	const painted = rows(ui);
	const y = painted.findIndex(line => line.includes(title));
	expect(y).toBeGreaterThan(0);
	const cap = painted[y - 1]!;
	const x = cap.indexOf('▄');
	const width = cap.trim().length;
	expect(width).toBeGreaterThan(0);
	expect(cap.trim()).toBe('▄'.repeat(width));
	expect(painted[y + 1]!.trim()).toBe('▀'.repeat(width));
	expect(painted[y]!.indexOf(title)).toBe(x + 1);
	const cells = ui
		.captureSpans()
		.lines[y]!.spans.flatMap(span =>
			Array.from(span.text, char => ({char, bg: span.bg, fg: span.fg})),
		);
	for (const cell of cells.slice(x, x + width)) {
		expect(cell.bg).toEqual(RGBA.fromHex(color));
	}
	expect(cells[x + 1]!.fg).toEqual(RGBA.fromHex(colors().base));
}

test('tool detail arrows and wheel share clamped scroll without leaking', async () => {
	let leaked = 0;
	const ui = await testRender(
		() => (
			<box onMouseScroll={() => leaked++}>
				<DetailsModal
					title="Tool details"
					content={Array.from({length: 40}, (_, i) => `detail-${i}`).join('\n')}
					onClose={() => {}}
				/>
			</box>
		),
		{width: 100, height: 20},
	);
	try {
		await ui.flush();
		assertHeader(ui, 'Tool details');
		ui.mockInput.pressArrow('down');
		await ui.flush();
		expect(text(ui)).not.toMatch(/detail-0\s/);
		ui.mockInput.pressArrow('up');
		await ui.flush();
		expect(text(ui)).toMatch(/detail-0\s/);
		await ui.mockMouse.scroll(4, 8, 'down');
		await ui.flush();
		expect(text(ui)).not.toMatch(/detail-0\s/);
		await ui.mockMouse.scroll(4, 8, 'up');
		await ui.flush();
		expect(text(ui)).toMatch(/detail-0\s/);
		for (let i = 0; i < 60; i++) {
			await ui.mockMouse.scroll(4, 8, 'down');
			await ui.flush();
		}
		await ui.flush();
		expect(text(ui)).toContain('detail-39');
		expect(text(ui)).toContain('40/40');
		expect(leaked).toBe(0);
	} finally {
		ui.renderer.destroy();
	}
});

test('subagent shared bar and embedded History own arrows and wheel', async () => {
	let leaked = 0;
	const content = Array.from(
		{length: 80},
		(_, i) => `transcript-${i.toString().padStart(2, '0')}`,
	).join('\n');
	setActiveAgentRuns([
		{
			id: 'modal_scroll_agent',
			name: 'explore',
			description: 'scroll transcript',
			output: content,
			transcript: content.split('\n'),
			streaming: '',
			history: content.split('\n').flatMap((line, i) => [
				{
					role: 'assistant' as const,
					content: '',
					tool_calls: [
						{
							id: `scroll_call_${i}`,
							name: 'Bash',
							arguments: JSON.stringify({command: `echo ${line}`}),
						},
					],
				},
				{
					role: 'tool' as const,
					content: line,
					tool_call_id: `scroll_call_${i}`,
				},
			]),
			status: 'cancelled',
		},
	]);
	const ui = await testRender(
		() => (
			<box onMouseScroll={() => leaked++}>
				<BackgroundJobsModal
					initialAgentId="modal_scroll_agent"
					onClose={() => {}}
				/>
			</box>
		),
		{width: 90, height: 20},
	);
	try {
		await Bun.sleep(150);
		await ui.flush();
		assertHeader(ui, 'Subagent details');
		// Tool rows retain their own shape; the surrounding detail body has no border.
		expect(text(ui)).toContain('transcript-79');
		const tail = text(ui);
		ui.mockInput.pressArrow('up');
		await ui.flush();
		expect(text(ui)).not.toBe(tail);
		ui.mockInput.pressArrow('down');
		await ui.flush();
		expect(text(ui)).toBe(tail);
		await ui.mockMouse.scroll(5, 10, 'up');
		await ui.flush();
		expect(text(ui)).not.toBe(tail);
		for (let i = 0; i < 5; i++) {
			await ui.mockMouse.scroll(5, 10, 'down');
			await ui.flush();
		}
		await ui.flush();
		expect(text(ui)).toContain('transcript-79');
		expect(leaked).toBe(0);
		ui.resize(32, 6);
		await Bun.sleep(200);
		await ui.flush();
		expect(text(ui)).toContain('Subagent details');
		for (let i = 0; i < 800; i++) ui.mockInput.pressArrow('up');
		await ui.flush();
		expect(text(ui)).toContain('transcript-00');
	} finally {
		ui.renderer.destroy();
		setActiveAgentRuns([]);
	}
});

for (const height of [20, 6]) {
	test(`catalog arrows and wheel keep selection reachable at ${height} rows`, async () => {
		let activated = -1;
		const ui = await testRender(
			() => (
				<SettingsListModal
					title="Tools"
					rows={Array.from({length: 30}, (_, i) => ({
						label: `catalog-${i}`,
						onActivate: () => {
							activated = i;
						},
					}))}
					onClose={() => {}}
				/>
			),
			{width: 40, height},
		);
		try {
			await ui.flush();
			if (height >= 9) assertHeader(ui, 'Tools');
			ui.mockInput.pressArrow('down');
			await ui.flush();
			expect(text(ui)).toMatch(/❯ catalog-1\s/);
			ui.mockInput.pressArrow('up');
			await ui.flush();
			expect(text(ui)).toMatch(/❯ catalog-0\s/);
			await ui.mockMouse.scroll(2, 2, 'down');
			await ui.flush();
			expect(text(ui)).toMatch(/❯ catalog-1\s/);
			for (let i = 0; i < 40; i++) {
				await ui.mockMouse.scroll(2, 2, 'down');
				await ui.flush();
			}
			await ui.flush();
			expect(text(ui)).toContain('❯ catalog-29');
			ui.mockInput.pressEnter();
			await ui.flush();
			expect(activated).toBe(29);
		} finally {
			ui.renderer.destroy();
		}
	});
}

test('model picker wheel reuses arrow navigation and focus', async () => {
	const ui = await testRender(
		() => (
			<ModelModal
				providers={[
					{
						id: 'mock',
						name: 'Mock',
						models: ['alpha', 'beta', 'gamma', 'delta'],
						modelEfforts: {},
					},
				]}
				currentProvider="mock"
				currentModel="alpha"
				hasMessages={false}
				onSelect={() => {}}
				onConnectProvider={() => {}}
				onClose={() => {}}
			/>
		),
		{width: 55, height: 24},
	);
	try {
		await ui.flush();
		assertHeader(ui, 'Select a Model');
		ui.mockInput.pressArrow('down');
		await ui.flush();
		const afterArrow = text(ui);
		ui.mockInput.pressArrow('up');
		await ui.flush();
		await ui.mockMouse.scroll(4, 5, 'down');
		await ui.flush();
		expect(text(ui)).toBe(afterArrow);
	} finally {
		ui.renderer.destroy();
	}
});

test('model picker refined header does not create excessive dead space', async () => {
	const ui = await testRender(
		() => (
			<ModelModal
				providers={[
					{
						id: 'codex',
						name: 'Codex',
						models: ['alpha', 'beta', 'gamma'],
						modelEfforts: {},
					},
				]}
				currentProvider="codex"
				currentModel="alpha"
				hasMessages={false}
				onSelect={() => {}}
				onConnectProvider={() => {}}
				onClose={() => {}}
			/>
		),
		{width: 80, height: 28},
	);
	try {
		await ui.flush();
		const painted = rows(ui);
		const titleRow = painted.findIndex(line => line.includes('Select a Model'));
		const filterRow = painted.findIndex(line =>
			line.includes('Type to filter'),
		);
		expect(titleRow).toBeGreaterThan(0);
		expect(filterRow).toBeGreaterThan(titleRow);
		const between = painted.slice(titleRow + 1, filterRow);
		const blankRows = between.filter(line => line.trim() === '').length;
		// One breathable row is fine; stacked blank spacer rows recreate the old
		// oversized void under the title bar.
		expect(blankRows).toBeLessThanOrEqual(1);
	} finally {
		ui.renderer.destroy();
	}
});
