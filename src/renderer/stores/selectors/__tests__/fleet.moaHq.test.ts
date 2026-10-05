// @vitest-environment jsdom
// Moa's HQ workspace is the main bot, not a worker: the Fleet board, its
// section counts and fleet.triage leave it out, while selectFleetPanes (the
// workspace mirror, per-workspace roll-ups) still lists it.
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';
import { selectFleetBoard, selectFleetPanes, selectFleetSectionCounts } from '../fleet';
import { buildFleetTriage } from '../../../utils/fleetTriage';
import { seedFleetTriageStore } from '../../../utils/__tests__/fleetTriageFixture';

const now = Date.now();
const boardWorkspaces = () => {
  const { panes, groups } = selectFleetBoard(useStore.getState(), { now, sortMode: 'attention' });
  const rows = [...groups.needsYou, ...groups.running, ...groups.idle].map((r) => r.pane.workspaceId);
  return { panes: panes.map((p) => p.workspaceId), rows };
};

describe('Fleet board without Moa\'s HQ', () => {
  beforeEach(() => seedFleetTriageStore(now, { moa: null, moaHqSeed: null }));

  it('lists ws-1 (needs you) while it is an ordinary workspace', () => {
    expect(boardWorkspaces().rows).toContain('ws-1');
    expect(useStore.getState().surfaceAgentStatus['pty-1']).toBe('awaiting_input');
  });

  it('leaves the HQ off the board, its counts and fleet.triage; selectFleetPanes keeps it', () => {
    const before = selectFleetSectionCounts(useStore.getState()).needsYou;
    useStore.setState({ moaHqSeed: 'ws-1' });
    const { panes, rows } = boardWorkspaces();
    expect(panes).not.toContain('ws-1');
    expect(rows).not.toContain('ws-1');
    expect(selectFleetSectionCounts(useStore.getState()).needsYou).toBe(before - 1);
    const triage = buildFleetTriage(useStore.getState(), { includeIdle: true }, now);
    expect([...triage.needsYou, ...triage.running, ...(triage.idle.rows ?? [])].map((r) => r.workspaceId)).not.toContain('ws-1');
    expect(selectFleetPanes(useStore.getState()).map((p) => p.workspaceId)).toContain('ws-1');
  });

  it('reads the HQ from Moa\'s state once main has answered', () => {
    const before = selectFleetSectionCounts(useStore.getState()).running;
    expect(boardWorkspaces().rows).toContain('ws-3');
    useStore.setState({ moa: { hq: { workspaceId: 'ws-3' } } as never });
    expect(boardWorkspaces().rows).not.toContain('ws-3');
    expect(selectFleetSectionCounts(useStore.getState()).running).toBe(before - 1);
  });
});
