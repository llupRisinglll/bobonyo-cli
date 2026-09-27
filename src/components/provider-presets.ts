export const CODEX_MODELS = [
	'gpt-5.5-codex',
	'gpt-5.5-codex-high',
	'gpt-5.4-codex',
	'gpt-5.4-codex-mini',
];
/**
 * The ChatGPT-ACCOUNT codex backend's model catalog SEED (the live
 * /backend-api/codex/models fetch supersedes it after connect). The
 * `gpt-5.5-codex` family is API-key-only — the account endpoint rejects
 * it with 400. Keep this list equal to the account catalog's VISIBLE rows
 * so a newly launched model shows even before the first discovery lands.
 */
export const CODEX_ACCOUNT_MODELS = [
	'gpt-6-astra',
	'gpt-6-sol',
	'gpt-6-luna',
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'gpt-5.5',
];

// The CURRENT DeepSeek catalog (the /models endpoint returns v4-flash/v4-pro;
// the live fetch refreshes it after connect, these seeds just keep the picker
// honest before/without a key).
export const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

export const XIAOMI_MODELS = [
	'mimo-v2.5',
	'mimo-v2.5-pro',
	'mimo-v2.5-asr',
	'mimo-v2.5-tts',
];

/**
 * OpenCode Zen catalog seeds (live `/zen/v1/models` refresh replaces these
 * after connect). The `*-free` models work WITHOUT a subscription — the
 * reason a blank key is allowed for this preset.
 */
export const OPENCODE_ZEN_MODELS = [
	'deepseek-v4-flash-free',
	'mimo-v2.5-free',
	'hy3-free',
	'nemotron-3-ultra-free',
	'nemotron-3.5-lightning-free',
	'laguna-s-2.1-free',
	'big-pickle',
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'gpt-5.5',
	'claude-opus-5',
	'deepseek-v4-flash',
	'deepseek-v4-pro',
	'qwen3.6-plus',
	'kimi-k3',
];

/** OpenCode Go catalog seeds (subscription; live refresh replaces these). */
export const OPENCODE_GO_MODELS = [
	'deepseek-v4-flash',
	'deepseek-v4-pro',
	'glm-5.2',
	'kimi-k2.7-code',
	'qwen3.8-max',
	'qwen3.7-plus',
	'minimax-m3',
	'gpt-5.6-luna',
	'grok-4.5',
	'mimo-v2.5-pro',
];

export interface ProviderPreset {
	/** Default provider id/name; a blank name falls back to this. */
	id: string;
	title: string;
	description: string;
	category: 'Popular' | 'Providers';
	/** Known endpoint — presets NEVER ask for it (custom does). */
	baseUrl: string;
	/** Seeded catalog so the picker never shows mock-model-1 before discovery. */
	models: string[];
	modelDiscoveryUrl?: string;
	sdkProvider?: string;
	/** ChatGPT-account mode (responses wire via ~/.codex/auth.json). */
	codexAccount?: boolean;
	contextWindow?: number;
	/** Codex offers a ChatGPT-account method; every other preset is key-only. */
	authMethods?: Array<{id: 'account' | 'api'; label: string; detail: string}>;
	/** Key OPTIONAL — a blank key connects anyway (anonymous free tier). */
	optionalKey?: boolean;
}

/**
 * Preset catalog. Scope = providers the harness can ACTUALLY talk to with
 * the existing wires (openai-compatible, anthropic, responses); the list is
 * inspired by opencode's provider catalog. Most carry a `/models` discovery
 * URL so the real catalog replaces the seeds after connect.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: 'codex',
		title: 'Codex',
		description: 'ChatGPT account or API key',
		category: 'Popular',
		baseUrl: 'https://api.openai.com/v1',
		models: CODEX_MODELS,
		modelDiscoveryUrl: 'https://api.openai.com/v1/models',
		sdkProvider: 'responses',
		contextWindow: 400_000,
		authMethods: [
			{
				id: 'account',
				label: 'ChatGPT account (codex login)',
				detail: 'Uses ~/.codex/auth.json',
			},
			{id: 'api', label: 'API key', detail: 'sk-... or env:VAR'},
		],
	},
	{
		id: 'openai',
		title: 'OpenAI',
		description: 'gpt-5.5 / gpt-5.4',
		category: 'Popular',
		baseUrl: 'https://api.openai.com/v1',
		models: ['gpt-5.5', 'gpt-5.5-mini', 'gpt-5.4', 'gpt-5.4-mini'],
		modelDiscoveryUrl: 'https://api.openai.com/v1/models',
	},
	{
		id: 'anthropic',
		title: 'Anthropic',
		description: 'claude-sonnet / claude-opus',
		category: 'Popular',
		baseUrl: 'https://api.anthropic.com',
		models: ['claude-sonnet-4-6', 'claude-opus-4', 'claude-sonnet-4-5'],
		sdkProvider: 'anthropic',
	},
	{
		id: 'openrouter',
		title: 'OpenRouter',
		description: 'one key, many models',
		category: 'Popular',
		baseUrl: 'https://openrouter.ai/api',
		models: ['openrouter/auto'],
		modelDiscoveryUrl: 'https://openrouter.ai/api/v1/models',
	},
	{
		id: 'deepseek',
		title: 'DeepSeek',
		description: 'deepseek-v4-flash / deepseek-v4-pro',
		category: 'Popular',
		baseUrl: 'https://api.deepseek.com',
		models: DEEPSEEK_MODELS,
		modelDiscoveryUrl: 'https://api.deepseek.com/models',
	},
	{
		id: 'xiaomi',
		title: 'Xiaomi MiMo',
		description: 'token-plan gateway (mimo-v2.5)',
		category: 'Popular',
		baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
		models: XIAOMI_MODELS,
		// normalize() auto-adds modelDiscoveryUrl for token-plan hosts.
	},
	{
		id: 'opencode-zen',
		title: 'OpenCode Zen',
		description: 'free models without a key, subscription unlocks more',
		category: 'Popular',
		baseUrl: 'https://opencode.ai/zen/v1',
		models: OPENCODE_ZEN_MODELS,
		modelDiscoveryUrl: 'https://opencode.ai/zen/v1/models',
		// Zen is the FREE source: a blank key still connects (anonymous
		// tier, IP-limited) so users without a subscription keep the
		// `*-free` models.
		optionalKey: true,
	},
	{
		id: 'opencode-go',
		title: 'OpenCode Go',
		description: 'low-cost subscription models',
		category: 'Popular',
		baseUrl: 'https://opencode.ai/zen/go/v1',
		models: OPENCODE_GO_MODELS,
		modelDiscoveryUrl: 'https://opencode.ai/zen/go/v1/models',
	},
	{
		id: 'mistral',
		title: 'Mistral',
		description: 'mistral-large',
		category: 'Providers',
		baseUrl: 'https://api.mistral.ai',
		models: ['mistral-large'],
		modelDiscoveryUrl: 'https://api.mistral.ai/v1/models',
	},
	{
		id: 'xai',
		title: 'xAI',
		description: 'grok-4',
		category: 'Providers',
		baseUrl: 'https://api.x.ai',
		models: ['grok-4'],
		modelDiscoveryUrl: 'https://api.x.ai/v1/models',
	},
	{
		id: 'groq',
		title: 'Groq',
		description: 'fast llama',
		category: 'Providers',
		baseUrl: 'https://api.groq.com/openai',
		models: ['llama-4-scout-17b-16e-instruct'],
		modelDiscoveryUrl: 'https://api.groq.com/openai/v1/models',
	},
	{
		id: 'cerebras',
		title: 'Cerebras',
		description: 'llama / deepseek on wafer',
		category: 'Providers',
		baseUrl: 'https://api.cerebras.ai',
		models: ['llama-3.3-70b'],
		modelDiscoveryUrl: 'https://api.cerebras.ai/v1/models',
	},
	{
		id: 'together',
		title: 'Together AI',
		description: 'open-source catalog',
		category: 'Providers',
		baseUrl: 'https://api.together.xyz',
		models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
		modelDiscoveryUrl: 'https://api.together.xyz/v1/models',
	},
	{
		id: 'fireworks',
		title: 'Fireworks AI',
		description: 'fast inference',
		category: 'Providers',
		baseUrl: 'https://api.fireworks.ai/inference',
		models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
		modelDiscoveryUrl: 'https://api.fireworks.ai/inference/v1/models',
	},
	{
		id: 'nvidia',
		title: 'NVIDIA',
		description: 'nemotron',
		category: 'Providers',
		baseUrl: 'https://integrate.api.nvidia.com',
		models: ['nvidia/llama-3.3-nemotron-super-49b-v1'],
		modelDiscoveryUrl: 'https://integrate.api.nvidia.com/v1/models',
	},
	{
		id: 'custom',
		title: 'Custom provider',
		description: 'Bring your own endpoint',
		category: 'Providers',
		baseUrl: '',
		models: [],
	},
];
