import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {listHooks, runBashPostHooks, runBashPreHooks, runHooks} from './hooks';

const oldConfig = process.env.BOBONYO_CONFIG_DIR;
const oldCwd = process.cwd();
afterEach(() => {
	if (oldConfig === undefined) delete process.env.BOBONYO_CONFIG_DIR;
	else process.env.BOBONYO_CONFIG_DIR = oldConfig;
	process.chdir(oldCwd);
});

function setup(settings: unknown): string {
	const root = `/tmp/bobonyo-hooks-${Math.random().toString(36).slice(2)}`;
	mkdirSync(root, {recursive: true});
	writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
	process.env.BOBONYO_CONFIG_DIR = root;
	return root;
}

test('loads a Codex-shaped hooks.json only from Bobonyo config', () => {
	const root = setup({});
	writeFileSync(
		join(root, 'hooks.json'),
		JSON.stringify({
			hooks: {
				PreCompact: [{hooks: [{type: 'command', command: 'echo compact'}]}],
			},
		}),
	);
	expect(listHooks()).toContainEqual({
		event: 'PreCompact',
		matcher: '*',
		type: 'command',
		target: 'echo compact',
		async: false,
		source: join(root, 'hooks.json'),
	});
});

test('Bobonyo PreToolUse hook rewrites Bash input', async () => {
	setup({
		hooks: {
			PreToolUse: [
				{
					matcher: 'Bash',
					hooks: [
						{
							type: 'command',
							command: `cat >/dev/null; printf '%s' '{"hookSpecificOutput":{"updatedInput":{"command":"echo rewritten"}}}'`,
						},
					],
				},
			],
		},
	});
	expect(await runBashPreHooks('echo original')).toEqual({
		command: 'echo rewritten',
		description: undefined,
	});
});

test('Bobonyo PreToolUse hook can deny a Bash call', async () => {
	setup({
		hooks: {
			PreToolUse: [
				{
					matcher: 'Bash',
					hooks: [
						{
							type: 'command',
							command: `cat >/dev/null; printf '%s' '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked locally"}}'`,
						},
					],
				},
			],
		},
	});
	await expect(runBashPreHooks('git push')).rejects.toThrow('blocked locally');
});

test('Bobonyo PostToolUse hook receives command and result payload', async () => {
	const root = setup({
		hooks: {
			PostToolUse: [
				{
					matcher: 'Bash',
					hooks: [
						{
							type: 'command',
							command: `cat > "$BOBONYO_CONFIG_DIR/payload.json"`,
						},
					],
				},
			],
		},
	});
	await runBashPostHooks('gh pr merge 1', 'EXIT_CODE: 0\nmerged');
	const payload = await Bun.file(join(root, 'payload.json')).json();
	expect(payload.tool_input.command).toBe('gh pr merge 1');
	expect(payload.tool_result).toBe('EXIT_CODE: 0\nmerged');
});

test('prompt and agent hook types inject additional context', async () => {
	setup({
		hooks: {
			UserPromptSubmit: [
				{
					matcher: 'UserPromptSubmit',
					hooks: [{type: 'prompt', prompt: 'check security'}],
				},
			],
			SubagentStart: [
				{
					matcher: 'review-.*',
					hooks: [{type: 'agent', prompt: 'run typecheck'}],
				},
			],
		},
	});
	const prompt = await runHooks({event: 'UserPromptSubmit', prompt: 'ship'});
	expect(prompt.additionalContext).toEqual(['check security']);
	const agent = await runHooks({
		event: 'SubagentStart',
		agentName: 'review-ops',
	});
	expect(agent.additionalContext).toEqual(['run typecheck']);
});
