import {describe, expect, test} from 'bun:test';
import {
	MAX_BASH_OUTPUT_CHARS,
	MAX_BASH_OUTPUT_LINES,
	capOutputTail,
	stripEchoedCommand,
} from './bash';

describe('capOutputTail (bash output capture caps)', () => {
	test('keeps output unchanged when it fits within both caps', () => {
		const {lines, truncated} = capOutputTail(['a', 'b', 'c']);
		expect(lines).toEqual(['a', 'b', 'c']);
		expect(truncated).toBe(false);
	});

	test('keeps the TAIL when the line cap is exceeded', () => {
		const lines = Array.from(
			{length: MAX_BASH_OUTPUT_LINES + 10},
			(_, i) => `line ${i}`,
		);
		const {lines: capped, truncated} = capOutputTail(lines);
		expect(truncated).toBe(true);
		expect(capped.length).toBe(MAX_BASH_OUTPUT_LINES);
		// Results/errors are at the end, so the tail must survive.
		expect(capped.at(-1)).toBe(`line ${MAX_BASH_OUTPUT_LINES + 9}`);
		expect(capped.at(0)).toBe('line 10');
	});

	test('a single giant line (minified one-line file) is sliced to the char cap', () => {
		const giant = 'x'.repeat(MAX_BASH_OUTPUT_CHARS * 4);
		const {lines, truncated} = capOutputTail([giant]);
		expect(truncated).toBe(true);
		expect(lines.length).toBe(1);
		// The TAIL of the line survives (with a leading `…` marker).
		expect(lines[0]!.startsWith('…')).toBe(true);
		expect(lines[0]!.endsWith('x'.repeat(MAX_BASH_OUTPUT_CHARS))).toBe(true);
	});

	test('later lines push earlier ones out of both caps together', () => {
		// 3 lines of 40 chars each with a 100-char cap: the last two fit
		// fully, the first is sliced to the remaining budget.
		const lines = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
		const {lines: capped, truncated} = capOutputTail(lines, 10, 100);
		expect(truncated).toBe(true);
		// The first line is sliced to the remaining 19-char budget, with a
		// `…` marker so the truncation is visible.
		expect(capped[0]!.startsWith('…')).toBe(true);
		expect(capped[0]!.slice(1)).toBe('a'.repeat(19));
		expect(capped.slice(1)).toEqual(['b'.repeat(40), 'c'.repeat(40)]);
	});
});

describe('stripEchoedCommand (leading echoed-command line)', () => {
	const CMD = 'cd /tmp/bobonyo-link && echo hi';

	test('drops a leading `$ <command>` echo (the box header already shows it)', () => {
		// The user-visible artifact: the shell echoed the typed command back
		// (`$ cd /tmp/bobonyo-link && echo hi`), so the bash box rendered the
		// command TWICE — once as the header, once as the first output line.
		expect(stripEchoedCommand([`$ ${CMD}`, 'hi'], CMD)).toEqual(['hi']);
	});

	test('drops a leading bare `<command>` echo too', () => {
		expect(stripEchoedCommand([CMD, 'hi'], CMD)).toEqual(['hi']);
	});

	test('drops the `❯ `-prefixed echo (zsh-style prompt)', () => {
		expect(stripEchoedCommand([`❯ ${CMD}`, 'hi'], CMD)).toEqual(['hi']);
	});

	test('tolerates a trailing CR from PTY line endings', () => {
		expect(stripEchoedCommand([`$ ${CMD}\r`, 'hi\r'], CMD)).toEqual(['hi\r']);
	});

	test('strips CONSECUTIVE echo lines (stdout+stderr both echoed)', () => {
		expect(stripEchoedCommand([`$ ${CMD}`, CMD, 'hi'], CMD)).toEqual(['hi']);
	});

	test('keeps the stream untouched when the first line is real output', () => {
		const lines = ['line 1', 'line 2'];
		expect(stripEchoedCommand(lines, CMD)).toEqual(lines);
	});

	test('never touches a matching line LATER in the output (real content)', () => {
		// A command that legitimately prints its own text must keep it.
		const lines = ['done', `$ ${CMD}`];
		expect(stripEchoedCommand(lines, CMD)).toEqual(lines);
	});

	test('does not drop a line that merely CONTAINS the command', () => {
		expect(stripEchoedCommand([`log: ${CMD} started`, 'hi'], CMD)).toEqual([
			`log: ${CMD} started`,
			'hi',
		]);
	});

	test('empty command leaves the lines untouched', () => {
		expect(stripEchoedCommand(['$ cd x', 'hi'], '   ')).toEqual([
			'$ cd x',
			'hi',
		]);
	});

	test('a MULTI-LINE command echo spans several captured lines and is stripped whole', () => {
		// The reported case: the model ran a multi-line git command
		// (`git add …\n  && git commit -m "…"\n  …`). The shell echoed the
		// typed command back, one captured line PER command line, so the
		// old whole-command match missed it and the box showed the command
		// twice (header + echoed lines). All command lines must be consumed.
		const cmd = [
			'cd /mnt/data/KSProjects/NanoCollective/bobonyo && git add src/a.ts',
			'  src/b.ts && git commit -m "feat: x" && git log --oneline -1',
		].join('\n');
		const echo = [
			`$ cd /mnt/data/KSProjects/NanoCollective/bobonyo && git add src/a.ts`,
			'  src/b.ts && git commit -m "feat: x" && git log --oneline -1',
		];
		const output = [
			'(pass) parseXmlToolCalls > args via the arg order',
			'… +42 more lines',
		];
		expect(stripEchoedCommand([...echo, ...output], cmd)).toEqual(output);
	});

	test('multi-line echo with `> ` continuation prompts (interactive PTY)', () => {
		const cmd = ['git add a.ts', 'git commit -m "feat: x"'].join('\n');
		const echo = ['$ git add a.ts', '> git commit -m "feat: x"'];
		expect(stripEchoedCommand([...echo, 'done'], cmd)).toEqual(['done']);
	});

	test('multi-line echo with bare continuation lines (no prompt) is stripped', () => {
		const cmd = ['git add a.ts', 'git commit -m "feat: x"'].join('\n');
		expect(
			stripEchoedCommand(
				['$ git add a.ts', 'git commit -m "feat: x"', 'done'],
				cmd,
			),
		).toEqual(['done']);
	});

	test('multi-line echo tolerates CR line endings', () => {
		const cmd = ['git add a.ts', 'git commit -m "feat: x"'].join('\n');
		expect(
			stripEchoedCommand(
				['$ git add a.ts\r', '> git commit -m "feat: x"\r', 'done\r'],
				cmd,
			),
		).toEqual(['done\r']);
	});

	test('a PARTIAL echo (prompt-marked fragment) is stripped — it is the echo split across reads', () => {
		// A LONG single-line command's echo can arrive in stream-read
		// fragments: the pump pushes each fragment as a separate line, so
		// the captured leading lines are a PROMPT-MARKED PREFIX of the
		// command. That is the echo, not real output — strip it.
		const cmd = 'git add a.ts && git commit -m "feat: x"';
		expect(
			stripEchoedCommand(['$ git add a.ts', 'some real output', 'done'], cmd),
		).toEqual(['some real output', 'done']);
	});

	test('a partial line WITHOUT a prompt prefix is real output and is preserved', () => {
		// `git log` can print `git` as its first real output word; without a
		// prompt marker nothing may be stripped.
		const cmd = 'git log --oneline -1';
		expect(stripEchoedCommand(['git log', 'abc123 fix'], cmd)).toEqual([
			'git log',
			'abc123 fix',
		]);
	});

	test('a LONG single-line command echo split across read fragments is stripped whole', () => {
		// The reported case: a long git command (single line, box-wrapped)
		// whose echo arrived in fragments — `out[0]` is only a PREFIX, so
		// the old exact-match missed it. The collapsed-text comparison must
		// reassemble the fragments and strip the whole echo.
		const cmd =
			'cd /mnt/data/KSProjects/NanoCollective/bobonyo && git add src/a.ts src/b.ts ' +
			'&& git commit -m "feat: center COMPLETED popup message" && git log --oneline -1';
		const echoFragments = [
			'$ cd /mnt/data/KSProjects/NanoCollective/bobonyo && git add src/a.ts',
			'src/b.ts && git commit -m "feat: center COMPLETED popup',
			'message" && git log --oneline -1',
		];
		expect(stripEchoedCommand([...echoFragments, '(pass) done'], cmd)).toEqual([
			'(pass) done',
		]);
	});

	test('multi-line echo appears twice (stdout + stderr) and BOTH are stripped', () => {
		const cmd = ['git add a.ts', 'git commit -m "feat: x"'].join('\n');
		const echo = ['$ git add a.ts', 'git commit -m "feat: x"'];
		expect(stripEchoedCommand([...echo, ...echo, 'done'], cmd)).toEqual([
			'done',
		]);
	});
});
