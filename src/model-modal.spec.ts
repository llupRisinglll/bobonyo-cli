import {describe, expect, test} from 'bun:test';
import {initialModelRowIndex} from './components/model-modal';

type Row = {kind: string; isCurrent?: boolean};

const model = (isCurrent = false): Row => ({kind: 'model', isCurrent});

describe('initialModelRowIndex (/model opens on the current model)', () => {
	test('returns the CURRENT model row when present', () => {
		const rows: Row[] = [
			{kind: 'provider'},
			{kind: 'spacer'},
			model(true),
			model(),
			{kind: 'provider'},
			{kind: 'spacer'},
			model(),
		];
		expect(initialModelRowIndex(rows)).toBe(2);
	});

	test('falls back to the FIRST model row when no current model', () => {
		const rows: Row[] = [
			{kind: 'provider'},
			{kind: 'spacer'},
			model(),
			model(),
		];
		expect(initialModelRowIndex(rows)).toBe(2);
	});

	test('prefers the Inherit row when it comes first and no current model', () => {
		const rows: Row[] = [
			{kind: 'inherit'},
			{kind: 'spacer'},
			{kind: 'provider'},
			{kind: 'spacer'},
			model(),
		];
		expect(initialModelRowIndex(rows)).toBe(0);
	});

	test('current model wins even when an Inherit row exists', () => {
		const rows: Row[] = [
			{kind: 'inherit'},
			{kind: 'spacer'},
			{kind: 'provider'},
			{kind: 'spacer'},
			model(true),
		];
		expect(initialModelRowIndex(rows)).toBe(4);
	});

	test('returns -1 when nothing is navigable', () => {
		expect(initialModelRowIndex([{kind: 'empty'}])).toBe(-1);
		expect(initialModelRowIndex([])).toBe(-1);
	});
});
