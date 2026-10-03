/** API capabilities from official OpenAI docs; account capabilities from the
 * sibling Codex models-manager/models.json catalog (October 2, 2026). */
const core = ['low', 'medium', 'high'];
const extended = [...core, 'xhigh'];
const maximum = [...extended, 'max'];
const efforts: Record<string, string[]> = {
	'gpt-4.1': [],
	'gpt-4.1-mini': [],
	'gpt-4.1-nano': [],
	'gpt-4o': [],
	'gpt-4o-mini': [],
	'gpt-5': ['minimal', ...core],
	'gpt-5-mini': ['minimal', ...core],
	'gpt-5-nano': ['minimal', ...core],
	'gpt-5-pro': ['high'],
	'gpt-5.1': ['none', ...core],
	'gpt-5.2': ['none', ...extended],
	'gpt-5.2-pro': ['medium', 'high', 'xhigh'],
	'gpt-5.4': ['none', ...extended],
	'gpt-5.4-mini': ['none', ...extended],
	'gpt-5.4-nano': ['none', ...extended],
	'gpt-5.4-pro': ['medium', 'high', 'xhigh'],
	'gpt-5.5': ['none', ...extended],
	'gpt-5.5-pro': ['medium', 'high', 'xhigh'],
	'gpt-5.6': ['none', ...maximum],
	'gpt-5.6-sol': ['none', ...maximum],
	'gpt-5.6-terra': ['none', ...maximum],
	'gpt-5.6-luna': ['none', ...maximum],
	'gpt-6-astra': maximum,
	'gpt-6.1-sol': maximum,
	'gpt-6-sol': ['none', ...maximum],
	'gpt-6-luna': ['none', ...maximum],
	'gpt-5.2-codex': extended,
	'gpt-5.3-codex': extended,
};
const accountEfforts: Record<string, string[]> = {
	'gpt-5.6-sol': [...maximum, 'ultra'],
	'gpt-5.6-terra': [...maximum, 'ultra'],
	'gpt-5.6-luna': maximum,
	'gpt-5.5': extended,
	'gpt-5.4': extended,
	'gpt-5.4-mini': extended,
	'gpt-5.2': extended,
	'codex-auto-review': extended,
};
const accountModels = new Set([
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'gpt-5.5',
	'gpt-5.4',
]);
const fastApiModels = new Set([
	...accountModels,
	'gpt-6-astra',
	'gpt-6.1-sol',
	'gpt-6-sol',
	'gpt-6-luna',
	'gpt-5.6',
	'gpt-5.4',
	'gpt-5.4-mini',
	'gpt-5.2',
	'gpt-5.1',
	'gpt-5',
	'gpt-5-mini',
	'gpt-4.1',
	'gpt-4.1-mini',
	'gpt-4.1-nano',
	'gpt-4o',
	'gpt-4o-mini',
	'gpt-5.3-codex',
]);
export interface GptControlsEndpoint {
	model: string;
	baseUrl?: string;
	sdkProvider?: string;
	codexAccount?: boolean;
	/** Scoped to the selected provider and model, not persisted. */
	fastMode?: boolean;
}
export function isGptModel(model: string): boolean {
	return /^(?:openai\/)?gpt-/i.test(model);
}
function modelId(model: string): string {
	return model
		.toLowerCase()
		.replace(/^openai\//, '')
		.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}
export function gptEfforts(model: string, codexAccount = false): string[] {
	const id = modelId(model);
	if (codexAccount && accountEfforts[id]) return [...accountEfforts[id]];
	return (efforts[id] ?? []).filter(level => !codexAccount || level !== 'none');
}
/** Codex ultra is an orchestration preset; the API receives max effort. */
export function gptEffortForRequest(
	effort: string | undefined,
	codexAccount = false,
): string | undefined {
	return codexAccount && effort === 'ultra' ? 'max' : effort;
}
/** Persisted choice is applied only on eligible official transports. */
export function restoredGptFast(
	endpoint: GptControlsEndpoint,
	tier?: 'priority' | 'default',
): boolean | undefined {
	return tier && supportsGptFast(endpoint) ? tier === 'priority' : undefined;
}
/** Unknown aliases remain provider-owned; absence is not proof of invalidity. */
export function knownGptEfforts(model: string): boolean {
	return Object.hasOwn(efforts, modelId(model));
}
/** Paid processing tier; never substitutes lower reasoning effort. */
export function supportsGptFast(endpoint: GptControlsEndpoint): boolean {
	let url: URL;
	try {
		url = new URL(endpoint.baseUrl ?? '');
	} catch {
		return false;
	}
	if (url.protocol !== 'https:' || url.port || url.username || url.password)
		return false;
	if (endpoint.codexAccount) {
		return (
			endpoint.sdkProvider === 'responses' &&
			url.hostname === 'chatgpt.com' &&
			url.pathname.replace(/\/+$/, '') === '/backend-api/codex' &&
			accountModels.has(modelId(endpoint.model))
		);
	}
	// These coding models require Responses for tool use; a name match does
	// not make the Chat Completions transport capable of serving them.
	if (
		(/^gpt-6/.test(modelId(endpoint.model)) ||
			modelId(endpoint.model) === 'gpt-5.3-codex') &&
		endpoint.sdkProvider !== 'responses'
	)
		return false;
	return (
		url.hostname === 'api.openai.com' &&
		['', '/', '/v1', '/v1/'].includes(url.pathname) &&
		[undefined, 'openai', 'openai-compatible', 'responses'].includes(
			endpoint.sdkProvider,
		) &&
		fastApiModels.has(modelId(endpoint.model))
	);
}
export function fastServiceTier(
	endpoint: GptControlsEndpoint,
): 'priority' | 'default' | undefined {
	if (endpoint.fastMode === undefined) return undefined;
	if (!supportsGptFast(endpoint)) {
		throw new Error(
			`Fast mode is unsupported for ${endpoint.model} on this provider/transport.`,
		);
	}
	// The official Codex client omits the default tier rather than sending it.
	return endpoint.fastMode
		? 'priority'
		: endpoint.codexAccount
			? undefined
			: 'default';
}
export function validateGptEffort(
	endpoint: GptControlsEndpoint & {effort?: string},
): void {
	if (
		isGptModel(endpoint.model) &&
		knownGptEfforts(endpoint.model) &&
		endpoint.effort &&
		!gptEfforts(endpoint.model, endpoint.codexAccount).includes(endpoint.effort)
	) {
		throw new Error(
			`Unsupported reasoning effort '${endpoint.effort}' for ${endpoint.model}. Use /effort default or a supported effort.`,
		);
	}
}

/** Requested fast mode is visible only when the selected wire can apply it. */
export function effectiveGptFast(endpoint: GptControlsEndpoint): boolean {
	return endpoint.fastMode === true && supportsGptFast(endpoint);
}
