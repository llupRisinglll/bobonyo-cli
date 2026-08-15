import {describe, expect, test} from 'bun:test';
import {
	formatLimitResetTime,
	formatOpenCodeLimitMessage,
	parseOpenCodeLimitError,
	GO_UPSELL_URL,
} from './opencode-limit';

const headers = (retryAfter?: string): Headers => {
	const h = new Headers();
	if (retryAfter !== undefined) h.set('retry-after', retryAfter);
	return h;
};

describe('parseOpenCodeLimitError (GoUsageLimitError / FreeUsageLimitError)', () => {
	test('parses a GoUsageLimitError with metadata and retry-after', () => {
		const body = JSON.stringify({
			error: {
				type: 'GoUsageLimitError',
				metadata: {workspace: 'w-123', limitName: 'weekly'},
			},
		});
		expect(parseOpenCodeLimitError(body, headers('151200'))).toEqual({
			kind: 'go',
			limitName: 'weekly',
			workspace: 'w-123',
			retryAfter: 151_200,
			link: 'https://opencode.ai/workspace/w-123/go',
		});
	});

	test('accepts metadata at the top level and a 5-hour rolling limit', () => {
		const body = JSON.stringify({
			type: 'GoUsageLimitError',
			metadata: {workspace: 'w', limitName: '5 hour'},
		});
		expect(parseOpenCodeLimitError(body, headers('18000'))).toEqual({
			kind: 'go',
			limitName: '5 hour',
			workspace: 'w',
			retryAfter: 18_000,
			link: 'https://opencode.ai/workspace/w/go',
		});
	});

	test('FreeUsageLimitError maps to the upsell', () => {
		expect(
			parseOpenCodeLimitError(
				JSON.stringify({type: 'FreeUsageLimitError'}),
				headers(),
			),
		).toEqual({kind: 'free', link: GO_UPSELL_URL});
	});

	test('plain-text body with the marker still parses (metadata undefined)', () => {
		expect(
			parseOpenCodeLimitError('GoUsageLimitError: weekly limit', headers('60')),
		).toEqual({
			kind: 'go',
			limitName: undefined,
			workspace: undefined,
			retryAfter: 60,
			link: GO_UPSELL_URL,
		});
	});

	test('other errors / empty bodies return null', () => {
		expect(parseOpenCodeLimitError(undefined, headers())).toBeNull();
		expect(
			parseOpenCodeLimitError(
				JSON.stringify({error: {message: 'bad request'}}),
				headers(),
			),
		).toBeNull();
	});
});

describe('formatLimitResetTime (opencode retry-after formatting)', () => {
	test('seconds/minutes/hours/days', () => {
		expect(formatLimitResetTime(0)).toBe('less than a minute');
		expect(formatLimitResetTime(90)).toBe('2 minutes');
		expect(formatLimitResetTime(3600)).toBe('1 hour');
		expect(formatLimitResetTime(5400)).toBe('1 hour 30 minutes');
		expect(formatLimitResetTime(86_400)).toBe('1 day');
		expect(formatLimitResetTime(151_200)).toBe('1 day 18 hours');
	});
});

describe('formatOpenCodeLimitMessage (open-code parity)', () => {
	test('weekly limit with reset time', () => {
		expect(
			formatOpenCodeLimitMessage({
				kind: 'go',
				limitName: 'weekly',
				workspace: 'w-123',
				retryAfter: 151_200,
				link: 'https://opencode.ai/workspace/w-123/go',
			}),
		).toContain('weekly usage limit reached');
		expect(
			formatOpenCodeLimitMessage({
				kind: 'go',
				limitName: 'weekly',
				workspace: 'w-123',
				retryAfter: 151_200,
				link: 'https://opencode.ai/workspace/w-123/go',
			}),
		).toContain('It will reset in 1 day 18 hours');
	});

	test('no reset time → no reset sentence', () => {
		const message = formatOpenCodeLimitMessage({
			kind: 'go',
			workspace: 'w',
			link: 'https://opencode.ai/workspace/w/go',
		});
		expect(message).not.toContain('It will reset');
		expect(message).toContain('enable usage from your available balance');
	});

	test('free tier → upsell', () => {
		const message = formatOpenCodeLimitMessage({
			kind: 'free',
			link: GO_UPSELL_URL,
		});
		expect(message).toContain('Free usage exceeded');
		expect(message).toContain(GO_UPSELL_URL);
	});
});
