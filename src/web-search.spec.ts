import {describe, expect, test} from 'bun:test';
import {
	formatNativeWebSearchActivity,
	nativeWebSearchActionDetail,
} from './web-search';

describe('native Responses web-search display', () => {
	test('formats search, open-page, and find-in-page actions', () => {
		expect(
			formatNativeWebSearchActivity({
				type: 'search',
				query: 'PostgreSQL indexes',
			}),
		).toBe('✦ Searched the web for PostgreSQL indexes');
		expect(
			nativeWebSearchActionDetail({
				type: 'open_page',
				url: 'https://example.com/guide',
			}),
		).toBe('https://example.com/guide');
		expect(
			nativeWebSearchActionDetail({
				type: 'find_in_page',
				url: 'https://example.com/guide',
				pattern: 'pagination',
			}),
		).toBe("'pagination' in https://example.com/guide");
	});

	test('falls back to a generic row when provider omits action detail', () => {
		expect(formatNativeWebSearchActivity()).toBe('✦ Searched the web');
		expect(
			formatNativeWebSearchActivity({
				type: 'search',
				queries: ['first query', 'second query'],
			}),
		).toBe('✦ Searched the web for first query ...');
	});
});
