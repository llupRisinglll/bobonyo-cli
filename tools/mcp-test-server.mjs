#!/usr/bin/env node
/**
 * Minimal stdio MCP test server (parity fixture for the rewrite's E8 client).
 * Speaks JSON-RPC over stdin/stdout: initialize, tools/list, tools/call.
 * Tools: mcp_echo (echo text back), mcp_time (current timestamp).
 */

import {createInterface} from 'node:readline';

const rl = createInterface({input: process.stdin});

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

const TOOLS = [
	{
		name: 'mcp_echo',
		description: 'Echo text back',
		inputSchema: {
			type: 'object',
			properties: {text: {type: 'string'}},
		},
	},
	{
		name: 'mcp_time',
		description: 'Return the current ISO timestamp',
		inputSchema: {type: 'object', properties: {}},
	},
];

rl.on('line', line => {
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		return;
	}
	const respond = result => send({jsonrpc: '2.0', id: request.id, result});
	const error = message =>
		send({jsonrpc: '2.0', id: request.id, error: {code: -32000, message}});

	switch (request.method) {
		case 'initialize':
			respond({
				protocolVersion: '2024-11-05',
				capabilities: {tools: {}},
				serverInfo: {name: 'mcp-test', version: '1.0.0'},
			});
			break;
		case 'tools/list':
			respond({tools: TOOLS});
			break;
		case 'tools/call': {
			const {name, arguments: args = {}} = request.params ?? {};
			if (name === 'mcp_echo') {
				respond({content: [{type: 'text', text: `echo: ${args.text ?? ''}`}]});
			} else if (name === 'mcp_time') {
				respond({
					content: [{type: 'text', text: `time: ${new Date().toISOString()}`}],
				});
			} else {
				error(`unknown tool: ${name}`);
			}
			break;
		}
		default:
			error(`unknown method: ${request.method}`);
	}
});
