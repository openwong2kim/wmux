import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkspaceSettleChange, WorkspaceSettleSnapshot } from '../../../shared/workspaceSettle';
import { WORKSPACE_SETTLE_UNDO_MS } from '../../../shared/workspaceSettle';
import { useStore } from '../../stores';
import { applyWorkspaceSettleChanges, IDLE_DAYS_SEND_DELAY_MS, sendWorkspaceSettleIdleDays } from '../useWorkspaceSettleBridge';

const snapshot: WorkspaceSettleSnapshot = { states: {}, idleDays: 3, hqWorkspaceId: null };
const command = vi.fn(async () => ({ ok: true as const, snapshot }));
vi.stubGlobal('window', { electronAPI: { workspaceSettle: { command } } });

function change(kind: WorkspaceSettleChange['kind'], extra: Partial<WorkspaceSettleChange> = {}): WorkspaceSettleChange {
  return { id: `c-${kind}`, workspaceId: 'ws-1', kind, cause: 'manual', undoable: true, at: 1, ...extra };
}

beforeEach(() => {
  command.mockClear();
  useStore.setState({
    ...useStore.getInitialState(),
    locale: 'en',
    workspaces: [{ id: 'ws-1', name: 'alpha' }] as unknown as ReturnType<typeof useStore.getState>['workspaces'],
  });
});

describe('applyWorkspaceSettleChanges', () => {
  it('stores the snapshot and raises an Undo toast that sends the undo verb', async () => {
    const next: WorkspaceSettleSnapshot = { states: { 'ws-1': { settled: { at: 1, reason: 'manual' } } }, idleDays: 5, hqWorkspaceId: null };
    applyWorkspaceSettleChanges({ snapshot: next, changes: [change('settled', { id: 'chg-9' })] });

    expect(useStore.getState().workspaceSettle).toEqual(next);
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('alpha settled');
    expect(toasts[0].durationMs).toBe(WORKSPACE_SETTLE_UNDO_MS);
    expect(toasts[0].action?.label).toBe('Undo');
    toasts[0].action!.onClick();
    expect(command).toHaveBeenCalledWith({ op: 'undo', changeId: 'chg-9' });
  });

  it('names the end time of a snooze and says when a workspace is back', () => {
    const until = new Date(2026, 9, 4, 20, 0).getTime();
    applyWorkspaceSettleChanges({
      snapshot: { states: { 'ws-1': { snoozedUntil: until } }, idleDays: 3, hqWorkspaceId: null },
      changes: [change('snoozed'), change('unsnoozed')],
    });
    const messages = useStore.getState().toasts.map((t) => t.message);
    expect(messages[0]).toMatch(/^alpha snoozed until /);
    expect(messages[1]).toBe('alpha is back');
  });

  it('raises no toast for unsettled, not-undoable or unknown-workspace changes', () => {
    applyWorkspaceSettleChanges({
      snapshot,
      changes: [
        change('unsettled'),
        change('settled', { undoable: false }),
        change('settled', { workspaceId: 'gone' }),
      ],
    });
    expect(useStore.getState().toasts).toEqual([]);
    expect(command).not.toHaveBeenCalled();
  });
});

describe('sendWorkspaceSettleIdleDays', () => {
  it('sends only the value typing settled on', () => {
    vi.useFakeTimers();
    try {
      sendWorkspaceSettleIdleDays(1);
      vi.advanceTimersByTime(IDLE_DAYS_SEND_DELAY_MS - 1);
      sendWorkspaceSettleIdleDays(14);
      vi.advanceTimersByTime(IDLE_DAYS_SEND_DELAY_MS);
      expect(command).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith({ op: 'setIdleDays', days: 14 });
    } finally {
      vi.useRealTimers();
    }
  });
});
