import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {createSignal, Show} from 'solid-js';
import {ResumeModal, type ResumeSession} from './components/resume-modal';
import type {SessionData} from './session';
import {runCommand, type CommandContext} from './commands';

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

test('/resume dispatch paints before slow persistence or listing can block', async () => {
	const [open, setOpen] = createSignal(false);
	const list = deferred<ResumeSession[]>();
	let loadingPainted = false;
	let saves = 0;
	let listedAfterPaint = false;
	let recorded = '';
	const ui = await testRender(
		() => (
			<Show when={open()}>
				<ResumeModal
					cwd="/project"
					loadSessions={() => {
						listedAfterPaint = loadingPainted;
						return list.promise;
					}}
					onResume={() => {}}
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
	ui.renderer.on('frame', () => {
		if (text().includes('Loading sessions…')) loadingPainted = true;
	});
	try {
		const start = performance.now();
		runCommand('/resume', {
			onBuiltinCommand: (input: string, options?: {persist: false}) => {
				recorded = input;
				// Mirrors App's submission callback. The filesystem delay is
				// deliberately synchronous, just like saveSession's snapshot.
				if (options?.persist !== false) {
					saves++;
					Bun.sleepSync(200);
				}
			},
			resume: () => setOpen(true),
		} as unknown as CommandContext);
		const dispatchMs = performance.now() - start;
		await ui.flush();
		expect(recorded).toBe('/resume');
		expect(saves).toBe(0);
		expect(dispatchMs).toBeLessThan(100);
		expect(text()).toContain('Loading sessions…');
		expect(listedAfterPaint).toBe(true);
		// Keep the read unresolved for 200ms: the painted shell remains
		// usable, and Esc cancels it without waiting for the filesystem.
		await Bun.sleep(200);
		ui.mockInput.pressEscape();
		await ui.flush();
		expect(text()).not.toContain('Resume session');
		list.resolve([row]);
		await ui.flush();
		expect(text()).not.toContain('Opening request');
		console.info(
			`resume dispatch ${dispatchMs.toFixed(1)}ms; delayed snapshot skipped (200ms); delayed list cancelled (200ms)`,
		);
	} finally {
		ui.renderer.destroy();
	}
});

test('resume search starts one row below title and footer follows content tightly', async () => {
	const ui = await testRender(
		() => (
			<ResumeModal
				cwd="/project"
				sessions={[row]}
				onResume={() => {}}
				onClose={() => {}}
			/>
		),
		{width: 100, height: 35},
	);
	try {
		await ui.flush();
		const lines = ui
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''));
		const title = lines.findIndex(line => line.includes('Resume session'));
		const search = lines.findIndex(line => line.includes('Type to filter'));
		const prompt = lines.findIndex(line => line.includes('└ /status'));
		const footer = lines.findIndex(line => line.includes('Enter resume'));
		// Bottom title cap + body padding + search border, no duplicate gaps.
		expect(search - title).toBe(4);
		expect(footer - prompt).toBe(2);
	} finally {
		ui.renderer.destroy();
	}
});

for (const height of [16, 15]) {
	test(`resume selected mixed-height row stays visible before Enter at 80x${height}`, async () => {
		const first = {...row, id: 'sess_first', name: 'First with preview'};
		const second = {
			...row,
			id: 'sess_second',
			name: 'Second without preview',
			updatedAt: row.updatedAt - 1,
			firstMessage: '',
			lastMessage: '',
		};
		let resumed = '';
		const ui = await testRender(
			() => (
				<ResumeModal
					cwd="/project"
					sessions={[first, second]}
					onResume={id => {
						resumed = id;
					}}
					onClose={() => {}}
				/>
			),
			{width: 80, height, kittyKeyboard: true},
		);
		const text = () =>
			ui
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''))
				.join('\n');
		try {
			await ui.flush();
			expect(text()).toContain('❯ sess_first: First with preview');
			if (height === 15) expect(text()).not.toContain('└ /status');
			ui.mockInput.pressArrow('down');
			await ui.flush();
			expect(text()).toContain('❯ sess_second: Second without preview');
			ui.mockInput.pressEnter();
			await ui.flush();
			expect(resumed).toBe(second.id);
		} finally {
			ui.renderer.destroy();
		}
	});
}
