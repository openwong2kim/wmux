// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useStore } from '../../index';
import { selectFleetBoard, selectFleetSectionCounts } from '../fleet';
import { seedFleetTriageStore } from '../../../utils/__tests__/fleetTriageFixture';

function boardCounts() {
  const { groups } = selectFleetBoard(useStore.getState(), { now: Date.now(), sortMode: 'attention' });
  return { needsYou: groups.needsYou.length, running: groups.running.length };
}

describe('selectFleetSectionCounts', () => {
  it('equals the Fleet board section sizes across states', () => {
    seedFleetTriageStore(Date.now());
    const steps: Partial<ReturnType<typeof useStore.getState>>[] = [
      {},
      { surfaceAgentStatus: { 'pty-5': 'error', 'pty-4': 'complete' } },
      { supervisionByPtyId: { 'pty-4': { status: 'stopped', restartCount: 3 } } as never },
      { surfacePendingQuestion: {}, surfaceAgentStatus: { 'pty-2b': 'waiting' } },
      { surfaceAgent: {}, surfaceTurnOpenAt: {}, remoteWorkspaces: [] },
      { surfaceAgentStatus: {}, supervisionByPtyId: {} },
    ];
    for (const step of steps) {
      useStore.setState(step);
      expect(selectFleetSectionCounts(useStore.getState())).toEqual(boardCounts());
    }
  });

  it('returns the same object when only output stamps or the clock move', () => {
    const now = Date.now();
    seedFleetTriageStore(now);
    const first = selectFleetSectionCounts(useStore.getState());
    useStore.setState({ surfaceOutputAt: { 'pty-1': now + 1 }, agentClockMs: now + 2_000, surfaceLastMessage: { 'pty-1': 'hi' } });
    expect(selectFleetSectionCounts(useStore.getState())).toBe(first);
    // An input that moves a section is not memoized away.
    useStore.setState({ surfaceAgentStatus: {} , surfacePendingQuestion: {} });
    expect(selectFleetSectionCounts(useStore.getState())).toEqual(boardCounts());
    expect(selectFleetSectionCounts(useStore.getState()).needsYou).toBe(1);
  });
});
