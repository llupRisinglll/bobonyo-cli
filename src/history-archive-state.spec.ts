import {afterEach, expect, test} from 'bun:test';
import * as state from './state';
afterEach(() => {
	state.clearMessages();
	state.configureTranscriptArchive(() => {});
});
const rows = (length: number): state.ChatMessage[] =>
	Array.from({length}, (_, i) => ({role: 'user', content: `row ${i}`}));
test('archives before cap eviction and identities are assigned once', () => {
	let archived: state.ChatMessage[] = [];
	state.configureTranscriptArchive((_, rows) => {
		archived = rows.slice();
		expect(state.messages()).toHaveLength(300);
	});
	state.setMessages(rows(300));
	const identity = state.messages()[299]!.transcriptId;
	state.appendMessage({role: 'assistant', content: 'new'});
	expect(archived).toHaveLength(1);
	expect(archived.every(r => Boolean(r.transcriptId))).toBe(true);
	expect(state.messages()).toHaveLength(300);
	expect(state.messages()[298]!.transcriptId).toBe(identity);
});
test('cap and compaction archive failures retain originals and report the failure', () => {
	state.configureTranscriptArchive(() => {
		throw new Error('disk full');
	});
	state.setMessages(rows(300));
	state.appendMessage({role: 'assistant', content: 'new'});
	expect(state.messages()).toHaveLength(301);
	expect(state.transcriptArchiveError()).toContain('disk full');
	const outgoing = state.messages();
	expect(state.retainArchivedDisplayWindow(outgoing, outgoing.slice(-2))).toBe(
		outgoing,
	);
});
test('does not freeze unsettled tool output in immutable archive pages', () => {
	let writes = 0;
	state.configureTranscriptArchive(() => {
		writes++;
	});
	const all = rows(301);
	all[0] = {role: 'tool', content: 'partial', running: true};
	expect(state.retainArchivedDisplayWindow(all, all.slice(-300))).toBe(all);
	expect(writes).toBe(0);
});
test('UTF8 display byte bound and archive helper never touch provider context', () => {
	state.setContext([{role: 'user', content: 'provider only'}]);
	const all = rows(300).map(row => ({...row, content: '界'.repeat(2000)}));
	state.configureTranscriptArchive(() => {});
	const kept = state.capDisplayMessages(all);
	expect(
		kept.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
	).toBeLessThanOrEqual(state.DISPLAY_MESSAGE_BYTES);
	state.retainArchivedDisplayWindow(all, kept);
	expect(state.context()).toEqual([{role: 'user', content: 'provider only'}]);
});
