import type {ActiveAgentRun} from './state';

const ORDINAL_WORDS = [
	'alpha',
	'beta',
	'gamma',
	'delta',
	'epsilon',
	'zeta',
	'eta',
	'theta',
	'iota',
	'kappa',
	'lambda',
	'mu',
	'nu',
	'xi',
	'omicron',
	'pi',
	'rho',
	'sigma',
	'tau',
	'upsilon',
	'phi',
	'chi',
	'psi',
	'omega',
];

function firstGoalSentence(value: string): string {
	const sentence = value.match(/^(.+?)(?:\.(?:\s|$)|$)/)?.[1] ?? value;
	return sentence.replace(/[,:;]+$/, '').trim();
}

export function agentLabelBase(description: string): string {
	let label = description
		.replace(/\s+/g, ' ')
		.replace(/^in\s+[^,]+,\s*/i, '')
		.replace(/^within\s+[^,]+,\s*/i, '')
		.replace(/^for the test,\s*/i, '')
		.replace(/^delegate\s+/i, '')
		.replace(/^task:\s*/i, '')
		.replace(/^do not edit files\.\s*/i, '')
		.replace(/^first run (?:exactly )?`?sleep\s+[^`.,;]+`?[.,;]?\s*/i, '')
		.replace(/^then\s+/i, '')
		.trim();
	label = firstGoalSentence(label);
	if (!label) label = 'Background task';
	return label;
}

export function nextAgentDisplayLabel(
	description: string,
	existing: Array<Pick<ActiveAgentRun, 'description' | 'displayLabel'>>,
): string {
	const base = agentLabelBase(description);
	const used = new Set(
		existing.map(run =>
			(run.displayLabel ?? agentLabelBase(run.description)).toLowerCase(),
		),
	);
	if (!used.has(base.toLowerCase())) return base;
	for (let number = 2; ; number++) {
		const prefix = `${ORDINAL_WORDS[number - 2] ?? number}: `;
		const candidate = `${prefix}${base}`;
		if (!used.has(candidate.toLowerCase())) return candidate;
	}
}

export function agentDisplayLabels(
	runs: Array<Pick<ActiveAgentRun, 'description' | 'displayLabel'>>,
): string[] {
	const bases = runs.map(run => agentLabelBase(run.description));
	const counts = new Map<string, number>();
	for (const base of bases)
		counts.set(base.toLowerCase(), (counts.get(base.toLowerCase()) ?? 0) + 1);
	const seen = new Map<string, number>();
	return runs.map((run, index) => {
		const base = bases[index]!;
		if ((counts.get(base.toLowerCase()) ?? 0) < 2) {
			return run.displayLabel && !/^\w+: /.test(run.displayLabel)
				? run.displayLabel
				: base;
		}
		const occurrence = seen.get(base.toLowerCase()) ?? 0;
		seen.set(base.toLowerCase(), occurrence + 1);
		const prefix = `${ORDINAL_WORDS[occurrence] ?? occurrence + 1}: `;
		return `${prefix}${base}`;
	});
}
