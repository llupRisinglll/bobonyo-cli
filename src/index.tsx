/** @jsxImportSource @opentui/solid */
// Explicit preload (bunfig preloads it for `bun run`, but `bun build
// --compile` does not resolve bunfig, the binary needs the import inline).
import '@opentui/solid/preload';
import {appendFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createCliRenderer} from '@opentui/core';
import {render} from '@opentui/solid';
import {App} from './app';

// Debug key logger (NANOCODER_KEYLOG=1): records every raw input sequence AND
// every parsed key event to /tmp/otui-keys.log so herdr key-delivery problems
// can be investigated. OFF by default, sync appends would add input latency.
const keyLogFile = '/tmp/otui-keys.log';
const logKey = (kind: string, payload: unknown): void => {
	if (!process.env.NANOCODER_KEYLOG) return;
	try {
		appendFileSync(
			keyLogFile,
			`${Date.now()} ${kind} ${JSON.stringify(payload)}\n`,
		);
	} catch {
		// best-effort debug logging
	}
};

// `bun run dev --resume [last|N|id]`, hand the ref to App on mount.
const cliArgs = process.argv.slice(2);
const resumeIndex = cliArgs.indexOf('--resume');
if (resumeIndex !== -1) {
	const ref = cliArgs[resumeIndex + 1];
	process.env.NANOCODER_RESUME = ref && !ref.startsWith('-') ? ref : 'last';
}
// `--continue` is an alias for `--resume last` (or `--continue <id>`).
const continueIndex = cliArgs.indexOf('--continue');
if (continueIndex !== -1) {
	const ref = cliArgs[continueIndex + 1];
	process.env.NANOCODER_RESUME =
		ref && !ref.startsWith('-') ? ref : 'last';
}
const providerIndex = cliArgs.indexOf('--provider');
if (providerIndex !== -1) {
	const ref = cliArgs[providerIndex + 1];
	if (ref && !ref.startsWith('-')) process.env.NANOCODER_PROVIDER = ref;
}
const modeIndex = cliArgs.indexOf('--mode');
if (modeIndex !== -1) {
	const ref = cliArgs[modeIndex + 1];
	if (ref && !ref.startsWith('-')) process.env.BOBONYO_MODE = ref;
}
const profileIndex = cliArgs.indexOf('--profile');
if (profileIndex !== -1) {
	const ref = cliArgs[profileIndex + 1];
	if (ref && !ref.startsWith('-')) process.env.BOBONYO_PROFILE = ref;
}
// GAP-21: `bun run dev --preview tui` (or `preview tui`) boots the app against
// the local keyword mock so all /mock:* scenarios can be reviewed without
// provider tokens, mirrors `nanocoder preview tui`.
import {isPreviewTui} from './preview';
const PREVIEW_TUI = isPreviewTui();
if (PREVIEW_TUI) {
	process.env.MOCK_URL ??= 'http://127.0.0.1:4123';
	process.env.BOBONYO_CONFIG_DIR ??= '/tmp/bobonyo-preview';
	// Preview mocks exercise the FULL tool surface, never let a persisted
	// `minimal`/`nano` profile truncate the mock batches (e.g.
	// `/mock:compact10` must stream all TEN bash calls into `✦ Ran Bash ×10`
	// instead of slicing to one). loadSettings() prefers NANOCODER_PROFILE
	// over the saved settings file, so this always wins in preview.
	process.env.BOBONYO_PROFILE ??= 'full';
	// Preview seed: EFFORT IS PER MODEL, give the mock model a catalog
	// effort (data-driven, mirrors how a real provider config declares
	// `{name, effort}`) so the `model[effort]` badge renders in previews
	// without any environment-variable hack.
	const cfgDir = process.env.BOBONYO_CONFIG_DIR;
	const providersFile = join(cfgDir ?? '/tmp/bobonyo-preview', 'providers.json');
	if (!existsSync(providersFile)) {
		mkdirSync(cfgDir ?? '/tmp/bobonyo-preview', {recursive: true});
		writeFileSync(
			providersFile,
			`${JSON.stringify(
				{
					providers: [
						{
							id: 'mock',
							name: 'Mock',
							baseUrl: process.env.MOCK_URL ?? 'http://127.0.0.1:4123',
							apiKey: process.env.MOCK_API_KEY ?? '',
							models: [{name: 'mock-model-1', effort: 'medium'}],
						},
					],
				},
				null,
				2,
			)}\n`,
			'utf8',
		);
	}
}
// B16: a non-interactive stdin (piped/CI) resolves approvals automatically.
if (!process.stdin.isTTY) {
	process.env.NANOCODER_NONINTERACTIVE = '1';
}

const renderer = await createCliRenderer({
	externalOutputMode: 'passthrough',
	targetFps: 60,
	exitOnCtrlC: false,
	useMouse: true,
	// herdr's terminal (ghostty) does NOT support xterm's modifyOtherKeys
	// (DECRQM mode 27 answers `0` = unrecognized) — its native protocol is
	// the KITTY keyboard protocol. Enable it with ONLY the DISAMBIGUATE
	// flag: physical Shift+Enter then arrives as `ESC[13;2u` (distinct from
	// Enter) so multiline input works, while unmodified keys stay raw
	// (Backspace stays DEL 0x7f — the `isDeleteKey` control-char handling
	// is a defensive backstop for terminals that encode it as `ESC[8u`).
	useKittyKeyboard: {
		disambiguate: true,
		alternateKeys: false,
		events: false,
		allKeysAsEscapes: false,
		reportText: false,
	} as never,
	...(process.env.NANOCODER_KEYLOG
		? {
				// Log the RAW bytes BEFORE OpenTUI parses them, this shows
				// exactly what herdr delivers for a physical keypress.
				prependInputHandlers: [
					(sequence: string) => {
						logKey('RAW', sequence);
						return false; // do not consume, let normal parsing proceed
					},
				],
			}
		: {}),
});


// Preview mode: spawn the keyword mock provider and clean it up on exit.
if (PREVIEW_TUI) {
	const {spawn} = await import('node:child_process');
	const {join} = await import('node:path');
	const mockServer = join(
		import.meta.dir,
		'..',
		'..',
		'nanocoder',
		'tools',
		'mock-provider',
		'server.mjs',
	);
	// The mock server REQUIRES --rules/--log: with them missing, its
	// `argv[indexOf(flag) + 1]` fallback resolves to process.argv[0] (the
	// node binary path), and every request then tries to APPEND the request
	// log into the running node executable, writeFileSync throws ETXTBSY,
	// the request handler dies and every provider call hangs.
	const mockLog = '/tmp/bobonyo-mock-requests.jsonl';
	const mock = spawn(
		'node',
		[mockServer, '--port', '4123', '--log', mockLog],
		{
		stdio: 'ignore',
		},
	);
	process.on('exit', () => mock.kill());
}

renderer.once('destroy', () => {
	// Ensure the terminal leaves mouse-reporting mode and the alternate
	// screen cleanly, otherwise raw SGR mouse sequences leak into the shell
	// after exit (parity: nanocoder restores the terminal on quit).
	try {
		process.stdout.write(
			'\x1b[?27l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[?1049l',
		);
	} catch {
		// stdout may already be gone
	}
	// Defer the exit: the App's own `exit()` writes the goodbye screen AFTER
	// `renderer.destroy()` returns, a synchronous exit here would kill the
	// process before the goodbye ever reaches stdout.
	setTimeout(() => {
		// DRAIN TERMINAL RESPONSES BEFORE HANDSHAKING BACK TO THE SHELL.
		// OpenTUI's startup capability probes (OSC 10/11 color queries, the
		// DSR cursor position, kitty `$p` mode + `?u` keyboard queries, and
		// the `+q4d73` DECRQSS) make the terminal answer through the PTY.
		// On a FAST exit (Ctrl+C right after boot) the app never reads those
		// answers, so they land in the shell's stdin as random garbage — the
		// herdr "10;rgb:…;1R1+r4D73=…" characters. Consume and discard
		// everything that arrives in a short window before exiting.
		if (!process.stdin.isTTY) {
			process.exit(0);
			return;
		}
		const discard = (): void => {
			// Responses are swallowed; they must never reach the shell.
		};
		process.stdin.on('data', discard);
		process.stdin.resume();
		const done = (): void => {
			process.stdin.removeListener('data', discard);
			process.stdin.pause();
			process.exit(0);
		};
		process.stdin.once('end', done);
		setTimeout(done, 400);
	}, 0);
});

// Log every PARSED key event (name/modifiers/sequence) so we can see whether
// OpenTUI recognized the physical key herdr delivered.
if (process.env.NANOCODER_KEYLOG) {
	renderer.keyInput.on(
		'keypress',
		(key: {
			name: string;
			sequence?: string;
			raw?: string;
			ctrl?: boolean;
			shift?: boolean;
			meta?: boolean;
		}) => {
			logKey('KEY', key);
		},
	);
}

// C13: copy drag selections to the clipboard on release (OSC 52), matching
// nanocoder's selection/copy lifecycle.
// C13: copy drag selections to the clipboard on release (OSC 52), matching
// nanocoder's selection/copy lifecycle. A plain CLICK produces a zero-size
// selection, so copying only fires for real drag selections.
let lastSelectionText = '';
renderer.on(
	'selection',
	(selection: {isDragging?: boolean; getSelectedText?: () => string}) => {
		if (!selection || selection.isDragging) return;
		try {
			const text = selection.getSelectedText?.() ?? '';
			if (text && text !== lastSelectionText) {
				lastSelectionText = text;
				renderer.copyToClipboardOSC52(text);
			}
		} catch {
			// clipboard is best-effort
		}
	},
);

try {
	await render(() => <App />, renderer);
} catch (error) {
	// TEMP: surface render errors to a file (the TUI console overlay hides them).
	const {writeFileSync} = await import('node:fs');
	writeFileSync(
		'/tmp/otui-error.txt',
		error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
	);
	renderer.destroy();
	process.exit(1);
}
