import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * REGRESSION GUARDS (detection tests).
 *
 * These are deliberate SOURCE-SCAN assertions, not behavior tests: they
 * fail the suite if a future change reintroduces the exact failure modes we
 * already hit, so even a developer who doesn't know the history cannot
 * silently bring them back:
 *
 *  1. Live tool rows must render as PLAIN text cells. Rendering them through
 *     `<markdown>` re-parses the whole node per update → the "christmas
 *     lights" flicker. The only renderer allowed is `LiveToolRows`.
 *  2. Running rows must go through the shared `liveRowSegments` tokenizer so
 *     colors/spacing stay identical to the settled rows.
 *  3. Each live row must keep its leading BREAKLINE (the settled transcript
 *     has a blank row between blocks; without it live rows glue themselves
 *     to the user message and to each other).
 *  4. SETTLED tool/thought rows must render as PLAIN COMPONENTS
 *     (`SettledToolRow`), never markdown: the hover highlight is a per-row
 *     background inside the row (parity: settings rows), which is what makes
 *     hover stick and hit the right rows. The old overlay geometry and the
 *     old buffer-bg tint (`applyHoverBackground`) must not reappear.
 */

/** Read a source file with comments stripped (the guards check CODE only). */
const read = (rel: string): string =>
	readFileSync(join(import.meta.dir, rel), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

describe('regression guards (foolproof live rows + hover)', () => {
	test('LiveToolRows renders plain text cells, never markdown', () => {
		const src = read('./components/live-tool-rows.tsx');
		expect(src).not.toMatch(/<markdown|MarkdownRenderable/i);
		expect(src).toMatch(/<text/);
	});

	test('history renders running tool rows ONLY via LiveToolRows', () => {
		const src = read('./components/history.tsx');
		expect(src).toMatch(/<LiveToolRows rows=\{liveToolRows\(\)\} \/>/);
		// The live rows memo builds segments through the shared util.
		expect(src).toMatch(/liveRowSegments/);
	});

	test('every live tool row keeps the settled leading breakline', () => {
		const src = read('./components/live-tool-rows.tsx');
		expect(src).toMatch(/<box height=\{1\} \/>/);
	});

	test('settled tool rows render as components; overlay/buffer-tint gone', () => {
		const history = read('./components/history.tsx');
		expect(history).toMatch(/<SettledToolRow/);
		expect(history).toMatch(/COMPONENT_ROW_LANGS/);
		// The old overlay geometry and the buffer-bg tint are gone.
		expect(history).not.toMatch(/hoverOverlay/);
		const highlight = read('./row-highlight.ts');
		expect(highlight).not.toMatch(/applyHoverBackground/);
		// The component itself is plain boxes/text — no markdown anywhere.
		const component = read('./components/settled-tool-row.tsx');
		expect(component).not.toMatch(/<markdown|MarkdownRenderable/i);
		// Hover must be a per-row BACKGROUND (settings-row parity), with the
		// header excluded by construction (the bg is only on body rows).
		expect(component).toMatch(/backgroundColor/);
	});
});
