export interface ArgumentSpec {
	name: string;
	type?: string;
	required?: boolean;
	description?: string;
	/** Capture ALL remaining tokens as ONE value (multi-word purposes). */
	rest?: boolean;
}

export interface CustomCommand {
	name: string;
	description: string;
	argumentHint?: string;
	arguments: ArgumentSpec[];
	body: string;
	source: string;
	subscribe?: string[];
}

/**
 * Map command tokens to argument values: positional args take one token
 * each; a `rest: true` arg captures EVERYTHING after the positional ones as
 * a single value (multi-word purposes like `/worktree purpose: hello world`).
 * Pure, unit-tested.
 */
/** Quote-aware command argument tokenizer. */
export function parseCommandArguments(input: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input))) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
	}
	return tokens;
}

export function mapCommandArguments(
	spec: ArgumentSpec[],
	tokens: string[],
): Record<string, string> {
	const values: Record<string, string> = {};
	let cursor = 0;
	for (const arg of spec) {
		if (arg.rest) {
			values[arg.name] = tokens.slice(cursor).join(' ').trim();
			cursor = tokens.length;
		} else {
			values[arg.name] = tokens[cursor] ?? '';
			cursor += 1;
		}
	}
	return values;
}

export function parseArgumentSpecs(value: unknown): ArgumentSpec[] {
	return (Array.isArray(value) ? value : [])
		.map((arg): ArgumentSpec | null => {
			if (typeof arg === 'string') return {name: arg};
			if (!arg || typeof arg !== 'object') return null;
			const source = arg as Record<string, unknown>;
			if (typeof source.name !== 'string') return null;
			return {
				name: source.name,
				...(typeof source.type === 'string' ? {type: source.type} : {}),
				...(typeof source.required === 'boolean'
					? {required: source.required}
					: {}),
				...(typeof source.description === 'string'
					? {description: source.description}
					: {}),
				...(typeof source.rest === 'boolean' ? {rest: source.rest} : {}),
			};
		})
		.filter((arg): arg is ArgumentSpec => arg !== null);
}
