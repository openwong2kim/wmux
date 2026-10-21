// @vitest-environment jsdom
// The workspace an earlier version made Moa's HQ is an ordinary workspace now:
// the Fleet board, its section counts and fleet.triage list it like any other,
// whatever an earlier run left in localStorage.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useStore } from '../../index';
import { selectFleetBoard, selectFleetSectionCounts } from '../fleet';
import { buildFleetTriage } from '../../../utils/fleetTriage';
import { seedFleetTriageStore } from '../../../utils/__tests__/fleetTriageFixture';

const now = Date.now();
/** The key earlier versions remembered the HQ id under. */
const LEGACY_HQ_SEED_KEY = 'wmux.moa.hqWorkspaceId';

describe('Fleet board and a legacy HQ workspace', () => {
  beforeEach(() => {
    localStorage.setItem(LEGACY_HQ_SEED_KEY, 'ws-1');
    seedFleetTriageStore(now);
  });
  afterEach(() => localStorage.clear());

  it('lists, counts and triages it like any workspace', () => {
    const { panes, groups } = selectFleetBoard(useStore.getState(), { now, sortMode: 'attention' });
    expect(panes.map((p) => p.workspaceId)).toContain('ws-1');
    expect([...groups.needsYou, ...groups.running, ...groups.idle].map((r) => r.pane.workspaceId)).toContain('ws-1');
    expect(selectFleetSectionCounts(useStore.getState()).needsYou).toBeGreaterThan(0);
    const triage = buildFleetTriage(useStore.getState(), { includeIdle: true }, now);
    expect([...triage.needsYou, ...triage.running, ...(triage.idle.rows ?? [])].map((r) => r.workspaceId)).toContain('ws-1');
  });
});
