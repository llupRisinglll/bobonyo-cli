import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	customToolRegistryName,
	expandCustomTool,
	loadCustomTools,
	loadSkills,
} from './custom';
import {cavemanMode, setCavemanMode} from './state';

const ORIGINAL_CONFIG_DIR = process.env.NANOCODER_CONFIG_DIR;
const ORIGINAL_CWD = process.cwd();
let root = '';
let project = '';

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-skills-'));
	project = join(root, 'project');
	mkdirSync(project, {recursive: true});
	process.env.NANOCODER_CONFIG_DIR = join(root, 'global');
	process.chdir(project);
});

afterEach(() => {
	process.chdir(ORIGINAL_CWD);
	if (ORIGINAL_CONFIG_DIR === undefined)
		delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	setCavemanMode(true);
	rmSync(root, {recursive: true, force: true});
});

const write = (rel: string, content: string): void => {
	const abs = join(project, rel);
	mkdirSync(join(abs, '..'), {recursive: true});
	writeFileSync(abs, content);
};

describe('loadSkills (bobonyo-local discovery, flat files)', () => {
	test('flat skills/*.md loads from the project dir', () => {
		write('.nanocoder/skills/deploy.md', '---\nname: deploy\n---\nbody');
		expect(loadSkills().map(skill => skill.name)).toContain('deploy');
	});

	test('flat file without frontmatter name uses the filename', () => {
		write('.nanocoder/skills/legacy.md', 'plain body');
		const skill = loadSkills().find(candidate => candidate.name === 'legacy');
		expect(skill?.body.trim()).toBe('plain body');
	});

	test('the config base skills dir loads too', () => {
		const global = join(root, 'global', 'skills');
		mkdirSync(global, {recursive: true});
		writeFileSync(
			join(global, 'global-skill.md'),
			'---\nname: global-skill\n---\nbody',
		);
		expect(loadSkills().map(skill => skill.name)).toContain('global-skill');
	});

	test('does not read Claude or Codex-owned skill folders', () => {
		write(
			'.claude/skills/prod-ops/SKILL.md',
			'---\nname: prod-ops\n---\nclaude body',
		);
		write(
			'.agents/skills/worktree/SKILL.md',
			'---\nname: worktree\n---\ncodex body',
		);
		const names = loadSkills().map(skill => skill.name);
		expect(names).not.toContain('prod-ops');
		expect(names).not.toContain('worktree');
	});

	test('loads copied SKILL.md from a Bobonyo-owned skill folder', () => {
		write(
			'.nanocoder/skills/worktree/SKILL.md',
			'---\nname: worktree\n---\nowned body',
		);
		const skill = loadSkills().find(candidate => candidate.name === 'worktree');
		expect(skill?.body).toContain('owned body');
		expect(skill?.source).toMatch(
			/\.(?:bobonyo|nanocoder)\/skills\/worktree\/SKILL\.md$/,
		);
	});

	test('nested skills/<name>/SKILL.md loads like OpenClaude', () => {
		write(
			'.nanocoder/skills/nested/SKILL.md',
			'---\ndescription: nested skill\n---\nbody',
		);
		const skill = loadSkills().find(candidate => candidate.name === 'nested');
		expect(skill?.body).toBe('body');
	});
});

describe('custom tools', () => {
	test('builds typed schemas and stable namespaced registry names', () => {
		write(
			'.bobonyo/tools/release-check.md',
			'---\nname: Release Check\ndescription: Check one release\nreadOnly: true\narguments:\n  - name: tag\n    type: string\n    required: true\n---\nChecked {{tag}}',
		);
		const tool = loadCustomTools().find(item => item.name === 'Release Check');
		expect(tool).toBeDefined();
		expect(customToolRegistryName(tool!.name)).toBe('custom__release_check');
		expect(tool!.parameters).toEqual({
			type: 'object',
			properties: {tag: {type: 'string'}},
			required: ['tag'],
			additionalProperties: false,
		});
	});

	test('expands arguments in command and body', () => {
		expect(
			expandCustomTool(
				{command: 'printf %s {{tag}}', body: 'Checked {{tag}}'},
				{tag: 'v1.2.3'},
			),
		).toEqual({
			command: "printf %s 'v1.2.3'",
			body: 'Checked v1.2.3',
		});
	});

	test('shell-quotes model arguments before command substitution', () => {
		expect(
			expandCustomTool(
				{command: 'printf %s {{tag}}', body: '{{tag}}'},
				{tag: "v1; touch /tmp/pwned's"},
			).command,
		).toBe(`printf %s 'v1; touch /tmp/pwned'"'"'s'`);
	});

	test('rejects names that cannot produce a safe registry name', () => {
		expect(() => customToolRegistryName('---')).toThrow(
			'Invalid custom tool name',
		);
	});
});

describe('built-in skills (harness-shipped)', () => {
	test('ships Herdr globally', () => {
		const herdr = loadSkills().find(skill => skill.name === 'herdr');
		expect(herdr).toBeDefined();
		expect(herdr!.body).toContain('HERDR_ENV');
		expect(herdr!.body).toContain('herdr --help');
	});
	test('ships with the harness while caveman mode is ON (default)', () => {
		expect(cavemanMode()).toBe(true);
		const caveman = loadSkills().find(skill => skill.name === 'caveman');
		expect(caveman).toBeDefined();
		expect(caveman!.body).toContain('respond terse like smart caveman');
	});

	test('keeps the narration ban but EXEMPTS tools whose description requires a pre-tool line', () => {
		// REGRESSION: caveman forbids tool-call narration, but execute_bash
		// (and the system prompt) REQUIRE a one-line pre-tool brief. Without
		// an explicit exemption the two rules contradict each other and MiMo/
		// DeepSeek fire bash bare. Both sides must stay in the injected body.
		const caveman = loadSkills().find(skill => skill.name === 'caveman');
		expect(caveman).toBeDefined();
		expect(caveman!.body).toMatch(/no tool-call narration/i);
		expect(caveman!.body).toMatch(/tool's OWN description/i);
		expect(caveman!.body).toMatch(/execute_bash/i);
	});

	test('a project caveman.md overrides the built-in (no duplicate)', () => {
		write(
			'.nanocoder/skills/caveman.md',
			'---\nname: caveman\n---\nproject body',
		);
		const caveman = loadSkills().filter(skill => skill.name === 'caveman');
		expect(caveman).toHaveLength(1);
		expect(caveman[0]!.body).toContain('project body');
	});

	test('is excluded when caveman mode is OFF', () => {
		setCavemanMode(false);
		expect(loadSkills().map(skill => skill.name)).not.toContain('caveman');
	});
});
