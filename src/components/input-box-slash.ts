import {COMMAND_ARGUMENT_HINTS} from '../commands';
import {
	loadCustomCommands,
	loadSkills,
	parseCommandArguments,
	type ArgumentSpec,
} from '../custom';

/** Active slash token after the cursor, anywhere in whitespace-delimited text. */
export function slashToken(
	inputText: string,
	cursor = inputText.length,
): string | null {
	const slash = inputText.lastIndexOf('/', cursor - 1);
	if (slash < 0) return null;
	const before = inputText.slice(0, slash);
	const after = inputText.slice(slash + 1, cursor);
	if (before.length > 0 && !/\s/.test(before.at(-1)!)) return null;
	if (/\s/.test(after)) return null;
	return after;
}

/** Replace active slash token while preserving text before and after cursor. */
export function insertSlashCommand(
	inputText: string,
	name: string,
	cursor = inputText.length,
): {value: string; cursor: number} {
	const token = slashToken(inputText, cursor);
	if (token === null) return {value: inputText, cursor};
	const slash = inputText.lastIndexOf('/', cursor - 1);
	const value =
		inputText.slice(0, slash) + `/${name} ` + inputText.slice(cursor);
	return {value, cursor: slash + name.length + 2};
}

function progressiveArgumentHint(spec: ArgumentSpec[], args: string): string {
	if (!spec.length) return '';
	const filled = parseCommandArguments(args).length;
	return spec
		.slice(filled)
		.map(arg => (arg.required === false ? `[${arg.name}]` : `<${arg.name}>`))
		.join(' ');
}

/** Gray fish-style argument suggestion after a complete leading slash command. */
export function slashArgumentHint(inputText: string): string {
	const match = inputText.match(/^\/([^\s]+)(?:\s(.*))?$/s);
	if (!match) return '';
	const [, name] = match;
	if (!name) return '';
	const argumentEntry = inputText.slice(name.length + 1);
	if (argumentEntry !== '' && argumentEntry !== ' ') return '';
	const builtin = COMMAND_ARGUMENT_HINTS[name];
	if (builtin) return builtin;
	const command = loadCustomCommands().find(item => item.name === name);
	if (command)
		return (
			command.argumentHint ?? progressiveArgumentHint(command.arguments, '')
		);
	const skill = loadSkills().find(item => item.name === name);
	return skill
		? (skill.argumentHint ?? progressiveArgumentHint(skill.arguments, ''))
		: '';
}

/** A typed first separator replaces the hint's decorative separator. */
export function slashArgumentHintPrefix(inputText: string): string {
	return inputText.endsWith(' ') ? '' : ' ';
}
