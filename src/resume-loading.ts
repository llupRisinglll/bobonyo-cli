import type {CliRenderer} from '@opentui/core';
import {setStartupLoading} from './state';

/** The frame event is emitted after native paint, unlike a microtask/timer. */
export function afterLoadingFrame(
	renderer: CliRenderer,
	signal: AbortSignal,
): Promise<void> {
	return new Promise(resolve => {
		const finish = () => {
			renderer.off('frame', finish);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		if (signal.aborted) return resolve();
		renderer.once('frame', finish);
		signal.addEventListener('abort', finish, {once: true});
		renderer.requestRender();
	});
}

export function showResumeLoading() {
	setStartupLoading(rows => [
		...rows.filter(row => row.id !== 'resume'),
		{id: 'resume', label: 'Loading session'},
	]);
}

export function hideResumeLoading() {
	setStartupLoading(rows => rows.filter(row => row.id !== 'resume'));
}
