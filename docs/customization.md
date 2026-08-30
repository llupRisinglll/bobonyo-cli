# Customization files

Bobonyo uses Bobonyo-owned files only. It does not read `~/.claude/`, `.claude/`, `~/.codex/`, `.codex/`, `~/.agents/`, or `.agents/` at runtime.

When documentation or agent instructions mention a skill, command, hook, agent, or folder, they should include its file path. A bare label such as `deploy skill` is ambiguous; write `.bobonyo/skills/deploy/SKILL.md` instead.

## Paths

| Capability   | User path                                  | Project path                      |
| ------------ | ------------------------------------------ | --------------------------------- |
| Settings     | `~/.config/bobonyo/settings.json`          | `.bobonyo/settings.json`          |
| Hooks        | `~/.config/bobonyo/hooks.json`             | `.bobonyo/hooks.json`             |
| Hook scripts | `~/.config/bobonyo/hooks/`                 | `.bobonyo/hooks/`                 |
| Skills       | `~/.config/bobonyo/skills/<name>/SKILL.md` | `.bobonyo/skills/<name>/SKILL.md` |
| Commands     | `~/.config/bobonyo/commands/<name>.md`     | `.bobonyo/commands/<name>.md`     |
| Agents       | `~/.config/bobonyo/agents/<name>.md`       | `.bobonyo/agents/<name>.md`       |
| Tools        | `~/.config/bobonyo/tools/<name>.md`        | `.bobonyo/tools/<name>.md`        |

Legacy `.nanocoder/` paths remain supported for existing Bobonyo users. New files should use `.bobonyo/`.

Custom tools are exposed to models as `custom__<name>` so they cannot shadow
built-in or MCP tools. Frontmatter `arguments` become the model-facing JSON
schema, and `{{argument}}` placeholders expand in both `command` and body.

## Migration from Claude Code or Codex

Migration means copying selected files into Bobonyo-owned paths. Bobonyo never silently consumes another tool's private configuration.

### Skills

Claude Code and Codex both use a folder containing `SKILL.md`. Copy that folder without rewriting its Markdown:

```bash
mkdir -p .bobonyo/skills
cp -R <source-skill-folder> .bobonyo/skills/
```

Result:

```text
.bobonyo/skills/deploy/SKILL.md
.bobonyo/skills/deploy/scripts/check.mjs
.bobonyo/skills/deploy/references/runbook.md
```

Bobonyo reads the copied `.bobonyo/skills/deploy/SKILL.md`. Helper files remain addressed by explicit relative paths from that skill folder.

### Commands and custom prompts

Copy a Claude Code command or Codex custom prompt to `.bobonyo/commands/<name>.md`.

Bobonyo supports common prompt arguments including `$ARGUMENTS`, `$ARGUMENTS[N]`, `$0`, and declared named arguments. The copied file remains Markdown; no JavaScript wrapper is needed.

### Hooks

Claude Code stores hooks under `hooks` in `settings.json`. Codex supports the same event/group/handler JSON shape in `hooks.json`. Bobonyo accepts both representations, but only from Bobonyo-owned locations:

- `.bobonyo/hooks.json`
- `.bobonyo/settings.json`
- `~/.config/bobonyo/hooks.json`
- `~/.config/bobonyo/settings.json`

Prefer `.bobonyo/hooks.json` for portable project hooks. Keep hook code in `.bobonyo/hooks/` and reference its path explicitly:

```json
{
	"hooks": {
		"PreToolUse": [
			{
				"matcher": "Bash",
				"hooks": [
					{
						"type": "command",
						"command": "bun \"$(git rev-parse --show-toplevel)/.bobonyo/hooks/check-command.mjs\"",
						"timeout": 30
					}
				]
			}
		]
	}
}
```

Hook commands receive event JSON on stdin. Exit code `2` blocks the operation. A JSON response may return `hookSpecificOutput.permissionDecision`, `permissionDecisionReason`, `updatedInput`, or `additionalContext`.

Bobonyo currently implements command, HTTP, prompt, and agent handlers. This is broader than Codex's current command/MCP execution model and differs from Claude Code in some lifecycle details. Copy hook configuration first, then test blocking and input-rewrite behavior before relying on it.

## Why `.mjs` files exist

A hook script is useful only when behavior needs code: parse event JSON, inspect structured tool input, share logic, or run tests. Simple workflows belong in Markdown:

- `.bobonyo/skills/<name>/SKILL.md` for reusable procedures
- `.bobonyo/commands/<name>.md` for explicit slash workflows
- `AGENTS.md` for durable repository rules

Use `.bobonyo/hooks/<name>.mjs` only for deterministic lifecycle enforcement. Large stateful workflow engines in hooks are brittle and should be avoided.
