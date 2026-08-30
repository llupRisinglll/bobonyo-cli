# Memory Optimization Plan

Started: 2026-08-28
Status: In progress

## Objective

Reduce long-lived Bobonyo memory without breaking transcript rendering,
compaction, undo, subagents, or isolated Playwright control.

## Baseline

- Runtime: Bun 1.3.5.
- Seven Bobonyo processes: roughly 1.5–2.0 GB resident combined, excluding
  some descendants and swapped pages.
- Individual long-lived Bobonyo processes: roughly 190–510 MB RSS, often with
  another 200–300 MB swapped.
- Real-session render benchmark under Bun 1.3.5: about 315 MB RSS rendered and
  296 MB after clearing the transcript.
- Same benchmark under Bun 1.4.0: about 283 MB RSS rendered and 262 MB after
  clearing the transcript.
- Playwright must remain isolated per Bobonyo process.

## Confirmed retention risks

- [ ] File-undo exchanges have no count or byte limit.
- [ ] `compactDetails` retains full transcript details globally without pruning.
- [ ] Settled-block cache retains stale content, width, and theme variants.
- [ ] Completed Bash jobs remain in the process-wide task registry.
- [ ] Retry snapshot can retain pre-compaction message/context arrays.
- [ ] Tool and subagent data use count limits without byte limits.
- [ ] Every configured MCP starts eagerly; codebase-memory is duplicated.
- [x] Connected MCP subprocesses now receive an application-exit cleanup path.

## Implementation phases

### Phase 1 — Runtime and bounded in-process caches

- [x] Upgrade development/runtime requirement to Bun 1.4.0.
- [x] Add count and byte bounds to file-undo history.
- [x] Reset file-undo history at conversation boundaries.
- [x] Prune transcript details to currently visible blocks.
- [x] Prune settled-block cache to currently rendered blocks.
- [x] Bound completed Bash task history and retained output.
- [x] Clear stale retry snapshots after compaction.

### Phase 2 — Byte-aware transcript and subagent storage

- [ ] Add byte budgets for display messages and large tool outputs.
- [ ] Keep full details on disk where UI only needs a compact tail.
- [ ] Persist subagent metadata/tails separately from full child history.
- [ ] Add memory diagnostics to `/doctor` or `/status`.

### Phase 3 — MCP lifecycle

- [ ] Add per-server lifecycle policy: `isolated`, `shared`, or `on-demand`.
- [ ] Keep Playwright isolated per Bobonyo process.
- [x] Lazy-start isolated Playwright on first browser tool call.
- [ ] Share codebase-memory through a user-scoped broker/daemon.
- [ ] Add idle shutdown and reliable process-tree cleanup.

## Verification

- [x] Regression tests fail against unbounded pre-fix behavior.
- [x] `npx prettier --write` on touched files.
- [x] Affected tests pass.
- [x] Full `bun test` passes.
- [x] `bun run typecheck` passes.
- [x] `bun run build` passes.
- [x] Real-session memory benchmark records before/after RSS and heap.
- [ ] Live TUI manually verified before commit for visible behavior changes.

## Progress log

### 2026-08-28

- Measured Bobonyo, Konsole, Herdr, MCP children, RSS, PSS, swap, sockets, and
  process trees.
- Verified most Bobonyo memory is private anonymous memory rather than session
  files or shared libraries.
- Confirmed compaction only replaces display messages and provider context;
  several process-lifetime registries bypass it.
- Benchmarked Bun 1.4.0 against Bun 1.3.5 using a real saved session. Bun 1.4.0
  reduced rendered RSS by about 10% and reclaimed substantially more JS heap
  after transcript clear.
- Verified Bun 1.4.0 with typecheck, targeted tests, and release build.
- Added MCP application-exit cleanup and regression guard.
- Upgraded the installed Bun runtime to 1.4.0 and pinned the project runtime
  requirement in `package.json`.
- Bounded file undo to 20 exchanges and 64 MiB, skipping a single snapshot
  that exceeds the full budget. Session switches, `/clear`, and successful
  compaction now reset the undo history.
- Moved transcript detail retention into each mounted `History`, clearing and
  rebuilding it from current visible messages on each settled render.
- Settled-block cache now evicts keys no longer present in current transcript,
  preventing stale width/theme/content variants from accumulating.
- Background Bash registry now retains every running task and only 20 newest
  completed task summaries.
- Successful compaction clears the pre-compaction retry snapshot.
- Added focused tests and source regression guards for every Phase 1 bound.
- Bun 1.4.0 real-session benchmark after cache fixes, five-run median:
  286 MB rendered, 263 MB after transcript clear, 202 MB after renderer
  destruction. Cleared JS heap dropped to about 34 MB from Bun 1.3.5's
  previous 93 MB baseline.
- Verification passed under Bun 1.4.0: typecheck, 968 tests, release build,
  and `git diff --check`.
- Full render suite still reports existing OpenTUI `TerminalConsoleCache`
  listener warnings. Tests pass, but listener ownership needs separate audit.

### 2026-08-28 — Post-upgrade live investigation

- KDE reports the Herdr systemd scope as a Konsole application scope. This
  scope contains every Herdr pane workload, not only Konsole or Bobonyo.
- Actual Konsole process: about 28 MB PSS and 32 MB cgroup memory.
- Herdr scope during investigation: about 5.2 GB current memory and 7.5 GB
  swap, with a historical peak around 22 GB.
- Largest owner was an unrelated Leetcode Next.js development server:
  `next-server (v15.5.4)`, PID 2343285, about 2.1 GB PSS plus 2.9 GB swap.
  It was launched detached with `nohup`, uses `/dev/null`, and is parented by
  the user systemd instance rather than a live Bobonyo process.
- The scope also contains unrelated Hilinga, Diuros, Leetcode, Vite, Next,
  MongoDB-connected, and plugin development processes from other Herdr panes.
- Two live Bobonyo processes remained, not one. Their own measured PSS was
  about 350 MB for the resumed active session and 107 MB for an old empty
  session. The active process also owned isolated Playwright MCP launcher and
  server processes at roughly 75 MB PSS each, plus a small codebase-memory
  process.
- Resuming the real session therefore adds hundreds of MB, not 3–6 GB. The
  apparent jump to 6 GB is KDE showing the whole Herdr/Konsole cgroup, whose
  dominant process is the unrelated Next.js server.
- Do not "fix" this by moving Bobonyo into another cgroup solely to hide the
  accounting. Actual remaining Bobonyo work is lazy isolated Playwright
  startup and shared codebase-memory lifecycle.
- Added a seven-day cached MCP tool manifest for explicitly isolated
  Playwright servers. Warm startups register proxy tools without spawning
  Playwright; the first browser tool call starts one isolated server owned by
  that Bobonyo process. Browser state is never shared between Bobonyo
  processes.
- Warmed the current Playwright manifest with 24 tools. Future restarts use
  lazy startup immediately; already-running Bobonyo processes keep their
  existing Playwright children until those processes exit.
- Verification after the lazy Playwright change passed under Bun 1.4.0:
  typecheck, 969 tests, release build, and `git diff --check`.
