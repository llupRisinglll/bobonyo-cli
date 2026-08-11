/**
 * Native web-search fallback (port of nanocoder's web-search-native): when a
 * Web-search fallback model is configured (Settings → Capabilities → Web
 * search model), the `web_search` tool runs the query through THAT model's
 * provider via its server-side `web_search` tool (Responses API), no
 * third-party search key. The fallback indicator row is emitted by the tool
 * so the chat shows `✦ WebSearch fallback: <model> searched → <main model>
 * responds` (parity with the original repository).
 */

import {listProviders, loadPreferences} from './config';

export interface WebSearchFallback {
	baseUrl: string;
	apiKey: string;
	model: string;
	providerId: string;
}

/** Resolve the configured web-search fallback (null = inherit main model). */
export function resolveWebSearchFallback(): WebSearchFallback | null {
	const prefs = loadPreferences();
	if (!prefs.webSearchModel) return null;
	const providers = listProviders();
	const provider =
		providers.find(
			candidate => candidate.id === prefs.webSearchProvider,
		) ??
		providers.find(candidate =>
			candidate.models.includes(prefs.webSearchModel!),
		);
	if (!provider) return null;
	return {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKeyResolved,
		model: prefs.webSearchModel,
		providerId: provider.id,
	};
}

function buildResponsesUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, '');
	if (!trimmed) return '';
	if (/\/v1$/.test(trimmed)) return `${trimmed}/responses`;
	return `${trimmed}/v1/responses`;
}

interface NativeWebSearchResponse {
	output_text?: string;
	output?: Array<{
		type?: string;
		title?: string;
		url?: string;
		content?: string;
		text?: string;
		content_parts?: Array<{type?: string; text?: string}>;
	}>;
}

function extractAnswer(data: NativeWebSearchResponse): string {
	const top = data.output_text?.trim();
	if (top) return top;
	const parts: string[] = [];
	for (const item of data.output ?? []) {
		if (item.type !== 'message') continue;
		for (const part of item.content_parts ?? []) {
			if (part.type === 'output_text' && part.text?.trim()) {
				parts.push(part.text.trim());
			}
		}
	}
	return parts.filter(Boolean).join('\n').trim();
}

function formatResults(
	query: string,
	data: NativeWebSearchResponse,
): string {
	const resultItems = (data.output ?? []).filter(
		item => item.type === 'web_search_result',
	);
	const searchRan = (data.output ?? []).some(
		item => item.type === 'web_search_call',
	);
	const answer = extractAnswer(data);
	let formatted = `# Web Search Results: "${query}"\n\n`;
	const shown = resultItems.slice(0, 8);
	if (shown.length > 0) {
		shown.forEach((item, i) => {
			formatted += `## ${i + 1}. ${item.title || 'Untitled'}\n\n`;
			if (item.url) formatted += `**URL:** ${item.url}\n\n`;
			if (item.content) formatted += `${item.content}\n\n`;
			formatted += '---\n\n';
		});
	} else if (!searchRan && !answer) {
		formatted += 'No results found.\n';
	}
	if (answer) formatted += `## Answer\n\n${answer}\n`;
	return formatted.trim();
}

/**
 * Run a native server-side web search through the fallback provider.
 * Returns null when no fallback is configured (caller keeps its default);
 * throws a descriptive error when the request fails.
 */
export async function executeNativeWebSearch(
	query: string,
): Promise<string | null> {
	const fallback = resolveWebSearchFallback();
	if (!fallback) return null;
	const url = buildResponsesUrl(fallback.baseUrl);
	if (!url) {
		throw new Error('Web-search fallback provider has an invalid base URL.');
	}
	if (!fallback.apiKey) {
		throw new Error(
			`Web-search fallback provider "${fallback.providerId}" has no API key.`,
		);
	}
	const prompt =
		'Use the web_search tool to search the web for the query below, then ' +
		'answer concisely and factually, citing the source URLs you used. ' +
		'Include the search result titles and URLs in your answer.\n\n' +
		`Query: ${query}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 100_000);
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${fallback.apiKey}`,
			},
			body: JSON.stringify({
				model: fallback.model,
				input: [
					{
						role: 'user',
						content: [{type: 'input_text', text: prompt}],
					},
				],
				tools: [{type: 'web_search'}],
				tool_choice: {type: 'web_search'},
				stream: false,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(
				`Web search fallback failed (HTTP ${response.status}): ${detail.slice(0, 200)}`,
			);
		}
		const data = (await response.json()) as NativeWebSearchResponse;
		const hasSearchData =
			(data.output ?? []).some(
				item =>
					item.type === 'web_search_result' ||
					item.type === 'web_search_call',
			) || Boolean(extractAnswer(data));
		if (!hasSearchData) {
			throw new Error(
				`Web-search fallback model ${fallback.model} returned no search data.`,
			);
		}
		return formatResults(query, data);
	} finally {
		clearTimeout(timer);
	}
}
