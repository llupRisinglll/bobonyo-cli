import {lstatSync, realpathSync} from 'node:fs';
import {basename, dirname, isAbsolute, relative, resolve} from 'node:path';

export interface RemovalGuardResult {
	allowed: boolean;
	reason?: string;
	targets?: string[];
}

const REMOVAL_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred']);
const SHELL_WRAPPERS = new Set([
	'sudo',
	'command',
	'env',
	'nice',
	'nohup',
	'timeout',
]);

function insideRoot(path: string, root: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return (
		rel !== '' &&
		rel !== '..' &&
		!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
		!isAbsolute(rel)
	);
}
function insideWorkspace(path: string, cwd: string): boolean {
	return insideRoot(path, cwd);
}

function shellWords(command: string): string[] {
	const words: string[] = [];
	let current = '';
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === '\\' && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char) || ';|&()\n'.includes(char)) {
			if (current) words.push(current);
			current = '';
			if (';|&()'.includes(char)) words.push(char);
			continue;
		}
		current += char;
	}
	if (current) words.push(current);
	return words;
}

function commandIndex(words: string[]): number {
	let index = 0;
	while (index < words.length) {
		const token = words[index] ?? '';
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			index += 1;
			continue;
		}
		const word = basename(token);
		if (!SHELL_WRAPPERS.has(word)) return index;
		index += 1;
		while (index < words.length && words[index]!.startsWith('-')) index += 1;
		if (
			word === 'timeout' &&
			index < words.length &&
			/^\d/.test(words[index]!)
		) {
			index += 1;
		}
	}
	return index;
}

function splitCommands(words: string[]): string[][] {
	const commands: string[][] = [];
	let current: string[] = [];
	for (const word of words) {
		if ([';', '|', '&', '(', ')'].includes(word)) {
			if (current.length > 0) commands.push(current);
			current = [];
		} else current.push(word);
	}
	if (current.length > 0) commands.push(current);
	return commands;
}

function removalTargets(words: string[], commandAt: number): string[] {
	const targets: string[] = [];
	let afterDoubleDash = false;
	for (const word of words.slice(commandAt + 1)) {
		if (!afterDoubleDash && word === '--') {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash && word.startsWith('-')) continue;
		targets.push(word);
	}
	return targets;
}

function existingAncestor(path: string): string | undefined {
	let current = path;
	for (;;) {
		try {
			return realpathSync(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

/**
 * Strict Bash deletion boundary.
 *
 * Removal commands may target literal paths strictly below cwd only. Dynamic
 * expansion, globs, shell indirection, cwd itself, symlink traversal, and any
 * outside path are refused before Bash starts. Complex deletion should use a
 * dedicated file tool instead of trying to outsmart this guard.
 */
export function checkBashRemovalSafety(
	command: string,
	cwd: string,
	allowedExternalRoots: string[] = [],
): RemovalGuardResult {
	const words = shellWords(command);
	const hasRemovalWord = words.some(word =>
		REMOVAL_COMMANDS.has(basename(word)),
	);
	const hasFindDelete =
		words.some(word => basename(word) === 'find') && words.includes('-delete');
	const shellIndirection =
		/(?:^|[;&|()\n]\s*|\s)(?:eval|bash|sh|zsh)\s+(?:-[^\s]*c\b)?[\s\S]*\b(?:rm|rmdir|unlink|shred)\b/.test(
			command,
		);
	if (shellIndirection) {
		return {
			allowed: false,
			reason: 'shell indirection can hide deletion targets',
		};
	}
	if (!hasRemovalWord && !hasFindDelete) return {allowed: true};

	if (hasFindDelete) {
		return {
			allowed: false,
			reason: '`find -delete` bypasses explicit target checks',
		};
	}
	if (/\bcd\b/.test(command)) {
		return {
			allowed: false,
			reason: 'changing directory inside a deletion command is ambiguous',
		};
	}

	const checked: string[] = [];
	for (const segment of splitCommands(words)) {
		const index = commandIndex(segment);
		const base = basename(segment[index] ?? '');
		const segmentHasRemoval = segment.some(word =>
			REMOVAL_COMMANDS.has(basename(word)),
		);
		if (!segmentHasRemoval) continue;
		if (!REMOVAL_COMMANDS.has(base)) {
			return {
				allowed: false,
				reason: 'indirect removal syntax cannot be verified safely',
			};
		}
		const optionWords = segment
			.slice(index + 1)
			.filter(word => word.startsWith('-'));
		if (
			base === 'rm' &&
			optionWords.some(
				word => word === '--recursive' || /^-[^-]*[rR]/.test(word),
			)
		) {
			return {
				allowed: false,
				reason:
					'recursive rm is disabled; remove files explicitly with delete_file',
			};
		}
		const targets = removalTargets(segment, index);
		if (targets.length === 0) {
			return {
				allowed: false,
				reason: `${base} has no statically verified target`,
			};
		}
		for (const target of targets) {
			if (/[$`*?\[\]{}!~]/.test(target)) {
				return {
					allowed: false,
					reason: `dynamic or globbed target '${target}' is not allowed`,
				};
			}
			const absolute = resolve(cwd, target);
			const allowedRoot = [cwd, ...allowedExternalRoots].find(root =>
				insideRoot(absolute, root),
			);
			if (!allowedRoot) {
				return {
					allowed: false,
					reason: `target '${absolute}' is outside current workspace or is workspace root`,
				};
			}
			const ancestor = existingAncestor(absolute);
			if (
				ancestor &&
				resolve(ancestor) !== resolve(allowedRoot) &&
				!insideRoot(ancestor, allowedRoot)
			) {
				return {
					allowed: false,
					reason: `target ancestor '${ancestor}' escapes current workspace`,
				};
			}
			try {
				const stat = lstatSync(absolute);
				if (stat.isSymbolicLink()) {
					return {
						allowed: false,
						reason: `symlink target '${absolute}' requires delete_file`,
					};
				}
				const real = realpathSync(absolute);
				if (!insideRoot(real, allowedRoot)) {
					return {
						allowed: false,
						reason: `resolved target '${real}' escapes current workspace`,
					};
				}
			} catch {
				// Missing targets are harmless; rm will report them normally.
			}
			checked.push(absolute);
		}
	}
	return checked.length > 0
		? {allowed: true, targets: checked}
		: {
				allowed: false,
				reason: 'deletion syntax could not be verified safely',
			};
}

export function pathInsideWorkspace(path: string, cwd: string): boolean {
	return insideWorkspace(resolve(cwd, path), cwd);
}
