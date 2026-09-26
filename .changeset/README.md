# Change sets

Every non-release commit in this repository carries exactly one change set
file in this directory. A change set is a small markdown file describing the
change and its semver impact; the release workflow consumes them to bump the
version automatically.

## Format

```md
---
'bobonyo': patch
---

One-line summary of the change (this becomes the CHANGELOG entry).
```

- File name: any unique slug, e.g. `fix-model-list.md`.
- Package name must be `"bobonyo"` (single quotes also accepted — the
  pre-commit formatter rewrites the quotes).
- Level is one of `major`, `minor`, `patch`:
  - `patch` — fixes, tests, docs, chores, CI.
  - `minor` — new features, and breaking changes while the version is 0.x.
  - `major` — reserved for the 1.0 breaking cut.
- Keep the summary user-facing: it is pasted verbatim into `CHANGELOG.md`
  and the GitHub Release notes.

## What consumes this

`scripts/release.mjs` (run by `.github/workflows/release.yml` on `main`):

1. Reads every `*.md` here (except this README).
2. Bumps `package.json` `version` by the highest level found.
3. Prepends the summaries to `CHANGELOG.md` under a new `vX.Y.Z` heading.
4. Deletes the consumed change sets and publishes a GitHub Release `vX.Y.Z`.

Local preview: `node scripts/release.mjs --dry-run`.

CI (`.github/workflows/ci.yml`) rejects any PR that changes `src/`,
`scripts/`, `package.json` or `bun.lock` without adding a change set here.
