import type {RowStatus} from './row-highlight';

export interface ToolDisplayData {
	name: string;
	detail: string;
	output: string;
	/** Raw call arguments (file previews diff old/new from these). */
	args?: Record<string, unknown>;
	/** Pre-tool narration owns glyph; grouped file labels become branches. */
	briefed?: boolean;
	/** Task-only compact form for superseded checklist snapshots. */
	compactTask?: boolean;
}

export type {RowStatus};
