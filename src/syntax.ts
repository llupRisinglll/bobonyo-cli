import {SyntaxStyle} from '@opentui/core';
import type {Colors} from './theme';

/**
 * Transcript markdown syntax style, derived from the ACTIVE theme, never
 * hardcoded (the /settings theme selector must recolor the transcript).
 */
export function markdownSyntaxStyleFor(colors: Colors): SyntaxStyle {
	return SyntaxStyle.fromStyles({
		default: {fg: colors.text},
		// Code token styles (tree-sitter highlight groups), these color the
		// ` ```ts ` / ` ```js ` code blocks through the built-in grammar.
		keyword: {fg: colors.primary, bold: true},
		'keyword.import': {fg: colors.primary, bold: true},
		'keyword.export': {fg: colors.primary, bold: true},
		'keyword.control': {fg: colors.primary, bold: true},
		string: {fg: colors.warning},
		'string.special': {fg: colors.warning},
		number: {fg: colors.success},
		'type.builtin': {fg: colors.info},
		type: {fg: colors.info},
		class: {fg: colors.info},
		function: {fg: colors.info},
		'function.method': {fg: colors.info},
		comment: {fg: colors.secondary, italic: true},
		'comment.line': {fg: colors.secondary, italic: true},
		'comment.block': {fg: colors.secondary, italic: true},
		variable: {fg: colors.text},
		'variable.parameter': {fg: colors.text},
		constant: {fg: colors.text},
		operator: {fg: colors.text},
		'punctuation.delimiter': {fg: colors.text},
		'punctuation.bracket': {fg: colors.text},
		tag: {fg: colors.info},
		attribute: {fg: colors.warning},
		'markup.heading': {fg: colors.primary, bold: true},
		// Bold = emphasis = PRIMARY accent (the welcome tip hotkeys and bold
		// reply spans pick this up).
		'markup.strong': {fg: colors.primary, bold: true},
		'markup.italic': {},
		'markup.raw': {fg: colors.info},
		// Links use the dedicated LINK color (cyan in both bundled themes),
		// not primary/info purple or the warning yellow, so they read as
		// links instead of clashing with tool names and emphasis.
		'markup.link': {fg: colors.link, underline: true},
		'markup.link.label': {fg: colors.link},
		'markup.link.url': {fg: colors.link, underline: true},
		'markup.list': {fg: colors.secondary},
		'markup.quote': {fg: colors.secondary},
		'markup.strikethrough': {dim: true},
	});
}
