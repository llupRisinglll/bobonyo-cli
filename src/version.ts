/**
 * Single source of truth for the bobonyo version. package.json's `version`
 * field is canonical — `scripts/release.mjs` bumps ONLY that field when it
 * consumes `.changeset/` entries, and every user-facing surface (banner,
 * /status, MCP client info, version modal) reads this module. A release can
 * therefore never show a stale hardcoded version.
 */
import packageJson from '../package.json';

export const VERSION: string = packageJson.version;
