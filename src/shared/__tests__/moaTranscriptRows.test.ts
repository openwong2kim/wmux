import { describe, it, expect } from 'vitest';
import { moaPhoneRows, rewritePastedPrompts, type NotedPrompt } from '../moaTranscriptRows';
import type { TurnEvent } from '../transcript/turnEvents';

const T = 1_700_000_000_000;
const pasted = (body: string) => `<pasted_content id="4d08">${body}</pasted_content id="4d08">`;

describe('moaPhoneRows — the Moa transcript as the phone reads it', () => {
  it('shows the sent text, turns injection-only rows into turn starts, and folds Moa\'s working', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', ts: T, text: pasted('[active-work] … leave this work active. 뭐하냐 ') },
      { id: 'a1', kind: 'assistant_text', text: 'checking the fleet' },
      { id: 't1', kind: 'tool_use', toolUseId: 'x', name: 'mcp__wmux__fleet_triage', argSummary: '' },
      { id: 'r1', kind: 'tool_result', toolUseId: 'x', ok: true, bytes: 2 },
      { id: 'a2', kind: 'assistant_text', text: 'All quiet.', turnComplete: true },
      { id: 'u2', kind: 'user_text', ts: T + 60_000, text: pasted('[active-work] id: w1 — unchanged since your last turn') },
      { id: 'u3', kind: 'user_text', ts: T + 70_000, text: '[pane-events] (UNTRUSTED terminal/A2A signals' },
      { id: 'u4', kind: 'user_text', ts: T + 80_000, text: 'typed straight into the TUI' },
    ];
    const prompts: NotedPrompt[] = [{ at: T - 1_000, text: '뭐하냐', hq: 'ws-hq' }];
    const out = moaPhoneRows(events, prompts, new Map());
    expect(out.map((e) => [e.id, e.kind, e.kind === 'user_text' ? e.text : undefined, e.folded])).toEqual([
      ['u1', 'user_text', '뭐하냐', undefined],
      ['a1', 'assistant_text', undefined, true],
      ['t1', 'tool_use', undefined, true],
      ['r1', 'tool_result', undefined, true],
      ['a2', 'assistant_text', undefined, undefined],
      ['moa-wake:u2', 'meta', undefined, undefined],
      ['moa-wake:u3', 'meta', undefined, undefined],
      ['u4', 'user_text', 'typed straight into the TUI', undefined],
    ]);
    expect(out[5]).toEqual({ id: 'moa-wake:u2', kind: 'meta', subtype: 'turn_started', label: '', ts: T + 60_000 });
  });

  it('the same, now that the parser unwraps a paste and marks it `pasted`', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', ts: T, text: '[active-work] … leave this work active. 뭐하냐 ', pasted: true },
      { id: 'u2', kind: 'user_text', ts: T + 60_000, text: '[active-work] id: w1 — unchanged since your last turn', pasted: true },
      { id: 'u3', kind: 'user_text', ts: T + 80_000, text: 'typed straight into the TUI' },
    ];
    const out = moaPhoneRows(events, [{ at: T - 1_000, text: '뭐하냐', hq: 'ws-hq' }], new Map());
    expect(out).toEqual([
      // Shown as main's prompt, and no longer marked as a paste.
      { id: 'u1', kind: 'user_text', ts: T, text: '뭐하냐' },
      { id: 'moa-wake:u2', kind: 'meta', subtype: 'turn_started', label: '', ts: T + 60_000 },
      { id: 'u3', kind: 'user_text', ts: T + 80_000, text: 'typed straight into the TUI' },
    ]);
  });

  it('uses each prompt once even when the prompts are re-read from disk on every call', () => {
    const read = (): NotedPrompt[] => [{ at: T - 1_000, text: '뭐하냐', hq: 'ws-hq' }];
    const assigned = new Map<string, NotedPrompt>();
    const first = rewritePastedPrompts([{ id: 'u1', kind: 'user_text', ts: T, text: pasted('ctx 뭐하냐') }], read(), assigned);
    const second = rewritePastedPrompts([{ id: 'u2', kind: 'user_text', ts: T + 5_000, text: pasted('ctx only') }], read(), assigned);
    expect(first[0]).toMatchObject({ text: '뭐하냐' });
    expect(second[0]).toMatchObject({ text: pasted('ctx only') });
    // A read that finds no prompts still shows what an entry was already matched to.
    expect(rewritePastedPrompts([{ id: 'u1', kind: 'user_text', ts: T, text: pasted('ctx 뭐하냐') }], [], assigned)[0]).toMatchObject({ text: '뭐하냐' });
  });
});
