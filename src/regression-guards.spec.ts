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

	test('the Worked-for completion line never auto-expires on a timer', () => {
		// The completion line persists during idle; it is cleared only when
		// a NEW turn starts or `/clear` runs. A timeout clearing it makes
		// the line vanish mid-idle — that exact regression is banned.
		const app = read('./app.tsx');
		expect(app).not.toMatch(/completionTimer/);
		expect(app).not.toMatch(
			/setCompletionMessage\(\s*['"]\s*['"]\s*\)\s*,\s*\d+\s*\)/,
		);
		// And it must be cleared at turn start + on /clear.
		expect(app).toMatch(/setCompletionMessage\(''\)/);
	});

	test('/status always reports the resolved AGENTS.md rules file', () => {
		const app = read('./app.tsx');
		expect(app).toMatch(/resolveRulesFile\(process\.cwd\(\)\)/);
		const rows = read('./status-rows.ts');
		expect(rows).toMatch(/'AGENTS\.md'/);
	});

	test('launcher keeps the USER cwd and applies the OpenTUI preload', () => {
		const build = read('../scripts/build.mjs');
		// Running `bobonyo` in another project must NOT cd into the repo
		// before exec: skills/AGENTS.md resolve against the user's cwd. A
		// subshell `cd … && pwd` to RESOLVE the repo dir is fine; changing
		// the launcher's own cwd (the old `cd` + `exec bun run src/…`) is not.
		expect(build).not.toMatch(
			/cd "\$\(dirname "\$0"\)\/\.\."\n\s*exec \/usr\/bin\/env bun run src\/index\.tsx/,
		);
		// The preload must be passed by ABSOLUTE PATH (-r): a bare module
		// specifier resolves against the user's node_modules and a missing
		// bunfig skips the preload — both crash the UI with "Orphan text".
		expect(build).toMatch(/bun run -r "\$PRELOAD"/);
		expect(build).toMatch(/@opentui\/solid\/scripts\/preload\.js/);
		// The dist launcher is STRICTLY the release entry: dev runs go
		// through the separate `bobonyo-dev` alias, never through dist.
		expect(build).not.toMatch(/--dev/);
	});

	test('trust/approval prompts never dereference a null signal', () => {
		const input = read('./components/input-box.tsx');
		expect(input).not.toMatch(/prompt\(\)!/);
		expect(input).not.toMatch(/approval\(\)!/);
	});

	test('the trust gate renders a DIALOG, never the free-text prompt', () => {
		const app = read('./app.tsx');
		expect(app).toMatch(/<TrustModal/);
		expect(app).toMatch(/pendingTrust/);
		// The trust question must not appear as a text prompt in the input.
		const input = read('./components/input-box.tsx');
		expect(input).not.toMatch(/Trust this directory/);
		// The codex-style dialog lives in its own component.
		const modal = read('./components/trust-modal.tsx');
		expect(modal).toMatch(/Trust this directory/);
		expect(modal).toMatch(/Yes, trust this directory/);
		expect(modal).toMatch(/No, do not trust/);
	});

	test('the /model modal opens on the CURRENT model row', () => {
		const modal = read('./components/model-modal.tsx');
		// The initial row index must come from the pure helper (current
		// model first, then first navigable row) — never a hardcoded 0,
		// which lands on the provider header and shows no highlight.
		expect(modal).toMatch(/initialModelRowIndex\(buildRows\(\)\)/);
		expect(modal).not.toMatch(/rowIndex, setRowIndex\] = createSignal\(0\)/);
		// Query changes re-snap through the same helper.
		expect(modal).toMatch(/createEffect/);
	});

	test('resume search covers the session id', () => {
		const modal = read('./components/resume-modal.tsx');
		// The filter must go through the pure helper that matches the id,
		// the name AND the last prompt — not just name/prompt inline.
		expect(modal).toMatch(/sessionMatchesQuery\(session, q\)/);
		const spec = read('../src/resume-modal.spec.ts');
		expect(spec).toMatch(/matches by SESSION ID/);
	});

	test('Ctrl+Left/Right jump WORD-WISE in the input (original parity)', () => {
		const input = read('./components/input-box.tsx');
		// The arrow handler branches on ctrl and goes through the word-jump
		// helpers — a regression would fall back to plain char movement.
		expect(input).toMatch(/event\.ctrl\) moveCursorPrevWord\(\)/);
		expect(input).toMatch(/event\.ctrl\) moveCursorNextWord\(\)/);
		expect(input).toMatch(/moveToPrevWord/);
		expect(input).toMatch(/moveToNextWord/);
	});
});
