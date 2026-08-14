import type {ScrollAcceleration} from '@opentui/core';
import {loadSettings} from './settings';

/**
 * Fixed-multiplier wheel scroll (parity: opencode's `CustomSpeedScroll`).
 * Each mouse-wheel notch scrolls `speed × baseDelta` rows instead of the
 * default linear 1× — that's the "faster/smoother" feel opencode has.
 */
export class CustomSpeedScroll implements ScrollAcceleration {
	constructor(private speed: number) {}

	tick(_now?: number): number {
		return this.speed;
	}

	reset(): void {}
}

/**
 * Zero-multiplier wheel scroll: while a MODAL is open the history behind it
 * must not scroll on wheel (the scrollbox multiplies its delta by
 * `tick()`, so 0 = no movement). Shared instance, stateless.
 */
export class DisabledScroll implements ScrollAcceleration {
	tick(_now?: number): number {
		return 0;
	}

	reset(): void {}
}

export const disabledScroll = new DisabledScroll();

/**
 * Resolve the transcript scroll acceleration from the saved settings
 * (`scrollSpeed`, default 3 — opencode's default). Pure, unit-tested.
 */
export function resolveScrollAcceleration(): ScrollAcceleration {
	const speed = loadSettings().scrollSpeed ?? 3;
	return new CustomSpeedScroll(Math.max(1, Math.min(speed, 20)));
}
