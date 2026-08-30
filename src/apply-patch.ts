import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';

export interface PatchChunk {
	oldLines: string[];
	newLines: string[];
	context?: string;
	endOfFile?: boolean;
}
export type PatchHunk =
	| {type: 'add'; path: string; content: string}
	| {type: 'delete'; path: string}
	| {type: 'update'; path: string; movePath?: string; chunks: PatchChunk[]};
export interface PlannedPatchChange {
	type: 'add' | 'delete' | 'update' | 'move';
	path: string;
	targetPath: string;
	oldContent: string;
	newContent: string;
	additions: number;
	deletions: number;
}

export interface ApplyPatchDisplayRow {
	kind: 'context' | 'add' | 'remove';
	line: number;
	text: string;
}

export interface ApplyPatchDisplayChange {
	type: PlannedPatchChange['type'];
	path: string;
	targetPath?: string;
	rows: ApplyPatchDisplayRow[];
}

function cleanPatchText(input: string): string {
	const trimmed = input.replace(/\r\n?/g, '\n').trim();
	const heredoc = /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/.exec(
		trimmed,
	);
	return heredoc?.[2] ?? trimmed;
}

export function parseApplyPatch(input: string): PatchHunk[] {
	const lines = cleanPatchText(input).split('\n');
	if (lines[0]?.trim() !== '*** Begin Patch') {
		throw new Error("first line must be '*** Begin Patch'");
	}
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === '*** End Patch',
	);
	if (end < 0) throw new Error("missing '*** End Patch'");
	if (lines.slice(end + 1).some(line => line.trim())) {
		throw new Error('unexpected content after End Patch');
	}
	const hunks: PatchHunk[] = [];
	let index = 1;
	while (index < end) {
		const header = lines[index]!;
		if (!header.trim()) {
			index += 1;
			continue;
		}
		if (header.startsWith('*** Add File:')) {
			const path = header.slice('*** Add File:'.length).trim();
			if (!path) throw new Error('Add File requires a path');
			index += 1;
			const content: string[] = [];
			while (index < end && !lines[index]!.startsWith('*** ')) {
				const line = lines[index++]!;
				if (!line.startsWith('+')) {
					throw new Error(`Add File lines must start with +: ${line}`);
				}
				content.push(line.slice(1));
			}
			hunks.push({type: 'add', path, content: `${content.join('\n')}\n`});
			continue;
		}
		if (header.startsWith('*** Delete File:')) {
			const path = header.slice('*** Delete File:'.length).trim();
			if (!path) throw new Error('Delete File requires a path');
			hunks.push({type: 'delete', path});
			index += 1;
			continue;
		}
		if (header.startsWith('*** Update File:')) {
			const path = header.slice('*** Update File:'.length).trim();
			if (!path) throw new Error('Update File requires a path');
			index += 1;
			let movePath: string | undefined;
			if (lines[index]?.startsWith('*** Move to:')) {
				movePath = lines[index]!.slice('*** Move to:'.length).trim();
				if (!movePath) throw new Error('Move to requires a path');
				index += 1;
			}
			const chunks: PatchChunk[] = [];
			while (index < end && !lines[index]!.startsWith('*** ')) {
				const marker = lines[index]!;
				if (!marker.startsWith('@@')) {
					throw new Error(`Update File expected @@ chunk, got: ${marker}`);
				}
				const context = marker.slice(2).trim() || undefined;
				index += 1;
				const oldLines: string[] = [];
				const newLines: string[] = [];
				let endOfFile = false;
				while (
					index < end &&
					!lines[index]!.startsWith('@@') &&
					(!lines[index]!.startsWith('*** ') ||
						lines[index] === '*** End of File')
				) {
					const line = lines[index++]!;
					if (line === '*** End of File') {
						endOfFile = true;
						break;
					}
					if (line.startsWith(' ')) {
						oldLines.push(line.slice(1));
						newLines.push(line.slice(1));
					} else if (line.startsWith('-')) oldLines.push(line.slice(1));
					else if (line.startsWith('+')) newLines.push(line.slice(1));
					else throw new Error(`invalid update line: ${line}`);
				}
				if (oldLines.length === 0 && newLines.length === 0) {
					throw new Error(`empty update chunk for ${path}`);
				}
				chunks.push({oldLines, newLines, context, endOfFile});
			}
			if (chunks.length === 0)
				throw new Error(`Update File ${path} has no chunks`);
			hunks.push({type: 'update', path, movePath, chunks});
			continue;
		}
		throw new Error(`unknown patch directive: ${header}`);
	}
	if (hunks.length === 0) throw new Error('empty patch');
	return hunks;
}

function normalizeUnicode(value: string): string {
	return value
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―]/g, '-')
		.replace(/…/g, '...')
		.replace(/ /g, ' ');
}
function findSequence(
	lines: string[],
	pattern: string[],
	start: number,
	endOfFile = false,
): number {
	if (pattern.length === 0) return -1;
	const comparators = [
		(left: string, right: string) => left === right,
		(left: string, right: string) => left.trimEnd() === right.trimEnd(),
		(left: string, right: string) => left.trim() === right.trim(),
		(left: string, right: string) =>
			normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
	];
	for (const compare of comparators) {
		const candidates: number[] = [];
		if (endOfFile) candidates.push(lines.length - pattern.length);
		for (let index = start; index <= lines.length - pattern.length; index++) {
			if (!candidates.includes(index)) candidates.push(index);
		}
		for (const index of candidates) {
			if (
				index >= start &&
				pattern.every((line, offset) => compare(lines[index + offset]!, line))
			) {
				return index;
			}
		}
	}
	return -1;
}

export function applyChunks(
	path: string,
	chunks: PatchChunk[],
	original: string,
): string {
	const trailingNewline = original.endsWith('\n');
	const lines = original.replace(/\n$/, '').split('\n');
	if (original === '') lines.length = 0;
	const replacements: Array<[number, number, string[]]> = [];
	let cursor = 0;
	for (const chunk of chunks) {
		if (chunk.context) {
			const contextIndex = findSequence(lines, [chunk.context], cursor);
			if (contextIndex < 0) {
				throw new Error(`failed to find context '${chunk.context}' in ${path}`);
			}
			cursor = contextIndex + 1;
		}
		if (chunk.oldLines.length === 0) {
			replacements.push([lines.length, 0, chunk.newLines]);
			continue;
		}
		let oldLines = chunk.oldLines;
		let newLines = chunk.newLines;
		let found = findSequence(lines, oldLines, cursor, chunk.endOfFile);
		if (found < 0 && oldLines.at(-1) === '') {
			oldLines = oldLines.slice(0, -1);
			if (newLines.at(-1) === '') newLines = newLines.slice(0, -1);
			found = findSequence(lines, oldLines, cursor, chunk.endOfFile);
		}
		if (found < 0) {
			throw new Error(
				`failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`,
			);
		}
		replacements.push([found, oldLines.length, newLines]);
		cursor = found + oldLines.length;
	}
	const next = [...lines];
	for (const [start, count, replacement] of replacements.sort(
		(a, b) => b[0] - a[0],
	)) {
		next.splice(start, count, ...replacement);
	}
	const content = next.join('\n');
	return content === ''
		? ''
		: `${content}${trailingNewline || next.length > 0 ? '\n' : ''}`;
}

function workspacePath(cwd: string, requested: string): string {
	if (!requested || isAbsolute(requested))
		throw new Error(`invalid patch path: ${requested}`);
	const path = resolve(cwd, requested);
	const rel = relative(resolve(cwd), path);
	if (
		rel === '..' ||
		rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
	) {
		throw new Error(`patch path escapes workspace: ${requested}`);
	}
	let ancestor = path;
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	if (existsSync(ancestor)) {
		const realRoot = realpathSync(cwd);
		const realAncestor = realpathSync(ancestor);
		const realRel = relative(realRoot, realAncestor);
		if (
			realRel === '..' ||
			realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
		) {
			throw new Error(`patch path resolves outside workspace: ${requested}`);
		}
	}
	return path;
}

export function planApplyPatch(
	cwd: string,
	patchText: string,
): PlannedPatchChange[] {
	const hunks = parseApplyPatch(patchText);
	const planned: PlannedPatchChange[] = [];
	const targets = new Set<string>();
	for (const hunk of hunks) {
		const path = workspacePath(cwd, hunk.path);
		const targetPath = workspacePath(
			cwd,
			hunk.type === 'update' && hunk.movePath ? hunk.movePath : hunk.path,
		);
		if (targets.has(path) || targets.has(targetPath)) {
			throw new Error(`patch modifies a path more than once: ${hunk.path}`);
		}
		targets.add(path);
		targets.add(targetPath);
		if (hunk.type === 'add') {
			if (existsSync(path))
				throw new Error(`file already exists: ${hunk.path}`);
			planned.push({
				type: 'add',
				path,
				targetPath,
				oldContent: '',
				newContent: hunk.content,
				additions:
					hunk.content === '' ? 0 : hunk.content.split('\n').length - 1,
				deletions: 0,
			});
			continue;
		}
		if (!existsSync(path)) throw new Error(`file does not exist: ${hunk.path}`);
		const stat = statSync(path);
		if (!stat.isFile())
			throw new Error(`patch target is not a file: ${hunk.path}`);
		const oldContent = readFileSync(path, 'utf8');
		if (hunk.type === 'delete') {
			planned.push({
				type: 'delete',
				path,
				targetPath,
				oldContent,
				newContent: '',
				additions: 0,
				deletions: oldContent === '' ? 0 : oldContent.split('\n').length,
			});
			continue;
		}
		if (hunk.movePath && existsSync(targetPath)) {
			throw new Error(`move destination already exists: ${hunk.movePath}`);
		}
		const newContent = applyChunks(hunk.path, hunk.chunks, oldContent);
		const additions = hunk.chunks.reduce(
			(sum, chunk) => sum + chunk.newLines.length,
			0,
		);
		const deletions = hunk.chunks.reduce(
			(sum, chunk) => sum + chunk.oldLines.length,
			0,
		);
		planned.push({
			type: hunk.movePath ? 'move' : 'update',
			path,
			targetPath,
			oldContent,
			newContent,
			additions,
			deletions,
		});
	}
	return planned;
}

function diffDisplayRows(
	oldLines: string[],
	newLines: string[],
	oldStart: number,
	newStart: number,
): ApplyPatchDisplayRow[] {
	const n = oldLines.length;
	const m = newLines.length;
	const dp: number[][] = Array.from({length: n + 1}, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i]![j] =
				oldLines[i] === newLines[j]
					? 1 + dp[i + 1]![j + 1]!
					: Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}
	const rows: ApplyPatchDisplayRow[] = [];
	let i = 0;
	let j = 0;
	let oldLine = oldStart;
	let newLine = newStart;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			rows.push({kind: 'context', line: oldLine, text: oldLines[i]!});
			i++;
			j++;
			oldLine++;
			newLine++;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
			rows.push({kind: 'remove', line: oldLine++, text: oldLines[i++]!});
		} else {
			rows.push({kind: 'add', line: newLine++, text: newLines[j++]!});
		}
	}
	while (i < n) {
		rows.push({kind: 'remove', line: oldLine++, text: oldLines[i++]!});
	}
	while (j < m) {
		rows.push({kind: 'add', line: newLine++, text: newLines[j++]!});
	}
	return rows;
}

/** Build compact, pre-mutation rows used only by transcript DiffView. */
export function applyPatchDisplayChanges(
	cwd: string,
	patchText: string,
): ApplyPatchDisplayChange[] {
	const hunks = parseApplyPatch(patchText);
	const planned = planApplyPatch(cwd, patchText);
	return planned.map((change, index) => {
		const hunk = hunks[index]!;
		const path = relative(cwd, change.path).replaceAll('\\', '/');
		const targetPath = relative(cwd, change.targetPath).replaceAll('\\', '/');
		if (hunk.type === 'add') {
			const lines = hunk.content.replace(/\n$/, '').split('\n');
			return {
				type: change.type,
				path,
				rows: lines.map((text, line) => ({kind: 'add', line: line + 1, text})),
			};
		}
		if (hunk.type === 'delete') {
			const lines = change.oldContent.replace(/\n$/, '').split('\n');
			return {
				type: change.type,
				path,
				rows: lines.map((text, line) => ({
					kind: 'remove',
					line: line + 1,
					text,
				})),
			};
		}
		const sourceLines = change.oldContent.replace(/\n$/, '').split('\n');
		const rows: ApplyPatchDisplayRow[] = [];
		let cursor = 0;
		let lineDelta = 0;
		for (const chunk of hunk.chunks) {
			if (chunk.context) {
				const contextIndex = findSequence(sourceLines, [chunk.context], cursor);
				if (contextIndex >= 0) cursor = contextIndex + 1;
			}
			let oldLines = chunk.oldLines;
			let newLines = chunk.newLines;
			let start = findSequence(sourceLines, oldLines, cursor, chunk.endOfFile);
			if (start < 0 && oldLines.at(-1) === '') {
				oldLines = oldLines.slice(0, -1);
				if (newLines.at(-1) === '') newLines = newLines.slice(0, -1);
				start = findSequence(sourceLines, oldLines, cursor, chunk.endOfFile);
			}
			if (start < 0) start = cursor;
			rows.push(
				...diffDisplayRows(
					oldLines,
					newLines,
					start + 1,
					start + 1 + lineDelta,
				),
			);
			cursor = start + oldLines.length;
			lineDelta += newLines.length - oldLines.length;
		}
		return {
			type: change.type,
			path,
			...(targetPath !== path ? {targetPath} : {}),
			rows,
		};
	});
}

export function executeApplyPatch(cwd: string, patchText: string): string {
	const changes = planApplyPatch(cwd, patchText);
	const applied: PlannedPatchChange[] = [];
	try {
		for (const change of changes) {
			if (change.type === 'delete') {
				rmSync(change.path);
				applied.push(change);
				continue;
			}
			mkdirSync(dirname(change.targetPath), {recursive: true});
			writeFileSync(change.targetPath, change.newContent);
			if (change.type === 'move' && change.targetPath !== change.path) {
				rmSync(change.path);
			}
			applied.push(change);
		}
	} catch (error) {
		for (const change of applied.reverse()) {
			try {
				if (change.type === 'add') rmSync(change.targetPath, {force: true});
				else if (change.type === 'delete') {
					mkdirSync(dirname(change.path), {recursive: true});
					writeFileSync(change.path, change.oldContent);
				} else if (change.type === 'move') {
					rmSync(change.targetPath, {force: true});
					mkdirSync(dirname(change.path), {recursive: true});
					writeFileSync(change.path, change.oldContent);
				} else writeFileSync(change.path, change.oldContent);
			} catch {
				// Best-effort rollback; original error remains primary.
			}
		}
		throw new Error(
			`apply_patch failed and rolled back: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return [
		'Applied patch successfully.',
		...changes.map(change => {
			const marker =
				change.type === 'add'
					? 'A'
					: change.type === 'delete'
						? 'D'
						: change.type === 'move'
							? 'R'
							: 'M';
			const target = relative(cwd, change.targetPath).replaceAll('\\', '/');
			return `${marker} ${target} (+${change.additions} -${change.deletions})`;
		}),
	].join('\n');
}

export function applyPatchPaths(cwd: string, patchText: string): string[] {
	return parseApplyPatch(patchText).flatMap(hunk => [
		workspacePath(cwd, hunk.path),
		...(hunk.type === 'update' && hunk.movePath
			? [workspacePath(cwd, hunk.movePath)]
			: []),
	]);
}
