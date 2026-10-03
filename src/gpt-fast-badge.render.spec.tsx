import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {readFileSync} from 'node:fs';
import {supportsGptFast} from './gpt-controls';
import {runCommand, type CommandContext} from './commands';
import {InputBox} from './components/input-box';
import {activeEndpoint, input, setActiveEndpoint, setInput} from './state';

test('Fast badge reacts to toggles and provider switches without adding rows', async () => {
	const original = activeEndpoint();
	const originalInput = input();
	setInput('');
	setActiveEndpoint({
		...original,
		model: 'gpt-5.5',
		effort: undefined,
		baseUrl: 'https://api.openai.com',
		sdkProvider: 'responses',
		codexAccount: false,
		fastMode: false,
	});
	const setup = await testRender(() => <InputBox onSubmit={() => {}} />, {
		width: 80,
		height: 24,
	});
	const lines = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''));
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	const marker = 'const switchFast = (args: string) => {';
	const start = app.indexOf(marker) + marker.length;
	const confirmations: string[] = [];
	const handler = new Function(
		'args',
		'activeEndpoint',
		'supportsGptFast',
		'setActiveEndpoint',
		'appendInfo',
		'savePreferences',
		app.slice(start, app.indexOf('\n\t};', start)),
	);
	const commandContext = {
		setFast: (args: string) =>
			handler(
				args,
				activeEndpoint,
				supportsGptFast,
				setActiveEndpoint,
				(message: string) => confirmations.push(message),
				() => {},
			),
	} as CommandContext;
	try {
		await setup.flush();
		const before = lines();
		const modelRow = before.findIndex(line => line.includes('gpt-5.5'));
		expect(modelRow).toBeGreaterThanOrEqual(0);
		expect(before.join('\n')).not.toContain('Fast');
		expect(runCommand('/fast', commandContext)).toBe(true);
		expect(confirmations[0]).toBe(
			'Fast processing requested (higher cost/usage) · gpt-5.5. ' +
				'Reasoning effort unchanged. Provider availability and limits apply.',
		);
		expect(activeEndpoint().fastMode).toBe(true);
		await setup.flush();
		expect(lines()[modelRow]).toContain('gpt-5.5');
		expect(lines()[modelRow]).toContain('Fast');
		expect(lines().filter(line => line.trim()).length).toBe(
			before.filter(line => line.trim()).length,
		);
		for (const change of [
			{fastMode: false},
			{fastMode: true, model: 'claude-opus-4'},
			{model: 'gpt-5.5', baseUrl: 'https://gateway.test'},
			{baseUrl: 'https://api.openai.com', model: 'gpt-5.5-pro'},
		]) {
			setActiveEndpoint(previous => ({...previous, ...change}));
			await setup.flush();
			expect(lines().join('\n')).not.toContain('Fast');
		}
		setActiveEndpoint(previous => ({
			...previous,
			model: 'gpt-5.5',
			fastMode: true,
			baseUrl: 'https://chatgpt.com/backend-api/codex',
			codexAccount: true,
		}));
		await setup.flush();
		expect(lines()[modelRow]).toContain('Fast');
	} finally {
		setup.renderer.destroy();
		setActiveEndpoint(original);
		setInput(originalInput);
	}
});
