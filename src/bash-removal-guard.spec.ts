import {describe, expect, test} from 'bun:test';
import {mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {checkBashRemovalSafety} from './bash-removal-guard';
import {runBash} from './bash';

const cwd = '/tmp/bobonyo-rm-guard';
mkdirSync(cwd, {recursive: true});

describe('Bash removal safety', () => {
	test('allows one literal file strictly below cwd', () => {
		expect(checkBashRemovalSafety('rm safe.txt', cwd)).toMatchObject({
			allowed: true,
		});
	});

	test('refuses absolute and relative targets outside cwd', () => {
		for (const command of ['rm /tmp/outside.txt', 'rm ../outside.txt']) {
			expect(checkBashRemovalSafety(command, cwd).allowed).toBe(false);
		}
	});
	test('allows literal deletion only below an explicit external root', () => {
		const external = '/tmp/bobonyo-external-grant';
		mkdirSync(external, {recursive: true});
		expect(
			checkBashRemovalSafety(`${'rm'} ${external}/general-purpose.md`, cwd, [
				external,
			]),
		).toMatchObject({allowed: true});
		expect(
			checkBashRemovalSafety(`${'rm'} ${external}/../outside.md`, cwd, [
				external,
			]).allowed,
		).toBe(false);
	});

	test('refuses workspace root and recursive rm', () => {
		for (const command of ['rm .', 'rm -rf .', 'rm -r safe-dir']) {
			expect(checkBashRemovalSafety(command, cwd).allowed).toBe(false);
		}
	});

	test('refuses globs, variables, substitutions, and tilde paths', () => {
		for (const command of [
			'rm *',
			'rm "$TARGET"',
			'rm "$(printf safe.txt)"',
			'rm `printf safe.txt`',
			'rm ~/safe.txt',
		]) {
			expect(checkBashRemovalSafety(command, cwd).allowed).toBe(false);
		}
	});

	test('refuses wrappers, shell indirection, compound outside rm, and find -delete', () => {
		for (const command of [
			'nice rm -rf /',
			"bash -c 'rm safe.txt'",
			'echo safe && rm /tmp/outside.txt',
			'find . -delete',
		]) {
			expect(checkBashRemovalSafety(command, cwd).allowed).toBe(false);
		}
	});

	test('refuses symlink targets', () => {
		const link = join(cwd, 'outside-link');
		try {
			symlinkSync('/tmp', link);
		} catch {}
		expect(checkBashRemovalSafety('rm outside-link', cwd).allowed).toBe(false);
	});

	test('runBash refuses before process creation', async () => {
		const marker = join(cwd, 'must-survive.txt');
		writeFileSync(marker, 'safe');
		const result = await runBash(
			`rm /tmp/outside.txt; printf touched > ${marker}`,
			undefined,
			undefined,
			cwd,
		);
		expect(result.content).toContain('REFUSED dangerous deletion');
		expect(await Bun.file(marker).text()).toBe('safe');
	});
});
