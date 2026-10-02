/** E6: models.dev context-window fallback, cached for a day. */
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
let modelsDevCache: {
	url: string;
	data: ModelsDevCatalog;
	at: number;
} | null = null;
const modelsDevRequests = new Map<string, Promise<ModelsDevCatalog>>();

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
	const pending = modelsDevRequests.get(url);
	if (pending) return pending;
	// A provider catalog resolves hundreds of models concurrently. Share both
	// the download and JSON parse instead of flooding the UI's event loop.
	const request = (async () => {
		const response = await fetch(url);
		if (!response.ok)
			throw new Error(`models.dev responded ${response.status}`);
		const data = (await response.json()) as ModelsDevCatalog;
		modelsDevCache = {url, data, at: Date.now()};
		return data;
	})();
	modelsDevRequests.set(url, request);
	try {
		return await request;
	} finally {
		modelsDevRequests.delete(url);
	}
}

/**
 * Extract model context from either models.dev schema. Provider match first,
 * then search whole catalog for auto-discovered ids under another provider.
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
	const legacy = catalog[model];
	if (legacy && !legacy.models) {
		const window = pick({
			limit: undefined,
			context_window: legacy.context_window,
		});
		if (window) return window;
	}
	return undefined;
}

/** Declared provider value wins; discovery failure means unknown. */
export async function resolveContextWindow(
	model: string,
	declared?: number,
	providerId?: string,
): Promise<number | undefined> {
	if (declared) return declared;
	try {
		return modelsDevContextWindow(
			await fetchModelsDev(),
			providerId ?? '',
			model,
		);
	} catch {
		return undefined;
	}
}

/** Provider config is authoritative; discovery only fills missing limits. */
export function effectiveContextWindow(
	declared?: number,
	discovered?: number,
	fallback = 128_000,
): number {
	return declared && declared > 0
		? declared
		: discovered && discovered > 0
			? discovered
			: fallback;
}
