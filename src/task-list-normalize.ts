import type {SessionTask, TaskStatus} from './state';

const TASK_STATUSES = new Set<TaskStatus>([
	'pending',
	'in_progress',
	'completed',
	'cancelled',
]);

export function normalizeTaskList(value: unknown): SessionTask[] {
	if (!Array.isArray(value)) return [];
	const normalized = value
		.map((item, index) => {
			if (typeof item === 'string') {
				const title = item.trim();
				return title
					? {id: `task_${index + 1}`, title, status: 'pending' as const}
					: null;
			}
			if (!item || typeof item !== 'object') return null;
			const row = item as Record<string, unknown>;
			const title = String(row.title ?? '').trim();
			if (!title) return null;
			const activeForm =
				typeof row.activeForm === 'string' && row.activeForm.trim()
					? row.activeForm.trim()
					: undefined;
			const legacyStatus =
				row.done === true
					? 'completed'
					: row.running === true
						? 'in_progress'
						: undefined;
			const requested = String(
				row.status ?? legacyStatus ?? 'pending',
			) as TaskStatus;
			const status = TASK_STATUSES.has(requested) ? requested : 'pending';
			const id = String(row.id ?? `task_${index + 1}`).trim();
			const dependsOn = Array.isArray(row.dependsOn)
				? row.dependsOn.map(String).filter(Boolean)
				: Array.isArray(row.depends_on)
					? row.depends_on.map(String).filter(Boolean)
					: undefined;
			const owner = String(row.owner ?? '').trim() || undefined;
			return {
				id,
				title,
				...(activeForm ? {activeForm} : {}),
				status,
				...(dependsOn?.length ? {dependsOn} : {}),
				...(owner ? {owner} : {}),
			};
		})
		.filter((item): item is NonNullable<typeof item> => item !== null);
	let activeSeen = false;
	return normalized.map(item => {
		if (item.status !== 'in_progress') return item;
		if (!activeSeen) {
			activeSeen = true;
			return item;
		}
		return {...item, status: 'pending'};
	});
}
