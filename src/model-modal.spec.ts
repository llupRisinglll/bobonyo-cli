import {describe, expect, test} from 'bun:test';
import {
	connectProviderShortcut,
	initialModelRowIndex,
	modelWithProvider,
	nextModelCursor,
	providerDisplayName,
	providerHeaderParts,
} from './components/model-modal';

type Row = {kind: string; isCurrent?: boolean};

const provider = (name: string) => ({
	id: name,
	name,
	models: [],
	modelEfforts: {},
});

describe('modelWithProvider (provider name in parentheses)', () => {
	test('appends the provider display name in parentheses', () => {
		expect(
			modelWithProvider('deepseek-v4-flash', provider('deepseek')),
		).toBe('deepseek-v4-flash (deepseek)');
		expect(
			modelWithProvider('gpt-5.6-luna', provider('opencode-go')),
		).toBe('gpt-5.6-luna (opencode-go)');
	});

	test('falls back to the provider id when the display name is missing', () => {
		expect(
			modelWithProvider('mimo-v2.5', {
				...provider('xiaomi'),
				name: '',
			}),
		).toBe('mimo-v2.5 (xiaomi)');
	});

	test('no provider means no parentheses', () => {
		expect(modelWithProvider('mock-model-1', undefined)).toBe(
			'mock-model-1',
		);
	});
});

describe('providerDisplayName (actual provider name, not the raw id)', () => {
	test('resolves the builtin preset title for known endpoints', () => {
		expect(
			providerDisplayName({
				id: 'deepseek',
				name: 'deepseek',
				baseUrl: 'https://api.deepseek.com',
				models: [],
				modelEfforts: {},
			}),
		).toBe('DeepSeek');
		expect(
			providerDisplayName({
				id: 'opencode-go',
				name: 'opencode-go',
				baseUrl: 'https://opencode.ai/zen/go/v1',
				models: [],
				modelEfforts: {},
			}),
		).toBe('OpenCode Go');
	});

	test('matches by endpoint even when the id was renamed', () => {
		expect(
			providerDisplayName({
				id: 'my-ds',
				name: 'my-ds',
				baseUrl: 'https://api.deepseek.com',
				models: [],
				modelEfforts: {},
			}),
		).toBe('DeepSeek');
	});

	test('falls back to the user-given name for non-preset / baseUrl-less providers', () => {
		expect(
			providerDisplayName({
				id: 'my-gateway',
				name: 'my-gateway',
				baseUrl: 'https://my-gateway.example/v1',
				models: [],
				modelEfforts: {},
			}),
		).toBe('my-gateway');
		expect(
			providerDisplayName({
				id: 'legacy',
				name: '',
				models: [],
				modelEfforts: {},
			}),
		).toBe('legacy');
	});
});

describe('providerHeaderParts (user name first, real name secondary)', () => {
	test('carries BOTH names when they differ', () => {
		expect(
			providerHeaderParts({
				id: 'deepseek',
				name: 'deepseek',
				baseUrl: 'https://api.deepseek.com',
				models: [],
				modelEfforts: {},
			}),
		).toEqual({user: 'deepseek', real: 'DeepSeek'});
	});

	test('omits the real name when it matches the user name (no duplication)', () => {
		expect(
			providerHeaderParts({
				id: 'my-gateway',
				name: 'my-gateway',
				baseUrl: 'https://my-gateway.example/v1',
				models: [],
				modelEfforts: {},
			}),
		).toEqual({user: 'my-gateway', real: undefined});
	});
});

const model = (isCurrent = false): Row => ({kind: 'model', isCurrent});

describe('initialModelRowIndex (/model opens on the current model)', () => {
	test('returns the CURRENT model row when present', () => {
		const rows: Row[] = [
			{kind: 'provider'},
			{kind: 'spacer'},
			model(true),
			model(),
			{kind: 'provider'},
			{kind: 'spacer'},
			model(),
		];
		expect(initialModelRowIndex(rows)).toBe(2);
	});

	test('falls back to the FIRST model row when no current model', () => {
		const rows: Row[] = [
			{kind: 'provider'},
			{kind: 'spacer'},
			model(),
			model(),
		];
		expect(initialModelRowIndex(rows)).toBe(2);
	});

	test('prefers the Inherit row when it comes first and no current model', () => {
		const rows: Row[] = [
			{kind: 'inherit'},
			{kind: 'spacer'},
			{kind: 'provider'},
			{kind: 'spacer'},
			model(),
		];
		expect(initialModelRowIndex(rows)).toBe(0);
	});

	test('current model wins even when an Inherit row exists', () => {
		const rows: Row[] = [
			{kind: 'inherit'},
			{kind: 'spacer'},
			{kind: 'provider'},
			{kind: 'spacer'},
			model(true),
		];
		expect(initialModelRowIndex(rows)).toBe(4);
	});

	test('returns -1 when nothing is navigable', () => {
		expect(initialModelRowIndex([{kind: 'empty'}])).toBe(-1);
		expect(initialModelRowIndex([])).toBe(-1);
	});
});

describe('connectProviderShortcut (C must not fire while searching)', () => {
	test('fires only when the LIST is focused', () => {
		expect(connectProviderShortcut('list', 'c')).toBe(true);
		expect(connectProviderShortcut('search', 'c')).toBe(false);
	});

	test('no other key triggers it', () => {
		expect(connectProviderShortcut('list', 'x')).toBe(false);
		expect(connectProviderShortcut('list', 'C')).toBe(false);
	});
});

describe('nextModelCursor (grid navigation, symmetric across groups)', () => {
	// Groups: mock(1) → codex(4) → custom(2), 2 columns.
	// Flattened cells: 0 | 1 2 / 3 4 | 5 6
	const SIZES = [1, 4, 2];

	test('RIGHT from a group last cell wraps to the NEXT group (left parity)', () => {
		expect(nextModelCursor(4, 'right', SIZES, 2, false)).toBe(5);
	});

	test('LEFT from a group first cell wraps to the PREVIOUS group last', () => {
		expect(nextModelCursor(5, 'left', SIZES, 2, false)).toBe(4);
	});

	test('the very first/last cells stay put (no wrap-around cycle)', () => {
		expect(nextModelCursor(0, 'left', SIZES, 2, false)).toBe(0);
		expect(nextModelCursor(6, 'right', SIZES, 2, false)).toBe(6);
	});

	test('LEFT/RIGHT move within a row and wrap across LINES symmetrically', () => {
		// codex row 1: 3 | 4 → left from 3 lands on 2 (row 0, last col).
		expect(nextModelCursor(3, 'left', SIZES, 2, false)).toBe(2);
		// right from 2 lands on 3 (row 1, first col).
		expect(nextModelCursor(2, 'right', SIZES, 2, false)).toBe(3);
		expect(nextModelCursor(1, 'right', SIZES, 2, false)).toBe(2);
	});

	test('DOWN jumps past the group to the next group first cell', () => {
		expect(nextModelCursor(4, 'down', SIZES, 2, false)).toBe(5);
		expect(nextModelCursor(0, 'down', SIZES, 2, false)).toBe(1);
	});

	test('UP wraps to the bottom of the same column / previous group / Inherit', () => {
		// codex row 0 col 0 → bottom of column 0 (cell 3), not the previous
		// group: vertical wrap stays INSIDE a multi-row group.
		expect(nextModelCursor(1, 'up', SIZES, 2, false)).toBe(3);
		// A single-row group has nowhere to wrap: previous group's last cell,
		// or the Inherit row when present.
		expect(nextModelCursor(0, 'up', SIZES, 2, true)).toBe(-1);
		expect(nextModelCursor(0, 'up', SIZES, 2, false)).toBe(0);
	});

	test('Inherit (-1) only moves with DOWN', () => {
		expect(nextModelCursor(-1, 'down', SIZES, 2, false)).toBe(0);
		expect(nextModelCursor(-1, 'up', SIZES, 2, false)).toBe(-1);
		expect(nextModelCursor(-1, 'right', SIZES, 2, false)).toBe(-1);
	});

	test('ragged last row wraps within the same column', () => {
		// 3 columns, group of 5: rows 0 1 2 / 3 4 — down from 4 wraps to 1
		// (top of column 1); up from 1 wraps to the bottom of column 1 (4).
		expect(nextModelCursor(4, 'down', [5], 3, false)).toBe(1);
		expect(nextModelCursor(1, 'up', [5], 3, false)).toBe(4);
	});
});
