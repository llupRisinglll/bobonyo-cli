# Report tracker

Every user report and its status, so nothing gets lost between turns. A report
is DONE only when verified live (or unit-tested) and committed.

| # | Report | Status | Verified / committed |
|---|---|---|---|
| 1 | Rename status `⏵⏵⏵ yolo mode on` → `⏵⏵⏵ yolo` | ✅ DONE | status line + `/status` modal show `yolo`; live capture |
| 2 | Test web-search fallback (search model = deepseek-v4-flash, main = mimo-v2.5-pro) | ✅ DONE | live: `✦ WebSearch fallback: deepseek-v4-flash searched → mimo-v2.5-pro responds` + real results |
| 3 | Test image fallback (vision model = mimo-v2.5, main = mimo-v2.5-pro) | ✅ DONE | live: `✦ Vision fallback: mimo-v2.5 analyzed 1 image → mimo-v2.5-pro responds`; the main model correctly described the image from the vision description |
| 4 | Add connecting to Codex as a provider feature | ✅ DONE | `/codex` command scaffolds the Codex provider (api.openai.com/v1, API key prompt, live model discovery, context window); appears in suggestions |
| 5 | Add a right-side gap for the scrollbar | ✅ DONE | scrollbox `paddingRight={2}`; `historyFillWidth` adjusted; content no longer touches the scrollbar |
| 6 | Responses must never render at column 0 (wrap in a container) | ✅ DONE | replies render in their OWN padded markdown container (`paddingLeft={2}`); verified: reply paragraphs, headings, lists, code all sit at column 2+; non-reply content (user msgs, tool rows) is unaffected |
| 7 | System prompt: say BoboNyo (not nanocoder); be blunt/snobbish, honesty first | ✅ DONE | both system prompts (full + nano) updated |
| 8 | Bug: typing `/rename` + space, cursor does not move (space invisible) | ✅ DONE | root cause: `wrapTextDetailed` trimmed trailing spaces so the caret snapped before the space; trailing spaces are now preserved + the caret maps after them; live capture `❯ /rename ▌` |
| 9 | Bug: `/rename    asdasd` multiple spaces looked like a tab | ✅ DONE | same root cause as #8; spaces now render normally |
| 10 | Keep a report tracker md with status | ✅ DONE | this file |

## Implementation notes (committed)

- `src/state.ts`: pending queue entries carry attachments (queued `[Image #N]`
  prompts keep their image paths for vision analysis).
- `src/vision.ts`: vision fallback analysis (OpenAI-compatible chat completions
  with `image_url` content parts) through the configured vision model.
- `src/web-search.ts`: native web-search fallback (Responses API) through the
  configured search model, with the chat indicator.
- `src/config.ts`: `savePreferences` merges (fallback keys survive model
  switches); provider `baseUrl` normalization strips a trailing `/v1` (the
  client appends `/v1/chat/completions` — the doubled path 404s on Xiaomi's
  token-plan endpoint and silently fell back to another provider).
- `src/client.ts`: system prompts updated to BoboNyo; OpenAI request body
  carries standard `tools` + `tool_calls` shapes.
- `src/components/history.tsx`: transcript renders as multiple markdown blocks;
  replies get padded containers; mouse hover/click maps through per-block row
  offsets.
- `src/components/input-box.tsx`: trailing-space wrap fix; attachments passed
  through submit; suggestions borderless + scrollable.
- `src/components/details-modal.tsx`: compact-tally click opens a scrollable
  details modal.
- `src/commands.ts` + `src/app.tsx`: `/codex` provider scaffold; `connectCodex`
  flow; status label; diagnostics only surface findings.

Gate: `bun test` (100 pass) + `bun run typecheck` clean before every commit.
