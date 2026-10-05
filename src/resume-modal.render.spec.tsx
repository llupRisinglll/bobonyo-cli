import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {createSignal, Show} from 'solid-js';
import {ResumeModal, type ResumeSession} from './components/resume-modal';
import type {SessionData} from './session';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => {
		resolve = yes;
	});
	return {promise, resolve};
}

const row: ResumeSession = {
	id: 'sess_test',
	name: 'Opening request',
	createdAt: Date.now(),
	updatedAt: Date.now(),
	firstMessage: 'First prompt',
	lastMessage: '/status',
};

test('resume modal mounts with loader before async list and selected session settle', async () => {
	const list = deferred<ResumeSession[]>();
	const selected = deferred<SessionData | null>();
	const [open, setOpen] = createSignal(true);
	let resumed: SessionData | undefined;
	let listStarted = false;
	const ui = await testRender(
		() => (
			<Show when={open()}>
				<ResumeModal
					cwd="/project"
					loadSessions={() => {
						listStarted = true;
						return list.promise;
					}}
					loadSelected={() => selected.promise}
					onResume={(_id, loaded) => {
						resumed = loaded;
					}}
					onClose={() => setOpen(false)}
				/>
			</Show>
		),
		{width: 100, height: 35, kittyKeyboard: true},
	);
	const text = () =>
		ui
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	try {
		await ui.flush();
		// Modal is visible while filesystem-backed promise remains unsettled.
		expect(text()).toContain('Resume session');
		expect(text()).toContain('Loading sessions…');
		expect(listStarted).toBe(true);
		list.resolve([row]);
		await ui.flush();
		expect(text()).toContain('sess_test: Opening request');
		ui.mockInput.pressEnter();
		await ui.flush();
		expect(text()).toContain('Loading session…');
		expect(resumed).toBeUndefined();
		const data: SessionData = {...row, messages: [], context: []};
		selected.resolve(data);
		await ui.flush();
		expect(resumed).toBe(data);
	} finally {
		ui.renderer.destroy();
	}
});
