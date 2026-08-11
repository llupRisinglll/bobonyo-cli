/**
 * Status-line path label, PURE (unit-tested). The footer must stay on ONE
 * row: the cwd `[user /path]` label shrinks to whatever width remains after
 * the FULL left segment (mode/tune/model[effort]/ctx/agents/bg). Forgetting
 * any segment made the line overflow and OpenTUI clipped `~N%`/`bg: N`
 * digits out of the middle nodes.
 */
export function statusPathLabel(options: {
	left: string;
	user: string;
	cwd: string;
	width: number;
}): string {
	const {left, user, cwd, width} = options;
	const base = cwd.split('/').pop() ?? cwd;
	const budget = Math.max(1, width - left.length);
	// With the user prefix: `[user path]`, brackets (2) + space (1) + user.
	const userPath = `[${user} ${cwd}]`;
	if (userPath.length <= budget) return userPath;
	const pathBudget = Math.max(1, budget - user.length - 4);
	const path = `…/${base}`.slice(-pathBudget);
	const withUser = `[${user} ${path}]`;
	if (withUser.length <= budget) return withUser;
	// Extremely narrow: drop the user, keep the base name.
	const bare = `[${path}]`;
	if (bare.length <= budget) return bare;
	return `[${base}]`.slice(0, Math.max(budget, 1));
}
