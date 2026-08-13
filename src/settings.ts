/**
 * Runtime settings (parity: nanocoder's config/preferences surface):
 * mode (D4/B16), tool profile (D7), and message cap (B4).
 *
 * Load order: `settings.json` in the config dir, overridden by CLI flags
 * (`--mode`, `--profile`) passed via env by index.tsx.
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {nanocoderConfigDir} from './nanocoder-paths';

export type Mode = 'yolo' | 'auto-accept' | 'normal' | 'plan';
export type ToolProfile = 'full' | 'minimal' | 'nano' | 'auto';
/**
 * Working directory to use when resuming a session (codex `ResumeCwdMode`
 * parity): the session's recorded directory (cache-friendly — the system
 * head stays byte-identical), the directory where bobonyo was launched, or
 * ask the user when the two differ.
 */
export type ResumeCwdMode = 'session' | 'current' | 'ask';

export interface Settings {
	mode: Mode;
	toolProfile: ToolProfile;
	maxMessages: number;
	/** Active theme id (see src/theme.ts, omnicode / tokyo-night / …). */
	theme?: string;
	/** Welcome-banner title shape (powerline-angled / tiny / none). */
	titleShape?: string;
	/** Show the status line footer (on/off). */
	statusLine?: boolean;
	/**
	 * Hide live Thinking + settled Thought blocks; the Working indicator
	 * says "Thinking…" while the model reasons instead.
	 */
	hideThinking?: boolean;
	/**
	 * Built-in caveman communication mode (bundled skill). ON by default;
	 * the toggle removes the caveman instructions from the system prompt.
	 */
	cavemanMode?: boolean;
	/** Resume working-directory mode (session / current / ask). */
	resumeCwd?: ResumeCwdMode;
	/** Mouse-wheel scroll speed multiplier (parity: opencode scroll_speed, default 3). */
	scrollSpeed?: number;
	autoCompact: {enabled: boolean; threshold: number};
	watchdogMs?: number;
	streamGuard?: {maxOutputChars?: number; maxDurationMs?: number};
	/** A2: directories the user has trusted (first-run trust gate). */
	trustedDirs?: string[];
	privacy?: {patterns: Array<{pattern: string; placeholder?: string}>};
}

const DEFAULTS: Settings = {
	mode: 'yolo',
	toolProfile: 'full',
	maxMessages: 1000,
	hideThinking: true,
	cavemanMode: true,
	resumeCwd: 'session',
	scrollSpeed: 3,
	autoCompact: {enabled: false, threshold: 75},
	watchdogMs: 0,
	streamGuard: {},
	trustedDirs: [],
	privacy: {patterns: []},
};

function settingsPath(): string {
	// Still the NANOCODER config dir, the rename happens when stable.
	const base = process.env.NANOCODER_CONFIG_DIR ?? nanocoderConfigDir();
	return join(base, 'settings.json');
}

export function loadSettings(): Settings {
	let settings: Partial<Settings> = {};
	try {
		const file = settingsPath();
		if (existsSync(file)) {
			settings = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>;
		}
	} catch {
		// corrupt settings, defaults
	}
	const mode = (process.env.NANOCODER_MODE ?? settings.mode ?? DEFAULTS.mode) as Mode;
	const toolProfile = (
		process.env.NANOCODER_PROFILE ??
		settings.toolProfile ??
		DEFAULTS.toolProfile
	) as ToolProfile;
	const maxMessages = Number(
		process.env.NANOCODER_MAX_MESSAGES ?? settings.maxMessages ?? DEFAULTS.maxMessages,
	);
	const rawAuto = (settings.autoCompact ?? {}) as Partial<{enabled: boolean; threshold: number}>;
	const threshold = Math.max(
		50,
		Math.min(95, Number(rawAuto.threshold ?? DEFAULTS.autoCompact.threshold)),
	);
	const watchdogMs = Number(settings.watchdogMs ?? DEFAULTS.watchdogMs);
	const rawGuard = (settings.streamGuard ?? {}) as Partial<{
		maxOutputChars: number;
		maxDurationMs: number;
	}>;
	const trustedDirs = Array.isArray(settings.trustedDirs)
		? settings.trustedDirs.filter(dir => typeof dir === 'string' && dir.length > 0)
		: [];
	const privacy = settings.privacy ?? DEFAULTS.privacy;
	const theme =
		typeof settings.theme === 'string' && settings.theme.length > 0
			? settings.theme
			: undefined;
	const titleShape =
		typeof settings.titleShape === 'string' && settings.titleShape.length > 0
			? settings.titleShape
			: undefined;
	const statusLine = settings.statusLine !== false;
	const hideThinking = settings.hideThinking !== false;
	const cavemanMode = settings.cavemanMode !== false;
	const resumeCwd = ['session', 'current', 'ask'].includes(
		settings.resumeCwd ?? '',
	)
		? (settings.resumeCwd as ResumeCwdMode)
		: DEFAULTS.resumeCwd;
	const scrollSpeed =
		typeof settings.scrollSpeed === 'number' &&
		Number.isFinite(settings.scrollSpeed)
			? settings.scrollSpeed
			: DEFAULTS.scrollSpeed;
	return {
		mode: ['yolo', 'auto-accept', 'normal', 'plan'].includes(mode) ? mode : DEFAULTS.mode,
		toolProfile: ['full', 'minimal', 'nano', 'auto'].includes(toolProfile)
			? toolProfile
			: DEFAULTS.toolProfile,
		maxMessages: Number.isFinite(maxMessages) && maxMessages > 0 ? maxMessages : DEFAULTS.maxMessages,
		theme,
		titleShape,
		statusLine,
		hideThinking,
		cavemanMode,
		resumeCwd,
		scrollSpeed,
		autoCompact: {
			enabled: rawAuto.enabled === true,
			threshold,
		},
		watchdogMs: Number.isFinite(watchdogMs) && watchdogMs >= 0 ? watchdogMs : 0,
		streamGuard: {
			maxOutputChars:
				Number.isFinite(rawGuard.maxOutputChars) &&
				rawGuard.maxOutputChars! > 0
					? rawGuard.maxOutputChars
					: undefined,
			maxDurationMs:
				Number.isFinite(rawGuard.maxDurationMs) &&
				rawGuard.maxDurationMs! > 0
				? rawGuard.maxDurationMs
					: undefined,
		},
		trustedDirs,
		privacy: {
			patterns: Array.isArray(privacy?.patterns)
				? privacy.patterns.filter(
						(p): p is {pattern: string; placeholder?: string} =>
							typeof p?.pattern === 'string' && p.pattern.length > 0,
					)
				: [],
		},
	};
}

export function saveSettings(settings: Settings): void {
	const base = process.env.NANOCODER_CONFIG_DIR ?? nanocoderConfigDir();
	mkdirSync(base, {recursive: true});
	writeFileSync(
		join(base, 'settings.json'),
		`${JSON.stringify(settings, null, 2)}\n`,
		'utf8',
	);
}

/**
 * Which directory a resumed session should use (codex `ResumeCwdMode`
 * parity). `session`/`current` are final; `ask` means the cwd DECISION is
 * deferred to the user when the two directories differ (identical cwds need
 * no prompt). Pure, unit-tested.
 */
export function resumeCwdDecision(
	mode: ResumeCwdMode,
	currentCwd: string,
	sessionCwd: string | undefined,
): 'session' | 'current' | 'ask' {
	if (!sessionCwd || mode === 'current') return 'current';
	if (mode === 'session') return 'session';
	return currentCwd === sessionCwd ? 'session' : 'ask';
}
