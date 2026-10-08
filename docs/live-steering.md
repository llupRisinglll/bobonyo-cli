# Live steering instead of queued drafts

## Research scope

Inspected the read-only sibling Codex checkout at
`678157acaa819d5510adfe359abb5d0392cfe461` (July 19, 2026), plus official
app-server documentation on October 8, 2026. This is a pinned implementation
comparison, not a claim that the sibling checkout is current upstream or that
the desktop frontend itself was inspected.

Primary sources:

- https://developers.openai.com/codex/app-server/
- https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/app-server/README.md
- https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/core/src/session/input_queue.rs
- https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/core/src/session/turn.rs
- https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/tui/src/chatwidget/input_restore.rs

The public app-server powers rich Codex clients. Its `turn/steer` validates
`expectedTurnId` and appends input to the active regular turn. Internally it
uses a pending-input queue: absence of a visible draft queue does not mean
absence of buffering. It ordinarily consumes input between model requests,
after collecting tool results, rather than cancelling arbitrary running tools.
Selected waiting tools can wake on new input.

Acceptance, persistence, insertion into model context, and model response are
distinct milestones. The inspected Codex code acknowledges steering before
context recording, and its turn-completion cleanup can record late input
without another inference request. These distinctions matter more than copying
the desktop's appearance.

## BoboNyo delivery contract

- Enter submits direction, including while the assistant is working. It is not
  an editable draft awaiting permission to send.
- Record the user transcript and referenced image attachments immediately.
  Give each submission its own identity, including identical text submissions.
- Keep accepted, undelivered direction in a session-owned durable inbox,
  separate from autonomous continuations and background completion scheduling.
- Inject direction at a safe model boundary without duplicating transcript
  rows or replaying completed tools. Record full tool batches before new user
  input so provider tool-call/result pairing remains valid.
- Context insertion is not proof of a provider response or model compliance.
  Do not promise that an in-flight response has already seen newly sent input.
- Escape stops current work and pauses undelivered direction. Preserve that
  direction across resume; a subsequent user submission permits continuation.
- Session replacement invalidates old preparation work. No direction from the
  old session may enter a new session's model context.
- While session restoration is loading, sending ordinary input retains the
  composer draft and attachments and reports that loading must finish first.
  It does not claim acceptance and then overwrite the submission.
- `/retry` continues the retained provider context. It does not rewind accepted
  transcript rows, duplicate an undelivered submission, or replay completed
  tool calls. Continuing already delivered context does not rerun
  `UserPromptSubmit` transformation hooks: their admitted result is already in
  that history. Undelivered input still passes prompt hooks before delivery;
  session lifecycle, ownership, and tool permission checks remain enforced.
- A blocked prompt hook retains direction rather than silently dropping it.
  Hooks and permission approvals are not bypassed by steering.
- Legacy `/queue TEXT` submits `TEXT` as direction. Sequencing requirements
  belong in the user's instruction, not in a separate draft-queue mode.

## Limits

This is safe-boundary steering, not a provider-native in-flight input API.
A slow model request or running foreground tool can still delay consumption.
The current OpenAI API documentation also describes `response.steer` for
GPT-6-family Responses WebSocket connections. That is a separate, restricted
transport capability, not a portable replacement for our model-agnostic
delivery path; this change does not implement it. Its acceptance event likewise
does not establish that the model has acted on the input. See
https://developers.openai.com/api/docs/guides/steering for that protocol.
No claim of superiority to Codex's desktop UX or model obedience is warranted
without a controlled live comparison. The acceptance tests cover harness
delivery, identity, persistence, cancellation, and session isolation instead.
