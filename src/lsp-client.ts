import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {extname, resolve} from 'node:path';

interface JsonRpcMessage {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: {code?: number; message?: string};
}

export interface LspServerCommand {
	name: string;
	command: string[];
}

const SERVER_BY_EXTENSION: Record<string, LspServerCommand[]> = {
	'.ts': [
		{
			name: 'typescript-language-server',
			command: ['typescript-language-server', '--stdio'],
		},
	],
	'.tsx': [
		{
			name: 'typescript-language-server',
			command: ['typescript-language-server', '--stdio'],
		},
	],
	'.js': [
		{
			name: 'typescript-language-server',
			command: ['typescript-language-server', '--stdio'],
		},
	],
	'.jsx': [
		{
			name: 'typescript-language-server',
			command: ['typescript-language-server', '--stdio'],
		},
	],
	'.py': [
		{name: 'pyright', command: ['pyright-langserver', '--stdio']},
		{name: 'pylsp', command: ['pylsp']},
	],
	'.rs': [{name: 'rust-analyzer', command: ['rust-analyzer']}],
	'.go': [{name: 'gopls', command: ['gopls']}],
	'.c': [{name: 'clangd', command: ['clangd']}],
	'.cc': [{name: 'clangd', command: ['clangd']}],
	'.cpp': [{name: 'clangd', command: ['clangd']}],
	'.h': [{name: 'clangd', command: ['clangd']}],
	'.hpp': [{name: 'clangd', command: ['clangd']}],
};

export function lspServerForPath(path: string): LspServerCommand | null {
	return (
		SERVER_BY_EXTENSION[extname(path).toLowerCase()]?.find(server =>
			Boolean(Bun.which(server.command[0]!)),
		) ?? null
	);
}

function languageId(path: string): string {
	return (
		{
			'.ts': 'typescript',
			'.tsx': 'typescriptreact',
			'.js': 'javascript',
			'.jsx': 'javascriptreact',
			'.py': 'python',
			'.rs': 'rust',
			'.go': 'go',
			'.c': 'c',
			'.cc': 'cpp',
			'.cpp': 'cpp',
			'.h': 'c',
			'.hpp': 'cpp',
		}[extname(path).toLowerCase()] ?? 'plaintext'
	);
}

export class StdioLspClient {
	private nextId = 1;
	private pending = new Map<
		number,
		{resolve: (value: unknown) => void; reject: (error: Error) => void}
	>();
	private notifications = new Map<string, Array<(params: unknown) => void>>();
	private writer: {
		write(data: Uint8Array): number | Promise<number>;
		end(): void;
	};
	private process: ReturnType<typeof Bun.spawn>;
	private readerTask: Promise<void>;

	constructor(
		private cwd: string,
		command: string[],
	) {
		this.process = Bun.spawn(command, {
			cwd,
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		this.writer = this.process.stdin as unknown as {
			write(data: Uint8Array): number | Promise<number>;
			end(): void;
		};
		this.readerTask = this.readLoop();
	}

	private async send(message: JsonRpcMessage): Promise<void> {
		const body = JSON.stringify({jsonrpc: '2.0', ...message});
		const bytes = new TextEncoder().encode(
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
		);
		await this.writer.write(bytes);
	}

	request(
		method: string,
		params: unknown,
		timeoutMs = 15_000,
	): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: value => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: error => {
					clearTimeout(timer);
					reject(error);
				},
			});
			void this.send({id, method, params}).catch(error => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	notify(method: string, params: unknown): Promise<void> {
		return this.send({method, params});
	}

	on(method: string, listener: (params: unknown) => void): () => void {
		const listeners = this.notifications.get(method) ?? [];
		listeners.push(listener);
		this.notifications.set(method, listeners);
		return () => {
			this.notifications.set(
				method,
				(this.notifications.get(method) ?? []).filter(
					item => item !== listener,
				),
			);
		};
	}

	private async readLoop(): Promise<void> {
		const reader = (
			this.process.stdout as ReadableStream<Uint8Array>
		).getReader();
		let buffer = new Uint8Array();
		try {
			for (;;) {
				const {done, value} = await reader.read();
				if (done) break;
				const next = new Uint8Array(buffer.length + value.length);
				next.set(buffer);
				next.set(value, buffer.length);
				buffer = next;
				for (;;) {
					const text = new TextDecoder().decode(buffer);
					const headerEnd = text.indexOf('\r\n\r\n');
					if (headerEnd < 0) break;
					const match = /Content-Length:\s*(\d+)/i.exec(
						text.slice(0, headerEnd),
					);
					if (!match) throw new Error('LSP response omitted Content-Length');
					const length = Number(match[1]);
					const bodyStart = new TextEncoder().encode(
						text.slice(0, headerEnd + 4),
					).length;
					if (buffer.length < bodyStart + length) break;
					const body = new TextDecoder().decode(
						buffer.slice(bodyStart, bodyStart + length),
					);
					buffer = buffer.slice(bodyStart + length);
					this.handle(JSON.parse(body) as JsonRpcMessage);
				}
			}
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			for (const pending of this.pending.values()) pending.reject(failure);
			this.pending.clear();
		} finally {
			reader.releaseLock();
		}
	}

	private handle(message: JsonRpcMessage): void {
		if (typeof message.id === 'number' && message.method) {
			void this.send({
				id: message.id,
				result: this.serverRequestResult(message.method),
			});
			return;
		}
		if (typeof message.id === 'number') {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error)
				pending.reject(
					new Error(message.error.message || 'LSP request failed'),
				);
			else pending.resolve(message.result);
			return;
		}
		if (message.method) {
			for (const listener of this.notifications.get(message.method) ?? []) {
				listener(message.params);
			}
		}
	}
	private serverRequestResult(method: string): unknown {
		switch (method) {
			case 'workspace/configuration':
				return [];
			case 'workspace/workspaceFolders':
				return [
					{
						uri: pathToFileURL(this.cwd).href,
						name: this.cwd.split('/').pop() || 'workspace',
					},
				];
			case 'client/registerCapability':
			case 'client/unregisterCapability':
			case 'window/workDoneProgress/create':
				return null;
			default:
				return null;
		}
	}
	async initialize(): Promise<void> {
		const rootUri = pathToFileURL(this.cwd).href;
		await this.request('initialize', {
			processId: process.pid,
			rootUri,
			capabilities: {
				workspace: {symbol: {}},
				textDocument: {
					definition: {},
					references: {},
					hover: {},
					publishDiagnostics: {},
				},
			},
			workspaceFolders: [
				{uri: rootUri, name: this.cwd.split('/').pop() || 'workspace'},
			],
		});
		await this.notify('initialized', {});
	}

	async openFile(path: string): Promise<{uri: string; text: string}> {
		const absolute = resolve(this.cwd, path);
		const text = readFileSync(absolute, 'utf8');
		const uri = pathToFileURL(absolute).href;
		await this.notify('textDocument/didOpen', {
			textDocument: {uri, languageId: languageId(absolute), version: 1, text},
		});
		return {uri, text};
	}

	async close(): Promise<void> {
		try {
			await this.request('shutdown', null, 2000);
			await this.notify('exit', null);
		} catch {
			// Server may already be gone.
		}
		try {
			this.writer.end();
		} catch {}
		this.process.kill();
		await Promise.race([this.readerTask, Bun.sleep(200)]);
	}
}
