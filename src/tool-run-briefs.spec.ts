import {describe, expect, test} from 'bun:test';
import {toolRunBriefs} from './components/history';
import type {ChatMessage} from './state';

const tool = (name: string, brief?: string, detail = ''): ChatMessage => ({
	role: 'tool',
	content: `✦ ${name}(${detail})`,
	brief,
	tool: {name, detail, output: ''},
});

describe('toolRunBriefs (per-row briefs across consecutive tool rounds)', () => {
	test('every bash round keeps its own brief once settled', () => {
		// Five separate tool-loop rounds that streamed narration append
		// CONSECUTIVE bash rows (no separator when a round produced no
		// reasoning). The old run-wide `run[0]?.brief` dropped everything
		// after the first row — the "Wait more." text vanished once the next
		// bash box settled. Every row must carry its OWN brief.
		const run = [
			tool('execute_bash', 'Purpose "viz-mode-2n" reads as slug already.'),
			tool('execute_bash', 'Script running in background. Wait for completion.'),
			tool('execute_bash', 'Still creating git worktrees. Wait more.'),
			tool('execute_bash'),
		];
		expect(toolRunBriefs(run)).toEqual([
			'Purpose "viz-mode-2n" reads as slug already.',
			'Script running in background. Wait for completion.',
			'Still creating git worktrees. Wait more.',
			undefined,
		]);
	});

	test('a same-round batch keeps ONE brief on its compact tally', () => {
		// One round, parallel same-family calls: the first carries the real
		// brief, later calls carry the ' ' batch marker. They collapse into
		// a single compact tally with the batch's one brief.
		const run = [
			tool('web_search', 'Checking the docs.'),
			tool('web_search', ' '),
			tool('fetch_url', ' '),
		];
		expect(toolRunBriefs(run)).toEqual(['Checking the docs.']);
	});

	test('a NEW round narration breaks the same-family compact group', () => {
		// Two rounds of the same family, each with its own brief: grouping
		// them into one tally would drop the second round's narration.
		const run = [
			tool('web_search', 'First round: searching.'),
			tool('web_search', 'Second round: still searching.'),
		];
		expect(toolRunBriefs(run)).toEqual([
			'First round: searching.',
			'Second round: still searching.',
		]);
	});

	test('the batch marker passes through to share the row glyph', () => {
		// One round, two sequential bash calls: the first briefs the batch,
		// the second carries ' ' so its box indents to the brief column
		// instead of painting a second glyph.
		const run = [
			tool('execute_bash', 'Running the hypothesis test.'),
			tool('execute_bash', ' '),
		];
		expect(toolRunBriefs(run)).toEqual([
			'Running the hypothesis test.',
			' ',
		]);
	});

	test('rows without any narration stay undefined', () => {
		expect(toolRunBriefs([tool('execute_bash'), tool('execute_bash')])).toEqual([
			undefined,
			undefined,
		]);
	});
});
