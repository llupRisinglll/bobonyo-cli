import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	activeAgentRuns,
	activeEndpoint,
	messages,
	setMessages,
	setActiveAgentRuns,
	setActiveEndpoint,
	type ActiveAgentRun,
} from './state';
import {executeTool, isReadOnlyTool, toolCatalogForModel} from './tools';
import {
	formatSubagentResults,
	MAX_SUBAGENT_ARCHIVE_READ_BYTES,
	loadSubagentResults,
	saveSubagentResult,
	subagentResultText,
	archiveSubagentResponse,
} from './subagent-results';

const verdict = `Review completed.\n${'Evidence beyond the diagnostic log cap. '.repeat(80)}\nREVIEW_PASSED: exact final lens verdict`;
function run(id = 'review:security:1'): ActiveAgentRun {
	return {
		id,
		name: 'review-security',
		description: 'Review security lens',
		status: 'completed',
		output: 'Review completed.',
		transcript: ['Review completed.'],
		streaming: '',
		history: [{role: 'assistant', content: verdict}],
		retrieved: true,
	};
}
const call = (
	name: string,
	args: Record<string, unknown> = {},
	sessionId = 'session-a',
) =>
	executeTool(
		{
			id: 'retrieve-test',
			name,
			arguments: args,
			rawArguments: JSON.stringify(args),
		},
		{sessionId},
	);

describe('durable subagent response retrieval', () => {
	let root: string;
	let previousData: string | undefined;
	let previousConfig: string | undefined;
	let previousRuns: ActiveAgentRun[];
	let previousCwd: string;
	let previousMessages: ReturnType<typeof messages>;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'bobonyo-agent-results-'));
		previousData = process.env.BOBONYO_DATA_DIR;
		previousConfig = process.env.BOBONYO_CONFIG_DIR;
		previousRuns = activeAgentRuns();
		previousMessages = messages();
		previousCwd = process.cwd();
		process.env.BOBONYO_DATA_DIR = join(root, 'data');
		process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
		process.chdir(root);
		setActiveAgentRuns([]);
	});
	afterEach(() => {
		process.chdir(previousCwd);
		setActiveAgentRuns(previousRuns);
		setMessages(previousMessages);
		if (previousData === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previousData;
		if (previousConfig === undefined) delete process.env.BOBONYO_CONFIG_DIR;
		else process.env.BOBONYO_CONFIG_DIR = previousConfig;
		rmSync(root, {recursive: true, force: true});
	});

	test('status and wait return full restored final response, not its first-line tail', async () => {
		setActiveAgentRuns(JSON.parse(JSON.stringify([run()])));
		for (const name of ['agent_status', 'agent_wait', 'agent_history']) {
			const result = await call(name, {agent_id: run().id});
			expect(result.content).toContain(verdict);
		}
	});

	test('status list bounds summaries and does not mark unreturned verdicts retrieved', async () => {
		setActiveAgentRuns(
			Array.from({length: 25}, (_, index) => ({
				...run(`review-${index}`),
				description: 'Long task description. '.repeat(200),
				output: verdict,
				retrieved: false,
			})),
		);
		const result = await call('agent_status');
		expect(result.content).toContain('Showing latest 20 of 25 agents.');
		expect(result.content).toContain('agent_history');
		expect(result.content).not.toContain('exact final lens verdict');
		expect(result.content).not.toContain('review-0 ·');
		expect(result.content.length).toBeLessThan(12000);
		expect(activeAgentRuns().every(agent => agent.retrieved === false)).toBe(
			true,
		);
		expect(
			(await call('agent_status', {agent_id: 'review-24'})).content,
		).toContain(verdict);
		expect(activeAgentRuns().at(-1)?.retrieved).toBe(true);
	});

	test('failed archive writes preserve completed and incomplete outputs with explicit warning', () => {
		mkdirSync(join(root, 'data'), {recursive: true});
		writeFileSync(join(root, 'data', 'subagent-results'), 'not a directory');
		for (const status of ['completed', 'incomplete'] as const) {
			const output = archiveSubagentResponse('session-a', {
				...run(),
				status,
				output: verdict,
			});
			expect(output).toStartWith(verdict);
			expect(output).toContain('Subagent archive failed:');
			expect(output).toContain('durable archival was not confirmed');
		}
	});

	test('history discovers old agents and preserves successive responses after pruning', async () => {
		for (let i = 0; i < 25; i++)
			saveSubagentResult('session-a', {
				...run(`review-${i}`),
				output: `REVIEW_PASSED ${i}`,
			});
		saveSubagentResult('session-a', {
			...run('review-0'),
			output: 'REVIEW_FINDINGS: subsequent revision',
		});
		saveSubagentResult('session-b', {
			...run('private-other-session'),
			output: 'Other session verdict',
		});
		const listed = await call('agent_history');
		expect(listed.content).toContain('review-0');
		expect(listed.content).toContain('review-24');
		expect(listed.content).not.toContain('private-other-session');
		const retrieved = await call('agent_history', {agent_id: 'review-0'});
		expect(retrieved.content).toContain('REVIEW_PASSED 0');
		expect(retrieved.content).toContain('REVIEW_FINDINGS: subsequent revision');
		expect(activeAgentRuns()).toEqual([]);
	});

	test('reads legacy session child history even when live cache omits that agent', async () => {
		mkdirSync(join(root, 'data', 'sessions'), {recursive: true});
		writeFileSync(
			join(root, 'data', 'sessions', 'session-a.json'),
			JSON.stringify({subagentRuns: [run()]}),
		);
		const result = await call('agent_history', {agent_id: run().id});
		expect(result.content).toContain(verdict);
		expect(
			(await call('agent_history', {agent_id: run().id}, 'session-b')).content,
		).not.toContain(verdict);
	});

	test('deduplicates live and archived responses and ignores torn final append', () => {
		saveSubagentResult('session-a', {...run(), output: verdict});
		appendFileSync(
			join(root, 'data', 'subagent-results', 'session-a.jsonl'),
			'{"id":',
		);
		expect(loadSubagentResults('session-a', [run()])).toHaveLength(1);
		saveSubagentResult('session-a', {
			...run('after-torn-append'),
			output: 'REVIEW_PASSED after restart',
		});
		expect(loadSubagentResults('session-a', [])).toHaveLength(2);
	});

	test('archive stores only response fields with owner-only permissions', () => {
		const path = join(root, 'data', 'subagent-results', 'session-a.jsonl');
		saveSubagentResult('session-a', {...run(), output: verdict});
		chmodSync(path, 0o644);
		saveSubagentResult('session-a', {...run(), output: verdict});
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, 'data', 'subagent-results')).mode & 0o777).toBe(
			0o700,
		);
		const stored = JSON.parse(
			readFileSync(path, 'utf8').trim().split('\n')[0]!,
		);
		expect(Object.keys(stored).sort()).toEqual([
			'description',
			'id',
			'name',
			'output',
			'status',
		]);
		expect(stored.output).toBe(verdict);
	});

	test('encoded session ids cannot escape archive or collide', () => {
		saveSubagentResult('../escape', {...run(), output: 'first'});
		saveSubagentResult('..%2Fescape', {...run(), output: 'second'});
		expect(loadSubagentResults('../escape', [])[0]?.output).toBe('first');
		expect(loadSubagentResults('..%2Fescape', [])[0]?.output).toBe('second');
		expect(existsSync(join(root, 'data', 'escape.jsonl'))).toBe(false);
	});

	test('archive refuses symlink targets on read and write', () => {
		const outside = join(root, 'private.txt');
		writeFileSync(outside, 'private');
		mkdirSync(join(root, 'data', 'subagent-results'), {recursive: true});
		symlinkSync(
			outside,
			join(root, 'data', 'subagent-results', 'session-a.jsonl'),
		);
		expect(() => loadSubagentResults('session-a', [])).toThrow();
		expect(() => saveSubagentResult('session-a', run())).toThrow();
		expect(readFileSync(outside, 'utf8')).toBe('private');
	});

	test('oversized archives fail explicitly without deleting evidence', async () => {
		saveSubagentResult('session-a', run());
		const path = join(root, 'data', 'subagent-results', 'session-a.jsonl');
		truncateSync(path, MAX_SUBAGENT_ARCHIVE_READ_BYTES + 1);
		expect((await call('agent_history')).content).toContain(
			'No records were deleted',
		);
		expect(statSync(path).size).toBe(MAX_SUBAGENT_ARCHIVE_READ_BYTES + 1);
		setActiveAgentRuns([run()]);
		const recovered = await call('agent_history', {agent_id: run().id});
		expect(recovered.content).toContain(verdict);
		expect(recovered.content).toContain('Subagent history source unavailable:');
	});

	test('missing session context never reads the durable archive', () => {
		saveSubagentResult('session-a', run());
		expect(loadSubagentResults(undefined, [])).toEqual([]);
	});

	test('pagination clamps bounds and handles offsets beyond the response', () => {
		const records = [{...run(), output: 'x'.repeat(30000)}];
		expect(
			formatSubagentResults(records, run().id, 0, 100000).split(
				'\n[More saved responses:',
			)[0],
		).toHaveLength(24000);
		expect(formatSubagentResults(records, run().id, -5, 100)).toBe(
			formatSubagentResults(records, run().id, 0, 100),
		);
		expect(formatSubagentResults(records, run().id, 100000)).toBe('');
	});

	test('paginates every character of a long single-line response', () => {
		const records = [{...run(), output: 'x'.repeat(30000) + 'FINAL_VERDICT'}];
		const expected = `${run().id} · completed · agent:review-security(Review security lens)\n${records[0]!.output}`;
		let reconstructed = '';
		for (let offset = 0; offset < expected.length; offset += 1000) {
			reconstructed += formatSubagentResults(
				records,
				run().id,
				offset,
				1000,
			).split('\n[More saved responses:')[0];
		}
		expect(reconstructed).toBe(expected);
	});

	test('running and cancelled agents never claim an earlier final answer as current', () => {
		for (const status of ['running', 'cancelled', 'error'] as const) {
			expect(
				subagentResultText({...run(), status, output: 'Interrupted follow-up'}),
			).toBe('Interrupted follow-up');
		}
	});

	test('history is advertised as read-only recovery without rerunning review', () => {
		const entry = toolCatalogForModel('gpt-5.5').find(
			tool => tool.name === 'agent_history',
		);
		expect(entry?.description).toContain('without rerunning');
		expect(entry?.description).toContain(
			'not proof that the current diff passes',
		);
		expect(isReadOnlyTool('agent_history')).toBe(true);
	});

	test.each([false, true])(
		'real review completion preserves mocked response with archive failure=%s',
		async archiveFails => {
			const previousFetch = globalThis.fetch;
			const previousEndpoint = activeEndpoint();
			const agents = join(root, 'config', 'agents');
			mkdirSync(agents, {recursive: true});
			writeFileSync(
				join(agents, 'review-retrieval-test.md'),
				'---\nname: review-retrieval-test\ndescription: Retrieval regression lens\n---\nRead only.',
			);
			globalThis.fetch = (async () =>
				new Response(
					`data: ${JSON.stringify({choices: [{delta: {content: verdict}, finish_reason: null}]})}\n\ndata: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`,
					{headers: {'content-type': 'text/event-stream'}},
				)) as unknown as typeof fetch;
			setActiveEndpoint({
				...previousEndpoint,
				id: 'retrieval-test',
				baseUrl: 'http://127.0.0.1:1',
				apiKey: 'test',
				model: 'retrieval-test',
				sdkProvider: undefined,
				codexAccount: undefined,
			});
			try {
				if (archiveFails) {
					mkdirSync(join(root, 'data'), {recursive: true});
					writeFileSync(
						join(root, 'data', 'subagent-results'),
						'not a directory',
					);
				}
				const sessionId = `integration-${root.split('/').at(-1)}`;
				const result = await call(
					'review_changes',
					{reviewers: ['review-retrieval-test']},
					sessionId,
				);
				expect(result.content).toContain(verdict);
				const id = activeAgentRuns()[0]!.id;
				expect(activeAgentRuns()[0]!.status).toBe('completed');
				if (archiveFails) {
					expect(result.content).toContain('Subagent archive failed:');
					expect(result.content).not.toContain('REVIEW_ERROR:');
					for (const name of ['agent_status', 'agent_wait', 'agent_history']) {
						const recovered = await call(name, {agent_id: id}, sessionId);
						expect(recovered.content).toContain(verdict);
						expect(recovered.content).toContain('Subagent archive failed:');
					}
					return;
				}
				expect(activeAgentRuns()[0]!.output).not.toContain(
					'exact final lens verdict',
				);
				setActiveAgentRuns([]);
				expect(
					(await call('agent_history', {agent_id: id}, sessionId)).content,
				).toContain(verdict);
				expect(
					readFileSync(
						join(root, 'data', 'subagent-results', `${sessionId}.jsonl`),
						'utf8',
					),
				).toContain('REVIEW_PASSED');
			} finally {
				globalThis.fetch = previousFetch;
				setActiveEndpoint(previousEndpoint);
			}
		},
	);
});
