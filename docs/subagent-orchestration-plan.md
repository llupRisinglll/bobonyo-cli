# Subagent Orchestration and Durable Research Memory

Date: September 7, 2026

## Goal

Make subagent work reliable across concurrent, unrelated tasks. Parent decisions must wait for and consolidate all required subagent results. Completed exploration must become reusable project/session knowledge instead of being rediscovered on every later request.

## Current problems

- Completion handling is event-oriented rather than graph-oriented.
- One completed subagent can cause the parent to decide before sibling results arrive.
- A decision can request another subagent, but that follow-up launch can be skipped after another event mutates state.
- Independent user tasks are not represented as separate durable work graphs.
- Exploration results are transient conversation output; later turns launch duplicate exploration.
- Task notifications do not carry enough dependency, scope, or decision identity to prevent stale updates.

## Design

### 1. Durable work graph

Represent each user request as a `WorkGraph`:

- graph id, session id, title, objective, status, created/updated timestamps
- nodes: task, research, implementation, review, decision, consolidation
- edges: `depends_on`, `blocks`, `supersedes`, `derived_from`
- node status: pending, ready, running, waiting, completed, failed, cancelled
- node owner: parent, foreground subagent, background subagent
- node result, error, and provenance metadata

Node identity must be stable. Events update node ids, never infer identity from text or array position.

### 2. Barrier-based decisions

Decision nodes declare required predecessor node ids. A decision is not runnable until every required predecessor reaches a terminal state. Failed results are still included in consolidation with explicit failure status.

Consolidation creates one decision input containing all predecessor results, ordered deterministically. Follow-up nodes created by consolidation are linked to that decision and cannot be silently skipped.

### 3. Concurrent graph scheduling

Scheduler rules:

- unrelated ready nodes may run concurrently
- dependent nodes wait for all predecessors
- each launch carries graph id, node id, attempt id, and task scope
- stale or duplicate completion events are idempotent
- new user requests create separate graph roots, even within one session
- parent can merge graphs explicitly, never accidentally through shared mutable queues

### 4. Durable research memory

Persist reusable findings separately from raw task output:

- scope: project, repository, session, or global
- topic and normalized query
- concise findings
- files/symbols/commands inspected
- source node and graph id
- confidence and created/updated timestamps
- invalidation keys based on changed files or commits

Before launching exploration, query memory by scope and topic. Reuse valid findings, then launch only a delta investigation when repository state changed.

### 5. SQLite migration boundary

Use SQLite for graph state, nodes, edges, events, and research memory. Keep settings and project instruction files as JSON/Markdown. Preserve JSON session import/export during migration.

Initial tables:

- `work_graphs`
- `work_nodes`
- `work_edges`
- `work_events`
- `research_memory`

Use WAL, foreign keys, transactions, and unique event ids.

## Implementation phases

1. Inspect current subagent/task lifecycle and identify race-prone transitions.
2. Add a pure graph model and scheduler with barrier tests.
3. Persist graph state and idempotent events in SQLite.
4. Route existing subagent launches/completions through graph nodes.
5. Add research-memory storage, lookup, invalidation, and prompt injection.
6. Add separate graph roots for unrelated user tasks and explicit consolidation.
7. Migrate existing task/session state gradually; retain legacy compatibility.
8. Run full tests, typecheck, build, and targeted concurrency regressions.

## Acceptance criteria

- Parent consolidation waits for every required subagent, including failures.
- Follow-up launches requested by a decision always materialize exactly once.
- Two unrelated tasks can run simultaneously without state contamination.
- Duplicate/stale completion events do not change terminal graph state.
- Repeated exploration reuses persisted findings when repository inputs are unchanged.
- Changed files invalidate only affected research memory.
- Existing sessions and subagent history still resume.
- Full test suite, typecheck, and production build pass.

## Non-goals

- Do not replace provider conversation context with graph state.
- Do not persist secrets in research memory.
- Do not blindly cache stale repository claims.
- Do not rewrite all settings/configuration into SQLite in first phase.
