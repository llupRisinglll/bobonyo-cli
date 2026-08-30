import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {SettledToolRow} from './components/settled-tool-row';
import {LiveToolRows} from './components/live-tool-rows';
import {liveRowSegments} from './live-tool-row';
import type {MarkdownBriefRenderer} from './components/markdown-brief';
import {colors} from './theme';
import {markdownSyntaxStyleFor} from './syntax';

/**
 * RENDER-LEVEL guards for the pre-tool brief alignment on GENERIC tool
 * rows (WebSearch, Read, … — anything that is not the bash box or the
 * file/diff row).
 *
 * The brief renders `✦` + a 2-col gap (text at col 3). The bash box
 * indents its border width 3 so it lines up under the brief text; the
 * generic row must do the same — header at col 3, body `└` at col 3 —
 * otherwise the tool content sits ONE GAP LEFT of the brief (the
 * "missing 1 gap" report). Live and settled must paint identical columns.
 */
const testMd: MarkdownBriefRenderer = {
	syntaxStyle: () => markdownSyntaxStyleFor(colors()),
	renderNode: () => undefined,
	treeSitter: undefined,
};

function painted(frame: {
	lines: Array<{spans: Array<{text: string}>}>;
}): string[] {
	return frame.lines
		.map(line =>
			line.spans
				.map(s => s.text)
				.join('')
				.trimEnd(),
		)
		.filter(t => t.trim() !== '');
}

describe('pre-tool brief alignment (generic tool rows)', () => {
	test('standalone agent rows keep glyph with batch marker', async () => {
		const segments = liveRowSegments(
			'Ran agent:explore(task) completed\n  └  result',
			'agentrow',
			'done',
			colors(),
			80,
		);
		const setup = await testRender(
			() => (
				<SettledToolRow
					segments={segments}
					status="done"
					glyph="✦"
					glyphTone="status"
					hovered={false}
					width={80}
					batchBriefed
					briefUnindented
					md={testMd}
				/>
			),
			{width: 80, height: 10},
		);
		try {
			await setup.flush();
			const rows = painted(setup.captureSpans());
			expect(
				rows.some(row => row.startsWith('✦') && row.includes('Ran agent:')),
			).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('briefed rows: header AND `└` sit at col 3, aligned with the brief text', async () => {
		const seg = liveRowSegments(
			'WebSearch(query)\n  └   some result tail',
			'toolrow',
			'done',
			colors(),
			80,
		);
		const setup = await testRender(
			() => (
				<SettledToolRow
					segments={seg}
					status="done"
					glyph="✦"
					hovered={false}
					width={80}
					md={testMd}
					brief="I will check the web first"
				/>
			),
			{width: 80, height: 10},
		);
		await setup.flush();
		await new Promise(resolve => setTimeout(resolve, 100));
		const paintedRows = painted(setup.captureSpans());
		const header = paintedRows.find(r => r.includes('WebSearch'));
		const body = paintedRows.find(r => r.includes('└'));
		// The brief's text column is 3 (`✦` at 0 + 2-col gap); the header
		// and the `└` container edge must match it — never one gap left.
		expect(header?.indexOf('WebSearch')).toBe(3);
		expect(body?.indexOf('└')).toBe(3);
		setup.renderer.destroy();
	});

	test('live and settled briefed rows paint IDENTICAL content columns', async () => {
		const seg = liveRowSegments(
			'WebSearch(query)\n  └   some result tail',
			'toolrow',
			'done',
			colors(),
			80,
		);
		const live = await testRender(
			() => (
				<LiveToolRows
					rows={[
						{
							...seg,
							lang: 'toolrow',
							brief: 'I will check the web first',
							batchBriefed: false,
						},
					]}
					md={testMd}
				/>
			),
			{width: 80, height: 10},
		);
		await live.flush();
		await new Promise(resolve => setTimeout(resolve, 100));
		const settled = await testRender(
			() => (
				<SettledToolRow
					segments={seg}
					status="done"
					glyph="✦"
					hovered={false}
					width={80}
					md={testMd}
					brief="I will check the web first"
				/>
			),
			{width: 80, height: 10},
		);
		await settled.flush();
		await new Promise(resolve => setTimeout(resolve, 100));
		// The markdown brief node lays out async; compare the CONTENT rows
		// (header + body) — they must be byte-identical live vs settled.
		const liveRows = painted(live.captureSpans()).filter(
			r => !r.startsWith('✦'),
		);
		const settledRows = painted(settled.captureSpans()).filter(
			r => !r.startsWith('✦'),
		);
		expect(liveRows).toEqual(settledRows);
		expect(liveRows[0]?.startsWith('   WebSearch')).toBe(true);
		expect(liveRows[1]?.startsWith('   └')).toBe(true);
		live.renderer.destroy();
		settled.renderer.destroy();
	});

	test('non-briefed rows keep two gap columns after the glyph', async () => {
		const seg = liveRowSegments(
			'WebSearch(query)\n  └   tail',
			'toolrow',
			'done',
			colors(),
			80,
		);
		const live = await testRender(
			() => <LiveToolRows rows={[{...seg, lang: 'toolrow'}]} md={testMd} />,
			{width: 80, height: 10},
		);
		await live.flush();
		await new Promise(resolve => setTimeout(resolve, 50));
		const liveRows = painted(live.captureSpans());
		// Blink frame may show ✦ or a space at col 0; either way the header
		// content starts at col 3: glyph plus two explicit gap columns.
		const header = liveRows.find(r => r.includes('WebSearch'));
		expect(header?.indexOf('WebSearch')).toBe(3);
		live.renderer.destroy();
	});
});
