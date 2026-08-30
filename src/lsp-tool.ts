import {existsSync} from 'node:fs';
import {extname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {detectLanguageServers} from './lsp';
import {lspServerForPath, StdioLspClient} from './lsp-client';

export type LspOperation =
	'servers' | 'diagnostics' | 'symbols' | 'references' | 'definition' | 'hover';

interface Position {
	line: number;
	character: number;
}
interface Location {
	uri: string;
	range: {start: Position; end: Position};
}

function run(cwd: string, command: string[]): string {
	const result = Bun.spawnSync(command, {cwd});
	const stdout = result.stdout?.toString().trim() ?? '';
	const stderr = result.stderr?.toString().trim() ?? '';
	return `EXIT_CODE: ${result.exitCode}\n${[stdout, stderr].filter(Boolean).join('\n')}`.trim();
}

function projectDiagnosticCommand(cwd: string): string[] | null {
	if (existsSync(resolve(cwd, 'tsconfig.json'))) {
		if (Bun.which('bun'))
			return ['bun', 'x', 'tsc', '--noEmit', '--pretty', 'false'];
		if (Bun.which('npx'))
			return ['npx', 'tsc', '--noEmit', '--pretty', 'false'];
	}
	if (existsSync(resolve(cwd, 'Cargo.toml')) && Bun.which('cargo')) {
		return ['cargo', 'check', '--message-format=short'];
	}
	if (existsSync(resolve(cwd, 'go.mod')) && Bun.which('go')) {
		return ['go', 'test', './...'];
	}
	if (existsSync(resolve(cwd, 'pyproject.toml'))) {
		if (Bun.which('pyright')) return ['pyright', '--outputjson'];
		if (Bun.which('ruff')) return ['ruff', 'check', '.'];
	}
	return null;
}

function search(cwd: string, query: string, path?: string): string {
	if (!query.trim()) return 'Error: query is required.';
	const target = path?.trim() || '.';
	const result = Bun.spawnSync(
		[
			'rg',
			'--with-filename',
			'--line-number',
			'--column',
			'--no-heading',
			'--color',
			'never',
			'--',
			query,
			target,
		],
		{cwd},
	);
	const output = result.stdout?.toString().trim() ?? '';
	if (result.exitCode === 1) return `No matches for ${query}.`;
	if (result.exitCode !== 0) {
		return `Error: ${result.stderr?.toString().trim() || 'code search failed'}`;
	}
	const lines = output.split('\n');
	const visible = lines.slice(0, 200);
	return `${visible.join('\n')}${lines.length > visible.length ? `\n… +${lines.length - visible.length} more matches` : ''}`;
}

function symbolPattern(query: string, path?: string): string {
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const ext = extname(path || '').toLowerCase();
	if (ext === '.py') return `^(?:async\\s+)?(?:def|class)\\s+${escaped}\\b`;
	if (ext === '.rs')
		return `^(?:pub(?:\\([^)]*\\))?\\s+)?(?:fn|struct|enum|trait|type|const|static)\\s+${escaped}\\b`;
	if (ext === '.go')
		return `^(?:func|type|var|const)\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\b`;
	return `^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var)\\s+${escaped}\\b`;
}

function formatLocation(location: Location): string {
	const path = location.uri.startsWith('file:')
		? fileURLToPath(location.uri)
		: location.uri;
	return `${path}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
}

function normalizeLocations(value: unknown): Location[] {
	if (!value) return [];
	const values = Array.isArray(value) ? value : [value];
	return values.flatMap(item => {
		if (!item || typeof item !== 'object') return [];
		const row = item as Record<string, unknown>;
		if (typeof row.uri === 'string' && row.range)
			return [row as unknown as Location];
		const target = row.targetUri;
		const range = row.targetSelectionRange ?? row.targetRange;
		return typeof target === 'string' && range
			? [{uri: target, range} as Location]
			: [];
	});
}

function hoverText(value: unknown): string {
	if (!value || typeof value !== 'object') return '';
	const contents = (value as {contents?: unknown}).contents;
	if (typeof contents === 'string') return contents;
	if (Array.isArray(contents)) {
		return contents
			.map(item =>
				typeof item === 'string'
					? item
					: item && typeof item === 'object' && 'value' in item
						? String((item as {value: unknown}).value)
						: '',
			)
			.filter(Boolean)
			.join('\n');
	}
	if (contents && typeof contents === 'object' && 'value' in contents) {
		return String((contents as {value: unknown}).value);
	}
	return '';
}

function symbolRows(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const rows: string[] = [];
	const walk = (items: unknown[], parent = '') => {
		for (const item of items) {
			if (!item || typeof item !== 'object') continue;
			const symbol = item as Record<string, unknown>;
			const name = typeof symbol.name === 'string' ? symbol.name : '';
			const location = symbol.location as Location | undefined;
			const range = symbol.selectionRange ?? symbol.range;
			const locationText = location
				? formatLocation(location)
				: range && typeof range === 'object'
					? `${Number((range as {start?: Position}).start?.line ?? 0) + 1}:${Number((range as {start?: Position}).start?.character ?? 0) + 1}`
					: '';
			if (name)
				rows.push(
					`${parent}${name}${locationText ? ` · ${locationText}` : ''}`,
				);
			if (Array.isArray(symbol.children)) walk(symbol.children, `${parent}  `);
		}
	};
	walk(value);
	return rows;
}

function diagnosticRows(value: unknown, fallbackPath: string): string[] {
	if (!value || typeof value !== 'object') return [];
	const row = value as {uri?: string; diagnostics?: unknown[]};
	const path = row.uri?.startsWith('file:')
		? fileURLToPath(row.uri)
		: row.uri || fallbackPath;
	return (row.diagnostics ?? []).flatMap(item => {
		if (!item || typeof item !== 'object') return [];
		const diagnostic = item as {
			message?: string;
			severity?: number;
			range?: {start?: Position};
			source?: string;
			code?: string | number;
		};
		const line = Number(diagnostic.range?.start?.line ?? 0) + 1;
		const character = Number(diagnostic.range?.start?.character ?? 0) + 1;
		const severity =
			['unknown', 'error', 'warning', 'info', 'hint'][
				diagnostic.severity ?? 0
			] ?? 'diagnostic';
		const source = [diagnostic.source, diagnostic.code]
			.filter(value => value !== undefined)
			.join(':');
		return [
			`${path}:${line}:${character} · ${severity}${source ? ` · ${source}` : ''} · ${diagnostic.message || ''}`,
		];
	});
}

async function protocolOperation(
	cwd: string,
	args: {
		operation: LspOperation;
		path?: string;
		query?: string;
		line?: number;
		character?: number;
	},
): Promise<string | null> {
	const serverPath = args.path || '';
	const server = serverPath ? lspServerForPath(serverPath) : null;
	if (!server) return null;
	const client = new StdioLspClient(cwd, server.command);
	try {
		await client.initialize();
		let diagnosticPromise: Promise<unknown> | undefined;
		if (args.operation === 'diagnostics') {
			diagnosticPromise = new Promise<unknown>(resolve => {
				const stop = client.on('textDocument/publishDiagnostics', value => {
					stop();
					resolve(value);
				});
				setTimeout(() => {
					stop();
					resolve(null);
				}, 1500);
			});
		}
		const opened = await client.openFile(serverPath);
		const position = {
			line: Math.max(0, Math.floor(args.line ?? 1) - 1),
			character: Math.max(0, Math.floor(args.character ?? 1) - 1),
		};
		if (args.operation === 'definition') {
			const result = await client.request('textDocument/definition', {
				textDocument: {uri: opened.uri},
				position,
			});
			const locations = normalizeLocations(result);
			return locations.length
				? `LSP ${server.name} definitions:\n${locations.map(formatLocation).join('\n')}`
				: `LSP ${server.name}: no definition found.`;
		}
		if (args.operation === 'references') {
			const result = await client.request('textDocument/references', {
				textDocument: {uri: opened.uri},
				position,
				context: {includeDeclaration: true},
			});
			const locations = normalizeLocations(result);
			return locations.length
				? `LSP ${server.name} references:\n${locations.map(formatLocation).join('\n')}`
				: `LSP ${server.name}: no references found.`;
		}
		if (args.operation === 'hover') {
			const result = await client.request('textDocument/hover', {
				textDocument: {uri: opened.uri},
				position,
			});
			const text = hoverText(result);
			return text
				? `LSP ${server.name} hover:\n${text}`
				: `LSP ${server.name}: no hover information.`;
		}
		if (args.operation === 'symbols') {
			const result = await client.request('textDocument/documentSymbol', {
				textDocument: {uri: opened.uri},
			});
			const rows = symbolRows(result);
			return rows.length
				? `LSP ${server.name} symbols:\n${rows.slice(0, 300).join('\n')}`
				: `LSP ${server.name}: no symbols found.`;
		}
		if (args.operation === 'diagnostics') {
			const diagnostics = await diagnosticPromise;
			const rows = diagnosticRows(diagnostics, resolve(cwd, serverPath));
			return rows.length
				? `LSP ${server.name} diagnostics:\n${rows.slice(0, 300).join('\n')}`
				: `LSP ${server.name}: no diagnostics published.`;
		}
		return null;
	} finally {
		await client.close();
	}
}

export async function executeLspOperation(
	cwd: string,
	args: {
		operation?: string;
		query?: string;
		path?: string;
		line?: number;
		character?: number;
	},
): Promise<string> {
	const operation = (args.operation || 'servers') as LspOperation;
	if (['definition', 'hover'].includes(operation) && !args.path) {
		return `Error: ${operation} requires path, line, and character.`;
	}
	if (
		args.path &&
		['definition', 'hover', 'references', 'symbols', 'diagnostics'].includes(
			operation,
		)
	) {
		try {
			const protocol = await protocolOperation(cwd, {
				operation,
				path: args.path,
				query: args.query,
				line: args.line,
				character: args.character,
			});
			if (protocol) return protocol;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (operation !== 'references')
				return `Error: LSP request failed: ${reason}`;
		}
	}
	switch (operation) {
		case 'servers': {
			const servers = detectLanguageServers();
			return servers.length
				? `Detected language servers:\n${servers.map(name => `- ${name}`).join('\n')}`
				: 'No language servers detected.';
		}
		case 'diagnostics': {
			const command = projectDiagnosticCommand(cwd);
			return command
				? run(cwd, command)
				: 'No supported project diagnostics command detected.';
		}
		case 'symbols':
			return search(cwd, symbolPattern(args.query || '', args.path), args.path);
		case 'references':
			return search(
				cwd,
				`\\b${(args.query || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
				args.path,
			);
		case 'definition':
		case 'hover':
			return `Error: no compatible language server is installed for ${args.path}.`;
		default:
			return `Error: unsupported lsp operation ${operation}.`;
	}
}
