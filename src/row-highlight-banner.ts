import {createTextAttributes, type RGBA, type TextChunk} from '@opentui/core';
import type {Colors} from './theme';
import {themeColors, type ThemePalette} from './highlight';

type Palette = ThemePalette;
function chunk(text: string, fg: RGBA | undefined, attributes = 0): TextChunk {
	return {__isChunk: true, text, ...(fg ? {fg} : {}), attributes};
}
function bold(): number {
	return createTextAttributes({bold: true});
}
function dim(): number {
	return createTextAttributes({dim: true});
}
function emitLines(
	lines: string[],
	render: (line: string) => TextChunk[],
	defaultFg: RGBA,
): TextChunk[] {
	const chunks: TextChunk[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) chunks.push(chunk('\n', defaultFg));
		chunks.push(...render(lines[i] ?? ''));
	}
	return chunks;
}

/** Welcome banner with purpose-colored title, details, and borders. */
export function tokenizeBanner(text: string, colors: Colors): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		line => {
			if (/^[╭╰][─]+[╮╯]$/.test(line)) {
				return [chunk(line, palette.fg.primary, bold())];
			}
			if (/^[│].*[│]$/.test(line)) {
				const chunks: TextChunk[] = [];
				let rest = line;
				if (rest.startsWith('│')) {
					chunks.push(chunk('│', palette.fg.primary));
					rest = rest.slice(1);
				}
				const close = rest.lastIndexOf('│');
				if (close !== -1) {
					const body = rest.slice(0, close);
					const tail = rest.slice(close);
					const mascot = body.match(/^(\s*)(★\s*|╭◕‿◕╮|╰───╯)(.*)$/);
					if (mascot) {
						chunks.push(chunk(mascot[1] ?? '', defaultFg));
						chunks.push(chunk(mascot[2] ?? '', palette.fg.primary, bold()));
						chunks.push(
							...bannerBody(
								body.slice((mascot[1] ?? '').length + (mascot[2] ?? '').length),
								palette,
								defaultFg,
							),
						);
					} else {
						chunks.push(...bannerBody(body, palette, defaultFg));
					}
					chunks.push(chunk(tail, palette.fg.primary));
				} else {
					chunks.push(...bannerBody(rest, palette, defaultFg));
				}
				return chunks;
			}
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

function bannerBody(
	text: string,
	palette: Palette,
	defaultFg: RGBA,
): TextChunk[] {
	const title = text.match(/^(\s*)(bobonyo\s*\([^)]*\))(.*)$/);
	if (title) {
		return [
			chunk(`${title[1] ?? ''}${title[2] ?? ''}`, palette.fg.primary, bold()),
			chunk(title[3] ?? '', defaultFg),
		];
	}
	const keyed = text.match(/^(\s*)([a-zA-Z]+:)(\s+)(.*)$/);
	if (keyed) {
		const label = `${keyed[1] ?? ''}${keyed[2] ?? ''}${keyed[3] ?? ''}`;
		const value = keyed[4] ?? '';
		const key = (keyed[2] ?? '').toLowerCase();
		if (value.includes('/model to change')) {
			const model = value.match(/^(\S+)(\s+)(.*)$/);
			return [
				chunk(label, palette.fg.secondary),
				chunk(model?.[1] ?? value, defaultFg),
				chunk(
					model ? `${model[2] ?? ''}${model[3] ?? ''}` : '',
					palette.fg.secondary,
					dim(),
				),
			];
		}
		if (key !== 'permissions:') {
			return [chunk(label, palette.fg.secondary), chunk(value, defaultFg)];
		}
		const valueMatch = value.match(/^(\S.*\S)(\s*)$/);
		const valueText = valueMatch?.[1] ?? value.trimEnd();
		const padding = valueMatch?.[2] ?? '';
		const danger = /yolo|auto-accept/i.test(valueText);
		return [
			chunk(label, palette.fg.secondary),
			chunk(
				valueText,
				danger ? palette.fg.error : palette.fg.warning,
				danger ? bold() : undefined,
			),
			chunk(padding, defaultFg),
		];
	}
	return [chunk(text, defaultFg)];
}
