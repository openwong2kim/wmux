import { describe, expect, it } from 'vitest';
import { foldMoaReports, foldNarration } from '../moaChatShape';
import type { MoaPurpose } from '../MoaPurposeCard';
import type { TurnEvent } from '../../../../../shared/transcript/turnEvents';

const complete = (ok: boolean): MoaPurpose => ({ kind: 'complete', input: { summary: 'Added subtract', verification: 'Read math.js line 2' }, ok });

describe('foldMoaReports', () => {
  it('a turn that closed its work becomes one report at its final reply, taking the delegation results with it', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', text: 'go', ts: 1 },
      { id: 'moa-result:l1', kind: 'meta', subtype: 'unknown', label: '', ts: 2 },
      { id: 'moa-purpose:c1', kind: 'meta', subtype: 'unknown', label: 'complete', ts: 3 },
      { id: 'a1', kind: 'assistant_text', text: 'Added it.', ts: 4, turnComplete: true },
      { id: 'u2', kind: 'user_text', text: 'thanks', ts: 5 },
    ];
    const { events: out, reports } = foldMoaReports(events, new Map([['moa-purpose:c1', complete(true)]]));
    expect(out.map((e) => e.id)).toEqual(['u1', 'moa-report:a1', 'u2']);
    expect(reports.get('moa-report:a1')).toEqual({ reply: 'Added it.', summary: 'Added subtract', verification: 'Read math.js line 2', linkIds: ['l1'] });
  });

  it('with no reply after the completion, the report stands where the completion was; a failed completion folds nothing', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', text: 'go', ts: 1 },
      { id: 'moa-result:l1', kind: 'meta', subtype: 'unknown', label: '', ts: 2 },
      { id: 'moa-purpose:c1', kind: 'meta', subtype: 'unknown', label: 'complete', ts: 3 },
    ];
    expect(foldMoaReports(events, new Map([['moa-purpose:c1', complete(true)]])).events.map((e) => e.id)).toEqual(['u1', 'moa-report:moa-purpose:c1']);
    expect(foldMoaReports(events, new Map([['moa-purpose:c1', complete(false)]])).events.map((e) => e.id)).toEqual(['u1', 'moa-result:l1', 'moa-purpose:c1']);
  });

  it('a delegation that finished turns before Moa closed the work is claimed by that report, not drawn twice', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', text: 'go', ts: 1 },
      { id: 'moa-result:l1', kind: 'meta', subtype: 'unknown', label: '', ts: 2 },
      { id: 'a1', kind: 'assistant_text', text: 'Shall I close it?', ts: 3, turnComplete: true },
      { id: 'w1', kind: 'meta', subtype: 'turn_started', label: '', ts: 4 },
      { id: 'moa-purpose:c1', kind: 'meta', subtype: 'unknown', label: 'complete', ts: 5 },
      { id: 'a2', kind: 'assistant_text', text: 'Closed.', ts: 6, turnComplete: true },
    ];
    const { events: out, reports } = foldMoaReports(events, new Map([['moa-purpose:c1', complete(true)]]));
    expect(out.map((e) => e.id)).toEqual(['u1', 'a1', 'w1', 'moa-report:a2']);
    expect(reports.get('moa-report:a2')?.linkIds).toEqual(['l1']);
  });

  it('a final reply with a code block keeps its own row; the report stands at the completion', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', text: 'go', ts: 1 },
      { id: 'moa-result:l1', kind: 'meta', subtype: 'unknown', label: '', ts: 2 },
      { id: 'moa-purpose:c1', kind: 'meta', subtype: 'unknown', label: 'complete', ts: 3 },
      { id: 'a1', kind: 'assistant_text', text: 'Here is the diff:\u0000code:1\u0000', ts: 4, turnComplete: true },
    ];
    const { events: out, reports } = foldMoaReports(events, new Map([['moa-purpose:c1', complete(true)]]));
    expect(out.map((e) => e.id)).toEqual(['u1', 'moa-report:moa-purpose:c1', 'a1']);
    expect(reports.get('moa-report:moa-purpose:c1')?.reply).toBeUndefined();
    // And that reply is still the turn's message, not narration.
    expect((foldNarration(out).find((e) => e.id === 'a1') as { thinking?: boolean }).thinking).toBeUndefined();
  });

  it('a completion that covers no delegation (small talk) is no report: the reply stays a message', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', text: '고마워', ts: 1 },
      { id: 'moa-purpose:c1', kind: 'meta', subtype: 'unknown', label: 'complete', ts: 2 },
      { id: 'a1', kind: 'assistant_text', text: '천만에요.', ts: 3, turnComplete: true },
    ];
    const { events: out, reports } = foldMoaReports(events, new Map([['moa-purpose:c1', complete(true)]]));
    expect(out.map((e) => e.id)).toEqual(['u1', 'a1']);
    expect(reports.size).toBe(0);
  });

  it('a thank-you turn with no completion is left alone', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', text: '고마워', ts: 1 },
      { id: 'a1', kind: 'assistant_text', text: '천만에요.', ts: 2, turnComplete: true },
    ];
    const { events: out, reports } = foldMoaReports(events, new Map());
    expect(out).toEqual(events);
    expect(reports.size).toBe(0);
  });
});

describe('foldNarration', () => {
  it('keeps each turn\'s last reply and turns earlier prose into thinking; a turn whose reply became a report keeps none', () => {
    const events: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', text: 'go', ts: 1 },
      { id: 'a1', kind: 'assistant_text', text: 'step', ts: 2 },
      { id: 'a2', kind: 'assistant_text', text: 'final', ts: 3, turnComplete: true },
      { id: 'w1', kind: 'meta', subtype: 'turn_started', label: '', ts: 4 },
      { id: 'a3', kind: 'assistant_text', text: 'checking', ts: 5 },
      { id: 'moa-report:a4', kind: 'meta', subtype: 'unknown', label: '', ts: 6 },
    ];
    const out = foldNarration(events);
    const thinking = (id: string) => (out.find((e) => e.id === id) as { thinking?: boolean }).thinking === true;
    expect(['a1', 'a2', 'a3'].map(thinking)).toEqual([true, false, true]);
  });
});
