import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {ModelModal} from './components/model-modal';
import {EffortModal} from './components/effort-modal';
import {AgentsModal} from './components/agents-modal';
import {ConnectProviderModal} from './components/connect-provider-modal';

/**
 * RENDER-LEVEL anti-regression guards for MODAL ARROW NAVIGATION.
 *
 * The reported bug: arrow keys did NOT move the selection in the model
 * modal's connection picker ("Select provider") and effort step ("Select
 * effort"). Root cause: the active-row check read the selection SIGNAL
 * inside the <For> child, but OpenTUI's reconciler only re-renders For
 * children when the `each` ARRAY reference changes — a stable array means
 * the highlight froze while the signal (and the final Enter selection)
 * still moved underneath it. The same stale-highlight pattern existed in
 * the standalone effort modal, the agents modal and the connect-provider
 * auth-method list.
 *
 * Every test asserts the VISIBLE `❯` marker moved in the captured frame —
 * not just the final callback value (the old tests passed because the
 * selection callback reads the signal, which moved even while the paint
 * stayed frozen).
 */
/** The trimmed text of the row carrying the `❯` selection marker. */
function activeRowText(frame: CapturedFrame): string {
	for (const line of frame.lines) {
		const text = line.spans.map(s => s.text).join('');
		if (text.includes('❯')) return text.trim();
	}
	return '';
}
function frameHas(frame: CapturedFrame, needle: string): boolean {
	return frame.lines.some(line =>
		line.spans.some(span => span.text.includes(needle)),
	);
}

const go = (name: string) => ({
	id: name,
	name,
	baseUrl: 'https://opencode.ai/zen/go/v1',
	models: ['mock-model-1'],
	modelEfforts: {},
});

describe('modal arrow navigation moves the VISIBLE selection', () => {
	test('model modal connection picker: ↓/↑ move the ❯ between accounts', async () => {
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[go('brian'), go('mika')]}
					currentProvider="brian"
					currentModel="mock-model-1"
					onSelect={() => {}}
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
			mockInput.pressEnter(); // select the model → connection picker
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'Select provider')).toBe(true);
			// Initially brian (the first connection) is selected.
			expect(activeRowText(setup.captureSpans())).toContain('brian');
			// ↓ moves the VISIBLE highlight to mika (froze before: the
			// active check read connectionIndex() inside a stable For).
			mockInput.pressArrow('down');
			await setup.flush();
			expect(activeRowText(setup.captureSpans())).toContain('mika');
			expect(activeRowText(setup.captureSpans())).not.toContain('brian');
			// ↑ moves it back.
			mockInput.pressArrow('up');
			await setup.flush();
			expect(activeRowText(setup.captureSpans())).toContain('brian');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('model modal effort step: ↓ moves the ❯ through the effort tiers', async () => {
		let selected: {provider: string; effort?: string} | undefined;
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[go('brian')]}
					currentProvider="brian"
					currentModel="mock-model-1"
					onSelect={(provider, _model, effort) => {
						selected = {provider, effort};
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
			mockInput.pressEnter(); // select the model → effort step
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'Select effort')).toBe(true);
			expect(activeRowText(setup.captureSpans())).toContain('Default');
			// ↓↓ moves the VISIBLE highlight to `low`.
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressArrow('down');
			await setup.flush();
			expect(activeRowText(setup.captureSpans())).toContain('low');
			// Enter picks the HIGHLIGHTED tier (not Default).
			mockInput.pressEnter();
			await setup.flush();
			expect(selected?.effort).toBe('low');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('standalone effort modal (bare /effort): ↓ moves the ❯', async () => {
		let chosen: string | undefined;
		const setup = await testRender(
			() => (
				<EffortModal
					model="mock-model-1"
					provider="mock"
					onSelect={level => {
						chosen = level;
					}}
					onClose={() => {}}
				/>
			),
			{width: 64, height: 20, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();
			expect(activeRowText(setup.captureSpans())).toContain('Default');
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressArrow('down');
			await setup.flush();
			expect(activeRowText(setup.captureSpans())).toContain('low');
			mockInput.pressEnter();
			await setup.flush();
			expect(chosen).toBe('low');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('agents modal: ↓ moves the ❯ through the agent list', async () => {
		const setup = await testRender(() => <AgentsModal onClose={() => {}} />, {
			width: 80,
			height: 24,
			kittyKeyboard: true,
		});
		try {
			const {mockInput} = setup;
			await setup.flush();
			const first = activeRowText(setup.captureSpans());
			expect(first.length).toBeGreaterThan(0);
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressArrow('down');
			await setup.flush();
			// The active row CHANGED (the ❯ no longer sits on the first
			// entry — it froze on entry 0 before the fix).
			expect(activeRowText(setup.captureSpans())).not.toBe(first);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('connect-provider auth-method list (codex): ↓ moves the ❯ to API key', async () => {
		// Isolate from the machine's real providers (a connected codex
		// account would send Enter to the MANAGE step instead).
		process.env.BOBONYO_PROVIDERS = JSON.stringify({providers: []});
		const setup = await testRender(
			() => <ConnectProviderModal onConnect={() => {}} onClose={() => {}} />,
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();
			// Filter to codex (it offers TWO auth methods) and pick it.
			await mockInput.typeText('codex');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'ChatGPT account')).toBe(true);
			expect(activeRowText(setup.captureSpans())).toContain('ChatGPT account');
			// ↓ moves the VISIBLE highlight to the API-key method (froze
			// before: the authMethods array is stable across renders).
			mockInput.pressArrow('down');
			await setup.flush();
			expect(activeRowText(setup.captureSpans())).toContain('API key');
		} finally {
			delete process.env.BOBONYO_PROVIDERS;
			setup.renderer.destroy();
		}
	});
});
