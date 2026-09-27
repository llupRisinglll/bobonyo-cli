export function languageForFile(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'typescript';
	if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript';
	if (['md', 'mdx'].includes(ext)) return 'markdown';
	return '';
}

export function stripResultPrefix(output: string): string {
	const match = /^(?:Wrote|Edited|Replaced|Deleted)[^\n]*\n?([\s\S]*)$/.exec(
		output,
	);
	return match?.[1]?.replace(/^\n/, '') ?? output;
}
