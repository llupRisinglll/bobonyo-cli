import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {BashToolRow} from './components/bash-tool-row';
import type {MarkdownBriefRenderer} from './components/markdown-brief';
import {liveRowSegments} from './live-tool-row';
import {colors} from './theme';
import {markdownSyntaxStyleFor} from './syntax';
import {formatToolEntry} from './tool-display';

/**
 * RENDER-LEVEL regression guard for the "bash entry shows twice" bug.
 *
 * The user's saved session carried the shell's echoed command INSIDE the
 * captured output (`EXIT_CODE: 0\n$ cd /tmp/bobonyo-link && echo hi\nhi`),
 * so the bordered box painted the command twice — once as its header, once
 * as the first output line. The dedup (stripBashEcho + capture-level
 * stripEchoedCommand) must make the PAINTED box show the command exactly
 * once, while the real output (`hi`) stays.
 */

const testMd: MarkdownBriefRenderer = {
	syntaxStyle: () => markdownSyntaxStyleFor(colors()),
	renderNode: () => undefined,
	treeSitter: undefined,
};

function allRows(frame: CapturedFrame): string[] {
	return frame.lines.map(line =>
		line.spans
			.map(s => s.text)
			.join('')
			.trimEnd(),
	);
}

describe('bash box renders the command ONCE (echoed-command dedup)', () => {
	test('a settled row whose output echoes the command paints it once', async () => {
		const cmd = 'cd /tmp/bobonyo-link && echo hi';
		// Exactly the persisted shape from the user's session (doubled).
		const output = `EXIT_CODE: 0\n$ ${cmd}\nhi`;
		// The settled path: formatToolEntry (plain) → liveRowSegments →
		// BashToolRow — the same pipeline History uses.
		const raw = formatToolEntry(
			{name: 'execute_bash', detail: cmd, output, args: {command: cmd}},
			false,
			'done',
			true,
			true,
			84,
		);
		const seg = liveRowSegments(raw, 'bashrow', 'done', colors(), 84);
		const setup = await testRender(
			() => (
				<BashToolRow
					header={seg.header}
					body={seg.body}
					status="done"
					glyph="✦"
					hovered={false}
					md={testMd}
				/>
			),
			{width: 100, height: 20},
		);
		await setup.flush();
		await new Promise(resolve => setTimeout(resolve, 50));
		const rows = allRows(setup.captureSpans());
		// The command text appears EXACTLY once (the header line) — the
		// echoed copy inside the output is gone.
		const occurrences = rows.filter(row => row.includes(cmd)).length;
		expect(occurrences).toBe(1);
		// The real output lines survive (EXIT_CODE + hi).
		expect(rows.some(row => row.includes('EXIT_CODE: 0'))).toBe(true);
		// The row paints `│hi<spaces>│` (both box borders), so the content
		// check must match the inner cell, not the row end.
		expect(rows.some(row => row.includes('│hi'))).toBe(true);
		setup.renderer.destroy();
	});

	test('a RUNNING row streams the command once too (live parity)', async () => {
		const cmd = 'for i in $(seq 1 3); do echo "line $i"; done';
		// The shell echoed the typed command into the STREAMED output while
		// the row was still running (the user's "twice while processing").
		const streamed = `$ ${cmd}\nline 1\nline 2`;
		const raw = formatToolEntry(
			{
				name: 'execute_bash',
				detail: cmd,
				output: streamed,
				args: {command: cmd},
			},
			false,
			'running',
			true,
			true,
			84,
		);
		const seg = liveRowSegments(raw, 'bashrow', 'running', colors(), 84);
		const setup = await testRender(
			() => (
				<BashToolRow
					header={seg.header}
					body={seg.body}
					status="running"
					glyph="✦"
					hovered={false}
					md={testMd}
				/>
			),
			{width: 100, height: 20},
		);
		await setup.flush();
		await new Promise(resolve => setTimeout(resolve, 50));
		const rows = allRows(setup.captureSpans());
		expect(rows.filter(row => row.includes(cmd)).length).toBe(1);
		expect(rows.some(row => row.includes('│line 2'))).toBe(true);
		setup.renderer.destroy();
	});

	test('a command that legitimately prints its own text later is untouched', async () => {
		const cmd = 'cd /tmp/bobonyo-link && echo hi';
		// The echo is only stripped when it is the LEADING line; a real
		// output line that mentions the command later must survive.
		const raw = formatToolEntry(
			{
				name: 'execute_bash',
				detail: cmd,
				output: `EXIT_CODE: 0\nran: ${cmd}`,
				args: {command: cmd},
			},
			false,
			'done',
			true,
			true,
			84,
		);
		const seg = liveRowSegments(raw, 'bashrow', 'done', colors(), 84);
		const setup = await testRender(
			() => (
				<BashToolRow
					header={seg.header}
					body={seg.body}
					status="done"
					glyph="✦"
					hovered={false}
					md={testMd}
				/>
			),
			{width: 100, height: 20},
		);
		await setup.flush();
		await new Promise(resolve => setTimeout(resolve, 50));
		const rows = allRows(setup.captureSpans());
		// Header + the output line that mentions it = two legit occurrences.
		expect(rows.filter(row => row.includes(cmd)).length).toBe(2);
		expect(rows.some(row => row.includes(`ran: ${cmd}`))).toBe(true);
		setup.renderer.destroy();
	});
});
