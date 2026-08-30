<p align="center">
  <strong>bobonyo</strong>, a terminal harness that runs any model you want.
</p>
<p align="center">
  <em>OpenTUI powered, Claude-Code style, model agnostic</em>
</p>

---

**bobonyo** is a coding agent that runs in your terminal. It is built on
[OpenTUI](https://github.com/opentui/opentui), a fast rendering library for
terminal apps. It continues the work of the
[nanocoder](https://github.com/Nano-Collective/nanocoder), but rewrites it so
the interface feels fast and interactive — bobonyo now owns its own config,
sessions and storage (legacy nanocoder folders are migrated on first run).

bobonyo is a direct alternative to Codex and Claude Code. It exists so you can
run **other models, especially Chinese models** (DeepSeek, Mimo, GLM, Qwen,
Kimi, and more) without fighting a tool that expects one specific provider.

## Why bobonyo?

The pain is simple. To use another model with Codex or Claude Code, you have
to change environment variables and edit config files, and you still hope the
tool does not break. Most harnesses also have privacy concerns. None of them
give you the Claude-Code style experience with **multi-agent collaboration**
and **model fallbacks**.

bobonyo treats every model as a first class citizen:

- **Vision fallback.** A dedicated model looks at images and reports back to
  the main agent.
- **Web-search fallback.** A model with search ability finds web results, and
  the main agent uses those results to answer.
- **Privacy first.** Config and sessions stay on your machine. Nothing leaves
  your computer except the request you send to your provider.
- **Resume anywhere.** Switch models mid-conversation, then continue on
  another provider without losing context.
- **Tool-call recovery.** Text based models sometimes send broken tool calls.
  bobonyo fixes them automatically and keeps going, instead of stopping.
- **Cache friendly.** Session management keeps the LLM prompt cache warm, so
  long conversations stay fast and cheap.
- **Your usage, on screen.** DeepSeek balance, MiMo token plans, and Codex
  rate limits show up in the terminal instead of a dashboard.
- **Pick your agent style.** Swap the system prompt to behave like
  OpenCode, Claude Code, or Codex — or write your own — without leaving the
  harness.

## System prompt

The harness is the part that stays: cache-friendly requests, tool-call
recovery, vision/web-search fallbacks, sessions and multi-agent
collaboration. The **personality** is the part you can change. Settings →
Behavior → System prompt lets you switch the agent's style on the fly:

- **default** — the built-in BoboNyo prompt (blunt, a little snobbish,
  honest).
- **opencode** — the OpenCode workflow: short answers (under 4 lines),
  no preamble, minimal tokens, never commit unless asked.
- **claudecode** — the Claude Code workflow: no gold-plating, read before
  proposing, diagnose before switching tactics, report faithfully.
- **codex** — the Codex CLI workflow: curious personality, blunt honesty,
  `rg`-first search, careful with destructive commands.
- **custom** — write your own. Selecting it seeds `~/.config/bobonyo/SYSTEM.md`
  with the built-in prompt; edit the file in any editor and it is loaded on
  the next turn.

All styles keep the harness's one hard rule: explain in one line what a
tool call is about to do before firing it. So you get the vibe of the tool
you already know, with the model freedom and cache savings you don't get
from that tool.

## Caveman mode

Why use many token when few do trick? bobonyo ships with **Caveman mode**
built in, and it is ON by default.

Caveman mode makes the agent reply in short, direct sentences. It drops
filler words and pleasantries, but keeps every technical detail exact. Code
blocks, commands, and error messages never change — only the fluff dies.

A normal reply:

> Your component re-renders because you create a new object reference on
> each render. I would recommend using useMemo.

becomes:

> New object ref each render. Wrap in `useMemo`.

Same answer, way fewer tokens. The measured saving is around 65% of output
tokens, and shorter replies mean every turn costs less.

Do not like it? Turn it off in **Settings, Behavior → Caveman mode**, or just
say "caveman off". You can also pick a level: "caveman lite" for normal
sentences without the filler, "caveman full" for the classic style,
"caveman ultra" for the shortest possible, and even classical Chinese with
"caveman wenyan-full" if you want to show off.

## What it looks like

![bobonyo in action](docs/demo.gif)

Streaming markdown renders live. Tool calls fold into neat groups you can
expand. Thoughts stream with a real time timer. The chat history works with
the mouse, so you can hover and click.

## Install

You need [Bun](https://bun.sh) version 1.2 or newer.

```bash
git clone https://github.com/llupRisinglll/bobonyo-cli.git
cd bobonyo-cli
bun install
bun run dev
```

For a release launcher:

```bash
bun run build        # builds dist/bobonyo (launcher + assets)
./dist/bobonyo       # run the release entry
./dist/bobonyo --dev # run the dev source
```

## Configure providers

Add any OpenAI compatible provider in one place. No environment variables to
juggle:

```json
{
	"nanocoder": {
		"providers": [
			{
				"name": "DeepSeek",
				"baseUrl": "https://api.deepseek.com/",
				"apiKey": "sk-..."
			},
			{
				"name": "Xiaomi",
				"baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1",
				"apiKey": "tp-...",
				"models": ["mimo-v2.5", "mimo-v2.5-pro"]
			}
		]
	}
}
```

DeepSeek and Xiaomi MiMo are special: their `models` lists are optional.
bobonyo fetches the current catalog from each provider's `/models` API
automatically, so new models appear in `/model` without editing this file. A
static `models` list, if you add one, is only used as an offline fallback
when the API cannot be reached.

Then switch models live with `/model`. The conversation follows you, and the
model's reasoning effort shows next to its name.

### DeepSeek and Xiaomi MiMo, first class

bobonyo is built to be the best terminal harness for DeepSeek and Xiaomi
MiMo. Both providers are special: the API key is all you need, the model
catalog is fetched live, and usage data is put on screen instead of forcing
you to open a dashboard.

- **Models auto discovered.** The model list is fetched from each provider's
  `/models` API (DeepSeek and the MiMo token-plan gateway), so new models
  show up in `/model` without editing your config by hand.
- **Usage tracking.** MiMo token plans bill a fixed monthly allowance, but
  Xiaomi only exposes the quota behind the browser login, not the API key.
  bobonyo accumulates every turn's `usage` block into a monthly ledger and
  shows it on the status line as `used 1.24M`, with a breakdown in `/status`
  and `/usage`. The ledger lives on disk and survives restarts.
- **Multi instance safe.** Model and usage data is cached on disk with a
  short TTL and atomic writes, so several terminals at once share one
  refresh instead of flooding the API.

#### DeepSeek

DeepSeek-specific features on top of the shared ones:

- **Live balance on the status line.** Your remaining credit shows as
  `Cred: $12.34` next to the mode and tune settings, refreshed every few
  minutes without a dashboard.
- **Cache hit awareness.** DeepSeek caches your prompt automatically.
  bobonyo reads the cache fields on every turn and shows the hit share on
  the completion line (`cache hit 99%`) and in `/status`. When a large turn
  misses the cache, a toast warns you, because cache misses are what drive
  the cost up.

The DeepSeek recording shows the provider's own data on screen:

![DeepSeek demo](docs/deepseek-demo.gif)

The recording above was made against the real DeepSeek API: the status line
shows the live balance, the model list comes from `/models`, and the second
turn hits the warm prompt cache (`cache hit 99%`), which is exactly what
keeps the cost down. You can try it with:

```bash
bobonyo --provider DeepSeek
```

The status line shows your balance, `/model` lists the live catalog, and
every reply shows its cache hit share.

#### Xiaomi MiMo

The MiMo token-plan gateway (`token-plan-sgp.xiaomimimo.com`) accepts a
`tp-...` key for inference and model discovery. Because Xiaomi does not let
an API key read the token-plan quota, bobonyo keeps its own monthly ledger:
every reply's token usage (prompt, completion, and cache) is accumulated on
disk and shown as `used N.NM` on the status line, with the full breakdown in
`/status` and `/usage`. Use a MiMo provider exactly like any other:

```bash
bobonyo --provider Xiaomi
```

### Codex, first class

Codex works with your ChatGPT account, not just an API key. bobonyo connects
the same way `codex login` does, and then puts your account's usage on
screen. No browser tab, no dashboard.

- **Connect your account.** `/connect` → Codex → ChatGPT account reuses the
  same `~/.codex/auth.json` the codex CLI signs in with. API key connections
  work too.
- **Live models.** The codex model catalog is fetched from the backend, so
  new models show up in `/model` without editing config.
- **Rate limits on screen.** `/status` reads your real usage straight from
  the Codex backend and shows it the same way Codex does:

```text
Monthly limit     [████████████████████] 100% left (resets 22:59 on 12 Sep)
```

The limit row fits itself to whatever window Codex gives you — hourly, 5h,
daily, weekly, or monthly — and every window gets its own line, plus your
credits. It refreshes every time you open `/status`.

### Cache-friendly requests

LLM providers bill cache misses in real money, so bobonyo keeps every request
prefix stable, the same way codex does:

- **Stable system prompt.** The system block is byte-identical across a
  session, so the provider's prefix cache keeps hitting.
- **Stable tool head.** The tool catalog is part of the cache head. Tools are
  always sent in sorted order, and the first request waits until lazy MCP,
  skills, and LSP loading finish. A tool list that changes between turns
  would bust the whole cache, not just the tail.
- **Append-only history.** Each turn's messages are the previous turn's
  messages plus new ones. Sessions resume with the exact same prefix the
  provider already cached.
- **Compaction keeps the cache warm.** When the context grows, bobonyo sends
  a separate summary request, then replaces the history with a short
  handoff summary plus the recent user prompts (capped at 20k tokens). The
  summary sits right above the next user message, so the next turn starts
  from a small, cache-friendly prefix instead of resending the old blob.
  If the summary request overflows the model's window, the oldest messages
  are trimmed and it retries, keeping the recent context intact.

### Vision and web-search fallbacks

In **Settings, Capabilities** you can pick a separate model for images and
another for web search. When the main agent needs an image or fresh web data,
the fallback model does that part, and the chat tells you who did what:

```text
✦ WebSearch fallback: deepseek-v4-flash searched → mimo-v2.5-pro responds
```

## Privacy

Config and sessions stay in `~/.config/bobonyo` and
`~/.local/share/bobonyo`. Nothing leaves your machine except the provider
request itself. `@` mentions stay local until submit, then Bobonyo sends only
bounded context for that workspace path. Directories are selectable and send a
direct-child listing rather than every descendant file. File ranges use
`@src/file.php#L7-9`; paths with spaces use `@"my folder/file.php"#L7-9`.
`[Image #N]` or `[Text #N]` pastes follow the same submit boundary. Steering
rules in `steering.json` can block, inject, or stop turns before they reach the
model.

## Command sandbox

Shell commands use Linux bubblewrap when available. Default `auto` mode gives
the command a read-only host filesystem plus write access to the current Git
workspace and its Git common directory. `/tmp` and `/var/tmp` are private.
Settings, Behavior exposes `Command sandbox` (`auto`, `workspace-write`,
`read-only`, `off`) and `Sandbox network` (`on`, `off`). Explicit
`workspace-write` or `read-only` fails closed when bubblewrap is unavailable;
`auto` falls back for portability. Extra writable absolute paths can be added
to `sandbox.writablePaths` in `~/.config/bobonyo/settings.json`.

## Customization files

Bobonyo reads only Bobonyo-owned configuration. It never reads `.claude/`,
`.codex/`, or `.agents/` directly. Copy selected Claude Code or Codex files
into `.bobonyo/` when migrating. See [docs/customization.md](docs/customization.md)
for exact skill, command, hook, agent, and script paths.

## Agents

Agents are Markdown files with YAML frontmatter. Bobonyo discovers built-in
personalities (General, Explore), user agents from
`~/.config/bobonyo/agents/<name>.md`, and project agents from
`.bobonyo/agents/<name>.md` (legacy `.nanocoder/agents/<name>.md` remains
supported). Project files win on name conflict. **Settings, Capabilities,
Agents** lists every discoverable agent with a search box; Enter opens the full
system prompt. The `agent` tool lets the main model delegate to any of them.

## Tool-call recovery

Chinese open-weight models often send tool calls as text instead of the native
protocol. bobonyo parses XML, Llama `<function=…>` tags, and JSON tool calls.
When the markup is broken, it tells the model the problem and retries on its
own. The conversation fixes itself instead of stopping.

## Sessions and resume

Every conversation saves automatically. `/resume` opens a picker grouped by
date (Today, Yesterday, and so on) with a preview of the last message and a
"how long ago" time. Resuming sends the exact same provider prefix, so the LLM
cache stays warm.

## Preview and development

`bobonyo preview tui` runs the full interface against a local keyword mock.
You can design, test, and work on the interface without spending provider
tokens.

## Contributing

We would love your help. The project keeps the same structure as the original
nanocoder, so the business-logic docs stay the source of truth.

1. Fork the repo and create a feature branch.
2. Run `bun test` and `bun run typecheck` before pushing.
3. Run `bun run build` after touching the interface, so the release launcher
   stays green.
4. Open a PR. Keep commits short and conventional (`feat:`, `fix:`,
   `refactor:`).

## License

MIT. See [LICENSE](LICENSE).
