import {RGBA, createTextAttributes, type TextChunk} from '@opentui/core';
import type {Colors} from './theme';

/**
 * Lightweight syntax highlighting for the transcript's code renderables.
 * OpenTUI 0.4.5 only bundles tree-sitter grammars for
 * javascript/typescript/markdown/zig, no bash, so bash commands and file
 * previews are tokenized here into colored TextChunks (consumed by
 * CodeRenderable.onChunks). Token colors derive from the ACTIVE theme.
 */

export interface ThemePalette {
	fg: {
		primary: RGBA;
		info: RGBA;
		success: RGBA;
		warning: RGBA;
		error: RGBA;
		secondary: RGBA;
		text: RGBA;
	};
}

export function themeColors(colors: Colors): ThemePalette {
	const hex = (value: string): RGBA => RGBA.fromHex(value);
	return {
		fg: {
			primary: hex(colors.primary),
			info: hex(colors.info),
			success: hex(colors.success),
			warning: hex(colors.warning),
			error: hex(colors.error),
			secondary: hex(colors.secondary),
			text: hex(colors.text),
		},
	};
}

interface TokenRule {
	re: RegExp;
	color: keyof ThemePalette['fg'];
	bold?: boolean;
	italic?: boolean;
}

function chunk(
	text: string,
	fg: RGBA | undefined,
	attributes = 0,
): TextChunk {
	return {__isChunk: true, text, ...(fg ? {fg} : {}), attributes};
}

/** Split text into themed chunks using ordered regex rules. */
function tokenize(
	text: string,
	rules: TokenRule[],
	palette: ThemePalette,
	defaultFg: RGBA,
): TextChunk[] {
	const chunks: TextChunk[] = [];
	let rest = text;
	while (rest.length > 0) {
		let matched = false;
		for (const rule of rules) {
			rule.re.lastIndex = 0;
			const m = rule.re.exec(rest);
			if (m && m.index === 0) {
				const token = m[0];
				const fg = palette.fg[rule.color];
				const attrs =
					rule.bold || rule.italic
						? createTextAttributes({
								bold: rule.bold,
								italic: rule.italic,
							})
						: 0;
				chunks.push(chunk(token, fg, attrs));
				rest = rest.slice(token.length);
				matched = true;
				break;
			}
		}
		if (!matched) {
			// Consume one char as plain text so we always progress.
			chunks.push(chunk(rest[0] ?? '', defaultFg));
			rest = rest.slice(1);
		}
	}
	return chunks;
}

const BASH_KEYWORDS =
	/\b(if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|time|local|export|readonly|return|exit|shift|source|break|continue)\b/;
const BASH_COMMANDS =
	/\b(cd|echo|printf|sleep|npm|pnpm|yarn|bun|node|git|gh|make|ls|cat|grep|awk|sed|curl|wget|kill|ps|mv|cp|rm|mkdir|touch|chmod|chown|sudo|tee|xargs|find|tail|head|cut|sort|uniq|wc|date|test|true|false|alias|set|unset|export|source|basename|dirname|read|wait|trap)\b/;

export function tokenizeBash(
	text: string,
	palette: ThemePalette,
	defaultFg: RGBA,
): TextChunk[] {
	return tokenize(
		text,
		[
			{re: /#[^\n]*/, color: 'secondary', italic: true},
			{re: /'[^'\n]*'/, color: 'warning'},
			{re: /"[^"\n]*"/, color: 'warning'},
			{re: /\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*/, color: 'info'},
			{re: /\b[0-9]+\b/, color: 'success'},
			{re: /--?[A-Za-z][A-Za-z0-9-]*/, color: 'warning'},
			{re: BASH_KEYWORDS, color: 'primary', bold: true},
			{re: BASH_COMMANDS, color: 'info'},
			{re: /[|&;<>(){}]/, color: 'secondary'},
		],
		palette,
		defaultFg,
	);
}

const CODE_KEYWORDS =
	/\b(const|let|var|function|return|import|from|export|default|interface|type|class|extends|implements|new|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|async|await|yield|of|in|typeof|instanceof|void|null|undefined|true|false|this|super|readonly|public|private|protected|static|enum|namespace|declare|abstract|as|satisfies|keyof|infer|never|unknown|any|string|number|boolean|object|symbol|bigint)\b/;

export function tokenizeCode(
	text: string,
	language: string,
	palette: ThemePalette,
	defaultFg: RGBA,
): TextChunk[] {
	void language; // token set is shared across the supported languages
	return tokenize(
		text,
		[
			{re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//, color: 'secondary', italic: true},
			{re: /`(?:[^`\\]|\\.)*`|'[^'\n]*'|"[^"\n]*"/, color: 'warning'},
			{re: /\b[0-9]+\b/, color: 'success'},
			{re: CODE_KEYWORDS, color: 'primary', bold: true},
			// JSX/TSX tag names and interface/type names (PascalCase).
			{re: /\b[A-Z][A-Za-z0-9_]*\b/, color: 'info'},
			// Only structural braces stay dim; other punctuation keeps the
			// default text color so code doesn't look over-highlighted.
			{re: /[{}]/, color: 'secondary'},
		],
		palette,
		defaultFg,
	);
}

/**
 * Map a file path to a highlight language id. Only the languages we have
 * tokenizers for return a non-empty id; everything else falls back to plain.
 */
export function languageForPath(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'typescript';
	if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript';
	if (['json', 'jsonc'].includes(ext)) return 'json';
	if (['md', 'mdx'].includes(ext)) return 'markdown';
	if (['sh', 'bash', 'zsh', 'mjs.sh'].includes(ext)) return 'bash';
	return '';
}
