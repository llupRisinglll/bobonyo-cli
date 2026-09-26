/** Default remains auto-approved and sandboxed; yolo explicitly removes isolation. */
export const MODES = [
	'default',
	'normal',
	'plan',
	'auto-accept',
	'yolo',
] as const;
export type Mode = (typeof MODES)[number];

/** Keyboard cycling must never accidentally opt into unsandboxed execution. */
export const SAFE_MODE_CYCLE: Mode[] = [
	'default',
	'normal',
	'plan',
	'auto-accept',
];

export function isMode(value: unknown): value is Mode {
	return typeof value === 'string' && MODES.includes(value as Mode);
}

export function autoApprovesTools(mode: Mode): boolean {
	return mode === 'default' || mode === 'yolo' || mode === 'auto-accept';
}

export function modeLabel(mode: Mode): string {
	return mode === 'yolo' ? 'yolo (sandbox off)' : `${mode} mode`;
}
