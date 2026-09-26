import {statSync} from 'node:fs';

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Recover only to the launch boundary, never an arbitrary surviving ancestor. */
export function recoverWorkingDirectory(
	current: string,
	launchRoot: string,
): string | undefined {
	if (isDirectory(current)) return undefined;
	if (!isDirectory(launchRoot))
		throw new Error(
			'Working directory and launch workspace are unavailable. Restore the workspace before continuing.',
		);
	process.chdir(launchRoot);
	return process.cwd();
}
