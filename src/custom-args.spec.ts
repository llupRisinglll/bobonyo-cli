import {describe, expect, test} from 'bun:test';
import {mapCommandArguments, type ArgumentSpec} from './custom';

describe('mapCommandArguments (rest-arg capture)', () => {
	test('a rest arg captures ALL remaining tokens as one value', () => {
		const spec: ArgumentSpec[] = [{name: 'request', rest: true}];
		expect(
			mapCommandArguments(spec, ['purpose:', 'hello', 'world']),
		).toEqual({request: 'purpose: hello world'});
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
