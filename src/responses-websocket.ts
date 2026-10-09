import type {StreamHandlers, TurnResult, MockToolCall} from './client';

/** Ownership may have transferred: never automatically reconnect or replay. */
export class ResponsesWebSocketError extends Error {
	constructor(
		message: string,
		override readonly cause?: unknown,
	) {
		super(message);
		this.name = 'ResponsesWebSocketError';
	}
}

export interface SteeringSubmission {
	id: number;
	input: string;
	previousResponseId: string;
	steerId?: string;
	status: 'sent' | 'accepted' | 'applied' | 'failed' | 'uncertain';
	successorResponseId?: string;
}

export interface ResponsesSteeringController {
	/** False before response.created or after transport termination. */
	submit(input: string): SteeringSubmission | false;
	snapshot(): SteeringSubmission[];
}

export interface RequiredResponsesInput {
	result: TurnResult;
	responseId: string;
	toolCalls: MockToolCall[];
	requiredInput: Array<Record<string, unknown>>;
}

export interface ResponsesSocket {
	addEventListener(type: string, listener: (event: any) => void): void;
	removeEventListener(type: string, listener: (event: any) => void): void;
	send(data: string): void;
	close(): void;
}

export interface ResponsesWebSocketOptions {
	enabled: true;
	register(controller: ResponsesSteeringController | undefined): void;
	onSteeringChange?: (submission: SteeringSubmission) => void;
	onResponseCreated?: (responseId: string) => void;
	/** Persist a non-tool parent before its successor, not as part of final text. */
	onIntermediateResponse?: (result: TurnResult) => void;
	/** Invalidate local tool dispatch synchronously before releasing ownership. */
	onTransportFailure?: () => void;
	/** Return matching incremental outputs/approvals, never history or steers. */
	onRequiredInput?: (
		request: RequiredResponsesInput,
	) => Promise<Array<Record<string, unknown>>>;
	/** Test injection, not a capability override. */
	createSocket?: (
		url: string,
		headers: Record<string, string>,
	) => ResponsesSocket;
}

export function supportsResponsesSteering(endpoint: {
	baseUrl: string;
	model: string;
	codexAccount?: boolean;
	sdkProvider?: string;
}): boolean {
	try {
		const url = new URL(endpoint.baseUrl);
		return (
			endpoint.sdkProvider === 'responses' &&
			!endpoint.codexAccount &&
			url.protocol === 'https:' &&
			url.hostname === 'api.openai.com' &&
			['/', '/v1', '/v1/'].includes(url.pathname) &&
			/^gpt-6(?:\.\d+)?(?:-|$)/.test(endpoint.model)
		);
	} catch {
		return false;
	}
}

type Wire = Record<string, any>;

function parseCall(item: Wire): MockToolCall {
	let args: Record<string, unknown> = {};
	try {
		args = JSON.parse(item.arguments || '{}');
	} catch {
		args = {_malformed: item.arguments || ''};
	}
	return {
		id: item.call_id,
		name: item.name,
		rawArguments: item.arguments || '',
		arguments: args,
	};
}

function addUsage(total: Wire, usage: Wire): void {
	for (const [key, value] of Object.entries(usage)) {
		if (typeof value === 'number') {
			total[key] = (total[key] ?? 0) + value;
		} else if (value && typeof value === 'object' && !Array.isArray(value)) {
			addUsage((total[key] ??= {}), value);
		}
	}
}

/** One ordered lane: includes automatic steering and explicit tool continuations. */
export function streamResponsesWebSocket(
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	handlers: StreamHandlers,
	options: ResponsesWebSocketOptions,
	signal?: AbortSignal,
	guard = {
		maxOutputChars: 1_000_000,
		maxDurationMs: 600_000,
		stallTimeoutMs: 60_000,
	},
): Promise<TurnResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
			return;
		}
		let socket: ResponsesSocket;
		try {
			// Bun supports auth headers; DOM declarations expose browser overloads.
			const NativeSocket = WebSocket as unknown as new (
				url: string,
				options: {headers: Record<string, string>},
			) => ResponsesSocket;
			socket =
				options.createSocket?.(url, headers) ??
				new NativeSocket(url, {headers});
		} catch (error) {
			reject(
				new ResponsesWebSocketError(
					'WebSocket connection failed; no automatic replay.',
					error,
				),
			);
			return;
		}
		let ended = false;
		let currentId = '';
		let text = '';
		let reasoning = '';
		let outputChars = 0;
		let nextSubmission = 1;
		let awaitingTools = false;
		let toolWork: Promise<void> | undefined;
		const submissions: SteeringSubmission[] = [];
		const completed = new Set<string>();
		const continued = new Set<string>();
		const successors = new Map<string, string>();
		let parentSegment: TurnResult | undefined;
		const handledCalls = new Set<string>();
		const items = new Map<string, Wire>();
		const usage: Wire = {};
		let stall: ReturnType<typeof setTimeout>;
		const duration = setTimeout(
			() => fail('Responses WebSocket duration limit exceeded.'),
			guard.maxDurationMs,
		);
		const notify = (entry: SteeringSubmission) =>
			options.onSteeringChange?.({...entry});
		const pending = () =>
			submissions.some(s => s.status === 'sent' || s.status === 'accepted');
		const cleanup = () => {
			clearTimeout(stall);
			clearTimeout(duration);
			signal?.removeEventListener('abort', abort);
			for (const [type, handler] of listeners)
				socket.removeEventListener(type, handler);
			try {
				options.register(undefined);
			} catch {}
			try {
				socket.close();
			} catch {}
		};
		const markUncertain = () => {
			for (const s of submissions) {
				if (s.status !== 'sent' && s.status !== 'accepted') continue;
				s.status = 'uncertain';
				try {
					notify(s);
				} catch {}
			}
		};
		const fail = (message: string, cause?: unknown) => {
			if (ended) return;
			ended = true;
			try {
				options.onTransportFailure?.();
			} catch {}
			markUncertain();
			cleanup();
			// Keep foreground ownership until dispatched local work has unwound and
			// persisted completed results. New turns must not race that cleanup.
			if (toolWork) {
				void toolWork.finally(() =>
					reject(new ResponsesWebSocketError(message, cause)),
				);
			} else {
				reject(new ResponsesWebSocketError(message, cause));
			}
		};
		const abort = () => {
			if (ended) return;
			ended = true;
			markUncertain();
			cleanup();
			const reason =
				signal?.reason ?? new DOMException('Aborted', 'AbortError');
			if (toolWork) {
				void toolWork.then(
					() => reject(reason),
					() => reject(reason),
				);
			} else {
				reject(reason);
			}
		};
		const touch = () => {
			clearTimeout(stall);
			if (awaitingTools) return;
			stall = setTimeout(
				() =>
					fail(
						'WebSocket stalled; ownership is uncertain, automatic replay skipped.',
					),
				guard.stallTimeoutMs,
			);
		};
		const send = (payload: Wire) => {
			try {
				socket.send(JSON.stringify(payload));
			} catch (error) {
				fail('WebSocket send failed; ownership is uncertain.', error);
			}
		};
		const settings = {...body};
		delete settings.stream;
		delete settings.background;
		delete settings.input;
		delete settings.previous_response_id;
		const controller: ResponsesSteeringController = {
			snapshot: () => submissions.map(s => ({...s})),
			submit: input => {
				if (ended || !currentId || !input.trim()) return false;
				const entry: SteeringSubmission = {
					id: nextSubmission++,
					input,
					previousResponseId: currentId,
					status: 'sent',
				};
				submissions.push(entry);
				send({type: 'response.steer', previous_response_id: currentId, input});
				if (!ended) notify(entry);
				return {...entry};
			},
		};
		async function continueTools(
			responseId: string,
			output: Wire[],
			required: Wire[],
		) {
			if (continued.has(responseId)) return;
			const calls = output
				.filter(
					item =>
						item.type === 'function_call' && !handledCalls.has(item.call_id),
				)
				.map(parseCall);
			if (!calls.length && !required.length) return;
			if (!options.onRequiredInput)
				throw new Error('Continuation requires a tool/approval handler.');
			continued.add(responseId);
			awaitingTools = true;
			for (const call of calls) handledCalls.add(call.id);
			clearTimeout(stall);
			if (!required.length) {
				required = calls.map(call => ({
					type: 'function_call_output',
					call_id: call.id,
				}));
			}
			const input = await options.onRequiredInput({
				result: {text, reasoning, toolCalls: calls, finishReason: 'tool_calls'},
				responseId,
				toolCalls: calls,
				requiredInput: required,
			});
			if (ended) return;
			awaitingTools = false;
			const expected = required;
			if (
				!Array.isArray(input) ||
				input.length !== expected.length ||
				expected.some(
					item =>
						input.filter(
							result =>
								result.type === item.type &&
								(item.call_id
									? result.call_id === item.call_id
									: result.approval_request_id === item.approval_request_id),
						).length !== 1,
				)
			)
				throw new Error(
					'Tool/approval results do not match required Responses input.',
				);
			touch();
			send({
				...settings,
				type: 'response.create',
				previous_response_id: responseId,
				input,
			});
		}
		function receive(event: Wire) {
			if (ended) return;
			touch();
			if (event.type === 'message') event = event.message;
			if (!event || typeof event.type !== 'string')
				throw new Error('Malformed WebSocket event.');
			const response = event.response;
			if (event.type === 'response.created') {
				if (!response?.id || typeof response.id !== 'string')
					throw new Error('response.created missing id.');
				if (response.id !== currentId) {
					if (awaitingTools)
						throw new Error(
							'Successor arrived before tool input was returned.',
						);
					if (parentSegment) {
						options.onIntermediateResponse?.(parentSegment);
						parentSegment = undefined;
						text = '';
						reasoning = '';
					}
					const previousId = currentId;
					if (
						previousId &&
						(!response.previous_response_id ||
							response.previous_response_id === previousId)
					) {
						successors.set(previousId, response.id);
					}
					currentId = response.id;
					items.clear();
					for (const entry of submissions) {
						if (
							entry.status !== 'accepted' ||
							entry.previousResponseId !== previousId ||
							successors.get(previousId) !== response.id
						)
							continue;
						entry.status = 'applied';
						entry.successorResponseId = response.id;
						notify(entry);
					}
				}
				options.onResponseCreated?.(currentId);
				return;
			}
			if (event.type.startsWith('response.steer.')) {
				const steer = event.steer;
				if (
					!steer?.previous_response_id ||
					(!steer.id && event.type !== 'response.steer.failed')
				)
					throw new Error('Malformed steering acknowledgement.');
				const entry =
					(steer.id
						? submissions.find(s => s.steerId === steer.id)
						: undefined) ??
					submissions.find(
						s =>
							s.status === 'sent' &&
							s.previousResponseId === steer.previous_response_id &&
							(event.type !== 'response.steer.failed' ||
								!steer.input ||
								s.input === steer.input),
					);
				if (!entry) throw new Error('Unmatched steering acknowledgement.');
				entry.steerId = steer.id;
				if (event.type === 'response.steer.accepted') {
					if (entry.status === 'sent') entry.status = 'accepted';
					notify(entry);
					const successor = successors.get(entry.previousResponseId);
					if (entry.status === 'accepted' && successor) {
						entry.status = 'applied';
						entry.successorResponseId = successor;
						notify(entry);
					}
				}
				if (event.type === 'response.steer.failed') {
					entry.status = 'failed';
					notify(entry);
					throw new Error(
						event.error?.message ??
							'Native steering failed; input was not replayed.',
					);
				}
				if (event.type === 'response.steer.pending') {
					if (
						!Array.isArray(event.required_input) ||
						!event.required_input.length
					)
						throw new Error('Malformed required steering input.');
					if (!continued.has(steer.previous_response_id))
						toolWork = continueTools(
							steer.previous_response_id,
							[...items.values()],
							event.required_input,
						).catch(error => fail(error.message, error));
				}
				return;
			}
			if (event.type === 'error' || event.type === 'response.failed') {
				throw new Error(
					event.error?.message ??
						response?.error?.message ??
						'Responses WebSocket error.',
				);
			}
			if (
				event.type === 'response.output_text.delta' ||
				event.type === 'response.content_part.delta'
			) {
				const delta =
					typeof event.delta === 'string' ? event.delta : event.delta?.text;
				if (typeof delta !== 'string') throw new Error('Malformed text delta.');
				text += delta;
				outputChars += delta.length;
				if (outputChars > guard.maxOutputChars)
					throw new Error('Responses output limit exceeded.');
				handlers.onText(delta);
			}
			if (event.type === 'response.reasoning_summary_text.delta') {
				if (typeof event.delta !== 'string')
					throw new Error('Malformed reasoning delta.');
				reasoning += event.delta;
				outputChars += event.delta.length;
				if (outputChars > guard.maxOutputChars)
					throw new Error('Responses output limit exceeded.');
				handlers.onReasoning(event.delta);
			}
			if (
				event.type === 'response.output_item.added' &&
				event.item?.type === 'reasoning'
			)
				handlers.onReasoningStart?.();
			if (event.type === 'response.output_item.done') {
				const item = event.item;
				if (item?.type === 'function_call') items.set(item.call_id, item);
				if (item?.type === 'web_search_call' && !items.has(item.id)) {
					items.set(item.id, item);
					handlers.onWebSearch?.(item.action);
				}
			}
			if (
				event.type === 'response.completed' ||
				event.type === 'response.incomplete'
			) {
				if (response?.id && completed.has(response.id)) return;
				if (!response?.id || response.id !== currentId)
					throw new Error('Unexpected terminal response id.');
				completed.add(response.id);
				if (response.usage) addUsage(usage, response.usage);
				if (
					event.type === 'response.incomplete' &&
					response.incomplete_details?.reason !== 'steered'
				) {
					throw new Error(
						`Incomplete response: ${response.incomplete_details?.reason ?? 'unknown'}`,
					);
				}
				const output = response.output ?? [...items.values()];
				if (!Array.isArray(output))
					throw new Error('Malformed response output.');
				if (
					output.some(
						item =>
							item.type === 'function_call' ||
							item.type === 'mcp_approval_request',
					)
				) {
					const required: Wire[] = output
						.filter(item => item.type === 'mcp_approval_request')
						.map(item => ({
							type: 'mcp_approval_response',
							approval_request_id: item.id,
						}));
					if (required.length) {
						for (const item of output) {
							if (item.type === 'function_call')
								required.push({
									type: 'function_call_output',
									call_id: item.call_id,
								});
						}
					}
					toolWork = continueTools(response.id, output, required).catch(error =>
						fail(error.message, error),
					);
					text = '';
					reasoning = '';
					return;
				}
				if (pending() || event.type === 'response.incomplete') {
					parentSegment = {
						text,
						reasoning,
						toolCalls: [],
						finishReason: 'stop',
					};
					return;
				}
				ended = true;
				cleanup();
				resolve({
					text,
					reasoning,
					toolCalls: [],
					finishReason: 'stop',
					...(Object.keys(usage).length ? {usage} : {}),
				});
			}
		}
		const message = (event: {data: unknown}) => {
			let parsed: Wire;
			try {
				parsed = JSON.parse(
					typeof event.data === 'string'
						? event.data
						: new TextDecoder().decode(event.data as ArrayBuffer),
				);
			} catch (error) {
				fail('Malformed Responses WebSocket JSON.', error);
				return;
			}
			try {
				receive(parsed);
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error), error);
			}
		};
		const open = () =>
			send({...settings, type: 'response.create', input: body.input});
		const close = () =>
			fail(
				'WebSocket disconnected; ownership is uncertain, automatic replay skipped.',
			);
		const error = () =>
			fail('Responses WebSocket failed; automatic replay skipped.');
		const listeners: Array<[string, (event: any) => void]> = [
			['open', open],
			['message', message],
			['close', close],
			['error', error],
		];
		for (const [type, handler] of listeners)
			socket.addEventListener(type, handler);
		signal?.addEventListener('abort', abort, {once: true});
		touch();
		try {
			options.register(controller);
		} catch (error) {
			fail('Steering registration failed.', error);
		}
	});
}
