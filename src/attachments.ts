import {existsSync} from 'node:fs';

/** Paste text longer than this becomes a `[Text #N]` placeholder. */
export const MAX_PASTE_CHARS = 200;

const IMAGE_RE =
	/(?:file:\/\/)?["']?([^\s"']+\.(?:png|jpe?g|gif|webp))["']?/gi;

function nextNumber(
	attachments: Record<string, string>,
	used: Set<number>,
): number {
	let n = 1;
	while (attachments[String(n)] || used.has(n)) n += 1;
	return n;
}

/**
 * Turn a terminal paste/drop into the compact input tokens (parity:
 * nanocoder's `[Image #N]` / `[Text #N]`):
 * - Image file paths (existing files with an image extension) → `[Image #N]`.
 * - Long text (> MAX_PASTE_CHARS) → `[Text #N]`.
 */
export function processPaste(
	text: string,
	existing: Record<string, string>,
): {text: string; attachments: Record<string, string>} {
	const attachments = {...existing};
	const used = new Set(Object.keys(attachments).map(Number));
	let cleaned = text.replace(
		IMAGE_RE,
		(match: string, path: string): string => {
			const candidate = path.replace(/\\ /g, ' ');
			if (!existsSync(candidate)) return match;
			const n = nextNumber(attachments, used);
			used.add(n);
			attachments[String(n)] = candidate;
			return `[Image #${n}]`;
		},
	);
	if (cleaned.length > MAX_PASTE_CHARS) {
		const n = nextNumber(attachments, used);
		used.add(n);
		attachments[String(n)] = cleaned;
		cleaned = `[Text #${n}]`;
	}
	return {text: cleaned, attachments};
}

/** Expand `[Text #N]` back to the pasted text (Image tokens stay visible). */
export function expandTextPlaceholders(
	text: string,
	attachments: Record<string, string>,
): string {
	return text.replace(/\[Text #(\d+)\]/g, (match, n: string) => {
		const raw = attachments[n];
		return raw === undefined ? match : raw;
	});
}
