import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createA2aSlice } from '../a2aSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// Cold-park (TASK-9) park/unpark state machine. Uses a minimal store that
// satisfies WorkspaceSlice plus the multiviewIds field the sweep reads.
type TestState = WorkspaceSlice & { multiviewIds: string[] };

function createTestStore(workspaces: Workspace[], activeId: string, multiviewIds: string[] = []) {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      workspaces,
      activeWorkspaceId: activeId,
      multiviewIds,
    }))
  );
}

const THRESHOLD = 5 * 60 * 1000;

describe('WorkspaceSlice cold-park', () => {
  let wsA: Workspace;
  let wsB: Workspace;
  let wsC: Workspace;

  beforeEach(() => {
    wsA = createWorkspace('A');
    wsB = createWorkspace('B');
    wsC = createWorkspace('C');
  });

  it('parks a hidden workspace only after it stays idle past the threshold', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    const t0 = 1_000_000;
    // First sweep observes B hidden → starts its idle clock, does not park yet.
    store.getState().sweepColdPark(t0, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
    expect(store.getState().lastVisibleAt[wsB.id]).toBe(t0);
    // Still within the window → not parked.
    store.getState().sweepColdPark(t0 + THRESHOLD - 1, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
    // Past the window → parked.
    store.getState().sweepColdPark(t0 + THRESHOLD, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBe(true);
    // The active workspace is never parked.
    expect(store.getState().parkedWorkspaceIds[wsA.id]).toBeUndefined();
  });

  it('never parks a multiview member and clears its idle clock', () => {
    const store = createTestStore([wsA, wsB, wsC], wsA.id, [wsA.id, wsB.id]);
    const t0 = 1_000_000;
    store.getState().sweepColdPark(t0, THRESHOLD);
    store.getState().sweepColdPark(t0 + THRESHOLD * 2, THRESHOLD);
    // B is a visible multiview member → never parked, no idle stamp.
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
    expect(store.getState().lastVisibleAt[wsB.id]).toBeUndefined();
    // C is hidden and idle → parked.
    expect(store.getState().parkedWorkspaceIds[wsC.id]).toBe(true);
  });

  it('never parks a workspace that holds a non-terminal surface', () => {
    // Give B a browser surface — its live webview state has no daemon-side
    // replay, so cold-park must skip it even when idle past the threshold.
    const leaf = wsB.rootPane;
    if (leaf.type === 'leaf') {
      leaf.surfaces.push({
        id: 'surf-browser',
        ptyId: '',
        title: 'browser',
        shell: '',
        cwd: '',
        surfaceType: 'browser',
        browserUrl: 'https://example.com',
      });
      leaf.activeSurfaceId = 'surf-browser';
    }
    const store = createTestStore([wsA, wsB], wsA.id);
    const t0 = 1_000_000;
    store.getState().sweepColdPark(t0, THRESHOLD);
    store.getState().sweepColdPark(t0 + THRESHOLD * 2, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
  });

  it('un-parks a parked workspace that gains a non-terminal surface', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    const t0 = 1_000_000;
    store.getState().sweepColdPark(t0, THRESHOLD);
    store.getState().sweepColdPark(t0 + THRESHOLD, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBe(true);
    // A browser.open targeting the parked workspace adds a webview surface — the
    // next sweep must unpark it so the surface mounts (not blank until reveal).
    store.setState((s) => {
      const leaf = s.workspaces.find((w) => w.id === wsB.id)!.rootPane;
      if (leaf.type === 'leaf') {
        leaf.surfaces.push({
          id: 'surf-browser', ptyId: '', title: 'b', shell: '', cwd: '',
          surfaceType: 'browser', browserUrl: 'https://example.com',
        });
      }
    });
    store.getState().sweepColdPark(t0 + THRESHOLD * 2, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
  });

  it('setActiveWorkspace un-parks the incoming workspace synchronously', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    // Park B.
    const t0 = 1_000_000;
    store.getState().sweepColdPark(t0, THRESHOLD);
    store.getState().sweepColdPark(t0 + THRESHOLD, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBe(true);
    // Switching to B releases it in the same mutation (same-frame reveal).
    store.getState().setActiveWorkspace(wsB.id);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
    expect(store.getState().lastVisibleAt[wsB.id]).toBeUndefined();
    // A is now the outgoing workspace → its idle clock started.
    expect(store.getState().lastVisibleAt[wsA.id]).toBeGreaterThan(0);
  });

  it('removeWorkspace un-parks the workspace it promotes to active', () => {
    // Combined store so removeWorkspace can see a2aTasks (fail-delegated path).
    const store = create<WorkspaceSlice & ReturnType<typeof createA2aSlice> & { multiviewIds: string[] }>()(
      immer((...args) => ({
        // @ts-expect-error — minimal composed store doesn't match full StoreState
        ...createWorkspaceSlice(...args),
        // @ts-expect-error — same
        ...createA2aSlice(...args),
        workspaces: [wsA, wsB],
        activeWorkspaceId: wsA.id,
        multiviewIds: [],
      })),
    );
    // Park B while A is active.
    const t0 = 1_000_000;
    store.getState().sweepColdPark(t0, THRESHOLD);
    store.getState().sweepColdPark(t0 + THRESHOLD, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBe(true);
    // Removing the active workspace promotes B to active directly (not via
    // setActiveWorkspace) — the park entry must be cleared so B isn't rendered
    // as a blank parked viewport.
    store.getState().removeWorkspace(wsA.id);
    expect(store.getState().activeWorkspaceId).toBe(wsB.id);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
  });

  it('unparkWorkspace releases a parked workspace and resets its clock', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    const t0 = 1_000_000;
    store.getState().sweepColdPark(t0, THRESHOLD);
    store.getState().sweepColdPark(t0 + THRESHOLD, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBe(true);
    store.getState().unparkWorkspace(wsB.id);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
    expect(store.getState().lastVisibleAt[wsB.id]).toBeUndefined();
  });

  it('re-parks a workspace after it is hidden again post-reveal', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    // Reveal B then switch back to A. setActiveWorkspace stamps the outgoing
    // workspace with the real wall clock, so the re-park sweeps below anchor on
    // Date.now() to stay on the same clock as the switch.
    store.getState().setActiveWorkspace(wsB.id);
    store.getState().setActiveWorkspace(wsA.id);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
    const stamped = store.getState().lastVisibleAt[wsB.id];
    expect(stamped).toBeGreaterThan(0);
    // Fresh clock — not yet past the window.
    store.getState().sweepColdPark(stamped + THRESHOLD - 1, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBeUndefined();
    // Past the window → re-parked.
    store.getState().sweepColdPark(stamped + THRESHOLD, THRESHOLD);
    expect(store.getState().parkedWorkspaceIds[wsB.id]).toBe(true);
  });
});
