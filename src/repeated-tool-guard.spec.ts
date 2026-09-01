import {describe, expect, test} from 'bun:test';
import {
	evaluateRepeatedToolCalls,
	type RepeatedToolState,
} from './repeated-tool-guard';

const initialState = (): RepeatedToolState => ({
	lastSignature: null,
	count: 0,
});

describe('repeated tool guard', () => {
	test('does not stop repeated write_tasks bookkeeping calls', () => {
		let state = initialState();
		for (let index = 0; index < 6; index++) {
			const result = evaluateRepeatedToolCalls(
				[
					{
						name: 'write_tasks',
						arguments: {
							tasks: [{title: 'Continue work', status: 'in_progress'}],
						},
					},
				],
				state,
			);
			expect(result.stop).toBe(false);
			state = result.state;
		}
		expect(state).toEqual(initialState());
	});
	test('does not stop repeated process status monitoring calls', () => {
		let state = initialState();
		for (let index = 0; index < 6; index++) {
			const result = evaluateRepeatedToolCalls(
				[{name: 'process_status', arguments: {process_id: 'proc_server'}}],
				state,
			);
			expect(result.stop).toBe(false);
			state = result.state;
		}
		expect(state).toEqual(initialState());
	});

	test('still stops a real identical tool loop on third call', () => {
		let state = initialState();
		const calls = [{name: 'execute_bash', arguments: {command: 'echo stuck'}}];
		const first = evaluateRepeatedToolCalls(calls, state);
		expect(first.stop).toBe(false);
		state = first.state;
		const second = evaluateRepeatedToolCalls(calls, state);
		expect(second.stop).toBe(false);
		state = second.state;
		const third = evaluateRepeatedToolCalls(calls, state);
		expect(third.stop).toBe(true);
		expect(third.state.count).toBe(3);
	});

	test('write_tasks does not hide repeated executable calls between updates', () => {
		const calls = [{name: 'execute_bash', arguments: {command: 'echo once'}}];
		const first = evaluateRepeatedToolCalls(calls, initialState());
		const bookkeeping = evaluateRepeatedToolCalls(
			[{name: 'write_tasks', arguments: {tasks: []}}],
			first.state,
		);
		const second = evaluateRepeatedToolCalls(calls, bookkeeping.state);
		const third = evaluateRepeatedToolCalls(calls, second.state);
		expect(bookkeeping.stop).toBe(false);
		expect(bookkeeping.state).toEqual(first.state);
		expect(second.stop).toBe(false);
		expect(third.stop).toBe(true);
	});
	test('skill calls remain guarded because repeated loads can loop', () => {
		let state = initialState();
		const calls = [{name: 'skill', arguments: {name: 'herdr'}}];
		for (let index = 0; index < 2; index++) {
			const result = evaluateRepeatedToolCalls(calls, state);
			expect(result.stop).toBe(false);
			state = result.state;
		}
		const third = evaluateRepeatedToolCalls(calls, state);
		expect(third.stop).toBe(true);
	});
});
