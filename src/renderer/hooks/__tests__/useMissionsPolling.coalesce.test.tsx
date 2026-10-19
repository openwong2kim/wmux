// @vitest-environment jsdom
//
// #2349 — the missions refresh runs at most one full pass (one
// task.mission.list per workspace) at a time, and a burst of workspace-set
// changes (a fan-out adding its task workspaces one by one) collapses into one
// debounced pass instead of a pass per change stacked on top of each other.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  // Every refreshMissions call of the pass in flight waits on this gate, so a
  // pass lasts until the test lets it finish (a pass in production takes as
  // long as ~90 daemon round-trips).
  gate: null as null | { promise: Promise<void>; open: () => void },
  inFlight: 0,
  maxInFlight: 0,
  passes: 0,
  // task.mission.list reads waiting at once: two passes overlapping would
  // hold more of them than there are workspaces.
  pendingReads: 0,
  maxPendingReads: 0,
}));

function newGate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

vi.mock('../../stores', async () => {
  const { create } = await import('zustand');
  const useStore = create(() => ({
    workspaces: [{ id: 'ws-0' }] as Array<{ id: string }>,
    missionByPaneGroup: {} as Record<string, unknown>,
    fanoutSpawnOwner: {} as Record<string, string>,
    fanoutProvenance: {} as Record<string, unknown>,
    // One provenance read per pass: it is what each pass starts with.
    refreshFanoutProvenance: vi.fn(async () => {
      mocks.passes += 1;
      mocks.inFlight += 1;
      mocks.maxInFlight = Math.max(mocks.maxInFlight, mocks.inFlight);
    }),
    refreshMissions: vi.fn(async () => {
      mocks.pendingReads += 1;
      mocks.maxPendingReads = Math.max(mocks.maxPendingReads, mocks.pendingReads);
      await mocks.gate?.promise;
      mocks.pendingReads -= 1;
    }),
    markFanoutRefreshSettled: vi.fn(() => {
      mocks.inFlight -= 1;
    }),
  }));
  return { useStore };
});

import { useStore as realUseStore } from '../../stores';
import { useMissionsPolling, MISSION_REFRESH_DEBOUNCE_MS } from '../useMissionsPolling';

/** The mocked store above, typed as what it is rather than the app's store. */
const useStore = realUseStore as unknown as {
  getState: () => { workspaces: Array<{ id: string }>; refreshMissions: ReturnType<typeof vi.fn> };
  setState: (partial: { workspaces: Array<{ id: string }> }) => void;
};

function Harness(): null {
  useMissionsPolling();
  return null;
}

/** Let the pass in flight finish, and every promise chain behind it settle. */
async function finishPass(): Promise<void> {
  const gate = mocks.gate;
  mocks.gate = newGate();
  gate?.open();
  await React.act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

describe('useMissionsPolling — refresh coalescing (#2349)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.gate = newGate();
    mocks.inFlight = 0;
    mocks.maxInFlight = 0;
    mocks.passes = 0;
    mocks.pendingReads = 0;
    mocks.maxPendingReads = 0;
    useStore.setState({ workspaces: [{ id: 'ws-0' }] });
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      daemon: {
        // Never resolves here: the mount's own pass is the one under test.
        whenReady: () => new Promise<void>(() => undefined),
        onConnected: () => () => undefined,
      },
    };
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    vi.useRealTimers();
  });

  it('a burst of 8 workspace-set changes during a pass gives at most 2 full passes, never overlapping', async () => {
    await React.act(async () => {
      root.render(<Harness />);
    });
    // The mount's pass is in flight (held open by the gate).
    expect(mocks.passes).toBe(1);

    // A fan-out adds its 8 task workspaces one by one.
    for (let i = 1; i <= 8; i++) {
      await React.act(async () => {
        useStore.setState({ workspaces: [...useStore.getState().workspaces, { id: `ws-${i}` }] });
      });
      await React.act(async () => {
        vi.advanceTimersByTime(50);
      });
    }
    await React.act(async () => {
      vi.advanceTimersByTime(MISSION_REFRESH_DEBOUNCE_MS);
    });
    // Debounced, and the mount's pass is still running: nothing new started.
    expect(mocks.passes).toBe(1);

    await finishPass();
    // Exactly one rerun after it, covering every new workspace.
    expect(mocks.passes).toBe(2);
    const refresh = useStore.getState().refreshMissions;
    const lastPassIds = refresh.mock.calls.slice(-9).map((c) => c[0]);
    expect(lastPassIds).toEqual(['ws-0', 'ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6', 'ws-7', 'ws-8']);
    await finishPass();
    await React.act(async () => {
      vi.advanceTimersByTime(MISSION_REFRESH_DEBOUNCE_MS * 4);
    });
    expect(mocks.passes).toBe(2);
    expect(mocks.maxInFlight).toBe(1);
    expect(mocks.maxPendingReads).toBeLessThanOrEqual(9);
  });

  it('keeps the 15 s poll, and a poll that lands during a pass waits for it', async () => {
    await React.act(async () => {
      root.render(<Harness />);
    });
    await finishPass();
    expect(mocks.passes).toBe(1);
    const refresh = useStore.getState().refreshMissions;
    const before = refresh.mock.calls.length;

    // The poll is ledger-only (no provenance read): count its missions reads.
    await React.act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(refresh.mock.calls.length).toBe(before + 1);

    // A change starts a pass (after the debounce); the next poll lands while
    // it runs and does not start a second one alongside it.
    await React.act(async () => {
      useStore.setState({ workspaces: [...useStore.getState().workspaces, { id: 'ws-new' }] });
    });
    await finishPass();
    await React.act(async () => {
      vi.advanceTimersByTime(MISSION_REFRESH_DEBOUNCE_MS);
    });
    expect(mocks.passes).toBe(2);
    const duringPass = refresh.mock.calls.length;
    await React.act(async () => {
      vi.advanceTimersByTime(15_000 - MISSION_REFRESH_DEBOUNCE_MS);
    });
    expect(refresh.mock.calls.length).toBe(duringPass);
    await finishPass();
    expect(refresh.mock.calls.length).toBe(duringPass + 2);
    expect(mocks.maxInFlight).toBe(1);
    expect(mocks.maxPendingReads).toBeLessThanOrEqual(2);
  });
});
