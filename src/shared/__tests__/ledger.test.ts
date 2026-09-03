import { describe, expect, it } from 'vitest';
import {
  LEDGER_STATUSES,
  canActorSet,
  LEDGER_TRANSITIONS,
  WORKER_SETTABLE_STATUSES,
  canTransition,
  isLedgerStatus,
} from '../ledger';

describe('ledger vocabulary', () => {
  it('reserves completed for the brain and reaches it only from review_requested', () => {
    expect(WORKER_SETTABLE_STATUSES).not.toContain('completed');
    expect(WORKER_SETTABLE_STATUSES).not.toContain('cancelled');
    const sources = LEDGER_STATUSES.filter((s) => s !== 'completed' && canTransition(s, 'completed'));
    expect(sources).toEqual(['review_requested']);
  });

  it('keeps completed and cancelled terminal, and every status in the transition table', () => {
    expect(LEDGER_TRANSITIONS.completed).toEqual([]);
    expect(LEDGER_TRANSITIONS.cancelled).toEqual([]);
    for (const s of LEDGER_STATUSES) expect(Object.keys(LEDGER_TRANSITIONS)).toContain(s);
    expect(isLedgerStatus('review_requested')).toBe(true);
    expect(isLedgerStatus('done')).toBe(false);
    expect(canTransition('done', 'working')).toBe(false);
    expect(canTransition('working', 'done')).toBe(false);
  });
});

describe('ledger authorization and idempotency', () => {
  const entry = {
    schemaVersion: 1 as const,
    id: 't1',
    taskWorkspaceId: 'ws-task',
    ownerWorkspaceId: 'ws-brain',
    title: 't',
    status: 'working' as const,
    rev: 3,
    updatedAt: 0,
    updatedBy: { kind: 'system' as const, workspaceId: 'daemon' },
  };

  it('scopes workers to their own task and worker-settable statuses only', () => {
    expect(canActorSet({ kind: 'worker', workspaceId: 'ws-task' }, entry, 'review_requested')).toBe(true);
    expect(canActorSet({ kind: 'worker', workspaceId: 'ws-task' }, entry, 'completed')).toBe(false);
    expect(canActorSet({ kind: 'worker', workspaceId: 'ws-other' }, entry, 'working')).toBe(false);
    expect(canActorSet({ kind: 'brain', workspaceId: 'ws-brain' }, entry, 'cancelled')).toBe(true);
    expect(canActorSet({ kind: 'brain', workspaceId: 'ws-other' }, entry, 'cancelled')).toBe(false);
  });

  it('treats a same-status resubmit as an allowed no-op', () => {
    expect(canTransition('working', 'working')).toBe(true);
    expect(canTransition('completed', 'completed')).toBe(true);
    expect(canTransition('review_requested', 'input_required')).toBe(true);
  });
});
