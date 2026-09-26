export interface DebouncedFlush {
	schedule: () => void;
	flush: () => void;
	cancel: () => void;
}

export function createDebouncedFlush(
	callback: () => void,
	delayMs: number,
): DebouncedFlush {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	};
	return {
		schedule: () => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				callback();
			}, delayMs);
		},
		flush: () => {
			cancel();
			callback();
		},
		cancel,
	};
}
