/**
 * MCP (Model Context Protocol), parity flavor of nanocoder's E8 config +
 * client. Servers come from `$NANOCODER_CONFIG_DIR/mcp.json` or the
 * `NANOCODER_MCPSERVERS` env (JSON, highest precedence). Each server speaks
 * JSON-RPC over stdio (initialize → tools/list → tools/call) and its tools
 * register into the shared registry with a live executor.
 */

import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export interface MCPServerConfig {
	id: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface MCPTool {
	serverId: string;
	name: string;
	description: string;
	call: (args: Record<string, unknown>) => Promise<string>;
}

export function loadMCPConfig(): MCPServerConfig[] {
	// Env servers win and are listed first.
	const envServers = process.env.NANOCODER_MCPSERVERS;
	const parsed: MCPServerConfig[] = [];
	if (envServers) {
		try {
			parsed.push(...(JSON.parse(envServers) as MCPServerConfig[]));
		} catch {
			// fall through to the file
		}
	}
	const base =
		process.env.NANOCODER_CONFIG_DIR ??
		join(homedir(), '.local', 'share', 'bobonyo');
	try {
		const file = join(base, 'mcp.json');
		if (existsSync(file)) {
			const fileConfig = JSON.parse(readFileSync(file, 'utf8')) as {
				servers?: MCPServerConfig[];
			};
			const ids = new Set(parsed.map(server => server.id.toLowerCase()));
			for (const server of fileConfig.servers ?? []) {
				if (!ids.has(server.id.toLowerCase())) parsed.push(server);
			}
		}
	} catch {
		// corrupt config, env-only
	}
	return parsed;
}

/** Spawn a stdio MCP server and handshake it; returns discovered tools. */
export async function connectMCPServer(
	server: MCPServerConfig,
): Promise<MCPTool[]> {
	const proc = Bun.spawn([server.command, ...(server.args ?? [])], {
		env: {...process.env, ...(server.env ?? {})} as Record<string, string>,
		stdout: 'pipe',
		stderr: 'ignore',
		stdin: 'pipe',
	});
	const client = new JsonRpcClient(proc);
	try {
		await client.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: {name: 'bobonyo', version: '0.1.0'},
		});
		const listed = (await client.request('tools/list', {})) as {
			tools?: Array<{name?: string; description?: string}>;
		};
		return (listed.tools ?? []).map(tool => ({
			serverId: server.id,
			name: tool.name ?? 'unknown',
			description: tool.description ?? '',
			call: async args => {
				const result = (await client.request('tools/call', {
					name: tool.name,
					arguments: args,
				})) as {content?: Array<{type?: string; text?: string}>};
				return (result.content ?? [])
					.map(block => block.text ?? '')
					.filter(Boolean)
					.join('\n');
			},
		}));
	} catch (error) {
		proc.kill();
		throw error;
	}
}

class JsonRpcClient {
	private seq = 0;
	private pending = new Map<number, (value: unknown) => void>();
	private proc: import('bun').Subprocess;

	constructor(proc: import('bun').Subprocess) {
		this.proc = proc;
		void this.readLoop();
	}

	private async readLoop(): Promise<void> {
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, {stream: true});
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const message = JSON.parse(line) as {
						id?: number;
						result?: unknown;
						error?: {message?: string};
					};
					if (message.id !== undefined) {
						const resolve = this.pending.get(message.id);
						if (resolve) {
							this.pending.delete(message.id);
							resolve(
								message.error
									? new Error(message.error.message ?? 'mcp error')
									: message.result,
							);
						}
					}
				} catch {
					// non-JSON line, ignore
				}
			}
		}
	}

	request(method: string, params: unknown): Promise<unknown> {
		const id = ++this.seq;
		// biome-ignore lint/suspicious/noExplicitAny: Bun types stdin as number|FileSink
		(this.proc.stdin as any)?.write(
			`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`,
		);
		return new Promise((resolve, reject) => {
			this.pending.set(id, value => {
				if (value instanceof Error) reject(value);
				else resolve(value);
			});
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`mcp request timed out: ${method}`));
				}
			}, 5000);
		});
	}
}
