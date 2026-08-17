import {describe, expect, test} from 'bun:test';
import type {TextChunk} from '@opentui/core';
import {renderCommandBlock, renderUserBlock} from './components/history';
import {renderInfoRow} from './components/history';
import type {ChatMessage} from './state';
import {tokenizeCommandRow} from './row-highlight';
import {colors} from './theme';

const longBody = Array.from({length: 25}, (_, i) => `line ${i + 1}`).join('\n');

function rgb(chunk: TextChunk | undefined): string {
	const fg = chunk?.fg as {r: number; g: number; b: number} | undefined;
	return fg
		? `rgb(${Math.round(fg.r * 255)},${Math.round(fg.g * 255)},${Math.round(fg.b * 255)})`
		: '';
}

function themeRgb(hex: string): string {
	return `rgb(${parseInt(hex.slice(1, 3), 16)},${parseInt(
		hex.slice(3, 5),
		16,
	)},${parseInt(hex.slice(5, 7), 16)})`;
}

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

describe('tokenizeCommandRow (header colors)', () => {
	test('Triggered a + (name) are WHITE, Command is primary bold', () => {
		const chunks = tokenizeCommandRow(
			'✦ Triggered a Command(worktree)\n  └   body',
			'done',
			colors(),
		);
		const joined = chunks.map(c => c.text).join('');
		expect(joined).toContain('Triggered a Command(worktree)');
		const triggered = chunks.find(c => c.text === 'Triggered a ');
		const command = chunks.find(c => c.text === 'Command');
		const paren = chunks.find(c => c.text === '(worktree)');
		expect(rgb(triggered)).toBe(themeRgb(colors().text));
		expect(rgb(command)).toBe(themeRgb(colors().primary));
		expect(rgb(paren)).toBe(themeRgb(colors().text));
	});

	test('glyph-less header (live row strips the glyph) still matches', () => {
		// liveRowSegments strips the leading ✦ before tokenizing, so the
		// header arrives WITHOUT the glyph — the regex must be optional.
		const chunks = tokenizeCommandRow(
			'Triggered a Command(worktree)\n  └   body',
			'done',
			colors(),
		);
		const command = chunks.find(c => c.text === 'Command');
		const triggered = chunks.find(c => c.text === 'Triggered a ');
		expect(command).toBeDefined();
		expect(rgb(command)).toBe(themeRgb(colors().primary));
		expect(rgb(triggered)).toBe(themeRgb(colors().text));
	});
});

describe('renderInfoRow (background task completion)', () => {
	test('renders a tool-style row with the └ container and +N footer', () => {
		const text = renderInfoRow(
			'Background task completed · exit 0\n' +
				'cd /mnt/data/KSProjects/Hilinga && ./worktree-create.sh hello-wo',
			'info-0',
		);
		expect(text).toContain('✦ Background task completed · exit 0');
		expect(text).toContain('  └   cd /mnt/data/KSProjects/Hilinga');
		expect(text).toContain('worktree-create.sh hello-wo');
	});

	test('long scripts hard-wrap inside the container', () => {
		const long = 'x'.repeat(200);
		const text = renderInfoRow(
			`Background task completed · exit 1\n${long}`,
			'info-1',
		);
		const lines = text.split('\n');
		// Leading history breakline + fence opener + blank + header, then
		// wrapped body lines.
		const body = lines.slice(4, lines.length - 1);
		expect(body.length).toBeGreaterThan(2);
		expect(body[0]!.startsWith('  └   ')).toBe(true);
		for (const line of body.slice(1))
			expect(line.startsWith('      ')).toBe(true);
	});
});
