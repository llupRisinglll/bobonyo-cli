import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {EffortModal} from './components/effort-modal';
import {ModelModal} from './components/model-modal';

test('standalone GPT effort picker excludes unsupported minimal and none on Astra', async () => {
	const setup = await testRender(
		() => (
			<EffortModal
				model="gpt-6-astra"
				provider="OpenAI"
				onSelect={() => {}}
				onClose={() => {}}
			/>
		),
		{width: 90, height: 30},
	);
	try {
		await setup.flush();
		const frame = setup.captureSpans();
		const text = frame.lines
			.flatMap(line => line.spans.map(span => span.text))
			.join('\n');
		expect(text).toContain('max');
		expect(text).not.toContain('minimal');
		expect(text).not.toContain('none');
	} finally {
		setup.renderer.destroy();
	}
});

test('Codex model effort step excludes API-only none and unsupported minimal', async () => {
	const setup = await testRender(
		() => (
			<ModelModal
				providers={[
					{
						id: 'account',
						name: 'Codex',
						baseUrl: 'https://chatgpt.com/backend-api/codex',
						codexAccount: true,
						models: ['gpt-5.5'],
						modelEfforts: {},
					},
				]}
				currentProvider="account"
				currentModel="gpt-5.5"
				onSelect={() => {}}
				onConnectProvider={() => {}}
				onClose={() => {}}
				hasMessages={false}
			/>
		),
		{width: 90, height: 30},
	);
	try {
		await setup.flush();
		setup.mockInput.pressEnter();
		await setup.flush();
		const frame = setup.captureSpans();
		const text = frame.lines
			.flatMap(line => line.spans.map(span => span.text))
			.join('\n');
		expect(text).toContain('Select effort');
		expect(text).toContain('xhigh');
		expect(text).not.toContain('minimal');
		expect(text).not.toContain('none');
	} finally {
		setup.renderer.destroy();
	}
});

test('Codex Sol picker renders ultra and footer without clipping', async () => {
	const setup = await testRender(
		() => (
			<EffortModal
				model="gpt-5.6-sol"
				provider="Codex"
				codexAccount
				onSelect={() => {}}
				onClose={() => {}}
			/>
		),
		{width: 90, height: 30},
	);
	try {
		await setup.flush();
		const text = setup
			.captureSpans()
			.lines.flatMap(line => line.spans.map(span => span.text))
			.join('\n');
		expect(text).toContain('ultra');
		expect(text).toContain('Enter choose');
		expect(text).not.toContain('none');
	} finally {
		setup.renderer.destroy();
	}
});
