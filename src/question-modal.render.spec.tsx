import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {QuestionModal} from './components/question-modal';

function frameText(frame: {
	lines: Array<{spans: Array<{text: string}>}>;
}): string {
	return frame.lines
		.flatMap(line => line.spans.map(span => span.text))
		.join('');
}
test('structured question modal selects options and accepts custom answers', async () => {
	let answer = '';
	const setup = await testRender(
		() => (
			<QuestionModal
				header="Base"
				question="Which branch?"
				options={[
					{label: 'main'},
					{label: 'staging', description: 'Release integration branch'},
				]}
				onAnswer={value => {
					answer = value;
				}}
				onCancel={() => {}}
			/>
		),
		{width: 90, height: 24},
	);
	try {
		await setup.flush();
		expect(frameText(setup.captureSpans())).toContain('Which branch?');
		setup.mockInput.pressArrow('down');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(answer).toBe('staging');
		answer = '';
		await setup.mockInput.typeText('release');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(answer).toBe('release');
	} finally {
		setup.renderer.destroy();
	}
});

test('structured question modal supports multi-select and option descriptions', async () => {
	let answer = '';
	const setup = await testRender(
		() => (
			<QuestionModal
				header="Checks"
				question="Which checks?"
				options={[
					{label: 'tests', description: 'Run unit tests'},
					{label: 'build', description: 'Build release output'},
				]}
				multiple
				onAnswer={value => {
					answer = value;
				}}
				onCancel={() => {}}
			/>
		),
		{width: 90, height: 24},
	);
	try {
		await setup.flush();
		expect(frameText(setup.captureSpans())).toContain('Run unit tests');
		setup.mockInput.pressKey(' ');
		setup.mockInput.pressArrow('down');
		setup.mockInput.pressKey(' ');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(answer).toBe('tests, build');
	} finally {
		setup.renderer.destroy();
	}
});
test('long destructive permission details wrap instead of truncating targets', async () => {
	const command =
		'rm -- /mnt/data/KSProjects/Hilinga/.bobonyo/agents/general-purpose.md /mnt/data/KSProjects/Hilinga/.nanocoder/agents/general-purpose.md';
	const setup = await testRender(
		() => (
			<QuestionModal
				header="Question"
				question={`Grant these tools for this session?\nexecute_bash: Delete duplicate agent files.\n  Command: ${command}\n  External paths: /mnt/data/KSProjects/Hilinga/.bobonyo/agents/general-purpose.md, /mnt/data/KSProjects/Hilinga/.nanocoder/agents/general-purpose.md`}
				options={[{label: 'Grant'}, {label: 'Deny'}]}
				onAnswer={() => {}}
				onCancel={() => {}}
			/>
		),
		{width: 90, height: 30},
	);
	try {
		await setup.flush();
		const text = frameText(setup.captureSpans());
		expect(text).toContain('general-purpose.md');
		expect(text).toContain('.nanocoder/agents');
		expect(text).not.toContain('Hilinga/…');
	} finally {
		setup.renderer.destroy();
	}
});
