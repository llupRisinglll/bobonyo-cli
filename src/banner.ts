/**
 * Welcome-banner text builder (pure, no Solid/OpenTUI imports so it can be
 * unit-tested). Returns the boxed lines WITHOUT the ```banner fence or the
 * trailing tip.
 */
export function buildBannerBox(options: {
	titleShape: string;
	model: string;
	permissions: string;
	cwd: string;
}): string {
	const {titleShape, model, permissions, cwd} = options;
	// The mascot is FIXED (parity: the tiny face art), the Shape setting is
	// gone and the banner no longer changes with the theme.
	const mascot = '╭◕‿◕╮';
	// Tiny keeps the face bottom (`╰───╯`) on the directory row; other
	// shapes just pad to the mascot width so keys stay aligned.
	const mascotBase = '╰───╯';
	// All KEYS (`bobonyo`, `model:`, `directory:`, `permissions:`) start on
	// the same column: mascot width + 2.
	const labelCol = mascot.length + 2;
	const contentLines = [
		`★${' '.repeat(labelCol - 1)}bobonyo (v0.1.0)`,
		`${mascot}  model:       ${model}  /model to change`,
		`${mascotBase}  directory:   ${cwd}`,
		`${' '.repeat(labelCol)}permissions: ${permissions}`,
	];
	// FIT CONTENT: the box is sized to the longest line (+ padding), not the
	// full terminal width. `+4` = the `│ ` prefix + minimum 1 space padding +
	// the `│` suffix, a `len + 2` budget made the longest line overflow the
	// border by 2 columns.
	const inner = Math.max(28, ...contentLines.map(line => line.length + 4));
	const dash = '─'.repeat(inner - 2);
	const pad = (text: string): string =>
		`│ ${text}${' '.repeat(Math.max(1, inner - 3 - text.length))}│`;
	const boxed = titleShape !== 'none';
	const line = (text: string): string => (boxed ? pad(text) : `  ${text}`);
	return (
		(boxed ? `╭${dash}╮\n` : '') +
		line(contentLines[0] ?? '') +
		'\n' +
		line(contentLines[1] ?? '') +
		'\n' +
		line(contentLines[2] ?? '') +
		'\n' +
		line(contentLines[3] ?? '') +
		'\n' +
		(boxed ? `╰${dash}╯\n` : '')
	);
}
