#!/usr/bin/env bash
set -euo pipefail

base=${1:-HEAD^}
if [[ "$base" =~ ^0+$ ]] || ! git rev-parse --verify "$base" >/dev/null 2>&1; then
	base=HEAD^
fi
files=$(git diff --name-only --diff-filter=ACMR "$base...HEAD"; git diff --name-only --diff-filter=ACMR; git diff --cached --name-only --diff-filter=ACMR; git ls-files --others --exclude-standard | grep -E '^(src|scripts|\.github|\.changeset)/|^(package\.json|tsconfig\.json|README\.md|AGENTS\.md)$' || true)
formatted=$(printf '%s\n' "$files" | grep -E '^(src|scripts|\.github|\.changeset)/|^(package\.json|tsconfig\.json|README\.md|AGENTS\.md)$' | grep -E '\.(ts|tsx|mjs|js|json|md|ya?ml|css)$' | grep -v '^CHANGELOG\.md$' || true)

if [[ -z "$formatted" ]]; then
	echo 'No changed files need formatting checks.'
	exit 0
fi

printf '%s\n' "$formatted" | xargs -r npx prettier --check
