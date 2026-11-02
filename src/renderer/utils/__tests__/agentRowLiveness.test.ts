import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../../stores';
import {
  applyProcessExits,
  clearSurfaceAgentOnProcessExit,
  clearSurfaceAgentsKnownGone,
  livenessSnapshotRequested,
  livenessSnapshotSettled,
} from '../agentRowLiveness';
import { planLiveAgentSeed } from '../../channels/agentCandidateSeed';

// A pane's sidebar agent row exists while surfaceAgent[ptyId] has a name
// (selectWorkspaceAgentRoster). These pin when the daemon's agent
// process-death edge drops it, and that the 15 s poll still does.
describe('agent row liveness', () => {
  beforeEach(() => {
    useStore.setState((state) => {
      state.surfaceAgent = {};
      state.surfaceActivityAt = {};
      state.commandRunningByPtyId = {};
      state.agentAliveByPtyId = {};
    });
    livenessSnapshotSettled(Number.NaN); // nothing in flight: retires every edge mark
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** Asks for a liveness snapshot as the poll does, at a given clock. */
  const requestAt = (now: number) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const requestedAt = livenessSnapshotRequested();
    vi.restoreAllMocks();
    return requestedAt;
  };

  const claudeIn = (ptyId: string) => useStore.getState().setSurfaceAgent(ptyId, 'Claude Code', 'idle', 'claude');
  const row = (ptyId: string) => useStore.getState().surfaceAgent[ptyId];

  it('the death edge of the pane\'s agent drops its row at once, without a poll', () => {
    claudeIn('p1');
    useStore.setState((state) => { state.surfaceActivityAt.p1 = 100; });
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    expect(row('p1')).toBeUndefined();
    // As the poll's alive=false branch: evidence from before the edge goes too.
    expect(useStore.getState().surfaceActivityAt.p1).toBeUndefined();
  });

  it('keeps the running evidence while a foreground command still runs, as the poll does', () => {
    claudeIn('p1');
    useStore.setState((state) => {
      state.surfaceActivityAt.p1 = 100;
      state.commandRunningByPtyId.p1 = true;
    });
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    expect(row('p1')).toBeUndefined();
    expect(useStore.getState().surfaceActivityAt.p1).toBe(100);
  });

  it('another agent\'s death edge leaves the row: the pane now runs a different agent', () => {
    claudeIn('p1');
    clearSurfaceAgentOnProcessExit('p1', 'codex', 200);
    expect(row('p1')?.name).toBe('Claude Code');
  });

  it('a death edge without a slug clears nothing', () => {
    claudeIn('p1');
    clearSurfaceAgentOnProcessExit('p1', null, 200);
    expect(row('p1')?.name).toBe('Claude Code');
  });

  it('a custom or unknown pane agent keeps its row: the edge may be from an earlier agent there', () => {
    useStore.getState().setSurfaceAgent('p1', 'Some Wrapper', 'idle');
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    expect(row('p1')?.name).toBe('Some Wrapper');
    expect(useStore.getState().agentAliveByPtyId.p1).toBeUndefined();
  });

  it('the edge marks the pane\'s agent dead in the liveness map', () => {
    claudeIn('p1');
    useStore.setState((state) => { state.agentAliveByPtyId.p1 = true; });
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    expect(useStore.getState().agentAliveByPtyId.p1).toBe(false);
  });

  it('a poll answer asked for before the edge cannot bring the row back', () => {
    claudeIn('p1');
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    // Serialized before the death: the daemon still said alive, and named the agent.
    const sessions = [{ id: 'p1', liveAgent: 'claude' }];
    const alive: Record<string, boolean> = { p1: true };
    applyProcessExits(alive, 150);
    expect(alive.p1).toBe(false);
    clearSurfaceAgentsKnownGone(alive, {}, 150);
    expect(planLiveAgentSeed(sessions, useStore.getState().surfaceAgent, alive, {})).toEqual([]);
    expect(row('p1')).toBeUndefined();
  });

  it('a poll answer asked for after the edge is current: a relaunched agent is seeded', () => {
    claudeIn('p1');
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    const requestedAt = requestAt(250);
    const alive: Record<string, boolean> = { p1: true };
    applyProcessExits(alive, requestedAt);
    expect(alive.p1).toBe(true);
    expect(planLiveAgentSeed([{ id: 'p1', liveAgent: 'claude' }], useStore.getState().surfaceAgent, alive, {}))
      .toEqual([{ ptyId: 'p1', slug: 'claude', status: 'idle' }]);
    // Nothing asked for before the edge is in flight: the mark is retired.
    livenessSnapshotSettled(requestedAt);
    const later: Record<string, boolean> = { p1: true };
    applyProcessExits(later, 100);
    expect(later.p1).toBe(true);
  });

  it('an answer asked for before the edge that lands after a newer one still cannot bring the row back', () => {
    claudeIn('p1');
    const older = requestAt(150);
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    const newer = requestAt(250);
    // The poll asked for after the edge answers first: the agent is dead.
    const fresh: Record<string, boolean> = { p1: false };
    applyProcessExits(fresh, newer);
    clearSurfaceAgentsKnownGone(fresh, {}, newer);
    livenessSnapshotSettled(newer);
    // Then the answer asked for before the death lands, still saying alive.
    const stale: Record<string, boolean> = { p1: true };
    applyProcessExits(stale, older);
    expect(stale.p1).toBe(false);
    clearSurfaceAgentsKnownGone(stale, {}, older);
    expect(planLiveAgentSeed([{ id: 'p1', liveAgent: 'claude' }], useStore.getState().surfaceAgent, stale, {})).toEqual([]);
    expect(row('p1')).toBeUndefined();
    // With both settled the mark is retired.
    livenessSnapshotSettled(older);
    const later: Record<string, boolean> = { p1: true };
    applyProcessExits(later, 100);
    expect(later.p1).toBe(true);
  });

  it('a Claude death edge after the pane switched to Codex leaves the Codex row', () => {
    claudeIn('p1');
    // A detection update names the new agent but brings no slug.
    useStore.getState().setSurfaceAgent('p1', 'Codex CLI', 'running');
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    expect(row('p1')?.name).toBe('Codex CLI');
  });

  it('a status-only update keeps the slug', () => {
    claudeIn('p1');
    useStore.getState().setSurfaceAgent('p1', undefined, 'running');
    expect(row('p1')).toEqual({ name: 'Claude Code', status: 'running', slug: 'claude' });
  });

  it('only the edge\'s pane is touched', () => {
    claudeIn('p1');
    claudeIn('p2');
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    expect(row('p1')).toBeUndefined();
    expect(row('p2')?.name).toBe('Claude Code');
  });

  it('the poll still clears a pane the tracker never attributed (back at its prompt)', () => {
    claudeIn('p1');
    // No agentProcessAlive entry at all: the tracker never attributed this pane.
    clearSurfaceAgentsKnownGone({}, { p1: false }, 200);
    expect(row('p1')).toBeUndefined();
  });

  it('the poll leaves a pane whose agent is alive and still running', () => {
    claudeIn('p1');
    clearSurfaceAgentsKnownGone({ p1: true }, { p1: true }, 200);
    expect(row('p1')?.name).toBe('Claude Code');
  });
});
