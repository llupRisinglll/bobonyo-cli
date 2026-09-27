import {lineDiff, type RowStatus} from './row-highlight';
import type {ApplyPatchDisplayChange} from './apply-patch';
import {fence, formatOutputTail} from './tool-display-output';
import type {ToolDisplayData} from './tool-display-types';
import {languageForFile, stripResultPrefix} from './tool-display-file-helpers';

export {languageForFile, stripResultPrefix} from './tool-display-file-helpers';

function textArg(
	args: Record<string, unknown> | undefined,
	key: string,
): string {
	const value = args?.[key];
	return typeof value === 'string' ? value : '';
}

function applyPatchDisplayArg(
	args: Record<string, unknown> | undefined,
): ApplyPatchDisplayChange[] {
	const value = args?._applyPatchDisplay;
	if (!Array.isArray(value)) return [];
	return value.filter(
		(change): change is ApplyPatchDisplayChange =>
			Boolean(change) &&
			typeof change === 'object' &&
			typeof (change as ApplyPatchDisplayChange).path === 'string' &&
			Array.isArray((change as ApplyPatchDisplayChange).rows),
	);
}

export function formatFilePreview(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
	width: number,
): string {
	const path = textArg(tool.args, 'path') || tool.detail;
	const displayName = tool.name === 'write_file' ? 'Write' : 'Edit';
	if (tool.name === 'diff_edit') {
		return formatUnifiedPatchPreview(tool, expanded, status);
	}
	if (tool.name === 'apply_patch') {
		return formatApplyPatchPreview(tool, expanded, status);
	}
	if (tool.name === 'write_file') {
		if (!/^Wrote /.test(tool.output)) {
			const tail = formatOutputTail(tool.output, expanded, width);
			return tail
				? `${displayName} ${path}\n${tail}`
				: `${displayName} ${path}`;
		}
		const body =
			textArg(tool.args, 'content') || stripResultPrefix(tool.output);
		const lines = body.replace(/\n+$/, '').split('\n');
		const visible = expanded ? lines : lines.slice(0, 50);
		const hidden = lines.length - visible.length;
		const numbered = visible
			.map((line, index) => `${String(index + 1).padStart(4, ' ')} ${line}`)
			.join('\n');
		const footer = hidden > 0 ? `\n  … +${hidden} more lines` : '';
		const header = `✦ ${displayName} ${path}`;
		const summary = ` ⎿ ${displayName}: ${lines.length} line${lines.length === 1 ? '' : 's'}`;
		const headerFence = fence('filerow', status, `${header}\n${summary}`);
		const lang = languageForFile(path);
		const codeFence = lang
			? `${'```'}${lang}\n${numbered}\n${'```'}`
			: numbered;
		return `${headerFence}\n${codeFence}${footer}`;
	}
	if (
		!/^Replaced /.test(tool.output) &&
		!/^Successfully replaced content at line/.test(tool.output)
	) {
		const tail = formatOutputTail(tool.output, expanded, width);
		const header = `✦ ${displayName} ${path}`;
		return tail ? `${header}\n${tail}` : header;
	}
	const oldStr =
		textArg(tool.args, 'old_string') || textArg(tool.args, 'old_str') || '';
	const newStr =
		textArg(tool.args, 'new_string') ||
		textArg(tool.args, 'new_str') ||
		stripResultPrefix(tool.output);
	const oldLines = oldStr.replace(/\n+$/, '').split('\n');
	const newLines = newStr.replace(/\n+$/, '').split('\n');
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] ===
			newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}
	const diffOld = oldLines.slice(prefix, oldLines.length - suffix);
	const diffNew = newLines.slice(prefix, newLines.length - suffix);
	let diffOldFinal = diffOld;
	let diffNewFinal = diffNew;
	let stripPrefix = prefix;
	if (diffOld.length === 0 || diffNew.length === 0) {
		diffOldFinal = oldLines;
		diffNewFinal = newLines;
		stripPrefix = 0;
	}
	const summary = ` ⎿ ${diffOldFinal.length} line${diffOldFinal.length === 1 ? '' : 's'} → ${diffNewFinal.length} line${diffNewFinal.length === 1 ? '' : 's'}`;
	const diff = lineDiffText(
		diffOldFinal.join('\n'),
		diffNewFinal.join('\n'),
		replacementBaseLine(tool.output) + stripPrefix,
	);
	const diffLines = diff.split('\n');
	const visibleDiff = expanded ? diffLines : diffLines.slice(0, 50);
	const hiddenDiff = diffLines.length - visibleDiff.length;
	const diffBody = visibleDiff.join('\n');
	const diffFooter = hiddenDiff > 0 ? `\n  … +${hiddenDiff} more lines` : '';
	const header = `✦ ${displayName} ${path}`;
	return fence(
		'filediff',
		status,
		`${header}\n${summary}${diffBody ? `\n${diffBody}` : ''}${diffFooter}`,
	);
}

function formatApplyPatchPreview(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
): string {
	const patch = textArg(tool.args, 'patchText').replace(/\r/g, '');
	if (!patch || !/^Applied patch successfully\./.test(tool.output)) {
		const tail = formatOutputTail(tool.output, expanded, 84);
		return tail ? `✦ Edit files (failed)\n${tail}` : '✦ Edit files (failed)';
	}
	const changes = applyPatchDisplayArg(tool.args);
	if (changes.length === 0) {
		const tail = formatOutputTail(tool.output, expanded, 84);
		return tail ? `✦ Edit files (failed)\n${tail}` : '✦ Edit files (failed)';
	}
	const body = changes.flatMap((change, changeIndex) => {
		const action =
			change.type === 'add'
				? 'Create'
				: change.type === 'delete'
					? 'Delete'
					: change.type === 'move'
						? 'Move'
						: 'Edit';
		const additions = change.rows.filter(row => row.kind === 'add').length;
		const deletions = change.rows.filter(row => row.kind === 'remove').length;
		const prefix = tool.briefed
			? `${changeIndex === 0 ? '✦ ' : ''}  └ `
			: changeIndex === 0
				? '✦ '
				: '└ ';
		const label =
			`${prefix}${action} ${change.path}` +
			`${change.targetPath ? ` → ${change.targetPath}` : ''}` +
			` (+${additions} -${deletions})`;
		const lineWidth = Math.max(
			1,
			...change.rows.map(row => String(row.line).length),
		);
		return [
			label,
			...change.rows.map(row => {
				const sigil =
					change.type === 'add'
						? ' '
						: row.kind === 'add'
							? '+'
							: row.kind === 'remove'
								? '-'
								: ' ';
				return `    ${String(row.line).padStart(lineWidth, ' ')} ${sigil} ${row.text}`;
			}),
		];
	});
	const visible = expanded ? body : body.slice(0, 50);
	const hidden = body.length - visible.length;
	const footer = hidden > 0 ? `\n  … +${hidden} more lines` : '';
	return fence('filediff', status, `${visible.join('\n')}${footer}`);
}

function formatUnifiedPatchPreview(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
): string {
	const patch = textArg(tool.args, 'diff').replace(/\r/g, '');
	const fallbackPath = textArg(tool.args, 'path') || tool.detail || 'patch';
	if (!patch || !/^EXIT_CODE:\s*0\b/.test(tool.output)) {
		const tail = formatOutputTail(tool.output, expanded, 84);
		const header = `✦ Edit ${fallbackPath}`;
		return tail ? `${header}\n${tail}` : header;
	}

	const lines = patch.split('\n');
	const body: string[] = [];
	let path = fallbackPath;
	let oldLine = 1;
	let newLine = 1;
	let added = 0;
	let removed = 0;
	let files = 0;
	for (const line of lines) {
		if (line.startsWith('+++ ')) {
			const raw = line.slice(4).trim().split(/\s+/)[0] ?? '';
			if (raw && raw !== '/dev/null') {
				const clean = raw.replace(/^[ab]\//, '');
				if (files === 0) path = clean;
				files += 1;
			}
			continue;
		}
		if (
			line.startsWith('--- ') ||
			line.startsWith('diff --git ') ||
			line.startsWith('index ')
		) {
			continue;
		}
		const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			continue;
		}
		if (line.startsWith('\\ No newline at end of file')) continue;
		if (line.startsWith('+')) {
			body.push(`  ${String(newLine++).padStart(4, ' ')} + ${line.slice(1)}`);
			added += 1;
			continue;
		}
		if (line.startsWith('-')) {
			body.push(`  ${String(oldLine++).padStart(4, ' ')} - ${line.slice(1)}`);
			removed += 1;
			continue;
		}
		if (line.startsWith(' ')) {
			body.push(`  ${String(oldLine++).padStart(4, ' ')}   ${line.slice(1)}`);
			newLine += 1;
		}
	}
	if (body.length === 0) {
		const tail = formatOutputTail(tool.output, expanded, 84);
		return tail ? `✦ Edit ${path}\n${tail}` : `✦ Edit ${path}`;
	}
	const visible = expanded ? body : body.slice(0, 50);
	const hidden = body.length - visible.length;
	const summary =
		` ⎿ ${removed} removed · ${added} added` +
		(files > 1 ? ` · ${files} files` : '');
	const footer = hidden > 0 ? `\n  … +${hidden} more lines` : '';
	return fence(
		'filediff',
		status,
		`✦ Edit ${path}\n${summary}\n${visible.join('\n')}${footer}`,
	);
}

export function replacementBaseLine(output: string): number {
	const match = /^Replaced \d+ occurrences? in .*? \(at line (\d+)\)/.exec(
		output,
	);
	const line = match ? Number(match[1]) : NaN;
	return Number.isFinite(line) && line > 0 ? line : 1;
}

function lineDiffText(oldStr: string, newStr: string, baseLine = 1): string {
	const diff = lineDiff(oldStr, newStr);
	const offset = Math.max(0, baseLine - 1);
	const lead = '  ';
	return diff
		.map(line => {
			const text = line.text;
			if (line.kind === 'add') {
				return `${lead}${String((line.newLineNo ?? 1) + offset).padStart(4, ' ')} + ${text}`;
			}
			if (line.kind === 'remove') {
				return `${lead}${String((line.oldLineNo ?? 1) + offset).padStart(4, ' ')} - ${text}`;
			}
			return `${lead}${String((line.oldLineNo ?? 1) + offset).padStart(4, ' ')}   ${text}`;
		})
		.join('\n');
}
