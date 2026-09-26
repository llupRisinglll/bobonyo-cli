import {execFileSync} from 'node:child_process';
import type {Mode} from './modes';

export function herdrAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === '1';
}

export type HerdrSplit = 'vertical' | 'horizontal';

/** Explicit flag prevents child config from changing parent execution policy. */
export function herdrForkCommand(sessionId: string, mode: Mode): string {
	const modeArgument =
		mode === 'yolo' ? '--yolo' : `--mode ${shellQuote(mode)}`;
	return `bobonyo --resume ${shellQuote(sessionId)} ${modeArgument}`;
}

export function forkInHerdrPane(
	sessionId: string,
	mode: Mode,
	split: HerdrSplit = 'vertical',
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (!herdrAvailable(env)) {
		throw new Error('/herdr:fork is only available inside Herdr.');
	}
	const direction = split === 'horizontal' ? 'down' : 'right';
	const splitResult = JSON.parse(
		execFileSync(
			'herdr',
			[
				'pane',
				'split',
				'--current',
				'--direction',
				direction,
				'--cwd',
				cwd,
				'--no-focus',
			],
			{encoding: 'utf8', env},
		),
	) as {result?: {pane?: {pane_id?: string}}};
	const paneId = splitResult.result?.pane?.pane_id;
	if (!paneId) throw new Error('Herdr did not return a new pane id.');
	const command = herdrForkCommand(sessionId, mode);
	execFileSync('herdr', ['pane', 'run', paneId, command], {
		encoding: 'utf8',
		env,
	});
	return paneId;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
