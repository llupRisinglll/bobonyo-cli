import {isMode, MODES, type Mode} from './modes';

/** Resolve explicit mode flags without booting the renderer. Conflicts are errors. */
export function cliMode(args: string[]): Mode | undefined {
	let selected: Mode | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (
			argument !== '--yolo' &&
			argument !== '--mode' &&
			!argument.startsWith('--mode=')
		)
			continue;
		const value =
			argument === '--yolo'
				? 'yolo'
				: argument === '--mode'
					? args[++index]
					: argument.slice('--mode='.length);
		if (!isMode(value))
			throw new Error(
				`Invalid mode '${value ?? ''}'. Use ${MODES.join(', ')}.`,
			);
		if (selected && selected !== value)
			throw new Error('Conflicting mode flags. Choose one mode.');
		selected = value;
	}
	return selected;
}

export const MODE_HELP = `Usage: bobonyo [options]

  --mode <mode>    default, normal, plan, auto-accept, or yolo
  --yolo          Disable the sandbox and tool permission prompts
  --profile <id>  full, minimal, nano, or auto
  --provider <id> Select a configured provider
  --resume [id]   Resume a session (last by default)
  --continue     Resume the last session
  --help         Show this help

Default mode auto-approves tools with the configured command sandbox (auto).
Auto sandbox uses bubblewrap when available; otherwise it runs without isolation.
Use workspace-write sandbox mode to require isolation and fail closed.
WARNING: --yolo allows host access without tool permission prompts.
Clarification questions, safety guards, and hooks remain enabled.`;
