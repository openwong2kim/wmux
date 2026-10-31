import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../stores';
import { applyProcessExits, clearSurfaceAgentOnProcessExit, clearSurfaceAgentsKnownGone } from '../agentRowLiveness';
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
    applyProcessExits({}, Number.POSITIVE_INFINITY); // retire every edge mark
  });

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
    const alive: Record<string, boolean> = { p1: true };
    applyProcessExits(alive, 250);
    expect(alive.p1).toBe(true);
    expect(planLiveAgentSeed([{ id: 'p1', liveAgent: 'claude' }], useStore.getState().surfaceAgent, alive, {}))
      .toEqual([{ ptyId: 'p1', slug: 'claude', status: 'idle' }]);
    // The mark is retired: a later stale-looking stamp no longer applies.
    const later: Record<string, boolean> = { p1: true };
    applyProcessExits(later, 100);
    expect(later.p1).toBe(true);
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
