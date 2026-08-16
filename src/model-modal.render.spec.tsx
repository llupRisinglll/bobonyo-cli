import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {ModelModal} from './components/model-modal';

/**
 * RENDER-LEVEL guard for the model modal's recent changes:
 * 1. The provider name lives on the CATEGORY header in parentheses
 *    (`(deepseek)` / `(codex) (current)`) — never repeated on every model
 *    cell (the earlier per-cell duplication was removed on request).
 * 2. Bracketed paste lands in the modal's search, not the chat box behind.
 */

const provider = (id: string, models: string[], baseUrl: string) => ({
	id,
	name: id,
	baseUrl,
	models,
	modelEfforts: {},
});

function frameHas(frame: CapturedFrame, needle: string): boolean {
	for (const line of frame.lines) {
		for (const span of line.spans) {
			if (span.text.includes(needle)) return true;
		}
	}
	return false;
}

describe('model modal provider header + paste', () => {
	test('provider headers show the provider name in parentheses; cells stay clean', async () => {
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[
						provider('codex', ['gpt-5.4-mini'], 'https://api.openai.com/v1'),
						provider(
							'deepseek',
							['deepseek-v4-flash'],
							'https://api.deepseek.com',
						),
					]}
					currentProvider="codex"
					currentModel="gpt-5.4-mini"
					onSelect={() => {}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={false}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			await setup.flush();
			const frame = setup.captureSpans();
			// ONE group per provider: `{real title} - {connection names}`
			// (the ` - names` segment is its own secondary span).
			expect(frameHas(frame, 'Codex')).toBe(true);
			expect(frameHas(frame, '- codex')).toBe(true);
			expect(frameHas(frame, '(current)')).toBe(true);
			expect(frameHas(frame, 'DeepSeek')).toBe(true);
			expect(frameHas(frame, '- deepseek')).toBe(true);
			// The header must NOT wrap the names in parentheses.
			expect(frameHas(frame, '(deepseek')).toBe(false);
			expect(frameHas(frame, '(codex')).toBe(false);
			// The model cells do NOT repeat the provider per model.
			expect(frameHas(frame, 'gpt-5.4-mini(codex)')).toBe(false);
			expect(frameHas(frame, 'deepseek-v4-flash(deepseek)')).toBe(false);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('bracketed paste lands in the model search', async () => {
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[
						provider(
							'deepseek',
							['deepseek-v4-flash'],
							'https://api.deepseek.com',
						),
					]}
					currentProvider="deepseek"
					currentModel="deepseek-v4-flash"
					onSelect={() => {}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={false}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			await setup.flush();
			await setup.mockInput.pasteBracketedText('deepseek');
			await setup.flush();
			// The search box shows the pasted query (the `⌕ ` and the query
			// render as separate spans, so check the query's own text); the
			// group header separately shows `(deepseek)`.
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'deepseek▌')).toBe(true);
			expect(frameHas(frame, 'DeepSeek')).toBe(true);
			expect(frameHas(frame, '- deepseek')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});
});

describe('model modal multiple accounts (ONE group per provider)', () => {
	const go = (name: string) => ({
		id: name,
		name,
		baseUrl: 'https://opencode.ai/zen/go/v1',
		// A RESOLVED key: the account picker must show the MASKED slice.
		apiKey: `sk-opencode-${name}-key-1234567890`,
		models: ['minimax-m3'],
		modelEfforts: {},
	});

	test('two connections merge into ONE header, and picking a model asks which account to use', async () => {
		let selected: string | undefined;
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[go('brian'), go('mika')]}
					currentProvider="brian"
					currentModel="minimax-m3"
					onSelect={providerId => {
						selected = providerId;
					}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={false}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();

			// ONE group: `OpenCode - Go (Subscription)` — the merged header
			// names the TIER, not the raw account ids.
			let frame = setup.captureSpans();
			expect(frameHas(frame, 'OpenCode')).toBe(true);
			expect(frameHas(frame, '- Go (Subscription)')).toBe(true);

			// Selecting the model opens the EFFORT step first (opencode flow:
			// model → effort → tier → named connection), then the ACCOUNT
			// PICKER — the choice is the NAMED provider (multiple opencode
			// keys allowed per endpoint), tier + endpoint on the detail line.
			mockInput.pressEnter();
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'Select effort')).toBe(true);
			mockInput.pressEnter(); // default effort
			await setup.flush();
			frame = setup.captureSpans();
			expect(frameHas(frame, 'Select provider')).toBe(true);
			expect(frameHas(frame, 'brian')).toBe(true);
			expect(frameHas(frame, 'mika')).toBe(true);
			expect(frameHas(frame, 'sk-o…7890')).toBe(true);
			expect(
				frameHas(frame, 'Go (Subscription) · https://opencode.ai/zen/go/v1'),
			).toBe(false);

			// Pick the second account (mika) → select (effort already chosen).
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			expect(selected).toBe('mika');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('two opencode keys of the SAME tier still ask which NAMED provider (multiple API keys)', async () => {
		// The user's requirement: opencode go + zen share the API key but not
		// the endpoint, and multiple keys are allowed per endpoint. The picker
		// must present the USER-GIVEN names as the choice — two Go connections
		// must not both read "OpenCode Go (Subscription)".
		let selected: string | undefined;
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[go('work-key'), go('personal-key')]}
					currentProvider="work-key"
					currentModel="minimax-m3"
					onSelect={providerId => {
						selected = providerId;
					}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={false}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();
			mockInput.pressEnter(); // model → EFFORT step (opencode flow)
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'Select effort')).toBe(true);
			mockInput.pressEnter(); // default effort
			await setup.flush();
			// ONE tier (Go) → skip the tier step → account picker.
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'Select provider')).toBe(true);
			// The NAMES are the selectable rows — not two identical tier labels.
			expect(frameHas(frame, 'work-key')).toBe(true);
			expect(frameHas(frame, 'personal-key')).toBe(true);
			expect(frameHas(frame, 'sk-o…7890')).toBe(true);
			// Pick the second key → effort already chosen → select.
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			expect(selected).toBe('personal-key');
		} finally {
			setup.renderer.destroy();
		}
	});
	test('opencode flow: model → effort → TIER (Zen/Go) → named connection', async () => {
		// The requested flow: select model → choose effort → choose Zen or Go
		// → choose which connection was created. Zen + Go share one API key
		// (different endpoints), so the tier step narrows the group's
		// connections by endpoint before the named picker.
		const zen = (name: string) => ({
			id: name,
			name,
			baseUrl: 'https://opencode.ai/zen/v1',
			models: ['minimax-m3'],
			modelEfforts: {},
		});
		let selected: {providerId: string; effort?: string} | undefined;
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[go('go-work'), go('go-personal'), zen('zen-free')]}
					currentProvider="go-work"
					currentModel="minimax-m3"
					onSelect={(providerId, _model, effort) => {
						selected = {providerId, effort};
					}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={false}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();
			mockInput.pressEnter(); // model → EFFORT
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'Select effort')).toBe(true);
			mockInput.pressEnter(); // default effort
			await setup.flush();
			// TIER step: Zen (API usage) / Go (Subscription).
			const frame = setup.captureSpans();
			const tierText = frame.lines
				.map(line => line.spans.map(sp => sp.text).join(''))
				.join('\n');
			expect(tierText).toContain('Select tier');
			expect(tierText).toContain('Zen (API usage)');
			expect(tierText).toContain('Go (Subscription)');
			// The tier rows show their ENDPOINT, so the user knows which URL
			// each tier will use (Zen/Go share the key, differ in endpoint).
			expect(tierText).toContain('https://opencode.ai/zen/v1');
			expect(tierText).toContain('https://opencode.ai/zen/go/v1');
			// The cursor starts on ZEN (index 0) — Enter picks it directly →
			// only the zen connection remains.
			mockInput.pressEnter();
			await setup.flush();
			const connFrame = setup.captureSpans();
			expect(frameHas(connFrame, 'Select provider')).toBe(true);
			expect(frameHas(connFrame, 'zen-free')).toBe(true);
			expect(frameHas(connFrame, 'go-work')).toBe(false);
			mockInput.pressEnter();
			await setup.flush();
			expect(selected).toEqual({providerId: 'zen-free', effort: undefined});
		} finally {
			setup.renderer.destroy();
		}
	});
	test('opencode tier step: Go shows ONLY the Go connections (zen/go choice first)', async () => {
		const zen = (name: string) => ({
			id: name,
			name,
			baseUrl: 'https://opencode.ai/zen/v1',
			models: ['minimax-m3'],
			modelEfforts: {},
		});
		let selected: {providerId: string; effort?: string} | undefined;
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[go('go-work'), go('go-personal'), zen('zen-free')]}
					currentProvider="zen-free"
					currentModel="minimax-m3"
					onSelect={(providerId, _model, effort) => {
						selected = {providerId, effort};
					}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={false}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();
			mockInput.pressEnter(); // model → EFFORT
			await setup.flush();
			mockInput.pressArrow('down'); // minimal effort
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			// TIER step → pick Go (row 2).
			expect(frameHas(setup.captureSpans(), 'Select tier')).toBe(true);
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			// Go connections only — the two keys are the choice.
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'Select provider')).toBe(true);
			expect(frameHas(frame, 'go-work')).toBe(true);
			expect(frameHas(frame, 'go-personal')).toBe(true);
			expect(frameHas(frame, 'zen-free')).toBe(false);
			// Pick the second Go key — the chosen effort rides through.
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			expect(selected).toEqual({providerId: 'go-personal', effort: 'minimal'});
		} finally {
			setup.renderer.destroy();
		}
	});
	test('an account swap within the SAME provider skips the resend confirm (context + cache head stay intact)', async () => {
		let selected: string | undefined;
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[go('brian'), go('mika')]}
					currentProvider="brian"
					currentModel="minimax-m3"
					onSelect={providerId => {
						selected = providerId;
					}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={true}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();
			mockInput.pressEnter(); // model → EFFORT step (opencode flow)
			await setup.flush();
			mockInput.pressEnter(); // default effort
			await setup.flush();
			mockInput.pressArrow('down'); // mika
			await setup.flush();
			mockInput.pressEnter(); // pick mika → select (effort already chosen)
			await setup.flush();
			expect(selected).toBe('mika');
			// No "Switch model" confirm was shown.
			expect(frameHas(setup.captureSpans(), 'Switch model')).toBe(false);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('switching to a DIFFERENT provider still confirms the resend', async () => {
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[
						go('brian'),
						{
							id: 'deepseek',
							name: 'deepseek',
							baseUrl: 'https://api.deepseek.com',
							models: ['deepseek-v4-flash'],
							modelEfforts: {},
						},
					]}
					currentProvider="brian"
					currentModel="minimax-m3"
					onSelect={() => {}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={true}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();
			// Navigate to the deepseek model cell: ↓ moves within the group
			// (one model), then ↓ to the next group's first cell.
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressEnter(); // select deepseek model → effort step
			await setup.flush();
			mockInput.pressEnter(); // default effort → CONFIRM (different provider)
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'Switch model')).toBe(true);
			expect(frameHas(setup.captureSpans(), '(y) continue')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});
});
