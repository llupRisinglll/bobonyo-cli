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

test('later tool rounds inherit the brief batch indentation marker', () => {
	expect(toolCallBrief('Inspect files.', 0, false)).toBe('Inspect files.');
	expect(toolCallBrief('Inspect files.', 1, false)).toBe(' ');
	expect(toolCallBrief('', 0, true)).toBe(' ');
	expect(toolCallBrief('', 0, false)).toBeUndefined();
});
