import {expect, test} from 'bun:test';
import {formatToolEntry} from './tool-display';

function preview(
	oldString: string,
	newString: string,
	updated: string,
	line: number,
) {
	return formatToolEntry(
		{
			name: 'edit_file',
			detail: 'journal.md',
			output: `Replaced 1 occurrence in journal.md (at line ${line})\n${updated}`,
			args: {path: 'journal.md', old_string: oldString, new_string: newString},
		},
		true,
		'done',
		true,
		true,
		84,
	);
}

test('inserted journal entry leaves unchanged Markdown bullets neutral', () => {
	const oldString =
		'- 09:00 MDT — Started the shift.\n- 12:47 MDT — Examining baselines.';
	const newString =
		'- 09:00 MDT — Started the shift.\n- 10:18 MDT — Updated channel.\n- 12:47 MDT — Examining baselines.';
	const result = preview(
		oldString,
		newString,
		'# Date\nEarlier entry\n' + newString + '\nLater entry\n',
		3,
	);
	expect(result).toContain('     3   - 09:00 MDT — Started the shift.');
	expect(result).toContain('     4 + - 10:18 MDT — Updated channel.');
	expect(result).toContain('     5   - 12:47 MDT — Examining baselines.');
	expect(result).not.toMatch(/\n\s+3 - - 09:00|\n\s+5 - - 12:47/);
	expect(result).not.toContain('Earlier entry');
	expect(result).not.toContain('Later entry');
});

test('replacement gets one outside line on either side, with file-absolute positions', () => {
	const result = preview('old', 'new', 'first\nabove\nnew\nbelow\nlast', 3);
	expect(result).toContain('     2   above');
	expect(result).toContain('     3 - old');
	expect(result).toContain('     3 + new');
	expect(result).toContain('     4   below');
	expect(result).not.toContain('   first');
	expect(result).not.toContain('   last');
});

test('file boundaries do not produce phantom context rows', () => {
	const result = preview('old', 'new', 'new\nend', 1);
	expect(result).toContain('     1 - old');
	expect(result).toContain('     1 + new');
	expect(result).toContain('     2   end');
	expect(result).not.toMatch(/\n\s+0\s/);
	expect((result.match(/\n\s+\d+\s+[-+ ]\s/g) ?? []).length).toBe(3);
});

test('nearby changes share unchanged context instead of duplicating it', () => {
	const result = preview(
		'old A\nshared\nold B',
		'new A\nshared\nnew B',
		'before\nnew A\nshared\nnew B\nafter',
		2,
	);
	expect((result.match(/\d+   shared/g) ?? []).length).toBe(1);
	expect(result).toContain('     3   shared');
	expect(result).toContain('     5   after');
});
test('mid-line replacement borrows real neighboring file lines', () => {
	const result = preview('old', 'new', 'above\nprefix new suffix\nbelow', 2);
	expect(result).toContain('     1   above');
	expect(result).toContain('     3   below');
});
test('multiple replacements never claim a changed line is unchanged', () => {
	const result = formatToolEntry(
		{
			name: 'string_replace',
			detail: 'journal.md',
			output:
				'Replaced 2 occurrences in journal.md (at line 2)\nabove\nnew\nnew\nbelow',
			args: {path: 'journal.md', old_string: 'old', new_string: 'new'},
		},
		true,
		'done',
		true,
		true,
		84,
	);
	expect(result).not.toContain('     3   new');
});
