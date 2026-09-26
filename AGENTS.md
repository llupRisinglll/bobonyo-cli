# BoboNyo repository rules

The parent `../AGENTS.md` remains authoritative for project architecture,
verification, configuration ownership, and safety. These rules supplement it.

## Hard rule: commit and push every change

- After each logical change is complete and verified, commit it and push it to
  the configured remote. Do not leave completed changes uncommitted or unpushed.
- Run the required tests, typecheck, and build before committing. Never bypass
  hooks or commit failing work. UI-visible changes still require the user's
  manual approval before commit or push.
- Stage only the files or hunks belonging to that change. Never sweep unrelated,
  unfinished, or another worker's changes into the commit.
- Use a small conventional commit with one single-line subject and no AI
  attribution. Follow the parent repository's branch policy.
- Push normally; never force-push or invent a remote. If tests, approval,
  authentication, or remote configuration prevent completion, report the exact
  blocker and retain the work. Never claim a commit or push succeeded without
  verifying it.

## Hard rule: every commit carries a change set

- Every non-release commit MUST add exactly one `.changeset/<slug>.md` file
  describing that logical change (format in `.changeset/README.md`):
  `---\n"bobonyo": patch\n---\n` followed by a one-line user-facing summary.
  Levels: `patch` fixes/tests/docs/chores, `minor` features (and breaking
  changes while 0.x), `major` reserved for 1.0.
- The summary is pasted verbatim into `CHANGELOG.md` and the GitHub Release
  notes — write it for users, not for the diff.
- CI (`.github/workflows/ci.yml`) rejects PRs whose `src/`, `scripts/`,
  `package.json` or `bun.lock` changed without a valid change set. Do not
  bypass it; add the change set.
- `chore(release)` commits (the bot's version bump) are the ONLY exemption.
- Releases are automatic: pushing to `main` lets
  `.github/workflows/release.yml` consume the pending change sets, bump
  `package.json` `version` (single source of truth — `src/version.ts`),
  update `CHANGELOG.md`, tag `vX.Y.Z`, and publish a GitHub Release.
  Never edit `package.json`'s `version` by hand and never hand-edit a
  generated `CHANGELOG.md` release section.
- **After every push**, check whether the release workflow bumped the version
  (run `gh run list --limit 1` or read `package.json` after a short wait)
  and **report back to the user** with the version bump result: the old
  version, the new version, and whether the GitHub Release was published.
  Do not skip this report — the user expects visibility into every release.
