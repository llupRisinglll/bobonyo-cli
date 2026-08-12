import {describe, expect, test} from 'bun:test';
import {liveRowSegments, splitChunksByLine} from './live-tool-row';
import {tokenizeBashRow} from './row-highlight';
import {colors} from './theme';
import {formatOutputTail} from './tool-display';

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

	test('live body lines are byte-identical to the settled output tail', () => {
		// The settled row and the live row both go through formatOutputTail,
		// so the `  └   ` container + cap + `+N lines` footer must match
		// exactly while streaming and when done (spacing parity).
		const output =
			'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7';
		const settledTail = formatOutputTail(output, false).split('\n');
		const {body} = liveRowSegments(
			`Bash(echo hi)\n${settledTail.join('\n')}`,
			'bashrow',
			'running',
			colors(),
			80,
		);
		expect(body.map(line => line.map(c => c.text).join(''))).toEqual(
			settledTail,
		);
	});

	test('long output lines wrap INSIDE the └ container (never column 0)', () => {
		const longLine = 'x'.repeat(200);
		const tail = formatOutputTail(longLine, false).split('\n');
		// Every rendered line keeps the indent prefix (`  └   ` first,
		// `      ` continuations) — nothing can escape the container.
		expect(tail.length).toBeGreaterThan(1);
		for (const [index, line] of tail.entries()) {
			if (line.startsWith('…')) continue;
			if (index === 0) expect(line.startsWith('  └   ')).toBe(true);
			else expect(line.startsWith('      ')).toBe(true);
		}
		// The wrapped content never exceeds the container width.
		for (const line of tail) {
			if (!line.startsWith('…')) expect(line.length).toBeLessThanOrEqual(91);
		}
	});
});
