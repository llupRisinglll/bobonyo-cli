import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPatchDisplayChanges} from './apply-patch';
import {formatToolEntry} from './tool-display';

function display(files: Record<string, string>, patch: string) {
	const cwd = mkdtempSync(join(tmpdir(), 'bobonyo-patch-context-'));
	try {
		for (const [path, content] of Object.entries(files))
			writeFileSync(join(cwd, path), content);
		return applyPatchDisplayChanges(cwd, patch);
	} finally {
		rmSync(cwd, {recursive: true, force: true});
	}
}

test('apply_patch borrows three unchanged file lines around every sparse hunk', () => {
	const source =
		Array.from({length: 300}, (_, index) => `line ${index + 1}`).join('\n') +
		'\n';
	const patch = [
		'*** Begin Patch',
		'*** Update File: context-window.ts',
		'@@',
		'-line 8',
		'+new 8',
		'@@',
		'-line 56',
		'+new 56',
		'@@',
		'-line 283',
		'+new 283',
		'*** End Patch',
	].join('\n');
	const [change] = display({'context-window.ts': source}, patch);
	for (const line of [
		5, 6, 7, 9, 10, 11, 53, 54, 55, 57, 58, 59, 280, 281, 282, 284, 285, 286,
	])
		expect(change!.rows).toContainEqual({
			kind: 'context',
			line,
			text: `line ${line}`,
			...([53, 280].includes(line) ? {gapBefore: true} : {}),
		});
	expect(change!.rows.filter(row => row.kind === 'context')).toHaveLength(18);
});

test('nearby hunks share context without painting changed neighbors as unchanged', () => {
	const patch = [
		'*** Begin Patch',
		'*** Update File: model-modal.ts',
		'@@',
		'-b',
		'+B',
		'@@',
		'-c',
		'+C',
		'*** End Patch',
	].join('\n');
	const [change] = display({'model-modal.ts': 'a\nb\nc\nd\n'}, patch);
	expect(change!.rows.filter(row => row.kind === 'context')).toEqual([
		{kind: 'context', line: 1, text: 'a'},
		{kind: 'context', line: 4, text: 'd'},
	]);
});

test('context uses updated line positions after insertion and never invents EOF', () => {
	const patch = [
		'*** Begin Patch',
		'*** Update File: f.ts',
		'@@',
		' a',
		'+inserted',
		'@@',
		'-c',
		'+C',
		'*** End Patch',
	].join('\n');
	const [change] = display({'f.ts': 'a\nb\nc\n'}, patch);
	expect(change!.rows.filter(row => row.kind === 'context')).toEqual([
		{kind: 'context', line: 1, text: 'a'},
		{kind: 'context', line: 3, text: 'b'},
	]);
	expect(change!.rows.at(-1)).toEqual({kind: 'add', line: 4, text: 'C'});
});

test('pure insertion previews append at EOF with preceding file context', () => {
	const patch =
		'*** Begin Patch\n*** Update File: f.ts\n@@\n+added\n*** End Patch';
	const [change] = display({'f.ts': 'first\nlast\n'}, patch);
	expect(change!.rows).toEqual([
		{kind: 'context', line: 1, text: 'first'},
		{kind: 'context', line: 2, text: 'last'},
		{kind: 'add', line: 3, text: 'added'},
	]);
});
test('screenshot insertion 86–100 has context 83–85 before and 101–103 after', () => {
	const source = Array.from({length: 110}, (_, index) => `source ${index + 1}`);
	const additions = Array.from(
		{length: 15},
		(_, index) => `insert ${index + 86}`,
	);
	const patch = [
		'*** Begin Patch',
		'*** Update File: spec.ts',
		'@@',
		' source 85',
		...additions.map(text => `+${text}`),
		' source 86',
		'*** End Patch',
	].join('\n');
	const [change] = display({'spec.ts': source.join('\n') + '\n'}, patch);
	expect(change!.rows.map(row => [row.kind, row.line])).toEqual([
		...[83, 84, 85].map(line => ['context' as const, line]),
		...additions.map((_, index) => ['add' as const, index + 86]),
		...[101, 102, 103].map(line => ['context' as const, line]),
	]);
	expect(change!.rows.at(-3)?.text).toBe('source 86');
});
test('screenshot replacement gets trailing context and explicit omitted ranges', () => {
	const source = Array.from({length: 500}, (_, index) => `source ${index + 1}`);
	const patch = [
		'*** Begin Patch',
		'*** Update File: apply-patch.ts',
		'@@',
		' source 470',
		'+inserted',
		...source.slice(470, 479).map(text => ` ${text}`),
		'-source 480',
		'+replacement A',
		'+replacement B',
		'+replacement C',
		'+replacement D',
		'*** End Patch',
	].join('\n');
	const [change] = display({'apply-patch.ts': source.join('\n') + '\n'}, patch);
	const contexts = change!.rows.filter(row => row.kind === 'context');
	expect(contexts.map(row => row.line)).toEqual([
		468, 469, 470, 472, 473, 474, 478, 479, 480, 485, 486, 487,
	]);
	const rendered = formatToolEntry(
		{
			name: 'apply_patch',
			detail: '',
			output: 'Applied patch successfully.',
			args: {patchText: patch, _applyPatchDisplay: [change]},
		},
		true,
		'done',
	);
	expect(rendered).toMatch(/474   source 473\n\s+…\n\s+478   source 477/);
});

test('EOF insertion followed by an earlier replacement keeps file order and numbering', () => {
	const patch =
		'*** Begin Patch\n*** Update File: f.ts\n@@\n+added\n@@\n-b\n+B\n*** End Patch';
	const [change] = display({'f.ts': 'a\nb\nc\n'}, patch);
	expect(change!.rows).toEqual([
		{kind: 'context', line: 1, text: 'a'},
		{kind: 'remove', line: 2, text: 'b'},
		{kind: 'add', line: 2, text: 'B'},
		{kind: 'context', line: 3, text: 'c'},
		{kind: 'add', line: 4, text: 'added'},
	]);
});

test('repeated pure EOF insertions match patch application order', () => {
	const patch =
		'*** Begin Patch\n*** Update File: f.ts\n@@\n+first\n@@\n+second\n*** End Patch';
	const [change] = display({'f.ts': 'a\n'}, patch);
	expect(change!.rows).toEqual([
		{kind: 'context', line: 1, text: 'a'},
		{kind: 'add', line: 2, text: 'second'},
		{kind: 'add', line: 3, text: 'first'},
	]);
});

test('empty-file insertion has no nonexistent surrounding context', () => {
	const patch =
		'*** Begin Patch\n*** Update File: f.ts\n@@\n+added\n*** End Patch';
	const [change] = display({'f.ts': ''}, patch);
	expect(change!.rows).toEqual([{kind: 'add', line: 1, text: 'added'}]);
});
test('BOF and EOF replacements borrow only real file rows', () => {
	const patch = [
		'*** Begin Patch',
		'*** Update File: f.ts',
		'@@',
		'-first',
		'+FIRST',
		'@@',
		'-last',
		'+LAST',
		'*** End Patch',
	].join('\n');
	const [change] = display({'f.ts': 'first\n\nlast\n'}, patch);
	expect(change!.rows.filter(row => row.kind === 'context')).toEqual([
		{kind: 'context', line: 2, text: ''},
	]);
	expect(change!.rows.every(row => row.line >= 1 && row.line <= 3)).toBe(true);
});
test('large patch anchor ranges do not render unrelated unchanged lines', () => {
	const source = Array.from({length: 200}, (_, index) => `source ${index + 1}`);
	const patch = [
		'*** Begin Patch',
		'*** Update File: f.ts',
		'@@',
		...source.slice(0, 99).map(text => ` ${text}`),
		'-source 100',
		'+replacement',
		...source.slice(100).map(text => ` ${text}`),
		'*** End Patch',
	].join('\n');
	const [change] = display({'f.ts': source.join('\n') + '\n'}, patch);
	expect(
		change!.rows.filter(row => row.kind === 'context').map(row => row.line),
	).toEqual([97, 98, 99, 101, 102, 103]);
	expect(change!.rows).toHaveLength(8);
});

test('multi-file apply_patch previews keep exactly one empty row between files', () => {
	const patchText = [
		'*** Begin Patch',
		'*** Update File: first.ts',
		'@@',
		'-old',
		'+new',
		'*** Update File: second.ts',
		'@@',
		'-old',
		'+new',
		'*** End Patch',
	].join('\n');
	const changes = display(
		{
			'first.ts': 'above\nold\nbelow\n',
			'second.ts': 'above\nold\nbelow\n',
		},
		patchText,
	);
	for (const briefed of [false, true]) {
		const rendered = formatToolEntry(
			{
				name: 'apply_patch',
				detail: '',
				output: 'Applied patch successfully.',
				briefed,
				args: {patchText, _applyPatchDisplay: changes},
			},
			true,
			'done',
		);
		expect(rendered).toMatch(/3   below\n\n[^\n]*Edit second\.ts/);
		expect(rendered).not.toContain('\n\n\n');
	}
});
