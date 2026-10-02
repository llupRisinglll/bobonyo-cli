import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createSignal, Show} from 'solid-js';
import {testRender} from '@opentui/solid';
import {ModelModal} from './components/model-modal';

test('model layout caches catalog work but refreshes visible cursor highlights', () => {
	const source = readFileSync(
		new URL('./components/model-modal.tsx', import.meta.url),
		'utf8',
	);
	for (const name of ['groups', 'displayLines', 'modelCells', 'visibleLines']) {
		expect(source).toContain(`const ${name} = createMemo(`);
	}
	expect(source).toContain(
		'cells: line.cells?.map(cell => (cell ? {...cell} : null))',
	);
});

test('model navigation reuses the catalog and remains live across reset and refresh', async () => {
	let reads = 0;
	const models = Array.from({length: 300}, (_, index) => `model-${index}`);
	const [providers, setProviders] = createSignal([
		{
			id: 'test',
			name: 'test',
			baseUrl: 'https://test.invalid',
			models,
			modelEfforts: {},
		},
	]);
	const [open, setOpen] = createSignal(true);
	const setup = await testRender(
		() => (
			<Show when={open()}>
				<ModelModal
					providers={(() => {
						reads++;
						return providers();
					})()}
					currentProvider="test"
					currentModel="model-0"
					onSelect={() => {}}
					onConnectProvider={() => {}}
					onClose={() => setOpen(false)}
					hasMessages={false}
				/>
			</Show>
		),
		{width: 120, height: 24, kittyKeyboard: true},
	);
	const text = () =>
		setup
			.captureSpans()
			.lines.flatMap(line => line.spans.map(span => span.text))
			.join('\n');
	try {
		await setup.flush();
		// Remount with an empty conversation, as after /clear or compaction.
		setOpen(false);
		await setup.flush();
		setOpen(true);
		await setup.flush();
		const mountedReads = reads;
		setup.mockInput.pressArrow('right');
		await setup.flush();
		expect(text()).toContain('❯ model-1');
		expect(reads).toBe(mountedReads);
		setup.mockInput.pressKey('e');
		await setup.flush();
		expect(text()).toContain('[high]');
		expect(text()).toContain('❯ model-1');
		expect(reads).toBe(mountedReads);
		setProviders([{...providers()[0]!, models: [...models, 'new-model']}]);
		await setup.flush();
		await setup.mockInput.pasteBracketedText('new-model');
		await setup.flush();
		expect(text()).toContain('❯ new-model');
		setup.mockInput.pressEscape();
		await setup.flush();
		expect(open()).toBe(false);
	} finally {
		setup.renderer.destroy();
	}
});
