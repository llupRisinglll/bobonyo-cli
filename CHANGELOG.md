# Changelog

All notable changes to bobonyo. Entries are generated from `.changeset/`
files by `scripts/release.mjs` when the release workflow consumes them on
`main`; each `vX.Y.Z` section is also the GitHub Release body.

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
