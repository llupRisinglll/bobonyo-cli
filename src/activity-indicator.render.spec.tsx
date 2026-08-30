import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {ActivityIndicator} from './components/activity-indicator';

function frameHas(frame: CapturedFrame, needle: string): boolean {
	return frame.lines.some(line =>
		line.spans
			.map(span => span.text)
			.join('')
			.includes(needle),
	);
}

describe('ActivityIndicator', () => {
	test('hides zero-valued categories while showing active goal', async () => {
		const setup = await testRender(
			() => (
				<ActivityIndicator
					backgroundCount={0}
					agentCount={2}
					goalActive
					onOpen={() => {}}
				/>
			),
			{width: 100, height: 20},
		);
		try {
			await setup.flush();
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'agents: 2 · goal: active')).toBe(true);
			expect(frameHas(frame, 'bg: 0')).toBe(false);
			expect(frameHas(frame, '/ps · click')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('shows only nonzero categories when no goal is active', async () => {
		const setup = await testRender(
			() => (
				<ActivityIndicator
					backgroundCount={1}
					agentCount={0}
					goalActive={false}
					onOpen={() => {}}
				/>
			),
			{width: 100, height: 20},
		);
		try {
			await setup.flush();
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'bg: 1')).toBe(true);
			expect(frameHas(frame, 'agents: 0')).toBe(false);
			expect(frameHas(frame, 'goal: active')).toBe(false);
		} finally {
			setup.renderer.destroy();
		}
	});
});
