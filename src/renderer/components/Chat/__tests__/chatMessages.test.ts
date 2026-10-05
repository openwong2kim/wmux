import { describe, expect, it } from 'vitest';
import { activityLabel, transcriptMessages, type ChatRow } from '../chatMessages';
import { formatDuration } from '../ChatMessage';
import { mergeTranscriptEvents } from '../transcriptState';
import type { TurnEvent } from '../../../../shared/transcript/turnEvents';
const user: TurnEvent = { id: 'u', kind: 'user_text', text: 'hello' };
const call: TurnEvent = { id: 't', kind: 'tool_use', toolUseId: 'tool-1', name: 'Read', argSummary: 'README.md' };
const result: TurnEvent = { id: 'r', kind: 'tool_result', toolUseId: 'tool-1', ok: false, bytes: 3, output: { n: 0, bytes: 3, inline: 'err' } };
describe('transcript message projection', () => {
  it('joins a tool result to its call without dropping user/assistant boundaries', () => {
    const rows = transcriptMessages([user, call, result, { id: 'a', kind: 'assistant_text', text: 'done' }]);
    expect(rows.map((m) => m.id)).toEqual(['u', 't', 'a']);
    expect(rows[0].role).toBe('user');
    expect(rows[1].metadata.custom.row).toEqual({ event: call, result });
    expect(rows[2].content).toEqual([{ type: 'text', text: 'done' }]);
  });
  it('preserves an orphan tool result at a pagination boundary', () => {
    expect(transcriptMessages([result])).toHaveLength(1);
    expect(transcriptMessages([call, result])).toHaveLength(1);
  });
  it('deduplicates overlapping live pages and prepends history without reordering', () => {
    expect(mergeTranscriptEvents([user, call], [call, result])).toEqual([user, call, result]);
    expect(mergeTranscriptEvents([call, result], [user, call], true)).toEqual([user, call, result]);
  });
  it('groups work without swallowing an answer or a file review card', () => {
    const file: TurnEvent = { ...result, ok: true, files: [{ path: 'app.ts', patch: '+hi', additions: 1, deletions: 0 }] };
    const rows = transcriptMessages([user, call, file, { id: 'a', kind: 'assistant_text', text: 'done' }], true);
    expect(rows.map((row) => row.id)).toEqual(['u', 'activity:t', 'r', 'a']);
    expect((rows[1].metadata.custom.row as { activity: unknown[] }).activity).toHaveLength(1);
  });
  it('folds events main marked as internal, failed calls and mid-turn text included, out of the conversation', () => {
    const failedCall: TurnEvent = { ...call, folded: true };
    const failed: TurnEvent = { ...result, ok: false, folded: true };
    const narration: TurnEvent = { id: 'n', kind: 'assistant_text', text: 'Proposing the handoff…', folded: true };
    const reply: TurnEvent = { id: 'a', kind: 'assistant_text', text: '넘겼습니다.', turnComplete: true, ts: 9 };
    const rows = transcriptMessages([user, failedCall, failed, narration, reply], true);
    expect(rows.map((row) => row.id)).toEqual(['u', 'activity:t', 'a']);
    expect((rows[1].metadata.custom.row as ChatRow).activity?.map((r) => r.event.id)).toEqual(['t', 'n']);
    // The receipt's reply (what Copy takes) is the final text only.
    expect((rows[2].metadata.custom.row as ChatRow).receipt?.replies.map((r) => r.id)).toEqual(['a']);
    // Unmarked, a failed call still stays in view.
    expect(transcriptMessages([user, call, { ...result, ok: false }], true).map((row) => row.id)).toEqual(['u', 't']);
  });
  it('folds an image source note into the prompt that carried the image', () => {
    const prompt: TurnEvent = { id: 'p', kind: 'user_text', text: '[Image #1] what is this?', hasImage: true };
    const note: TurnEvent = { id: 'n', kind: 'meta', subtype: 'caveat', label: 'Image source', images: ['/tmp/red.png'] };
    const rows = transcriptMessages([prompt, note, { id: 'a', kind: 'assistant_text', text: 'red' }], true);
    expect(rows.map((row) => row.id)).toEqual(['p', 'a']);
    expect((rows[0].metadata.custom.row as { images: string[] }).images).toEqual(['/tmp/red.png']);
    // Without its prompt (a page boundary) the note stays a quiet meta row.
    expect(transcriptMessages([note]).map((row) => row.id)).toEqual(['n']);
  });
  it('puts a receipt only on a recorded turn end, with times the transcript carried', () => {
    const reply = (id: string, extra: object) => ({ id, kind: 'assistant_text', text: id, ...extra }) as TurnEvent;
    const rows = transcriptMessages([{ ...user, ts: 1_000 }, reply('a1', { ts: 2_000 }), reply('a2', { ts: 244_000, turnComplete: true }),
      { id: 'u2', kind: 'user_text', text: 'again' }, reply('a3', { turnComplete: true }), reply('a4', { ts: 9_000 })], true);
    const receipt = (id: string) => (rows.find((m) => m.id === id)!.metadata.custom.row as ChatRow).receipt;
    expect(receipt('a1')).toBeUndefined();
    expect(receipt('a2')).toMatchObject({ start: 1_000, end: 244_000 });
    expect(receipt('a2')!.replies.map((e) => e.id)).toEqual(['a1', 'a2']);
    // No timestamps recorded: a receipt without a duration, never a guessed one.
    expect(receipt('a3')).toMatchObject({ start: undefined, end: undefined });
    // Silence after a reply is not a turn end.
    expect(receipt('a4')).toBeUndefined();
  });
  it('formats a turn duration as seconds, minutes or hours', () => {
    expect(formatDuration(55_000)).toBe('55s');
    expect(formatDuration(243_000)).toBe('4m 3s');
    expect(formatDuration(3_720_000)).toBe('1h 2m');
  });
  it('keeps a failed call out of the activity fold', () => {
    const read = (id: string): TurnEvent => ({ id, kind: 'tool_use', toolUseId: `use-${id}`, name: 'Read', argSummary: id });
    const ok = (id: string): TurnEvent => ({ id: `r-${id}`, kind: 'tool_result', toolUseId: `use-${id}`, ok: true, bytes: 1 });
    const rows = transcriptMessages([user, read('a'), ok('a'), call, result, read('b'), ok('b')], true);
    expect(rows.map((row) => row.id)).toEqual(['u', 'activity:a', 't', 'activity:b']);
  });
  it('names a fold of one kind of call, and only past its threshold', () => {
    const use = (name: string, id = name): ChatRow => ({ event: { id, kind: 'tool_use', toolUseId: id, name, argSummary: '' } });
    expect(activityLabel([use('Read', '1'), use('Read', '2'), use('Read', '3')])).toEqual({ key: 'chat.groupRead', count: 3 });
    expect(activityLabel([use('Read', '1'), use('Read', '2')])).toBeNull();
    expect(activityLabel([use('Edit', '1'), use('Write', '2')])).toEqual({ key: 'chat.groupEdited', count: 2 });
    expect(activityLabel([use('Bash', '1'), use('Read', '2'), use('Grep', '3')])).toBeNull();
  });
});
