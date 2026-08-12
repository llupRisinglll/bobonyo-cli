import {describe, expect, test} from 'bun:test';
import {renderCommandBlock, renderUserBlock} from './components/history';
import type {ChatMessage} from './state';

const longBody = Array.from({length: 25}, (_, i) => `line ${i + 1}`).join('\n');

describe('renderCommandBlock (triggered command rows)', () => {
	test('caps the body preview at 10 lines with a +N more lines footer', () => {
		const {text} = renderCommandBlock(
			{kind: 'command', name: 'worktree', body: longBody},
			'command-0',
		);
		expect(text).toContain('✦ Triggered a Command(worktree)');
		expect(text).toContain('line 10');
		expect(text).not.toContain('line 11');
		expect(text).toContain('… +15 more lines');
	});

	test('skill variants render Triggered a Skill(name)', () => {
		const {text} = renderCommandBlock(
			{kind: 'skill', name: 'frontend', body: 'short'},
			'command-1',
		);
		expect(text).toContain('✦ Triggered a Skill(frontend)');
		expect(text).toContain('  └   short');
	});

	test('short bodies render fully without a footer', () => {
		const {text} = renderCommandBlock(
			{kind: 'command', name: 'status', body: 'one\ntwo'},
			'command-2',
		);
		expect(text).toContain('one');
		expect(text).toContain('two');
		expect(text).not.toMatch(/more lines/);
	});
});

describe('renderUserBlock (multi-line user messages)', () => {
	const message = (content: string): ChatMessage => ({
		role: 'user',
		content,
	});

	test('caps long messages at 12 lines with a clickable +N footer', () => {
		const {text} = renderUserBlock(message(longBody), 'user-0');
		expect(text).toContain('line 12');
		expect(text).not.toContain('line 13');
		expect(text).toContain('… +13 more lines');
	});

	test('short messages render whole with no footer', () => {
		const {text} = renderUserBlock(
			message('hello world\nsecond line'),
			'user-1',
		);
		expect(text).toContain('❯ hello world');
		expect(text).toContain('second line');
		expect(text).not.toMatch(/more lines/);
	});
});
