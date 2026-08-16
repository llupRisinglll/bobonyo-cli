import {describe, expect, test} from 'bun:test';
import {
	COMPLETION_POPUP_IDLE_MS,
	createCompletionPopupController,
	type CompletionPopupClock,
} from './completion-popup';

/**
 * Time-aware fake clock: setTimeout registers a handler due at
 * `now + ms`; tick(ms) advances time and fires only the timers that came
 * due. This makes the "activity restarts the idle window" delay observable.
 */
class FakeClock implements CompletionPopupClock {
	now = 0;
	timers = new Map<number, {due: number; handler: () => void}>();
	next = 1;
	setTimeout(handler: () => void, ms: number): unknown {
		const id = this.next++;
		this.timers.set(id, {due: this.now + ms, handler});
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}
	tick(ms: number): void {
		this.now += ms;
		for (const [id, {due, handler}] of [...this.timers]) {
			if (due <= this.now) {
				this.timers.delete(id);
				handler();
			}
		}
	}
	get pending(): number {
		return this.timers.size;
	}
}

function makeController(idleMs = 100) {
	const clock = new FakeClock();
	const shown: number[] = [];
	const hidden: number[] = [];
	const controller = createCompletionPopupController(
		clock,
		idleMs,
		() => shown.push(shown.length),
		() => hidden.push(hidden.length),
	);
	return {clock, controller, shown, hidden};
}

describe('createCompletionPopupController (COMPLETED idle popup)', () => {
	test('a completed task shows the popup only after a FULL idle window', () => {
		const {clock, controller, shown} = makeController();
		controller.arm();
		expect(controller.armed).toBe(true);
		expect(controller.visible).toBe(false);
		expect(shown.length).toBe(0);
		clock.tick(99);
		expect(controller.visible).toBe(false);
		clock.tick(1);
		expect(controller.visible).toBe(true);
		expect(controller.armed).toBe(false);
		expect(shown.length).toBe(1);
	});

	test('mouse activity DURING the window CANCELS it (the user is present)', () => {
		const {clock, controller, shown} = makeController();
		controller.arm();
		// The user moves the mouse 30ms in — they are clearly present, so
		// the arm is cancelled and the popup NEVER shows (it must not pop up
		// in front of an active user the moment they pause).
		clock.tick(30);
		controller.activity();
		expect(controller.armed).toBe(false);
		// Even a long silence afterwards must not resurrect it.
		clock.tick(1000);
		expect(controller.visible).toBe(false);
		expect(shown.length).toBe(0);
	});

	test('the FIRST activity dismisses a visible popup (user came back)', () => {
		const {clock, controller, shown, hidden} = makeController();
		controller.arm();
		clock.tick(100);
		expect(controller.visible).toBe(true);
		// The user returns and moves the mouse.
		controller.activity();
		expect(controller.visible).toBe(false);
		expect(controller.armed).toBe(false);
		expect(hidden.length).toBe(1);
		expect(shown.length).toBe(1);
	});

	test('a keypress dismisses the visible popup too', () => {
		const {clock, controller, hidden} = makeController();
		controller.arm();
		clock.tick(100);
		controller.activity();
		expect(controller.visible).toBe(false);
		expect(hidden.length).toBe(1);
	});

	test('a dismissed popup never re-shows on later activity', () => {
		const {clock, controller, shown, hidden} = makeController();
		controller.arm();
		clock.tick(100);
		controller.activity();
		// Later idle/movement must not resurrect it (no stale timer).
		clock.tick(500);
		expect(controller.visible).toBe(false);
		expect(shown.length).toBe(1);
		expect(hidden.length).toBe(1);
	});

	test('cancel (new turn / /clear / undo) stops an ARMED popup', () => {
		const {clock, controller, shown} = makeController();
		controller.arm();
		controller.cancel();
		clock.tick(500);
		expect(controller.visible).toBe(false);
		expect(shown.length).toBe(0);
	});

	test('cancel hides a VISIBLE popup', () => {
		const {clock, controller, hidden} = makeController();
		controller.arm();
		clock.tick(100);
		controller.cancel();
		expect(controller.visible).toBe(false);
		expect(hidden.length).toBe(1);
	});

	test('cancel clears the pending timer (no fire later)', () => {
		const {clock, controller, shown} = makeController();
		controller.arm();
		controller.cancel();
		expect(clock.pending).toBe(0);
		clock.tick(500);
		expect(shown.length).toBe(0);
	});

	test('re-arm works after a dismiss (next task completes)', () => {
		const {clock, controller, shown, hidden} = makeController();
		controller.arm();
		clock.tick(100);
		controller.activity();
		controller.arm();
		clock.tick(100);
		expect(controller.visible).toBe(true);
		expect(shown.length).toBe(2);
		expect(hidden.length).toBe(1);
	});

	test('activity with nothing armed/visible is a no-op', () => {
		const {controller, hidden} = makeController();
		controller.activity();
		controller.activity();
		expect(hidden.length).toBe(0);
	});

	test('the idle constant is a sane 3 seconds', () => {
		expect(COMPLETION_POPUP_IDLE_MS).toBe(3000);
	});
});
