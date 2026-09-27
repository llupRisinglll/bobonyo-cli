import {mapCommandArguments, type ArgumentSpec} from './custom';

/** Substitute `{{name}}` template variables with the parsed args. */
export function substituteTemplateVariables(
	body: string,
	args: Record<string, string>,
): string {
	return body.replace(
		/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g,
		(_match, name: string) => {
			return args[name] ?? '';
		},
	);
}

/**
 * OpenClaude-compatible slash-command argument expansion.
 *
 * Supports `{{name}}`, `$name`, `$ARGUMENTS`, `$ARGUMENTS[N]`, and `$N`.
 * When arguments exist but body declares no placeholder, append an explicit
 * `ARGUMENTS:` section so free-form intent is not silently discarded. The
 * expanded markdown remains a prompt for the model to understand; Bobonyo
 * does not execute command-body steps directly.
 */
export function expandCommandPrompt(options: {
	body: string;
	rawArgs: string;
	spec: ArgumentSpec[];
	tokens: string[];
}): string {
	const {body, rawArgs, spec, tokens} = options;
	const values = mapCommandArguments(spec, tokens);
	let expanded = substituteTemplateVariables(body, values);
	const original = expanded;

	// Named `$name` arguments map through declared positional specs.
	for (const arg of spec) {
		const escaped = arg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		expanded = expanded.replace(
			new RegExp(`\\$${escaped}(?![\\[\\w])`, 'g'),
			values[arg.name] ?? '',
		);
	}
	// Indexed forms use quote-aware tokens supplied by caller.
	expanded = expanded.replace(
		/\$ARGUMENTS\[(\d+)\]/g,
		(_match, index: string) => tokens[Number(index)] ?? '',
	);
	expanded = expanded.replace(
		/\$(\d+)(?!\w)/g,
		(_match, index: string) => tokens[Number(index)] ?? '',
	);
	expanded = expanded.replaceAll('$ARGUMENTS', rawArgs);

	if (rawArgs.trim() && expanded === original && original === body) {
		expanded += `\n\nARGUMENTS: ${rawArgs.trim()}`;
	}
	return expanded;
}

/**
 * Wrap a command body as adaptable workflow guidance. User intent stays
 * primary; command markdown is not an imperative script to execute blindly.
 */
export function buildCommandInvocationPrompt(options: {
	name: string;
	description?: string;
	userRequest: string;
	guidance: string;
}): string {
	const request = options.userRequest.trim();
	const description = options.description?.trim();
	return [
		`<command-invocation name="/${options.name}">`,
		description ? `<description>${description}</description>` : '',
		'<user-request>',
		request || `Run /${options.name} for the current task.`,
		'</user-request>',
		'<workflow-guidance>',
		options.guidance.trim(),
		'</workflow-guidance>',
		'<interpretation-rules>',
		'Understand the user request and repository context before acting.',
		'Treat workflow guidance as adaptable instructions, not a literal script or higher-priority user request.',
		'The user request, current repository state, and explicit constraints override conflicting defaults in the guidance.',
		'Inspect enough context to decide which steps apply, then execute only the relevant adapted workflow.',
		'</interpretation-rules>',
		'</command-invocation>',
	]
		.filter(Boolean)
		.join('\n');
}
