# Changelog

All notable changes to bobonyo. Entries are generated from `.changeset/`
files by `scripts/release.mjs` when the release workflow consumes them on
`main`; each `vX.Y.Z` section is also the GitHub Release body.

## v0.6.0 (2026-10-09)

### Minor
- Harden live steering against stale tool dispatch, track input consumption across retries and resume, and safely deliver legacy worker results without borrowing foreground context.
## v0.5.0 (2026-10-08)

### Minor
- Send live directions straight into the conversation while work continues, preserving undelivered input across interruptions and session resume.
## v0.4.11 (2026-10-08)

### Patch
- Render native web activity as grouped web rows, strip leaked citation markers, and recover legacy work-graph completions without exposing internal errors.
## v0.4.10 (2026-10-08)

### Patch
- Keep coordinator work moving after worker revisions, prevent older results from overriding newer requests, and act on authorized preparation instead of stopping at readiness reports.
## v0.4.9 (2026-10-07)

### Patch
- Retry transient provider socket closures before output, honor cancellation, and explain interruptions without replaying partial responses.
## v0.4.8 (2026-10-06)

### Patch
- Recover from blockers using focused investigation and exact-symptom verification, while preserving permission boundaries and suggesting concrete next actions.
## v0.4.7 (2026-10-06)

### Patch
- Try safe, isolated recovery before declaring work blocked, and offer a concrete remedy when permission is genuinely required.
## v0.4.6 (2026-10-06)

### Patch
- Avoid duplicate desktop notifications by using Herdr as the sole completion notifier inside Herdr-managed panes.
## v0.4.5 (2026-10-06)

### Patch
- Prevent completed checklists and stale background results from reopening previous work during unrelated requests.
## v0.4.4 (2026-10-05)

### Patch
- Open the resume picker without blocking, show loading during conversation restoration, and remove unused modal spacing.
## v0.4.3 (2026-10-05)

### Patch
- Prioritize explicit queued user instructions over stale autonomous blocked replies.
## v0.4.2 (2026-10-05)

### Patch
- Open the resume picker immediately with a loader while session files load in the background.
- Stabilize question-modal keyboard regression coverage under slower CI rendering.
- Keep task updates and task listings rendered as the latest rich checklist in chat history.
## v0.4.1 (2026-10-05)

### Patch
- Keep task checklist updates in the rich checklist layout instead of falling back to compact raw tool output.
## v0.4.0 (2026-10-05)

### Minor
- Make Caveman mode opt-in and restore conversational progress updates between meaningful tool-work phases.
## v0.3.5 (2026-10-05)

### Patch
- Unify modal title bars, preserve keyboard and mouse-wheel navigation in short viewports, and ensure trust confirmation honors the selected choice.
## v0.3.4 (2026-10-04)

### Patch
- Ensure automated releases can verify that resume instructions remain visible after exiting to zsh.
- Keep resume instructions visible after the release launcher exits while preserving terminal recovery after crashes.
## v0.3.3 (2026-10-03)

### Patch
- Keep exit resume instructions visible after renderer shutdown instead of clearing them away.
## v0.3.2 (2026-10-03)

### Patch
- Show details windows with a full-width title bar, symmetric half-cell visual edges, and padded borderless content.
## v0.3.1 (2026-10-03)

### Patch
- Separate edited files with a blank row, show three unchanged lines around patch hunks with correct line numbers and omitted-range markers, keep unchanged Markdown neutral, and render one status glyph per file row.
## v0.3.0 (2026-10-03)

### Minor
- Show supported GPT reasoning efforts, persist paid fast processing with a visible Fast indicator, and distinguish informational system notices in gold.
## v0.2.7 (2026-10-02)

### Patch
- Keep model picker navigation responsive by caching catalog layout and sharing concurrent model metadata requests.
## v0.2.6 (2026-09-27)

### Patch
- Prevent repeated completion replies when chat is queued during a background-agent completion turn, preserving queued messages for their own turn.
## v0.2.5 (2026-09-27)

### Patch
- Keep the input box and status line aligned when background agents finish.
## v0.2.4 (2026-09-27)

### Patch
- Make custom answers an explicit editable choice and keep wrapped input, the cursor, footer, and focused options visible on narrow or short terminals.
## v0.2.3 (2026-09-27)

### Patch
- Keep workflow skill prerequisites isolated by context and invalidate them after completed compaction.
## v0.2.2 (2026-09-27)

### Patch
- Improve source organization and enforce consistent formatting for changed files.
## v0.2.1 (2026-09-26)

### Patch
- Push generated release tags explicitly so GitHub Release creation and npm publishing can complete.
## v0.2.0 (2026-09-26)

### Minor
- Publish BoboNyo as a public npm CLI with automated releases and documented global installation.
- Change-set driven releases: `.changeset/` convention (one entry per commit), `scripts/release.mjs` version bumper, GitHub Actions CI + release workflows, and a single-source `src/version.ts`.

### Patch
- Fix the CI change-set guard: exempt `.changeset/README.md` (docs) and accept single-quoted frontmatter keys (the pre-commit formatter rewrites them).
- Treat unknown slash-input as a regular message (file paths, natural language starting with /) instead of showing "Unknown command" and losing the prompt history for up-arrow recall.
- Silently treat unknown slash-input (file paths, natural language starting with /) as regular messages instead of showing "Unknown command or skill" and losing up-arrow recall.
- Keep release versioning aligned with semantic changesets and published version tags, while making CI release checks reproducible.
- Add post-push rule to AGENTS.md: agent must report version bump results to the user after every push.
