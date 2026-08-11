import {describe, expect, test} from 'bun:test';
import {
	filterSettingsRows,
	listScrollStart,
	type SettingsListRow,
} from './settings-list-modal';
import {wrapDescription} from '../description-wrap';

describe('listScrollStart', () => {
	test('stays at the top while the selection fits', () => {
		expect(listScrollStart(0, 3, 10)).toBe(0);
		expect(listScrollStart(3, 3, 10)).toBe(0);
	});

	test('scrolls once the selection leaves the window', () => {
		expect(listScrollStart(7, 20, 10)).toBe(7);
		expect(listScrollStart(19, 20, 10)).toBe(10);
	});

	test('clamps to the last window for oversized indexes', () => {
		expect(listScrollStart(99, 20, 10)).toBe(10);
	});
});

describe('filterSettingsRows (list search)', () => {
	const rows: SettingsListRow[] = [
		{label: '/create-pr', value: 'Create a pull request'},
		{label: '/hilinga-local-dev', value: 'Local dev loop'},
		{label: '/babysit-pr', value: 'Watch a PR'},
	];

	test('matches the label and the description, case-insensitive', () => {
		expect(filterSettingsRows(rows, 'create')).toHaveLength(1);
		expect(filterSettingsRows(rows, 'pull')).toHaveLength(1);
		expect(filterSettingsRows(rows, 'PR')).toHaveLength(2);
	});

	test('empty query keeps every row', () => {
		expect(filterSettingsRows(rows, '')).toHaveLength(3);
	});
});

describe('wrapDescription (2-line wrap parity)', () => {
	test('short descriptions stay on one line', () => {
		expect(wrapDescription('Show this help', 40)).toEqual([
			'Show this help',
		]);
	});

	test('long descriptions wrap to exactly 2 lines with an ellipsis', () => {
		const lines = wrapDescription(
			'Create a pull request. Handles project-specific rules like changesets and branch targeting automatically. Runs the REVIEW.md lens reviewer before push.',
			40,
		);
		expect(lines.length).toBe(2);
		expect(lines[1]).toMatch(/…$/);
	});

	test('empty descriptions stay empty', () => {
		// wrapText keeps one empty row for the caret; the description
		// renderer guards with `Show when={row.value}` so it never shows.
		expect(wrapDescription('', 40).length).toBeLessThanOrEqual(1);
	});
});
