import type {ProviderConfig} from '../config';
import {
	CODEX_MODELS,
	CODEX_ACCOUNT_MODELS,
	DEEPSEEK_MODELS,
	XIAOMI_MODELS,
	type ProviderPreset,
} from './provider-presets';

/** Codex provider payloads (pure, unit-tested). */
export function codexAccountProvider(name = 'codex'): ProviderConfig {
	return {
		id: name.trim() || 'codex',
		name: name.trim() || 'codex',
		baseUrl: 'https://chatgpt.com/backend-api/codex',
		sdkProvider: 'responses',
		codexAccount: true,
		contextWindow: 400_000,
		models: CODEX_ACCOUNT_MODELS,
	};
}

export function codexApiKeyProvider(
	apiKey: string,
	name = 'codex',
): ProviderConfig | null {
	const key = apiKey.trim();
	if (!key) return null;
	const id = name.trim() || 'codex';
	return {
		id,
		name: id,
		baseUrl: 'https://api.openai.com/v1',
		sdkProvider: 'responses',
		apiKey: key,
		modelDiscoveryUrl: 'https://api.openai.com/v1/models',
		contextWindow: 400_000,
		models: CODEX_MODELS,
	};
}

/** DeepSeek preset: known endpoint, discovery keeps the catalog fresh. */
export function deepseekProvider(name: string, apiKey: string): ProviderConfig {
	const id = name.trim() || 'deepseek';
	return {
		id,
		name: id,
		baseUrl: 'https://api.deepseek.com',
		...(apiKey.trim() ? {apiKey: apiKey.trim()} : {}),
		modelDiscoveryUrl: 'https://api.deepseek.com/models',
		models: DEEPSEEK_MODELS,
	};
}

/** Xiaomi MiMo token-plan preset (normalize adds the /models discovery). */
export function xiaomiProvider(name: string, apiKey: string): ProviderConfig {
	const id = name.trim() || 'xiaomi';
	return {
		id,
		name: id,
		baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
		...(apiKey.trim() ? {apiKey: apiKey.trim()} : {}),
		models: XIAOMI_MODELS,
	};
}

/** Generic preset builder for OpenAI-compatible endpoints (pure). */
export function openAICompatibleProvider(
	preset: ProviderPreset,
	name: string,
	apiKey: string,
): ProviderConfig {
	const id = name.trim() || preset.id;
	return {
		id,
		name: id,
		baseUrl: preset.baseUrl,
		...(apiKey.trim() ? {apiKey: apiKey.trim()} : {}),
		...(preset.modelDiscoveryUrl
			? {modelDiscoveryUrl: preset.modelDiscoveryUrl}
			: {}),
		...(preset.sdkProvider ? {sdkProvider: preset.sdkProvider} : {}),
		...(preset.contextWindow ? {contextWindow: preset.contextWindow} : {}),
		models: preset.models,
	};
}

/** Build the provider for a preset + stashed API key (codex routes apart). */
export function buildPresetProvider(
	preset: ProviderPreset,
	name: string,
	apiKey: string,
): ProviderConfig | null {
	if (preset.id === 'codex') return codexApiKeyProvider(apiKey, name);
	// OpenCode Zen allows a BLANK key: the anonymous tier still serves the
	// free models, so a user without a subscription can connect anyway.
	if (!apiKey.trim() && !preset.optionalKey) return null;
	if (preset.id === 'deepseek') return deepseekProvider(name, apiKey);
	if (preset.id === 'xiaomi') return xiaomiProvider(name, apiKey);
	return openAICompatibleProvider(preset, name, apiKey);
}

export function customProvider(config: {
	id: string;
	baseUrl: string;
	apiKey?: string;
	models: string[];
}): ProviderConfig | null {
	const id = config.id.trim();
	const baseUrl = config.baseUrl.trim();
	if (!id || !baseUrl) return null;
	return {
		id,
		name: id,
		baseUrl,
		...(config.apiKey?.trim() ? {apiKey: config.apiKey.trim()} : {}),
		models: config.models,
	};
}
