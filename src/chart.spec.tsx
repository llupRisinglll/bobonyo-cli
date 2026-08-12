/** @jsxImportSource @opentui/solid */
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {setBgTasks} from './bash';
import {BgTasksCard, ChartTitle, VizCard} from './components/chart';
import {publishViz} from './viz-store';

describe('visualization cards (diamond glyph, never a `  └   ` tool row)', () => {
	test('BgTasksCard renders the glyph + task rows and NO └ indent', async () => {
		setBgTasks([
			{
				id: 'bg_abc_1',
				command: './worktree-create.sh demo',
				output: ['cloned repos', 'building kernel dist'],
				running: true,
				exitCode: null,
				startedAt: Date.now() - 3000,
				progress: [
					{step: 'cloned repos', at: Date.now() - 2000},
					{step: 'kernel build', at: Date.now() - 1000},
				],
			},
		]);
		const setup = await testRender(() => <BgTasksCard />, {
			width: 100,
			height: 30,
		});
		const frame = await setup.waitForFrame(text =>
			text.includes('Background tasks'),
		);
		expect(frame).toContain('✦');
		expect(frame).toContain('bg_abc_1');
		// A card is NOT a tool row: no `  └   ` branch anywhere.
		expect(frame).not.toContain('└');
		setup.renderer.destroy();
	});

	test('VizCard renders the glyph + chart and NO └ indent', async () => {
		publishViz('smoke', 'E2E results', 'bar', [
			{label: 'auth', value: 42},
		]);
		const setup = await testRender(
			() => <VizCard toolId="smoke" title="E2E results" kind="bar" />,
			{width: 100, height: 30},
		);
		const frame = await setup.waitForFrame(text =>
			text.includes('E2E results'),
		);
		expect(frame).toContain('✦');
		expect(frame).toContain('auth');
		expect(frame).not.toContain('└');
		setup.renderer.destroy();
	});

	test('ChartTitle carries the diamond glyph before the title', async () => {
		const setup = await testRender(
			() => <ChartTitle title="solo" running />,
			{width: 100, height: 10},
		);
		const frame = await setup.waitForFrame(text =>
			text.includes('solo'),
		);
		expect(frame).toContain('✦ solo');
		expect(frame).toContain('● live');
		setup.renderer.destroy();
	});
});
