import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {LiveToolRows} from './components/live-tool-rows';
import {formatActivityTree, activityGroupForTool} from './activity-groups';
import {liveRowSegments} from './live-tool-row';
import {colors} from './theme';
import {markdownSyntaxStyleFor} from './syntax';
import type {MarkdownBriefRenderer} from './components/markdown-brief';

const md: MarkdownBriefRenderer = {
	syntaxStyle: () => markdownSyntaxStyleFor(colors()),
	renderNode: () => undefined,
	treeSitter: undefined,
};

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
			'✦ Explored',
			'  ├ Read src/a.ts',
			'  ├ Search renderToolRun',
			'  └ Glob src/**/*.tsx',
		]);
	} finally {
		setup.renderer.destroy();
	}
});
