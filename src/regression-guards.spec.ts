import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * REGRESSION GUARDS (detection tests).
 *
 * These are deliberate SOURCE-SCAN assertions, not behavior tests: they
 * fail the suite if a future change reintroduces the exact failure modes we
 * already hit, so even a developer who doesn't know the history cannot
 * silently bring them back:
 *
 *  1. Live tool rows must render as PLAIN text cells. Rendering them through
 *     `<markdown>` re-parses the whole node per update → the "christmas
 *     lights" flicker. The only renderer allowed is `LiveToolRows`.
 *  2. Running rows must go through the shared `liveRowSegments` tokenizer so
 *     colors/spacing stay identical to the settled rows.
 *  3. Each live row must keep its leading BREAKLINE (the settled transcript
 *     has a blank row between blocks; without it live rows glue themselves
 *     to the user message and to each other).
 *  4. SETTLED tool/thought rows must render as PLAIN COMPONENTS
 *     (`SettledToolRow`), never markdown: the hover highlight is a per-row
 *     background inside the row (parity: settings rows), which is what makes
 *     hover stick and hit the right rows. The old overlay geometry and the
 *     old buffer-bg tint (`applyHoverBackground`) must not reappear.
 */

/** Read a source file with comments stripped (the guards check CODE only). */
const read = (rel: string): string =>
	readFileSync(join(import.meta.dir, rel), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

describe('regression guards (foolproof live rows + hover)', () => {
	test('LiveToolRows renders plain text cells, never markdown', () => {
		const src = read('./components/live-tool-rows.tsx');
		expect(src).not.toMatch(/<markdown|MarkdownRenderable/i);
		expect(src).toMatch(/<text/);
		// Chunk colors ride as SPANS inside ONE <text> per line, never as a
		// per-cell <text> (each <text> is a native TextBufferRenderable with
		// its own TextBuffer/TextBufferView/SyntaxStyle handle set — per-cell
		// texts exhaust OpenTUI's handle table on big sessions and /undo).
		expect(src).toMatch(/<span\s+style=\{\{/);
	});

	test('history renders running tool rows ONLY via LiveToolRows', () => {
		const src = read('./components/history.tsx');
		expect(src).toMatch(/<LiveToolRows rows=\{liveToolRows\(\)\} \/>/);
		// The live rows memo builds segments through the shared util.
		expect(src).toMatch(/liveRowSegments/);
	});

	test('every live tool row keeps the settled leading breakline', () => {
		const src = read('./components/live-tool-rows.tsx');
		expect(src).toMatch(/<box height=\{1\} \/>/);
	});

	test('the live streaming reply keeps the settled leading breakline', () => {
		const history = read('./components/history.tsx');
		// The settled reply renders a blank row before the response; the LIVE
		// reply must too, or the streaming text glues to the user message and
		// visibly shifts down by one row when it settles.
		const start = history.indexOf('<Show when={liveReplyText()}>');
		const section = history.slice(
			start,
			history.indexOf('</Show>', start),
		);
		expect(section).toMatch(/<box height=\{1\} \/>/);
		expect(section.indexOf('<box height={1} />')).toBeLessThan(
			section.indexOf('<box flexDirection="row">'),
		);
	});

	test('settled tool rows render as components; overlay/buffer-tint gone', () => {
		const history = read('./components/history.tsx');
		expect(history).toMatch(/<SettledToolRow/);
		expect(history).toMatch(/COMPONENT_ROW_LANGS/);
		// The old overlay geometry and the buffer-bg tint are gone.
		expect(history).not.toMatch(/hoverOverlay/);
		const highlight = read('./row-highlight.ts');
		expect(highlight).not.toMatch(/applyHoverBackground/);
		// The component itself is plain boxes/text — no markdown anywhere.
		const component = read('./components/settled-tool-row.tsx');
		expect(component).not.toMatch(/<markdown|MarkdownRenderable/i);
		// Same handle budget rule as the live rows: per-line <text> with
		// styled spans, never a per-cell <text>.
		expect(component).toMatch(/<span\s+style=\{\{/);
		// Hover must be a per-row BACKGROUND (settings-row parity), with the
		// header excluded by construction (the bg is only on body rows).
		expect(component).toMatch(/backgroundColor/);
	});

	test('the Worked-for completion line never auto-expires on a timer', () => {
		// The completion line persists during idle; it is cleared only when
		// a NEW turn starts or `/clear` runs. A timeout clearing it makes
		// the line vanish mid-idle — that exact regression is banned.
		const app = read('./app.tsx');
		expect(app).not.toMatch(/completionTimer/);
		expect(app).not.toMatch(
			/setCompletionMessage\(\s*['"]\s*['"]\s*\)\s*,\s*\d+\s*\)/,
		);
		// And it must be cleared at turn start + on /clear.
		expect(app).toMatch(/setCompletionMessage\(''\)/);
	});

	test('/status always reports the resolved AGENTS.md rules file', () => {
		const app = read('./app.tsx');
		expect(app).toMatch(/resolveRulesFile\(process\.cwd\(\)\)/);
		const rows = read('./status-rows.ts');
		expect(rows).toMatch(/'AGENTS\.md'/);
	});

	test('launcher keeps the USER cwd and applies the OpenTUI preload', () => {
		const build = read('../scripts/build.mjs');
		// Running `bobonyo` in another project must NOT cd into the repo
		// before exec: skills/AGENTS.md resolve against the user's cwd. A
		// subshell `cd … && pwd` to RESOLVE the repo dir is fine; changing
		// the launcher's own cwd (the old `cd` + `exec bun run src/…`) is not.
		expect(build).not.toMatch(
			/cd "\$\(dirname "\$0"\)\/\.\."\n\s*exec \/usr\/bin\/env bun run src\/index\.tsx/,
		);
		// The preload must be passed by ABSOLUTE PATH (-r): a bare module
		// specifier resolves against the user's node_modules and a missing
		// bunfig skips the preload — both crash the UI with "Orphan text".
		expect(build).toMatch(/bun run -r "\$PRELOAD"/);
		expect(build).toMatch(/@opentui\/solid\/scripts\/preload\.js/);
		// The dist launcher is STRICTLY the release entry: dev runs go
		// through the separate `bobonyo-dev` alias, never through dist.
		expect(build).not.toMatch(/--dev/);
	});

	test('trust/approval prompts never dereference a null signal', () => {
		const input = read('./components/input-box.tsx');
		expect(input).not.toMatch(/prompt\(\)!/);
		expect(input).not.toMatch(/approval\(\)!/);
	});

	test('the trust gate renders a DIALOG, never the free-text prompt', () => {
		const app = read('./app.tsx');
		expect(app).toMatch(/<TrustModal/);
		expect(app).toMatch(/pendingTrust/);
		// The trust question must not appear as a text prompt in the input.
		const input = read('./components/input-box.tsx');
		expect(input).not.toMatch(/Trust this directory/);
		// The codex-style dialog lives in its own component.
		const modal = read('./components/trust-modal.tsx');
		expect(modal).toMatch(/Trust this directory/);
		expect(modal).toMatch(/Yes, trust this directory/);
		expect(modal).toMatch(/No, do not trust/);
	});

	test('the /model modal opens on the CURRENT model row', () => {
		const modal = read('./components/model-modal.tsx');
		// The initial row index must come from the pure helper (current
		// model first, then first navigable row) — never a hardcoded 0,
		// which lands on the provider header and shows no highlight.
		expect(modal).toMatch(/initialCursor\(\)/);
		expect(modal).toMatch(/cells\.findIndex\(cell => cell\.isCurrent\)/);
		expect(modal).not.toMatch(/\[cursor, setCursor\] = createSignal\(0\)/);
		// Effort is folded INTO the grid cells (the OpenTUI reconciler's
		// <For> only re-renders when the `each` array changes — reading the
		// override inside the child never repaints the [effort] badge).
		expect(modal).toMatch(/shownEffort: effectiveEffort/);
		// The query re-snap must track ONLY the query: an unfenced effect
		// re-runs on every E press and snaps the cursor back to current.
		expect(modal).toMatch(/createEffect\(on\(query,/);
		// Query changes re-snap through the same helper.
		expect(modal).toMatch(/createEffect/);
	});

	test('the model modal keeps the context-length column in the grid', () => {
		const modal = read('./components/model-modal.tsx');
		// The grid cells must carry the size (modelContextWindows ??
		// contextWindow) and render it dim — a regression to name-only cells
		// silently drops the context length users rely on.
		expect(modal).toMatch(/contextSize: \(\(\) =>/);
		expect(modal).toMatch(/formatContextLength\(window\)/);
		expect(modal).toMatch(/cell\.contextSize/);
	});

	test('the model modal reserves the WRAPPED footer height', () => {
		const modal = read('./components/model-modal.tsx');
		// The long footer hint wraps to 2 lines on narrow cards; the card
		// must reserve the real wrapped height or the hint renders outside.
		expect(modal).toMatch(/const footerLines = \(\): number =>/);
		expect(modal).toMatch(/wrapText\(footerHint, cardWidth\(\) - 6\)/);
		expect(modal).toMatch(/capped \+ 10 \+ footerLines\(\)/);
	});

	test('the model modal asks for effort after selecting a model (opencode parity)', () => {
		const modal = read('./components/model-modal.tsx');
		expect(modal).toMatch(/Select effort/);
		expect(modal).toMatch(/setEffortStep\(/);
		expect(modal).toMatch(/EFFORT_OPTIONS/);
		expect(modal).toMatch(/Default \(\$\{catalog\}\)/);
	});

	test('/effort routes and persists per-model overrides', () => {
		const commands = read('./commands.ts');
		expect(commands).toMatch(/case 'effort':\n\s*ctx\.setEffort\(args\)/);
		const app = read('./app.tsx');
		expect(app).toMatch(/const switchEffort = \(args: string\) =>/);
		expect(app).toMatch(/EFFORT_LEVELS\.includes/);
		expect(read('./config.ts')).toMatch(/modelEfforts\?: Record<string, string>/);
	});

	test('bare /effort opens the effort picker modal (never the input row)', () => {
		const app = read('./app.tsx');
		// No args must open the modal; a modal signal, not setPendingPrompt.
		expect(app).toMatch(/if \(!level\) \{\n\s*setEffortOpen\(true\)/);
		expect(app).toMatch(/<EffortModal/);
		expect(app).toMatch(/onSelect=\{level => \{\n\s*applyEffort\(level\)/);
		expect(read('./components/input-box.tsx')).toMatch(
			/connectOpen\(\) \|\|\n\s*effortOpen\(\)/,
		);
		// Effort picker owns every key while open.
		expect(app).toMatch(/connectOpen\(\) \|\|\n\s*effortOpen\(\)/);
	});

	test('DeepSeek fetchers use the RESOLVED key (env: never sent raw)', () => {
		const deepseek = read('./deepseek.ts');
		expect(deepseek).toMatch(
			/provider\.apiKeyResolved \?\? provider\.apiKey \?\? ''/,
		);
	});

	test('model catalogs are cached on disk with a stale fallback', () => {
		// The generic /models fetch must persist to disk (no refetch per
		// startup) and keep the last known catalog when the token fails —
		// otherwise the model list collapses to seeds on a 401.
		const config = read('./config.ts');
		expect(config).toMatch(/MODEL_CATALOG_TTL_MS/);
		expect(config).toMatch(/modelCatalogCachePath\(\)/);
		expect(config).toMatch(/saveModelCatalogCache\(disk\.entries\)/);
		expect(config).toMatch(/const stale = disk\.entries\[discoveryUrl\]/);
		// DeepSeek/MiMo fetchers fall back to the stale DISK catalog too.
		const deepseek = read('./deepseek.ts');
		expect(deepseek).toMatch(
			/staleCachedModels\(loadDeepSeekCache\(\), key\)/,
		);
	});

	test('project .nanocoder folders auto-migrate to .bobonyo', () => {
		const paths = read('./bobonyo-paths.ts');
		expect(paths).toMatch(/export function migrateProjectDir/);
		expect(paths).toMatch(/cpSync\(source, target, \{recursive: true\}\)/);
		expect(paths).toMatch(/\.bobonyo/);
		// The migration runs wherever project dirs resolve (config/custom/
		// subagents), so Hilinga-style project agents/commands/skills move.
		expect(read('./config.ts')).toMatch(/migrateProjectDir\(/);
		expect(read('./custom.ts')).toMatch(/migrateProjectDir\(process\.cwd\(\)\)/);
		expect(read('./subagents.ts')).toMatch(/migrateProjectDir\(process\.cwd\(\)\)/);
	});

	test('the DeepSeek preset seeds the CURRENT v4 catalog', () => {
		const modal = read('./components/connect-provider-modal.tsx');
		expect(modal).toMatch(
			/DEEPSEEK_MODELS = \['deepseek-v4-flash', 'deepseek-v4-pro'\]/,
		);
		expect(modal).not.toMatch(/deepseek-chat/);
	});

	test('codex ACCOUNT models match the ChatGPT backend, with live discovery', () => {
		const modal = read('./components/connect-provider-modal.tsx');
		// The account backend rejects the API-key gpt-5.5-codex family (400).
		expect(modal).toMatch(/CODEX_ACCOUNT_MODELS = \[/);
		expect(modal).toMatch(/models: CODEX_ACCOUNT_MODELS,/);
		expect(modal).toMatch(/'gpt-5\.5'/);
		// The catalog endpoint needs the login token + account id.
		const config = read('./config.ts');
		expect(config).toMatch(/export async function discoverCodexAccountModels/);
		expect(config).toMatch(/chatgpt-account-id/);
		// The catalog request's client_version tracks the INSTALLED codex CLI
		// (cached), so the backend never gates models on a stale hardcoded
		// version — new models (e.g. gpt-5.6-sol on a paid plan) appear once
		// the account can serve them.
		expect(config).toMatch(/codexClientVersion\(\)/);
		expect(config).toMatch(/execFileSync\('codex', \['--version'\]/);
		const app = read('./app.tsx');
		expect(app).toMatch(
			/provider\.codexAccount\n\s*\? discoverCodexAccountModels/,
		);
	});

	test('the provider modal auto-widens and tiles on big screens', () => {
		const modal = read('./components/connect-provider-modal.tsx');
		expect(modal).toMatch(/Math\.min\(120, Math\.max\(60, dims\(\)\.width - 4\)\)/);
		expect(modal).toMatch(/providerColumns\(cardWidth\(\)\)/);
		expect(modal).toMatch(/visibleGridRows\(\)/);
		// Height autofits EVERY step (fit-content): each view computes its own
		// content lines and the card is exactly that, capped by the window.
		expect(modal).toMatch(/const viewContentLines = \(\): number =>/);
		expect(modal).toMatch(/case 'pick':/);
		expect(modal).toMatch(/case 'manage':/);
		// The footer hint reserves its REAL wrapped height (narrow cards
		// wrap it; a 1-line estimate left it below the card edge).
		expect(modal).toMatch(/viewContentLines\(\) \+ 7 \+ footerLines\(\)/);
		expect(modal).toMatch(/const footerLines = \(\): number =>/);
	});

	test('connected providers offer a MANAGE step to edit existing instances', () => {
		const modal = read('./components/connect-provider-modal.tsx');
		expect(modal).toMatch(/presetConnections\(row\.preset\)\.length > 0/);
		expect(modal).toMatch(/<ManageList/);
		expect(modal).toMatch(/setEditTargetId\(selected\.id\)/);
		// Editing preserves the wire fields (responses/anthropic, codexAccount…).
		expect(modal).toMatch(/editProvider\.sdkProvider/);
		expect(modal).toMatch(/editProvider\.codexAccount/);
	});

	test('modal input placeholders use the blinking caret (input-box parity)', () => {
		const modal = read('./components/connect-provider-modal.tsx');
		expect(modal).toMatch(/spinnerFrame\(\) >> 2\) % 2 === 0/);
		expect(modal).toMatch(/activeRow\(\)\.bg/);
		// The caret sits at the START of an empty field (rendered BEFORE the
		// placeholder), at the END once the user types.
		expect(modal).toMatch(/when=\{!filled\}/);
		expect(modal).toMatch(/const caretChar = filled/);
		expect(modal).toMatch(/shown\[shown\.length - 1\]!/);
		// The hint lives INSIDE the field, never below the input.
		expect(modal).not.toMatch(/props\.description/);
	});

	test('/provider is removed (redundant with /connect)', () => {
		const commands = read('./commands.ts');
		expect(commands).not.toMatch(/case 'provider':/);
		expect(commands).not.toMatch(/providerSwitch/);
		const app = read('./app.tsx');
		expect(app).not.toMatch(/const switchProvider/);
	});

	test('settings: Providers tab removed, Connect provider row added', () => {
		const panel = read('./components/settings-panel.tsx');
		expect(panel).not.toMatch(/'Providers',/);
		expect(panel).toMatch(/key: 'connectProvider'/);
		const app = read('./app.tsx');
		expect(app).toMatch(/case 'connectProvider':/);
	});

	test('system prompt is a settings-selectable STYLE (custom = SYSTEM.md)', () => {
		const panel = read('./components/settings-panel.tsx');
		expect(panel).toMatch(/systemPrompt: \[\.\.\.SYSTEM_PROMPT_STYLES\]/);
		expect(panel).toMatch(/key: 'systemPrompt'/);
		const client = read('./client.ts');
		expect(client).toMatch(/resolveSystemPrompt\(style, defaultBase\)/);
		const app = read('./app.tsx');
		expect(app).toMatch(/case 'systemPrompt':/);
		expect(app).toMatch(/seedCustomSystemPrompt\(buildSystemPrompt\(\)\)/);
		expect(read('./system-prompt.ts')).toMatch(
			/export function seedCustomSystemPrompt/,
		);
	});

	test('resume search covers the session id', () => {
		const modal = read('./components/resume-modal.tsx');
		// The filter must go through the pure helper that matches the id,
		// the name AND the last prompt — not just name/prompt inline.
		expect(modal).toMatch(/sessionMatchesQuery\(session, q\)/);
		const spec = read('../src/resume-modal.spec.ts');
		expect(spec).toMatch(/matches by SESSION ID/);
	});

	test('resume heals tail-lag only and restores the session cwd (cache parity)', () => {
		// Rebuilding the provider context on every resume sent a bigger,
		// byte-different head and busted the prefix cache; the heal must
		// only fire on genuine tail lag and stay within the live message
		// budget. Resuming from a different directory changed the system
		// prompt's cwd line — the whole head missed. Both are guarded so
		// continued conversations keep their provider cache.
		const session = read('./session.ts');
		expect(session).toMatch(/contextCoversTranscriptTail/);
		expect(session).not.toMatch(/contextUsers >= transcriptUsers/);
		const app = read('./app.tsx');
		expect(app).toMatch(/process\.chdir\(resumed\.cwd!?\)/);
	});

	test('the current date rides the user-message tail, never the cached head', () => {
		// codex delivers the time as a persisted per-turn fragment; ours
		// used to sit in the system prompt, so a day change or next-day
		// resume busted the ENTIRE prefix cache. The date must stay out of
		// the system head and ride the provider user message instead.
		const client = read('./client.ts');
		expect(client).not.toMatch(/Current Date/);
		expect(client).toMatch(/export function currentDateFragment/);
		const app = read('./app.tsx');
		expect(app).toMatch(/datedUserMsg/);
	});

	test('resume cwd mode is configurable (codex ResumeCwdMode parity)', () => {
		// The session directory restore must respect a user setting (session
		// / current / ask) instead of always silently switching, and the
		// `ask` mode must route through the pending prompt so the choice is
		// visible and cancellable.
		const settings = read('./settings.ts');
		expect(settings).toMatch(/export function resumeCwdDecision/);
		const app = read('./app.tsx');
		expect(app).toMatch(/resumeCwdDecision\(/);
		expect(app).toMatch(/setPendingPrompt\(\{/);
		expect(app).toMatch(/case 'resumeCwd'/);
	});

	test('the DeepSeek status line surfaces the live cache rate, not just balance', () => {
		// The balance refreshes every 5 minutes, so a long task looks free
		// until it is not. The per-turn usage block reports cache hit/miss
		// tokens; the ledger must accumulate them and the status line must
		// render the cumulative rate (`100K/1.5M (10% miss)`) every turn.
		const usage = read('./provider-usage.ts');
		expect(usage).toMatch(/export function formatCacheRate/);
		expect(usage).toMatch(/export function extractCacheTokens/);
		expect(usage).toMatch(/cacheHitTokens:/);
		expect(usage).toMatch(/cacheMissTokens:/);
		const status = read('./components/status.tsx');
		expect(status).toMatch(/formatCacheRate\(providerUsage\(\)\)/);
		expect(status).toMatch(/· cache/);
		// Provider-agnostic: the cache rate must render for ANY provider that
		// reports cache fields, never gated on DeepSeek.
		expect(status).not.toMatch(/isDeepSeek\(activeEndpoint\(\)\) && formatCacheRate/);
	});

	test('long conversations COMPACT before the message cap trims the head', () => {
		// Once a conversation exceeds the message cap, capMessages trims the
		// OLDEST message — byte 0 changes, so every subsequent request misses
		// the provider's entire prefix cache (the 14M-token / 55% session).
		// Auto-compact must trigger on the MESSAGE cap (not just the token
		// threshold, which a 1M-window provider never crosses at ~300K) and
		// after tool-heavy turns, so the head change stays a one-time
		// summary instead of a per-turn miss.
		const app = read('./app.tsx');
		expect(app).toMatch(/shouldAutoCompact/);
		expect(app).toMatch(/context\(\)\.length >= maxMessages\(\) - AUTO_COMPACT_MESSAGE_MARGIN/);
		expect(app).toMatch(/if \(shouldAutoCompact\(\)\) triggerAutoCompact\(\)/);
		const settings = read('./settings.ts');
		expect(settings).toMatch(/autoCompact: \{enabled: true, threshold: 75\}/);
	});

	test('the monitor tool is removed (background completion reports instead)', () => {
		// Background bash tasks already append a completion row when they
		// exit, so the model-facing monitor polling tool is redundant (the
		// future realtime background-task modal replaces it for the user).
		const tools = read('./tools.ts');
		expect(tools).not.toMatch(/registerTool\('monitor'/);
		expect(tools).not.toMatch(/'monitor',/);
		const app = read('./app.tsx');
		expect(app).not.toMatch(/allMonitor/);
	});

	test('Ctrl+Left/Right jump WORD-WISE in the input (original parity)', () => {
		const input = read('./components/input-box.tsx');
		// The arrow handler branches on ctrl and goes through the word-jump
		// helpers — a regression would fall back to plain char movement.
		expect(input).toMatch(/event\.ctrl\) moveCursorPrevWord\(\)/);
		expect(input).toMatch(/event\.ctrl\) moveCursorNextWord\(\)/);
		expect(input).toMatch(/moveToPrevWord/);
		expect(input).toMatch(/moveToNextWord/);
	});

	test('thought gears are never success-green; body wraps inside └', () => {
		const row = read('./components/settled-tool-row.tsx');
		// The row glyph color must go through the thought-aware helper (a
		// regression to bare glyphColor would turn the settled ⚙ green).
		expect(row).toMatch(/settledGlyphColor/);
		expect(row).not.toMatch(/glyphColor\(props\.status/);
		const history = read('./components/history.tsx');
		// Settled + live thought bodies wrap through the tool-style helper
		// (`  └   ` lead, 6-space continuations) so text never escapes.
		expect(history).toMatch(/wrapThoughtBody/);
		expect(history).toMatch(/THOUGHT_BODY_LEAD/);
		expect(history).toMatch(/THOUGHT_BODY_CONT/);
		expect(history).not.toMatch(/tailLines/);
		// The LIVE thinking header must ANIMATE: gear + dots BEFORE the
		// timer. A regression to the old static `⚙ Thinking · (Ns)...` (dots
		// AFTER the timer, static gear) fails this.
		expect(history).toMatch(/liveThinkingHeader\(spinnerFrame\(\), thinkingElapsed\(\)\)/);
		expect(history).not.toMatch(/Thinking · \(\$\{formatElapsed/);
	});

	test('thinking timer measures the THINKING phase, not the turn', () => {
		const app = read('./app.tsx');
		// The timer anchors when reasoning first streams (never at message
		// send) and the settled Thought duration uses the same anchor.
		expect(app).toMatch(/thinkingStartedAt = Date\.now\(\)/);
		expect(app).toMatch(/setThinkingElapsed/);
		expect(app).toMatch(/thinkingSeconds\(/);
		const state = read('./state.ts');
		expect(state).toMatch(/export function thinkingSeconds/);
	});

	test('DeepSeek/MiMo features load on provider switch, not just /status', () => {
		const app = read('./app.tsx');
		// Switching the active provider/model must trigger the provider-
		// specific loads immediately: DeepSeek balance (statusline `Cred:`)
		// and the MiMo monthly usage ledger (`used N.NM`).
		expect(app).toMatch(/const loadProviderFeatures/);
		expect(app).toMatch(/refreshDeepSeekBalance\(provider\)/);
		expect(app).toMatch(/currentMonthUsage\(provider\.baseUrl\)/);
		// Every switch path must call it: modal select, resume, and /model
		// (endpoint arg). /provider was removed (redundant with /connect).
		const providerCalls = app.match(/loadProviderFeatures\(provider\)/g) ?? [];
		const endpointCalls = app.match(/loadProviderFeatures\(endpoint\);/g) ?? [];
		expect(providerCalls.length).toBeGreaterThanOrEqual(2);
		expect(endpointCalls.length).toBe(1);
		// The statusline Cred segment is provider-scoped like the MiMo used
		// segment (a stale balance must not linger on other providers).
		const status = read('./components/status.tsx');
		expect(status).toMatch(/isDeepSeek\(activeEndpoint\(\)\) && deepSeekBalance\(\)/);
	});

	test('input sits below the banner and slides down like a terminal prompt', () => {
		const app = read('./app.tsx');
		const history = read('./components/history.tsx');
		// The history height is min(MEASURED content, terminal cap): on an
		// empty conversation the banner is short so the input rides directly
		// below it, then slides down as rows are added, and sticks at the
		// bottom once the content fills the cap.
		expect(app).toMatch(/Math\.min\(\s*historyContentHeight\(\)/);
		expect(app).toMatch(/onContentHeight=\{setHistoryContentHeight\}/);
		expect(history).toMatch(/onContentHeight/);
		expect(history).toMatch(/getChildren\(\)/);
		// flexGrow on the scrollbox would stretch it and pin the input at
		// the bottom again — the terminal-like placement depends on it NOT
		// growing.
		expect(history).toMatch(/flexGrow=\{0\}/);
		// The spacer keeps the status line pinned at the bottom while the
		// conversation is short.
		expect(app).toMatch(/<box flexGrow=\{1\} \/>/);
	});

	test('startup gate keeps the typed message (Enter never silently eats it)', () => {
		const app = read('./app.tsx');
		// The cache-head gate must NOT clear the input: a message typed right
		// after `--resume` while tools are still loading would vanish and
		// look exactly like "Enter doesn't work".
		const gate = app.slice(
			app.indexOf('!startupReadyRef'),
			app.indexOf('return;', app.indexOf('!startupReadyRef')),
		);
		expect(gate).toMatch(/Still loading tools/);
		expect(gate).not.toMatch(/setInput\(/);
	});

	test('the resume notice breakline is counted in the layout cap', () => {
		const app = read('./app.tsx');
		// The success notice renders TWO rows above the input (breakline +
		// message); the history cap must subtract both or the status line
		// overlaps the input box while the notice is visible.
		expect(app).toMatch(
			/completionMessageRows\(\s*completionMessage\(\),\s*completionTone\(\),\s*\)/,
		);
		const input = read('./components/input-box.tsx');
		expect(input).toMatch(/tone === 'success' \? 2 : 1/);
	});

	test('content-height measurement never crashes mid-resume', () => {
		const history = read('./components/history.tsx');
		expect(history).toMatch(/const measureContentHeight[\s\S]*?try \{/);
	});

	test('resume modal isolates its keys like the other modals', () => {
		const resume = read('./components/resume-modal.tsx');
		expect(resume).toMatch(
			/useKeyboard\(event => \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
	});

	test('/undo is wired and truncates at the last user message', () => {
		const app = read('./app.tsx');
		const commands = read('./commands.ts');
		expect(commands).toMatch(/'undo',/);
		expect(commands).toMatch(/undo: 'Undo the last message'/);
		expect(app).toMatch(/undo: undoLast/);
		expect(app).toMatch(/export function undoExchange/);
		// The provider context must be a TRUNCATION, never a reorder/inline
		// mutation — otherwise the cache head changes and every later turn
		// misses the prompt cache.
		expect(app).toMatch(/keptContext = healResumedContext/);
		// The "Undid the last message." notice uses the SUCCESS completion
		// slot (green, leading breakline, auto-expires), never a permanent
		// transcript row. The message may carry a restored-files suffix.
		expect(app).toMatch(/setCompletionTone\('success'\)/);
		expect(app).toMatch(/setCompletionMessage\(/);
		expect(app).toMatch(/Undid the last message\./);
		expect(app).not.toMatch(/appendInfo\('Undid the last message\.'\)/);
		// /undo file parity (openclaude rewind): the handler restores the
		// files the undone exchange mutated, and every REAL LLM turn starts a
		// new file-undo exchange (slash commands must not — they would push a
		// dummy entry that swallows the previous exchange's file undo).
		expect(app).toMatch(/undoFileExchange\(\)/);
		expect(app).toMatch(/beginFileUndoExchange\(value\)/);
	});

	test('typed keys are claimed so the history scrollbox never scrolls', () => {
		// OpenTUI dispatches GLOBAL key listeners (the InputBox) before
		// RENDERABLE handlers (the history ScrollBox's native ScrollBar,
		// which maps `k`/`j`/`h`/`l` to scroll). Every key the input box
		// consumes must call preventDefault() or typing `k` scrolls the chat
		// history behind the prompt.
		const input = read('./components/input-box.tsx');
		// Character insertion (the path `k`/`j`/`h`/`l`/any letter takes):
		// preventDefault must sit between the guarded branch and the insert.
		expect(input).toMatch(
			/if \(char && !event\.ctrl && !event\.meta\) \{[\s\S]{0,120}event\.preventDefault\(\);[\s\S]{0,80}insertAtCursor\(char\);/,
		);
		// Space, backspace/delete, navigation, Tab and Return are claimed too.
		expect(input).toMatch(
			/if \(event\.name === 'space'\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
		expect(input).toMatch(
			/if \(isDeleteKey\(event\.name\)\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
		expect(input).toMatch(
			/if \(isSubmitKey\(event\)\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
		expect(input).toMatch(
			/if \(event\.name === 'tab'\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
		expect(input).toMatch(
			/if \(event\.name === 'left'\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
		expect(input).toMatch(
			/if \(event\.name === 'right'\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
		// Popup escape branches claim the key too: without preventDefault the
		// App's global Esc handler would ALSO see it and arm the exit
		// confirmation while the popup is open.
		expect(input).toMatch(
			/if \(event\.name === 'escape'\) \{[\s\S]{0,120}event\.preventDefault\(\);[\s\S]{0,80}setInputAt\(input\(\)\.replace\(\/@\[\^\\s\]\*\$\/, ''\)\);/,
		);
		expect(input).toMatch(
			/if \(event\.name === 'escape'\) \{[\s\S]{0,120}event\.preventDefault\(\);[\s\S]{0,80}setInputAt\(''\);/,
		);
	});

	test('settled blocks keep STABLE identity across memo recomputes', () => {
		// Solid's <For> re-renders every child whose item reference changed
		// (mapArray reference equality). If the settled-blocks memo returns
		// fresh block objects on every recompute, the WHOLE transcript
		// repaints whenever messages() changes (e.g. every bash row that
		// settles) — the post-bash blink. The memo must reuse unchanged
		// blocks by reference via a content-keyed cache.
		const history = read('./components/history.tsx');
		expect(history).toMatch(/stableSettledBlocks\(settledBlockCache, blocks\)/);
		const cache = read('./settled-block-cache.ts');
		expect(cache).toMatch(/export function stableSettledBlocks/);
		expect(cache).toMatch(/const cached = cache\.get\(key\)/);
		// The cache key must cover EVERYTHING the block renders (content,
		// status/glyph and the tokenized segments) so a theme or width
		// change still rebuilds the block instead of showing stale colors.
		expect(cache).toMatch(/JSON\.stringify\(block\.segments\)/);
		expect(cache).toMatch(/block\.part\.text/);
	});

	test('bash calls render STANDALONE, never compacted into a ×N tally', () => {
		// `✦ Ran Bash ×2` hides the actual commands — the command line IS the
		// useful content. Every bash call must keep its own `✦ Bash(cmd)`
		// row (same rule as file-write tools and agents).
		const history = read('./components/history.tsx');
		const groupToolRun = history.slice(
			history.indexOf('function groupToolRun'),
			history.indexOf('function groupToolRun') + 1400,
		);
		expect(groupToolRun).toMatch(/name === 'execute_bash'/);
		expect(groupToolRun).toMatch(/name === 'execute_bash:user'/);
		expect(groupToolRun).toMatch(/blocks\.push\(\[message\]\);/);
	});

	test('bash command/body wrap to the REAL render width, never a fixed 72', () => {
		// A hardcoded wrap width diverges from the render width on wide
		// terminals: the bash header breaks mid-path even though it fits,
		// and the pre-wrapped line count differs from the rendered rows —
		// which shifts blockRanges and breaks hover/click hit-targets.
		const display = read('./tool-display.ts');
		// The command wrap is derived from the caller-provided width.
		expect(display).toMatch(/width - COMMAND_PROMPT_WIDTH/);
		expect(display).toMatch(/width - BOX_EDGE_WIDTH/);
		expect(display).not.toMatch(/COMMAND_WRAP_WIDTH/);
		const history = read('./components/history.tsx');
		// Settled rows thread the real width through the tool formatter.
		expect(history).toMatch(/renderToolRun\(run, fillWidth\)/);
		expect(history).toMatch(/singleToolRow\(block\[0\]!, key, width\)/);
		// The LIVE path passes the same render width.
		expect(history).toMatch(/historyFillWidth\(terminalDimensions\(\)\.width \?\? 80\),/);
	});

	test('bash entries render as ONE native bordered box (component, not text)', () => {
		// The bash execution is a single bordered entry: the `✦` glyph sits
		// OUTSIDE the box, and OpenTUI draws the border (so wrapped lines
		// always stay inside — a hand-drawn text border misaligns). The
		// same box is used for LIVE streaming and SETTLED rows.
		const row = read('./components/bash-tool-row.tsx');
		expect(row).toMatch(/export function BashToolRow/);
		expect(row).toMatch(/borderStyle="rounded"/);
		// Glyph outside the border: the glyph <text> is a SIBLING of the
		// bordered <box>, never inside it.
		expect(row).toMatch(/<text fg=\{glyph\}/);
		expect(row).toMatch(/border\s*$/m);
		// The `$` prompt is part of the header chunks (never duplicated).
		const history = read('./components/history.tsx');
		expect(history).toMatch(/isBashBlock\(block\)/);
		expect(history).toMatch(/<BashToolRow/);
		const live = read('./components/live-tool-rows.tsx');
		expect(live).toMatch(/row\.lang === 'bashrow'/);
		expect(live).toMatch(/<BashToolRow/);
	});

	test('hover/click hit-testing uses the ACTUAL rendered height (brief-safe)', () => {
		// The pre-tool brief and the bash box borders render rows that are
		// NOT in docLines; the computed `rows` undercounts them, which
		// shifted blockRanges and broke hover/click below every briefed
		// entry (visible on resume). rowForEvent must read the laid-out ref
		// height and clamp into the block's doc-line span.
		const history = read('./components/history.tsx');
		expect(history).toMatch(/export function hitTestBlock/);
		expect(history).toMatch(/entry\.ref\.height \?\? entry\.rows/);
		expect(history).toMatch(/entry\.start \+ Math\.max\(0, entry\.rows - 1\)/);
	});

	test('settled block refs survive memo recomputes (resume hover parity)', () => {
		// stableSettledBlocks reuses UNCHANGED block objects, so Solid's For
		// keeps their elements WITHOUT re-firing the ref callback. Resetting
		// every blockRefs entry to null on recompute silently dropped hover/
		// click from every kept block — on resume only the last (newly
		// created) block stayed interactive. The memo must carry the
		// previous ref over by block identity, not reset it.
		const history = read('./components/history.tsx');
		expect(history).toMatch(/prevRefsByBlock/);
		expect(history).toMatch(/prevRefsByBlock\.set\(entry\.block, entry\.ref\)/);
		expect(history).toMatch(/prevRefsByBlock\.get\(stableBlocks\[groupIndex\]!\) \?\? null/);
	});

	test('tool loop is uncapped; runaway protection stays guard-based', () => {
		// opencode / openclaude / codex don't limit per-turn tool calls,
		// and a round cap killed long-running tasks. The loop must not
		// iterate against a round ceiling; the REAL runaway protection is
		// the repeated-tool-signature guard (plus empty-turn / malformed
		// retries), and a future dev must not reintroduce a silent cap.
		const app = read('./app.tsx');
		expect(app).toMatch(/for \(let round = 0; ; round\+\+\)/);
		expect(app).not.toMatch(/round < MAX_TURN_ROUNDS/);
		expect(app).not.toMatch(/MAX_TURN_ROUNDS/);
		expect(app).toMatch(/MAX_REPEATED_TOOL_CALLS/);
	});

	test('tool rows hold their RUNNING state for a visible floor (MCP parity)', () => {
		// A fast MCP stdio round trip (~1ms) settles before OpenTUI paints
		// its next frame (~16ms), so the row would appear already green
		// with output — the grey running glyph is never seen. The settle
		// path must await the remaining floor before flipping running:false
		// (parity: the startup loader's MIN_LOAD_MS floor).
		const app = read('./app.tsx');
		expect(app).toMatch(/MIN_TOOL_RUNNING_MS = 400/);
		expect(app).toMatch(
			/toolRunningRemainingMs\(\s*callStartedAt,\s*executedAt,?\s*\)/,
		);
		expect(app).toMatch(
			/await new Promise\(resolve =>\s*setTimeout\(resolve, runningRemaining\),?\s*\)/,
		);
	});

	test('the model brief before a tool call is rendered, never dropped', () => {
		// claude code / openclaude render the model's "I'll check X"
		// narration BEFORE the tool box, INTEGRATED with the tool entry.
		// The brief attaches to the FIRST tool message of the batch (once,
		// never repeated per concurrent call) and renders above the bash
		// box — not as a separate assistant message.
		const app = read('./app.tsx');
		const toolTurn = app.slice(
			app.indexOf('const briefText = result.text.trim()'),
			app.indexOf('const assistantToolMsg: ChatMessageLike'),
		);
		expect(toolTurn).toMatch(/result\.text\.trim\(\)/);
		expect(toolTurn).toMatch(/callIndex === 0[\s\S]{0,40}\? briefText[\s\S]{0,30}: ' '/);
		expect(toolTurn).toMatch(/index === 0[\s\S]{0,40}\? briefText[\s\S]{0,30}: ' '/);
		expect(toolTurn).not.toMatch(/appendAssistantMessage\(scrubberRef\.rehydrate\(result\.text\)\)/);
		// The row component renders the brief ONCE above the box.
		const row = read('./components/bash-tool-row.tsx');
		expect(row).toMatch(/<Show when=\{props\.brief && props\.brief\.trim\(\)\}>/);
	});

	test('consecutive tool ROUNDS each keep their own brief once settled', () => {
		// Tool-loop rounds that stream narration append CONSECUTIVE tool
		// rows (no separator when the round produced no reasoning), so a run
		// can span multiple rounds. The settled renderer must thread each
		// row's OWN brief — the old run-wide `run[0]?.brief` dropped every
		// brief after the first tool message of the run (the "Wait more."
		// narration vanished once the next bash box settled).
		const history = read('./components/history.tsx');
		const settled = history.slice(
			history.indexOf('for (const row of renderToolRun(run, fillWidth))'),
			history.indexOf('for (const row of renderToolRun(run, fillWidth))') + 400,
		);
		expect(settled).toMatch(/pushBlock\(row\.text, row\.blockKey, 'md', row\.brief\)/);
		expect(history).not.toMatch(/runBrief = run\[0\]\?\.brief/);
		// renderToolRun threads each block's OWN brief into its row, and a
		// same-family tally breaks when a NEW narration starts (so compact
		// groups never swallow a later round's brief either).
		expect(history).toMatch(/brief = block\[0\]\?\.brief/);
		expect(history).toMatch(/blockKey: key, brief/);
		expect(history).toMatch(/sharesBatch/);
	});

	test('codex usage limits render in /status for codexAccount endpoints', () => {
		// The `/status` modal must fetch live codex limits (`GET /wham/usage`)
		// ONLY for the ChatGPT-account codex backend, and thread them into
		// the status rows — the account's window (5h / weekly / monthly …)
		// decides the label, and every window gets its own row.
		const app = read('./app.tsx');
		expect(app).toMatch(/fetchCodexLimits\(endpoint\.baseUrl\)/);
		expect(app).toMatch(/codexLimitRows: rows/);
		expect(app).toMatch(/endpoint\.codexAccount/);
		const rows = read('./status-rows.ts');
		expect(rows).toMatch(/codexLimitRows\?: StatusRow\[\]/);
		expect(rows).toMatch(/\.\.\.\(data\.codexLimitRows \?\? \[\]\)/);
		const limits = read('./codex-limits.ts');
		expect(limits).toMatch(/\/wham\/usage/);
		expect(limits).toMatch(/codexLimitLabel\(window\.limit_window_seconds/);
	});

	test('file tools carry model-facing descriptions + argument schemas', () => {
		// The provider sees the catalog as OpenAI `tools`. Empty descriptions
		// and an empty schema made the edit/write tools unusable — the model
		// fell back to bash for every file change instead of using the tools
		// that render the Diff preview. Each file tool must tell the model
		// what it does and what arguments it takes.
		const tools = read('./tools.ts');
		for (const name of ['write_file', 'string_replace', 'diff_edit']) {
			const block = tools.slice(
				tools.indexOf(`registerTool('${name}'`),
				tools.indexOf(`registerTool('${name}'`) + 900,
			);
			expect(block).toMatch(/description:/);
			expect(block).toMatch(/parameters:/);
			expect(block).toMatch(/type: 'object'/);
			expect(block).toMatch(/properties:/);
			expect(block).toMatch(/required:/);
		}
	});

	test('the rotating tip lives in the IDLE history, centered, with a breakline', () => {
		// The tip must NOT ride the Working indicator line anymore; it
		// renders INSIDE the transcript (breakline above, centered) and only
		// while a turn runs with nothing painting (idle history, e.g. the
		// model thinking in the background).
		const input = read('./components/input-box.tsx');
		expect(input).not.toMatch(/dynamicTip/);
		const history = read('./components/history.tsx');
		expect(history).toMatch(/historyTip/);
		expect(history).toMatch(/justifyContent="center"/);
		expect(history).toMatch(/Tip: Type \/ for commands/);
		// Idle gate: tip shows only while running() and nothing is live.
		expect(history).toMatch(/const idle =/);
		expect(history).toMatch(/!liveToolRows\(\)\.length/);
		expect(history).toMatch(/!liveReplyText\(\)/);
		// hide-thinking ON means the live thought does NOT render, so the
		// history is idle and the tip may take the stage.
		expect(history).toMatch(/!\(!hideThinking\(\) && liveThoughtHeader\(\)\)/);
		// Transient: breakline + centered row, inside the scrollbox.
		expect(history).toMatch(/<Show when=\{historyTip\(\)\}>/);
		expect(history).toMatch(/<box height=\{1\} \/>/);
	});

	test('the transcript scrollbox uses the opencode-style scroll speed', () => {
		// opencode feels faster/smoother scrolling because its transcript
		// scrollbox multiplies the wheel delta (CustomSpeedScroll default 3)
		// instead of OpenTUI's linear 1×. Bobonyo mirrors that via the
		// `scrollSpeed` setting; a future change must keep the wiring.
		const history = read('./components/history.tsx');
		expect(history).toMatch(/scrollAcceleration=\{resolveScrollAcceleration\(\)\}/);
		const accel = read('./scroll-acceleration.ts');
		expect(accel).toMatch(/class CustomSpeedScroll/);
		expect(accel).toMatch(/return this\.speed/);
		expect(accel).toMatch(/loadSettings\(\)\.scrollSpeed \?\? 3/);
		const settings = read('./settings.ts');
		expect(settings).toMatch(/scrollSpeed\?: number/);
		expect(settings).toMatch(/scrollSpeed: 3/);
	});

	test('modals ignore ONLY the opening release, never a real outside click', () => {
		// The old `suppressFirstMouseUp` one-shot boolean was consumed by the
		// opening click's release, so the user's FIRST real outside click
		// was swallowed too — click-twice-to-close. Every modal must use a
		// short time window instead so an outside click closes on the first
		// try.
		for (const file of [
			'./components/details-modal.tsx',
			'./components/agents-modal.tsx',
			'./components/commands-modal.tsx',
			'./components/model-modal.tsx',
			'./components/resume-modal.tsx',
			'./components/settings-list-modal.tsx',
			'./components/settings-panel.tsx',
			'./components/status-modal.tsx',
			'./components/trust-modal.tsx',
			'./components/connect-provider-modal.tsx',
		]) {
			const src = read(file);
			expect(src).not.toMatch(/suppressFirstMouseUp/);
			expect(src).toMatch(/mountedAt = Date\.now\(\)/);
			expect(src).toMatch(/isOpeningRelease/);
		}
	});

	test('replies keep a REAL gap after the ✦ glyph (never `✦The`)', () => {
		const history = read('./components/history.tsx');
		// The reply content box owns its left padding; the glyph is its own
		// cell. A regression to `✦{' '}` (trailing space, trimmed by the
		// renderer) glues the first word to the glyph.
		expect(history).toMatch(/<box flexGrow=\{1\} paddingLeft=\{2\}>/);
		expect(history).not.toMatch(/✦\{' '\}/);
	});

	test('Ran tally/agent headers split colors even WITHOUT the glyph', () => {
		const rh = read('./row-highlight.ts');
		// liveRowSegments strips the leading ✦/⚙ before tokenizing, so the
		// `Ran … ×N` / `Ran agent:…` header regexes must make the glyph
		// OPTIONAL — a required glyph regresses the whole header to primary.
		expect(rh).toMatch(/\(\/\^\(\[✦⚙\]\\s\*\)\?\(Ran\\s\+\)\(\.\*\)\$/);
		expect(rh).toMatch(/\(\/\^\(\[✦⚙\]\\s\*\)\?\(\.\*\)\$/);
	});

	test('provider connect is a MODAL — the input-box wizard must not return', () => {
		// The old /connect flow asked questions in the chat input row
		// (`setPendingPrompt`); it was replaced by the opencode-style modal.
		// A future "simplification" that resurrects the input-row wizard
		// breaks the UX this guard exists for.
		const app = read('./app.tsx');
		const connectFlow = app
			.slice(app.indexOf('const setupProviders'), app.indexOf('const submit ='))
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		expect(connectFlow).not.toMatch(/setPendingPrompt/);
		expect(connectFlow).toMatch(/setConnectOpen/);
		expect(app).toMatch(
			/<ConnectProviderModal[\s\S]*?onConnect=\{saveConnectedProvider\}/,
		);
	});

	test('connect modal owns every key (gated in BOTH the app and input box)', () => {
		// OpenTUI dispatches every keypress to every listener: a modal that
		// is not in the gate list leaks arrow/typing keys into the chat
		// input and the history scrollbox behind it (the k-scrolls bug
		// class).
		expect(read('./app.tsx')).toMatch(/resumeOpen\(\) \|\|\n\s*connectOpen\(\)/);
		expect(read('./components/input-box.tsx')).toMatch(
			/resumeOpen\(\) \|\|\n\s*connectOpen\(\)/,
		);
	});

	test('ANY provider with a discovery URL fetches its models', () => {
		// DeepSeek/Xiaomi have dedicated fetchers; every other preset
		// (OpenAI, OpenRouter, Mistral, ...) carries a modelDiscoveryUrl and
		// must go through the generic catalog fetch — otherwise the model
		// picker shows only the seeds and never the full supported list.
		const app = read('./app.tsx');
		const refresh = app.slice(
			app.indexOf('const refreshModelCatalogs'),
			app.indexOf('const selectModel'),
		);
		expect(refresh).toMatch(
			/isXiaomiMiMo\(provider\) && provider\.modelDiscoveryUrl/,
		);
		expect(refresh).toMatch(
			/provider\.modelDiscoveryUrl\s*\n\s*\?\s*discoverModels\(provider\)/,
		);
	});
});
