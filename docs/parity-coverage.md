# Nanocoder → OpenTUI parity coverage

Status legend:

- ✅ **Implemented**, behavior is present and proven by a parity scenario or
  a direct tmux check in `scripts/parity-check.sh`.
- 🟡 **Partial**, the core behavior exists; documented edge cases remain
  (each row names what is missing).
- ⛔ **Not yet**, not implemented in the rewrite.

The authoritative contract is `../nanocoder/docs/business-logic/cli/`
(feature tables A1-A9, B1-B25, D1-D7, C1-C16, E1-E9, F1-F8) and
`../nanocoder/docs/business-logic/mock-scenarios.md` (scenarios 1-28).
Parity scenarios are driven by `scripts/parity-check.sh all` (82 scenarios).

## Mock scenario catalog (28 + 2 future)

| # | Scenario | Rewrite | Proves |
|---|---|---|---|
| 1 | hello | ✅ | text stream + settled render |
| 2 | md | ✅ | streaming markdown, formatted live |
| 3 | mdlong | ✅ | long markdown grows to the tail |
| 4 | tool | ✅ | read_file real execution + afterTool reply |
| 5 | bash | ✅ | execute_bash tool row + output tail |
| 6 | multi | ✅ | two tool calls execute |
| 6b | compact | ✅ | same-family calls collapse (`✦ Ran WebSearch ×2`), Ctrl+O expands/collapses per-call |
| 6c | compactmixed | ✅ | cross-tool family join (`✦ Ran WebSearch and WebFetch`) |
| 7 | sequence | ✅ | multi-turn script chain |
| 8 | web | ✅ | web_search tool row |
| 9 | write | ✅ | write_file real write |
| 10 | git | ✅ | git_status real output |
| 11 | skill | ✅ | skill tool row |
| 12 | pr | ✅ | PR link capture + `/tool:open-prs` |
| 13-16 | error/401/403/404 | ✅ | HTTP error classification rows |
| 17 | ratelimit | ✅ | 3 client retries, 4th succeeds |
| 18 | empty | ✅ | nudge-retry flow, no crash |
| 19 | miderror | ✅ | mid-stream error frame surfaces |
| 20 | think | ✅ | reasoning stream → Thought block |
| 21 | reasoningonly | ✅ | thought kept + fallback, no crash |
| 22 | long | ✅ | long reply wraps, no truncation |
| 23 | usage | ✅ | token accounting in footer |
| 24 | malformed | ✅ | invalid args → validation error |
| 25 | cachehead | ✅ | stable system block in request log |
| 26 | stall | ✅ | stall retry (2), then success |
| 27 | bg | ✅ | 15s handover + `bg: N` + completion row |
| 28 | agent | ✅ | nested subagent conversation at the mock |
| future | bgdone | ✅ (inside `bg`) | completion notification after exit |
| future | clearrun | ✅ | `/clear` cancels an in-flight run |
| extra | help | ✅ | `/help` command catalog renders |
| extra | bashbang | ✅ | `!cmd` → `✦ Executed Bash(cmd)` row, no LLM call |
| extra | retry | ✅ | `/retry` re-issues the last prompt (mock sees it twice) |
| extra | sessions | ✅ | create → `/clear` → list → `/resume <index>` |
| extra | compactcmd | ✅ | `/compact` mechanical reduction report |
| extra | queue | ✅ | chat sent mid-stream queues then auto-submits |
| extra | slowbash | ✅ | bash tool row streams its output tail LIVE mid-run |
| extra | tasks | ✅ | `write_tasks` renders a numbered task block |
| extra | providers | ✅ | config file + `--provider` selection, model validation, log proves the model |
| extra | discovery | ✅ | `modelDiscoveryUrl` → `/v1/models` replaces the static list |
| extra | glob/lsdir | ✅ | find_files (`✦ Find`) + list_directory (`✦ LS`) |
| extra | gitlog/makediff | ✅ | git_log + git_diff `--stat` through the registry |
| extra | editfile | ✅ | string_replace replaces + previews the file |
| extra | mouse | ✅ | SGR click expands the compact block, click again collapses |
| extra | alt | ✅ | `--alt-screen` boots into the alternate screen buffer |
| extra | approve/decline | ✅ | `--mode normal` gates mutation tools behind a y/n prompt; decline cancels |
| extra | nano | ✅ | `--profile nano` rejects out-of-profile tools |
| extra | cap | ✅ | `maxMessages` keeps the provider context at the cap (log-proven) |
| extra | naturalend | ✅ | completed turn appends `Worked for a <adjective> <elapsed>.` |
| extra | customcmd | ✅ | frontmatter command substitutes args and runs its body as a prompt |
| extra | customtool | ✅ | markdown-defined tool registers and executes |
| extra | skillmd | ✅ | skill tool reads a SKILL.md from the config dir |
| extra | ctx | ✅ | non-zero ctx% from a small provider context window |
| extra | xmltool | ✅ | XML function calls streamed as text are parsed + ghost-stripped |
| extra | interrupt | ✅ | Esc mid-stream commits the partial + `Interrupted by user.`, app stays alive |
| extra | autocompact | ✅ | ctx% crossing the threshold triggers mechanical compaction notice |
| extra | wizard | ✅ | `/setup-providers` guided flow writes providers.json |
| extra | mode | ✅ | `/mode plan` switches live and excludes mutation tools |
| extra | prefs | ✅ | last provider+model persist and restore across restarts |
| extra | anthropic | ✅ | `sdkProvider: anthropic` → `/v1/messages` + cache_control breakpoints |
| extra | openrouter | ✅ | provider options land in the request body (log-proven) |
| extra | cachekey | ✅ | `promptCacheKey` sends the namespaced prompt_cache_key |
| extra | repeat | ✅ | identical tool signature ×3 stops the loop with a visible error |
| extra | steerblock | ✅ | matching rule blocks the turn with an InnerDaemon row, no request sent |
| extra | steerinject | ✅ | inject rule text reaches the request body (log-proven) |
| extra | watchdog | ✅ | within-turn budget abort surfaces the InnerDaemon timeout row |
| extra | diagnostics | ✅ | tool turns inject an LSP diagnostics summary |
| extra | privacy | ✅ | configured secrets are scrubbed from outgoing requests |
| extra | mcp | ✅ | stdio MCP server handshake + tools/list + tools/call execute |
| extra | leaktags | ✅ | `<think>` blocks in content are stripped from the reply |
| extra | recover | ✅ | malformed tool args trigger the auto-recovery nudge |
| extra | sessiondel | ✅ | `/session delete` removes the session and starts fresh |
| extra | alias | ✅ | claude-code tool names resolve to canonical handlers |
| extra | alwaysallow | ✅ | provider `alwaysAllow` skips the approval prompt |
| extra | projectprov | ✅ | project providers.json merges with the global file (project wins) |
| extra | steertool | ✅ | steering rule matches a tool and blocks it before dispatch |
| extra | steercollapse | ✅ | consecutive identical noop traces collapse into `×N` |
| extra | subscribe | ✅ | custom command `subscribe:` keywords auto-trigger the body |

## 01, App lifecycle

| ID | Feature | Status | Notes / missing |
|---|---|---|---|
| A1 | CLI entry & flag contract | ✅ | boots + `--resume [last|N|id]` + `--provider <id>` + `--mode` + `--profile` + `--alt-screen` |
| A2 | App shell composition | ✅ | header + input + status + first-run trust gate (default config dir only; isolated configs auto-trusted) |
| A3 | App state invariants | ✅ | single signal store + context; resume rebases the session id (prompt-cache affinity) |
| A4 | Handler surface & mode cycling | ✅ | `/mode` switches live + persists + `/checkpoint [name]` / `/checkpoints` / `/restore <name>` selectors |
| A5 | Message routing | ✅ | `!bash` → Executed Bash, `/command` → registry (incl. custom commands), chat (parity `customcmd`, `bashbang`) |
| A6 | Input pipeline | ✅ | ↑/↓ history nav (draft preserved), `/` fuzzy completion + Tab, queued-while-busy, Shift+Enter multiline, Tab file completion in `!` mode |
| A7 | Input shell states | ✅ | busy hint + approval prompt + cancelling indicator + live task-list overlay while a turn runs |
| A8 | Session lifecycle | ✅ | create/list/resolve/save/rename/delete + `--resume` + `/checkpoint` persist (restore via `/resume`) |
| A9 | Settings surface | ✅ | tabbed `/settings [general|providers|session|about]` + `/settings set <key> <value>` editor |

## 02, Chat handler

| ID | Feature | Status | Notes / missing |
|---|---|---|---|
| B1 | System prompt & caching | ✅ | stable block + volatile cwd/date/AGENTS.md tail; Anthropic breakpoint on the stable block only (parity `cachehead`) |
| B2 | Turn start & abort | ✅ | AbortController per turn + `watchdogMs` abort (parity `watchdog`) |
| B3 | Streaming callbacks | ✅ | text + reasoning deltas + live ctx% climbs during the stream |
| B4 | Message capping | ✅ | newest-N slice with turn-boundary snap (system excluded) |
| B5 | Steering watchdog | ✅ | `watchdogMs` budget abort + auditable InnerDaemon row |
| B6 | Tool extraction & ghost echo | ✅ | native + XML fallback (plain `<tool_calls>` + `antml` dialects), Llama `<function=…>` tags, JSON tool-call objects, ghost strip, `<think>` tag strip; assistant `tool_calls` round-trip uses the STANDARD OpenAI shape (`{id, type:"function", function:{name, arguments}}`) so strict providers (Xiaomi mimo) accept the follow-up request |
| B7 | Malformed tool-call recovery | ✅ | tiered recovery, name case-normalization (tier 1) + valid-JSON retry nudge (tier 2) |
| B8 | Single-tool enforcement | ✅ | minimal/nano profiles truncate to one call per turn |
| B9 | Compact-count flush semantics | ✅ | per-turn compact grouping (×N) + LIVE running tally, read-only parallel batches pre-append every running row so the compact block streams its tail mid-run (parity `compact`, `slowbash`) |
| B10 | Assistant commit rules | ✅ | content-or-tool_calls enforced |
| B11 | Auto-compact | ✅ | codex-style LLM compaction: a SEPARATE summarization request produces a handoff summary (prompt + prefix ported from codex-rs/core/src/compact.rs); the summary + recent user prompts REPLACE the history; runs after the turn settles (never interrupts); auto-compact defers via `setTimeout` so `busy` is already false |
| B12 | Usage accounting | ✅ | footer tokens + `/usage` per-call history (provider/model/tokens/ts snapshots) |
| B13 | Unknown-tool handling | ✅ | `Unknown tool: …` result paired 1:1 |
| B14 | Repeated-tool-call detection | ✅ | signature counter, monitor exemption, stop at 3 |
| B15 | Steering integration | ✅ | preflight + tool-call constraints + noop ×N collapse + InnerDaemon rows |
| B16 | Tool approval gating | ✅ | yolo/auto-accept auto, normal prompts y/n, decline cancels the rest + non-interactive stdin auto-declines mutations |
| B17 | Tool execution | ✅ | sequential batch with LIVE streaming rows + read-only parallel batch (`isReadOnlyTool` + `allReadOnly`, parity `slowbash`) |
| B18 | Empty-turn handling | ✅ | nudge selection, cap, give-up error |
| B19 | Natural end | ✅ | `Worked for a <adjective> <elapsed>.` + token count |
| B20 | Interrupt / cancel | ✅ | Esc commits the partial stream + `Interrupted by user.`; `/clear` wipes |
| B21 | Auto-diagnostics | ✅ | `lsp_get_diagnostics` after tool turns; ONLY surfaces/injects when there are FINDINGS (a clean "no issues" pass appends nothing, no provider tokens wasted) |
| B22 | Privacy | ✅ | outgoing scrub + reply rehydration |
| B23 | AI-SDK chat handler | ✅ | stall + rate-limit retries + runaway stream guard (`StreamRunawayError`, `streamGuard` settings, parity `runaway`) |
| B24 | Prompt caching (anthropic) | ✅ | `/v1/messages` with ≤4 `cache_control` breakpoints (tools → system → latest user) |
| B25 | Tool filter (cache head) | ✅ | fixed inventory (no adaptive filtering, all registered tools always sent) + byte-stable system block (parity `cachehead`) |
| B26 | Session-management parity (cache) | ✅ | the persisted `context` mirrors the FINAL provider history after EVERY turn (including tool-only turns, previously a shorter prefix was saved); resuming re-sends the exact prefix so the LLM cache stays warm; harness invariants unit-locked (`harness.spec.ts`: stable system prompt, deterministic tools always present, append-only message prefix, standard tool_calls shape) |
| B27 | Malformed tool-call self-correction | ✅ | layered `parseToolCalls` (XML → Llama function tags → JSON → malformed detection with format guidance); when a turn looks like tool-call text but fails to parse, the error is fed back to the model and it retries (capped at `MAX_MALFORMED_RETRIES=2`, parity `MAX_MALFORMED_RETRIES`) |

## 03, Tools

| ID | Feature | Status | Notes / missing |
|---|---|---|---|
| D1 | Tool registry contract | ✅ | `registerTool` registry, 1:1 result pairing, validation/execution error surfaces |
| D2 | Tool naming conventions | ✅ | display names + reverse alias resolution |
| D3 | Tool availability | ✅ | plan-mode exclusions + profile filtering (parity `mode`, `nano`) |
| D4 | Approval policy | ✅ | mode-based + provider `alwaysAllow` |
| D5 | Built-in tool catalog | ✅ | all 27 tools (bash, read/write/edit/file_op, glob, ls, grep, web, git_* ×11, skill/check_skill, agent, monitor, write_tasks, fetch) |
| D6 | Display contract | ✅ | family grouping + output tails + live streaming rows (parity `compact`, `slowbash`) |
| D7 | Tool profiles | ✅ | full/minimal/nano/auto + single-tool mode + slim nano system prompt (`buildSystemPrompt(profile)`, parity `slim`) |

## 04, TUI rendering

| ID | Feature | Status | Notes / missing |
|---|---|---|---|
| C1 | Chat history viewport | ✅ | sticky-bottom scrollbox + native wheel + PageUp/PageDn viewport scroll |
| C2 | Assistant markdown | ✅ | headings/lists/code/tables/quotes/links via `<markdown>` |
| C3 | Streaming message | ✅ | formatted live, settles to the same shape |
| C4 | Thought / reasoning | ✅ | LIVE `⚙/✦ Thinking · (Ns)…` with REAL-TIME timer (`xh xm xs` format) + animated dots + `└` tail; settles into `⚙ Thought (Ns)` + `~N tokens` footer; the RUNNING header is PRIMARY (the gear reads as an animation, not a dim tool-glyph blink); settled stays secondary/dim |
| C5 | Tool-result display | ✅ | one pipeline; error rows strip the `Error:` prefix |
| C6 | Compact tool blocks | ✅ | family grouping + `✦ Ran X ×N and Y`; universal `… +N more lines` footer is the expand affordance (no ctrl-o/ctrl-r keyboard hints in the text); mouse click toggles per block; expanded blocks never get a hover tint (even with a residual long-output footer); LIVE running-state streaming |
| C7 | Bash display | ✅ | command word-wrap with `│` continuations, output TAIL + `+N lines` footer, `✦ Executed Bash` for `!cmd`, LIVE streaming output tail |
| C8 | Background task completed | ✅ | expandable completion row, summary + script preview, `… +N more lines` footer |
| C9 | Task list display | ✅ | `write_tasks` numbered task block + live progress (running/✓ markers + input-row overlay) |
| C10 | Subagent view | ✅ | tool row + result + LIVE progress tail while the subagent works (reasoning/text streams into the running row) |
| C11 | Diff view | ✅ | write/edit file previews + `git_diff --stat` in fenced ```diff blocks with per-line added/removed/hunk colors |
| C12 | Status line | ✅ | mode/profile/model/ctx/tokens/bg/mcp + LSP issue count (parity `diagissues`); theme colors fixed |
| C13 | Mouse & selection | ✅ | mouse enabled, native drag selection + clipboard copy on release (OSC 52), click-to-expand/collapse; hover tint only on COLLAPSED expandable blocks (contrast-guarded so text never becomes invisible) |
| C14 | Output overlay | ✅ | OpenTUI's native renderer IS the byte-level terminal-cell screen mirror (no separate overlay needed) |
| C15 | Fullscreen alternate screen | ✅ | `--alt-screen` switches the renderer buffer; brand banner renders in both screen modes |
| C16 | Expand/collapse invariants | ✅ | thought (ctrl+r) and compact blocks (ctrl+o/t AND mouse click) toggle both ways; per-block mouse targeting (`expandedBlocks` local overrides, parity `mouse`) |
| C17 | Toast notifications | ✅ | setting changes (model/provider/mode/fallback switches) show a transient top-of-screen toast (auto-dismiss ~2.5s) instead of polluting the chat history |
| C18 | Real-time timer format | ✅ | Working + Thinking headers render `52s`, `1m 11s`, `1h 2m 3s` (never a bare seconds count past 60) |
| C19 | Command suggestions | ✅ | borderless list, description in a separate fixed column, ↑/↓ scroll through ALL matches via a 6-row window (no hard cap) |
| C20 | Settings search | ✅ | tabs with no matches are HIDDEN; ←/→ navigate only matching tabs and never clear the query |
| C21 | Resume modal grouping | ✅ | date headers with blank lines (header, blank, sessions, blank, header); duplicate "Today" fixed via timestamp normalization (epoch ms vs ISO strings) + dedupe by session id; relative "how long ago" on the right |
| C22 | Built-in agents | ✅ | General/Explore discoverable via Settings → Capabilities → Agents (dedicated modal with instructions) |
| C23 | Lazy post-open loading | ✅ | custom tools + MCP handshakes load AFTER the app paints with a spinner indicator; active MCP servers + LSP status shown in `/status` |

## 05, Providers

| ID | Feature | Status | Notes / missing |
|---|---|---|---|
| E1 | Config hierarchy | ✅ | env > project `.nanocoder` > global > built-in; project wins by name; `${VAR}` substitution |
| E2 | Provider resolution | ✅ | `--provider`, preferences lastProvider, `/provider` switch, model validation + ordered fallback chain (parity `fallback`) |
| E3 | SDK provider families | ✅ | openai-compatible + anthropic `/v1/messages` streaming |
| E4 | Provider options | ✅ | providerOptions merge + namespaced prompt_cache_key (options win) |
| E5 | Model discovery | ✅ | `modelDiscoveryUrl` + `/v1/models` + TTL cache + fallback (parity `discovery`) |
| E6 | Models cache | ✅ | discovery TTL cache + models.dev context-window fallback (declared window wins; `NANOCODER_MODELS_DEV_URL` override, parity `ctxdev`) |
| E7 | Tokenization | ✅ | provider-aware char/token ratio keyed by model family + provider context window → ctx% |
| E8 | MCP config | ✅ | env + `mcp.json` servers, stdio JSON-RPC client, dynamic tool registration, `/mcp` surface |
| E9 | Config files & paths | ✅ | `$NANOCODER_CONFIG_DIR/providers.json` + closest-file `.nanocoder` walk up from cwd |
| E10 | Web-search fallback | ✅ | Settings → Capabilities → Web search model persists a fallback provider/model; `web_search` runs through its native server-side search (Responses API) with the chat indicator `✦ WebSearch fallback: <model> searched → <main model> responds`; `savePreferences` MERGES so fallback keys survive model switches |
| E11 | Vision fallback preference | ✅ | Settings → Capabilities → Vision model persists a fallback provider/model via the same modal flow (image pipeline is future work; the preference + indicator surface exist) |

## 06, Commands & config

| ID | Feature | Status | Notes / missing |
|---|---|---|---|
| F1 | Command registry | ✅ | registry + parse + display-only output + fuzzy completion scoring (prefix > substring > subsequence) |
| F2 | Command catalog | ✅ | 43 of 43, full nanocoder catalog (incl. commands tools skills tasks agents version credits doctor privacy statusline lsp innerdaemon schedule update export context-max setup-config setup-mcp) |
| F3 | Special commands | ✅ | clear/resume/retry/compact/rename/usage/checkpoint/tune + model picker (`/model` lists + selects) |
| F4 | Custom commands | ✅ | frontmatter parser, arg spec, substitution, body-as-prompt, subscribe auto-trigger |
| F5 | Custom tools | ✅ | markdown-defined tools with readOnly + personal/project source tracking (project wins by name) |
| F6 | Skills | ✅ | loader reads SKILL.md from config dirs, `check_skill` lints bodies, `subscribe:` keywords auto-trigger (parity `skillsub`) |
| F7 | Config files | ✅ | providers.json, settings.json, nanocoder-preferences.json (lastProvider/lastModel); project `.nanocoder` > global merge by name (E1) |
| F8 | Wizards | ✅ | `/setup-providers` guided add + `/setup-providers edit <id>` / `delete <id>` forms + settings tabs |

## Next milestones (by doc priority)

1. **C13/C14**, hover highlights, clipboard copy, the terminal-cell output
   overlay (OpenTUI-native byte-level screen mirror); bash syntax
   highlighting.
2. **C15/F8/A9**, fullscreen banner split/overflow rules; wizard edit-form /
   settings tabs UI.
3. **B9/C9/C10/C11**, live running tally flush; live task progress panel;
   subagent per-call details; per-line diff syntax highlight.
4. **B23/E6/E7/D7**, runaway stream guard; models.dev context limits;
   provider-aware tokenizers; slim-prompt profile variants.
5. **A5/A8/B16**, custom command/checkpoint selectors; non-interactive exit
   path.
6. **C1/A6**, wheel/PageUp viewport scrolling; multiline/file completions.
