import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {QuestionModal, type QuestionOption} from './components/question-modal';
import {activeRowPalette} from './row-highlight';
import {colors} from './theme';

async function mountCustom(
	width = 70,
	height = 30,
	question = 'Which branch?',
	options: QuestionOption[] = [{label: 'main'}, {label: 'staging'}],
	multiple = false,
) {
	let answer = '';
	let cancelled = false;
	const setup = await testRender(
		() => (
			<QuestionModal
				question={question}
				options={options}
				multiple={multiple}
				onAnswer={value => {
					answer = value;
				}}
				onCancel={() => {
					cancelled = true;
				}}
			/>
		),
		{width, height},
	);
	return {...setup, answer: () => answer, cancelled: () => cancelled};
}

test('custom choice has explicit entry, editing-only cursor, and preserved draft on Escape', async () => {
	const setup = await mountCustom();
	try {
		await setup.flush();
		expect(rows(setup).join('\n')).not.toContain('▌');
		expect(rows(setup).join('\n')).toContain('Custom answer…');
		setup.mockInput.pressArrow('up');
		await setup.flush();
		expect(rows(setup).join('\n')).toMatch(/❯\s+Custom answer…/);
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(assertCustomBounded(setup).join('\n')).toContain('Type your answer');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(setup.answer()).toBe('');
		expect(rows(setup).join('\n')).toContain('▌');
		await setup.mockInput.typeText('draft');
		setup.mockInput.pressEscape();
		await setup.flush();
		expect(setup.cancelled()).toBe(false);
		expect(rows(setup).join('\n')).not.toContain('▌');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(rows(setup).join('\n')).toContain('draft▌');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(setup.answer()).toBe('draft');
		setup.mockInput.pressEscape();
		await Bun.sleep(60);
		setup.mockInput.pressEscape();
		await Bun.sleep(60);
		await setup.flush();
		expect(setup.cancelled()).toBe(true);
	} finally {
		setup.renderer.destroy();
	}
});

test('typing and paste focus only custom editing while preserving multi-select choices', async () => {
	const setup = await mountCustom(70, 30, 'Checks?', undefined, true);
	try {
		setup.mockInput.pressKey(' ');
		await setup.mockInput.typeText('draft');
		await setup.flush();
		expect(assertCustomBounded(setup).join('\n')).toContain('draft▌');
		const palette = activeRowPalette(colors());
		const main = setup
			.captureSpans()
			.lines.flatMap(line => line.spans)
			.find(span => span.text.includes('main'))!;
		expect(main.bg).not.toEqual(palette.bg);
		setup.mockInput.pressEscape();
		await Bun.sleep(60);
		setup.mockInput.pressArrow('up');
		setup.mockInput.pressKey(' ');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(setup.answer()).toBe('main, staging');
		await setup.mockInput.pasteBracketedText(' pasted');
		await setup.flush();
		expect(assertCustomBounded(setup).join('\n')).toContain('draft pasted▌');
	} finally {
		setup.renderer.destroy();
	}
});

test('mouse highlights the final custom choice and activates its editor', async () => {
	const setup = await mountCustom();
	try {
		await setup.flush();
		const lines = rows(setup);
		const y = lines.findIndex(line => line.includes('Custom answer…'));
		const x = lines[y]!.indexOf('Custom answer…');
		await setup.mockMouse.moveTo(x, y);
		await setup.flush();
		assertFocusedOption(setup, 'Custom answer…');
		await setup.mockMouse.click(x, y);
		await setup.flush();
		expect(assertCustomBounded(setup).join('\n')).toContain('Type your answer');
	} finally {
		setup.renderer.destroy();
	}
});

function assertFocusedOption(
	setup: Awaited<ReturnType<typeof mountCustom>>,
	label: string,
) {
	const frame = setup.captureSpans();
	const line = frame.lines.find(line =>
		line.spans.some(span => span.text.includes(label)),
	);
	expect(line).toBeDefined();
	expect(line!.spans.map(span => span.text).join('')).toMatch(
		new RegExp(`❯\\s+${label}`),
	);
	const labelSpan = line!.spans.find(span => span.text.includes(label))!;
	expect(labelSpan.bg).toEqual(activeRowPalette(colors()).bg);
	expect(rows(setup).join('\n')).not.toContain('▌');
	expect(rows(setup).join('\n')).toContain('Esc');
}

for (const question of [
	'Which branch?',
	'A long question with details. '.repeat(30),
]) {
	test(`short viewport follows focused option: ${question.slice(0, 20)}`, async () => {
		const setup = await mountCustom(
			26,
			9,
			question,
			question.length > 20
				? [
						{label: 'main', description: 'Default branch'},
						{label: 'staging', description: 'Release branch'},
					]
				: undefined,
		);
		try {
			await setup.flush();
			assertFocusedOption(setup, 'main');
			setup.mockInput.pressArrow('down');
			await setup.flush();
			assertFocusedOption(setup, 'staging');
			setup.mockInput.pressEnter();
			await setup.flush();
			expect(setup.answer()).toBe('staging');
			setup.mockInput.pressArrow('up');
			await setup.flush();
			assertFocusedOption(setup, 'main');
			setup.mockInput.pressArrow('up');
			await setup.flush();
			assertFocusedOption(setup, 'Custom answer…');
			await setup.mockInput.pasteBracketedText('custom '.repeat(100) + 'TAIL');
			await setup.flush();
			expect(assertCustomBounded(setup).join('\n')).toContain('TAIL▌');
			setup.mockInput.pressEscape();
			await Bun.sleep(60);
			setup.mockInput.pressArrow('down');
			await setup.flush();
			assertFocusedOption(setup, 'main');
			setup.resize(38, 12);
			await setup.flush();
			assertFocusedOption(setup, 'main');
		} finally {
			setup.renderer.destroy();
		}
	});
}

function rows(setup: Awaited<ReturnType<typeof mountCustom>>) {
	return setup
		.captureSpans()
		.lines.map(line => line.spans.map(span => span.text).join(''));
}

function assertCustomBounded(setup: Awaited<ReturnType<typeof mountCustom>>) {
	const lines = rows(setup);
	const caret = lines.findIndex(line => line.includes('▌'));
	const footer = lines.findIndex(line => line.includes('Enter'));
	expect(caret).toBeGreaterThanOrEqual(0);
	expect(footer).toBeGreaterThan(caret);
	expect(lines.some(line => line.includes('Esc'))).toBe(true);
	const top = lines.find(line => line.includes('╭'));
	const bottom = lines.find(line => line.includes('╰'));
	expect(top).toContain('╮');
	expect(bottom).toContain('╯');
	const caretLine = lines[caret]!;
	expect(caretLine.indexOf('▌')).toBeGreaterThan(caretLine.indexOf('│'));
	expect(caretLine.lastIndexOf('│')).toBeGreaterThan(caretLine.indexOf('▌'));
	return lines;
}

test('narrow empty question keeps card, custom cursor, and footer on screen', async () => {
	const setup = await mountCustom(26, 9);
	try {
		await setup.flush();
		expect(rows(setup).join('\n')).not.toContain('▌');
		setup.mockInput.pressArrow('up');
		setup.mockInput.pressEnter();
		await setup.flush();
		assertCustomBounded(setup);
	} finally {
		setup.renderer.destroy();
	}
});

test('87-to-52-column resize does not insert blank rows into a pasted paragraph', async () => {
	const setup = await mountCustom(87, 30);
	const value =
		'study it and help with the decision. the idea is our harness should be similar to other harnesses but with more customization. as the user writes a longer answer, the dialog should grow and keep the answer cursor above its keyboard hints.';
	try {
		await setup.mockInput.pasteBracketedText(value);
		await setup.flush();
		for (const width of [87, 52]) {
			setup.resize(width, 30);
			await setup.flush();
			const lines = assertCustomBounded(setup);
			const start = lines.findIndex(line => line.includes('Custom:'));
			const end = lines.findIndex(line => line.includes('▌'));
			expect(start).toBeGreaterThanOrEqual(0);
			const answerRows = lines
				.slice(start, end + 1)
				.map(line => line.split('│')[1]!.trim());
			expect(answerRows).not.toContain('');
			expect(answerRows.join(' ').replace(/\s+/g, ' ')).toBe(
				`Custom: ${value}▌`,
			);
		}
	} finally {
		setup.renderer.destroy();
	}
});

test('custom answer grows on typing and shrinks after deletion without footer overlap', async () => {
	const setup = await mountCustom();
	try {
		await setup.flush();
		setup.mockInput.pressArrow('up');
		setup.mockInput.pressEnter();
		await setup.flush();
		const initial = rows(setup).filter(line => line.includes('│')).length;
		const value = 'release-'.repeat(20) + 'end';
		await setup.mockInput.typeText(value);
		await setup.flush();
		const expanded = assertCustomBounded(setup);
		expect(expanded.join('\n')).toContain('end▌');
		expect(expanded.filter(line => line.includes('│')).length).toBeGreaterThan(
			initial,
		);
		for (let index = 0; index < value.length; index++)
			setup.mockInput.pressBackspace();
		await setup.flush();
		expect(
			assertCustomBounded(setup).filter(line => line.includes('│')).length,
		).toBe(initial);
	} finally {
		setup.renderer.destroy();
	}
});

test('pasted custom answer reflows on resize and keeps its tail and footer in a short viewport', async () => {
	const setup = await mountCustom();
	const value = 'release '.repeat(80) + 'TAIL';
	try {
		await setup.mockInput.pasteBracketedText(value);
		await setup.flush();
		expect(assertCustomBounded(setup).join('\n')).toContain('TAIL▌');
		for (const [width, height] of [
			[38, 16],
			[26, 9],
			[90, 30],
		]) {
			setup.resize(width!, height!);
			await setup.flush();
			expect(assertCustomBounded(setup).join('\n')).toContain('TAIL▌');
		}
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(setup.answer()).toBe(value);
	} finally {
		setup.renderer.destroy();
	}
});

test('multiline Unicode custom answers retain graphemes, blank rows, and submitted text', async () => {
	const setup = await mountCustom(38, 24);
	const value = 'café\n\n界'.repeat(3) + ' 👩‍💻 '.repeat(8) + '\nTAIL';
	try {
		await setup.mockInput.pasteBracketedText(value);
		await setup.flush();
		const text = assertCustomBounded(setup).join('\n');
		expect(text).toContain('TAIL▌');
		expect(text).toContain('👩‍💻');
		expect(text).not.toContain('�');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(setup.answer()).toBe(value);
	} finally {
		setup.renderer.destroy();
	}
});

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
