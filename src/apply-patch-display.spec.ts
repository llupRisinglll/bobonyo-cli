import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPatchDisplayChanges} from './apply-patch';
import {formatToolEntry, rowLanguage} from './tool-display';
import {tokenizeFileDiff} from './row-highlight';
import {colors} from './theme';

function rgb(
	chunk: ReturnType<typeof tokenizeFileDiff>[number],
): string | null {
	if (!chunk.fg) return null;
	return `${Math.round(chunk.fg.r * 255)},${Math.round(chunk.fg.g * 255)},${Math.round(chunk.fg.b * 255)}`;
}

function themeRgb(hex: string): string {
	return `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
}

test('apply_patch renders every mutation as a numbered multi-file DiffView', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'bobonyo-patch-display-'));
	writeFileSync(join(cwd, 'old.txt'), 'before\nold\nafter\n');
	writeFileSync(join(cwd, 'gone.txt'), 'gone\n');
	const patchText = `*** Begin Patch
*** Add File: new.txt
+new
*** Update File: old.txt
*** Move to: moved.txt
@@
 before
-old
+changed
 after
*** Delete File: gone.txt
*** End Patch`;
	try {
		const display = applyPatchDisplayChanges(cwd, patchText);
		const rendered = formatToolEntry(
			{
				name: 'apply_patch',
				detail: '',
				output:
					'Applied patch successfully.\nA new.txt (+1 -0)\nR moved.txt (+1 -1)\nD gone.txt (+0 -1)',
				args: {patchText, _applyPatchDisplay: display},
			},
			false,
			'done',
		);
		expect(rowLanguage('apply_patch')).toBe('filediff');
		expect(rendered).not.toContain('Edited 3 files');
		expect(rendered).not.toContain('ApplyPatch');
		expect(rendered).toContain('✦ Create new.txt (+1 -0)');
		expect(rendered).toContain('Move old.txt → moved.txt (+1 -1)');
		expect(rendered).toContain('1   new');
		expect(rendered).toContain('2 - old');
		expect(rendered).toContain('2 + changed');
		expect(rendered).toContain('Delete gone.txt (+0 -1)');
		expect(rendered).toContain('1 - gone');

		const inner = rendered
			.split('\n')
			.filter(line => !/^\s*```/.test(line))
			.join('\n');
		const chunks = tokenizeFileDiff(inner, '', 'done', colors(), 84);
		expect(rgb(chunks.find(chunk => chunk.text === 'Create')!)).toBe(
			themeRgb(colors().primary),
		);
		expect(rgb(chunks.find(chunk => chunk.text === ' new.txt')!)).toBe(
			themeRgb(colors().text),
		);
		expect(rgb(chunks.find(chunk => chunk.text === ' (+1')!)).toBe(
			themeRgb(colors().success),
		);
		expect(rgb(chunks.find(chunk => chunk.text === '-0)')!)).toBe(
			themeRgb(colors().error),
		);
		const created = chunks.find(chunk => chunk.text === 'new');
		expect(created).toBeDefined();
		expect(created?.bg).toBeUndefined();
	} finally {
		rmSync(cwd, {recursive: true, force: true});
	}
});

test('failed apply_patch display says failed instead of implying an edit', () => {
	const rendered = formatToolEntry(
		{
			name: 'apply_patch',
			detail: '',
			output: 'patch path escapes workspace: ../../outside.ts',
			args: {
				patchText:
					'*** Begin Patch\n*** Update File: ../../outside.ts\n@@\n-old\n+new\n*** End Patch',
			},
		},
		false,
		'done',
	);
	expect(rendered).toContain('✦ Edit files (failed)');
	expect(rendered).toContain('patch path escapes workspace');
	expect(rendered).not.toContain('\n✦ Edit files\n');
});
