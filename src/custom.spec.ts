import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSkills} from './custom';
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
	if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.NANOCODER_CONFIG_DIR;
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
		writeFileSync(join(global, 'global-skill.md'), '---\nname: global-skill\n---\nbody');
		expect(loadSkills().map(skill => skill.name)).toContain('global-skill');
	});

	test('does NOT scan .claude/skills or .agents/skills (copies, not discovery)', () => {
		write('.claude/skills/prod-ops/SKILL.md', '---\nname: prod-ops\n---\nclaude body');
		write('.agents/skills/worktree/SKILL.md', '---\nname: worktree\n---\nagents body');
		expect(loadSkills().map(skill => skill.name)).not.toContain('prod-ops');
		expect(loadSkills().map(skill => skill.name)).not.toContain('worktree');
	});

	test('nested skills/<name>/SKILL.md is NOT discovered (flat-only stays stable)', () => {
		write('.nanocoder/skills/nested/SKILL.md', '---\nname: nested\n---\nbody');
		expect(loadSkills().map(skill => skill.name)).not.toContain('nested');
	});
});

describe('built-in caveman skill (harness-shipped)', () => {
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
		write('.nanocoder/skills/caveman.md', '---\nname: caveman\n---\nproject body');
		const caveman = loadSkills().filter(skill => skill.name === 'caveman');
		expect(caveman).toHaveLength(1);
		expect(caveman[0]!.body).toContain('project body');
	});

	test('is excluded when caveman mode is OFF', () => {
		setCavemanMode(false);
		expect(loadSkills().map(skill => skill.name)).not.toContain('caveman');
	});
});
