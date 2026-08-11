/**
 * Vision fallback (port of nanocoder's examine-image flow): when a Vision
 * fallback model is configured (Settings → Capabilities → Vision model),
 * attached `[Image #N]` images are sent to THAT model for analysis and the
 * description is handed to the main (possibly text-only) agent, with a chat
 * indicator row mirroring the web-search fallback line.
 */

import {readFileSync, existsSync} from 'node:fs';
import {listProviders, loadPreferences} from './config';

export interface VisionFallback {
	baseUrl: string;
	apiKey: string;
	model: string;
	providerId: string;
}

/** Resolve the configured vision fallback (null = inherit main model). */
export function resolveVisionFallback(): VisionFallback | null {
	const prefs = loadPreferences();
	if (!prefs.visionModel) return null;
	const providers = listProviders();
	const provider =
		providers.find(
			candidate => candidate.id === prefs.visionProvider,
		) ??
		providers.find(candidate =>
			candidate.models.includes(prefs.visionModel!),
		);
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
			...(fallback.apiKey
				? {authorization: `Bearer ${fallback.apiKey}`}
				: {}),
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
