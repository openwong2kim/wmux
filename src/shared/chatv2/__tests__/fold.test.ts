// Contract tests for the chat-v2 fold: the daemon and every renderer must
// reach the same session from the same stamped events, however they batch.
import { describe, expect, it } from 'vitest';
import { applyHarnessEvent, applyHarnessEvents, blockChangeFrom } from '../apply';
import type { HarnessEvent, StampedHarnessEvent } from '../harnessEvents';
import { newChatSession, type Session } from '../session';

const base = (): Session => newChatSession({ id: 'c1', harness: 'claude', cwd: '/repo', model: 'opus' });

function stampAll(events: HarnessEvent[], from = 1): StampedHarnessEvent[] {
  return events.map((event, i) => ({ seq: from + i, at: 1_000 + (from + i) * 10, event }));
}

const turn: HarnessEvent[] = [
  { type: 'user.message', text: 'fix the test', clientMessageId: 'client-0001' },
  { type: 'session.providerBound', providerSessionId: 'native-1' },
  { type: 'reasoning.delta', text: 'Look' },
  { type: 'reasoning.delta', text: 'ing' },
  { type: 'message.delta', text: 'I will ' },
  { type: 'message.delta', text: 'edit it.' },
  { type: 'message.completed' },
  { type: 'tool.started', callId: 't1', title: 'Edit', kind: 'edit', status: 'pending' },
  { type: 'approval.requested', requestId: 'req-1', title: 'Edit', kind: 'edit', callId: 't1' },
  { type: 'approval.resolved', requestId: 'req-1', decision: 'allow' },
  { type: 'tool.updated', callId: 't1', status: 'completed' },
  { type: 'message.delta', text: 'Done.' },
  { type: 'turn.metrics', inputTokens: 10, outputTokens: 5 },
  { type: 'turn.ended', outcome: 'completed' },
];

describe('chat-v2 fold determinism', () => {
  it('gives the same session folded at once, one by one, or in chunks', () => {
    const stamped = stampAll(turn);
    const all = applyHarnessEvents(base(), stamped);
    const single = stamped.reduce((s, e) => applyHarnessEvent(s, e), base());
    let chunked = base();
    for (let i = 0; i < stamped.length; i += 3) chunked = applyHarnessEvents(chunked, stamped.slice(i, i + 3));
    expect(single).toEqual(all);
    expect(chunked).toEqual(all);
  });

  it('derives block ids from seq and turn times from the stamp', () => {
    const session = applyHarnessEvents(base(), stampAll(turn));
    expect(session.blocks.map((b) => b.id)).toEqual(['1.1', '3.1', '5.1', '8.1', '12.1']);
    const user = session.blocks[0]!;
    expect(user).toMatchObject({
      role: 'user',
      clientMessageId: 'client-0001',
      startedAt: 1_010,
      durationMs: 1_140 - 1_010,
      outcome: 'completed',
      turnModel: { harness: 'claude', id: 'opus' },
      turnMetrics: { inputTokens: 10, outputTokens: 5 },
    });
    expect(session.busy).toBe(false);
    expect(session.providerSessionId).toBe('native-1');
    expect(session.blocks[3]!.approval).toEqual({ requestId: 'req-1', decided: 'allow' });
  });

  it('cancels a pending approval and fails open tools when the turn fails', () => {
    const stamped = stampAll([
      { type: 'user.message', text: 'go', clientMessageId: 'client-0002' },
      { type: 'tool.started', callId: 't1', title: 'Bash', kind: 'execute', status: 'in_progress' },
      { type: 'approval.requested', requestId: 'r', title: 'Bash', callId: 't1' },
      { type: 'turn.ended', outcome: 'failed' },
    ]);
    const session = applyHarnessEvents(base(), stamped);
    expect(session.blocks[1]).toMatchObject({ approval: { requestId: 'r', decided: 'cancelled' }, tool: { status: 'failed' } });
    expect(session.blocks[0]!.outcome).toBe('failed');
  });

  it('clears a usage limit on the next user turn', () => {
    const limited = applyHarnessEvents(base(), stampAll([{ type: 'usage.limited', resetsAt: 5 }]));
    expect(limited.usageLimit).toEqual({ resetsAt: 5 });
    const next = applyHarnessEvents(limited, stampAll([{ type: 'user.message', text: 'again', clientMessageId: 'client-0003' }], 2));
    expect(next.usageLimit).toBeUndefined();
  });
});

describe('blockChangeFrom', () => {
  it('reports the lowest changed block, or the length when nothing changed', () => {
    const stamped = stampAll(turn);
    const before = applyHarnessEvents(base(), stamped.slice(0, 8));
    expect(blockChangeFrom(before, before)).toBe(before.blocks.length);
    const appended = applyHarnessEvents(before, stamped.slice(8, 9));
    // The approval attaches to the existing tool block (index 3).
    expect(blockChangeFrom(before, appended)).toBe(3);
    const grown = applyHarnessEvents(appended, stamped.slice(11, 12));
    expect(blockChangeFrom(appended, grown)).toBe(appended.blocks.length);
  });
});

describe('window fold (renderer holding only the tail)', () => {
  it('matches the tail of the full fold when the window starts at the open turn', () => {
    const stamped = stampAll([
      { type: 'user.message', text: 'first', clientMessageId: 'client-0010' },
      { type: 'message.delta', text: 'one' },
      { type: 'turn.ended', outcome: 'completed' },
      ...turn,
    ]);
    const atSnapshot = applyHarnessEvents(base(), stamped.slice(0, 12));
    // The daemon starts the window at the open turn's user block (index 2).
    const baseIndex = 2;
    expect(atSnapshot.blocks[baseIndex]!.role).toBe('user');
    const window: Session = { ...atSnapshot, blocks: atSnapshot.blocks.slice(baseIndex) };
    const rest = stamped.slice(12);
    const full = applyHarnessEvents(atSnapshot, rest);
    expect(blockChangeFrom(atSnapshot, full)).toBe(baseIndex);
    const folded = applyHarnessEvents(window, rest);
    expect(baseIndex + folded.blocks.length).toBe(full.blocks.length);
    expect(folded.blocks).toEqual(full.blocks.slice(baseIndex));
    expect(folded.blocks.at(-1)?.id).toBe(full.blocks.at(-1)?.id);
    const { blocks: _w, ...windowHead } = folded;
    const { blocks: _f, ...fullHead } = full;
    expect(windowHead).toEqual(fullHead);
  });

  it('applies head-only events without touching blocks', () => {
    const atSnapshot = applyHarnessEvents(base(), stampAll(turn.slice(0, 6)));
    const head = applyHarnessEvents(atSnapshot, stampAll([
      { type: 'background.updated', tasks: ['tests'] },
      { type: 'context', used: 1200, window: 200_000 },
      { type: 'usage.limited', resetsAt: 99 },
    ], 7));
    expect(blockChangeFrom(atSnapshot, head)).toBe(head.blocks.length);
    expect(head).toMatchObject({ backgroundTasks: ['tests'], usageLimit: { resetsAt: 99 }, context: { used: 1200 } });
  });

  it('folds a mid-turn process exit as a failed turn', () => {
    const exited = applyHarnessEvents(base(), stampAll([
      { type: 'user.message', text: 'go', clientMessageId: 'client-0004' },
      { type: 'message.delta', text: 'work' },
      { type: 'session.ended', code: 1 },
    ]));
    expect(exited.busy).toBe(false);
    expect(exited.blocks[0]!.outcome).toBe('failed');
  });

  it('signals a re-snapshot when the turn end touches a user block outside the window', () => {
    const stamped = stampAll(turn);
    const atSnapshot = applyHarnessEvents(base(), stamped.slice(0, 9));
    const full = applyHarnessEvents(atSnapshot, stamped.slice(9));
    // A window that starts after the open turn's user block (index 0) cannot
    // record the turn's outcome: touchedFrom (0) < baseIndex (2).
    expect(blockChangeFrom(atSnapshot, full)).toBe(0);
  });
});
