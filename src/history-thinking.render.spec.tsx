import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {createSignal} from 'solid-js';
import {History} from './components/history';
import {setSpinnerFrame, setThinkingActive, setThinkingMode} from './state';

test('show-mode live thought hides when thinking ends despite stale reasoning', async () => {
	const [running] = createSignal(true);
	const [reasoning] = createSignal('Inspecting provider stream');
	setThinkingMode('show');
	setThinkingActive(true);
	setSpinnerFrame(0);
	const setup = await testRender(
		() => (
			<History
				embedded
				width={80}
				height={12}
				messages={() => []}
				running={running}
				reasoning={reasoning}
				streaming={() => ''}
				liveOutputs={() => ({})}
			/>
		),
		{width: 80, height: 12},
	);
	const text = (): string =>
		setup
			.captureSpans()
			.lines.flatMap(line => line.spans.map(span => span.text))
			.join('');
	try {
		await Bun.sleep(180);
		await setup.flush();
		expect(text()).toContain('⚙ Thinking .');
		expect(text()).toContain('Inspecting provider stream');

		setThinkingActive(false);
		await Bun.sleep(180);
		await setup.flush();
		expect(text()).not.toContain('Thinking');
		expect(text()).not.toContain('Inspecting provider stream');
	} finally {
		setThinkingActive(false);
		setThinkingMode('hidden');
		setSpinnerFrame(0);
		setup.renderer.destroy();
	}
});
