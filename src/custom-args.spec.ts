import {describe, expect, test} from 'bun:test';
import {mapCommandArguments, type ArgumentSpec} from './custom';

describe('mapCommandArguments (rest-arg capture)', () => {
	test('a rest arg captures ALL remaining tokens as one value', () => {
		const spec: ArgumentSpec[] = [{name: 'request', rest: true}];
		expect(mapCommandArguments(spec, ['purpose:', 'hello', 'world'])).toEqual({
			request: 'purpose: hello world',
		});
	});

	test('positional args take one token each before the rest', () => {
		const spec: ArgumentSpec[] = [
			{name: 'name', required: true},
			{name: 'notes', rest: true},
		];
		expect(
			mapCommandArguments(spec, ['checkout-bug', 'purpose:', 'the', 'fix']),
		).toEqual({name: 'checkout-bug', notes: 'purpose: the fix'});
	});

	test('missing tokens leave empty values', () => {
		const spec: ArgumentSpec[] = [{name: 'name'}, {name: 'notes', rest: true}];
		expect(mapCommandArguments(spec, [])).toEqual({name: '', notes: ''});
		expect(mapCommandArguments(spec, ['only-name'])).toEqual({
			name: 'only-name',
			notes: '',
		});
	});
});

describe('expandCommandPrompt (OpenClaude command parsing parity)', () => {
	test('appends free-form arguments when body has no placeholder', async () => {
		const {expandCommandPrompt} = await import('./custom');
		expect(
			expandCommandPrompt({
				body: 'Create a pull request for the current branch.',
				rawArgs: 'for this new e2e',
				spec: [],
				tokens: ['for', 'this', 'new', 'e2e'],
			}),
		).toBe(
			'Create a pull request for the current branch.\n\nARGUMENTS: for this new e2e',
		);
	});

	test('supports full, indexed, shorthand, named and moustache placeholders', async () => {
		const {expandCommandPrompt} = await import('./custom');
		const spec: ArgumentSpec[] = [
			{name: 'kind'},
			{name: 'request', rest: true},
		];
		expect(
			expandCommandPrompt({
				body: '$ARGUMENTS | $ARGUMENTS[0] | $1 | $kind | {{request}}',
				rawArgs: 'e2e "new flow" now',
				spec,
				tokens: ['e2e', 'new flow', 'now'],
			}),
		).toBe('e2e "new flow" now | e2e | new flow | e2e | new flow now');
	});

	test('does not append ARGUMENTS after a placeholder consumed them', async () => {
		const {expandCommandPrompt} = await import('./custom');
		expect(
			expandCommandPrompt({
				body: 'Purpose: $ARGUMENTS',
				rawArgs: 'for this new e2e',
				spec: [],
				tokens: ['for', 'this', 'new', 'e2e'],
			}),
		).toBe('Purpose: for this new e2e');
	});
});

describe('buildCommandInvocationPrompt (interpret before acting)', () => {
	test('keeps user request primary and workflow guidance secondary', async () => {
		const {buildCommandInvocationPrompt} = await import('./custom');
		const prompt = buildCommandInvocationPrompt({
			name: 'create-pr',
			description: 'Create a pull request',
			userRequest: 'for this new e2e only',
			guidance: 'Create a PR for every dirty repository.',
		});
		expect(prompt).toContain('<user-request>\nfor this new e2e only');
		expect(prompt).toContain('<workflow-guidance>');
		expect(prompt).toContain('user request');
		expect(prompt).toContain('override conflicting defaults');
		expect(prompt.indexOf('<user-request>')).toBeLessThan(
			prompt.indexOf('<workflow-guidance>'),
		);
	});

	test('never presents command markdown as a literal execution script', async () => {
		const {buildCommandInvocationPrompt} = await import('./custom');
		const prompt = buildCommandInvocationPrompt({
			name: 'deploy',
			userRequest: 'deploy staging, not production',
			guidance: 'Deploy production by default.',
		});
		expect(prompt).toContain('adaptable instructions');
		expect(prompt).toContain('execute only the relevant adapted workflow');
	});
});
