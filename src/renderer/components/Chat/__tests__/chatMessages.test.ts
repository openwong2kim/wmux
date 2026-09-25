import { describe, expect, it } from 'vitest';
import { transcriptMessages } from '../chatMessages';
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
    const file: TurnEvent = { ...result, files: [{ path: 'app.ts', patch: '+hi', additions: 1, deletions: 0 }] };
    const rows = transcriptMessages([user, call, file, { id: 'a', kind: 'assistant_text', text: 'done' }], true);
    expect(rows.map((row) => row.id)).toEqual(['u', 'activity:t', 'r', 'a']);
    expect((rows[1].metadata.custom.row as { activity: unknown[] }).activity).toHaveLength(1);
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
});
