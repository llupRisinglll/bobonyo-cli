import {describe, expect, test} from 'bun:test';
import {
	confineMCPOutputFilename,
	formatMCPResourceContents,
	isIsolatedPlaywrightServer,
	type MCPServerConfig,
} from './mcp';

const cwd = '/mnt/data/KSProjects/Hilinga';
const server: MCPServerConfig = {
	id: 'playwright',
	command: 'npx',
	args: ['@playwright/mcp', '--output-dir', '.screenshots'],
};

describe('confineMCPOutputFilename', () => {
	test('moves named Playwright screenshots out of project root', () => {
		expect(
			confineMCPOutputFilename(
				server,
				'browser_take_screenshot',
				{filename: 'settings-page.png'},
				cwd,
			),
		).toEqual({filename: '.screenshots/settings-page.png'});
	});

	test('keeps screenshots already inside configured output directory', () => {
		const args = {filename: '.screenshots/settings-page.png'};
		expect(
			confineMCPOutputFilename(server, 'browser_take_screenshot', args, cwd),
		).toBe(args);
	});

	test('prevents absolute and parent-traversal screenshot paths escaping', () => {
		expect(
			confineMCPOutputFilename(
				server,
				'browser_take_screenshot',
				{filename: '/tmp/preview.png'},
				cwd,
			),
		).toEqual({filename: '.screenshots/preview.png'});
		expect(
			confineMCPOutputFilename(
				server,
				'browser_take_screenshot',
				{filename: '../preview.png'},
				cwd,
			),
		).toEqual({filename: '.screenshots/preview.png'});
	});

	test('does not rewrite other MCP tools or unnamed screenshots', () => {
		const named = {filename: 'network.log'};
		expect(
			confineMCPOutputFilename(server, 'browser_network_requests', named, cwd),
		).toBe(named);
		const unnamed = {fullPage: true};
		expect(
			confineMCPOutputFilename(server, 'browser_take_screenshot', unnamed, cwd),
		).toBe(unnamed);
	});

	test('supports PLAYWRIGHT_MCP_OUTPUT_DIR and absolute output directories', () => {
		const envServer: MCPServerConfig = {
			id: 'playwright',
			command: 'npx',
			env: {PLAYWRIGHT_MCP_OUTPUT_DIR: '/tmp/mcp-shots'},
		};
		expect(
			confineMCPOutputFilename(
				envServer,
				'browser_take_screenshot',
				{filename: 'preview.png'},
				cwd,
			),
		).toEqual({filename: '/tmp/mcp-shots/preview.png'});
	});
});

test('MCP resource contents preserve text and summarize blobs', () => {
	expect(
		formatMCPResourceContents([
			{uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello'},
			{uri: 'image://x', mimeType: 'image/png', blob: 'abcd'},
		]),
	).toContain('file:///a.txt · text/plain\nhello');
	expect(
		formatMCPResourceContents([{uri: 'image://x', blob: 'abcd'}]),
	).toContain('[base64 blob: 4 chars]');
});

describe('isolated Playwright lifecycle', () => {
	test('detects only explicitly isolated Playwright MCP servers', () => {
		expect(
			isIsolatedPlaywrightServer({
				id: 'playwright',
				command: 'npx',
				args: ['@playwright/mcp@latest', '--isolated'],
			}),
		).toBe(true);
		expect(
			isIsolatedPlaywrightServer({
				id: 'playwright',
				command: 'npx',
				args: ['@playwright/mcp@latest'],
			}),
		).toBe(false);
		expect(
			isIsolatedPlaywrightServer({
				id: 'codebase-memory',
				command: 'codebase-memory-mcp',
			}),
		).toBe(false);
	});
});
