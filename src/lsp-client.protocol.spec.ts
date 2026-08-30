import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StdioLspClient} from './lsp-client';

let root = '';
afterEach(() => {
	if (root) rmSync(root, {recursive: true, force: true});
	root = '';
});

test('stdio LSP client frames JSON-RPC and answers server capability requests', async () => {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-fake-lsp-'));
	const server = join(root, 'server.ts');
	writeFileSync(
		server,
		String.raw`
let buffer = Buffer.alloc(0)
function send(message) {
  const body = JSON.stringify({jsonrpc: '2.0', ...message})
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body)
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const marker = buffer.indexOf('\r\n\r\n')
    if (marker < 0) return
    const header = buffer.slice(0, marker).toString()
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] || 0)
    const start = marker + 4
    if (buffer.length < start + length) return
    const message = JSON.parse(buffer.slice(start, start + length).toString())
    buffer = buffer.slice(start + length)
    if (message.method === 'initialize') {
      send({id: message.id, result: {capabilities: {hoverProvider: true}}})
      send({id: 99, method: 'workspace/configuration', params: {items: []}})
    } else if (message.id === 99 && 'result' in message) {
      send({method: 'window/logMessage', params: {type: 3, message: 'configured'}})
    } else if (message.method === 'textDocument/hover') {
      send({id: message.id, result: {contents: {kind: 'plaintext', value: 'hover result'}}})
    } else if (message.method === 'shutdown') {
      send({id: message.id, result: null})
    } else if (message.method === 'exit') process.exit(0)
  }
})
`,
	);
	const client = new StdioLspClient(root, [process.execPath, server]);
	try {
		await client.initialize();
		const result = await client.request('textDocument/hover', {
			textDocument: {uri: 'file:///tmp/sample.ts'},
			position: {line: 0, character: 0},
		});
		expect(result).toEqual({
			contents: {kind: 'plaintext', value: 'hover result'},
		});
	} finally {
		await client.close();
	}
});
