/**
 * Provider configuration (parity: nanocoder's mcp-config-loader +
 * client-factory, docs 05 E1/E2/E5/E9).
 *
 * Precedence: `NANOCODER_PROVIDERS` env (highest) → `providers.json` in the
 * config dir → built-in mock default. `${VAR}` values substitute from env.
 * `--provider <id>` (via NANOCODER_PROVIDER) selects; otherwise the first
 * configured provider wins.
 */

import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {nanocoderConfigDir} from './nanocoder-paths';

export interface ProviderConfig {
	id: string;
	name?: string;
	baseUrl: string;
	apiKey?: string;
	/**
	 * Model catalog, a plain name or `{name, effort}`. EFFORT IS PER MODEL
	 * (parity: nanocoder's model picker passes the effort with the selection;
	 * the reference per-model variants). The active endpoint derives its
	 * `model[effort]` badge from the SELECTED model's entry, never an env
	 * variable.
	 */
	models?: Array<string | {name: string; effort?: string}>;
	/** SDK family; the rewrite implements `openai-compatible` only. */
	sdkProvider?: string;
	/** Optional live model-discovery endpoint (`/v1/models`). */
	modelDiscoveryUrl?: string;
	/** Provider context window (tokens) for the ctx% indicator. */
	contextWindow?: number;
	/** Vendor-specific request body extras (E4: openrouter/requesty …). */
	providerOptions?: Record<string, unknown>;
	/** OpenAI-contract routers: send a prompt-cache key when enabled. */
	promptCacheKey?: boolean;
	/** D4: tools that never require approval. */
	alwaysAllow?: string[];
}

export interface AppConfig {
	providers: ProviderConfig[];
}

export interface ResolvedProvider extends ProviderConfig {
	apiKeyResolved: string;
	models: string[];
	/** Per-model effort lookup keyed by model name. */
	modelEfforts: Record<string, string>;
	/** Undefined when the provider config did not declare a window (E6 fallback). */
	contextWindow?: number;
	alwaysAllow: string[];
}

/** E6: models.dev context-window fallback, cached for a day. */
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
let modelsDevCache: {
	url: string;
	data: Record<string, {context_window?: number}>;
	at: number;
} | null = null;

async function fetchModelsDev(): Promise<
	Record<string, {context_window?: number}>
> {
	const url =
		process.env.NANOCODER_MODELS_DEV_URL ?? 'https://models.dev/api.json';
	const now = Date.now();
	if (
		modelsDevCache &&
		modelsDevCache.url === url &&
		now - modelsDevCache.at < MODELS_DEV_TTL_MS
	) {
		return modelsDevCache.data;
	}
	const response = await fetch(url);
	if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
	const data = (await response.json()) as Record<
		string,
		{context_window?: number}
	>;
	modelsDevCache = {url, data, at: now};
	return data;
}

/**
 * E6: resolve a model's context window, a declared provider value wins,
 * otherwise the models.dev catalog (cached; never throws; callers treat an
 * undefined result as "unknown window").
 */
export async function resolveContextWindow(
	model: string,
	declared?: number,
): Promise<number | undefined> {
	if (declared) return declared;
	try {
		const catalog = await fetchModelsDev();
		return catalog[model]?.context_window;
	} catch {
		return undefined;
	}
}

export function configDir(): string {
	// Still the NANOCODER config dir, the rename happens when stable.
	return nanocoderConfigDir();
}

export function configFilePath(): string {
	// The nanocoder config lives in `agents.config.json`; keep supporting a
	// plain `providers.json` fallback.
	const agents = join(configDir(), 'agents.config.json');
	return existsSync(agents) ? agents : join(configDir(), 'providers.json');
}

function builtinDefault(): AppConfig {
	const baseUrl = process.env.MOCK_URL ?? 'http://127.0.0.1:4010';
	const model = process.env.MOCK_MODEL ?? 'mock-model-1';
	return {
		providers: [
			{
				id: 'mock',
				name: 'Mock',
				baseUrl,
				apiKey: process.env.MOCK_API_KEY ?? '',
				models: [model],
			},
		],
	};
}

/** Split `string | {name, effort}` model entries into names + effort map. */
export function normalizeModels(
	models: ProviderConfig['models'],
): {names: string[]; efforts: Record<string, string>} {
	const names: string[] = [];
	const efforts: Record<string, string> = {};
	for (const entry of models ?? []) {
		if (typeof entry === 'string') {
			if (entry) names.push(entry);
		} else if (entry?.name) {
			names.push(entry.name);
			if (entry.effort) efforts[entry.name] = entry.effort;
		}
	}
	return {
		names: names.length > 0 ? names : ['mock-model-1'],
		efforts,
	};
}

function substituteEnv(value: string): string {
	return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
		return process.env[name] ?? '';
	});
}

function normalize(config: AppConfig): AppConfig {
	return {
		providers: (config.providers ?? []).map(provider => ({
			...provider,
			// nanocoder configs carry `name` without `id`, use the name as
			// the provider identity.
			id: provider.id ?? provider.name ?? 'provider',
			baseUrl: substituteEnv(provider.baseUrl).replace(/\/+$/, ''),
			models: provider.models?.length ? provider.models : ['mock-model-1'],
			contextWindow: provider.contextWindow,
			alwaysAllow: provider.alwaysAllow ?? [],
		})),
	};
}

export function loadConfig(): AppConfig {
	// Highest precedence: providers from env.
	const envProviders = process.env.NANOCODER_PROVIDERS;
	if (envProviders) {
		try {
			// NOTE: parse the whole AppConfig and take `.providers`, the old
			// `as ProviderConfig[]` cast lied about the runtime shape and the
			// env path always fell through to defaults.
			const parsedEnv = JSON.parse(envProviders) as AppConfig;
			return normalize({providers: parsedEnv.providers});
		} catch {
			// fall through to the file
		}
	}
	// E1/E9: project config, closest `.nanocoder/providers.json` walking UP
	// from cwd (falls back to `.nanocoder/agents.config.json` in the same
	// directory) wins by name; the global file fills the gaps.
	const projectBase = process.env.NANOCODER_PROJECT_DIR ?? process.cwd();
	const project = findClosestProjectConfig(projectBase);
	const global = readProvidersFile(configFilePath());
	const merged = mergeProviders(project ?? [], global ?? []);
	if (merged.length > 0) return normalize({providers: merged});
	return builtinDefault();
}

/**
 * E9: closest-file resolution, walk from `startDir` upward until a
 * `.nanocoder/providers.json` (or `agents.config.json`) is found, or the
 * filesystem root is reached. Mirrors nanocoder's `getClosestConfigFile`.
 */
function findClosestProjectConfig(startDir: string): ProviderConfig[] | null {
	let dir = startDir;
	for (;;) {
		const providers = readProvidersFile(join(dir, '.nanocoder', 'providers.json'));
		if (providers) return providers;
		const legacy = readProvidersFile(join(dir, 'agents.config.json'));
		if (legacy) return legacy;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readProvidersFile(file: string): ProviderConfig[] | null {
	try {
		if (!existsSync(file)) return null;
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown as {
			providers?: ProviderConfig[];
			nanocoder?: {providers?: ProviderConfig[]};
		};
		if (Array.isArray(parsed)) return parsed as ProviderConfig[];
		if (Array.isArray(parsed.providers)) return parsed.providers;
		// nanocoder's `agents.config.json` wraps providers under `nanocoder`.
		if (parsed.nanocoder && Array.isArray(parsed.nanocoder.providers)) {
			return parsed.nanocoder.providers;
		}
		return null;
	} catch {
		return null;
	}
}

function mergeProviders(
	project: ProviderConfig[],
	global: ProviderConfig[],
): ProviderConfig[] {
	const key = (provider: ProviderConfig): string =>
		(provider.id ?? provider.name ?? '').toLowerCase();
	const byId = new Map<string, ProviderConfig>();
	for (const provider of project) byId.set(key(provider), provider);
	for (const provider of global) {
		if (!byId.has(key(provider))) {
			byId.set(key(provider), provider);
		}
	}
	return [...byId.values()];
}

export function saveConfig(config: AppConfig): void {
	mkdirSync(configDir(), {recursive: true});
	writeFileSync(configFilePath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function listProviders(): ResolvedProvider[] {
	return loadConfig().providers.map(provider => {
		const {names, efforts} = normalizeModels(provider.models);
		return {
			...provider,
			apiKeyResolved: resolveApiKey(provider.apiKey),
			models: names,
			modelEfforts: efforts,
			contextWindow: provider.contextWindow,
			alwaysAllow: provider.alwaysAllow ?? [],
		};
	});
}

export function resolveProvider(id?: string): ResolvedProvider {
	const providers = listProviders();
	// E2: an explicit request wins; otherwise the last-used provider from
	// preferences; otherwise the first configured provider.
	const requested =
		id ?? process.env.NANOCODER_PROVIDER ?? loadPreferences().lastProvider;
	if (requested) {
		const found = providers.find(
			provider => provider.id.toLowerCase() === requested.toLowerCase(),
		);
		if (found) return found;
		throw new Error(
			`Provider '${requested}' not found. Available: ${providers
				.map(provider => provider.id)
				.join(', ')}`,
		);
	}
	if (providers.length === 0) {
		throw new Error('No providers configured. Add a provider or create providers.json.');
	}
	return providers[0]!;
}

export interface Preferences {
	lastProvider?: string;
	lastModel?: string;
	/** Web-search fallback model + provider (native server-side search). */
	webSearchModel?: string;
	webSearchProvider?: string;
	/** Vision fallback model + provider (image analysis). */
	visionModel?: string;
	visionProvider?: string;
}

function preferencesPath(): string {
	return join(configDir(), 'nanocoder-preferences.json');
}

export function loadPreferences(): Preferences {
	try {
		const file = preferencesPath();
		if (existsSync(file)) {
			return JSON.parse(readFileSync(file, 'utf8')) as Preferences;
		}
	} catch {
		// corrupt, defaults
	}
	return {};
}

export function savePreferences(prefs: Preferences): void {
	mkdirSync(configDir(), {recursive: true});
	writeFileSync(
		preferencesPath(),
		// MERGE with the existing prefs, a model/provider switch must never
		// wipe the web-search/vision fallback selections (parity: nanocoder's
		// preference store persists unrelated keys across updates).
		`${JSON.stringify({...loadPreferences(), ...prefs}, null, 2)}\n`,
		'utf8',
	);
}

export function resolveApiKey(value: string | undefined): string {
	if (!value) return '';
	const envRef = /^env:([A-Z0-9_]+)$/.exec(value);
	const name = envRef?.[1];
	return name ? (process.env[name] ?? '') : substituteEnv(value);
}

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const discoveryCache = new Map<string, {at: number; models: string[]}>();

/**
 * Live model discovery (`modelDiscoveryUrl`): fetch `/v1/models`, cache by URL
 * with a 5-minute TTL, and NEVER throw, stale-but-usable fallback to the
 * static list (parity: model-discovery.ts).
 */
export async function discoverModels(provider: ResolvedProvider): Promise<string[]> {
	const discoveryUrl = provider.modelDiscoveryUrl;
	if (!discoveryUrl) return provider.models;
	const cached = discoveryCache.get(discoveryUrl);
	if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.models;
	try {
		const response = await fetch(
			`${discoveryUrl.replace(/\/+$/, '')}/v1/models`,
			{
				headers: provider.apiKeyResolved
					? {authorization: `Bearer ${provider.apiKeyResolved}`}
					: {},
			},
		);
		if (!response.ok) throw new Error(`discovery ${response.status}`);
		const body = (await response.json()) as {
			data?: Array<{id?: string}>;
		};
		const ids = (body.data ?? []).map(item => item.id).filter(Boolean) as string[];
		if (ids.length === 0) return provider.models;
		discoveryCache.set(discoveryUrl, {at: Date.now(), models: ids});
		return ids;
	} catch {
		return provider.models;
	}
}
