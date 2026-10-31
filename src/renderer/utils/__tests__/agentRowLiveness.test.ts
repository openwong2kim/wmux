import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../stores';
import { clearSurfaceAgentOnProcessExit, clearSurfaceAgentsKnownGone } from '../agentRowLiveness';

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

  it('an unknown pane agent cannot contradict the tracker', () => {
    useStore.getState().setSurfaceAgent('p1', 'Some Wrapper', 'idle');
    clearSurfaceAgentOnProcessExit('p1', 'claude', 200);
    expect(row('p1')).toBeUndefined();
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
