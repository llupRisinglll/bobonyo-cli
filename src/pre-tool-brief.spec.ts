import {expect, test} from 'bun:test';
import {
	oneSentencePreToolBrief,
	splitPreToolText,
	toolCallBrief,
} from './pre-tool-brief';

test('pre-tool brief keeps only first sentence', () => {
	expect(
		oneSentencePreToolBrief(
			'Inspect task rendering first. Then patch it.\n\nAfter that, run tests.',
		),
	).toBe('Inspect task rendering first.');
});

test('pre-tool brief flattens one sentence to one line', () => {
	expect(
		oneSentencePreToolBrief('Inspect task\nrendering before patching'),
	).toBe('Inspect task rendering before patching');
});
test('pre-tool text preserves prose after brief sentence', () => {
	expect(
		splitPreToolText(
			'Inspect files first. I found the likely bug and will fix it.',
		),
	).toEqual({
		brief: 'Inspect files first.',
		remainder: 'I found the likely bug and will fix it.',
	});
});

test('pre-tool text preserves Markdown entries instead of hiding them in brief chrome', () => {
	const markdown =
		'## Findings\n\nThe launcher inherits the parent process.\n\n- Keep cwd stable.';
	expect(splitPreToolText(markdown)).toEqual({brief: '', remainder: markdown});
});

test('plain declarative assistant sentence remains a normal transcript entry', () => {
	const prose = 'The launcher inherits the parent process.';
	expect(splitPreToolText(prose)).toEqual({brief: '', remainder: prose});
});

test('multi-line plain prose remains a normal Markdown entry', () => {
	const prose = 'I found the issue.\n\nThe next tool call checks the fix.';
	expect(splitPreToolText(prose)).toEqual({brief: '', remainder: prose});
});

test('later tool rounds inherit the brief batch indentation marker', () => {
	expect(toolCallBrief('Inspect files.', 0, false)).toBe('Inspect files.');
	expect(toolCallBrief('Inspect files.', 1, false)).toBe(' ');
	expect(toolCallBrief('', 0, true)).toBe(' ');
	expect(toolCallBrief('', 0, false)).toBeUndefined();
});
