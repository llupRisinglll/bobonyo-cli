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
