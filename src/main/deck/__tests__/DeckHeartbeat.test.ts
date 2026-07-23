// Unit tests for the level-review heartbeat: it fires flushSnapshot ONLY when
// every condition holds (enabled, mode!=off, not busy, no pending decision, an
// attention pane present, not recently woken) and skips each otherwise. Plus a
// tiny test for the additive CommanderEventCoalescer.lastWakeAt accessor the
// heartbeat reads.

import { describe, it, expect, vi } from 'vitest';
import { DeckHeartbeat, type DeckHeartbeatDeps } from '../DeckHeartbeat';
import { CommanderEventCoalescer } from '../CommanderEventCoalescer';
import type { WorkspaceAutonomy } from '../deckAutonomyStore';
import type { FleetSnapshot } from '../../../shared/workspaceMirror';

const INTERVAL = 180_000;

const autonomy = (mode: WorkspaceAutonomy['mode']): WorkspaceAutonomy => ({
  mode,
  summarize: true,
  continueInstruction: mode !== 'off',
  approvalPress: mode === 'auto',
});

const attentionSnapshot = (ws = 'ws-1'): FleetSnapshot => ({
  workspaceId: ws,
  ts: 0,
  panes: [
    { ptyId: 'p1', agentName: 'claude', agentStatus: 'awaiting_input', isActivePane: true },
    { ptyId: 'p2', agentName: 'codex', agentStatus: 'running', isActivePane: false },
  ],
});

const idleSnapshot = (ws = 'ws-1'): FleetSnapshot => ({
  workspaceId: ws,
  ts: 0,
  panes: [{ ptyId: 'p1', agentName: 'claude', agentStatus: 'running', isActivePane: true }],
});

/** Build heartbeat deps with sensible "everything fires" defaults, overridable. */
function makeDeps(over: Partial<DeckHeartbeatDeps> = {}): {
  deps: DeckHeartbeatDeps;
  flush: ReturnType<typeof vi.fn>;
} {
  const flush = vi.fn();
  const deps: DeckHeartbeatDeps = {
    getWorkspaceIds: () => ['ws-1'],
    getAutonomy: () => autonomy('auto'),
    isBusy: () => false,
    hasPendingDecision: () => false,
    getFleetSnapshot: () => attentionSnapshot(),
    flushSnapshot: flush,
    lastWakeAt: () => null,
    isEnabled: () => true,
    intervalMs: INTERVAL,
    now: () => 1_000_000,
    ...over,
  };
  return { deps, flush };
}

describe('DeckHeartbeat — tick fire conditions', () => {
  it('fires flushSnapshot with the mirror snapshot when every condition holds', () => {
    const snap = attentionSnapshot();
    const { deps, flush } = makeDeps({ getFleetSnapshot: () => snap });
    new DeckHeartbeat(deps).tick();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('ws-1', snap); // the mirror's snapshot, verbatim
  });

  it('skips when the heartbeat is disabled', () => {
    const { deps, flush } = makeDeps({ isEnabled: () => false });
    new DeckHeartbeat(deps).tick();
    expect(flush).not.toHaveBeenCalled();
  });

  it('skips a workspace whose mode is off', () => {
    const { deps, flush } = makeDeps({ getAutonomy: () => autonomy('off') });
    new DeckHeartbeat(deps).tick();
    expect(flush).not.toHaveBeenCalled();
  });

  it('skips a busy workspace (a review must not race an in-flight turn)', () => {
    const { deps, flush } = makeDeps({ isBusy: () => true });
    new DeckHeartbeat(deps).tick();
    expect(flush).not.toHaveBeenCalled();
  });

  it('skips a workspace with a pending decision gate', () => {
    const { deps, flush } = makeDeps({ hasPendingDecision: () => true });
    new DeckHeartbeat(deps).tick();
    expect(flush).not.toHaveBeenCalled();
  });

  it('skips when no pane needs attention (all-idle fleet)', () => {
    const { deps, flush } = makeDeps({ getFleetSnapshot: () => idleSnapshot() });
    new DeckHeartbeat(deps).tick();
    expect(flush).not.toHaveBeenCalled();
  });

  it('skips when there is no snapshot at all (mirror never populated)', () => {
    const { deps, flush } = makeDeps({ getFleetSnapshot: () => null });
    new DeckHeartbeat(deps).tick();
    expect(flush).not.toHaveBeenCalled();
  });

  it('skips a recently-woken workspace (within intervalMs of the last wake)', () => {
    const now = 1_000_000;
    const { deps, flush } = makeDeps({ now: () => now, lastWakeAt: () => now - (INTERVAL - 1) });
    new DeckHeartbeat(deps).tick();
    expect(flush).not.toHaveBeenCalled();
  });

  it('fires when the last wake is at least intervalMs old', () => {
    const now = 1_000_000;
    const { deps, flush } = makeDeps({ now: () => now, lastWakeAt: () => now - INTERVAL });
    new DeckHeartbeat(deps).tick();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('reviews every armed workspace in one pass', () => {
    const { deps, flush } = makeDeps({
      getWorkspaceIds: () => ['ws-1', 'ws-2'],
      getFleetSnapshot: (ws) => attentionSnapshot(ws),
    });
    new DeckHeartbeat(deps).tick();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledWith('ws-2', expect.objectContaining({ workspaceId: 'ws-2' }));
  });

  it('a throwing probe on one workspace never aborts the pass (best-effort)', () => {
    const { deps, flush } = makeDeps({
      getWorkspaceIds: () => ['bad', 'ws-1'],
      isBusy: (ws) => {
        if (ws === 'bad') throw new Error('torn store');
        return false;
      },
    });
    new DeckHeartbeat(deps).tick();
    // 'bad' throws (skipped, treated as busy=fallback → skip) but ws-1 still fires.
    expect(flush).toHaveBeenCalledWith('ws-1', expect.anything());
  });
});

describe('DeckHeartbeat — timer lifecycle', () => {
  it('start() schedules on the cadence and does NOT fire immediately', () => {
    vi.useFakeTimers();
    try {
      const { deps, flush } = makeDeps();
      const hb = new DeckHeartbeat(deps);
      hb.start();
      expect(flush).not.toHaveBeenCalled(); // no immediate tick, unlike the scheduler
      vi.advanceTimersByTime(INTERVAL);
      expect(flush).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(INTERVAL);
      expect(flush).toHaveBeenCalledTimes(2);
      hb.stop();
      vi.advanceTimersByTime(INTERVAL * 3);
      expect(flush).toHaveBeenCalledTimes(2); // stopped — no more ticks
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CommanderEventCoalescer.lastWakeAt (WP4 additive accessor)', () => {
  it('is null before any wake and returns the last accepted wake timestamp after', async () => {
    const coalescer = new CommanderEventCoalescer({
      runTurn: async () => ({ ok: true }),
      isBusy: () => false,
      getAutonomy: () => autonomy('auto'),
      now: () => 5_000,
    });
    expect(coalescer.lastWakeAt('ws-1')).toBeNull();
    // A level-snapshot flush with an attention pane is accepted → records a wake.
    coalescer.flushSnapshot('ws-1', attentionSnapshot());
    await new Promise((r) => setTimeout(r, 0)); // let the runTurn().then record the wake
    expect(coalescer.lastWakeAt('ws-1')).toBe(5_000);
    coalescer.dispose();
  });
});
