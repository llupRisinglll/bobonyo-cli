import {describe, expect, test} from 'bun:test';
import {cliMode, MODE_HELP} from './cli-mode';
import {autoApprovesTools, modeLabel, SAFE_MODE_CYCLE} from './modes';

describe('explicit execution mode flags', () => {
	test('no flags leave saved/default mode alone', () => {
		expect(cliMode([])).toBeUndefined();
		expect(cliMode(['--provider', 'local'])).toBeUndefined();
	});
	test('yolo requires an explicit mode flag', () => {
		expect(cliMode(['--yolo'])).toBe('yolo');
		expect(cliMode(['--mode', 'yolo'])).toBe('yolo');
		expect(cliMode(['--mode=default'])).toBe('default');
	});
	test('invalid and conflicting flags fail instead of silently escalating', () => {
		expect(() => cliMode(['--mode'])).toThrow('Invalid mode');
		expect(() => cliMode(['--mode', 'typo'])).toThrow('Invalid mode');
		expect(() => cliMode(['--mode', 'normal', '--yolo'])).toThrow(
			'Conflicting',
		);
		expect(() => cliMode(['--yolo', '--mode=default'])).toThrow('Conflicting');
	});
	test('default retains automatic approval without yolo label', () => {
		expect(autoApprovesTools('default')).toBe(true);
		expect(autoApprovesTools('yolo')).toBe(true);
		expect(autoApprovesTools('normal')).toBe(false);
		expect(autoApprovesTools('plan')).toBe(false);
		expect(modeLabel('default')).toBe('default mode');
		expect(modeLabel('yolo')).toBe('yolo (sandbox off)');
		expect(SAFE_MODE_CYCLE).not.toContain('yolo');
	});
	test('help states risks and retains clarification and guards', () => {
		expect(MODE_HELP).toContain('--yolo');
		expect(MODE_HELP).toContain('WARNING:');
		expect(MODE_HELP).toContain(
			'Clarification questions, safety guards, and hooks remain enabled',
		);
	});
});
