# Visual & behavioral parity gaps, bobonyo rewrite

Tracks the remaining 1:1 visual/behavioral differences between the rewrite and
the reference nanocoder TUI. The FUNCTIONAL tracker is
[`parity-coverage.md`](parity-coverage.md) (150 ✅ / 0 🟡); this doc covers the
LOOKS and interaction details that the keyword-parity suite cannot assert
(layout positions, animations, borders, exit hygiene).

## Omnicode palette (authoritative, from `nanocoder/source/config/themes.json`)

| Role | Hex | Used for |
|---|---|---|
| text | `#c0caf5` | Default transcript/input text |
| base | `#1a1b26` | Background |
| primary | `#bb9af7` | Prompt `❯`, tool glyphs, model name, tune value, banner |
| secondary | `#565f89` | Border, separators, dim labels, effort badge, ctx label |
| success | `#7AF778` | Diff added text, ✔ |
| error | `#f7768e` | Status mode (`yolo mode on`), diff removed text, errors |
| warning | `#e0af68` | Warnings |
| promptChar | `❯` (U+276F) | The prompt glyph |
| assistantIcon | `✦` (U+2726) | Tool/assistant row glyph |
| bannerGradient | `#bb9af7 → #bb9af7` | Banner |

Chalk grey (placeholders/hints) = ANSI 90 ≈ neutral `#808080` in the rewrite
(never `#565f89`).

## Verification methodology (herdr, NOT tmux)

Interactive/look verification MUST run inside **herdr** (the terminal workspace
manager the user actually types in), because tmux's raw-input handling masks
key bugs (backspace/escape flushing). Use herdr's pane API:

```sh
herdr pane split --pane <ID> --direction down        # new test pane
herdr pane run <PANE_ID> "cd <rewrite> && MOCK_URL=http://127.0.0.1:4123 NANOCODER_CONFIG_DIR=/tmp/otui-herdr-test bun run dev"
herdr pane send-text <PANE_ID> "say hello"           # literal text
herdr pane send-keys <PANE_ID> enter backspace up tab # canonical keys
herdr pane read <PANE_ID> --source visible           # LIVE screen (default "recent" is stale scrollback!)
herdr pane wait-output --match "Hello" <PANE_ID>     # wait for output
```

Key gotchas learned:
- `read` defaults to `--source recent` (scrollback), ALWAYS use `--source visible` for the live frame.
- Key names: `enter`, `backspace`, `up`, `down`, `tab`, `esc` work; `ctrl-<x>` combos are NOT supported as names, send them as literal text or the raw sequence.
- The keyword-mock must be running (`node .../mock-provider/server.mjs --port 4123`).

## herdr ↔ OpenTUI kitty-keyboard conflict (IMPORTANT)

Physical keys (Backspace, etc.) fail inside herdr for OpenTUI apps (this
rewrite AND ), while the Ink-based nanocoder works. Root cause: OpenTUI
enables the **kitty keyboard protocol by default** (`useKittyKeyboard ?? true`
in `@opentui/core`), and herdr's raw-input layer mishandles the kitty-encoded
key events (see herdr-client.log "flushing lone escape after input timeout").
`herdr pane send-keys` works because it writes raw bytes straight to the PTY,
bypassing the client key path.

FIX APPLIED: `src/index.tsx` passes `useKittyKeyboard: null` to
`createCliRenderer`, the app stays in legacy input mode (Backspace = DEL
`0x7f`), which herdr forwards exactly like the Ink app. Verified in herdr:
typing, Backspace, Enter all work with kitty disabled.

TRADEOFF: Shift+Enter multiline (A6) relied on the kitty `ESC[13;2u` sequence,
with kitty off it degrades to plain Enter. Re-add multiline later via a
non-kitty chord (Alt+Enter / Ctrl+Enter) if needed.

The automated scenario suite (`scripts/parity-check.sh all`, 89 scenarios) is
still tmux-based for CI-style text assertions; interactive/look verification
is herdr-only until the suite is ported.

- **Code review first, captures second.** A herdr `read` proves a row's text
  and layout, but not whether a spinner is *animating*; verify animation by
  reading the ticker code AND capturing the same pane at two moments (the
  glyph must change).
- Dynamic capture recipe: boot in a herdr pane, run a scenario, then
  `herdr pane read <ID> --source visible`.
- Reference captures of nanocoder's real TUI live in this repo's history:
  `/mock:bash`, `/mock:thoughtrun`, `/mock:mixed`, `/mock:tools` run in
  `nanocoder preview tui`.
- Full gate: `bash scripts/parity-check.sh all` (89 scenarios) + `bun run typecheck`.
  Status 2026-08-11: 89/89 PASS. The `interrupt` assertion now expects the
  caret BEFORE the placeholder (`❯ ▌/ commands, …`), the caret moved to
  column 0 so the old exact-match `❯ / commands…` could never match.

## Reference look (nanocoder)

Idle input box (welcome screen):

```
  ╭────────────────────────────────────────────────────────────────────────╮
  │ ❯ / commands, ! bash, ↑/↓ history                                      │
  │                                                                        │
  ╰────────────────────────────────────── preview-model[medium] · ctx ~3% ─╯
 ⏵⏵⏵ yolo mode on · tune:full ·agents:  · [/path]
```

Busy state (Working indicator ABOVE the box, spinner line inside):

```
 ⚙ Working... · 0/6 agents completed
  ╭────────────────────────────────────────────────────────────────────────╮
  │ ❯ / commands, ! bash, ↑/↓ history                                      │
  │                                                                        │
  │ ⠹ Press Esc to cancel · ctrl-o expand tool results                     │
  ╰────────────────────────────────────── preview-model[medium] · ctx ~3% ─╯
 ⏵⏵⏵ yolo mode on · tune:full ·agents:  · [/path]
```

## Current rewrite look

Idle (verified 2026-08-11, `otui-hint3`):

```
  ╭──────────────────────────────────────────────────────────────────────╮
  │ ❯ / commands, ! bash, ↑/↓ history▌                                  │
  ╰─────────────────────────────────────────────── mock-model-1 · ctx ~0% ─╯
 ⏵⏵⏵ yolo mode on · tune: full              [engr_luis …/bobonyo]
```

## Gap tracker

| # | Area | Expected (nanocoder) | Current (rewrite) | Evidence | Fix location | Status |
|---|---|---|---|---|---|---|
| GAP-1 | Input-box height | IDLE = ONE interior row (top border, prompt, bottom border). BUSY = THREE (prompt, empty, busy line). Grows for the completion menu / task overlay. Prompt/approval wizards = THREE interior rows (question, empty, cancel) | Dynamic; idle=1 ✓ busy=3 ✓ menu grows ✓ wizard=3 ✓ (prompt `Set X:` + empty + `Press Esc to cancel`) | `w1:p19` captures 2026-08-11 | `src/components/input-box.tsx` | DONE |
| GAP-2 | Busy-hint placement | Own interior row: `│ ⠹ Press Esc to cancel · ctrl-o expand tool results │` | Own row with animated braille spinner, `#565f89`; on narrow terminals (<80 cols) the trailing `tool results` is dropped so the hint never wraps (parity: nanocoder's `{isNarrow ? '' : 'tool results'}`) | `w1:p19` busy captures | `input-box.tsx` | DONE |
| GAP-3 | Empty interior row | Only present when busy (reference idle box has NO blank row) | Idle = prompt only ✓; busy = prompt + empty + busy ✓ | `w1:p19` captures | `input-box.tsx` | DONE |
| GAP-4 | Border style/color/position | Rounded `╭─╮│╰╯` in `#565f89`; box inset 2 columns; content pad 1 → `❯` at column 5 | Rounded, `#565f89`, inset matches, `❯` at column 5 ✓ | `w1:p19` captures | `input-box.tsx` | DONE |
| GAP-4b | Hint/placeholder | `/ commands, ! bash, ↑/↓ history`, left-adjacent AFTER `❯ `, ONLY when input is empty, neutral grey (chalk.grey ≈ `#808080`) | Placeholder after the caret `❯ ▌/ commands, …`, empty-only, `#808080` ✓ | `w1:p19` captures | `input-box.tsx` | DONE |
| GAP-4c | Input/transcript text color | normal/body text is WHITE (parity feedback: `#c0caf5` read as a light violet) | omnicode `colors.text` = `#ffffff`, input, markdown fg, banner values, diff context all use it; tokyo-night keeps `#c0caf5` | `w1:p1A` ANSI captures | `src/theme.ts` | DONE |
| GAP-5 | Status line | `⏵⏵⏵ yolo mode on · tune: full (auto) · model[effort] · ctx ~N% · bg: N · [user /path]`, mode `#f7768e` BOLD, separators `#565f89`, tune `#bb9af7`, model/ctx/effort/bg `#565f89`, cwd `#565f89` | Colors match; tune shows RESOLVED profile + `(auto)` on wide terminals; path shrinks to fit ONE row INCLUDING the model/ctx/agents/bg segments (a narrow pane used to clip `~N%` and the `bg: 1` digit) | `w1:p1A` + 80-col tmux captures | `src/components/status.tsx` | DONE |
| GAP-6 | Model[effort] in corner | `model[effort] · ctx ~N%`, MODEL NAME `#bb9af7` BOLD, `[effort]` + ` · ctx ~N%` `#565f89`, right-aligned in the bottom border | The model NAME is primary-bold, the effort badge + ctx stay secondary, rendered as a two-tone absolute overlay on the border line (OpenTUI `bottomTitle` is single-color), painted on the base bg so the border dashes don't bleed through the spaces. The status line uses the same split. EFFORT IS PER MODEL: catalog entry `{name, effort}`, endpoint derives from the SELECTED model; the old `MOCK_EFFORT` env seed is gone | `w1:p1A` ANSI captures | `input-box.tsx` + `status.tsx` + `config.ts` + `state.ts` | DONE |
| GAP-7 | Welcome/boot message | nanocoder shows a gradient welcome banner + hint on empty conversation | ASCII `NANOCODER` banner (` ```banner ` code block in primary) + description + hint on empty conversation ✓ | `w1:p19` boot capture | `src/components/history.tsx` | DONE |
| GAP-8 | Banner look | Mascot + fit-content box: `★ bobonyo` / `╭◕‿◕╮ model:` / `╰───╯ directory:` / `permissions:`, ALL keys on the SAME column; keys ONE color (secondary), values purpose-colored; borders + mascot + title primary | Box fits content (never full-width), keys aligned via `buildBannerBox` (pure module), keys secondary / values white / permissions warning, `/model to change` hint dim | `w1:p1A` ANSI captures | `src/banner.ts` + `src/row-highlight.ts` `tokenizeBanner` | DONE |
| GAP-9 | Working indicator | `⚙ Working... · 0/6 agents completed (8s)` above the box, animated gear ⚙↔✦ + dots | `⚙/✦ Working… · (Ns)` above the box, animated gear/dots + REAL-TIME timer formatted `xh xm xs` (verified `1m 11s` past 60s); the `agents completed` subagent counter is deferred (bobonyo tracks in-flight agents, not a completed/total pair) | two-frame captures | `input-box.tsx` + `state.ts` ticker | DONE (agents-count polish deferred) |
| GAP-10 | Spinner animation | Braille spinner rotates in the busy line | Rotates (frame ticker) ✓ | two-frame captures | `state.ts` ticker + `input-box.tsx` | DONE |
| GAP-11 | Exit hygiene | Terminal fully restored, no raw SGR/mouse leak after quit | Clean shell prompt after Esc/Ctrl+C; cleanup writes `\x1b[?1000l … ?1049l` on destroy | `otui-exit4` capture | `src/index.tsx` destroy handler | DONE, re-verify on every layout change |
| GAP-12 | Per-token shell coloring | Bash command keywords colored | DONE, bash rows render as ` ```bashrow ` code blocks tokenized by `src/highlight.ts` (keywords primary bold, commands info, strings warning, numbers success, vars info, flags warning, output secondary dim). OpenTUI 0.4.5 has no bash tree-sitter grammar, so the tokenizer produces colored chunks via `CodeRenderable.onChunks` | `w1:p1A` ANSI captures | `src/highlight.ts` + `src/row-highlight.ts` + `history.tsx` | DONE |
| GAP-13 | Diff view | Per-line red/green with FULL-ROW backgrounds; word-level darker bg only on PAIRED similar lines (0.6 change-ratio threshold), unpaired delete-only rows plain | `tokenizeFileDiff` fills the row bg to the full width, pairs remove/add runs 1:1 and word-highlights only within the threshold; the fenced leading blank (which desynced the body cursor and dropped the bg) is stripped | `w1:p1A` ANSI captures + unit specs | `src/row-highlight.ts` | DONE |
| GAP-14 | Markdown heading color | Purple headings | REVERTED: the manual TextRenderable for heading tokens caused layout instability in the single-markdown stream (the welcome line rendered as an interleaved `Welcomeetoonanocoder-…` artifact). OpenTUI 0.4.5 only styles table headers, so headings now render default color; the welcome banner covers the boot heading instead | `w1:p19` boot capture (clean `Welcome to bobonyo`) | `history.tsx` renderNode | DONE (reverted, heading color DEFERRED) |
| GAP-15 | Command suggestions | `/` menu with fuzzy match | Inline text menu inside the box, box grows to fit | `otui-hdyn2` capture | `input-box.tsx` | DONE |
| GAP-16 | Task overlay | Live task progress panel | Input-row overlay: the running task header uses the animated spinner, completed items render ✓, `computeInputBoxHeight` accounts for the rows so the box grows (parity `tasks`) | `tasks` scenario | `input-box.tsx` | DONE |
| GAP-17 | Hover | Row hover highlight; `▸` only on the clickable `+N more lines` / expand footers (not on arbitrary wrapped transcript lines) | `▸` marker now gated by `isInteractiveFooter()`, long wrapped content no longer gets an inaccurate marker; clipboard copy on drag release | `w1:p19` captures | `history.tsx` + `index.tsx` | DONE |
| GAP-18 | `❯` prompt glyph/color | `❯ ` themed | `❯ ` purple bold | captures | `input-box.tsx` | DONE |
| GAP-19 | Settings UI look | nanocoder's `/settings` renders an interactive settings page (tabs + selectors + focus) | Multi-tab modal: values in a fixed label column, gap before the footer hints, the ACTIVE-tab indicator follows the Title Shape setting (powerline-angled = filled segment, tiny = `▍`, none = `❯`) and moves when tabs change (driven by a memo, the constant `For` array was stale), Enter on option-backed rows (Theme/Title Shape/Shape/Status Line/…) opens an IN-MODAL selector (↑/↓ + Enter apply, Esc back) showing the row LABEL; modal keys never leak to the history behind it (History page keys + App exit keys + InputBox are all gated on `settingsOpen()`) | `w1:p1A` captures | `src/components/settings-panel.tsx` + `app.tsx` + `history.tsx` | DONE |
| GAP-19b | Settings modal + input | The modal backdrop covers the FULL screen, the input box and status line stay MOUNTED behind the translucent tint (dimmed, not hidden; the composer stays visible); HOVER and ↑/↓ navigation render the SAME row highlight (`❯` + info background); keys while the modal is open never reach the input/history (InputBox, History page keys/mouse and App exit keys all gate on `settingsOpen()`/`statusOpen()`) | rows use `active = selected || hovered` with one style; typing "x" went to the settings search while the input placeholder stayed untouched | `w1:p1A` captures | `src/components/settings-panel.tsx` + `app.tsx` + `input-box.tsx` + `history.tsx` | DONE |
| GAP-28 | `/status` modal | `/status` opens a MODAL (same surface as settings) listing every tracked detail: session, provider, model[effort], tune, mode, context tokens/%, directory, messages, background tasks, agents, checkpoints, skills, custom commands, steering, watchdog, stream guard, version | `StatusModal` with the "Esc close" hint in the TOP RIGHT (parity with the settings card); rows built by the pure `buildStatusRows` (unit-tested); mode error-colored, context warns >75%, bg warns while running; Esc / backdrop click closes | `w1:p1A` captures + `status-rows.spec.ts` | `src/components/status-modal.tsx` + `src/status-rows.ts` + `app.tsx` | DONE |
| GAP-29 | `/model` modal | `/model` opens the MODEL SELECTOR modal (parity: the reference model picker): providers grouped + expandable (current provider expanded), searchable, ↑/↓ navigate (list scrolls within a bounded card that never overlaps the input), Enter opens a provider / selects a model, ←/→ cycles the reasoning effort (`[minimal|low|medium|high]`), the MODEL SIZE (context window, e.g. `128K`) is right-aligned on each model row, the footer lists hotkeys incl. `C connect provider`, Esc closes | Bounded card height + scroll window on small screens; `C` closes the modal and launches the provider wizard (config is re-read on the next /model, no restart); selecting a model with a NON-EMPTY conversation shows an in-modal confirm, "Switching to X will RESEND the entire conversation… (y) continue · (n) cancel"; empty conversations switch immediately. Verified on a 24-row pane: card fits, input stays visible behind the tint, `y` applied `Switched to agy/gemini-3.1-flash-image on OmniRoute-AGY.` | tmux captures + `config.spec.ts` | `src/components/model-modal.tsx` + `src/config.ts` + `src/nanocoder-paths.ts` + `src/session.ts` + `app.tsx` | DONE |
| GAP-30 | Exit/completion/busy status + tool-call XML | (1) The exit confirmation (`Press Ctrl+C again to exit…`) EXPIRES after ~6s; (2) the completion line (`✦ Worked for a snappy 16s. · N tokens`) renders as a STATIC secondary line ABOVE the input (diamond glyph, same slot as the Working indicator) instead of a transcript row, and expires; (3) the in-box busy hint (`⠇ Press Esc to cancel · ctrl-o expand tool results`) is REMOVED, `Esc to cancel` now sits beside the Working indicator and the ctrl-o hint is gone; (4) tool calls streamed as TEXT in the plain `<tool_calls><invoke name="Bash"><parameter string="0">…` dialect (non-mock providers) parse into real tool calls, positional `string="N"` params map through each tool's arg order, alongside the existing antml dialect | Verified: `✦ Working. · (3s) · Esc to cancel` above input during a run with NO in-box hint; completion line above input; parser unit-spec'd for both dialects | `w1:p1A` captures + `client.spec.ts` | `src/app.tsx` + `src/components/input-box.tsx` + `src/state.ts` + `src/client.ts` | DONE |
| GAP-31 | Model modal, current provider + headers | The `/model` modal no longer expands/collapses providers, the CURRENT provider is pinned to the TOP with a header-style label and its models listed flat (parity: the reference grouped list) | Provider rows render as primary-bold headers (not selectable); ↑/↓ skip headers and move between model rows; context length stays right-aligned | tmux + herdr captures | `src/components/model-modal.tsx` | DONE |
| GAP-32 | Input affordances | Slash suggestions get a `[Command]`/`[Skill]` prefix + a description column and are mouse-clickable (same hover/click style as settings rows); `@` suggests project FILES (bounded walk, mouse+keyboard, inserts the path); terminal paste converts image paths to `[Image #N]` and long text to `[Text #N]` (expanded on submit); the welcome tip points to `ctrl+p`/`/`/`@` and DYNAMIC tips rotate once a turn has been Working >10s | Verified: `/` rows show `[Command] /help … Show this help`; `@` lists `@bun.lock`, `@src/…`; `[Image #N]`/`[Text #N]` unit-spec'd | herdr captures + `attachments.spec.ts` | `src/components/input-box.tsx` + `src/commands.ts` + `src/mentions.ts` + `src/attachments.ts` + `history.tsx` | DONE |
| GAP-33 | Status polish | Working indicator is PRIMARY and turns WARNING with `retrying (n)` during provider backoff (429/stall); a bottom gap separates the transcript from the Working line; user messages no longer paint a stray highlighted blank above them; the settings option selector is a CLEAN options-only card (label only in the title, ONE footer); Capabilities/Model rows open the model modal; reasoning deltas accept `reasoning`/`thinking` field names (real providers) | Verified: `✦ Working... · (2s) · Esc to cancel` in primary; clean selector card (`Shape … Esc back`, options, one footer); Model row in Capabilities opens the picker | herdr captures | `src/state.ts` + `src/client.ts` + `src/app.tsx` + `src/components/input-box.tsx` + `src/components/settings-panel.tsx` + `src/row-highlight.ts` | DONE |
| GAP-34 | Reply prefix / status / suggestions / removals | (1) Assistant replies render with a `✦` prefix as the left indication; (2) the status line drops model[effort]/ctx (the input corner already shows them), it keeps mode · tune · agents/bg · cwd; (3) suggestion rows: built-ins carry NO `[Command]` tag (only custom/skill entries do), the tag renders beside the RIGHT-side description, the command name is WHITE and the left marker secondary; Tab on a suggestion inserts the NAME (was `/[object Object]`); (4) `@` file suggestions navigate by keyboard AND mouse (selection folded into the item array); (5) settings row clicks select; (6) Capabilities model picker has an `Inherit main agent model` row; (7) the Shape + Alternate Screen settings are REMOVED (the banner is the fixed tiny-mascot box); (8) the welcome tip highlights hotkeys in bold | Verified live: `✦ Hello from the mock provider!`; status `⏵⏵⏵ yolo mode on · tune: full`; `/help` row name white + marker secondary + right description; Inherit row first in the settings model modal; no Shape/Alternate rows | herdr + tmux captures | `src/components/history.tsx` + `src/components/status.tsx` + `src/components/input-box.tsx` + `src/components/model-modal.tsx` + `src/components/settings-panel.tsx` + `src/banner.ts` + `src/settings.ts` + `src/state.ts` + `src/index.tsx` | DONE |
| GAP-35 | Goodbye screen + launcher + glyph polish | (1) On exit the app prints the mascot banner WITHOUT the box border + `Session <name> - <ISO timestamp>` and `Continue  bobonyo -s <id>` (parity: the reference exit banner); (2) a global `bobonyo` launcher at `~/.local/bin/bobonyo` runs `bun run src/index.tsx "$@"` from anywhere, plus a `bun build` script that compiles a standalone binary (the binary has an OpenTUI tree-sitter asset limitation, the launcher is the release path); (3) the reply `✦` is DIM (rendered via `~✦~` strikethrough→dim) and BLINKS while the response streams; (4) the tip hotkeys are bold + PRIMARY (markup.strong → primary); (5) user messages get a bg-free breakline before them | Verified: `/exit` prints the goodbye; `bobonyo --preview tui` works from any cwd; reply ✦ dim in ANSI | tmux captures | `src/app.tsx` + `src/index.tsx` + `src/components/history.tsx` + `src/syntax.ts` + `package.json` + `~/.local/bin/bobonyo` | DONE |
| GAP-36 | Alias / resume / clicks / tokens | (1) `bobonyo` runs the DIST release launcher (from any cwd) and `bobonyo --dev` runs the source, the compiled binary is blocked by an OpenTUI+bun-compile JSX-transform incompatibility (documented in `scripts/build.mjs`); (2) the exit message says `Continue  bobonyo --resume <id>` and resume ACTUALLY loads real nanocoder sessions (sessions live in the DATA dir; the OpenAI-style files are converted to bobonyo rows with tool calls/attachments); (3) settings row/option clicks select/apply (handlers moved to the row boxes); (4) Shift+Enter creates newlines in the multi-line input (CSI-u `\x1b[27;2;13~`); (5) `[Command]`/`[Skill]` tags and `[Image #N]`/`[Text #N]` tokens render PRIMARY in the input, and backspace deletes a WHOLE token (atomic blocks) | Verified: resumed a 1377-message nanocoder session; SGR click moved `❯` and applied an option; `[Text #3]` backspace deleted the token; `bobonyo` boots from /tmp | tmux + herdr captures + `session.spec.ts` | `src/session.ts` + `src/app.tsx` + `src/components/settings-panel.tsx` + `src/components/input-box.tsx` + `scripts/build.mjs` + `~/.local/bin/bobonyo` | DONE |
| GAP-37 | Resume modal / connect / compact / tasks / agents | (1) `/resume` opens a MODAL grouped by date headers (Today / Yesterday / This week / Older, modal-style) with ↑/↓+Enter and mouse; EMPTY conversations are never saved and are filtered from the list; (2) `/connect` runs the provider wizard; (3) Tab uses the HIGHLIGHTED suggestion (same as Enter); `/quit` is an ALIAS of `/exit` in suggestions; (4) the task overlay's header is the CURRENT task with an animated spinner (done items get ✓); (5) a new `/mock:compact10` scenario shows `✦ Ran Bash ×10`; (6) two default agents `general` + `explore` with type-specific system prompts; (7) Shift+Enter now also accepts Ctrl+J and a literal LF newline (nanocoder PR parity) | Verified: `/resume` modal groups sessions by date and resumes; `/connect` opens `Provider id:`; typing `/qui` suggests `/exit`; `✦ Ran Bash ×10` renders; task overlay shows ○/✓ items | tmux captures | `src/components/resume-modal.tsx` + `src/session.ts` + `src/commands.ts` + `src/components/input-box.tsx` + `src/tools.ts` + mock server | DONE |
| GAP-20 | Modal selectors | nanocoder renders pickers (model / provider / session / command menu) as focused MODAL selectors with a border, selected-item marker (`▸`), ↑/↓ navigation, Enter/Esc | All pickers are now MODALS: `/model`, `/settings`, `/status`, `/resume`, and the built-in Agents list render as centered translucent-backdrop cards with ↑/↓+Enter+Esc, mouse hover/click, bounded card heights and windowed lists that never overflow | herdr captures | `model-modal.tsx` + `settings-panel.tsx` + `status-modal.tsx` + `resume-modal.tsx` + `agents-modal.tsx` | DONE |
| GAP-21 | Preview-mode render parity | `nanocoder preview tui` renders every mock scenario, the REWRITE must render each scenario's rows with the same look | `/mock:<name>` commands drive the REAL pipeline. FIXED this session: (1) the rewrite spawns the mock server with `--log` (it previously resolved the missing flag to `process.argv[0]` and every request hung on ETXTBSY writing to the running node binary); (2) the mock's `afterTool` rule only fires for tool-loop continuations; (3) script rules match the LAST real user message (skipping `<diagnostics-summary>`) and stop after exhaustion (no last-step loop); (4) `/mock:diff` now emits write_file/string_replace script calls so it renders numbered file-create/edit/delete previews instead of a raw git diff --stat; (5) the `make diff` rule RESETS its scratch files on first activation so repeated `/mock:diff` runs are deterministic (the executed string_replace otherwise fails on the previous run's file state). Verified in herdr: md long ×2, bash (highlighted), thoughtrun, tools, file diffs (twice in a row), confirm, skills | `w1:p1A` captures | `src/index.tsx` spawn + `nanocoder/tools/mock-provider/server.mjs` matchRule + `src/tool-display.ts` | DONE for the verified scenarios |
| GAP-23 | `/mock:*` availability | The preview scenario commands exist ONLY in `bobonyo preview tui`, a normal run must not suggest them and must refuse to run them | `commandNames()` includes the mock catalog only when `isPreviewTui()`; `runCommand` shows "only available in preview mode" otherwise. Unit-spec'd | dev-mode + preview captures | `src/preview.ts` + `src/commands.ts` + `input-box.tsx` | DONE |
| GAP-24 | Trust gate + hover + modal key isolation | First-run trust prompt must NOT silently continue when unanswered (Esc = decline/exit); hover must react only to the block under the cursor (±1 row, not 2-3 rows away); keys while a modal is open must never affect the history behind it | `pendingPrompt.onCancel`, the trust gate exits on Esc; hover window tightened from ±3 to ±1 in click+move; History page keys / mouse handlers + App exit keys gated on `settingsOpen()` | code + `w1:p1A` captures | `src/state.ts` + `input-box.tsx` + `app.tsx` + `history.tsx` | DONE |
| GAP-25 | User-message background | The WHOLE row of each user message is backgrounded, 5 lines means 5 full highlighted rows, not just the text runs | `tokenizeUserMessage` fills the row bg (`#2a2a2a`) across the full width including continuation lines and padding (same fill pattern as the diff rows) | `w1:p1A` ANSI captures + `row-highlight.spec.ts` | `src/row-highlight.ts` + `history.tsx` | DONE |
| GAP-26 | Settings ↑/↓ navigation | ↑/↓ must move the selected row (and the selector option highlight) | Fixed: the OpenTUI reconciler's `<For>` only re-renders when the `each` array reference changes, so `settingsIndex()`/`hovered`/`optionIndex` read inside the children were stale, folded into memo-derived item arrays | `w1:p1A` captures | `src/components/settings-panel.tsx` | DONE |
| GAP-27 | Code-diff gaps + resize | Diff rows render ONE row per logical line (no blank walls) AND the row background follows the pane width IMMEDIATELY on resize (no focus-out/in needed) | Two root causes: (1) the row-bg fill padded to `terminalWidth - 2` but the markdown container is `terminalWidth - 3` (root padding 2 + scrollbar 1), every padded row wrapped into a second blank row; `historyFillWidth()` targets the real width. (2) OpenTUI's CodeRenderable never re-runs `onChunks` on resize, so old-width padding lingered, the History memo now reads the width and embeds it in the full-row-bg fence markers (`filediff:done:w107`), so a resize changes the doc → the block re-creates → fresh chunks. Verified: row length == pane width right after `herdr pane resize` / `tmux resize-window` with no interaction | herdr + tmux resize captures + `history-width.spec.ts` | `src/history-width.ts` + `history.tsx` | DONE |
| GAP-22 | Backspace across all input states | Backspace must work in every state (normal, placeholder, prompt forms, approval, completion menu, multiline) and for EVERY encoding a terminal/herdr client may send (DEL `0x7f`, BS `0x08`, CSI-u `ESC[127;Nu`, and DELETE `ESC[3~`) | FIXED, input handler now treats BOTH `backspace` AND `delete` as backward delete in normal + prompt + approval modes; verified in herdr for `backspace`, `0x7f`, `0x08`, `ESC[127;2u`, `ESC[3~` | herdr pane `w1:pH` captures | `src/components/input-box.tsx` | DONE, user must RESTART the app pane (`bun run dev` is NOT watch mode) to pick up the fix |

## Detailed specs for the user-requested surfaces (GAP-19/20/21)

### GAP-19, Settings UI (`/settings`), reference: `nanocoder/source/app/components/settings-tabs.tsx` + `settings-selector.tsx`

Reference behavior:
- Tabbed panel: tabs are `Appearance · Input · Behavior · …` (TABS array), switched with **←/→**; each tab renders a set of SELECTOR PANELS stacked vertically.
- Panel list rows: selected/focused row text is `colors.info` (#bb9af7) + **bold**; unselected rows are `colors.text` (#c0caf5), `rowColor = selected ? colors.info : colors.text`.
- Panel headers are `colors.primary` (#bb9af7) bold; each panel has a border: `borderColor = focused ? colors.primary : colors.secondary`, the focused panel's border is PRIMARY, others SECONDARY (#565f89).
- A search box renders `⌕ ` in `colors.secondary`; the query in `colors.text`; placeholder in secondary; "No settings match \"query\"" in secondary.
- Footer hints in `colors.secondary`.
- Keyboard: ↑/↓ move selection, Enter edits (opens the value editor), ←/→ switch tabs, Esc closes.

Rewrite status: DONE (2026-08-11), `/settings` opens a focusable tabbed
panel (`src/components/settings-panel.tsx`): tabs row (primary when active,
secondary otherwise), `▸`-marked selected row in primary bold, rows in text
color, footer hints in secondary; ←/→ tabs, ↑/↓ rows, Enter opens the value
editor as an input-box wizard, Esc closes. The panel carries an EXPLICIT
`height` because OpenTUI 0.4.5 collapses a bordered column box to a single
interior row otherwise (same root cause as GAP-1). `Providers` tab lists the
configured providers; the richer per-panel selector surfaces (search box,
per-panel focused borders) remain a future refinement.

### GAP-20, Modal selectors (model / provider / session / command menu)

Reference:
- **Command completion menu** (`user-input.tsx` `commandCompletionWindow`): rendered INSIDE the input box under the prompt; each row is `▸ /name` for the selected item (marker `▸ `, name in `colors.info` #bb9af7 + bold) or `  /name` in `colors.secondary` (#565f89); the description follows in secondary; ↑/↓ navigate, Enter selects, Esc dismisses.
- **Model selector** (`model-selector.tsx`): a bordered box with `borderColor = hasModels ? colors.primary : colors.error` (#bb9af7 / #f7768e); ←/→ move between the provider column and the model column, ↑/↓ select within a column, typing filters ("Type to filter…" in secondary); highlighted model in `colors.primary`, others `colors.text` (#c0caf5); the provider/effort badges in primary/secondary.
- **Session resume picker**: the `--resume` list uses the same select-style (highlighted item in primary, `▸` marker).

Rewrite status: `/` menu is an INLINE text list inside the box that grows the
box height (works, but no `▸` marker / primary highlight on the selected row
yet); there is no bordered model/session picker modal, `/model` prints text.
NOT DONE, needs a bordered selector modal (GAP-20).

### GAP-21, Preview mode (`nanocoder preview tui`) render parity

Reference: `nanocoder preview tui` (backed by `source/app/previews/subagents-preview.tsx`) registers these mock commands, each rendering through the REAL live-chat components:

`/mock:agents` `/mock:bash` `/mock:bg` `/mock:confirm` `/mock:diff` `/mock:innerdaemon` `/mock:md` `/mock:mixed` `/mock:model` `/mock:scenario` `/mock:settings` `/mock:skill` `/mock:steering` `/mock:subagents` `/mock:tasks` `/mock:thoughtrun` `/mock:tools [tool ...]`

The rewrite's parity suite covers the same scenarios by keyword prompt, but only asserts TEXT, the per-scenario ROW LOOK (bash wrap indents, thought preview, compact blocks, diff colors, settings panel, modal) is not yet compared scenario-by-scenario. NOT DONE, add a per-scenario visual comparison (capture the rewrite vs `nanocoder preview tui` at the same pane size and diff the frames + colors).

> 2026-08-11: parity SUITE runs are no longer the gate, we are in gap
> refinements. Visual/behavioral regressions are covered by unit specs
> (`bun test`); the suite is only a manual spot-check now.

## Known OpenTUI 0.4.5 limitations (not rewrite bugs)

- Inline spans (`` `code` ``, `**bold**`) whose closing delimiter sits at
  end-of-line DROP the closing delimiter + any following text. Worked around
  by avoiding inline spans at EOL (bash commands are plain text).
- `markup.heading` is only applied to table headers. A manual `renderNode`
  TextRenderable for headings caused layout instability in the single
  markdown stream (interleaved welcome text) and was REVERTED, headings
  render default color for now; the boot banner is a ` ```banner ` code block
  instead.
- A `<box>` with `border` + `flexDirection="column"` children does not always
  stack interior rows (GAP-1, settings panel). Workaround: give the bordered
  box an EXPLICIT `height` equal to the row count (borders + rows), as the
  input box and settings panel now do.

## Next steps (in order)

1. All pickers are MODALS (GAP-20 done): `/model`, `/settings`, `/status`,
   `/resume` and the built-in Agents list render as centered cards with
   bounded heights + windowed lists (they never overflow), ↑/↓ + Enter + Esc
   and mouse hover/click.
2. The two-tone `model[effort] · ctx ~N%` bottom-border badge (GAP-6) is
   implemented as a two-color absolute overlay on the border line.
3. The Working indicator timer formats as `xh xm xs` (GAP-9 done); the
   `0/N agents completed` subagent counter is DEFERRED (bobonyo tracks
   in-flight agents, not a completed/total pair).
4. GAP-21 per-scenario visual diff vs `nanocoder preview tui` is no longer
   the gate (2026-08-11): unit specs (`bun test`) cover the behavior; the
   parity suite is only a manual spot-check.
5. Keep `bun test` + `bun run typecheck` green after each change; update
   this table's status column as items close.

## 2026-08-11 round (user feedback), implemented

- **Blinking caret**, the input caret toggles ▌/space every 400ms via the
  spinner ticker (space keeps the placeholder from shifting).
- **Theming**, `src/theme.ts` (Colors/Theme, omnicode + tokyo-night); every
  component reads `colors()` reactively in JSX (no hardcoded hex); the
  Settings Appearance → Theme row switches palettes live and persists;
  syntax styles + row tokenizers derive from the active palette.
- **Bash syntax highlighting**, custom tokenizer (`src/highlight.ts`) with
  keywords/commands/strings/variables/numbers/flags; bash rows render as
  ` ```bashrow ` code blocks tokenized via `CodeRenderable.onChunks`.
- **File create/edit previews**, `write_file` renders numbered,
  syntax-highlighted content (` ```filerow `); `string_replace`/`diff_edit`
  render an old→new line diff with line numbers (` ```filediff `, LCS-based
  `lineDiff`). Declined/blocked results fall back to the generic tail.
- **Tool rows**, `✦` glyph color by status (green done, secondary
  running/background), blink while running; tool NAME primary bold; `(...)`
  detail secondary; `└` container content secondary/dim with `+N more lines`
  footers. Rendered via per-kind code-block tokenizers (toolrow/bashrow/
  filerow/filediff/diffrow/agentrow/grouprow/thought).
- **Click-to-toggle**, fence markers + collapsed margins shift the doc-line
  index, so clicks match the NEAREST captured block range (±2 rows) instead
  of a raw index.
- **Settings value editor**, Esc cancels, Enter applies; opening defers a
  microtask so the opening Enter isn't consumed as the submit.
- **Busy hint truncation**, on narrow terminals (<80 cols) the trailing
  `tool results` is dropped so the hint never wraps (parity: nanocoder's
  `{isNarrow ? '' : 'tool results'}`).
- **Queued messages**, messages typed while a turn streams render as a
  persistent `Queued messages` block ABOVE the input (parity: nanocoder's
  queuedBlock) instead of a transcript row that scrolls away; ↑/↓ select a
  queued item (`▸` marker), Enter loads it back into the input for editing
  and removes it, Del removes it. This also fixed the parity suite's flaky
  `queue` scenario (the row is now visible the whole busy period).
- **Mock diff determinism**, the `make diff` rule RESETS its scratch files
  on first activation so repeated `/mock:diff` runs are deterministic.

## Second feedback round (same day), implemented

- **Markdown tables**, the transcript `<markdown>` now passes
  `tableOptions={{style: 'grid', borders: true, widthMode: 'content'}}` so
  tables render as boxed, content-fit tables (parity: nanocoder's
  cli-table3) instead of plain spaced columns.
- **Command-completion popup**, typing `/` opens an modal-style BORDERED
  popup above the input: `▸ /name` for the selected row (primary bold), the
  rest secondary; ↑/↓ navigate, Enter selects, Esc dismisses. Typing a full
  `/command` + Enter RUNS it (the popup only intercepts partial matches).
  Esc no longer quits the app while text is in the input.
- **Tool animations**, `/mock:bash` runs a 16-line stream (~3s) so the
  output visibly tails; web_search/fetch_url/find_files/list_directory/
  git_* now stream their results line-by-line through onProgress (the
  settled row still returns the full content). web_search/fetch_url return
  the SAME canned results as `nanocoder preview tui`.
- **Agent header color**, `✦ Ran agent:explore(<task>) completed`: ONLY
  `agent:explore` is primary bold; `Ran `, `(<task>)` and the status are
  secondary.
- **Thought color**, the `⚙ Thought (Ns)` header is secondary/dim (muted),
  matching the collapsed reasoning preview.
- **git_diff consistency**, the header now synthesizes the invocation
  (`✦ git_diff(git diff --stat)`), the output sits under a `└` container
  with a `+N more lines (ctrl + t to view transcript)` footer, like every
  other tool row.
- **Block spacing**, every fenced row carries a leading blank INSIDE the
  fence (OpenTUI collapses the blank separator at code-block boundaries);
  the transcript now has consistent one-line gaps between user/thought/
  tool/assistant blocks.
- **Hover/click on `+N more lines`**, the click/hover row mapping is now
  exact (the between-part separator before fenced blocks was removed, so the
  doc index matches the rendered row); the footer highlights with `▸` on
  hover and expands/collapses the specific row locally (each tool row got a
  blockKey instead of the global toggle).
- **Scroll-to-bottom**, verified the sticky scrollbox follows the stream,
  re-sticks after manual scroll, and stays at the bottom on settle.

## Third feedback round, implemented

- **Renamed the project to `bobonyo`**, folder, package.json name, config
  dirs (`~/.local/share/bobonyo`, `/tmp/bobonyo-preview`), welcome banner
  (BOBONYO ASCII art), welcome text, about strings, and the global
  shortcuts (`bobonyo` / `bobonyo-preview`; `otui`/`otui-preview` kept as
  aliases).
- **Settings completeness**, the settings surface now mirrors the original's
  SIX tabs (`Appearance · Input · Behavior · Capabilities · Providers ·
  Advanced`) and lists every setting the rewrite actually supports: Theme,
  Tool profile, Alternate screen, Max messages, Paste threshold, Mode,
  Auto-compact, Reasoning traces, Sessions/checkpoints, Skills, Custom
  commands/tools, Background tasks, Agents, Vision/Web-search model rows,
  Providers, MCP servers, Tool approval, Steering (InnerDaemon), Watchdog,
  Stream guard, Privacy patterns, Trusted directories, Developer mode, and
  Model. `watchdog`/`streamGuard` are editable via the value editor.
- **Shift+Tab cycles modes**, yolo → normal → plan → auto-accept → yolo
  (persisted).
- **All `/mock:*` commands registered**, every mock scenario now appears in
  the `/mock:` completion popup (tasks, web, write, git, skill, bg, error
  mocks, …) plus `/mock:model` and `/mock:settings` routed to their surfaces.
- **Compacted tool color**, `✦ Ran WebSearch ×2 and WebFetch (ctrl-o to
  expand)`: `Ran `, `×N`, `and`/`, ` and the hint are secondary; ONLY the
  tool names are primary bold.
- **Click-to-expand tightening**, only explicit toggle targets respond (the
  `+N more lines` footer, `(ctrl-o to expand/collapse)` hints, `✦ Ran …`
  headers, `⚙ Thought` headers); a click anywhere else in the history does
  nothing.
- **Slower glyph blink**, running glyphs toggle every 500ms (parity with the
  original ToolGlyph) instead of the previous 400ms, so streaming rows no
  longer feel like they're blinking excessively.

## Fourth feedback round, implemented

- **User message background**, `❯ content` rows render as surface-filled
  blocks with the `#2a2a2a` background (parity: nanocoder's arrow-style
  UserMessage `ICON_PROMPT_HISTORY_BACKGROUND`); the `❯ ` prompt is primary
  bold, the content stays text-colored.
- **Persistent container hover + click**, the WHOLE tool/thought container
  (header, `└` output, footer) now shows a persistent `#565f89` background
  while the cursor is over any part of it (no more flash, the old per-row
  `▸` marker that re-parsed on every mouse move is gone), and clicking
  ANYWHERE inside the container expands it; clicking again collapses it
  (the `(ctrl-o to collapse)` footer is the "show less" button). Plain
  transcript text (user rows, replies, diagnostics) is not clickable.
- **Settings as a centered modal**, `/settings` opens the panel CENTERED on
  the screen (modal-style dialog), hiding the chat history, input box and
  status line while it is open (←/→ tabs, ↑/↓ rows, Enter edit, Esc close).

## Fifth feedback round, implemented

- **Settings modal is now modal-style**, a full-screen translucent
  backdrop (`RGBA(0,0,0,150)`) keeps the CHAT VISIBLE behind it while
  dimmed, and a card container (panel background + rounded primary border)
  sits centered near the top quarter. BOTH mouse and keyboard drive it:
  clicking a tab switches tabs, clicking a row selects it, clicking the
  dimmed backdrop closes, and ←/→ ↑/↓ Enter Esc still work. It also opens
  via **Ctrl+P** (like the reference command palette). The input box and status
  line are hidden while it's open; the history keeps its full height.

## Sixth feedback round, implemented

- **modal-style exit**, Ctrl+C clears the input first; with an empty
  input it shows `Press Ctrl+C again to exit · resume with \`bobonyo --resume
  <sessionId>\`` and only exits on the next press (Esc behaves the same).
  Typing resets the confirmation.
- **Simple start banner**, the welcome is now a Codex/Claude-style box:
  `╭───╮ ★ bobonyo (v0.1.0) / ╭◕‿◕╮ model: … / ╰───╯ directory: … /
  permissions: … ╰───╯` plus a tip line, sized to the terminal width. The
  mascot and box come from the new `Nanocoder Shape` / `Title Shape`
  settings (titleShape `none` drops the box).
- **Settings search + auto-navigation**, the modal now has a `⌕ Search
  settings…` box ABOVE the tabs (faithful to nanocoder's settings-tabs:
  rounded border, ⌕ prefix, placeholder, empty-query cursor). Typing filters
  the ACTIVE tab's rows by fuzzy score on label + id (exact > startsWith >
  contains > subsequence) and AUTO-NAVIGATES to the first tab that has
  matches. Rows render like the original: `❯ ` marker, label + value,
  `No settings match "query"` empty state, footer hints.
- **Editable cosmetic settings**, Appearance now includes Title Shape,
  Shape (mascot), Status Line (on/off toggles the footer) and Alternate
  Screen (on/off toggles the screen buffer), all persisted and live.
- **Capital-letter typing fixed**, OpenTUI reports shifted letters as
  `{name:'s', shift:true}`, which dropped the case; the input and settings
  search now preserve it.

## Seventh feedback round, implemented

- **mock:diff**, the mock new-file is now a 54-line TSX component so the
  collapsed preview exercises `… +4 more lines (ctrl + t to view
  transcript)`; file/diff rows no longer get the container hover tint;
  old→new diff rows carry per-row green/red backgrounds
  (`diffAdded`/`diffRemoved`); and only the action name (Write/Edit) is
  primary bold, the file path stays secondary.
- **Built-in tree-sitter highlighting**, OpenTUI's grammar DOES work (the
  client needed the code-token styles in the syntax style): ` ```ts ` /
  ` ```js ` file previews now highlight through the real tree-sitter tokens
  (keywords primary bold, strings warning, numbers success, types info,
  comments secondary italic). The write preview splits the `filerow` header
  from a real-language code fence so the parser only sees code.
- **Settings tabs active indicator**, the active tab renders as a filled
  `info`-background segment with base-colored text (powerline-style
  indicator), and inactive tabs are plain secondary labels.
- **mock:tasks todo list**, `/mock:tasks` now renders a real task list:
  `✦ Tasks (N done, M in progress, K open)` + per-task `◐/✓/○` status icons
  (in-progress warning, done success, open secondary), reading the LIVE task
  signal so a running row animates its states.
- **Settings mouse + spacing**, rows/tabs are clickable across the WHOLE
  row (not just the label text), hovering a row highlights it (secondary bg),
  and the card got proper padding plus blank-line gaps between the search
  box, tab bar and row list.

Full gate 2026-08-11: `parity-check.sh all` = **90/90 PASS** and
`tsc --noEmit` clean.

## Latest gap-refinement round, implemented

- **Real-time timer format**, Working + Thinking headers render `52s`,
  `1m 11s`, `1h 2m 3s` via a shared `formatElapsed` (never a bare seconds
  count past 60; verified live at `1m 11s`).
- **"Worked for…" completion line**, shows after EVERY turn: the text branch
  sets it as before, plus a post-loop fallback covers tool-only turns, and
  the display window is 8s.
- **Expanded bash rows no longer highlight**, hover tint is gated on
  `hasFooter && !expandedBlocks[key]` so a clicked-open block (even with a
  residual long-output footer) never gets a whole-block tint.
- **opencode references removed**, all "opencode" mentions (README, source
  comments, docs) are gone; the project credits OpenTUI + nanocoder only.
- **Em-dash sweep**, README rewritten at high-school reading level with
  commas/semicolons; source comments + docs + user-facing strings cleared of
  em-dashes.
- **Toast notifications**, setting changes (model/provider/mode/fallback
  switches) render as a transient top-of-screen toast instead of chat rows.
- **Diagnostics noise**, `lsp_get_diagnostics` only surfaces/injects when
  there are FINDINGS; a clean pass appends nothing.
- **Codex-style LLM compaction**, `/compact` + auto-compact send a separate
  summarization request (codex prompt + prefix) and replace the history with
  the summary + recent user prompts; auto-compact defers until the turn
  settles and never interrupts.
- **Resume modal grouping**, date headers get blank lines before/after,
  duplicate "Today" fixed (timestamp normalization + dedupe by id), and each
  row shows relative "how long ago"; the model modal mirrors the header
  spacing and aligns the effort column.
- **Suggestions + settings search**, the `/` menu is borderless with a
  scrollable 6-row window and a fixed description column; settings search
  hides non-matching tabs and arrow navigation never clears the query.
- **Fallbacks + harness**, web-search fallback (native Responses-API search
  with the chat indicator) and vision fallback preference are configurable
  from Settings → Capabilities; `savePreferences` merges; OpenAI requests
  carry the standard `tools` + `tool_calls` shape; `context` syncs after
  every turn (cache warm on resume); MCP/LSP rows in `/status`; post-open
  lazy loading with a spinner; built-in Agents modal (General/Explore).

Gate: `bun test` (100 pass) + `bun run typecheck` clean.
