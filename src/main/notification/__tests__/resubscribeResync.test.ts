// #2263 — after the daemon drops main's event subscription and the health
// probe subscribes again, everything pushed in between is gone. The resync
// reads each pane from the daemon once and corrects only where the pane shows
// something else, without notifying anyone.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const last = new Map<string, string>();
  const broadcastMetadataUpdate = vi.fn((_win: unknown, payload: { ptyId?: string; agentStatus?: string }) => {
    if (payload.ptyId && payload.agentStatus !== undefined) last.set(payload.ptyId, payload.agentStatus);
  });
  return { last, broadcastMetadataUpdate };
});

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: mocks.broadcastMetadataUpdate,
  getLastBroadcastAgentStatus: (ptyId: string) => mocks.last.get(ptyId),
  hasOutstandingRunningClaim: () => false,
}));

import { resyncAfterResubscribe, type DaemonPaneState } from '../resubscribeResync';
import { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { SignalLatencyMeter } from '../../../shared/hooks/SignalLatencyMeter';

function run(states: Record<string, DaemonPaneState | null>, router: HookSignalRouter | null = null) {
  const titles: Array<[string, string]> = [];
  const result = resyncAfterResubscribe({
    listSessionIds: async () => Object.keys(states),
    readState: async (id) => states[id] ?? null,
    emitTitle: (id, title) => { titles.push([id, title]); },
    hookRouter: router,
    win: null,
  });
  return { result, titles };
}

function statuses(): Array<{ ptyId?: string; agentStatus?: string; settled?: boolean }> {
  return mocks.broadcastMetadataUpdate.mock.calls.map((c) => c[1] as { ptyId?: string; agentStatus?: string; settled?: boolean });
}

describe('resyncAfterResubscribe (#2263)', () => {
  let router: HookSignalRouter;

  beforeEach(() => {
    mocks.last.clear();
    mocks.broadcastMetadataUpdate.mockClear();
    router = new HookSignalRouter({ latencyMeter: new SignalLatencyMeter() });
  });

  it('lights a pane whose turn started in the gap (a missed `active`)', async () => {
    mocks.last.set('d1', 'idle');
    const { result } = run({ d1: { agentStatus: 'running', agentName: 'Codex', turnOpen: true } });
    expect((await result).statusesCorrected).toBe(1);
    expect(statuses()).toEqual([{ ptyId: 'd1', agentStatus: 'running', agentName: 'Codex' }]);
  });

  it('reads an open turn that is thinking quietly as running, and takes the latch its missed hook would have set', async () => {
    mocks.last.set('d1', 'idle');
    const { result } = run({ d1: { agentStatus: 'idle', agentName: 'Claude Code', turnOpen: true, hookReports: true } }, router);
    await result;
    expect(statuses()).toEqual([{ ptyId: 'd1', agentStatus: 'running', agentName: 'Claude Code' }]);
    expect(router.governsRunningState('d1')).toBe(true);
  });

  it('takes no latch for a turn open without hooks', async () => {
    mocks.last.set('d1', 'idle');
    const { result } = run({ d1: { agentStatus: 'running', agentName: 'Codex', turnOpen: true, hookReports: false } }, router);
    await result;
    expect(router.governsRunningState('d1')).toBe(false);
  });

  it('settles a pane whose turn ended in the gap, latch and activity stamp included', async () => {
    mocks.last.set('d1', 'running');
    router.noteHookTurnStart('d1', Date.now(), 'claude');
    const { result } = run({ d1: { agentStatus: 'idle', agentName: 'Claude Code', turnOpen: false } }, router);
    expect((await result).statusesCorrected).toBe(1);
    expect(router.governsRunningState('d1')).toBe(false);
    expect(statuses()).toEqual([{ ptyId: 'd1', agentStatus: 'idle', settled: true }]);
  });

  it('shows a result reached in the gap and releases the latch, without a notification path', async () => {
    mocks.last.set('d1', 'running');
    router.noteHookTurnStart('d1', Date.now(), 'claude');
    const { result } = run({ d1: { agentStatus: 'complete', agentName: 'Claude Code', turnOpen: false } }, router);
    await result;
    expect(router.governsRunningState('d1')).toBe(false);
    expect(statuses()).toEqual([{ ptyId: 'd1', agentStatus: 'complete', agentName: 'Claude Code' }]);
  });

  it('leaves an unread result alone when the daemon pane is idle', async () => {
    mocks.last.set('d1', 'complete');
    mocks.last.set('d2', 'waiting');
    const { result } = run({
      d1: { agentStatus: 'idle', agentName: 'Claude Code', turnOpen: false },
      d2: { agentStatus: 'idle', agentName: 'Codex', turnOpen: false },
    });
    expect((await result).statusesCorrected).toBe(0);
    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('does not act on an idle status from an older daemon that cannot say whether a turn is open', async () => {
    mocks.last.set('d1', 'running');
    const { result } = run({ d1: { agentStatus: 'idle', agentName: 'Claude Code' } });
    expect((await result).statusesCorrected).toBe(0);
    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('sends every pane\'s title, and skips an empty one', async () => {
    const { result, titles } = run({
      d1: { agentStatus: 'idle', agentName: null, title: '✳ 50번째 소수', turnOpen: false },
      d2: { agentStatus: 'idle', agentName: null, title: '', turnOpen: false },
    });
    expect((await result).titles).toBe(1);
    expect(titles).toEqual([['d1', '✳ 50번째 소수']]);
  });

  it('skips a pane it could not read and keeps going', async () => {
    mocks.last.set('d2', 'idle');
    const { result } = run({ d1: null, d2: { agentStatus: 'running', agentName: 'Codex', turnOpen: true } });
    const r = await result;
    expect(r.panes).toBe(1);
    expect(r.statusesCorrected).toBe(1);
  });

  it('changes nothing on a second pass', async () => {
    mocks.last.set('d1', 'idle');
    mocks.last.set('d2', 'running');
    const states: Record<string, DaemonPaneState> = {
      d1: { agentStatus: 'running', agentName: 'Codex', turnOpen: true },
      d2: { agentStatus: 'complete', agentName: 'Claude Code', turnOpen: false },
    };
    expect((await run(states, router).result).statusesCorrected).toBe(2);
    mocks.broadcastMetadataUpdate.mockClear();
    expect((await run(states, router).result).statusesCorrected).toBe(0);
    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });
});
