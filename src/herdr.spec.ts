import {describe, expect, test} from 'bun:test';
import {herdrForkCommand} from './herdr';

describe('Herdr fork mode inheritance', () => {
	test('default child stays sandboxed and approval-free', () => {
		expect(herdrForkCommand('session-default', 'default')).toBe(
			"bobonyo --resume 'session-default' --mode 'default'",
		);
	});

	test('explicit yolo child receives explicit unsandboxed opt-in', () => {
		expect(herdrForkCommand('session-yolo', 'yolo')).toBe(
			"bobonyo --resume 'session-yolo' --yolo",
		);
	});

	test('all other active modes are inherited exactly', () => {
		for (const mode of ['normal', 'plan', 'auto-accept'] as const) {
			expect(herdrForkCommand("session'quoted", mode)).toBe(
				`bobonyo --resume 'session'"'"'quoted' --mode '${mode}'`,
			);
		}
	});
});
