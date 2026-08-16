/**
 * COMPLETED attention-modal controller.
 *
 * A finished task (the `✦ Worked for …` line) ARMS the controller. The
 * popup shows only after a FULL idle window with zero user activity (mouse
 * move, click or keypress) — i.e. the user is away and needs the attention
 * grab. Once visible, the FIRST activity dismisses it: the user came back,
 * moved the mouse, and the modal did its job.
 *
 * Pure logic with an injected clock, fully unit-tested (no real timers in
 * the specs).
 */
export const COMPLETION_POPUP_IDLE_MS = 3000;

export interface CompletionPopupClock {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export function createCompletionPopupController(
	clock: CompletionPopupClock,
	idleMs: number,
	onShow: () => void,
	onHide: () => void,
) {
	let armed = false;
	let visible = false;
	let timer: unknown = null;

	const clearTimer = (): void => {
		if (timer !== null) {
			clock.clearTimeout(timer);
			timer = null;
		}
	};
	const startIdleWindow = (): void => {
		clearTimer();
		timer = clock.setTimeout(() => {
			timer = null;
			if (!armed) return;
			armed = false;
			visible = true;
			onShow();
		}, idleMs);
	};

	return {
		get armed(): boolean {
			return armed;
		},
		get visible(): boolean {
			return visible;
		},
		/** A task finished: watch for a full idle window before showing. */
		arm(): void {
			armed = true;
			startIdleWindow();
		},
		/**
		 * User activity (mouse move, click, keypress): dismiss when the
		 * popup is up, otherwise restart the idle window (still not idle).
		 */
		activity(): void {
			if (visible) {
				visible = false;
				armed = false;
				clearTimer();
				onHide();
				return;
			}
			if (armed) startIdleWindow();
		},
		/** New turn / /clear / undo: stop watching, hide. */
		cancel(): void {
			armed = false;
			visible = false;
			clearTimer();
			onHide();
		},
	};
}

export type CompletionPopupController = ReturnType<
	typeof createCompletionPopupController
>;
