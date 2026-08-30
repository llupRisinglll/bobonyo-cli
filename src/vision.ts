/**
 * Vision fallback (port of nanocoder's examine-image flow): when a Vision
 * fallback model is configured (Settings → Capabilities → Vision model),
 * attached `[Image #N]` images are sent to THAT model for analysis and the
 * description is handed to the main (possibly text-only) agent, with a chat
 * indicator row mirroring the web-search fallback line.
 */

import {readFileSync, existsSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {listProviders, loadPreferences} from './config';

export interface VisionFallback {
	baseUrl: string;
	apiKey: string;
	model: string;
	providerId: string;
}

/** Codex Responses models accept native input_image blocks. */
export function supportsNativeImageInput(endpoint: {
	id?: string;
	name?: string;
	model: string;
	sdkProvider?: string;
	codexAccount?: boolean;
}): boolean {
	if (endpoint.codexAccount) return true;
	return (
		endpoint.sdkProvider === 'responses' &&
		/(?:codex|gpt-5)/i.test(
			`${endpoint.id ?? ''} ${endpoint.name ?? ''} ${endpoint.model}`,
		)
	);
}

/** Resolve the configured vision fallback (null = inherit main model). */
export function resolveVisionFallback(): VisionFallback | null {
	const prefs = loadPreferences();
	if (!prefs.visionModel) return null;
	const providers = listProviders();
	const provider =
		providers.find(candidate => candidate.id === prefs.visionProvider) ??
		providers.find(candidate => candidate.models.includes(prefs.visionModel!));
	if (!provider) return null;
	return {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKeyResolved,
		model: prefs.visionModel,
		providerId: provider.id,
	};
}

function mimeFor(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
	if (ext === 'gif') return 'image/gif';
	if (ext === 'webp') return 'image/webp';
	return 'image/png';
}

export async function inspectWorkspaceImage(
	imagePath: string,
	question: string,
	cwd: string,
	analyze: (
		path: string,
		prompt: string,
	) => Promise<string> = analyzeImageWithFallback,
): Promise<string> {
	const root = realpathSync(resolve(cwd));
	const absolute = resolve(cwd, imagePath);
	if (!existsSync(absolute)) throw new Error(`Image not found: ${imagePath}`);
	const real = realpathSync(absolute);
	const rel = relative(root, real);
	if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
		throw new Error(`${imagePath} resolves outside the current workspace`);
	}
	if (!/\.(?:png|jpe?g|gif|webp)$/i.test(real)) {
		throw new Error('view_image supports PNG, JPEG, GIF, and WebP files only');
	}
	if (statSync(real).size > 20 * 1024 * 1024) {
		throw new Error('Image exceeds the 20 MiB limit');
	}
	const result = await analyze(
		real,
		question.trim() ||
			'Describe this image precisely, including visible text and UI details.',
	);
	if (!result) throw new Error('No vision model is configured');
	return result;
}

/**
 * Analyze an image through the vision fallback model (OpenAI-compatible
 * chat-completions with an `image_url` content part). Returns the model's
 * description; throws a descriptive error when the request fails.
 */
export async function analyzeImageWithFallback(
	imagePath: string,
	question: string,
): Promise<string> {
	const fallback = resolveVisionFallback();
	if (!fallback) return '';
	if (!existsSync(imagePath)) {
		throw new Error(`Image not found: ${imagePath}`);
	}
	const base64 = readFileSync(imagePath).toString('base64');
	const response = await fetch(`${fallback.baseUrl}/v1/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(fallback.apiKey ? {authorization: `Bearer ${fallback.apiKey}`} : {}),
		},
		body: JSON.stringify({
			model: fallback.model,
			stream: false,
			messages: [
				{
					role: 'user',
					content: [
						{type: 'text', text: question},
						{
							type: 'image_url',
							image_url: {
								url: `data:${mimeFor(imagePath)};base64,${base64}`,
							},
						},
					],
				},
			],
		}),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(
			`Vision fallback failed (HTTP ${response.status}): ${detail.slice(0, 200)}`,
		);
	}
	const data = (await response.json()) as {
		choices?: Array<{message?: {content?: string}}>;
	};
	return data.choices?.[0]?.message?.content ?? '';
}
