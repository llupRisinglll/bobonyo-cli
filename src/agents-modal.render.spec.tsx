import '@opentui/solid/preload';
import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {testRender} from '@opentui/solid';
import {AgentsModal} from './components/agents-modal';
import {loadPreferences} from './config';
import {saveSubagentModel} from './subagents';
import type {ModelProvider} from './components/model-modal';

const roots: string[] = [];
const providers: ModelProvider[] = [
	{
		id: 'mock',
		name: 'Mock',
		models: ['main-model', 'fast-model'],
		modelEfforts: {},
	},
];
function isolatedConfig(): string {
	const root = join(
		tmpdir(),
		`bobonyo-agents-modal-${process.pid}-${Date.now()}-${Math.random()}`,
	);
	roots.push(root);
	mkdirSync(join(root, 'agents'), {recursive: true});
	process.env.BOBONYO_CONFIG_DIR = root;
	return root;
}
function frameText(setup: Awaited<ReturnType<typeof testRender>>): string {
	return setup
		.captureSpans()
		.lines.map(line => line.spans.map(span => span.text).join(''))
		.join('\n');
}

function modalProps() {
	return {
		providers,
		currentProvider: 'mock',
		currentModel: 'main-model',
		onConnectProvider: () => {},
		onClose: () => {},
	};
}

afterEach(() => {
	delete process.env.BOBONYO_CONFIG_DIR;
	for (const root of roots.splice(0))
		rmSync(root, {recursive: true, force: true});
});

describe('agents modal management', () => {
	test('Enter opens shared model selection and persists chosen override', async () => {
		isolatedConfig();
		const setup = await testRender(() => <AgentsModal {...modalProps()} />, {
			width: 80,
			height: 24,
			kittyKeyboard: true,
		});
		try {
			await setup.flush();
			setup.mockInput.pressEnter();
			await setup.flush();
			expect(frameText(setup)).toContain('Select model for Explore');
			expect(frameText(setup)).toContain('Inherit main agent model');
			setup.mockInput.pressTab();
			await setup.flush();
			setup.mockInput.pressArrow('down');
			await setup.flush();
			setup.mockInput.pressArrow('right');
			await setup.flush();
			await Bun.sleep(160);
			setup.mockInput.pressEnter();
			await Bun.sleep(60);
			await setup.flush();
			expect(frameText(setup)).toContain('Select effort');
			await Bun.sleep(160);
			setup.mockInput.pressEnter();
			await Bun.sleep(5);
			await setup.flush();
			expect(loadPreferences().agentModels?.explore).toBe('fast-model');
			expect(loadPreferences().agentProviders?.explore).toBe('mock');
			expect(frameText(setup)).toContain('Explore · fast-model');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('inherit entry clears model and provider overrides', async () => {
		isolatedConfig();
		saveSubagentModel('explore', 'fast-model', 'mock');
		const setup = await testRender(() => <AgentsModal {...modalProps()} />, {
			width: 80,
			height: 24,
			kittyKeyboard: true,
		});
		try {
			await setup.flush();
			setup.mockInput.pressEnter();
			await Bun.sleep(160);
			await setup.flush();
			setup.mockInput.pressArrow('up');
			await setup.flush();
			setup.mockInput.pressEnter();
			await Bun.sleep(5);
			await setup.flush();
			expect(loadPreferences().agentModels?.explore).toBe('inherit');
			expect(loadPreferences().agentProviders?.explore).toBeUndefined();
			expect(frameText(setup)).toContain('Explore · inherit');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('Shift+D asks before deleting a custom agent and y confirms', async () => {
		const root = isolatedConfig();
		const agentFile = join(root, 'agents', 'audit.md');
		writeFileSync(
			agentFile,
			'---\nname: audit\ndescription: Audit code\n---\nAudit carefully.\n',
		);
		const setup = await testRender(() => <AgentsModal {...modalProps()} />, {
			width: 80,
			height: 24,
			kittyKeyboard: true,
		});
		try {
			await setup.flush();
			expect(frameText(setup)).toContain('audit');
			setup.mockInput.pressKey('d', {shift: true});
			await setup.flush();
			expect(frameText(setup)).toContain('Delete "audit"?');
			expect(existsSync(agentFile)).toBe(true);
			setup.mockInput.pressKey('y');
			await setup.flush();
			expect(existsSync(agentFile)).toBe(false);
			expect(frameText(setup)).not.toContain('audit ·');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('built-in agents cannot enter delete confirmation', async () => {
		isolatedConfig();
		const setup = await testRender(() => <AgentsModal {...modalProps()} />, {
			width: 80,
			height: 24,
			kittyKeyboard: true,
		});
		try {
			await setup.flush();
			setup.mockInput.pressKey('d', {shift: true});
			await setup.flush();
			expect(frameText(setup)).not.toContain('Delete agent');
		} finally {
			setup.renderer.destroy();
		}
	});
});
