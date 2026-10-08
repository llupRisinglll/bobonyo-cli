import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {mkdtempSync, rmSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from './app';
import {prepareResume, type PreparedResume} from './resume-preparation';
import {saveSession, type SessionData} from './session';
import {loadSettings, saveSettings} from './settings';
import {
	clearMessages,
	setBusy,
	setResumeOpen,
	setStartupLoading,
	setCompletionMessage,
	setPendingTrust,
	setInput,
	input,
	steeringInbox,
	pendingPrompt,
	sessionId,
	sessionName,
	tasks,
	activeEndpoint,
	context,
	messages,
	pendingQueue,
} from './state';

const selectedEntry = process.env.BOBONYO_RESUME_TEST_ENTRY;
for (const entry of [
	'CLI last',
	'picker selection',
	'ask yes',
	'ask no',
	'ask Escape',
	'ownership clear',
	'ownership resume',
	'stale clear',
	'stale resume',
	'failure missing',
	'failure error',
	'old loop',
	'old goal',
	'loading input',
]) {
	if (!selectedEntry) {
		test(`isolated App resume regression: ${entry}`, async () => {
			const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
				env: {...process.env, BOBONYO_RESUME_TEST_ENTRY: entry},
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
			expect(code).toBe(0);
		}, 15000);
		continue;
	}
	if (selectedEntry !== entry) continue;
	test(`real App ${entry} paints loader before delayed IO and keeps it through restore`, async () => {
		const directory = mkdtempSync(join(tmpdir(), 'bobonyo-resume-render-'));
		const env = {
			config: process.env.BOBONYO_CONFIG_DIR,
			data: process.env.BOBONYO_DATA_DIR,
			legacy: process.env.NANOCODER_DATA_DIR,
			resume: process.env.NANOCODER_RESUME,
			mock: process.env.MOCK_URL,
		};
		process.env.BOBONYO_CONFIG_DIR = directory;
		process.env.BOBONYO_DATA_DIR = directory;
		process.env.NANOCODER_DATA_DIR = directory;
		const asks = entry.startsWith('ask ');
		const stale = entry.startsWith('stale ');
		const failure = entry.startsWith('failure ');
		const oldLoop = entry === 'old loop';
		const oldGoal = entry === 'old goal';
		const ownership =
			entry.startsWith('ownership ') || stale || failure || oldLoop || oldGoal;
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				requests++;
				return new Response(
					'data: {"choices":[{"delta":{"content":"new reply"}}]}\n\ndata: [DONE]\n\n',
					{
						headers: {'Content-Type': 'text/event-stream'},
					},
				);
			},
		});
		process.env.MOCK_URL = server.url.toString();
		const launchCwd = process.cwd();
		if (asks) saveSettings({...loadSettings(), resumeCwd: 'ask'});
		if (entry === 'CLI last' || asks || ownership || entry === 'loading input')
			process.env.NANOCODER_RESUME = 'last';
		else delete process.env.NANOCODER_RESUME;
		clearMessages();
		setBusy(false);
		setResumeOpen(false);
		setStartupLoading([]);
		setCompletionMessage('');
		setPendingTrust(null);
		const session: SessionData = {
			id: 'sess_delayed',
			name: 'Delayed conversation',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			firstMessage: 'restored prompt',
			messages: [
				{role: 'user', content: 'restored prompt'},
				{role: 'assistant', content: 'restored answer'},
			],
			context: [],
			...(oldGoal
				? {
						goal: {
							objective: 'Old goal must not follow resume',
							status: 'paused' as const,
							tokensUsed: 0,
							timeUsedSeconds: 0,
							createdAt: Date.now(),
							updatedAt: Date.now(),
						},
					}
				: {}),
			...(asks
				? {
						cwd: directory,
						provider: 'mock',
						model: 'mock-model-1',
						tasks: [
							{
								id: 'restored_task',
								title: 'Intended task',
								status: 'pending' as const,
							},
						],
					}
				: {}),
		};
		saveSession(session);
		const second = {...session, id: 'sess_second', name: 'Second conversation'};
		if (ownership) saveSession({...second, updatedAt: 1});
		let resolve!: (value: PreparedResume) => void;
		let settleMissing!: () => void;
		let reject!: (reason: Error) => void;
		const delayed = new Promise<PreparedResume | null>((yes, no) => {
			resolve = yes;
			settleMissing = () => yes(null);
			reject = no;
		});
		let started = false;
		let paintedBeforeIO = false;
		let signal: AbortSignal | undefined;
		let subsequentResolve!: (value: PreparedResume) => void;
		const subsequent = new Promise<PreparedResume>(yes => {
			subsequentResolve = yes;
		});
		let calls = 0;
		let ui: Awaited<ReturnType<typeof testRender>>;
		const text = () =>
			ui
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''))
				.join('\n');
		ui = await testRender(
			() => (
				<App
					resumeLoader={(_ref, _max, abortSignal) => {
						started = true;
						paintedBeforeIO = text().includes('Loading session');
						calls++;
						if (ownership && calls === 1)
							return Promise.resolve(prepareResume(session, 100));
						signal = abortSignal;
						return calls > 2 ? subsequent : delayed;
					}}
				/>
			),
			{width: 100, height: 35, kittyKeyboard: true},
		);
		try {
			await ui.flush();
			const waitFor = async (predicate: () => boolean) => {
				for (let i = 0; i < 100 && !predicate(); i++) {
					await Bun.sleep(10);
					await ui.flush();
				}
				expect(predicate()).toBe(true);
			};
			const command = async (value: string) => {
				setInput(value);
				ui.mockInput.pressEnter();
				await ui.flush();
			};
			if (entry === 'loading input') {
				await waitFor(() => started);
				await command('first draft while loading');
				expect(input()).toBe('first draft while loading');
				await command('second draft while loading');
				expect(input()).toBe('second draft while loading');
				await command('/workspace/image.png inspect after resume');
				expect(input()).toBe('/workspace/image.png inspect after resume');
				expect(steeringInbox()).toEqual([]);
				expect(requests).toBe(0);
				resolve(prepareResume(session, 100));
				await waitFor(() => sessionId() === session.id);
				expect(input()).toBe('/workspace/image.png inspect after resume');
				ui.mockInput.pressEnter();
				await ui.flush();
				await waitFor(() => requests === 1);
				expect(
					messages().filter(
						message =>
							message.content === '/workspace/image.png inspect after resume',
					),
				).toHaveLength(1);
				return;
			}
			if (ownership) {
				await waitFor(() => sessionId() === session.id);
				await waitFor(() => !text().includes('Loading skills'));
				if (oldLoop) {
					await command('/loop @every 1s old-loop-prompt');
				}
				const path = join(directory, 'sessions', `${session.id}.json`);
				await command('/resume sess_second');
				await waitFor(() => calls === 2);
				const snapshot = readFileSync(path, 'utf8');
				const saved = JSON.parse(snapshot) as SessionData;
				expect(saved.messages[0]?.content).toBe('restored prompt');
				expect(saved.messages[1]?.content).toBe('restored answer');
				expect(saved.context.at(-1)?.content).toBe('restored answer');
				if (oldGoal) {
					await command('/goal');
					expect(
						messages().some(message =>
							message.content.includes('No goal is currently set'),
						),
					).toBe(true);
					return;
				}
				if (failure) {
					if (entry === 'failure missing') settleMissing();
					else reject(new Error('Controlled worker failure'));
					await waitFor(() =>
						messages().some(message =>
							message.content.includes(
								entry === 'failure missing'
									? 'No session found'
									: 'Could not resume',
							),
						),
					);
					await ui.flush();
					expect(
						messages().some(message =>
							message.content.includes(
								entry === 'failure missing'
									? 'Use /resume'
									: 'use /resume to retry',
							),
						),
					).toBe(true);
					await command('new saved chat');
					await waitFor(() =>
						messages().some(message => message.content === 'new saved chat'),
					);
					await command('/rename recovered-chat');
					const savedChats = readdirSync(join(directory, 'sessions')).map(
						file =>
							JSON.parse(
								readFileSync(join(directory, 'sessions', file), 'utf8'),
							) as SessionData,
					);
					expect(
						savedChats.some(
							chat =>
								chat.id !== session.id &&
								chat.id !== second.id &&
								chat.messages.some(
									message => message.content === 'new saved chat',
								),
						),
					).toBe(true);
					expect(readFileSync(path, 'utf8')).toBe(snapshot);
					return;
				}
				if (oldLoop) {
					await Bun.sleep(1250);
					await ui.flush();
					expect(pendingQueue().some(item => item.source === 'loop')).toBe(
						false,
					);
					expect(
						messages().some(message =>
							message.content.includes('old-loop-prompt'),
						),
					).toBe(false);
					await command('/loop');
					expect(text()).toContain('No thread jobs are scheduled');
					return;
				}
				if (stale) {
					await command('must-not-move');
					expect(input()).toBe('must-not-move');
					expect(steeringInbox()).toEqual([]);
					expect(text()).toContain('Your draft is retained');
					const requestCount = requests;
					await command(
						entry === 'stale clear' ? '/clear' : '/resume sess_delayed',
					);
					if (entry === 'stale resume') {
						await waitFor(() => calls === 3);
						subsequentResolve(prepareResume(session, 100));
						await waitFor(
							() =>
								sessionId() === session.id &&
								!text().includes('Loading session'),
						);
					}
					resolve(prepareResume(second, 100));
					await Bun.sleep(100);
					await ui.flush();
					expect(
						messages().some(message => message.content === 'must-not-move'),
					).toBe(false);
					expect(requests).toBe(requestCount);
					return;
				}
				await command('/status');
				expect(readFileSync(path, 'utf8')).toBe(snapshot);
				ui.mockInput.pressEscape();
				await ui.flush();
				await command('/rename loading-name');
				expect(readFileSync(path, 'utf8')).toBe(snapshot);
				const cancelled = signal!;
				await command(
					entry === 'ownership clear' ? '/clear' : '/resume sess_delayed',
				);
				expect(cancelled.aborted).toBe(true);
				expect(readFileSync(path, 'utf8')).toBe(snapshot);
				resolve(prepareResume(second, 100));
				await Bun.sleep(20);
				await ui.flush();
				expect(sessionId()).not.toBe(second.id);
				if (entry === 'ownership resume') {
					await waitFor(() => calls === 3);
					subsequentResolve(prepareResume(session, 100));
					await waitFor(() => sessionId() === session.id);
				} else expect(sessionName()).toBe('New conversation');
				expect(readFileSync(path, 'utf8')).toBe(snapshot);
				return;
			}
			if (entry === 'picker selection') {
				setResumeOpen(true);
				for (let i = 0; i < 100 && !text().includes('sess_delayed'); i++) {
					await Bun.sleep(10);
					await ui.flush();
				}
				expect(text()).toContain('sess_delayed');
				ui.mockInput.pressEnter();
				await ui.flush();
			}
			expect(text()).toContain('Loading session');
			expect(started).toBe(true);
			expect(paintedBeforeIO).toBe(true);
			await Bun.sleep(40);
			await ui.flush();
			expect(text()).toContain('Loading session');
			expect(text()).not.toContain('restored answer');
			resolve(prepareResume(session, 100));
			if (asks) {
				await waitFor(() => Boolean(pendingPrompt()));
				expect(text()).toContain('Loading session');
				if (entry === 'ask Escape') ui.mockInput.pressEscape();
				else {
					setInput(entry === 'ask yes' ? 'yes' : 'no');
					ui.mockInput.pressEnter();
				}
				await waitFor(() => sessionId() === session.id);
				expect(sessionName()).toBe(session.name);
				expect(tasks()[0]?.id).toBe('restored_task');
				expect(activeEndpoint().model).toBe('mock-model-1');
				expect(context().at(-1)?.content).toBe('restored answer');
				expect(process.cwd()).toBe(entry === 'ask yes' ? directory : launchCwd);
				await command('/rename restored-name');
				expect(
					JSON.parse(
						readFileSync(
							join(directory, 'sessions', `${session.id}.json`),
							'utf8',
						),
					).name,
				).toBe('restored-name');
			}
			for (let i = 0; i < 100 && !text().includes('restored answer'); i++) {
				await Bun.sleep(10);
				await ui.flush();
			}
			expect(text()).toContain('restored answer');
			expect(text()).not.toContain('Loading session');
		} finally {
			ui.renderer.destroy();
			server.stop(true);
			process.chdir(launchCwd);
			const previous = {
				BOBONYO_CONFIG_DIR: env.config,
				BOBONYO_DATA_DIR: env.data,
				NANOCODER_DATA_DIR: env.legacy,
				NANOCODER_RESUME: env.resume,
				MOCK_URL: env.mock,
			};
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(directory, {recursive: true, force: true});
			clearMessages();
			setResumeOpen(false);
			setStartupLoading([]);
			setCompletionMessage('');
		}
	});
}
