import {describe, expect, test} from 'bun:test';
import {colorDetailLine} from './components/details-modal';
import {colors} from './theme';

const attrs = {bold: () => 1, dim: () => 2};

describe('colorDetailLine', () => {
	test('colors the FULL tool name primary, not the first letter', () => {
		const segments = colorDetailLine(
			'✦ Bash(for i in $(seq 1 16); do echo "line $i"; done)',
			colors(),
			attrs,
		);
		expect(segments.length).toBe(3);
		expect(segments[0]!.text).toBe('✦ ');
		expect(segments[1]!.text).toBe('Bash');
		expect(segments[1]!.fg).toBe(colors().primary);
		expect(segments[2]!.text).toBe(
			'(for i in $(seq 1 16); do echo "line $i"; done)',
		);
		expect(segments[2]!.fg).toBe(colors().secondary);
	});

	test('keeps underscored tool names whole', () => {
		const segments = colorDetailLine(
			'✦ WebSearch(nanocoder fullscreen alternate screen)',
			colors(),
			attrs,
		);
		expect(segments[1]!.text).toBe('WebSearch');
	});

	test('output lines render secondary dim', () => {
		const [seg] = colorDetailLine('  └   EXIT_CODE: 0', colors(), attrs);
		expect(seg!.text).toBe('  └   EXIT_CODE: 0');
		expect(seg!.fg).toBe(colors().secondary);
	});

	test('plain text stays text-colored', () => {
		const [seg] = colorDetailLine('Diagnostics: no issues found.', colors(), attrs);
		expect(seg!.fg).toBe(colors().text);
	});
});
