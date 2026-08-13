import {describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {CustomSpeedScroll, resolveScrollAcceleration} from './scroll-acceleration';

describe('CustomSpeedScroll (opencode scroll-speed parity)', () => {
	test('tick returns the configured multiplier', () => {
		expect(new CustomSpeedScroll(3).tick()).toBe(3);
		expect(new CustomSpeedScroll(1).tick()).toBe(1);
		expect(new CustomSpeedScroll(3).tick(Date.now())).toBe(3);
	});

	test('reset is a no-op (fixed speed has no state)', () => {
		const scroll = new CustomSpeedScroll(3);
		expect(() => scroll.reset()).not.toThrow();
		expect(scroll.tick()).toBe(3);
	});
});

describe('resolveScrollAcceleration', () => {
	const ORIGINAL = process.env.NANOCODER_CONFIG_DIR;
	const dir = join('/tmp', `scroll-accel-test-${Date.now()}`);

	test('defaults to 3 (opencode parity) when settings do not specify', () => {
		mkdirSync(dir, {recursive: true});
		process.env.NANOCODER_CONFIG_DIR = dir;
		try {
			expect(resolveScrollAcceleration().tick()).toBe(3);
		} finally {
			if (ORIGINAL === undefined) delete process.env.NANOCODER_CONFIG_DIR;
			else process.env.NANOCODER_CONFIG_DIR = ORIGINAL;
			rmSync(dir, {recursive: true, force: true});
		}
	});

	test('uses the saved scrollSpeed', () => {
		mkdirSync(dir, {recursive: true});
		process.env.NANOCODER_CONFIG_DIR = dir;
		writeFileSync(
			join(dir, 'settings.json'),
			JSON.stringify({scrollSpeed: 5}),
			'utf8',
		);
		try {
			expect(resolveScrollAcceleration().tick()).toBe(5);
		} finally {
			if (ORIGINAL === undefined) delete process.env.NANOCODER_CONFIG_DIR;
			else process.env.NANOCODER_CONFIG_DIR = ORIGINAL;
			rmSync(dir, {recursive: true, force: true});
		}
	});

	test('clamps absurd speeds', () => {
		mkdirSync(dir, {recursive: true});
		process.env.NANOCODER_CONFIG_DIR = dir;
		writeFileSync(
			join(dir, 'settings.json'),
			JSON.stringify({scrollSpeed: 999}),
			'utf8',
		);
		try {
			expect(resolveScrollAcceleration().tick()).toBe(20);
		} finally {
			if (ORIGINAL === undefined) delete process.env.NANOCODER_CONFIG_DIR;
			else process.env.NANOCODER_CONFIG_DIR = ORIGINAL;
			rmSync(dir, {recursive: true, force: true});
		}
	});
});
