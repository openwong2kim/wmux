import { expect, it } from 'vitest';
import { chatAgentStatus, confirmedStopAt, transcriptTurnEnd } from '../chatAgentStatus';
import { parseTranscriptLine } from '../parseEntry';
import { parseCodexLineDetailed } from '../parseCodexEntry';
import type { TurnEvent } from '../../../shared/transcript/turnEvents';
const final = { id: 'a', kind: 'assistant_text' as const, text: 'done', ts: 200, turnComplete: true };
it('reconciles repaint activity only with a current recorded completion', () => {
  expect(chatAgentStatus('running', [final], 100)).toBe('complete');
  expect(chatAgentStatus('running', [final], 300)).toBe('running');
  expect(chatAgentStatus('awaiting_input', [final], 100)).toBe('awaiting_input');
  expect(chatAgentStatus('error', [final], 100)).toBe('error');
  expect(chatAgentStatus('idle', [{ ...final, turnComplete: undefined }], 100)).toBe('idle');
  expect(chatAgentStatus('running', [final, { id: 'u', kind: 'user_text', text: 'next', ts: 300 }], 100)).toBe('complete');
  expect(chatAgentStatus('running', [final, { id: 'u', kind: 'user_text', text: 'next', ts: 300 }], 250)).toBe('running');
  expect(chatAgentStatus('running', undefined, 100)).toBe('running');
});

// Real transcript shapes: Claude Code records an ESC interrupt as its own user
// text block (parseEntry), Codex as an `event_msg` of type `turn_aborted`.
const at = '2026-09-28T00:00:10.000Z';
const ts = Date.parse(at);
const claudeAbort = (text = '[Request interrupted by user]') => parseTranscriptLine(JSON.stringify({ type: 'user', uuid: 'i', timestamp: at,
  message: { role: 'user', content: [{ type: 'text', text }] } }), 0);
const codexAbort = () => parseCodexLineDetailed(JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'turn_aborted', turn_id: 't' } }), 0).events;

it('reads a recorded interrupt (Claude and Codex) as idle, but only for the current turn', () => {
  for (const aborted of [claudeAbort(), claudeAbort('[Request interrupted by user for tool use]'), codexAbort()]) {
    expect(aborted).toEqual([expect.objectContaining({ kind: 'meta', subtype: 'turn_aborted', ts })]);
    expect(chatAgentStatus('running', aborted, ts - 1)).toBe('idle');
    expect(chatAgentStatus('running', aborted, ts)).toBe('idle');
    // A prompt submitted after the interrupt is newer work.
    expect(chatAgentStatus('running', aborted, ts + 1)).toBe('running');
    expect(chatAgentStatus('awaiting_input', aborted, ts - 1)).toBe('awaiting_input');
    expect(transcriptTurnEnd(aborted, ts - 1)).toMatchObject({ status: 'idle', at: ts });
  }
  expect(transcriptTurnEnd([final], 100)).toEqual({ status: 'complete', at: 200 });
  expect(transcriptTurnEnd([final], 300)).toBeUndefined();
});

it('finds the end behind trailing rows that are not work, but not behind newer work', () => {
  const queued: TurnEvent = { id: 'q', kind: 'user_text', text: 'queued prompt', ts: ts + 5 };
  const note: TurnEvent = { id: 'n', kind: 'meta', subtype: 'unknown', label: 'token count', ts: ts + 6 };
  expect(chatAgentStatus('running', [...claudeAbort(), queued], ts - 1)).toBe('idle');
  expect(chatAgentStatus('running', [...codexAbort(), note], ts - 1)).toBe('idle');
  const started: TurnEvent = { id: 's', kind: 'meta', subtype: 'turn_started', label: 'Working', ts: ts + 7 };
  const reply: TurnEvent = { id: 'r', kind: 'assistant_text', text: 'working on it', ts: ts + 8 };
  expect(chatAgentStatus('running', [...codexAbort(), started], ts - 1)).toBe('running');
  expect(chatAgentStatus('running', [...claudeAbort(), queued, reply], ts - 1)).toBe('running');
});

it('confirms a Codex stop hook only from the rollout end of the same turn', () => {
  const rollout = (type: string, turnId: string, when: string) =>
    parseCodexLineDetailed(JSON.stringify({ type: 'event_msg', timestamp: when, payload: { type, turn_id: turnId } }), 0).events;
  const started = rollout('task_started', 'turn-2', '2026-09-28T00:00:20.000Z');
  const previous = rollout('task_complete', 'turn-1', '2026-09-28T00:00:05.000Z');
  const done = rollout('task_complete', 'turn-2', '2026-09-28T00:00:40.000Z');
  // No binding yet, or the turn is still running: nothing confirms the stop.
  expect(confirmedStopAt(undefined, 'turn-2')).toBeUndefined();
  expect(confirmedStopAt([...previous, ...started], 'turn-2')).toBeUndefined();
  // The rollout's end names another turn than the hook.
  expect(confirmedStopAt([...started, ...done], 'turn-3')).toBeUndefined();
  expect(confirmedStopAt([...started, ...done], 'turn-2')).toBe(Date.parse('2026-09-28T00:00:40.000Z'));
  expect(confirmedStopAt([...started, ...done], undefined)).toBe(Date.parse('2026-09-28T00:00:40.000Z'));
});
