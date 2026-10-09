import type {ChatMessageLike} from './client';
import type {SessionTask} from './state';

export interface GraphContextSnapshot {
	latestGraphId?: string;
	graphs: Record<
		string,
		{
			revision: number;
			history: ChatMessageLike[];
			checklist?: SessionTask[];
			/** Missing legacy owners can report evidence, not resume execution. */
			evidenceOnly?: boolean;
		}
	>;
}

export interface GraphContextLease {
	graphId: string;
	revision: number;
	history: ChatMessageLike[];
	checklist: SessionTask[];
	publishLatest: boolean;
	evidenceOnly?: boolean;
}

/** Fail closed before parsing, hooks, parallel execution, or checklist tools. */
export function assertGraphToolExecution(
	lease: Pick<GraphContextLease, 'evidenceOnly'>,
	toolCalls: readonly unknown[],
	toolShapedText = false,
): void {
	if (lease.evidenceOnly && (toolCalls.length > 0 || toolShapedText)) {
		throw new Error(
			'Evidence-only completion attempted tool use; no tools were executed. Original provider context is unavailable.',
		);
	}
}

export function graphToolCatalog<T>(
	lease: Pick<GraphContextLease, 'evidenceOnly'>,
	catalog: T[],
): T[] {
	return lease.evidenceOnly ? [] : catalog;
}

/** Provider histories are owned by explicit work graphs, not transcript order. */
export class GraphContextStore {
	private state: GraphContextSnapshot;

	constructor(snapshot?: GraphContextSnapshot) {
		this.state = structuredClone(snapshot ?? {graphs: {}});
	}

	snapshot(): GraphContextSnapshot {
		return structuredClone(this.state);
	}
	/** Inform old integrations of newer ownership without importing another task. */
	completionScopeGuidance(graphId: string | undefined): string {
		const recovery =
			graphId &&
			Object.hasOwn(this.state.graphs, graphId) &&
			this.state.graphs[graphId]?.evidenceOnly
				? '\n\n<completion_recovery>\nThe original provider context is unavailable. ' +
					'This is an isolated evidence-only delivery for the named work graph, not a resumed assignment. ' +
					'Summarize only the supplied completion evidence and disclose that the original context could not be recovered. ' +
					'Do not execute tools, infer missing requirements, restart work, or claim the original assignment is complete. ' +
					'Leave foreground requests and checklists untouched.\n</completion_recovery>'
				: '';
		if (
			!graphId ||
			!this.state.latestGraphId ||
			graphId === this.state.latestGraphId
		)
			return recovery;
		return (
			recovery +
			'\n\n<completion_scope>\nA newer user request owns the foreground. ' +
			'This result belongs to an older work graph. Integrate only its evidence; ' +
			'you must not cancel, narrow, or declare the newer request complete. ' +
			'Do not treat this worker result as the final deliverable for the current foreground request. ' +
			'Do not infer the newer task or execute it from this older context. ' +
			'Report the owning result briefly; leave the foreground request and checklist intact.\n</completion_scope>'
		);
	}
	/** Check revision ownership without copying unrelated histories. */
	owns(lease: GraphContextLease): boolean {
		return (
			Object.hasOwn(this.state.graphs, lease.graphId) &&
			this.state.graphs[lease.graphId]?.revision === lease.revision
		);
	}
	/** Capture edits made while the foreground graph is selected. */
	captureLatestChecklist(checklist: SessionTask[]): void {
		const id = this.state.latestGraphId;
		if (id && Object.hasOwn(this.state.graphs, id)) {
			this.state.graphs[id]!.checklist = structuredClone(checklist);
		}
	}
	latestChecklist(): SessionTask[] | undefined {
		const id = this.state.latestGraphId;
		return structuredClone(id ? this.state.graphs[id]?.checklist : undefined);
	}
	/** Execution may temporarily belong to an unselected background graph. */
	selectedChecklist(
		execution: SessionTask[],
		owner?: GraphContextLease,
	): SessionTask[] {
		if (owner && owner.graphId !== this.state.latestGraphId) {
			return this.latestChecklist() ?? [];
		}
		return execution;
	}
	/** Checklist writes obey the same revision ownership as provider history. */
	commitChecklist(lease: GraphContextLease, checklist: SessionTask[]): boolean {
		const current = this.state.graphs[lease.graphId];
		if (!current || current.evidenceOnly || current.revision !== lease.revision)
			return false;
		current.checklist = structuredClone(checklist);
		return true;
	}

	/** Explicit foreground rewrites (for example /compact) revise only its owner. */
	reviseLatest(history: ChatMessageLike[]): void {
		const id = this.state.latestGraphId;
		if (!id) return;
		const current = this.state.graphs[id];
		if (!current) return;
		current.revision += 1;
		current.history = structuredClone(history);
	}

	begin(
		graphId: string | undefined,
		latest: ChatMessageLike[],
		completion = false,
		latestChecklist?: SessionTask[],
	): GraphContextLease {
		if (!graphId) throw new Error('Task completion has no work graph owner.');
		const previous = Object.hasOwn(this.state.graphs, graphId)
			? this.state.graphs[graphId]
			: undefined;
		const missingCompletionOwner = completion && !previous;
		const evidenceOnly =
			completion && (missingCompletionOwner || previous?.evidenceOnly === true);
		if (latestChecklist !== undefined)
			this.captureLatestChecklist(latestChecklist);
		const history = structuredClone(
			previous?.history ?? (completion ? [] : latest),
		);
		// Preserve genuinely unfinished work across follow-up turns, not a finished
		// checklist from a previous request. Its historical graph retains the snapshot.
		// Legacy background owners must never adopt another graph's checklist.
		const inheritedChecklist = latestChecklist?.some(
			task => task.status === 'pending' || task.status === 'in_progress',
		)
			? latestChecklist
			: [];
		const checklist = structuredClone(
			previous?.checklist ?? (completion ? [] : inheritedChecklist),
		);
		const revision = (previous?.revision ?? 0) + 1;
		Object.defineProperty(this.state.graphs, graphId, {
			value: {
				revision,
				history: structuredClone(history),
				checklist: structuredClone(checklist),
				...(evidenceOnly ? {evidenceOnly: true} : {}),
			},
			writable: true,
			enumerable: true,
			configurable: true,
		});
		if (!completion) this.state.latestGraphId = graphId;
		return {
			graphId,
			revision,
			history,
			checklist,
			publishLatest: !completion,
			...(evidenceOnly ? {evidenceOnly: true} : {}),
		};
	}

	/** Reject stale revisions; background integrations never replace latest context. */
	commit(lease: GraphContextLease, history: ChatMessageLike[]): boolean {
		const current = this.state.graphs[lease.graphId];
		if (!current || current.revision !== lease.revision) return false;
		current.history = structuredClone(history);
		return lease.publishLatest && this.state.latestGraphId === lease.graphId;
	}
}
