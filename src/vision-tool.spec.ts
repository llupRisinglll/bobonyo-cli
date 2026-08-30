import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {inspectWorkspaceImage} from './vision';

const root = '/tmp/bobonyo-view-image';
afterEach(() => rmSync(root, {recursive: true, force: true}));

test('view image confines paths and delegates a default prompt', async () => {
	mkdirSync(root, {recursive: true});
	writeFileSync(join(root, 'screen.png'), Buffer.from([1, 2, 3]));
	let prompt = '';
	const result = await inspectWorkspaceImage(
		'screen.png',
		'',
		root,
		async (_path, question) => {
			prompt = question;
			return 'blue screen';
		},
	);
	expect(result).toBe('blue screen');
	expect(prompt).toContain('Describe this image');
	symlinkSync('/etc/passwd', join(root, 'escape.png'));
	await expect(
		inspectWorkspaceImage('escape.png', 'inspect', root, async () => 'bad'),
	).rejects.toThrow(/outside/);
});
