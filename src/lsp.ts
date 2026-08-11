/**
 * Lightweight language-server DISCOVERY (parity: nanocoder's
 * lsp/server-discovery): detects installed language servers on the system by
 * checking their binaries, so `/status` can report which LSPs are available
 * (bobonyo runs diagnostics through its own tool; this makes the configured
 * LSP surface visible).
 */

const LANGUAGE_SERVERS: Array<{name: string; binary: string}> = [
	{name: 'typescript-language-server', binary: 'typescript-language-server'},
	{name: 'deno', binary: 'deno'},
	{name: 'pyright', binary: 'pyright-langserver'},
	{name: 'pylsp', binary: 'pylsp'},
	{name: 'rust-analyzer', binary: 'rust-analyzer'},
	{name: 'gopls', binary: 'gopls'},
	{name: 'clangd', binary: 'clangd'},
	{name: 'vscode-langservers-extracted', binary: 'vscode-langservers-extracted'},
	{name: 'eslint', binary: 'eslint'},
	{name: 'biome', binary: 'biome'},
];

let cache: string[] | null = null;

/** Detect installed language servers (cached per process; best-effort). */
export function detectLanguageServers(): string[] {
	if (cache) return cache;
	const found: string[] = [];
	for (const server of LANGUAGE_SERVERS) {
		try {
			if (Bun.which(server.binary)) found.push(server.name);
		} catch {
			// keep scanning the rest
		}
	}
	cache = found;
	return found;
}
