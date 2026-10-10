import { describe, expect, it } from 'vitest';
import { mergeLocalFleetEvents } from '../localFleetEvents';
import type { DeckBrainMessage } from '../../../Deck/deckBrain';

describe('local Fleet exchange projection', () => {
  const messages: DeckBrainMessage[] = [
    { id: 'u', role: 'user', text: 'status', ts: 2, localFleet: true },
    { id: 'a', role: 'assistant', text: 'Fleet snapshot', ts: 2, localFleet: true, status: 'done' },
  ];
  it('keeps local answers beside the real transcript in chronological order', () => {
    const result = mergeLocalFleetEvents([{ id: 'old', kind: 'user_text', text: 'earlier', ts: 1 }, { id: 'new', kind: 'user_text', text: 'later', ts: 3 }], messages);
    expect(result.map((e) => e.id)).toEqual(['old', 'local-fleet:u', 'local-fleet:a', 'new']);
    expect(result[2]).toMatchObject({ kind: 'assistant_text', turnComplete: true });
  });
  it('preserves native source order when timestamps are missing or nonmonotonic', () => {
    const native = [
      { id: 'user', kind: 'user_text' as const, text: 'start', ts: 10 },
      { id: 'untimed', kind: 'assistant_text' as const, text: 'working' },
      { id: 'answer', kind: 'assistant_text' as const, text: 'done', ts: 9 },
    ];
    const result = mergeLocalFleetEvents(native, messages);
    expect(result.filter((e) => !e.id.startsWith('local-fleet:')).map((e) => e.id)).toEqual(['user', 'untimed', 'answer']);
  });
  it('does not mirror normal or incomplete stream output as transcript truth', () => {
    expect(mergeLocalFleetEvents([], [{ id: 'n', role: 'assistant', text: 'normal', status: 'done' }, { id: 's', role: 'assistant', text: 'partial', localFleet: true, status: 'streaming' }])).toEqual([]);
  });
  it('deduplicates repeat merge and caps the session-only projection', () => {
    const first = mergeLocalFleetEvents([], messages);
    expect(mergeLocalFleetEvents(first, messages)).toEqual(first);
    expect(mergeLocalFleetEvents([], Array.from({ length: 150 }, (_, n) => ({ ...messages[0], id: String(n) })))).toHaveLength(100);
  });
  it('labels a local answer as Fleet (local), never as Moa or the orchestrator', () => {
    const result = mergeLocalFleetEvents([], messages, 'Fleet (local)');
    const answer = result.find((e) => e.id === 'local-fleet:a');
    expect(answer).toMatchObject({ kind: 'assistant_text', text: '*Fleet (local)*\n\nFleet snapshot' });
    expect(result.find((e) => e.id === 'local-fleet:u')).toMatchObject({ text: 'status' });
  });
});
