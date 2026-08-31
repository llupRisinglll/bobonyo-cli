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
	test('MCP subprocesses have an application-shutdown cleanup path', () => {
		const app = read('./app.tsx');
		const mcp = read('./mcp.ts');
		expect(mcp).toMatch(/export async function closeMCPServers/);
		expect(mcp).toMatch(/activeClients\.clear\(\)/);
		expect(app).toMatch(/void closeMCPServers\(\)/);
	});
	test('memory-heavy transcript caches are session-bounded', () => {
		const history = read('./components/history.tsx');
		const detailsDeclaration = history.indexOf(
			'const compactDetails = new Map<string, string>()',
		);
		expect(detailsDeclaration).toBeGreaterThan(
			history.indexOf('function History'),
		);
		expect(history).toMatch(/compactDetails\.clear\(\)/);
		const cache = read('./settled-block-cache.ts');
		expect(cache).toMatch(
			/if \(!activeKeys\.has\(key\)\) cache\.delete\(key\)/,
		);
		const app = read('./app.tsx');
		expect(app).toMatch(/setRetrySnapshot\(null\)/);
		expect(app).toMatch(/resetFileUndoStack\(\)/);
	});
	test('LiveToolRows renders plain text cells, never markdown (brief is exempt)', () => {
		const src = read('./components/live-tool-rows.tsx');
		// MarkdownBrief is the brief-specific wrapper (not the full markdown
		// pipeline); the generic live row imports it to paint the pre-tool
		// brief identically to the settled row. The body must never use
		// <markdown> directly or MarkdownRenderable.
		expect(src).not.toMatch(/<markdown(?!Brief)|MarkdownRenderable/i);
		expect(src).toMatch(/MarkdownBrief/);
		expect(src).toMatch(/<text/);
		// Chunk colors ride as SPANS inside ONE <text> per line, never as a
		// per-cell <text> (each <text> is a native TextBufferRenderable with
		// its own TextBuffer/TextBufferView/SyntaxStyle handle set — per-cell
		// texts exhaust OpenTUI's handle table on big sessions and /undo).
		expect(src).toMatch(/<span\s+style=\{\{/);
	});

	test('history renders running tool rows ONLY via LiveToolRows', () => {
		const src = read('./components/history.tsx');
		expect(src).toMatch(
			/<LiveToolRows[\s\S]*?rows=\{liveToolRows\(\)\}[\s\S]*?\/>/,
		);
		// The live rows memo builds segments through the shared util.
		expect(src).toMatch(/liveRowSegments/);
	});

	test('active subagent owns its live row; generic Agent row is suppressed', () => {
		const history = read('./components/history.tsx');
		const rows = read('./live-tool-row.ts');
		expect(history).toMatch(/shouldRenderRunningToolMessage/);
		expect(rows).toMatch(/toolName !== 'agent' \|\| !hasRunningAgent/);
	});

	test('every live tool row keeps the settled leading breakline', () => {
		const src = read('./components/live-tool-rows.tsx');
		expect(src).toMatch(/<box height=\{1\} \/>/);
		// SINGLE breakline only: the bash/file row components render their
		// OWN leading breakline, so the live wrapper must NOT add another
		// before them — a double blank row appeared while running and
		// collapsed when the row settled (the "extra breakline").
		const beforeBash = src.slice(
			src.indexOf("row.lang !== 'inforow'") + 1,
			src.indexOf("row.lang === 'bashrow'"),
		);
		const bashBranch = src.slice(
			src.indexOf("row.lang === 'bashrow'"),
			src.indexOf("row.lang === 'filerow'"),
		);
		expect(bashBranch).not.toMatch(/<box height=\{1\} \/>/);
		const fileBranch = src.slice(
			src.indexOf("row.lang === 'filerow'"),
			src.indexOf("row.lang !== 'bashrow'"),
		);
		expect(fileBranch).not.toMatch(/<box height=\{1\} \/>/);
		// The breakline lives ONLY inside the generic (non-bash/file) branch.
		expect(beforeBash).not.toMatch(/<box height=\{1\} \/>/);
	});

	test('the live streaming reply uses the shared reply row with its breakline', () => {
		const history = read('./components/history.tsx');
		const reply = read('./components/transcript-reply.tsx');
		const start = history.indexOf('<Show when={visibleLiveReplyText()}>');
		const section = history.slice(start, history.indexOf('</Show>', start));
		expect(section).toMatch(/<TranscriptReply/);
		expect(reply).toMatch(/<box height=\{1\} \/>/);
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
		expect(component).not.toMatch(/<markdown[\s>]/);
		// Same handle budget rule as the live rows: per-line <text> with
		// styled spans, never a per-cell <text>.
		expect(component).toMatch(/<span\s+style=\{\{/);
		// Hover belongs to History's full-row wrapper. Child rows stay content-only
		// so Bash and other entries never paint nested/double backgrounds.
		expect(component).not.toMatch(/backgroundColor/);
		expect(history).toMatch(/block\.parts\[0\]\?\.key === hoveredBlock\(\)/);
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
		expect(modal).toMatch(/createEffect\(\s*on\(query,/);
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
		expect(modal).toMatch(/effortOptions\(/);
		expect(modal).toMatch(/Default \(\$\{catalog\}\)/);
	});

	test('/effort routes and persists per-model overrides', () => {
		const commands = read('./commands.ts');
		expect(commands).toMatch(/case 'effort':\n\s*ctx\.setEffort\(args\)/);
		const app = read('./app.tsx');
		expect(app).toMatch(/const switchEffort = \(args: string\) =>/);
		expect(app).toMatch(/effortLevelsForModel\(endpoint\.model\)/);
		expect(read('./config.ts')).toMatch(
			/modelEfforts\?: Record<string, string>/,
		);
	});

	test('bare /effort opens the effort picker modal (never the input row)', () => {
		const app = read('./app.tsx');
		// No args must open the modal; a modal signal, not setPendingPrompt.
		expect(app).toMatch(/if \(!level\) \{\n\s*setEffortOpen\(true\)/);
		expect(app).toMatch(/<EffortModal/);
		expect(app).toMatch(/onSelect=\{level => \{\n\s*applyEffort\(level\)/);
		expect(read('./components/input-box.tsx')).toMatch(/anyModalOpen\(\)/);
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
		expect(deepseek).toMatch(/staleCachedModels\(loadDeepSeekCache\(\), key\)/);
	});

	test('project .nanocoder folders auto-migrate to .bobonyo', () => {
		const paths = read('./bobonyo-paths.ts');
		expect(paths).toMatch(/export function migrateProjectDir/);
		expect(paths).toMatch(/cpSync\(source, target, \{recursive: true\}\)/);
		expect(paths).toMatch(/\.bobonyo/);
		// The migration runs wherever project dirs resolve (config/custom/
		// subagents), so Hilinga-style project agents/commands/skills move.
		expect(read('./config.ts')).toMatch(/migrateProjectDir\(/);
		// All project-local discovery now flows through shared configSearchDirs;
		// custom loaders consume that resolver instead of duplicating migration.
		expect(read('./custom.ts')).toMatch(/configSearchDirs\(/);
		expect(read('./subagents.ts')).toMatch(/configSearchDirs\(/);
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
		expect(modal).toMatch(
			/Math\.min\(120, Math\.max\(60, dims\(\)\.width - 4\)\)/,
		);
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
		// Manage-step delete (`d` → confirm → `y`), hinted in the footer.
		expect(modal).toMatch(/onDelete\?: \(id: string\) => void/);
		expect(modal).toMatch(/Enter edit · d delete · Esc back/);
		// Editing preserves the wire fields (responses/anthropic, codexAccount…).
		expect(modal).toMatch(/editProvider(\(\)!?)?\.sdkProvider/);
		expect(modal).toMatch(/editProvider(\(\)!?)?\.codexAccount/);
	});

	test('deleting a provider clears the saved lastProvider preference', () => {
		// Otherwise the next start resolves a provider that no longer exists
		// and silently falls back to the mock provider (`mock-model-1`).
		const app = read('./app.tsx');
		expect(app).toMatch(/action === 'delete'/);
		// The config/prefs mutation is a PURE helper in config.ts; the app
		// must route its deletes through it.
		expect(app).toMatch(/applyProviderDeletion\(/);
		const config = read('./config.ts');
		expect(config).toMatch(
			/lastProvider\.toLowerCase\(\) === id\.toLowerCase\(\)/,
		);
		expect(config).toMatch(/lastProvider: undefined,\s*lastModel: undefined/);
	});

	test('modal input placeholders use the blinking caret (input-box parity)', () => {
		const modal = read('./components/connect-provider-modal.tsx');
		expect(modal).toMatch(/spinnerFrame\(\) >> 2\) % 2 === 0/);
		expect(modal).toMatch(/activeRow\(\)\.bg/);
		// The caret sits at the START of an empty field (rendered BEFORE the
		// placeholder), at the END once the user types.
		expect(modal).toMatch(/when=\{!filled\(\)\}/);
		expect(modal).toMatch(/const caretChar = createMemo/);
		expect(modal).toMatch(/shown\(\)\[shown\(\)\.length - 1\]!/);
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
		// tokens; the status line must render the cumulative rate
		// (`100K/1.5M (10% miss)`) every turn. The aggregate is
		// SESSION-scoped (usageHistory): `/clear` empties it, so a fresh
		// conversation never shows the previous conversation's cache numbers
		// — the monthly ledger stays for `/usage` cost tracking.
		const usage = read('./provider-usage.ts');
		expect(usage).toMatch(/export function formatCacheRate/);
		expect(usage).toMatch(/export function extractCacheTokens/);
		expect(usage).toMatch(/export function sessionCacheUsage/);
		expect(usage).toMatch(/cacheHitTokens:/);
		expect(usage).toMatch(/cacheMissTokens:/);
		const status = read('./components/status.tsx');
		expect(status).toMatch(/formatCacheRate\(sessionCacheStats\(\)\)/);
		expect(status).toMatch(/sessionCacheUsage\(usageHistory\(\)\)/);
		expect(status).toMatch(/· cache/);
		// Provider-agnostic: the cache rate must render for ANY provider that
		// reports cache fields, never gated on DeepSeek.
		expect(status).not.toMatch(
			/isDeepSeek\(activeEndpoint\(\)\) && formatCacheRate/,
		);
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
		expect(app).toMatch(/shouldAutoCompactHistory/);
		expect(app).toMatch(/shouldAutoCompactContext\(\{/);
		expect(app).toMatch(/messageCount: history\.length/);
		expect(app).toMatch(/messageCap: maxMessages\(\)/);
		expect(app).toMatch(/messageMargin: AUTO_COMPACT_MESSAGE_MARGIN/);
		expect(app).toMatch(/history = await tryAutoCompactHistory\(history\)/);
		expect(app).toMatch(/await tryAutoCompactHistory\(context\(\)\)/);
		const settings = read('./settings.ts');
		expect(settings).toMatch(/autoCompact: \{enabled: true, threshold: 80\}/);
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
		expect(history).toMatch(
			/liveThinkingHeader\(spinnerFrame\(\), thinkingElapsed\(\)\)/,
		);
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
		expect(status).toMatch(
			/isDeepSeek\(activeEndpoint\(\)\) && deepSeekBalance\(\)/,
		);
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
			/completionMessageRows\(\s*completionMessage\(\),\s*completionTone\(\)\s*,?\s*\)/,
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

	test('/undo is conversation-only and /rewind owns file restoration', () => {
		const app = read('./app.tsx');
		const commands = read('./commands.ts');
		expect(commands).toMatch(/'undo',/);
		expect(commands).toMatch(/'rewind',/);
		expect(commands).toMatch(/undo: 'Undo the last message'/);
		expect(commands).toMatch(
			/rewind: 'Restore conversation and\/or files to an earlier point'/,
		);
		expect(app).toMatch(/undo: undoLast/);
		expect(app).toMatch(/rewind,/);
		expect(app).toMatch(/export function undoExchange/);
		expect(app).toMatch(/export function rewindExchangeAt/);
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
		expect(app).not.toMatch(/undoFileExchange\(\)/);
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
			/if \(event\.name === 'escape'\) \{[\s\S]{0,120}event\.preventDefault\(\);/,
		);
		// Escape removes only active @ token, preserving text before/after it.
		expect(input).toMatch(
			/setInputAt\(\s*at >= 0 \? input\(\)\.slice\(0, at\) \+ input\(\)\.slice\(cursor\) : input\(\),?\s*\)/,
		);
		expect(input).toMatch(
			/if \(event\.name === 'space'\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
		expect(input).toMatch(
			/if \(isDeleteKey\(event\)\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
		);
		expect(input).toMatch(
			/if \(isReturnKey\) \{[\s\S]{0,80}event\.preventDefault\(\);/,
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

	test('bash calls render STANDALONE, never enter an activity group', () => {
		// Bash has no activity group, so every call keeps its own bordered
		// command row. Only exploration, web, and MCP tools group.
		const history = read('./components/history.tsx');
		const groupToolRun = history.slice(
			history.indexOf('function groupToolRun'),
			history.indexOf('function groupToolRun') + 1400,
		);
		expect(groupToolRun).toMatch(/activityGroupForTool\(name\)/);
		expect(groupToolRun).toMatch(/if \(!activity\)/);
		expect(groupToolRun).toMatch(/blocks\.push\(\[message\]\);/);
		const activity = read('./activity-groups.ts');
		expect(activity).not.toContain("'execute_bash'");
	});

	test('selective tool groups render chronological activity trees, never ×N tallies', () => {
		const history = read('./components/history.tsx');
		const activity = read('./activity-groups.ts');
		expect(history).toMatch(/activityGroupForTool/);
		expect(history).toMatch(/formatActivityMessages/);
		expect(history).not.toMatch(/function compactToolBlock/);
		expect(activity).toMatch(/title: 'Explored'/);
		expect(activity).toMatch(/title: 'Navigated Web'/);
		expect(activity).toMatch(/mcpServerTitle\(mcp\[1\]/);
		expect(activity).toMatch(/replace\(\/\(\?:\^\|_\)mcp\$\/i, ''\)/);
		expect(activity).toMatch(/final \? '└' : '├'/);
	});

	test('apply_patch captures pre-mutation rows and renders them through DiffView', () => {
		const tools = read('./tools.ts');
		const app = read('./app.tsx');
		const display = read('./tool-display.ts');
		expect(tools).toMatch(/applyPatchDisplayChanges/);
		expect(tools).toMatch(/displayArgs/);
		expect(app).toMatch(/toolResult\.displayArgs \?\? message\.tool!\.args/);
		expect(display).toMatch(/_applyPatchDisplay/);
		expect(display).toMatch(/row\.kind === 'add'/);
		expect(display).toMatch(/row\.kind === 'remove'/);
		expect(display).toMatch(/fence\(\s*'filediff'/);
		expect(display).toMatch(/changeIndex === 0 \? '✦ ' : ''/);
		expect(display).toMatch(/\? `\$\{changeIndex === 0 \? '✦ ' : ''\}  └ `/);
		expect(display).not.toMatch(/Edited \$\{changes\.length\} file/);
		expect(display).not.toMatch(/✦ ApplyPatch/);
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
		expect(history).toMatch(/renderToolRun\(\s*run,\s*fillWidth,/);
		expect(history).toMatch(/singleToolRow\(\s*message,\s*key,\s*width,/);
		// The LIVE path passes the same render width.
		expect(history).toMatch(
			/historyFillWidth\(terminalDimensions\(\)\.width \?\? 80\),/,
		);
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
		expect(row).toMatch(/fg=\{glyph\}/);
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

	test('hover keeps later tool and markdown entries distinct', () => {
		const history = read('./components/history.tsx');
		expect(history).toMatch(/entryForEvent/);
		expect(history).toMatch(/pickHoveredEntry\(blockRefs, event\.y\)/);
		expect(history).toMatch(/blockRefs\.find\(item => item\.block === block\)/);
		expect(history).toMatch(/key: key \?\? `entry-\$\{anonymousBlock\+\+\}`/);
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
		expect(history).toMatch(
			/prevRefsByBlock\.get\(stableBlocks\[groupIndex\]!\) \?\? null/,
		);
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
		expect(app).toMatch(/evaluateRepeatedToolCalls/);
		const repeatedGuard = read('./repeated-tool-guard.ts');
		expect(repeatedGuard).toMatch(/MAX_REPEATED_TOOL_CALLS/);
		expect(repeatedGuard).toMatch(/BOOKKEEPING_TOOLS/);
	});

	test('task closeout never deletes the streamed Markdown reply', () => {
		const app = read('./app.tsx');
		const closeout = app.slice(
			app.indexOf('if (unfinishedTasks.length > 0'),
			app.indexOf(
				'completionSummary =',
				app.indexOf('if (unfinishedTasks.length > 0'),
			),
		);
		expect(closeout).toMatch(/appendAssistantMessage\(/);
		expect(closeout.indexOf('appendAssistantMessage(')).toBeLessThan(
			closeout.indexOf("setStreaming('')"),
		);
	});

	test('post-task final text survives even when it repeats the closeout draft', () => {
		const app = read('./app.tsx');
		expect(app).toContain('taskToolRanAfterCloseoutDraft = true');
		expect(app).toContain('shouldPersistTaskCloseoutReply(');
	});

	test('task closeout never fabricates completion after ignored nudges', () => {
		const app = read('./app.tsx');
		expect(app).toContain('const remainingUnfinishedTasks = unfinishedTasks');
		expect(app).not.toContain('toolId: `task-closeout-${Date.now()}`');
		expect(app).toContain('remainingUnfinishedTasks.length === 0');
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

	test('live pre-tool narration has one visual owner', () => {
		const app = read('./app.tsx');
		const history = read('./components/history.tsx');
		// Once provider text becomes tool.brief, clear streaming source and
		// suppress throttle residue while live tool row is visible.
		expect(app).toMatch(/const briefText[\s\S]{0,300}setStreaming\(''\)/);
		expect(history).toMatch(/const visibleLiveReplyText = createMemo/);
		expect(history).toMatch(
			/liveToolRows\(\)\.length > 0 \? '' : liveReplyText\(\)/,
		);
		expect(history).toMatch(/<Show when=\{visibleLiveReplyText\(\)\}>/);
	});

	test('command workflow bodies stay model-only, never render Triggered blocks', () => {
		const history = read('./components/history.tsx');
		expect(history).toMatch(
			/commandVisibleText\(message\.command, message\.content\)/,
		);
		expect(history).not.toMatch(/renderCommandBlock\(message\.command/);
		expect(history).not.toContain('✦ Triggered a Command');
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
		expect(toolTurn).toContain(
			'toolCallBrief(briefText, callIndex, priorRoundBriefed)',
		);
		expect(toolTurn).toContain(
			'toolCallBrief(briefText, index, priorRoundBriefed)',
		);
		expect(toolTurn).toContain('if (briefText) toolBriefActive = true');
		expect(toolTurn).not.toMatch(
			/appendAssistantMessage\(scrubberRef\.rehydrate\(result\.text\)\)/,
		);
		// The row component renders the brief ONCE above the box.
		const row = read('./components/bash-tool-row.tsx');
		expect(row).toMatch(
			/<Show when=\{props\.brief && props\.brief\.trim\(\)\}>/,
		);
	});

	test('completed tools stay visible while global turn keeps Working', () => {
		const history = read('./components/history.tsx');
		// Row.running owns placement. Global running() describes whole model
		// turn and must never hide an already completed row.
		expect(history).toMatch(/const liveToolIds = createMemo/);
		expect(history).toMatch(
			/message\.running \|\|[\s\S]{0,100}liveToolIds\(\)\.has/,
		);
		expect(history).not.toMatch(/running\(\) && message\.toolId/);
		// Adjacent live rows must not leak into a settled run.
		expect(history).toMatch(/!all\[i \+ 1\]\?\.running/);
		// Both live and settled paths suppress duplicate call ids.
		const dedupes = history.match(/seenToolIds\.has\(message\.toolId\)/g) ?? [];
		expect(dedupes.length).toBe(2);
	});
	test('detached background work releases foreground chat ownership', () => {
		const app = read('./app.tsx');
		const tools = read('./tools.ts');
		expect(tools).toMatch(/onDetachedWork\?\.\('bash', result\.task\.id\)/);
		expect(app).toMatch(/if \(busy\(\) && foregroundTurnOwner !== 0\)/);
		expect(app).toMatch(/foregroundTurnOwner = 0/);
		expect(app).toMatch(/setBusy\(false\)/);
		expect(app).toMatch(/break turnLoop/);
	});

	test('/usage remains width-safe after terminal resize', () => {
		const app = read('./app.tsx');
		const modal = read('./components/details-modal.tsx');
		// Pages are canonical narrow chunks, not frozen from stdout.columns at
		// open time. Card and cell widths read reactive terminal dimensions.
		expect(app).toMatch(/12 - index/);
		expect(app).toMatch(/Math\.min\(months, 12 - start\)/);
		expect(app).not.toMatch(/process\.stdout\.columns/);
		expect(modal).toMatch(/detailsCardWidth\(props\.title, dims\(\)\.width\)/);
		expect(modal).toMatch(/usageCalendarCellWidth\(props\.width\)/);
		expect(modal).toMatch(/usageVariantIndex\(cardWidth\(\), variants\)/);
		expect(modal).toMatch(
			/detailsCardHeight\(visibleContent\(\), dims\(\)\.height\)/,
		);
	});

	test('consecutive tool ROUNDS each keep their own brief once settled', () => {
		// Tool-loop rounds that stream narration append CONSECUTIVE tool
		// rows (no separator when the round produced no reasoning), so a run
		// can span multiple rounds. The settled renderer must thread each
		// row's OWN brief — the old run-wide `run[0]?.brief` dropped every
		// brief after the first tool message of the run (the "Wait more."
		// narration vanished once the next bash box settled).
		const history = read('./components/history.tsx');
		const start = history.indexOf('for (const row of renderToolRun(');
		const settled = history.slice(start, start + 600);
		expect(settled).toMatch(
			/pushBlock\(row\.text, row\.blockKey, 'md', row\.brief\)/,
		);
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
		expect(app).toMatch(/codexLimitRows:/);
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

	test('edit diff numbers are FILE-absolute, never snippet-relative 1..N', () => {
		// The reported bug: adding a line showed `1 - 2 - 3 - 4` no matter
		// where in the file the edit happened (the diff was numbered against
		// the old/new SNIPPET). string_replace must report the first
		// occurrence's absolute line and the preview must shift every diff
		// row by that base.
		const tools = read('./tools.ts');
		const replace = tools.slice(
			tools.indexOf("registerTool('string_replace'"),
			tools.indexOf("registerTool('diff_edit'"),
		);
		expect(replace).toMatch(/\(at line \$\{baseLine\}\)/);
		expect(replace).toMatch(/baseLine/);
		expect(replace).toMatch(/split\('\\n'\)\.length/);
		const display = read('./tool-display.ts');
		expect(display).toMatch(/replacementBaseLine\(tool\.output\)/);
		expect(display).toMatch(/export function replacementBaseLine/);
		// The offset math must actually move the rendered numbers: the
		// marker line number minus 1 is added to every diff row.
		expect(display).toMatch(/baseLine - 1/);
		// The diff runs on the STRIPPED middle (diffOldFinal/diffNewFinal,
		// degenerate-guarded), numbered from the real file line of that
		// middle.
		expect(display).toMatch(/lineDiffText\(\s*diffOldFinal\.join/);
		// INDENTATION: the diff rows must NOT render flush at column 0 —
		// every row carries a fixed container lead (the 2-space `lead`
		// baked into lineDiffText), so the numbered block nests under the
		// header like every other tool body.
		expect(display).toMatch(/const lead = '  ';/);
		expect(display).toMatch(/`\$\{lead\}\$\{String\(\(line\.newLineNo/);
		// SIGIL SPACE: the tokenizer consumed the space after +/- into the
		// parse regex; the renderer must re-emit it or `+const` glues to the
		// code. The renderChange chunk must carry the trailing space, and the
		// parse regex must take EXACTLY ONE separator (a greedy `\s+` would
		// swallow the code's leading tabs and render added lines flush).
		const highlight = read('./row-highlight.ts');
		expect(highlight).toMatch(/\$\{row\.sigil \?\? ''\} `/);
		// The change-row parse regex takes EXACTLY ONE space after the sigil
		// (`([-+]) (.*)`), so the code's leading indentation survives into
		// `text` — a greedy `\s+` would swallow it and render adds flush.
		expect(highlight).toMatch(/\(\[\-\+\]\) \(\.\*\)/);
		// TABS MUST BE EXPANDED (never rendered literally): a `\t` chunk
		// breaks the NATIVE OpenTUI layout — every tab-indented diff line
		// paints a blank row after it in a real terminal (herdr), invisible
		// to the test renderer. tokenizeFileDiff AND tokenizeFileRow must
		// replace tabs with spaces before parsing.
		expect(highlight).toMatch(/\.replace\(\/\\t\/g, '  '\)/);
		const diffFn = highlight.slice(
			highlight.indexOf('export function tokenizeFileDiff'),
			highlight.indexOf('export function tokenizeFileDiff') + 2000,
		);
		expect(diffFn).toMatch(/\.replace\(\/\\t\/g, '  '\)/);
		const rowFn = highlight.slice(
			highlight.indexOf('export function tokenizeFileRow'),
			highlight.indexOf('export function tokenizeFileRow') + 1500,
		);
		expect(rowFn).toMatch(/\.replace\(\/\\t\/g, '  '\)/);
		// LINE-COUNT CONSISTENCY: the summary must count blank lines exactly
		// like the diff renderer does — filtering empties made the summary
		// say N while the diff rendered N+1 rows (the phantom "extra line"
		// when the model inserts a blank line).
		expect(display).toMatch(
			/const oldLines = oldStr\.replace\(\/\\n\+\$\/, ''\)\.split\('\\n'\);/,
		);
		expect(display).toMatch(
			/const newLines = newStr\.replace\(\/\\n\+\$\/, ''\)\.split\('\\n'\);/,
		);
		const countBlock = display.slice(
			display.indexOf('const oldLines = oldStr'),
			display.indexOf(
				'const summary',
				display.indexOf('const oldLines = oldStr'),
			),
		);
		expect(countBlock).not.toMatch(/filter/);
		// REDUNDANT CONTEXT STRIPPING: identical leading/trailing lines in
		// old_string/new_string (the edit's ANCHOR) must NOT render as
		// context — they inflated the summary (`7 → 8` for a real 3 → 4
		// edit, the "extra 1 more line"). The diff must strip the common
		// prefix/suffix, and the summary must count ONLY the stripped
		// middle so the rendered rows always match it.
		expect(countBlock).toMatch(/const diffOld = oldLines\.slice\(prefix/);
		expect(countBlock).toMatch(/const diffNew = newLines\.slice\(prefix/);
		// DEGENERATE-STRIP GUARD: a prefix-replacement (old block replaced
		// by a longer block starting with the same lines) must NOT collapse
		// to `0 → N` — the full old→new renders so the replaced lines show
		// as context+removes+adds (git/codex parity).
		expect(countBlock).toMatch(/diffOldFinal = oldLines;/);
		expect(countBlock).toMatch(
			/diffOld.length === 0 \|\| diffNew.length === 0/,
		);
		expect(display).toMatch(/` ⎿ \$\{diffOldFinal\.length\} line/);
		expect(display).toMatch(
			/replacementBaseLine\(tool\.output\) \+ stripPrefix/,
		);
		// LEGACY NANOCODER ARGS: old sessions saved `old_str`/`new_str`
		// (snake_case) instead of `old_string`/`new_string`. Resuming them
		// showed `0 → N` (oldStr fell back to ''). The diff must accept
		// BOTH key shapes, and the legacy `Successfully replaced content at
		// lines N-M` result prefix must gate the SAME diff path as
		// `Replaced …` (never fall through to the generic tail).
		expect(display).toMatch(
			/old_string'\).*\|\| textArg\(tool\.args, 'old_str'/,
		);
		expect(display).toMatch(
			/new_string'\).*\|\|\s*textArg\(tool\.args, 'new_str'/,
		);
		expect(display).toMatch(/Successfully replaced content at line/);
	});
	test('edit diff rows WRAP INSIDE the container (long lines never overflow)', () => {
		// The intermittent "additional lines" bug: a diff row LONGER than
		// the renderable width overflowed, and the real terminal (herdr)
		// wrapped the orphan tail onto its OWN phantom row — invisible to
		// the clipped test renderer, so it shipped "fixed" twice. The
		// renderer must split long rows at the width budget (code-column
		// continuation, row bg preserved) so nothing ever exceeds the
		// renderable width and the terminal never wraps a row.
		const highlight = read('./row-highlight.ts');
		const diffFn = highlight.slice(
			highlight.indexOf('export function tokenizeFileDiff'),
			highlight.indexOf('export function tokenizeFileDiff') + 6000,
		);
		// The width-budget split: rows longer than `width - prefix` split
		// into continuation pieces (never overflow).
		expect(diffFn).toMatch(
			/maxText = width > 0 \? Math\.max\(1, width - prefixLen\)/,
		);
		// Continuations re-indent to the code column and carry the row bg
		// (the embedded newline is a template escape, not a string).
		expect(diffFn).toMatch(/`\\n\$\{' '\.repeat\(prefixLen\)\}`/);
		// The continuation chunk inherits the row background.
		expect(diffFn).toMatch(/bg: rowBg/);
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
		expect(history).toMatch(/!visibleLiveReplyText\(\)/);
		// Only 'show' mode renders live thought; hidden/line leave the
		// history idle so the tip may take the stage.
		expect(history).toMatch(
			/!\(thinkingMode\(\) === 'show' && liveThoughtHeader\(\)\)/,
		);
		// Transient: breakline + centered row, inside the scrollbox.
		expect(history).toMatch(/<Show when=\{historyTip\(\)\}>/);
		expect(history).toMatch(/<box height=\{1\} \/>/);
	});
	test('compaction shows a TRANSIENT centered row, never a permanent history line', () => {
		// The "Compacting context (LLM summary)…" status must NOT be a
		// permanent chat-history info row (appendInfo): it renders as a
		// centered row inside the transcript with a leading breakline,
		// animated dots and the warning color, and disappears the moment
		// the summarization settles (success, error or empty summary).
		const app = read('./app.tsx');
		// The permanent info row is GONE; the signal wraps the summarization.
		expect(app).not.toMatch(/appendInfo\('Compacting context \(LLM summary\)/);
		const compact = app.slice(
			app.indexOf('const compactHistory = '),
			app.indexOf('const retryLast'),
		);
		expect(compact).toMatch(/setCompacting\(true\)/);
		expect(compact).toMatch(/setCompacting\(false\)/);
		expect(compact).toMatch(/finally/);
		expect(compact).toMatch(/partitionCompactionHistory\(ctx\)/);
		expect(compact).toMatch(/summarizeContext\(\s*partition\.summarize/);
		// The completion notice stays a permanent info row (the RESULT of the
		// compaction is chat content — only the in-progress status is transient).
		expect(compact).toMatch(/Context compacted via LLM summary/);
		const history = read('./components/history.tsx');
		expect(history).toMatch(/<Show when=\{compacting\(\)\}>/);
		expect(history).toMatch(/compactingLabel\(spinnerFrame\(\)\)/);
		expect(history).toMatch(/justifyContent="center"/);
		expect(history).toMatch(/<box height=\{1\} \/>/);
		expect(history).toMatch(/colors\(\)\.warning/);
		// The animated dots come from the shared loading cadence helper, not a
		// hard-coded "…" (a fixed ellipsis would double the animated tail).
		expect(history).not.toMatch(/compactingLabel\([^)]*\)\s*\+\s*['"]…['"]/);
		const state = read('./state.ts');
		expect(state).toMatch(/compactingLabel/);
		expect(state).toMatch(/loadingDots\(frame\)/);
	});
	test('task bookkeeping renders as plain progress text, not tool chrome', () => {
		const display = read('./tool-display.ts');
		const history = read('./components/history.tsx');
		const live = read('./components/live-tool-rows.tsx');
		expect(display).toMatch(/isTaskProgressTool/);
		expect(display).toMatch(
			/if \(isTaskProgressTool\(tool\.name\)\) return raw/,
		);
		expect(history).toMatch(/formatTaskStatusText\(message\.tool, status\)/);
		expect(live).toMatch(/row\.lang === 'inforow'/);
		expect(live).toMatch(/row\.lang !== 'inforow'/);
		expect(live).toMatch(/row\.glyphTone === 'muted'/);
		expect(history).toMatch(/tokenizeTaskStatusRow/);
		expect(history).toMatch(/rowGlyph\('inforow'\)/);
		expect(live).toMatch(/settledGlyphColor\([\s\S]*row\.glyph/);
		expect(history).toMatch(
			/singleToolRow[\s\S]*isTaskProgressTool\(message\.tool\.name\)/,
		);
		expect(history).not.toMatch(/`✦  \$\{formatTaskStatusText/);
		expect(history).toMatch(/formatTaskStatusText\(message\.tool, status\)/);
	});

	test('the transcript scrollbox uses the opencode-style scroll speed', () => {
		// opencode feels faster/smoother scrolling because its transcript
		// scrollbox multiplies the wheel delta (CustomSpeedScroll default 3)
		// instead of OpenTUI's linear 1×. Bobonyo mirrors that via the
		// `scrollSpeed` setting; a future change must keep the wiring.
		const history = read('./components/history.tsx');
		expect(history).toMatch(
			/anyModalOpen\(\)\s*\?\s*disabledScroll\s*:\s*resolveScrollAcceleration\(\)/,
		);
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
		const reply = read('./components/transcript-reply.tsx');
		// Shared parent/child reply row owns a real two-column spacer.
		expect(reply).toMatch(/TRANSCRIPT_GLYPH_GAP/);
		expect(reply).not.toMatch(/✦\{' '\}/);
	});

	test('Ran tally/agent headers split colors even WITHOUT the glyph', () => {
		const rh = read('./row-highlight.ts');
		// liveRowSegments strips the leading ✦/⚙ before tokenizing, so the
		// `Ran … ×N` / `Ran agent:…` header regexes must make the glyph
		// OPTIONAL — a required glyph regresses the whole header to primary.
		expect(rh).toMatch(/\(\/\^\(\[✦⚙\]\\s\*\)\?\(Ran\\s\+\)\(\.\*\)\$/);
		expect(rh).toMatch(/\(\/\^\(\[✦⚙\]\\s\*\)\?\(\.\*\)\$/);
	});

	test('agents modal manages models and confirms custom-agent deletion', () => {
		const agents = read('./components/agents-modal.tsx');
		const subagents = read('./subagents.ts');
		expect(agents).toMatch(/Select model for/);
		expect(agents).toMatch(/saveSubagentModel/);
		expect(agents).toMatch(/Delete agent/);
		expect(agents).toMatch(/confirmingDelete/);
		expect(agents).toMatch(/Shift\+D|D delete custom/);
		expect(subagents).toMatch(/unlinkSync\(agent\.path\)/);
		expect(subagents).toMatch(/agentModels/);
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
		expect(read('./app.tsx')).toMatch(
			/resumeOpen\(\) \|\|\n\s*psOpen\(\) \|\|\n\s*connectOpen\(\)/,
		);
		expect(read('./components/input-box.tsx')).toMatch(/anyModalOpen\(\)/);
	});

	test('every modal with an input handles paste (never leaks to the chat box)', () => {
		// While a modal is open the chat box ignores paste (anyModalOpen
		// gate); each modal field must register its own usePaste or the
		// paste would be swallowed entirely.
		for (const file of [
			'./components/connect-provider-modal.tsx',
			'./components/model-modal.tsx',
			'./components/settings-list-modal.tsx',
			'./components/commands-modal.tsx',
			'./components/resume-modal.tsx',
			'./components/agents-modal.tsx',
			'./components/settings-panel.tsx',
		]) {
			expect(read(file)).toMatch(/usePaste/);
		}
	});

	test('git wrappers stay removed; bounded glob and grep stay first-class', () => {
		const tools = read('./tools.ts');
		const client = read('./client.ts');
		for (const name of [
			'find_files',
			'search_file_contents',
			'list_directory',
			'git_status',
			'git_log',
			'git_diff',
			'git_add',
			'git_push',
			'git_pull',
			'git_branch',
			'git_commit',
			'git_stash',
			'git_reset',
			'git_pr',
		]) {
			expect(tools).not.toContain(`registerTool('${name}'`);
			expect(client).not.toMatch(new RegExp(`^[\t ]*${name}:`, 'm'));
		}
		expect(tools).toMatch(/registerTool\('execute_bash'/);
		expect(tools).toMatch(/registerTool\('glob'/);
		expect(tools).toMatch(/registerTool\('grep'/);
		expect(tools).toMatch(/globWorkspace/);
		expect(tools).toMatch(/grepWorkspace/);
	});

	test('git commit / gh pr messages stay ONE line with no AI attribution', () => {
		// The bash tool refuses violating commands before they run.
		const tools = read('./tools.ts');
		expect(tools).toMatch(/gitCommitMessagesViolation/);
		expect(tools).toMatch(/ghPrMessagesViolation/);
		expect(tools).toMatch(/REFUSED to run/);
		// Git operations use execute_bash; no redundant dedicated git tools.
		expect(tools).not.toMatch(/registerTool\('git_/);
		// The default system prompt states the rule too.
		const client = read('./client.ts');
		expect(client).toMatch(/git commit`/);
		expect(client).toMatch(/Co-authored-by:/);
	});

	test('model modal header renders user + real name WITHOUT parentheses', () => {
		// The category header renders the REAL provider title plus the
		// user-given connection names (`DeepSeek - deepseek`, or the TIER
		// list for the merged OpenCode group) and must not wrap the names
		// in `(...)`.
		const modal = read('./components/model-modal.tsx');
		expect(modal).toMatch(/providerDisplayName\(line\.provider\)/);
		expect(modal).toMatch(/export function providerHeaderParts/);
		expect(modal).toMatch(/\{title\}/);
		expect(modal).toMatch(/\{names\}/);
		// No literal `(` rendered directly before the header name.
		const header = modal.slice(modal.indexOf("if (line.kind === 'provider')"));
		expect(header).not.toMatch(/\{'  '\}\s*\(/);
	});

	test('configured provider context limits beat discovered model metadata', () => {
		const app = read('./app.tsx');
		expect(app).toMatch(
			/effectiveContextWindow\(\s*provider\.contextWindow,\s*modelWindows\(\)\[provider\.id\]\?\.\[sessionModel\],\s*\)/,
		);
		expect(app).toMatch(
			/effectiveContextWindow\(\s*provider\.contextWindow,\s*modelWindows\(\)\[providerId\]\?\.\[model\],\s*\)/,
		);
	});

	test('switching models/accounts never clears the conversation context (cache head)', () => {
		// `selectModel` must ONLY swap the active endpoint: the context and
		// the provider cache head stay untouched, so a same-provider account
		// swap (brian → mika) does not intentionally resend/rebuild
		// everything and lose the cache rate.
		const app = read('./app.tsx');
		const start = app.indexOf('const selectModel = ');
		const end = app.indexOf('const listProvidersInfo', start);
		const select = app.slice(start, end === -1 ? undefined : end);
		expect(select).toMatch(/setActiveEndpoint/);
		expect(select).not.toMatch(/clearMessages/);
		expect(select).not.toMatch(/setContext\(\[\]\)/);
		// Save chosen provider/model into current session immediately; global
		// preferences alone make /resume restore stale pre-switch metadata.
		expect(select).toMatch(/persist\(\)/);
		// The model modal drives the account switch via the connection
		// picker and marks same-provider swaps to skip the resend confirm.
		const modal = read('./components/model-modal.tsx');
		expect(modal).toMatch(/Select provider/);
		expect(modal).toMatch(/accountSwitch/);
	});

	test('thinking display is a hidden / show / line three-way mode', () => {
		const settings = read('./settings.ts');
		expect(settings).toMatch(/ThinkingMode = 'hidden' \| 'show' \| 'line'/);
		const history = read('./components/history.tsx');
		// Live thought block renders ONLY in 'show' mode.
		expect(history).toMatch(/thinkingMode\(\) === 'show'/);
		// Settled thought blocks render ONLY in 'show' mode.
		expect(history).toMatch(/thinkingMode\(\) === 'show'\)/);
		// historyTip idle check: only 'show' blocks the tip.
		expect(history).toMatch(
			/!\(thinkingMode\(\) === 'show' && liveThoughtHeader\(\)\)/,
		);
		const panel = read('./components/settings-panel.tsx');
		expect(panel).toMatch(/thinkingMode: \['hidden', 'show', 'line'\]/);
	});

	test('line mode: ticker renders in input-box, not in chat history', () => {
		const input = read('./components/input-box.tsx');
		// The ticker row is gated on the pure helper (line + busy +
		// ACTIVELY thinking), never on the raw reasoning buffer — a stale
		// buffer during tool runs must not leave a stuck line.
		expect(input).toMatch(
			/lineTickerVisible\(thinkingMode\(\), busy\(\), thinkingActive\(\)\)/,
		);
		// The ticker shows the one-line reasoning via liveThoughtOneLine.
		expect(input).toMatch(/liveThoughtOneLine/);
		const history = read('./components/history.tsx');
		// history.tsx must NOT render the live thought for 'line' mode.
		const liveThoughtGuards =
			history.match(/<Show when=\{thinkingMode\(\)[^}]*liveThoughtHeader/g) ??
			[];
		for (const guard of liveThoughtGuards) {
			expect(guard).toContain('show');
			expect(guard).not.toContain('line');
		}
	});

	test('line-mode ticker row is subtracted from the history-height cap', () => {
		// The ticker renders INSIDE the InputBox column, so the App must
		// subtract its row from historyHeight or the input box shifts down
		// and overlaps the status line while thinking (the reported bug).
		const app = read('./app.tsx');
		expect(app).toMatch(
			/lineTickerVisible\(thinkingMode\(\), busy\(\), thinkingActive\(\)\)/,
		);
		const input = read('./components/input-box.tsx');
		expect(input).toMatch(/export function lineTickerVisible/);
	});

	test('/settings set thinkingMode validates the three modes and persists', () => {
		// The slash-command handler must accept exactly hidden/show/line,
		// reject anything else with a message, and persist the choice —
		// a regression that drops the validation would accept garbage.
		const app = read('./app.tsx');
		const handler = app.slice(
			app.indexOf("case 'thinkingMode':"),
			app.indexOf("case 'cavemanMode':"),
		);
		expect(handler).toMatch(/\['hidden', 'show', 'line'\]\.includes/);
		expect(handler).toMatch(/Invalid thinking mode/);
		expect(handler).toMatch(
			/setThinkingMode\(next as 'hidden' \| 'show' \| 'line'\)/,
		);
		expect(handler).toMatch(/saveSettings\(/);
	});

	test('startup applies the persisted thinkingMode (never a hardcoded default)', () => {
		// The app must hydrate the signal from settings on boot — a
		// regression that always uses the default would ignore the user's
		// saved mode (e.g. 'line') after every restart.
		const app = read('./app.tsx');
		expect(app).toMatch(
			/setThinkingMode\(settings\.thinkingMode \?\? 'hidden'\)/,
		);
	});

	test('Shift+Enter multiline routes through isNewlineInsert (all terminal shapes)', () => {
		// The per-pane regression: herdr panes deliver Shift+Enter as a
		// MODIFIED linefeed, other terminals as return+shift. The handler
		// must route through the single pure helper — an inline check that
		// excludes linefeed events silently drops Shift+Enter on some panes.
		const input = read('./components/input-box.tsx');
		expect(input).toMatch(/if \(isNewlineInsert\(event\)\) \{/);
		expect(input).not.toMatch(/event\.name !== 'linefeed'/);
		// The helper exists and covers the modified-linefeed shape.
		expect(input).toMatch(/export function isNewlineInsert/);
		expect(input).toMatch(/event\.name === 'linefeed'/);
		expect(input).toMatch(
			/return Boolean\(event\.shift \|\| event\.ctrl \|\| event\.meta\)/,
		);
	});

	test('kitty keyboard protocol is gated, dual-protocol, and normalized', () => {
		// The per-pane Shift+Enter bug: terminals send Shift+Enter as a plain
		// `\r` (indistinguishable from Enter) UNLESS extended key reporting
		// is enabled. The app must gate it on known-good terminals, write BOTH
		// the kitty (`>1u`) and modifyOtherKeys (`>4;2m`) enables (tmux only
		// accepts the latter), and route every CSI-u sequence through
		// kittyToXterm (OpenTUI's own kitty parser mis-names herdr backspace
		// `\x1b[8u` as `\b`). A regression that re-disables kitty, drops the
		// gate, or drops the converter breaks Shift+Enter on other panes.
		const index = read('./index.tsx');
		expect(index).toMatch(/supportsExtendedKeys\(\)/);
		expect(index).toMatch(/KITTY_KEYBOARD_ENABLE/);
		expect(index).toMatch(/MODIFY_OTHER_KEYS_ENABLE/);
		expect(index).toMatch(/prependInputHandler/);
		expect(index).toMatch(/kittyToXterm\(raw\)/);
		// Converted keys must route through the SAME internal handler normal
		// keys use (processParsedKey wraps a KeyEvent) — a custom emit would
		// bypass preventDefault ordering and break global key handlers.
		expect(index).toMatch(/_internalKeyInput\.processParsedKey/);
		// Both protocols must be disabled on exit (kitty + modifyOtherKeys).
		expect(index).toMatch(/KITTY_KEYBOARD_DISABLE/);
		expect(index).toMatch(/MODIFY_OTHER_KEYS_DISABLE/);
		const keys = read('./kitty-keys.ts');
		expect(keys).toMatch(/export function kittyToXterm/);
		expect(keys).toMatch(/export function supportsExtendedKeys/);
		// Allowlist safety: unknown terminals default OFF.
		expect(keys).toMatch(/EXTENDED_KEYS_TERMINALS/);
		expect(keys).toMatch(/return false;/);
		// herdr panes are marked by HERDR_ENV=1 (TERM_PROGRAM is unset) —
		// without this the protocol never enables inside herdr.
		expect(keys).toMatch(/HERDR_ENV === '1'/);
		// Shift+Enter: kitty stored mod 2 = shift → xterm mod 2.
		expect(keys).toMatch(/Math\.max\(0, stored - 1\)/);
		expect(keys).toMatch(/mask & 1 \? 1 : 0/);
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
	test('briefed file rows shrink the fill width by the brief indent', () => {
		// The "blank line between diff rows" regression: FileToolRow prepends
		// a 2-wide indent box to EVERY body row of a briefed file/diff entry,
		// ON TOP of the tokenizer's width-filled padding. A briefed row then
		// measures `fillWidth + 2` while the renderable is only `fillWidth` —
		// the TERMINAL wraps the 2-cell overflow onto a phantom line after
		// every diff row. Invisible to the OpenTUI test renderer (it clips
		// instead of wrapping), so the guard lives at the width-math level:
		// both the settled and the LIVE file-row tokenizer calls must route
		// through toolRowFillWidth(terminalWidth, brief), never raw
		// historyFillWidth.
		const width = read('./history-width.ts');
		expect(width).toMatch(/export function toolRowFillWidth/);
		expect(width).toMatch(/brief !== undefined && brief !== ''/);
		expect(width).toMatch(/Math\.max\(1, fill - 3\)/);
		const history = read('./components/history.tsx');
		// Settled component-tool rows (filerow/filediff render as
		// FileToolRow) must use the brief-aware width.
		expect(history).toMatch(/liveRowSegments\(/);
		expect(history).toMatch(
			/toolRowFillWidth\(terminalDimensions\(\)\.width \?\? 80, part\.brief\)/,
		);
		// Running tool rows stream through the same component — the live
		// segments must use the brief-aware width too.
		expect(history).toMatch(
			/toolRowFillWidth\(\s*terminalDimensions\(\)\.width \?\? 80,\s*message\.brief\)/,
		);
	});

	test('the pre-tool brief renders through MARKDOWN, never a plain <text>', () => {
		// The model's pre-tool narration carries real markdown
		// (`**bold**`, `` `code` ``); a plain `<text>{props.brief}</text>`
		// leaked the raw markers. Every tool row must render the brief via
		// MarkdownBrief (a `<markdown>` node with the transcript's renderer),
		// in the LIVE rows and once settled.
		const brief = read('./components/markdown-brief.tsx');
		expect(brief).toMatch(/export function MarkdownBrief/);
		// The brief node is a REAL markdown element (the same pipeline the
		// replies use), with the transcript's syntax style + renderer.
		expect(brief).toMatch(/<markdown/);
		expect(brief).toMatch(/syntaxStyle=\{props\.md\.syntaxStyle\(\)\}/);
		expect(brief).toMatch(/renderNode=\{props\.md\.renderNode\}/);
		// The components must route the brief through MarkdownBrief — a
		// regression to `<text>{props.brief}</text>` fails here.
		for (const file of [
			'./components/bash-tool-row.tsx',
			'./components/file-tool-row.tsx',
			'./components/settled-tool-row.tsx',
		]) {
			const src = read(file);
			expect(src).toMatch(/<MarkdownBrief/);
			expect(src).not.toMatch(/<text>\{props\.brief\}<\/text>/);
			expect(src).not.toMatch(/<text>\{props\.brief\}/);
		}
		// The LIVE renderer threads the same renderer bits through.
		const live = read('./components/live-tool-rows.tsx');
		expect(live).toMatch(/md: MarkdownBriefRenderer/);
		expect(live).toMatch(/md=\{props\.md\}/);
		// history.tsx builds the renderer from the transcript's OWN markdown
		// pipeline (same syntaxStyle/renderNode as the replies) and hands it
		// to every row component + the live region.
		const history = read('./components/history.tsx');
		expect(history).toMatch(/const briefMarkdown: MarkdownBriefRenderer/);
		expect(history).toMatch(/syntaxStyle,/);
		expect(history).toMatch(/renderNode,/);
		expect(history).toMatch(/md=\{briefMarkdown\}/);
	});
});

describe('regression guards (COMPLETED attention popup)', () => {
	test('the popup is armed exactly at the two "Worked for" completion sites', () => {
		const app = read('./app.tsx');
		// The text-turn and tool-only-turn completions both arm the idle
		// window right after the completion message is set.
		const arms = app.match(/completionPopupController\.arm\(\)/g);
		expect(arms?.length).toBe(2);
	});

	test('every completion POPUP lifecycle site is wired (arm/cancel/activity)', () => {
		const app = read('./app.tsx');
		// New turn, /clear, /undo and /resume all cancel the popup (a stale
		// attention modal must never survive a conversation swap).
		const cancels = app.match(/completionPopupController\.cancel\(\)/g);
		expect(cancels?.length).toBe(5);
		// ANY key is user activity (dismisses a visible popup / restarts the
		// idle window) and the ROOT box tracks mouse move/down globally —
		// "move the mouse to dismiss" works over the whole screen.
		const activities = app.match(/completionPopupController\.activity\(\)/g);
		expect(activities?.length).toBeGreaterThanOrEqual(3);
		expect(app).toMatch(
			/onMouseMove: \(\) => completionPopupController\.activity\(\)/,
		);
		expect(app).toMatch(
			/onMouseDown: \(\) => completionPopupController\.activity\(\)/,
		);
	});

	test('the popup component dismisses on mouse AND key without claiming keys', () => {
		const src = read('./components/completion-popup.tsx');
		expect(src).toContain('✓ COMPLETED');
		// The COMPLETED card uses the theme PRIMARY color (border + title),
		// never the success-green — a task-done banner in green fights the
		// terminal's signal colors and the user asked for primary.
		expect(src).toMatch(/borderColor=\{colors\(\)\.primary\}/);
		expect(src).toMatch(
			/<text fg=\{colors\(\)\.primary\} attributes=\{bold\(\)\}>/,
		);
		expect(src).not.toMatch(/colors\(\)\.success/);
		// The card centers its content (title + message) — the message is
		// the payload of an attention grab.
		expect(src).toMatch(/alignItems="center"/);
		// ONE combined dismiss hint covers BOTH paths (any key OR mouse
		// movement); the separate per-path hints and any ESC mention are
		// redundant and banned.
		expect(src).toMatch(/move the mouse or press any key to dismiss/);
		expect(src).not.toMatch(/press any key to continue/);
		expect(src).not.toMatch(/move the mouse to dismiss/);
		expect(src).not.toMatch(/[Ee]sc\b/);
		expect(src).toMatch(/onMouseMove: \(\) => props\.onDismiss\(\)/);
		expect(src).toMatch(/onMouseDown: \(\) => props\.onDismiss\(\)/);
		expect(src).toMatch(/onMouseUp: \(\) => props\.onDismiss\(\)/);
		expect(src).toMatch(/onMouseScroll: \(\) => props\.onDismiss\(\)/);
		// The key dismiss must NOT claim the key: no preventDefault /
		// stopPropagation inside the useKeyboard callback, so the next prompt
		// can be typed immediately.
		expect(src).not.toMatch(/preventDefault|stopPropagation/);
		expect(src).toMatch(
			/useKeyboard\(\(\) => \{[\s\S]*?props\.onDismiss\(\);[\s\S]*?\}\);/,
		);
	});
});

describe('regression guards (interrupted-turn tool ghost)', () => {
	test('every turn END settles any still-running tool rows (no ghost resurface)', () => {
		const app = read('./app.tsx');
		// The turn's finally block must settle running tool rows with their
		// streamed output. A turn can end mid-tool (Esc interrupt / watchdog
		// / provider error) and runBash keeps streaming into liveOutputs —
		// without this, the leftover `running:true` message becomes a GHOST
		// that resurfaces in the live region during the NEXT turn, stacked
		// next to the new turn's identical command ("same bash twice").
		const finallyBlock = app.slice(
			app.indexOf('} finally {'),
			app.indexOf('const recordUsage'),
		);
		expect(finallyBlock).toMatch(
			/settleRunningToolRows\(prev, liveOutputs\(\)\)/,
		);
		expect(finallyBlock).toMatch(/setRunning\(false\)/);
		// The helper lives in state and un-flags EVERY running message.
		const state = read('./state.ts');
		expect(state).toMatch(/export function settleRunningToolRows/);
		expect(state).toMatch(/if \(!message\.running\) return message;/);
	});
});

describe('regression guards (brief gap + COMPLETED modal only-when-idle)', () => {
	test('the pre-tool brief keeps a REAL 2-column gap after the diamond', () => {
		// The reply container pads its content 2 columns after `✦`; the
		// brief rendered `✦ ` (ONE trailing space inside the text cell) so
		// its text sat one column too close to the diamond. The gap must be
		// a real spacer box (trailing spaces get trimmed by the renderer).
		const brief = read('./components/markdown-brief.tsx');
		expect(brief).toMatch(/<text fg=\{props\.glyph as never\}>✦<\/text>/);
		expect(brief).toMatch(/TRANSCRIPT_GLYPH_GAP/);
		expect(brief).not.toMatch(/✦ <\/text>/);
		// The bordered tool box (bash) and the file row indent to the NEW
		// text column (`✦` + 2-col gap = 3 cols) so the border still lines
		// up under the brief text.
		expect(read('./components/bash-tool-row.tsx')).toMatch(
			/TRANSCRIPT_CONTENT_COLUMN/,
		);
		const fileRow = read('./components/file-tool-row.tsx');
		expect(fileRow).toMatch(/<box width=\{3\} \/>/);
	});

	test('COMPLETED popup: activity while ARMED cancels (never shows to an active user)', () => {
		const src = read('./completion-popup.ts');
		// activity() when armed must DISARM + clear the timer — a restart
		// would show the modal the moment an active user pauses briefly.
		expect(src).toMatch(
			/if \(armed\) \{\n\s*armed = false;\n\s*clearTimer\(\);/,
		);
		// The restart path must be gone from activity().
		const activity = src.slice(src.indexOf('activity(): void {'));
		expect(activity).not.toMatch(/startIdleWindow\(\)/);
	});

	test('the completion line stays VISIBLE above the input while the popup is up', () => {
		const app = read('./app.tsx');
		// A bright copy renders at the completion line's position with a
		// z-index above the popup's backdrop (3000), only while the popup is
		// visible — the backdrop must never hide the `✦ Worked for …` line.
		expect(app).toMatch(/completionPopup\(\) && completionMessage\(\)/);
		expect(app).toMatch(/top=\{historyHeight\(\) \+ 1\}/);
		expect(app).toMatch(/zIndex=\{3100\}/);
		expect(app).toMatch(
			/fg=\{colors\(\)\.secondary\}>\{completionMessage\(\)\}/,
		);
	});
});

describe('regression guards (shared parent/subagent transcript renderer)', () => {
	test('/ps subagent details reuse History instead of hand-rendering rows', () => {
		const modal = read('./components/background-jobs-modal.tsx');
		expect(modal).toMatch(/import \{History\} from '\.\/history'/);
		expect(modal).toMatch(
			/<History[\s\S]*?embedded[\s\S]*?messages=\{agentMessages\}/,
		);
		expect(modal).not.toMatch(/<For each=\{detailAgent\(\)\?\.transcript/);
		const history = read('./components/history.tsx');
		expect(history).toMatch(/messages\?: \(\) => ChatMessage\[\]/);
		expect(history).toMatch(
			/const messages = props\.messages \?\? globalMessages/,
		);
		expect(history).toMatch(/<TranscriptReply/);
	});
});
