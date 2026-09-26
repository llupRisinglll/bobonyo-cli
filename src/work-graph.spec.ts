import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	addWorkEdge,
	consolidationInput,
	createWorkGraph,
	getWorkGraph,
	requiredNodesSettled,
	findResearchMemory,
	recordWorkEvent,
	saveResearchMemory,
	upsertWorkNode,
} from './work-graph';

const originalDataDir = process.env.BOBONYO_DATA_DIR;
let testDataDir = '';

beforeAll(() => {
	testDataDir = mkdtempSync(join(tmpdir(), 'bobonyo-work-graph-'));
	process.env.BOBONYO_DATA_DIR = testDataDir;
});

afterAll(() => {
	if (originalDataDir === undefined) delete process.env.BOBONYO_DATA_DIR;
	else process.env.BOBONYO_DATA_DIR = originalDataDir;
	rmSync(testDataDir, {recursive: true, force: true});
});

describe('work graph persistence', () => {
	test('deduplicates events and stores reusable research findings', () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const graph = `test-graph-${suffix}`;
		const node = `test-node-${suffix}`;
		createWorkGraph(graph, 'test-session', 'test graph');
		upsertWorkNode({
			id: node,
			graphId: graph,
			kind: 'research',
			status: 'completed',
			title: 'inspect lifecycle',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		addWorkEdge(node, node, 'derived_from');
		expect(recordWorkEvent('event-' + suffix, graph, 'finished', node)).toBe(
			true,
		);
		expect(recordWorkEvent('event-' + suffix, graph, 'finished', node)).toBe(
			false,
		);
		saveResearchMemory({
			id: `memory-${suffix}`,
			scope: 'project',
			key: `subagents:${suffix}`,
			text: 'Agent completion requires a barrier.',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		expect(
			findResearchMemory('project', `subagents:${suffix}`)?.text,
		).toContain('barrier');
	});

	test('waits for every dependency and consolidates results deterministically', () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const graph = `barrier-graph-${suffix}`;
		const first = `research-a-${suffix}`;
		const second = `research-b-${suffix}`;
		const decision = `decision-${suffix}`;
		createWorkGraph(graph, 'test-session', 'barrier graph');
		for (const [id, result] of [
			[first, 'first result'],
			[second, 'second result'],
		] as const) {
			upsertWorkNode({
				id,
				graphId: graph,
				kind: 'research',
				status: 'running',
				title: id,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			void result;
		}
		upsertWorkNode({
			id: decision,
			graphId: graph,
			kind: 'decision',
			status: 'waiting',
			title: 'consolidate',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		addWorkEdge(first, decision);
		addWorkEdge(second, decision);
		expect(requiredNodesSettled(graph, decision)).toBe(false);
		upsertWorkNode({
			id: first,
			graphId: graph,
			kind: 'research',
			status: 'completed',
			title: first,
			result: 'first result',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		expect(requiredNodesSettled(graph, decision)).toBe(false);
		upsertWorkNode({
			id: second,
			graphId: graph,
			kind: 'research',
			status: 'failed',
			title: second,
			result: 'second failed',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		expect(requiredNodesSettled(graph, decision)).toBe(true);
		expect(
			consolidationInput(graph, decision).map(item => item.nodeId),
		).toEqual([first, second].sort());
		expect(getWorkGraph(graph).nodes).toHaveLength(3);
	});
});
