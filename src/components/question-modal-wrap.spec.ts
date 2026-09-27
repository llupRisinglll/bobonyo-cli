import {expect, test} from 'bun:test';
import {wrapQuestionText} from './question-modal-wrap';

test('overflowing word separators do not create phantom blank display rows', () => {
	expect(wrapQuestionText('word next▌', 4)).toEqual(['word', 'next', '▌']);
	expect(wrapQuestionText('word\n\nnext▌', 4)).toEqual([
		'word',
		'',
		'next',
		'▌',
	]);
});

test('question rows fit terminal cells including trailing spaces and Unicode', () => {
	for (const value of [
		'Custom: word '.repeat(20) + '▌',
		'界👩‍💻é'.repeat(20) + '▌',
	]) {
		for (const width of [8, 18, 32, 56]) {
			const rows = wrapQuestionText(value, width);
			for (const row of rows)
				expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
			expect(rows.at(-1)).toContain('▌');
			expect(rows.join('')).not.toContain('�');
		}
	}
});

test('question rows preserve explicit blank lines and Unicode graphemes', () => {
	expect(wrapQuestionText('café\n\n界\n', 8)).toEqual(['café', '', '界', '']);
	expect(wrapQuestionText('👩‍💻👩‍💻👩‍💻', 4)).toEqual(['👩‍💻👩‍💻', '👩‍💻']);
});
