import {expect, spyOn, test} from 'bun:test';
import {executeTool, toolCatalog} from './tools';
import {validateToolArguments} from './tool-schema';
import * as bash from './bash';

test('Bash rejects unsupported directory arguments before executing in wrong repo', async () => {
	const run = spyOn(bash, 'runBash').mockResolvedValue({
		content: 'unexpected execution',
	});
	try {
		for (const key of ['workdir', 'cwd', 'working_directory']) {
			const args = {
				command: 'npm ci --ignore-scripts',
				[key]: '/tmp/sdk-review',
			};
			const result = await executeTool({
				id: key,
				name: 'execute_bash',
				arguments: args,
				rawArguments: JSON.stringify(args),
			});
			expect(result.content).toContain('Invalid tool arguments');
			expect(result.content).toContain(key);
			expect(result.content).toContain('cd');
		}
		expect(run).not.toHaveBeenCalled();
	} finally {
		run.mockRestore();
	}
});

test('Bash schema advertises strict arguments and accepts explicit directory command', () => {
	const schema = toolCatalog().find(
		tool => tool.name === 'execute_bash',
	)!.parameters!;
	expect(schema.additionalProperties).toBe(false);
	expect(
		validateToolArguments(
			{command: 'cd /tmp/sdk-review && npm ci --ignore-scripts'},
			schema,
		).valid,
	).toBe(true);
	expect(
		validateToolArguments({command: 'true', workdir: '/tmp/sdk-review'}, schema)
			.valid,
	).toBe(false);
});
