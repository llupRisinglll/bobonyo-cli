import {describe, expect, test} from 'bun:test';
import {liveRowSegments, splitChunksByLine} from './live-tool-row';
import {tokenizeBashRow} from './row-highlight';
import {colors} from './theme';

describe('splitChunksByLine', () => {
	test('splits a chunk stream on newline separators', () => {
		const chunks = tokenizeBashRow(
			'Bash(echo hi)\n  └   line 1\n      line 2',
			'running',
			colors(),
		);
		const lines = splitChunksByLine(chunks);
		expect(lines.length).toBe(3);
		expect(lines[0]!.map(c => c.text).join('')).toBe('Bash(echo hi)');
		expect(lines[1]!.map(c => c.text).join('')).toBe('  └   line 1');
		expect(lines[2]!.map(c => c.text).join('')).toBe('      line 2');
	});
});

describe('liveRowSegments', () => {
	test('strips the glyph from the header and keeps the bash syntax chunks', () => {
		const {header, body} = liveRowSegments(
			'✦ Bash(for i in $(seq 1 16); do echo "line $i"; done)\n  └   line 1',
			'bashrow',
			'running',
			colors(),
			80,
		);
		// Glyph is NOT part of the chunks (it renders separately/blinks).
		expect(header.map(c => c.text).join('')).not.toContain('✦');
		expect(header.map(c => c.text).join('')).toContain('Bash');
		// Keyword/string/number syntax colors survive the live split.
		const joined = header.map(c => c.text).join('');
		expect(joined).toContain('do');
		expect(joined).toContain('"line $i"');
		expect(body.length).toBe(1);
		expect(body[0]!.map(c => c.text).join('')).toBe('  └   line 1');
	});
});
