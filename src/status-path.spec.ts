import {describe, expect, test} from 'bun:test';
import {statusPathLabel} from './status-path';

const CWD = '/mnt/data/KSProjects/NanoCollective/bobonyo';

describe('statusPathLabel', () => {
	test('full path fits when the left segment is short', () => {
		const label = statusPathLabel({
			left: '⏵⏵⏵ yolo mode on · tune: full',
			user: 'engr_luis',
			cwd: CWD,
			width: 100,
		});
		expect(label).toBe(`[engr_luis ${CWD}]`);
	});

	test('path shrinks so the WHOLE line fits the narrow pane (bg: 1 case)', () => {
		// 78 content columns at an 80-col terminal; the left segment includes
		// model[effort], ctx AND the bg count, the old budget forgot these
		// and OpenTUI clipped `~0%` / the `bg: 1` digit.
		const left =
			'⏵⏵⏵ yolo mode on · tune: full · mock-model-1[medium] · ctx ~0% · bg: 1';
		const label = statusPathLabel({
			left,
			user: 'engr_luis',
			cwd: CWD,
			width: 78,
		});
		expect(left.length + label.length).toBeLessThanOrEqual(78);
	});

	test('label never exceeds the remaining budget even for absurd lefts', () => {
		const left = '⏵⏵⏵ ' + 'x'.repeat(100);
		const label = statusPathLabel({
			left,
			user: 'engr_luis',
			cwd: CWD,
			width: 78,
		});
		// Budget = max(1, 78 - 107) = 1, the label must never exceed it.
		expect(label.length).toBeLessThanOrEqual(1);
	});

	test('drops the user prefix on very narrow panes', () => {
		const label = statusPathLabel({
			left: '⏵⏵⏵ yolo mode on · tune: full · mock-model-1 · ctx ~0% · bg: 1',
			user: 'engr_luis',
			cwd: CWD,
			width: 40,
		});
		expect(label.includes('engr_luis')).toBe(false);
	});
});
