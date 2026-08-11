import {createMemo, createSignal} from 'solid-js';
import {loadSettings, saveSettings} from './settings';

/**
 * Theme system (parity: nanocoder's `source/config/themes.json` + Colors).
 * Every component reads colors through `colors()`, NEVER hardcoded hex, so
 * the /settings theme selector can switch palettes at runtime.
 */
export interface Colors {
	text: string;
	base: string;
	primary: string;
	tool: string;
	secondary: string;
	success: string;
	error: string;
	info: string;
	warning: string;
	diffAdded: string;
	diffRemoved: string;
	diffAddedText: string;
	diffRemovedText: string;
	diffAddedWord: string;
	diffRemovedWord: string;
	textboxBackground?: string;
	promptChar?: string;
	bannerGradient?: string[];
	assistantIcon?: string;
}

export interface Theme {
	name: string;
	displayName: string;
	themeType: 'light' | 'dark';
	colors: Colors;
}

/** Omnicode palette (authoritative, nanocoder/source/config/themes.json). */
const OMNICODE: Theme = {
	name: 'omnicode',
	displayName: 'Omnicode',
	themeType: 'dark',
	colors: {
		// Normal/body text is plain WHITE (parity feedback: the previous
		// `#c0caf5` read as a light violet in the transcript).
		text: '#ffffff',
		base: '#1a1b26',
		primary: '#bb9af7',
		tool: '#bb9af7',
		success: '#7AF778',
		error: '#f7768e',
		secondary: '#565f89',
		info: '#bb9af7',
		warning: '#e0af68',
		diffAdded: '#1f3a28',
		diffRemoved: '#3a1f28',
		diffAddedText: '#7AF778',
		diffRemovedText: '#f7768e',
		diffAddedWord: '#338844',
		diffRemovedWord: '#883344',
		textboxBackground: 'none',
		promptChar: '❯',
		bannerGradient: ['#bb9af7', '#bb9af7'],
		assistantIcon: '✦',
	},
};

/** Tokyo Night, secondary palette for /settings theme switching. */
const TOKYO_NIGHT: Theme = {
	name: 'tokyo-night',
	displayName: 'Tokyo Night',
	themeType: 'dark',
	colors: {
		text: '#c0caf5',
		base: '#1a1b26',
		primary: '#7aa2f7',
		tool: '#7aa2f7',
		success: '#9ece6a',
		error: '#f7768e',
		secondary: '#565f89',
		info: '#7dcfff',
		warning: '#e0af68',
		diffAdded: '#1f3a28',
		diffRemoved: '#3a1f28',
		diffAddedText: '#9ece6a',
		diffRemovedText: '#f7768e',
		diffAddedWord: '#338844',
		diffRemovedWord: '#883344',
		textboxBackground: 'none',
		promptChar: '❯',
		bannerGradient: ['#7aa2f7', '#7aa2f7'],
		assistantIcon: '✦',
	},
};

export const THEMES: Record<string, Theme> = {
	omnicode: OMNICODE,
	'tokyo-night': TOKYO_NIGHT,
};

// NOTE: the initial theme must NOT be read from settings at module scope,
// index.tsx sets NANOCODER_CONFIG_DIR in its body, but ESM imports (and thus
// this module) evaluate BEFORE that body runs, so a top-level loadSettings()
// would read the WRONG config dir. App syncs the theme from settings on mount
// (same as mode/profile/maxMessages).
export const [themeName, setThemeName] = createSignal<string>('omnicode');

/** Active palette, reactive; components read `colors()` in render. */
export const colors = createMemo<Colors>(
	() => THEMES[themeName()]?.colors ?? OMNICODE.colors,
);

export const currentTheme = createMemo<Theme>(
	() => THEMES[themeName()] ?? OMNICODE,
);

export function selectTheme(name: string): void {
	if (!THEMES[name]) return;
	setThemeName(name);
	try {
		saveSettings({...loadSettings(), theme: name});
	} catch {
		// best-effort persistence
	}
}

/** Chalk-grey neutral for placeholders/hints (not the secondary palette). */
export const CHALK_GREY = '#808080';
