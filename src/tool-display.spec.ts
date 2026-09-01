import {expect, test} from 'bun:test';
import {formatToolEntry} from './tool-display';

test('agent tool rows use compact Ran syntax, never nested agent calls', () => {
	const row = formatToolEntry(
		{
			name: 'agent',
			detail: 'agent:explore(Inspect E2E coverage. Do not edit.)',
			output: 'Started background agent agent:explore:1',
		},
		false,
		'running',
		true,
	);
	expect(row).toContain(
		'Ran agent:explore(Inspect E2E coverage. Do not edit.)',
	);
	expect(row).not.toContain('agent(agent:');
});
