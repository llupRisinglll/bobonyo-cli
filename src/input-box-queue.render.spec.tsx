import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {InputBox} from './components/input-box';
import {
	input,
	pendingQueue,
	setInput,
	setBusy,
	setPendingQueue,
	setPromptHistory,
	setHistoryIndex,
} from './state';

test('scheduling never paints editable input rows or steals history arrows', async () => {
	setInput('');
	setBusy(true);
	setHistoryIndex(-1);
	setPromptHistory(['previous prompt']);
	const event = {value: 'hidden scheduling event', source: 'task' as const};
	setPendingQueue([event]);
	const setup = await testRender(() => <InputBox onSubmit={() => {}} />, {
		width: 100,
		height: 16,
		kittyKeyboard: true,
	});
	try {
		await setup.flush();
		const frame = setup
			.captureSpans()
			.lines.flatMap(line => line.spans.map(span => span.text))
			.join('\n');
		expect(frame).not.toContain('Queued messages');
		expect(frame).not.toContain(event.value);
		setup.mockInput.pressArrow('up');
		await setup.flush();
		expect(input()).toBe('previous prompt');
		setup.mockInput.pressArrow('down');
		await setup.flush();
		expect(input()).toBe('');
		setup.mockInput.pressKey('DELETE');
		await setup.flush();
		expect(pendingQueue()).toEqual([event]);
	} finally {
		setup.renderer.destroy();
		setPendingQueue([]);
		setInput('');
		setBusy(false);
		setPromptHistory([]);
		setHistoryIndex(-1);
	}
});
