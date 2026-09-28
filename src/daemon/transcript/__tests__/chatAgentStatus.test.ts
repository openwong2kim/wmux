import { expect, it } from 'vitest';
import { chatAgentStatus, transcriptTurnEnd } from '../chatAgentStatus';
import { parseTranscriptLine } from '../parseEntry';
import { parseCodexLineDetailed } from '../parseCodexEntry';
const final = { id: 'a', kind: 'assistant_text' as const, text: 'done', ts: 200, turnComplete: true };
it('reconciles repaint activity only with a current recorded completion', () => {
  expect(chatAgentStatus('running', final, 100)).toBe('complete');
  expect(chatAgentStatus('running', final, 300)).toBe('running');
  expect(chatAgentStatus('awaiting_input', final, 100)).toBe('awaiting_input');
  expect(chatAgentStatus('error', final, 100)).toBe('error');
  expect(chatAgentStatus('idle', { ...final, turnComplete: undefined }, 100)).toBe('idle');
  expect(chatAgentStatus('running', { id: 'u', kind: 'user_text', text: 'next', ts: 300 }, 100)).toBe('running');
});

it('reads a recorded interrupt (Claude and Codex) as idle, but only for the current turn', () => {
  const at = '2026-09-28T00:00:10.000Z';
  const ts = Date.parse(at);
  const claude = parseTranscriptLine(JSON.stringify({ type: 'user', uuid: 'i', timestamp: at, message: { role: 'user', content: [
    { type: 'text', text: '[Request interrupted by user]' }] } }), 0).at(-1);
  const codex = parseCodexLineDetailed(JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'turn_aborted', turn_id: 't' } }), 0).events.at(-1);
  for (const aborted of [claude, codex]) {
    expect(aborted).toMatchObject({ kind: 'meta', subtype: 'turn_aborted', ts });
    expect(chatAgentStatus('running', aborted, ts - 1)).toBe('idle');
    expect(chatAgentStatus('running', aborted, ts)).toBe('idle');
    // A prompt submitted after the interrupt is newer work.
    expect(chatAgentStatus('running', aborted, ts + 1)).toBe('running');
    expect(chatAgentStatus('awaiting_input', aborted, ts - 1)).toBe('awaiting_input');
    expect(transcriptTurnEnd(aborted, ts - 1)).toEqual({ status: 'idle', at: ts });
  }
  expect(transcriptTurnEnd(final, 100)).toEqual({ status: 'complete', at: 200 });
  expect(transcriptTurnEnd(final, 300)).toBeUndefined();
});
