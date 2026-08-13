/**
 * Provider configuration (parity: nanocoder's mcp-config-loader +
 * client-factory, docs 05 E1/E2/E5/E9).
 *
 * Precedence: `BOBONYO_PROVIDERS` env (highest) → `providers.json` in the
 * config dir → built-in mock default. `${VAR}` values substitute from env.
 * `--provider <id>` (via BOBONYO_PROVIDER) selects; otherwise the first
 * configured provider wins. The legacy `NANOCODER_*` env vars still work.
 */

import {existsSync, readFileSync, writeFileSync, mkdirSync, renameSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {bobonyoConfigDir} from './bobonyo-paths';
import {readCodexAuth} from './codex-auth';

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
	/**
	 * Responses wire against the ChatGPT Codex backend
	 * (`https://chatgpt.com/backend-api/codex`), authenticated with the
	 * `codex login` credentials (`~/.codex/auth.json`). Set for the Codex
	 * provider's "ChatGPT account" connection; API-key Codex connections use
	 * the standard OpenAI responses endpoint instead.
	 */
	codexAccount?: boolean;
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
	data: ModelsDevCatalog;
	at: number;
} | null = null;

/** One model entry in the models.dev catalog. */
interface ModelsDevModel {
	id?: string;
	/** New schema (2026): the context window lives under `limit.context`. */
	limit?: {context?: number; input?: number; output?: number};
	/** Old schema: some snapshots carry `context_window` on the model. */
	context_window?: number;
}

export interface ModelsDevCatalog {
	[providerId: string]:
		| {
				models?: Record<string, ModelsDevModel>;
				/** Old provider-keyed shape, `context_window` at the top. */
				context_window?: number;
		  }
		| undefined;
}

async function fetchModelsDev(): Promise<ModelsDevCatalog> {
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
	const data = (await response.json()) as ModelsDevCatalog;
	modelsDevCache = {url, data, at: now};
	return data;
}

/**
 * Extract a model's context window from a models.dev catalog snapshot.
 * Handles BOTH schemas:
 *   1. current: `catalog[providerId].models[modelId].limit.context`
 *   2. legacy:  `catalog[modelId].context_window` (direct key)
 * The providerId lookup is tried FIRST, then the whole catalog is searched by
 * model id — auto-discovered ids (deepseek-chat, mimo-v2.5-pro) often live
 * under a DIFFERENT provider key than the config id (e.g. the Xiaomi
 * token-plan host vs the plain `xiaomi` entry). Pure, unit-tested.
 */
export function modelsDevContextWindow(
	catalog: ModelsDevCatalog,
	providerId: string,
	model: string,
): number | undefined {
	const pick = (entry: ModelsDevModel | undefined): number | undefined => {
		const window = entry?.limit?.context ?? entry?.context_window;
		return window && window > 0 ? window : undefined;
	};
	const provider = catalog[providerId];
	const direct = pick(provider?.models?.[model]);
	if (direct) return direct;
	for (const entry of Object.values(catalog)) {
		const window = pick(entry?.models?.[model]);
		if (window) return window;
	}
	// Legacy shape keyed directly by model id.
	const legacy = catalog[model];
	if (legacy && !legacy.models) {
		const window = pick({limit: undefined, context_window: legacy.context_window});
		if (window) return window;
	}
	return undefined;
}

/**
 * E6: resolve a model's context window, a declared provider value wins,
 * otherwise the models.dev catalog (cached; never throws; callers treat an
 * undefined result as "unknown window").
 */
export async function resolveContextWindow(
	model: string,
	declared?: number,
	providerId?: string,
): Promise<number | undefined> {
	if (declared) return declared;
	try {
		const catalog = await fetchModelsDev();
		return modelsDevContextWindow(catalog, providerId ?? '', model);
	} catch {
		return undefined;
	}
}

export function configDir(): string {
	return bobonyoConfigDir();
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

/**
 * MiMo token-plan gateways are `token-plan-*.xiaomimimo.com` — their
 * catalog endpoint is `/v1/models` (the `/v1` prefix is part of the host
 * path, unlike `api.deepseek.com/models`).
 */
function isMiMoTokenPlanHost(rawBaseUrl: string): boolean {
	const base = rawBaseUrl.toLowerCase();
	return base.includes('xiaomimimo.com') && base.includes('token-plan');
}

function normalize(config: AppConfig): AppConfig {
	return {
		providers: (config.providers ?? []).map(provider => ({
			...provider,
			// nanocoder configs carry `name` without `id`, use the name as
			// the provider identity.
			id: provider.id ?? provider.name ?? 'provider',
			// Normalize the base URL: strip trailing slashes AND a trailing
			// `/v1` (the client appends `/v1/chat/completions`, so a config
			// that already ends in `/v1` must not become `/v1/v1/…` — the
			// Xiaomi token-plan endpoint 404s on the doubled path).
			baseUrl: substituteEnv(provider.baseUrl)
				.replace(/\/+$/, '')
				.replace(/\/v1$/, ''),
			models: provider.models?.length ? provider.models : ['mock-model-1'],
			contextWindow: provider.contextWindow,
			alwaysAllow: provider.alwaysAllow ?? [],
			// MiMo token-plan providers auto-discover their catalog from
			// `GET /v1/models` (same live-discover story as DeepSeek), so the
			// static `models` list becomes optional. Other providers only
			// discover when the config explicitly sets `modelDiscoveryUrl`.
			...(isMiMoTokenPlanHost(provider.baseUrl) &&
			!provider.modelDiscoveryUrl
				? {
						modelDiscoveryUrl: `${substituteEnv(provider.baseUrl).replace(
							/\/+$/,
							'',
						)}/models`,
					}
				: {}),
		})),
	};
}

export function loadConfig(): AppConfig {
	// Highest precedence: providers from env (BOBONYO_*, legacy NANOCODER_*).
	const envProviders =
		process.env.BOBONYO_PROVIDERS ??
		process.env.NANOCODER_PROVIDERS;
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
	// E1/E9: project config, closest `.bobonyo/providers.json` walking UP
	// from cwd (falls back to `.bobonyo/agents.config.json` in the same
	// directory) wins by name; the global file fills the gaps.
	const projectBase =
		process.env.BOBONYO_PROJECT_DIR ??
		process.env.NANOCODER_PROJECT_DIR ??
		process.cwd();
	const project = findClosestProjectConfig(projectBase);
	const global = readProvidersFile(configFilePath());
	const merged = mergeProviders(project ?? [], global ?? []);
	if (merged.length > 0) return normalize({providers: merged});
	return builtinDefault();
}

/**
 * E9: closest-file resolution, walk from `startDir` upward until a
 * `.bobonyo/providers.json` (or `agents.config.json`) is found, or the
 * filesystem root is reached. Mirrors nanocoder's `getClosestConfigFile`.
 */
function findClosestProjectConfig(startDir: string): ProviderConfig[] | null {
	let dir = startDir;
	for (;;) {
		const providers = readProvidersFile(join(dir, '.bobonyo', 'providers.json'));
		if (providers) return providers;
		// Legacy project layout: `.nanocoder` still works for existing repos.
		const legacyProviders = readProvidersFile(
			join(dir, '.nanocoder', 'providers.json'),
		);
		if (legacyProviders) return legacyProviders;
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
		id ??
		process.env.BOBONYO_PROVIDER ??
		process.env.NANOCODER_PROVIDER ??
		loadPreferences().lastProvider;
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
	/**
	 * Per-model reasoning-effort overrides, keyed
	 * `${providerId}\u0000${model}` (set by `/effort` and the model modal's
	 * effort step; the status line badge and the next selection read it).
	 */
	modelEfforts?: Record<string, string>;
	/** Web-search fallback model + provider (native server-side search). */
	webSearchModel?: string;
	webSearchProvider?: string;
	/** Vision fallback model + provider (image analysis). */
	visionModel?: string;
	visionProvider?: string;
}

function preferencesPath(): string {
	return join(configDir(), 'bobonyo-preferences.json');
}

export function loadPreferences(): Preferences {
	try {
		const file = preferencesPath();
		if (existsSync(file)) {
			return JSON.parse(readFileSync(file, 'utf8')) as Preferences;
		}
		// Legacy name: the pre-rename file still holds the settings until the
		// next save writes the bobonyo name.
		const legacy = join(configDir(), 'nanocoder-preferences.json');
		if (existsSync(legacy)) {
			return JSON.parse(readFileSync(legacy, 'utf8')) as Preferences;
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
/** Disk-cache TTL for fetched model catalogs (models change rarely). A warm
 *  cache stops every startup / every /model from re-fetching the catalog. */
export const MODEL_CATALOG_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, {at: number; models: string[]}>();

interface ModelCatalogCacheFile {
	entries: Record<string, {models: string[]; at: number}>;
}

export function modelCatalogCachePath(): string {
	return join(configDir(), 'model-catalogs.json');
}

function loadModelCatalogCache(): ModelCatalogCacheFile {
	try {
		if (!existsSync(modelCatalogCachePath())) return {entries: {}};
		const parsed = JSON.parse(
			readFileSync(modelCatalogCachePath(), 'utf8'),
		) as ModelCatalogCacheFile;
		return {entries: parsed.entries ?? {}};
	} catch {
		// corrupt or missing, start fresh
		return {entries: {}};
	}
}

function saveModelCatalogCache(
	entries: Record<string, {models: string[]; at: number}>,
): void {
	mkdirSync(configDir(), {recursive: true});
	const file = modelCatalogCachePath();
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({entries}, null, 2)}\n`, 'utf8');
	renameSync(tmp, file);
}

/**
 * Live model discovery (`modelDiscoveryUrl`): the value IS the complete
 * catalog URL (e.g. `https://token-plan-sgp.xiaomimimo.com/v1/models`) —
 * fetch it directly, cache by URL (5-minute in-memory + 1-hour DISK cache
 * so restarts do not re-fetch), and NEVER throw: a failed token falls back
 * to the last known disk catalog, then to the static list — a stale list
 * beats losing the models entirely.
 */
export async function discoverModels(provider: ResolvedProvider): Promise<string[]> {
	const discoveryUrl = provider.modelDiscoveryUrl;
	if (!discoveryUrl) return provider.models;
	const now = Date.now();
	const cached = discoveryCache.get(discoveryUrl);
	if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.models;
	const disk = loadModelCatalogCache();
	const freshDisk = disk.entries[discoveryUrl];
	if (freshDisk && now - freshDisk.at < MODEL_CATALOG_TTL_MS) {
		discoveryCache.set(discoveryUrl, {
			at: freshDisk.at,
			models: freshDisk.models,
		});
		return freshDisk.models;
	}
	try {
		const response = await fetch(
			discoveryUrl.replace(/\/+$/, ''),
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
		discoveryCache.set(discoveryUrl, {at: now, models: ids});
		disk.entries[discoveryUrl] = {models: ids, at: now};
		saveModelCatalogCache(disk.entries);
		return ids;
	} catch {
		// Token failed / network down: keep the last known catalog when it
		// exists (even stale), so the model list never collapses to seeds.
		const stale = disk.entries[discoveryUrl]?.models;
		if (stale && stale.length > 0) return stale;
		return provider.models;
	}
}

/**
 * The installed codex CLI version (parsed from `codex --version`, CACHED),
 * so the catalog request's `client_version` stays honest with the actual
 * CLI instead of drifting from a hardcoded constant. Falls back to a known
 * good version when codex is not installed.
 */
let cachedCodexClientVersion: string | null = null;
export function codexClientVersion(): string {
	if (cachedCodexClientVersion) return cachedCodexClientVersion;
	try {
		const out = execFileSync('codex', ['--version'], {
			encoding: 'utf8',
			timeout: 5000,
		});
		const match = /(\d+\.\d+\.\d+)/.exec(out);
		if (match) {
			cachedCodexClientVersion = match[1]!;
			return cachedCodexClientVersion;
		}
	} catch {
		// codex not installed / not on PATH — use the fallback.
	}
	cachedCodexClientVersion = '0.145.0';
	return cachedCodexClientVersion;
}

/**
 * Live model discovery for the ChatGPT-ACCOUNT codex backend: its catalog
 * endpoint needs the `codex login` token + account id (a generic Bearer
 * apiKey fetch can't), so it reads ~/.codex/auth.json itself and caches to
 * the same model-catalogs.json disk cache with the same stale fallback.
 * Returns [] when not logged in (the static account list remains).
 */
export async function discoverCodexAccountModels(
	baseUrl: string,
): Promise<string[]> {
	const discoveryUrl = `${baseUrl.replace(/\/+$/, '')}/models?client_version=${codexClientVersion()}`;
	const now = Date.now();
	const memory = discoveryCache.get(discoveryUrl);
	if (memory && now - memory.at < DISCOVERY_TTL_MS) return memory.models;
	const disk = loadModelCatalogCache();
	const freshDisk = disk.entries[discoveryUrl];
	if (freshDisk && now - freshDisk.at < MODEL_CATALOG_TTL_MS) {
		discoveryCache.set(discoveryUrl, {
			at: freshDisk.at,
			models: freshDisk.models,
		});
		return freshDisk.models;
	}
	try {
		const auth = readCodexAuth();
		if (!auth.accessToken) throw new Error('no codex login');
		const response = await fetch(discoveryUrl, {
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${auth.accessToken}`,
				...(auth.accountId
					? {'chatgpt-account-id': auth.accountId}
					: {}),
				originator: 'bobonyo',
			},
		});
		if (!response.ok) throw new Error(`codex models ${response.status}`);
		const body = (await response.json()) as {
			models?: Array<{slug?: string}>;
		};
		const ids = (body.models ?? [])
			.map(model => model.slug)
			.filter((id): id is string => Boolean(id));
		if (ids.length === 0) return ids;
		discoveryCache.set(discoveryUrl, {at: now, models: ids});
		disk.entries[discoveryUrl] = {models: ids, at: now};
		saveModelCatalogCache(disk.entries);
		return ids;
	} catch {
		const stale = disk.entries[discoveryUrl]?.models;
		if (stale && stale.length > 0) return stale;
		return [];
	}
}
