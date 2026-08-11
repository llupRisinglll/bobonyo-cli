import {describe, expect, test} from 'bun:test';
import {buildBannerBox} from './banner';

const BASE = {
	titleShape: 'powerline-angled',
	model: 'mock-model-1',
	permissions: 'YOLO mode',
	cwd: '/mnt/data/KSProjects/NanoCollective/bobonyo',
};

/** Strip the `│ ` prefix / ` │` suffix and return the interior text. */
function interior(line: string): string {
	return line.replace(/^│ /, '').replace(/ │$/, '');
}

function keyColumn(line: string, key: string): number {
	const text = interior(line);
	return text.indexOf(key);
}

describe('buildBannerBox', () => {
	test('all keys start on the same column', () => {
		const box = buildBannerBox(BASE);
		const lines = box.trimEnd().split('\n');
		expect(lines[0]).toMatch(/^╭─/);
		expect(lines[lines.length - 1]).toMatch(/^╰─/);
		const title = lines[1] ?? '';
		const model = lines[2] ?? '';
		const dir = lines[3] ?? '';
		const perm = lines[4] ?? '';
		const cols = [
			keyColumn(title, 'bobonyo'),
			keyColumn(model, 'model:'),
			keyColumn(dir, 'directory:'),
			keyColumn(perm, 'permissions:'),
		];
		expect(new Set(cols).size).toBe(1);
	});

	test('box fits its content, every line has the same width', () => {
		const box = buildBannerBox(BASE);
		const lines = box.trimEnd().split('\n');
		const widths = new Set(lines.map(line => line.length));
		expect(widths.size).toBe(1);
		// The box is content-sized, not full-width.
		expect(lines[0]?.length).toBeLessThan(80);
	});

	test('unboxed (title shape none) keeps the aligned keys', () => {
		const box = buildBannerBox({...BASE, titleShape: 'none'});
		const lines = box.trimEnd().split('\n');
		expect(lines[0]).not.toMatch(/^╭/);
		const cols = [
			keyColumn(`│ ${lines[0] ?? ''} │`, 'bobonyo'),
			keyColumn(`│ ${lines[1] ?? ''} │`, 'model:'),
			keyColumn(`│ ${lines[2] ?? ''} │`, 'directory:'),
			keyColumn(`│ ${lines[3] ?? ''} │`, 'permissions:'),
		];
		expect(new Set(cols).size).toBe(1);
	});

	test('long directory truncation never overflows the box', () => {
		const box = buildBannerBox({
			...BASE,
			cwd: '/a/very/very/very/long/path/that/keeps/going/and/going/and/going/and/going/bobonyo',
		});
		const lines = box.trimEnd().split('\n');
		const widths = new Set(lines.map(line => line.length));
		expect(widths.size).toBe(1);
	});
});
