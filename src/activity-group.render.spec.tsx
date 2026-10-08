import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {LiveToolRows} from './components/live-tool-rows';
import {formatActivityTree, activityGroupForTool} from './activity-groups';
import {liveRowSegments} from './live-tool-row';
import {colors} from './theme';
import {markdownSyntaxStyleFor} from './syntax';
import type {MarkdownBriefRenderer} from './components/markdown-brief';
import {History, renderToolRun} from './components/history';
import {stripProviderCitationMarkers} from './components/history';
import {webSearchActivityMessage} from './web-search';
import type {ChatMessage} from './state';

const md: MarkdownBriefRenderer = {
	syntaxStyle: () => markdownSyntaxStyleFor(colors()),
	renderNode: () => undefined,
	treeSitter: undefined,
};

function searchMessages(): ChatMessage[] {
	return [
		{
			role: 'tool',
			content: '',
			toolId: 'shell-find',
			tool: {
				name: 'execute_bash',
				detail: 'find…',
				output: 'src/a.ts',
				args: {command: 'find src -type f'},
			},
		},
		{
			role: 'tool',
			content: '',
			toolId: 'shell-grep',
			tool: {
				name: 'execute_bash',
				detail: 'grep…',
				output: 'grep: missing.ts: No such file or directory',
				args: {command: 'grep -n needle missing.ts'},
			},
		},
		{
			role: 'tool',
			content: '',
			toolId: 'read',
			tool: {name: 'read_file', detail: 'src/a.ts', output: 'file contents'},
		},
		{
			role: 'tool',
			content: '',
			toolId: 'unsafe',
			tool: {
				name: 'execute_bash',
				detail: 'find src -type f -delete',
				output: 'mutation output',
				args: {command: 'find src -type f -delete'},
			},
		},
	];
}

test('History groups shell find/grep with reads but keeps unsafe Bash cards', async () => {
	const messages = searchMessages();
	const setup = await testRender(
		() => (
			<History
				embedded
				width={100}
				height={30}
				messages={() => messages}
				running={() => false}
				reasoning={() => ''}
				streaming={() => ''}
				liveOutputs={() => ({})}
			/>
		),
		{width: 100, height: 30},
	);
	try {
		await Bun.sleep(180);
		await setup.flush();
		const text = setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
		expect(text.match(/Explored/g)).toHaveLength(1);
		expect(text).toContain('├ Search find src -type f');
		expect(text).toContain('├ Search grep -n needle missing.ts');
		expect(text).toContain('└ Read src/a.ts');
		expect(text).toContain('find src -type f -delete');
		expect(text).toContain('mutation output');
		expect(text).not.toContain('Search find src -type f -delete');
		expect(text).not.toContain('find…');
	} finally {
		setup.renderer.destroy();
	}
});

test('native provider web search renders as grouped web activity, not gold info rows', async () => {
	const messages = [
		webSearchActivityMessage({type: 'search', query: 'npm stage approval'}),
		webSearchActivityMessage({
			type: 'open_page',
			url: 'https://docs.npmjs.com',
		}),
	] satisfies ChatMessage[];
	const setup = await testRender(
		() => (
			<History
				embedded
				width={90}
				height={18}
				messages={() => messages}
				running={() => false}
				reasoning={() => ''}
				streaming={() => ''}
				liveOutputs={() => ({})}
			/>
		),
		{width: 90, height: 18},
	);
	try {
		await Bun.sleep(180);
		await setup.flush();
		const text = setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
		expect(text).toContain('Navigated Web');
		expect(text).toContain('├ WebSearch "npm stage approval"');
		expect(text).toContain('└ WebFetch https://docs.npmjs.com');
		expect(text).not.toContain('Searched the web');
	} finally {
		setup.renderer.destroy();
	}
});

test('assistant replies strip provider citation placeholders before markdown rendering', () => {
	expect(
		stripProviderCitationMarkers(
			'record before asking you to act. citeturn1view0\nNext sentence citeturn0search3',
		),
	).toBe('record before asking you to act.\nNext sentence');
	expect(
		stripProviderCitationMarkers(
			'record before asking you to act. [cite:turn1view0]\nNext sentence [cite:turn0search3]',
		),
	).toBe('record before asking you to act.\nNext sentence');
});

test('group details retain shell commands, output and errors for expansion', () => {
	const details = new Map<string, string>();
	const rows = renderToolRun(searchMessages(), 100, details);
	expect(rows).toHaveLength(2);
	expect(rows[0]!.text).toContain('grouprow:done');
	expect(rows[1]!.text).toContain('bashrow:done');
	const expanded = details.get(rows[0]!.blockKey!)!;
	expect(expanded).toContain('find src -type f');
	expect(expanded).toContain('grep -n needle missing.ts');
	expect(expanded).toContain('src/a.ts');
	expect(expanded).toContain('No such file or directory');
	expect(expanded).toContain('file contents');
});

test('running shell searches group with reads and keep streamed errors visible', async () => {
	const messages = searchMessages().map(message => ({
		...message,
		running: true,
	}));
	const setup = await testRender(
		() => (
			<History
				embedded
				width={100}
				height={35}
				messages={() => messages}
				running={() => true}
				reasoning={() => ''}
				streaming={() => ''}
				liveOutputs={() => ({
					'shell-grep': 'grep: streaming permission denied',
				})}
			/>
		),
		{width: 100, height: 35},
	);
	try {
		await Bun.sleep(180);
		await setup.flush();
		const text = setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
		expect(text.match(/Explored/g)).toHaveLength(1);
		expect(text).toContain('├ Search find src -type f');
		expect(text).toContain('├ Search grep -n needle missing.ts');
		expect(text).toContain('└ Read src/a.ts');
		expect(text).toContain('streaming permission denied');
		expect(text).toContain('mutation output');
		expect(text).not.toContain('Search find src -type f -delete');
	} finally {
		setup.renderer.destroy();
	}
});

test('classification reads complete args even when detail hides trailing mutation', () => {
	const messages = searchMessages();
	const shell = messages[0]!;
	shell.tool!.args = {command: `find src -name '${'a'.repeat(120)}' -delete`};
	const rows = renderToolRun(messages, 100, new Map());
	expect(rows).toHaveLength(3);
	expect(rows[0]!.text).toContain('bashrow:done');
	delete shell.tool!.args;
	expect(renderToolRun([shell], 100, new Map())[0]!.text).toContain(
		'bashrow:done',
	);
});

test('activity group paints connected chronological rows', async () => {
	const raw = formatActivityTree(activityGroupForTool('read_file')!, [
		{name: 'read_file', detail: 'src/a.ts'},
		{name: 'grep', detail: 'renderToolRun'},
		{name: 'glob', detail: 'src/**/*.tsx'},
	]);
	const segments = liveRowSegments(raw, 'grouprow', 'done', colors(), 80);
	const setup = await testRender(
		() => <LiveToolRows rows={[{...segments, lang: 'grouprow'}]} md={md} />,
		{width: 80, height: 10},
	);
	try {
		await setup.flush();
		const rows = setup
			.captureSpans()
			.lines.map(line =>
				line.spans
					.map(span => span.text)
					.join('')
					.trimEnd(),
			)
			.filter(Boolean);
		expect(rows).toEqual([
			'✦  Explored',
			'   ├ Read src/a.ts',
			'   ├ Search renderToolRun',
			'   └ Glob src/**/*.tsx',
		]);
	} finally {
		setup.renderer.destroy();
	}
});

test('grouped brief gets one blank line before activity tree', async () => {
	const raw = formatActivityTree(activityGroupForTool('read_file')!, [
		{name: 'read_file', detail: 'src/a.ts'},
	]);
	const segments = liveRowSegments(raw, 'grouprow', 'done', colors(), 80);
	const baseline = await testRender(
		() => <LiveToolRows rows={[{...segments, lang: 'grouprow'}]} md={md} />,
		{width: 80, height: 12},
	);
	const setup = await testRender(
		() => (
			<LiveToolRows
				rows={[
					{
						...segments,
						lang: 'grouprow',
						brief: 'Trace existing launcher conventions.',
					},
				]}
				md={md}
			/>
		),
		{width: 80, height: 12},
	);
	try {
		await baseline.flush();
		await setup.flush();
		const baselineRows = baseline.captureSpans().lines;
		const rows = setup.captureSpans().lines.map(line =>
			line.spans
				.map(span => span.text)
				.join('')
				.trimEnd(),
		);
		const treeIndex = rows.findIndex(row => row.includes('Explored'));
		const baselineTreeIndex = baselineRows.findIndex(line =>
			line.spans
				.map(span => span.text)
				.join('')
				.includes('Explored'),
		);
		expect(treeIndex).toBe(baselineTreeIndex + 2);
	} finally {
		baseline.renderer.destroy();
		setup.renderer.destroy();
	}
});

test('long activity paths render without a second mid-token wrap', async () => {
	const raw = formatActivityTree(
		activityGroupForTool('read_file')!,
		[
			{
				name: 'read_file',
				detail:
					'/mnt/data/KSProjects/Hilinga/.bobonyo/worktrees/improving-subscription/hilinga-e2e-qa/tests/repos/kplugin_subscriptions/subscriptions.spec.ts',
			},
		],
		80,
	);
	const segments = liveRowSegments(raw, 'grouprow', 'done', colors(), 80);
	const setup = await testRender(
		() => <LiveToolRows rows={[{...segments, lang: 'grouprow'}]} md={md} />,
		{width: 80, height: 10},
	);
	try {
		await setup.flush();
		const rows = setup.captureSpans().lines.map(line =>
			line.spans
				.map(span => span.text)
				.join('')
				.replace(/\s+$/, ''),
		);
		expect(rows.every(row => row.length <= 80)).toBe(true);
		expect(rows.join('\n')).toContain('/mnt/data');
	} finally {
		setup.renderer.destroy();
	}
});
