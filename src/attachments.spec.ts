import {describe, expect, test} from 'bun:test';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	expandTextPlaceholders,
	imageSourceContext,
	MAX_PASTE_CHARS,
	persistImageAttachments,
	processPaste,
	referencedImageAttachments,
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
		const {text, attachments} = processPaste(
			'/tmp/bobonyo-attach-test.png',
			{},
		);
		expect(text).toBe('[Image #1]');
		expect(attachments['1']).toBe('/tmp/bobonyo-attach-test.png');
	});

	test('non-existent image paths are left untouched', () => {
		const {text} = processPaste('/no/such/file.png', {});
		expect(text).toBe('/no/such/file.png');
	});

	test('caches image bytes immediately while processing paste', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-paste-cache-'));
		try {
			const source = join(root, 'clipboard.png');
			writeFileSync(source, Buffer.from([9, 8, 7]));
			const {text, attachments} = processPaste(
				source,
				{},
				{
					sessionId: 'sess_paste',
					baseDir: join(root, 'data'),
					id: () => 'paste-id',
				},
			);
			expect(text).toBe('[Image #1]');
			expect(attachments['1']).toBe(
				join(root, 'data', 'image-cache', 'sess_paste', 'paste-id.png'),
			);
			expect(readFileSync(attachments['1']!)).toEqual(Buffer.from([9, 8, 7]));
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('keeps embedded image token visible when accompanying text is long', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-mixed-paste-'));
		try {
			const source = join(root, 'receipt.png');
			writeFileSync(source, Buffer.from([1, 2, 3]));
			const longText = 'receipt context '.repeat(30);
			const {text, attachments} = processPaste(`${longText}\n${source}`, {});
			expect(text).toMatch(/^\[Text #\d+\]\s+\[Image #\d+\]$/);
			expect(text).toContain('[Image #1]');
			expect(attachments['1']).toBe(source);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('long text uses next attachment number', () => {
		const raw = 'first.png second.png ' + 'y'.repeat(MAX_PASTE_CHARS + 1);
		const {text, attachments} = processPaste(raw, {});
		expect(text).toBe('[Text #1]');
		expect(attachments['1']).toBe(raw);
	});
	test('short CRLF/CR paste normalizes to LF before cursor mapping', () => {
		const {text} = processPaste('a\r\nb\rc', {});
		expect(text).toBe('a\nb\nc');
	});
});

describe('submitted image attachments', () => {
	test('copies referenced image bytes into durable session storage', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-image-cache-'));
		try {
			const source = join(root, 'source.png');
			writeFileSync(source, Buffer.from([1, 2, 3, 4]));
			const attachments = persistImageAttachments(
				'upload [Image #1]',
				{'1': source},
				'sess_test',
				join(root, 'data'),
				() => 'image-id',
			);
			const stored = attachments['1']!;
			expect(stored).toBe(
				join(root, 'data', 'image-cache', 'sess_test', 'image-id.png'),
			);
			expect(readFileSync(stored)).toEqual(Buffer.from([1, 2, 3, 4]));
			expect(statSync(stored).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('tells model exact local path for shell upload tasks', () => {
		expect(
			imageSourceContext('upload [Image #2]', {'2': '/safe/image.png'}),
		).toBe(
			'\n\n<attached-images>\n[Image #2] source path: "/safe/image.png"\n</attached-images>',
		);
	});
});

describe('expandTextPlaceholders', () => {
	test('expands [Text #N] back to the raw text', () => {
		const raw = 'a '.repeat(300);
		const expanded = expandTextPlaceholders('[Text #2]', {2: raw});
		expect(expanded).toBe(raw);
	});

	test('keeps unknown tokens and Image tokens', () => {
		expect(
			expandTextPlaceholders('[Image #1] and [Text #9]', {'1': '/x.png'}),
		).toBe('[Image #1] and [Text #9]');
	});
});

describe('referencedImageAttachments', () => {
	test('drops stale images and text payloads after submission', () => {
		expect(
			referencedImageAttachments('send [Image #3]', {
				'1': '/old.png',
				'2': 'long pasted text',
				'3': '/current.png',
			}),
		).toEqual({'3': '/current.png'});
	});
});
