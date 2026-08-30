/**
 * Slash-command registry (parity: nanocoder commands.ts + lazy-registry).
 *
 * Parsing: `/name arg1 arg2` splits on whitespace (name = first token).
 * Command output goes ONLY to the transcript as display-only info rows,
 * never into the provider context, never persisted with the session.
 */

import {appendInfo} from './state';
import {loadCustomCommands, loadSkills} from './custom';
import {isPreviewTui} from './preview';
import {herdrAvailable} from './herdr';

export const BASE_COMMAND_NAMES = [
	'help',
	'exit',
	'quit',
	'clear',
	'compact',
	'goal',
	'loop',
	'fork',
	'resume',
	'retry',
	'rename',
	'sessions',
	'usage',
	'tool:open-prs',
	'status',
	'model',
	'effort',
	'providers',
	'mode',
	'settings',
	'setup-providers',
	'connect',
	'codex',
	'codex-reset',
	'mcp',
	'session',
	'checkpoint',
	'checkpoints',
	'restore',
	'tune',
	'prs',
	'commands',
	'tools',
	'skills',
	'tasks',
	'ps',
	'version',
	'credits',
	'doctor',
	'privacy',
	'statusline',
	'lsp',
	'innerdaemon',
	'schedule',
	'update',
	'undo',
	'export',
	'context-max',
	'setup-config',
	'setup-mcp',
] as const;

/** `/mock:<name>` preview scenarios, only registered in preview mode. */
export const MOCK_COMMAND_NAMES = [
	'mock:bash',
	'mock:md',
	'mock:mdlong',
	'mock:thoughtrun',
	'mock:tools',
	'mock:mixed',
	'mock:web',
	'mock:write',
	'mock:git',
	'mock:skill',
	'mock:bg',
	'mock:tasks',
	'mock:compact10',
	'mock:compact',
	'mock:diff',
	'mock:confirm',
	'mock:agents',
	'mock:subagents',
	'mock:error',
	'mock:401',
	'mock:403',
	'mock:404',
	'mock:ratelimit',
	'mock:runaway',
	'mock:stall',
	'mock:empty',
	'mock:midstream',
	'mock:malformed',
	'mock:reasoningonly',
	'mock:sequence',
	'mock:glob',
	'mock:lsdir',
	'mock:gitlog',
	'mock:editfile',
	'mock:xml',
	'mock:repeat',
	'mock:mcp',
	'mock:custom',
	'mock:leaktags',
	'mock:steering',
	'mock:innerdaemon',
	'mock:scenario',
	'mock:model',
	'mock:settings',
] as const;

/** All slash commands visible for the CURRENT mode (mocks only in preview). */
export function commandNames(): string[] {
	const commands = isPreviewTui()
		? [...BASE_COMMAND_NAMES, ...MOCK_COMMAND_NAMES]
		: [...BASE_COMMAND_NAMES];
	return herdrAvailable() ? [...commands, 'herdr:fork'] : commands;
}

/** One-line descriptions for the built-in slash commands (suggestions UI). */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
	help: 'Show this help',
	exit: 'Quit bobonyo',
	quit: 'Quit bobonyo',
	clear: 'Start a new conversation',
	compact: 'Compact the conversation',
	goal: 'Set or manage a long-running goal',
	loop: 'Create, list, or stop scheduled thread jobs',
	fork: 'Fork this conversation into a new session',
	'herdr:fork': 'Fork into a new Herdr pane',
	resume: 'Resume a session',
	retry: 'Retry the last turn',
	undo: 'Undo the last message',
	rename: 'Rename the current session',
	sessions: 'List sessions',
	usage: 'Show token usage',
	'tool:open-prs': 'Open the captured PRs in the browser',
	status: 'Show status details',
	model: 'Pick a model',
	effort: 'Reasoning effort (minimal/low/medium/high/default)',
	providers: 'List providers',
	mode: 'Switch approval mode',
	settings: 'Open settings',
	'setup-providers': 'Add or edit a provider',
	connect: 'Connect a provider (add or edit)',
	codex: 'Connect Codex (OpenAI) as a provider',
	mcp: 'MCP servers',
	session: 'Session details',
	checkpoint: 'Save a checkpoint',
	checkpoints: 'List checkpoints',
	restore: 'Restore a checkpoint',
	tune: 'Tool profile (full/minimal/nano/auto)',
	prs: 'Open captured PRs',
	commands: 'List commands',
	tools: 'List tools',
	skills: 'List skills',
	tasks: 'List tasks',
	version: 'Show version',
	credits: 'Credits',
	doctor: 'Diagnostics',
	privacy: 'Privacy patterns',
	statusline: 'Status line info',
	lsp: 'LSP diagnostics',
	innerdaemon: 'Steering info',
	schedule: 'Scheduled tasks',
	update: 'Update info',
	export: 'Export the session',
	'context-max': 'Context cap',
	'setup-config': 'Config dir',
	'setup-mcp': 'MCP wizard',
};

/**
 * GAP-21: `/mock:<name>` preview scenarios, each maps to the keyword the
 * mock provider serves, so the rewrite renders the real rows (parity with
 * `nanocoder preview tui`'s /mock: catalog).
 */
const MOCK_PROMPTS: Record<string, string> = {
	bash: 'run bash',
	md: 'md test',
	mdlong: 'md long',
	think: 'think',
	thoughtrun: 'thoughtrun',
	mixed: 'search and fetch',
	tools: 'tools',
	compact10: 'ten bash runs',
	compact: 'compact mix',
	web: 'web search',
	write: 'write file',
	git: 'git status tool',
	skill: 'skill tool',
	bg: 'background bash',
	agents: 'spawn an agent',
	subagents: 'spawn agents',
	tasks: 'make tasks',
	diff: 'make diff',
	error: 'trigger the 500',
	'401': 'trigger the 401',
	'403': 'trigger the 403',
	'404': 'model not found',
	ratelimit: 'rate limit',
	runaway: 'runaway',
	stall: 'stall',
	empty: 'empty',
	midstream: 'midstream',
	malformed: 'malformed tool',
	reasoningonly: 'reasoning only',
	sequence: 'sequence',
	glob: 'glob files',
	lsdir: 'list dir',
	gitlog: 'git log',
	editfile: 'edit file',
	xml: 'xml tool',
	repeat: 'repeat bash',
	mcp: 'mcp tool',
	custom: 'custom tool',
	leaktags: 'leak tags',
	steering: 'steer tool',
	innerdaemon: 'innerdaemon',
	confirm: 'confirm',
	scenario: 'scenario',
};

export interface CommandContext {
	exit: () => void;
	clear: () => void;
	compact: () => void;
	goal: (args: string) => void;
	loop: (args: string) => void;
	fork: () => void;
	herdrFork: (split: string) => void;
	retry: () => void;
	undo: () => void;
	resume: (ref?: string) => void;
	rename: (name: string) => void;
	usage: () => void;
	sessions: () => void;
	openPRs: () => void;
	status: () => void;
	model: (args: string) => void;
	/** `/effort <minimal|low|medium|high|default>` — reasoning effort for the
	 *  ACTIVE model (persisted per model; default clears the override). */
	setEffort: (args: string) => void;
	providers: () => void;
	/** A custom command matched by name (F4): run its body as a prompt. */
	custom: (name: string, args: string) => void;
	modeSwitch: (args: string) => void;
	settings: (args: string) => void;
	setupProviders: (args: string) => void;
	/** `/codex` — scaffold the Codex (OpenAI) provider with one API key. */
	connectCodex: () => void;
	/** Redeem one earned Codex reset credit. */
	codexReset: () => void;
	/** `/connect` — smooth provider connect flow (Codex or custom). */
	connectProvider: (args: string) => void;
	mcp: () => void;
	session: (args: string) => void;
	/** F3: save a checkpoint of the current session. */
	checkpoint: (name: string) => void;
	/** A4: list saved checkpoints. */
	checkpoints: () => void;
	/** A4: restore a named checkpoint. */
	restore: (name: string) => void;
	/** Show or switch the tool profile (full/minimal/nano/auto). */
	tune: (args: string) => void;
	/** F2 catalog breadth: display-only info commands. */
	help: () => void;
	/** GAP-21: run a preview-mock scenario through the REAL chat pipeline. */
	submitPrompt: (
		prompt: string,
		command?: {
			kind: 'command' | 'skill';
			name: string;
			original?: string;
			body: string;
		},
	) => void;
	commandsList: () => void;
	toolsList: () => void;
	skillsList: () => void;
	tasksList: () => void;
	/** `/ps` — open the background-jobs modal (running bash tasks, live). */
	ps: () => void;
	version: () => void;
	credits: () => void;
	doctor: () => void;
	privacy: () => void;
	statusline: () => void;
	lspInfo: () => void;
	innerdaemonInfo: () => void;
	scheduleInfo: () => void;
	updateInfo: () => void;
	exportSession: () => void;
	contextMax: () => void;
	setupConfigInfo: () => void;
	setupMcpInfo: () => void;
}

let customCommandsCache: ReturnType<typeof loadCustomCommands> | null = null;

export function customCommandNames(): string[] {
	customCommandsCache ??= loadCustomCommands();
	return customCommandsCache.map(command => command.name);
}

export function findCustomCommand(name: string) {
	customCommandsCache ??= loadCustomCommands();
	return customCommandsCache.find(
		command => command.name.toLowerCase() === name.toLowerCase(),
	);
}

export function parseCommandLine(input: string): {name: string; args: string} {
	const rest = input.trim().slice(1);
	const space = rest.search(/\s/);
	if (space === -1) return {name: rest, args: ''};
	return {name: rest.slice(0, space), args: rest.slice(space + 1).trim()};
}

/**
 * Route a slash command. Returns true when the input WAS a command (the
 * caller must not send it to the chat handler or persist it).
 */
export function runCommand(input: string, ctx: CommandContext): boolean {
	const {name, args} = parseCommandLine(input);
	// `/mock:<name>` → preview scenarios (parity with `nanocoder preview tui`).
	// Each maps to the keyword prompt the real mock provider serves, so the
	// rows render through the SAME components as live chat (AGENTS.md preview
	// principles, never a mock-only render path).
	if (name.startsWith('mock:')) {
		if (!isPreviewTui()) {
			appendInfo(
				`/mock:* scenarios are only available in preview mode, run \`bobonyo preview tui\`.`,
			);
			return true;
		}
		const mockName = name.slice(5);
		// GAP-19/20 surfaces aren't modal yet, route to the existing text
		// commands so the preview still shows the real output.
		if (mockName === 'model') {
			ctx.model('');
			return true;
		}
		if (mockName === 'settings') {
			ctx.settings('');
			return true;
		}
		const prompt = MOCK_PROMPTS[mockName];
		if (!prompt) {
			appendInfo(
				`Unknown mock '${mockName}'. Available: ${Object.keys(MOCK_PROMPTS).join(', ')}`,
			);
			return true;
		}
		ctx.submitPrompt(prompt);
		return true;
	}
	// `/skill:<name>` remains a compatibility alias for direct `/name` skills.
	if (name.startsWith('skill:')) {
		const skillName = name.slice(6);
		const skill = loadSkills().find(
			candidate => candidate.name.toLowerCase() === skillName.toLowerCase(),
		);
		if (skill) {
			ctx.submitPrompt(skill.body, {
				kind: 'skill',
				name: skill.name,
				original: `/${name}`,
				body: skill.body,
			});
			return true;
		}
		appendInfo(`Unknown skill '${skillName}'.`);
		return true;
	}
	switch (name) {
		case 'help':
			ctx.help();
			return true;
		case 'exit':
		case 'quit':
			ctx.exit();
			return true;
		case 'clear':
			ctx.clear();
			return true;
		case 'compact':
			ctx.compact();
			return true;
		case 'goal':
			ctx.goal(args);
			return true;
		case 'loop':
			ctx.loop(args);
			return true;
		case 'fork':
			ctx.fork();
			return true;
		case 'herdr:fork':
			if (!herdrAvailable()) {
				appendInfo('/herdr:fork is only available inside Herdr.');
				return true;
			}
			ctx.herdrFork(args || 'vertical');
			return true;
		case 'retry':
			ctx.retry();
			return true;
		case 'undo':
			ctx.undo();
			return true;
		case 'resume':
			ctx.resume(args || undefined);
			return true;
		case 'sessions':
			ctx.sessions();
			return true;
		case 'rename':
			ctx.rename(args);
			return true;
		case 'usage':
			ctx.usage();
			return true;
		case 'tool:open-prs':
			ctx.openPRs();
			return true;
		case 'status':
			ctx.status();
			return true;
		case 'model':
			ctx.model(args);
			return true;
		case 'effort':
			ctx.setEffort(args);
			return true;
		case 'providers':
			ctx.providers();
			return true;
		case 'mode':
			ctx.modeSwitch(args);
			return true;
		case 'settings':
			ctx.settings(args);
			return true;
		case 'setup-providers':
			ctx.setupProviders(args);
			return true;
		case 'connect':
			ctx.connectProvider(args);
			return true;
		case 'codex':
			ctx.connectCodex();
			return true;
		case 'codex-reset':
			ctx.codexReset();
			return true;
		case 'mcp':
			ctx.mcp();
			return true;
		case 'session':
			ctx.session(args);
			return true;
		case 'checkpoint':
			ctx.checkpoint(args);
			return true;
		case 'checkpoints':
			ctx.checkpoints();
			return true;
		case 'restore':
			ctx.restore(args);
			return true;
		case 'tune':
			ctx.tune(args);
			return true;
		case 'prs':
			ctx.openPRs();
			return true;
		case 'commands':
			ctx.commandsList();
			return true;
		case 'tools':
			ctx.toolsList();
			return true;
		case 'skills':
			ctx.skillsList();
			return true;
		case 'tasks':
			ctx.tasksList();
			return true;
		case 'ps':
			ctx.ps();
			return true;
		case 'version':
			ctx.version();
			return true;
		case 'credits':
			ctx.credits();
			return true;
		case 'doctor':
			ctx.doctor();
			return true;
		case 'privacy':
			ctx.privacy();
			return true;
		case 'statusline':
			ctx.statusline();
			return true;
		case 'lsp':
			ctx.lspInfo();
			return true;
		case 'innerdaemon':
			ctx.innerdaemonInfo();
			return true;
		case 'schedule':
			ctx.scheduleInfo();
			return true;
		case 'update':
			ctx.updateInfo();
			return true;
		case 'export':
			ctx.exportSession();
			return true;
		case 'context-max':
			ctx.contextMax();
			return true;
		case 'setup-config':
			ctx.setupConfigInfo();
			return true;
		case 'setup-mcp':
			ctx.setupMcpInfo();
			return true;
		default:
			// One slash namespace: built-ins, then custom commands, then skills.
			// `/skill:name` remains as a compatibility alias, but suggestions and
			// normal invocation use the cleaner `/name` form.
			if (findCustomCommand(name)) {
				ctx.custom(name, args);
				return true;
			}
			const skill = loadSkills().find(
				candidate => candidate.name.toLowerCase() === name.toLowerCase(),
			);
			if (skill) {
				ctx.submitPrompt(skill.body, {
					kind: 'skill',
					name: skill.name,
					original: `/${name}`,
					body: skill.body,
				});
				return true;
			}
			appendInfo(
				`Unknown command or skill: /${name}. Type /help for the list.`,
			);
			return true;
	}
}

export const HELP_TEXT = [
	'/help       , this list',
	'/clear     , new conversation (cancels in-flight runs)',
	'/compact   , checkpoint and compact context',
	'/goal <objective> [--tokens N] [--max-iterations N] [--completion-promise "TEXT"]',
	'/loop <spec>, schedule after-turn or timed continuation work',
	'/retry     , re-run the last prompt',
	'/resume [last|N|id], load a previous session',
	'/sessions  , list saved sessions',
	'/rename <name>, rename the current session',
	'/usage     , token accounting for this session',
	'/tool:open-prs, open captured PRs in the browser',
	'/status    , current session/model/context info',
	'/model     , show the active model',
	'/checkpoint [name], save the current session as a checkpoint',
	'/checkpoints, list saved checkpoints',
	'/restore <name>, restore a checkpoint',
	'/tune [profile], show or switch the tool profile',
	'/prs       , open captured PRs (alias for /tool:open-prs)',
	'/mock:<name>, preview scenarios (bash md thoughtrun tools mixed confirm agents …)',
	'/exit      , quit (Esc / Ctrl+C also quit)',
	'',
	'!<command> , run a shell command directly (Executed Bash)',
].join('\n');
