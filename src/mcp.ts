/**
 * MCP (Model Context Protocol), parity flavor of nanocoder's E8 config +
 * client. Servers come from `$BOBONYO_CONFIG_DIR/mcp.json` or the
 * `BOBONYO_MCPSERVERS` env (JSON, highest precedence). Each server speaks
 * JSON-RPC over stdio (initialize → tools/list → tools/call) and its tools
 * register into the shared registry with a live executor.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
} from 'node:path';
import {bobonyoConfigDir} from './bobonyo-paths';

export interface MCPServerConfig {
	id: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	/** Explicit tools safe to run without approval. Default: none. */
	readOnlyTools?: string[];
	requestTimeoutMs?: number;
}

export interface MCPTool {
	serverId: string;
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	readOnly: boolean;
	call: (args: Record<string, unknown>) => Promise<string>;
}
const activeClients = new Set<JsonRpcClient>();
const resourceClients = new Map<string, JsonRpcClient>();
const connectedServers = new Map<string, Promise<MCPTool[]>>();
const MCP_TOOL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedMCPTools {
	at: number;
	tools: Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		readOnly: boolean;
	}>;
}

function serverKey(server: MCPServerConfig): string {
	return String(
		Bun.hash(
			JSON.stringify({
				id: server.id,
				command: server.command,
				args: server.args ?? [],
				env: server.env ?? {},
				readOnlyTools: server.readOnlyTools ?? [],
			}),
		),
	);
}

function toolCachePath(): string {
	const base =
		process.env.BOBONYO_CONFIG_DIR ??
		process.env.NANOCODER_CONFIG_DIR ??
		bobonyoConfigDir();
	return join(base, 'mcp-tools-cache.json');
}

function readToolCache(): Record<string, CachedMCPTools> {
	try {
		return JSON.parse(readFileSync(toolCachePath(), 'utf8')) as Record<
			string,
			CachedMCPTools
		>;
	} catch {
		return {};
	}
}

function saveCachedTools(server: MCPServerConfig, tools: MCPTool[]): void {
	const path = toolCachePath();
	const next = {
		...readToolCache(),
		[serverKey(server)]: {
			at: Date.now(),
			tools: tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				readOnly: tool.readOnly,
			})),
		},
	};
	mkdirSync(dirname(path), {recursive: true});
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(temp, path);
}

export function isIsolatedPlaywrightServer(server: MCPServerConfig): boolean {
	const command = [server.command, ...(server.args ?? [])]
		.join(' ')
		.toLowerCase();
	return command.includes('playwright') && command.includes('--isolated');
}

async function connectedTools(server: MCPServerConfig): Promise<MCPTool[]> {
	const key = serverKey(server);
	const existing = connectedServers.get(key);
	if (existing) return existing;
	const connecting = connectMCPServer(server).catch(error => {
		connectedServers.delete(key);
		throw error;
	});
	connectedServers.set(key, connecting);
	return connecting;
}

/**
 * Isolated Playwright remains process-owned, but a warm manifest registers
 * proxy tools without spawning its server. First browser call starts this
 * Bobonyo process's own isolated Playwright instance.
 */
export async function loadMCPServerTools(
	server: MCPServerConfig,
): Promise<MCPTool[]> {
	if (isIsolatedPlaywrightServer(server)) {
		const cached = readToolCache()[serverKey(server)];
		if (cached && Date.now() - cached.at < MCP_TOOL_CACHE_TTL_MS) {
			return cached.tools.map(tool => ({
				serverId: server.id,
				...tool,
				call: async args => {
					const tools = await connectedTools(server);
					const live = tools.find(candidate => candidate.name === tool.name);
					if (!live) {
						throw new Error(
							`MCP tool disappeared after reconnect: ${tool.name}`,
						);
					}
					return live.call(args);
				},
			}));
		}
	}
	const tools = await connectedTools(server);
	if (isIsolatedPlaywrightServer(server)) saveCachedTools(server, tools);
	return tools;
}

/** Stop connected MCP subprocesses when the application exits. */
export async function closeMCPServers(): Promise<void> {
	const clients = [...activeClients];
	activeClients.clear();
	connectedServers.clear();
	resourceClients.clear();
	await Promise.all(clients.map(client => client.close()));
}

async function resourceClient(serverId: string): Promise<JsonRpcClient> {
	const server = loadMCPConfig().find(candidate => candidate.id === serverId);
	if (!server) throw new Error(`MCP server not found: ${serverId}`);
	await connectedTools(server);
	const client = resourceClients.get(serverId);
	if (!client) throw new Error(`MCP server is not connected: ${serverId}`);
	return client;
}

export async function listMCPResources(serverId?: string): Promise<string> {
	const servers = serverId
		? loadMCPConfig().filter(server => server.id === serverId)
		: loadMCPConfig();
	const rows: string[] = [];
	for (const server of servers) {
		try {
			const client = await resourceClient(server.id);
			const result = (await client.request('resources/list', {})) as {
				resources?: Array<{
					uri?: string;
					name?: string;
					description?: string;
					mimeType?: string;
				}>;
			};
			for (const resource of result.resources ?? []) {
				rows.push(
					`${server.id} · ${resource.uri ?? ''} · ${resource.name ?? ''}${resource.mimeType ? ` · ${resource.mimeType}` : ''}${resource.description ? `\n  ${resource.description}` : ''}`,
				);
			}
		} catch (error) {
			if (serverId) throw error;
		}
	}
	return rows.length > 0 ? rows.join('\n') : 'No MCP resources.';
}

export async function listMCPResourceTemplates(
	serverId?: string,
): Promise<string> {
	const servers = serverId
		? loadMCPConfig().filter(server => server.id === serverId)
		: loadMCPConfig();
	const rows: string[] = [];
	for (const server of servers) {
		try {
			const client = await resourceClient(server.id);
			const result = (await client.request('resources/templates/list', {})) as {
				resourceTemplates?: Array<{
					uriTemplate?: string;
					name?: string;
					description?: string;
				}>;
			};
			for (const resource of result.resourceTemplates ?? []) {
				rows.push(
					`${server.id} · ${resource.uriTemplate ?? ''} · ${resource.name ?? ''}${resource.description ? `\n  ${resource.description}` : ''}`,
				);
			}
		} catch (error) {
			if (serverId) throw error;
		}
	}
	return rows.length > 0 ? rows.join('\n') : 'No MCP resource templates.';
}

export function formatMCPResourceContents(
	contents: Array<{
		uri?: string;
		text?: string;
		blob?: string;
		mimeType?: string;
	}>,
): string {
	return contents
		.map(content => {
			const body =
				content.text ??
				(content.blob ? `[base64 blob: ${content.blob.length} chars]` : '');
			return `${content.uri ?? ''}${content.mimeType ? ` · ${content.mimeType}` : ''}\n${body}`.trim();
		})
		.filter(Boolean)
		.join('\n\n');
}

export async function readMCPResource(
	serverId: string,
	uri: string,
): Promise<string> {
	const client = await resourceClient(serverId);
	const result = (await client.request('resources/read', {uri})) as {
		contents?: Array<{
			uri?: string;
			text?: string;
			blob?: string;
			mimeType?: string;
		}>;
	};
	return (
		formatMCPResourceContents(result.contents ?? []) || 'Empty MCP resource.'
	);
}

function configuredOutputDir(server: MCPServerConfig): string | undefined {
	const args = server.args ?? [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === '--output-dir') return args[index + 1];
		if (arg.startsWith('--output-dir='))
			return arg.slice('--output-dir='.length);
	}
	return server.env?.PLAYWRIGHT_MCP_OUTPUT_DIR;
}

/**
 * Playwright MCP treats an explicit screenshot filename as workspace-relative,
 * bypassing its configured output directory. Constrain named screenshots to
 * that directory so `filename: "foo.png"` cannot litter the project root.
 */
export function confineMCPOutputFilename(
	server: MCPServerConfig,
	toolName: string,
	args: Record<string, unknown>,
	cwd = process.cwd(),
): Record<string, unknown> {
	if (toolName !== 'browser_take_screenshot') return args;
	const filename = args.filename;
	if (typeof filename !== 'string' || !filename.trim()) return args;
	const outputDir = configuredOutputDir(server);
	if (!outputDir) return args;
	const absoluteOutput = resolve(cwd, outputDir);
	const absoluteFilename = resolve(cwd, filename);
	const fromOutput = relative(absoluteOutput, absoluteFilename);
	if (
		fromOutput === '' ||
		(!fromOutput.startsWith('..') && !isAbsolute(fromOutput))
	) {
		return args;
	}
	const confined = resolve(absoluteOutput, basename(normalize(filename)));
	return {
		...args,
		filename: isAbsolute(outputDir) ? confined : relative(cwd, confined),
	};
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
		process.env.BOBONYO_CONFIG_DIR ??
		process.env.NANOCODER_CONFIG_DIR ??
		bobonyoConfigDir();
	// The original nanocoder stores MCP servers in `.mcp.json` as
	// `{ "mcpServers": { "<name>": { command, args, env } } }` — read that
	// FIRST so a nanocoder-configured MCP setup is detected.
	try {
		const dotFile = join(base, '.mcp.json');
		if (existsSync(dotFile)) {
			const dot = JSON.parse(readFileSync(dotFile, 'utf8')) as {
				mcpServers?: Record<
					string,
					{
						command?: string;
						args?: string[];
						env?: Record<string, string>;
						readOnlyTools?: string[];
						requestTimeoutMs?: number;
					}
				>;
			};
			for (const [name, server] of Object.entries(dot.mcpServers ?? {})) {
				if (!server?.command) continue;
				const key = name.toLowerCase();
				if (!parsed.some(existing => existing.id.toLowerCase() === key)) {
					parsed.push({
						id: name,
						command: server.command,
						args: server.args ?? [],
						env: server.env,
						readOnlyTools: server.readOnlyTools,
						requestTimeoutMs: server.requestTimeoutMs,
					});
				}
			}
		}
	} catch {
		// corrupt .mcp.json — fall through
	}
	try {
		const file = join(base, 'mcp.json');
		if (existsSync(file)) {
			const fileConfig = JSON.parse(readFileSync(file, 'utf8')) as {
				servers?: MCPServerConfig[];
			};
			const ids = new Set(parsed.map(server => server.id.toLowerCase()));
			for (const server of fileConfig.servers ?? []) {
				if (!ids.has(server.id.toLowerCase())) {
					parsed.push(server);
					ids.add(server.id.toLowerCase());
				}
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
	const client = new JsonRpcClient(proc, server.requestTimeoutMs);
	try {
		await client.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: {name: 'bobonyo', version: '0.1.0'},
		});
		const listed = (await client.request('tools/list', {})) as {
			tools?: Array<{
				name?: string;
				description?: string;
				inputSchema?: Record<string, unknown>;
			}>;
		};
		activeClients.add(client);
		resourceClients.set(server.id, client);
		return (listed.tools ?? []).map(tool => ({
			serverId: server.id,
			name: tool.name ?? 'unknown',
			description: tool.description ?? '',
			parameters: tool.inputSchema ?? {type: 'object', properties: {}},
			readOnly: (server.readOnlyTools ?? []).includes(tool.name ?? ''),
			call: async args => {
				const toolName = tool.name ?? 'unknown';
				const confinedArgs = confineMCPOutputFilename(server, toolName, args);
				const result = (await client.request('tools/call', {
					name: toolName,
					arguments: confinedArgs,
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
	private timeoutMs: number;
	private closed = false;

	constructor(proc: import('bun').Subprocess, timeoutMs = 30_000) {
		this.proc = proc;
		this.timeoutMs = timeoutMs;
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
		if (this.closed) return Promise.reject(new Error('mcp client is closed'));
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
			setTimeout(
				() => {
					if (this.pending.has(id)) {
						this.pending.delete(id);
						reject(new Error(`mcp request timed out: ${method}`));
					}
				},
				Math.max(1000, Math.min(120_000, this.timeoutMs)),
			);
		});
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const reject of this.pending.values())
			reject(new Error('mcp client closed'));
		this.pending.clear();
		try {
			this.proc.kill();
		} catch {
			// already exited
		}
		await this.proc.exited;
	}
}
