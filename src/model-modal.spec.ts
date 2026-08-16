import {describe, expect, test} from 'bun:test';
import {
	connectProviderShortcut,
	connectionPickerRow,
	distinctOpenCodeTiers,
	groupProviders,
	initialModelRowIndex,
	modelWithProvider,
	nextModelCursor,
	openCodeTierLabel,
	openCodeTierOf,
	providerDisplayName,
	providerGroupKey,
	providerHeaderParts,
	sameProviderGroup,
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
		expect(modelWithProvider('deepseek-v4-flash', provider('deepseek'))).toBe(
			'deepseek-v4-flash (deepseek)',
		);
		expect(modelWithProvider('gpt-5.6-luna', provider('opencode-go'))).toBe(
			'gpt-5.6-luna (opencode-go)',
		);
	});

	test('uses the REAL provider title when the connection matches a preset', () => {
		expect(
			modelWithProvider('deepseek-v4-flash', {
				id: 'deepseek',
				name: 'deepseek',
				baseUrl: 'https://api.deepseek.com',
				models: [],
				modelEfforts: {},
			}),
		).toBe('deepseek-v4-flash (deepseek · DeepSeek)');
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
		expect(modelWithProvider('mock-model-1', undefined)).toBe('mock-model-1');
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

describe('groupProviders (ONE list per real provider)', () => {
	const go = (name: string, models: string[]) => ({
		id: name,
		name,
		baseUrl: 'https://opencode.ai/zen/go/v1',
		models,
		modelEfforts: {},
	});

	test('merges multiple connections of the same provider into ONE group', () => {
		const groups = groupProviders([
			go('brian', ['minimax-m3', 'kimi-k3']),
			go('mika', ['kimi-k3', 'glm-5.2']),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.title).toBe('OpenCode');
		expect(groups[0]!.connections.map(connection => connection.id)).toEqual([
			'brian',
			'mika',
		]);
		// Models are the UNION, order preserved, no duplicates.
		expect(groups[0]!.models).toEqual(['minimax-m3', 'kimi-k3', 'glm-5.2']);
	});

	test('custom / non-preset providers keep their own group', () => {
		const groups = groupProviders([
			{
				id: 'my-gateway',
				name: 'my-gateway',
				baseUrl: 'https://my-gateway.example/v1',
				models: ['m1'],
				modelEfforts: {},
			},
			go('brian', ['m2']),
		]);
		expect(groups).toHaveLength(2);
		expect(groups.map(group => group.providerId).sort()).toEqual([
			'my-gateway',
			'opencode',
		]);
	});

	test('OpenCode Zen and OpenCode Go share ONE group (same opencode.ai key)', () => {
		const zen = (name: string, models: string[]) => ({
			id: name,
			name,
			baseUrl: 'https://opencode.ai/zen/v1',
			models,
			modelEfforts: {},
		});
		const groups = groupProviders([
			go('brian', ['minimax-m3']),
			zen('mika', ['deepseek-v4-flash']),
		]);
		// ONE merged group — not two duplicate-looking OpenCode lists.
		expect(groups).toHaveLength(1);
		expect(groups[0]!.title).toBe('OpenCode');
		expect(groups[0]!.connections.map(connection => connection.id)).toEqual([
			'brian',
			'mika',
		]);
		expect(groups[0]!.models).toEqual(['minimax-m3', 'deepseek-v4-flash']);
	});
	test('providerGroupKey resolves the preset id (or the raw id)', () => {
		expect(providerGroupKey(go('brian', []))).toBe('opencode');
		expect(
			providerGroupKey({
				id: 'opencode-zen',
				name: 'opencode-zen',
				baseUrl: 'https://opencode.ai/zen/v1',
				models: [],
				modelEfforts: {},
			}),
		).toBe('opencode');
		expect(
			providerGroupKey({
				id: 'x',
				name: 'x',
				baseUrl: 'https://my-gateway.example/v1',
				models: [],
				modelEfforts: {},
			}),
		).toBe('x');
	});
});

describe('openCodeTierLabel / connectionPickerRow (Zen vs Go tier picker)', () => {
	const zen = (name: string) => ({
		id: name,
		name,
		baseUrl: 'https://opencode.ai/zen/v1',
		models: [],
		modelEfforts: {},
	});
	const go = (name: string) => ({
		id: name,
		name,
		baseUrl: 'https://opencode.ai/zen/go/v1',
		models: [],
		modelEfforts: {},
	});
	test('labels the tiers Zen (API usage) / Go (Subscription)', () => {
		expect(openCodeTierLabel(zen('opencode-zen'))).toBe('Zen (API usage)');
		expect(openCodeTierLabel(go('brian'))).toBe('Go (Subscription)');
	});
	test('non-OpenCode providers fall back to the user name', () => {
		expect(
			openCodeTierLabel({
				id: 'x',
				name: 'x',
				models: [],
				modelEfforts: {},
			}),
		).toBe('x');
	});
	test('the picker row LEADS WITH the named provider; tier + endpoint ride the detail', () => {
		// Multiple opencode API keys are allowed per endpoint, so the choice
		// must be by the USER-GIVEN name; the tier (Zen/Go) + base URL stay
		// visible on the detail line.
		expect(connectionPickerRow(go('brian'))).toEqual({
			label: 'brian',
			detail: 'Go (Subscription) · https://opencode.ai/zen/go/v1',
		});
		expect(connectionPickerRow(zen('mika'))).toEqual({
			label: 'mika',
			detail: 'Zen (API usage) · https://opencode.ai/zen/v1',
		});
	});
	test('two opencode keys of the SAME tier stay distinguishable by name', () => {
		// The user's complaint: with two Go connections (different API keys)
		// the rows must read by NAME, not both "OpenCode Go (Subscription)".
		const first = connectionPickerRow(go('work-key'));
		const second = connectionPickerRow(go('personal-key'));
		expect(first.label).toBe('work-key');
		expect(second.label).toBe('personal-key');
		expect(first.detail).toBe(
			'Go (Subscription) · https://opencode.ai/zen/go/v1',
		);
		expect(second.detail).toBe(
			'Go (Subscription) · https://opencode.ai/zen/go/v1',
		);
	});
	test('non-OpenCode picker rows keep the user-given name + endpoint', () => {
		expect(
			connectionPickerRow({
				id: 'my-gateway',
				name: 'my-gateway',
				baseUrl: 'https://my-gateway.example/v1',
				models: [],
				modelEfforts: {},
			}),
		).toEqual({
			label: 'my-gateway',
			detail: 'https://my-gateway.example/v1',
		});
	});
});
describe('openCodeTierOf / distinctOpenCodeTiers (Zen vs Go endpoints)', () => {
	const go = (name: string) => ({
		id: name,
		name,
		baseUrl: 'https://opencode.ai/zen/go/v1',
		models: [],
		modelEfforts: {},
	});
	const zen = (name: string) => ({
		id: name,
		name,
		baseUrl: 'https://opencode.ai/zen/v1',
		models: [],
		modelEfforts: {},
	});
	test('maps the endpoint to the tier', () => {
		expect(openCodeTierOf(go('brian'))).toBe('go');
		expect(openCodeTierOf(zen('mika'))).toBe('zen');
	});
	test('non-OpenCode connections have no tier', () => {
		expect(
			openCodeTierOf({
				id: 'deepseek',
				name: 'deepseek',
				baseUrl: 'https://api.deepseek.com',
				models: [],
				modelEfforts: {},
			}),
		).toBeUndefined();
	});
	test('distinct tiers across a merged group, Zen first', () => {
		expect(distinctOpenCodeTiers([go('a'), zen('b')])).toEqual(['zen', 'go']);
		expect(distinctOpenCodeTiers([go('a'), go('b')])).toEqual(['go']);
		expect(distinctOpenCodeTiers([zen('a')])).toEqual(['zen']);
		expect(
			distinctOpenCodeTiers([
				{id: 'x', name: 'x', models: [], modelEfforts: {}},
			]),
		).toEqual([]);
	});
});
describe('sameProviderGroup (account-swap detection)', () => {
	const go = (name: string) => ({
		id: name,
		name,
		baseUrl: 'https://opencode.ai/zen/go/v1',
		models: [],
		modelEfforts: {},
	});

	test('two connections of the same real provider are the same group', () => {
		expect(sameProviderGroup(go('brian'), go('mika'))).toBe(true);
	});
	test('OpenCode Zen and OpenCode Go are the SAME group (shared opencode.ai key)', () => {
		const zen = (name: string) => ({
			id: name,
			name,
			baseUrl: 'https://opencode.ai/zen/v1',
			models: [],
			modelEfforts: {},
		});
		expect(sameProviderGroup(go('brian'), zen('mika'))).toBe(true);
		expect(sameProviderGroup(zen('mika'), go('brian'))).toBe(true);
	});

	test('different providers (or undefined) are NOT the same group', () => {
		expect(
			sameProviderGroup(go('brian'), {
				id: 'deepseek',
				name: 'deepseek',
				baseUrl: 'https://api.deepseek.com',
				models: [],
				modelEfforts: {},
			}),
		).toBe(false);
		expect(sameProviderGroup(undefined, go('mika'))).toBe(false);
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

	test('UP exits the group from its first row / previous group / Inherit', () => {
		// codex row 0 col 0 → the PREVIOUS group's last cell (mock, cell 0):
		// ↑ must never wrap to the bottom of its own group, that would trap
		// the cursor inside one provider and block reaching above the list.
		expect(nextModelCursor(1, 'up', SIZES, 2, false)).toBe(0);
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
