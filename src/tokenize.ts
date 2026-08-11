/**
 * E7: provider-aware token estimation for the ctx% indicator (parity:
 * nanocoder's provider-aware tokenizers, a rough char/token ratio keyed by
 * model family instead of a full BPE). The exact number doesn't gate
 * anything; it only drives the context-percentage footer and the B11
 * auto-compact trigger.
 */

const MODEL_RATIOS: Array<{match: RegExp; ratio: number}> = [
	{match: /claude/i, ratio: 3.6},
	{match: /deepseek|llama|qwen|glm|mistral|gemma/i, ratio: 3.4},
	{match: /gemini/i, ratio: 3.8},
	{match: /mimo|kimi/i, ratio: 3.2},
	// gpt/o*/codex and everything else default to ~4 chars/token.
];

export function estimateTokens(text: string, model?: string): number {
	const ratio =
		(model ? MODEL_RATIOS.find(entry => entry.match.test(model))?.ratio : undefined) ??
		4;
	return Math.ceil(text.length / ratio);
}
