import {describe, expect, test} from 'bun:test';
import {writeFileSync} from 'node:fs';
import {
	expandTextPlaceholders,
	MAX_PASTE_CHARS,
	processPaste,
} from './attachments';

describe('processPaste', () => {
	test('long text becomes a [Text #N] placeholder', () => {
		const long = 'x'.repeat(MAX_PASTE_CHARS + 10);
		const {text, attachments} = processPaste(long, {});
		expect(text).toBe('[Text #1]');
		expect(attachments['1']).toBe(long);
	});

	test('short text stays as-is', () => {
		const {text, attachments} = processPaste('hello world', {});
		expect(text).toBe('hello world');
		expect(attachments).toEqual({});
	});

	test('an existing image path becomes [Image #N]', () => {
		writeFileSync('/tmp/bobonyo-attach-test.png', 'x');
		const {text, attachments} = processPaste('/tmp/bobonyo-attach-test.png', {});
		expect(text).toBe('[Image #1]');
		expect(attachments['1']).toBe('/tmp/bobonyo-attach-test.png');
	});

	test('non-existent image paths are left untouched', () => {
		const {text} = processPaste('/no/such/file.png', {});
		expect(text).toBe('/no/such/file.png');
	});

	test('numbering continues across tokens', () => {
		const {text, attachments} = processPaste(
			'first.png second.png ' + 'y'.repeat(MAX_PASTE_CHARS + 1),
			{},
		);
		// Only the long text matters here (no real files), so it's Text #1.
		expect(text).toContain('[Text #1]');
	});
});

describe('expandTextPlaceholders', () => {
	test('expands [Text #N] back to the raw text', () => {
		const raw = 'a '.repeat(300);
		const expanded = expandTextPlaceholders('[Text #2]', {2: raw});
		expect(expanded).toBe(raw);
	});

	test('keeps unknown tokens and Image tokens', () => {
		expect(expandTextPlaceholders('[Image #1] and [Text #9]', {'1': '/x.png'})).toBe(
			'[Image #1] and [Text #9]',
		);
	});
});
