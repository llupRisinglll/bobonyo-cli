import {randomUUID} from 'node:crypto';
import {copyFileSync, chmodSync, existsSync, mkdirSync} from 'node:fs';
import {extname, join, resolve} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';

/** Paste text longer than this becomes a `[Text #N]` placeholder. */
export const MAX_PASTE_CHARS = 200;

const IMAGE_RE = /(?:file:\/\/)?["']?([^\s"']+\.(?:png|jpe?g|gif|webp))["']?/gi;

function nextNumber(
	attachments: Record<string, string>,
	used: Set<number>,
): number {
	let n = 1;
	while (attachments[String(n)] || used.has(n)) n += 1;
	return n;
}

interface ProcessPasteOptions {
	sessionId?: string;
	baseDir?: string;
	id?: () => string;
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
	options: ProcessPasteOptions = {},
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
	// Terminals commonly paste CRLF. A raw `\r` is invisible but still
	// consumes a cursor offset, desynchronizing caret, vertical movement and
	// Backspace. Canonicalize every text paste before inserting/tokenizing.
	cleaned = cleaned.replace(/\r\n?/g, '\n');
	if (cleaned.length > MAX_PASTE_CHARS) {
		const parts = cleaned.split(/(\[Image #\d+\])/g);
		cleaned = parts
			.map(part => {
				if (/^\[Image #\d+\]$/.test(part) || part.length <= MAX_PASTE_CHARS) {
					return part;
				}
				const leading = part.match(/^\s*/)?.[0] ?? '';
				const trailing = part.match(/\s*$/)?.[0] ?? '';
				const body = part.slice(leading.length, part.length - trailing.length);
				const n = nextNumber(attachments, used);
				used.add(n);
				attachments[String(n)] = body;
				return `${leading}[Text #${n}]${trailing}`;
			})
			.join('');
	}
	return {
		text: cleaned,
		attachments: options.sessionId
			? persistImageAttachments(
					cleaned,
					attachments,
					options.sessionId,
					options.baseDir,
					options.id,
				)
			: attachments,
	};
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

/** Keep only image files referenced by this submitted prompt. */
export function referencedImageAttachments(
	text: string,
	attachments: Record<string, string>,
): Record<string, string> {
	const referenced: Record<string, string> = {};
	for (const match of text.matchAll(/\[Image #(\d+)\]/g)) {
		const index = match[1];
		if (!index) continue;
		const path = attachments[index];
		if (path) referenced[index] = path;
	}
	return referenced;
}

/**
 * Copy submitted images out of ephemeral screenshot/clipboard directories.
 * Stable paths survive resume and let shell tools upload exact source bytes.
 */
export function persistImageAttachments(
	text: string,
	attachments: Record<string, string>,
	sessionId: string,
	baseDir = bobonyoDataDir(),
	id: () => string = randomUUID,
): Record<string, string> {
	const next = {...attachments};
	const cacheDir = resolve(baseDir, 'image-cache', sessionId);
	for (const match of text.matchAll(/\[Image #(\d+)\]/g)) {
		const index = match[1];
		if (!index) continue;
		const source = attachments[index];
		if (!source || !existsSync(source)) continue;
		if (resolve(source).startsWith(`${cacheDir}/`)) continue;
		const extension = extname(source).toLowerCase() || '.png';
		try {
			mkdirSync(cacheDir, {recursive: true, mode: 0o700});
			const target = join(cacheDir, `${id()}${extension}`);
			copyFileSync(source, target);
			chmodSync(target, 0o600);
			next[index] = target;
		} catch {
			// Keep original path. Provider can still inspect current turn's image.
		}
	}
	return next;
}

/**
 * Add provider-only source paths. Image-capable models see pixels, but agents
 * also need filesystem paths for shell upload and image manipulation tasks.
 */
export function imageSourceContext(
	text: string,
	attachments: Record<string, string>,
): string {
	const rows = new Map<string, string>();
	for (const match of text.matchAll(/\[Image #(\d+)\]/g)) {
		const index = match[1];
		const path = index ? attachments[index] : undefined;
		if (index && path)
			rows.set(index, `[Image #${index}] source path: ${JSON.stringify(path)}`);
	}
	return rows.size > 0
		? `\n\n<attached-images>\n${[...rows.values()].join('\n')}\n</attached-images>`
		: '';
}
