import {execFileSync} from 'node:child_process';

export function herdrAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === '1';
}

export type HerdrSplit = 'vertical' | 'horizontal';

export function forkInHerdrPane(
	sessionId: string,
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
	const command = `bobonyo --resume ${shellQuote(sessionId)}`;
	execFileSync('herdr', ['pane', 'run', paneId, command], {
		encoding: 'utf8',
		env,
	});
	return paneId;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
