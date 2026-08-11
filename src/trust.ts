/**
 * First-run trust-gate decision (pure, unit-tested).
 *
 * The gate MUST NOT continue when the prompt is unanswered: only an explicit
 * `y` trusts the directory; Esc (cancel) and any other answer decline trust
 * and exit the app.
 */
export type TrustDecision = 'trust' | 'exit';

export function trustDecision(value: string): TrustDecision {
	return value.trim().toLowerCase() === 'y' ? 'trust' : 'exit';
}
