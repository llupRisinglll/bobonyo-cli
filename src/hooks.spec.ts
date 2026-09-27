import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {listHooks, runBashPostHooks, runBashPreHooks, runHooks} from './hooks';

const oldConfig = process.env.BOBONYO_CONFIG_DIR;
const oldCwd = process.cwd();
test('prompt admission never returns denied text and preserves accepted rewrites', async () => {
	const {applyUserPromptHookResult} = await import('./hooks');
	const warnings: string[] = [];
	expect(
		applyUserPromptHookResult(
			'new task',
			{
				denied: 'persistence failed',
				updatedInput: {prompt: 'unsafe rewrite'},
				additionalContext: ['unsafe context'],
				messages: [],
			},
			message => warnings.push(message),
		),
	).toBeUndefined();
	expect(warnings).toEqual(['persistence failed']);
	expect(
		applyUserPromptHookResult(
			'original',
			{
				updatedInput: {prompt: 'accepted'},
				additionalContext: ['guidance'],
				messages: [],
			},
			message => warnings.push(message),
		),
	).toBe('accepted\n\nguidance');
});
test('failed delayed compaction suppresses stale error and finalizer effects', async () => {
	const hooks = await import('./hooks');
	for (const replace of [false, true]) {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			async fetch() {
				entered.resolve();
				await release.promise;
				return Response.json({
					hookSpecificOutput: {
						permissionDecision: 'deny',
						permissionDecisionReason: 'delivery failed',
					},
				});
			},
		});
		const dir = setup({
			hooks: {
				PostCompact: [
					{
						hooks: [
							{
								type: 'http',
								url: `http://127.0.0.1:${server.port}`,
							},
						],
					},
				],
			},
		});
		process.chdir(dir);
		try {
			await hooks.runHooks({event: 'SessionStart', sessionSource: 'startup'});
			const owner = hooks.hookSessionId();
			const owns = () => hooks.hookSessionId() === owner;
			let failures = 0;
			let indicator = true;
			let errorSeen = false;
			const operation = hooks.runOwnedContextOperation(
				async () => {
					await hooks.installCompactedContext(() => true, 'main', owner, owns);
				},
				owns,
				() => {
					failures++;
					errorSeen = true;
				},
				() => {
					indicator = false;
				},
			);
			const settled = operation.catch(() => {});
			await entered.promise;
			if (replace)
				await hooks.runHooks({event: 'SessionStart', sessionSource: 'clear'});
			release.resolve();
			await settled;
			expect(failures).toBe(replace ? 0 : 1);
			expect(indicator).toBe(replace);
			expect(errorSeen).toBe(!replace);
		} finally {
			release.resolve();
			server.stop(true);
		}
	}
});
test('overlapping startup failures remain scoped to their captured sessions', async () => {
	const hooks = await import('./hooks');
	for (const oldFails of [false, true]) {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			async fetch() {
				entered.resolve();
				await release.promise;
				return Response.json(
					oldFails
						? {
								hookSpecificOutput: {
									permissionDecision: 'deny',
									permissionDecisionReason: 'old failed',
								},
							}
						: {},
				);
			},
		});
		const dir = setup({
			hooks: {
				SessionStart: [
					{hooks: [{type: 'http', url: `http://127.0.0.1:${server.port}`}]},
				],
			},
		});
		process.chdir(dir);
		try {
			const oldStart = hooks.runHooks({
				event: 'SessionStart',
				sessionSource: 'startup',
			});
			const oldId = hooks.hookSessionId();
			await entered.promise;
			writeFileSync(
				join(dir, 'settings.json'),
				JSON.stringify({
					hooks: {
						SessionStart: [
							{
								hooks: [
									{type: 'command', command: oldFails ? 'true' : 'exit 1'},
								],
							},
						],
					},
				}),
			);
			const newStart = hooks.runHooks({
				event: 'SessionStart',
				sessionSource: 'clear',
			});
			const newId = hooks.hookSessionId();
			release.resolve();
			await Promise.all([oldStart, newStart]);
			const [oldTool, newTool] = await Promise.all(
				[oldId, newId].map(id =>
					hooks.withHookContext(
						'main',
						() => hooks.runHooks({event: 'PreToolUse', toolName: 'read_file'}),
						id,
					),
				),
			);
			expect(Boolean(oldTool!.denied)).toBe(oldFails);
			expect(Boolean(newTool!.denied)).toBe(!oldFails);
		} finally {
			release.resolve();
			server.stop(true);
		}
	}
});

test('delayed PostCompact cannot publish over replacement session or context store', async () => {
	const hooks = await import('./hooks');
	for (const replaceSession of [false, true]) {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			async fetch() {
				entered.resolve();
				await release.promise;
				return Response.json({});
			},
		});
		const dir = setup({
			hooks: {
				PostCompact: [
					{hooks: [{type: 'http', url: `http://127.0.0.1:${server.port}`}]},
				],
			},
		});
		process.chdir(dir);
		try {
			await hooks.runHooks({event: 'SessionStart', sessionSource: 'startup'});
			const owner = hooks.hookSessionId();
			let store = {};
			const capturedStore = store;
			let messages = ['old'];
			let undo = ['old undo'];
			let retry = 'old retry';
			const operation = (async () => {
				const installed = await hooks.installCompactedContext(
					() => true,
					'main',
					owner,
					() => hooks.hookSessionId() === owner && store === capturedStore,
				);
				if (!installed) return;
				messages = ['compacted'];
				undo = [];
				retry = '';
			})();
			await entered.promise;
			if (replaceSession)
				await hooks.runHooks({event: 'SessionStart', sessionSource: 'clear'});
			else store = {};
			messages = ['new'];
			undo = ['new undo'];
			retry = 'new retry';
			release.resolve();
			await operation;
			expect(messages).toEqual(['new']);
			expect(undo).toEqual(['new undo']);
			expect(retry).toBe('new retry');
		} finally {
			release.resolve();
			server.stop(true);
		}
	}
});
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

test('context identities isolate concurrent tool owners and await session delivery', async () => {
	const hooks = await import('./hooks');
	const dir = setup({
		hooks: {
			SessionStart: [
				{
					hooks: [
						{
							type: 'command',
							command: 'cat > "$BOBONYO_CONFIG_DIR/start.json"',
						},
					],
				},
			],
			PreToolUse: [
				{
					hooks: [
						{type: 'command', command: 'cat > "$BOBONYO_CONFIG_DIR/pre.json"'},
					],
				},
			],
		},
	});
	process.chdir(dir);
	const start = hooks.runHooks({
		event: 'SessionStart',
		sessionSource: 'startup',
	});
	await hooks.runHooks({event: 'PreToolUse', toolName: 'read_file'});
	const initial = await Bun.file(join(dir, 'start.json')).json();
	const pre = await Bun.file(join(dir, 'pre.json')).json();
	expect(initial.session_id).toBeString();
	expect(pre.session_id).toBe(initial.session_id);
	expect(pre.context_id).toBe('main');
	await start;
	await hooks.withHookContext('agent:one', () =>
		hooks.runHooks({event: 'PreToolUse', toolName: 'read_file'}),
	);
	expect((await Bun.file(join(dir, 'pre.json')).json()).context_id).toBe(
		'agent:one',
	);
	await hooks.runHooks({event: 'SessionStart', sessionSource: 'clear'});
	expect((await Bun.file(join(dir, 'start.json')).json()).session_id).not.toBe(
		initial.session_id,
	);
});

test('completed compaction installs first, awaits delivery, and ignores rejected installs', async () => {
	const hooks = await import('./hooks');
	const dir = setup({
		hooks: {
			PostCompact: [
				{
					hooks: [
						{
							type: 'command',
							command: 'cat > "$BOBONYO_CONFIG_DIR/compact.json"',
						},
					],
				},
			],
		},
	});
	process.chdir(dir);
	let installed = false;
	await hooks.installCompactedContext(() => {
		installed = true;
		return true;
	}, 'graph:one');
	expect(installed).toBe(true);
	const first = await Bun.file(join(dir, 'compact.json')).json();
	expect(first.context_id).toBe('graph:one');
	await hooks.installCompactedContext(() => false, 'graph:two');
	expect((await Bun.file(join(dir, 'compact.json')).json()).context_id).toBe(
		'graph:one',
	);
	await expect(
		hooks.installCompactedContext(() => {
			throw Error('summary failed');
		}, 'graph:three'),
	).rejects.toThrow('summary failed');
	expect((await Bun.file(join(dir, 'compact.json')).json()).context_id).toBe(
		'graph:one',
	);
});

test('failed lifecycle delivery blocks tools until a new session recovers', async () => {
	const hooks = await import('./hooks');
	const dir = setup({
		hooks: {SessionStart: [{hooks: [{type: 'command', command: 'exit 1'}]}]},
	});
	process.chdir(dir);
	expect(
		(await hooks.runHooks({event: 'SessionStart', sessionSource: 'clear'}))
			.denied,
	).toBeTruthy();
	expect(
		(await hooks.runHooks({event: 'PreToolUse', toolName: 'read_file'})).denied,
	).toBeTruthy();
	writeFileSync(join(dir, 'settings.json'), '{}');
	expect(
		(await hooks.runHooks({event: 'SessionStart', sessionSource: 'clear'}))
			.denied,
	).toBeUndefined();
	expect(
		(await hooks.runHooks({event: 'PreToolUse', toolName: 'read_file'})).denied,
	).toBeUndefined();
});

test('failed compaction delivery blocks only its owning context', async () => {
	const hooks = await import('./hooks');
	const dir = setup({
		hooks: {
			PostCompact: [
				{hooks: [{type: 'command', command: 'exit 1', async: true}]},
			],
		},
	});
	process.chdir(dir);
	await hooks.runHooks({event: 'SessionStart', sessionSource: 'startup'});
	await expect(
		hooks.installCompactedContext(() => true, 'graph:failed'),
	).rejects.toThrow();
	expect(
		(
			await hooks.withHookContext('graph:failed', () =>
				hooks.runHooks({event: 'PreToolUse', toolName: 'read_file'}),
			)
		).denied,
	).toBeTruthy();
	expect(
		(
			await hooks.withHookContext('main', () =>
				hooks.runHooks({event: 'PreToolUse', toolName: 'read_file'}),
			)
		).denied,
	).toBeUndefined();
});

test('old asynchronous context retains its session identity after clear', async () => {
	const hooks = await import('./hooks');
	const dir = setup({
		hooks: {
			PreToolUse: [
				{
					hooks: [
						{
							type: 'command',
							command: 'cat > "$BOBONYO_CONFIG_DIR/owner.json"',
						},
					],
				},
			],
		},
	});
	process.chdir(dir);
	await hooks.runHooks({event: 'SessionStart', sessionSource: 'startup'});
	const old = hooks.hookSessionId();
	await hooks.runHooks({event: 'SessionStart', sessionSource: 'clear'});
	await hooks.withHookContext(
		'agent:old',
		() => hooks.runHooks({event: 'PreToolUse', toolName: 'read_file'}),
		old,
	);
	const payload = await Bun.file(join(dir, 'owner.json')).json();
	expect(payload.session_id).toBe(old);
	expect(payload.context_id).toBe('agent:old');
	expect(hooks.hookSessionId()).not.toBe(old);
});
