import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {TrustModal} from './components/trust-modal';
import {EffortModal} from './components/effort-modal';
import {SettingsModal, settingsRows} from './components/settings-panel';
import {settingsIndex, setSettingsIndex, setSettingsTab} from './state';

type UI = Awaited<ReturnType<typeof testRender>>;
const rows = (ui: UI) =>
	ui
		.captureSpans()
		.lines.map(line => line.spans.map(span => span.text).join(''));
const text = (ui: UI) => rows(ui).join('\n');

for (const method of ['arrows', 'wheel']) {
	test(`trust Enter honors Yes and No after ${method}; Escape declines`, async () => {
		let trusted = 0;
		let declined = 0;
		const ui = await testRender(
			() => (
				<TrustModal
					directory="/tmp/example"
					onTrust={() => trusted++}
					onDecline={() => declined++}
				/>
			),
			{width: 40, height: 20},
		);
		try {
			await ui.flush();
			if (method === 'arrows') ui.mockInput.pressArrow('down');
			else await ui.mockMouse.scroll(2, 3, 'down');
			await ui.flush();
			expect(text(ui)).toMatch(/❯\s+No, do not trust/);
			ui.mockInput.pressEnter();
			await ui.flush();
			expect(trusted).toBe(0);
			expect(declined).toBe(1);
			if (method === 'arrows') ui.mockInput.pressArrow('up');
			else await ui.mockMouse.scroll(2, 3, 'up');
			await ui.flush();
			ui.mockInput.pressEnter();
			await ui.flush();
			expect(trusted).toBe(1);
			expect(declined).toBe(1);
			ui.mockInput.pressEscape();
			await Bun.sleep(60);
			await ui.flush();
			expect(declined).toBe(2);
		} finally {
			ui.renderer.destroy();
		}
	});
}

for (const [width, height] of [
	[40, 20],
	[80, 8],
	[40, 8],
] as const) {
	test(`trust explanation and directory stay separate and reachable at ${width}x${height}`, async () => {
		const ui = await testRender(
			() => (
				<TrustModal
					directory="/tmp/example"
					onTrust={() => {}}
					onDecline={() => {}}
				/>
			),
			{width, height},
		);
		try {
			await ui.flush();
			const read: string[] = [];
			for (let i = 0; i < 5; i++) {
				read.push(...rows(ui).map(line => line.trim()));
				await ui.mockMouse.scroll(
					Math.floor(width / 2),
					height >= 12 ? 7 : 2,
					'down',
				);
				await ui.flush();
			}
			expect(read.join(' ')).toContain('bobonyo can read and write files');
			expect(read.join(' ')).toContain('run commands here:');
			expect(read).toContain('/tmp/example');
			expect(
				read.some(
					line => line.includes('/tmp/example') && line.includes('here:'),
				),
			).toBe(false);
			expect(text(ui)).toContain('Yes, trust this directory');
			expect(text(ui)).toContain('No, do not trust');
			ui.mockInput.pressKeys(['\x1b[5~']);
			await ui.flush();
			expect(text(ui)).toContain('bobonyo can read');
		} finally {
			ui.renderer.destroy();
		}
	});
}

for (const height of [10, 6]) {
	test(`effort arrows and wheel keep current and final options visible at ${height} rows`, async () => {
		let selected = '';
		const ui = await testRender(
			() => (
				<EffortModal
					model="gpt-5"
					provider="Mock"
					currentEffort="medium"
					onSelect={value => {
						selected = value;
					}}
					onClose={() => {}}
				/>
			),
			{width: 60, height},
		);
		try {
			await ui.flush();
			expect(text(ui)).toContain('❯ medium');
			ui.mockInput.pressArrow('down');
			await ui.flush();
			expect(text(ui)).toContain('❯ high');
			ui.mockInput.pressArrow('up');
			await ui.flush();
			expect(text(ui)).toContain('❯ medium');
			await ui.mockMouse.scroll(2, 2, 'down');
			await ui.flush();
			expect(text(ui)).toContain('❯ high');
			ui.mockInput.pressEnter();
			await ui.flush();
			expect(selected).toBe('high');
			for (let i = 0; i < 8; i++) {
				await ui.mockMouse.scroll(2, 2, 'up');
				await ui.flush();
			}
			expect(text(ui)).toContain('❯ Default');
		} finally {
			ui.renderer.destroy();
		}
	});
}

test('settings arrows and wheel keep selected row visible in 80x15 viewport', async () => {
	const tab = 2;
	setSettingsTab(tab);
	setSettingsIndex(0);
	const ui = await testRender(
		() => (
			<SettingsModal
				onClose={() => {}}
				onEdit={() => {}}
				onApply={() => {}}
				onModelSelect={() => {}}
			/>
		),
		{width: 80, height: 15},
	);
	try {
		await ui.flush();
		const assertSelected = () => {
			const label = settingsRows(tab)[settingsIndex()]!.label;
			expect(text(ui)).toContain(`❯ ${label}`);
		};
		assertSelected();
		for (let i = 0; i < settingsRows(tab).length; i++) {
			ui.mockInput.pressArrow('down');
			await ui.flush();
			assertSelected();
		}
		for (let i = 0; i < settingsRows(tab).length; i++) {
			await ui.mockMouse.scroll(2, 2, 'up');
			await ui.flush();
			assertSelected();
		}
		expect(settingsIndex()).toBe(0);
	} finally {
		ui.renderer.destroy();
		setSettingsTab(0);
		setSettingsIndex(0);
	}
});
