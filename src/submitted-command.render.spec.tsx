import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {History} from './components/history';
import {runCommand, type CommandContext} from './commands';
import {createSignal} from 'solid-js';
import type {ChatMessage} from './state';

test('submitted built-in command renders once as user text before result', async () => {
	const [messages, setMessages] = createSignal<ChatMessage[]>([]);
	const setup = await testRender(
		() => (
			<History
				embedded
				width={90}
				height={15}
				messages={messages}
				running={() => false}
				reasoning={() => ''}
				streaming={() => ''}
				liveOutputs={() => ({})}
			/>
		),
		{width: 90, height: 15},
	);
	try {
		runCommand('/goal:this cover SQLite failures', {
			onBuiltinCommand: (input: string) =>
				setMessages(previous => [
					...previous,
					{role: 'user', content: input, submittedCommand: true},
				]),
			goalFromContext: () =>
				setMessages(previous => [
					...previous,
					{role: 'assistant', content: 'Generating goal.'},
				]),
		} as unknown as CommandContext);
		// Wait for both asynchronous markdown blocks, not parser warm-up timing.
		for (let attempt = 0; attempt < 40; attempt++) {
			await setup.flush();
			const painted = setup
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''))
				.join('\n');
			if (
				painted.includes('/goal:this cover SQLite failures') &&
				painted.includes('Generating goal.')
			)
				break;
			await Bun.sleep(25);
		}
		const text = setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
		expect(text.split('/goal:this cover SQLite failures')).toHaveLength(2);
		expect(text).toContain('❯');
		expect(text.indexOf('/goal:this')).toBeLessThan(
			text.indexOf('Generating goal.'),
		);
	} finally {
		setup.renderer.destroy();
	}
});
