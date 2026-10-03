import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {RGBA} from '@opentui/core';
import {testRender} from '@opentui/solid';
import {History} from './components/history';
import {colors} from './theme';
import type {ChatMessage} from './state';

test('command info notices paint gold; assistant replies and errors keep their colors', async () => {
	const messages: ChatMessage[] = [
		{
			role: 'assistant',
			kind: 'info',
			content: 'Fast processing requested (higher cost/usage) · gpt-5.5.',
		},
		{
			role: 'assistant',
			kind: 'info',
			content: 'Fast processing off · gpt-5.5.',
		},
		{role: 'assistant', content: 'Ordinary assistant reply.'},
		{
			role: 'assistant',
			kind: 'info',
			content: 'Command failed.',
			error: 'Command failed.',
		},
	];
	const setup = await testRender(
		() => (
			<History
				embedded
				width={100}
				height={24}
				messages={() => messages}
				running={() => false}
				reasoning={() => ''}
				streaming={() => ''}
				liveOutputs={() => ({})}
			/>
		),
		{width: 100, height: 24},
	);
	try {
		for (let attempt = 0; attempt < 40; attempt++) {
			await setup.flush();
			const text = setup
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''))
				.join('\n');
			if (text.includes('Ordinary assistant reply.')) break;
			await Bun.sleep(25);
		}
		const spans = setup.captureSpans().lines.flatMap(line => line.spans);
		for (const [text, color] of [
			['Fast processing requested', colors().warning],
			['Fast processing off', colors().warning],
			['Ordinary assistant reply.', colors().text],
			['Command failed.', colors().error],
		]) {
			const matching = spans.filter(span => span.text.includes(text!));
			expect(matching.length).toBeGreaterThan(0);
			for (const span of matching)
				expect((span.fg as RGBA).equals(RGBA.fromHex(color!))).toBe(true);
		}
	} finally {
		setup.renderer.destroy();
	}
});
