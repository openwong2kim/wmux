// Unit tests for the level-review heartbeat: it fires flushSnapshot ONLY when
// every condition holds (enabled, mode!=off, not busy, no pending decision, an
// attention pane present, not recently woken) and skips each otherwise. Plus a
// tiny test for the additive CommanderEventCoalescer.lastWakeAt accessor the
// heartbeat reads.

import { describe, it, expect, vi } from 'vitest';
import { DeckHeartbeat, type DeckHeartbeatDeps } from '../DeckHeartbeat';
import { CommanderEventCoalescer } from '../CommanderEventCoalescer';
import type { WorkspaceAutonomy } from '../deckAutonomyStore';
import type { WorkspaceDecision } from '../deckDecisionStore';
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

describe('DeckHeartbeat — WP3 stale-decision re-examine', () => {
  const TTL = 30 * 60_000;
  const NOW = 10_000_000;

  const pending = (raisedAt: number, id = 'd1'): WorkspaceDecision => ({
    id,
    question: 'Q?',
    options: [],
    context: '',
    status: 'pending',
    raisedAt,
  });

  /** Deps for the re-examine path: a pending decision gate is present, and the
   *  WP3 seams (getDecision / decisionTtlMs / reExamineDecision) are wired. The
   *  snapshot flush must NEVER fire on this path (the pending gate stops before
   *  it), so we assert on `reExamine` and keep `flush` as a leak sentinel. */
  function makeReExamineDeps(over: Partial<DeckHeartbeatDeps> = {}): {
    deps: DeckHeartbeatDeps;
    reExamine: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
  } {
    const reExamine = vi.fn();
    const flush = vi.fn();
    const deps: DeckHeartbeatDeps = {
      getWorkspaceIds: () => ['ws-1'],
      getAutonomy: () => autonomy('auto'),
      isBusy: () => false,
      hasPendingDecision: () => true,
      getFleetSnapshot: () => attentionSnapshot(),
      flushSnapshot: flush,
      lastWakeAt: () => null,
      isEnabled: () => true,
      intervalMs: INTERVAL,
      now: () => NOW,
      getDecision: () => pending(NOW - TTL - 1), // stale by 1ms
      decisionTtlMs: TTL,
      reExamineDecision: reExamine,
      ...over,
    };
    return { deps, reExamine, flush };
  }

  it('fires a re-examine (and NOT a snapshot flush) for a stale pending decision', () => {
    const { deps, reExamine, flush } = makeReExamineDeps();
    new DeckHeartbeat(deps).tick();
    expect(reExamine).toHaveBeenCalledTimes(1);
    expect(reExamine).toHaveBeenCalledWith('ws-1', expect.objectContaining({ id: 'd1' }));
    // Bypass does NOT leak into the ordinary snapshot wake.
    expect(flush).not.toHaveBeenCalled();
  });

  it('does NOT re-examine a pending decision that is not yet stale', () => {
    const { deps, reExamine } = makeReExamineDeps({ getDecision: () => pending(NOW - TTL + 1) });
    new DeckHeartbeat(deps).tick();
    expect(reExamine).not.toHaveBeenCalled();
  });

  it('does NOT re-examine when there is no decision (defensive — gate said pending)', () => {
    const { deps, reExamine } = makeReExamineDeps({ getDecision: () => null });
    new DeckHeartbeat(deps).tick();
    expect(reExamine).not.toHaveBeenCalled();
  });

  it('does NOT re-examine when the TTL is unset (feature off)', () => {
    const { deps, reExamine } = makeReExamineDeps({ decisionTtlMs: 0 });
    new DeckHeartbeat(deps).tick();
    expect(reExamine).not.toHaveBeenCalled();
  });

  it('does NOT re-examine a busy or off workspace (gated before the decision check)', () => {
    const busy = makeReExamineDeps({ isBusy: () => true });
    new DeckHeartbeat(busy.deps).tick();
    expect(busy.reExamine).not.toHaveBeenCalled();

    const off = makeReExamineDeps({ getAutonomy: () => autonomy('off') });
    new DeckHeartbeat(off.deps).tick();
    expect(off.reExamine).not.toHaveBeenCalled();
  });

  it('debounces: at most one re-ping per TTL for the same decision id, re-firing after another TTL', () => {
    let now = NOW;
    const { deps, reExamine } = makeReExamineDeps({ now: () => now });
    const hb = new DeckHeartbeat(deps);
    hb.tick();
    expect(reExamine).toHaveBeenCalledTimes(1); // stale → fires
    now += TTL - 1;
    hb.tick();
    expect(reExamine).toHaveBeenCalledTimes(1); // within the same TTL window → suppressed
    now += 2; // now > NOW + TTL since last re-ping
    hb.tick();
    expect(reExamine).toHaveBeenCalledTimes(2); // TTL elapsed → re-fires
  });

  it('re-fires immediately when the decision id changes (brain re-raised a sharper question)', () => {
    let decision = pending(NOW - TTL - 1, 'd1');
    const { deps, reExamine } = makeReExamineDeps({ getDecision: () => decision });
    const hb = new DeckHeartbeat(deps);
    hb.tick();
    expect(reExamine).toHaveBeenCalledTimes(1);
    // A re-raise: a NEW id, also already older than the TTL (raisedAt back-dated).
    decision = pending(NOW - TTL - 1, 'd2');
    hb.tick();
    expect(reExamine).toHaveBeenCalledTimes(2);
    expect(reExamine).toHaveBeenLastCalledWith('ws-1', expect.objectContaining({ id: 'd2' }));
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
