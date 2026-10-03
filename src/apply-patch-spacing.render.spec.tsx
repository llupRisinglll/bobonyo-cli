import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {FileToolRow} from './components/file-tool-row';
import {liveRowSegments} from './live-tool-row';
import {formatToolEntry} from './tool-display';
import {colors} from './theme';
import {markdownSyntaxStyleFor} from './syntax';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executeTool} from './tools';

test('file formatter retains an explicit inter-file spacer', () => {
	const source = readFileSync(
		`${import.meta.dir}/tool-display-files.ts`,
		'utf8',
	);
	expect(source).toContain("...(changeIndex > 0 ? [''] : [])");
});
test('production insertion renders context before 86 and after 100 with updated positions', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'bobonyo-live-patch-context-'));
	let setup: Awaited<ReturnType<typeof testRender>> | undefined;
	try {
		const source = Array.from(
			{length: 110},
			(_, index) => `source ${index + 1}`,
		);
		writeFileSync(join(cwd, 'spec.ts'), source.join('\n') + '\n');
		const patchText = [
			'*** Begin Patch',
			'*** Update File: spec.ts',
			'@@',
			' source 85',
			...Array.from({length: 15}, (_, index) => `+insert ${index + 86}`),
			' source 86',
			'*** End Patch',
		].join('\n');
		const result = await executeTool(
			{
				id: 'live-context-regression',
				name: 'apply_patch',
				arguments: {patchText},
				rawArguments: '{}',
			},
			{cwd},
		);
		expect(result.content).toStartWith('Applied patch successfully.');
		const raw = formatToolEntry(
			{
				name: 'apply_patch',
				detail: '',
				output: result.content,
				args: result.displayArgs,
			},
			true,
			'done',
		);
		const inner = raw
			.split('\n')
			.filter(line => !/^\s*```/.test(line))
			.join('\n');
		const segments = liveRowSegments(inner, 'filediff', 'done', colors(), 84);
		setup = await testRender(
			() => (
				<FileToolRow
					header={segments.header}
					body={segments.body}
					status="done"
					glyph="✦"
					hovered={false}
					md={{
						syntaxStyle: () => markdownSyntaxStyleFor(colors()),
						renderNode: () => undefined,
						treeSitter: undefined,
					}}
				/>
			),
			{width: 84, height: 30},
		);
		await setup.flush();
		const rows = setup.captureSpans().lines.map(line =>
			line.spans
				.map(span => span.text)
				.join('')
				.trimEnd(),
		);
		const firstAdd = rows.findIndex(line => line.includes('86 + insert 86'));
		const lastAdd = rows.findIndex(line => line.includes('100 + insert 100'));
		expect(rows.slice(firstAdd - 3, firstAdd).map(line => line.trim())).toEqual(
			['83   source 83', '84   source 84', '85   source 85'],
		);
		expect(
			rows.slice(lastAdd + 1, lastAdd + 4).map(line => line.trim()),
		).toEqual(['101   source 86', '102   source 87', '103   source 88']);
		expect(rows.some(line => /86   source 86/.test(line))).toBe(false);
	} finally {
		setup?.renderer.destroy();
		rmSync(cwd, {recursive: true, force: true});
	}
});

test('multi-file patch paints one blank terminal row between file blocks', async () => {
	const raw = formatToolEntry(
		{
			name: 'apply_patch',
			detail: '',
			output: 'Applied patch successfully.',
			args: {
				patchText: '*** Begin Patch\n*** End Patch',
				_applyPatchDisplay: ['first.ts', 'second.ts'].map(path => ({
					type: 'update',
					path,
					rows: [
						{kind: 'context', line: 1, text: 'above'},
						{kind: 'remove', line: 2, text: 'old'},
						{kind: 'add', line: 2, text: 'new'},
						{kind: 'context', line: 3, text: 'below'},
					],
				})),
			},
		},
		true,
		'done',
	);
	const inner = raw
		.split('\n')
		.filter(line => !/^\s*```/.test(line))
		.join('\n');
	const segments = liveRowSegments(inner, 'filediff', 'done', colors(), 84);
	const setup = await testRender(
		() => (
			<FileToolRow
				header={segments.header}
				body={segments.body}
				status="done"
				glyph="✦"
				hovered={false}
				md={{
					syntaxStyle: () => markdownSyntaxStyleFor(colors()),
					renderNode: () => undefined,
					treeSitter: undefined,
				}}
			/>
		),
		{width: 84, height: 20},
	);
	try {
		await setup.flush();
		const rows = setup.captureSpans().lines.map(line =>
			line.spans
				.map(span => span.text)
				.join('')
				.trimEnd(),
		);
		const firstBelow = rows.findIndex(line => line.includes('3   below'));
		const secondHeader = rows.findIndex(line =>
			line.includes('Edit second.ts'),
		);
		expect(firstBelow).toBeGreaterThan(0);
		expect(secondHeader).toBe(firstBelow + 2);
		expect(rows[firstBelow + 1]).toBe('');
	} finally {
		setup.renderer.destroy();
	}
});
