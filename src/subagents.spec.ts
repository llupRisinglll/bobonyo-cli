import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSubagents, subagentModel, subagentSystemPrompt} from './subagents';

const ORIGINAL_CONFIG_DIR = process.env.NANOCODER_CONFIG_DIR;
const ORIGINAL_CWD = process.cwd();
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-subagents-spec-'));
	process.env.NANOCODER_CONFIG_DIR = join(root, 'config');
	const project = join(root, 'project');
	mkdirSync(join(project, '.nanocoder', 'agents'), {recursive: true});
	process.chdir(project);
	mkdirSync(join(root, 'config', 'agents'), {recursive: true});
});

afterEach(() => {
	if (ORIGINAL_CONFIG_DIR === undefined)
		delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	process.chdir(ORIGINAL_CWD);
	rmSync(root, {recursive: true, force: true});
});

const AGENT_MD = (name: string, extra = ''): string =>
	`---\nname: ${name}\ndescription: ${name} does a thing\n${extra}---\n\nYou are the ${name} agent. Do the thing well.`;

describe('loadSubagents (nanocoder subagent-loader parity)', () => {
	test('discovers project agents from .nanocoder/agents', () => {
		writeFileSync(
			join(root, 'project', '.nanocoder', 'agents', 'review-api.md'),
			AGENT_MD('review-api'),
		);
		writeFileSync(
			join(root, 'project', '.nanocoder', 'agents', 'review-db.md'),
			AGENT_MD('review-db'),
		);
		const agents = loadSubagents();
		expect(agents.map(agent => agent.name).sort()).toEqual([
			'review-api',
			'review-db',
		]);
		expect(agents.every(agent => agent.source === 'project')).toBe(true);
		expect(
			agents.find(agent => agent.name === 'review-api')!.systemPrompt,
		).toContain('You are the review-api agent');
	});

	test('user agents load from the config dir and project wins on conflict', () => {
		writeFileSync(
			join(root, 'config', 'agents', 'shared.md'),
			AGENT_MD('shared', 'model: mimo-v2.5\n'),
		);
		writeFileSync(
			join(root, 'project', '.nanocoder', 'agents', 'shared.md'),
			AGENT_MD('shared', 'model: deepseek-v4-flash\n'),
		);
		const agents = loadSubagents();
		expect(agents).toHaveLength(1);
		expect(agents[0]!.source).toBe('project');
		expect(subagentModel('shared')).toBe('deepseek-v4-flash');
	});

	test('frontmatter tools/description parse and inherit model is undefined', () => {
		writeFileSync(
			join(root, 'project', '.nanocoder', 'agents', 'research.md'),
			AGENT_MD('research', 'model: inherit\ntools:\n  - read_file\n  - grep\n'),
		);
		const agent = loadSubagents()[0]!;
		expect(agent.model).toBe('inherit');
		expect(agent.tools).toEqual(['read_file', 'grep']);
		expect(agent.description).toBe('research does a thing');
	});

	test('subagentSystemPrompt returns the file body or empty for unknown', () => {
		writeFileSync(
			join(root, 'project', '.nanocoder', 'agents', 'audit.md'),
			AGENT_MD('audit'),
		);
		expect(subagentSystemPrompt('audit')).toContain('You are the audit agent');
		expect(subagentSystemPrompt('audit')).not.toContain('---');
		expect(subagentSystemPrompt('missing')).toBe('');
	});

	test('files without a name frontmatter are skipped', () => {
		writeFileSync(
			join(root, 'project', '.nanocoder', 'agents', 'no-name.md'),
			'---\ndescription: no name here\n---\nbody',
		);
		expect(loadSubagents()).toHaveLength(0);
	});
});
