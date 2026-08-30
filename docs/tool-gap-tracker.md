# Built-in tool gap tracker

Snapshot baseline: August 28, 2026. Compared against local Codex commit
`678157acaa819d5510adfe359abb5d0392cfe461` and local Claude Code reference
commit `0dc622e129e4ab960b5c1c7e5ccc90ffe7fe620e`.

This tracker covers meaningful coding-agent primitives, not raw tool-count
parity. A gap is DONE only after implementation, regression coverage,
typecheck, full tests, release build, and a final fresh comparison.

| #   | Gap                                              | Acceptance criteria                                                                                                                                                                                                                                | Status | Verification                                                                                                  |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | `list_directory` / `LS` is shallow and redundant | Remove model-facing `list_directory`; add bounded first-class `glob` and `grep` with workspace confinement, hidden-file controls, filters, and useful truncation metadata                                                                          | DONE   | Unit tests cover recursion, filtering, bounds, binary skipping, symlink refusal, and workspace escape refusal |
| 2   | File mutation choices overlap                    | Present one coherent edit surface per model: patch-trained GPT models get `apply_patch`; other models get `edit_file` + `write_file` + `delete_file`; remove model-facing `string_replace` and `diff_edit` aliases without breaking saved sessions | DONE   | Catalog tests verify model-specific surfaces; legacy handlers remain dispatch-only for resumed sessions       |
| 3   | Long-running process control is implicit         | Add explicit start/input/status/stop lifecycle for persistent processes; keep `execute_bash` for ordinary foreground commands                                                                                                                      | DONE   | Lifecycle test verifies stdin, output/status, and process-group stop                                          |
| 4   | Large catalogs are always eager                  | Add deferred `tool_search`; defer eligible MCP/custom tools while keeping core tools direct and schemas stable                                                                                                                                     | DONE   | Unit tests verify custom/MCP omission, ranked search, activation, and core-catalog stability                  |
| 5   | No model-callable image inspection               | Add workspace-confined `view_image` using native vision input when available or configured vision fallback                                                                                                                                         | DONE   | Tests verify workspace confinement, format/size validation, and vision delegation                             |
| 6   | MCP resources are unavailable                    | Add list resources, list templates, and read resource support when MCP servers expose those methods                                                                                                                                                | DONE   | RPC paths implemented; formatter tests cover text and bounded binary representation                           |
| 7   | Tasks are whole-list replacement only            | Add stable IDs, dependencies, owners, get/list/create/update operations; preserve `write_tasks` compatibility                                                                                                                                      | DONE   | Lifecycle tests cover stable IDs, dependency blocking, ownership, partial updates, and compatibility          |
| 8   | Model cannot request scoped permission           | Add structured `request_permissions` with explicit scope, reason, and harness approval; never bypass workspace containment                                                                                                                         | DONE   | Tests verify explicit reasons, denial, session grants, unknown-tool refusal, and retained hard safety checks  |
| 9   | Final parity revalidation                        | Reinspect current BoboNyo, Codex, and Claude registries; document any remaining meaningful gap or mark resolved with rationale                                                                                                                     | DONE   | Fresh registry audit completed August 28, 2026; remaining differences are documented non-goals                |

## Deliberate non-goals

- Raw parity with platform-specific Claude tools such as cron, push
  notifications, remote triggers, and proprietary team infrastructure.
- Duplicating shell wrappers for Git commands.
- Adding notebook editing until real user demand exists; shell/Python already
  handles notebooks and this is not a general coding-agent primitive.
- Adding current-time or sleep tools; neither improves repository work enough
  to justify permanent catalog cost.

## Work log

- 2026-08-28: Created tracker from source-level comparison. Started replacing
  shallow `LS` with dedicated search primitives.
- 2026-08-28: Removed model-facing `list_directory`/`LS`. Added recursive,
  bounded `glob` and `grep`; both stay inside workspace and skip symlinks,
  `.git`, `node_modules`, binary files, and oversized files by default.
- 2026-08-28: Added strict `edit_file`. New model catalogs no longer expose
  `string_replace` or `diff_edit`; legacy calls still execute for resume
  compatibility. GPT patch models see only `apply_patch` for file mutation.
- 2026-08-28: Added `process_start`, `process_input`, `process_status`, and
  `process_stop` over a sandboxed persistent-process registry.
- 2026-08-28: Added deferred `tool_search`. Custom and MCP schemas stay out of
  the model catalog until a capability search activates matching tools.
- 2026-08-28: Added workspace-confined `view_image` through the configured
  vision model, with format and 20 MiB limits.
- 2026-08-28: Added MCP resource listing, template listing, and resource read
  tools over connected stdio clients.
- 2026-08-28: Upgraded tasks with stable IDs, owners, dependencies, and
  create/get/list/update tools while preserving `write_tasks`.
- 2026-08-28: Added structured, session-scoped `request_permissions` for
  named tools. Hard workspace, sandbox, and deletion guards remain absolute.
- 2026-08-28: Re-audited visible BoboNyo catalogs for GPT and Claude-family
  models against local Codex and Claude references. Core gaps in search,
  editing, process control, deferred discovery, images, MCP resources, tasks,
  and permission requests are closed. Remaining differences are platform or
  product features listed under deliberate non-goals, not coding primitives.
