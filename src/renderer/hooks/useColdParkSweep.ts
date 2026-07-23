// ─── Cold-park sweep hook (TASK-9) ──────────────────────────────────────────
//
// Mounted once at the app layout level (parallel to useMissionsPolling). Runs a
// sparse background tick that hands the current wall clock to the store's
// idempotent `sweepColdPark` reducer, which stamps newly-hidden workspaces,
// parks those idle past the threshold, and un-parks any that became visible.
//
// Un-parking on reveal does NOT go through here — it happens synchronously in
// setActiveWorkspace / toggleMultiviewWorkspace so the revealed workspace renders
// its PaneContainer the same frame. This hook only drives the PARK direction,
// which is human-timescale and can be coarse.
//
// The feature is gated two ways: the `coldParkEnabled` flag (default ON), AND
// daemon mode being active. Parking a LOCAL PTY pane would be data loss — a
// parked pane's data handlers are unmounted and there is no daemon ring to
// replay from, so output while parked is gone and reveal is blank. In local
// mode (or while the daemon is disconnected) the sweep parks nothing and
// releases anything currently parked, matching the uiSlice flag's "no-op in
// local PTY mode" contract.

import { useEffect } from 'react';
import { useStore } from '../stores';
import { isDaemonModeActive } from '../daemon/daemonMode';

/** Idle threshold before a hidden workspace is parked. */
export const COLD_PARK_THRESHOLD_MS = 5 * 60 * 1000;
/** Sweep cadence — coarse; parking is not latency-sensitive. */
export const COLD_PARK_TICK_MS = 30_000;

export function useColdParkSweep(): void {
  const coldParkEnabled = useStore((s) => s.coldParkEnabled);

  useEffect(() => {
    const releaseAllParked = () => {
      const state = useStore.getState();
      for (const id of Object.keys(state.parkedWorkspaceIds)) {
        state.unparkWorkspace(id);
      }
    };
    if (!coldParkEnabled) {
      // Escape hatch flipped OFF — release everything currently parked so the
      // terminals remount, then stop ticking.
      releaseAllParked();
      return;
    }
    const tick = () => {
      // Local PTY mode / daemon disconnected: never park (no daemon ring to
      // replay from — parking would lose output). Release anything already
      // parked so those panes remount, then wait for the next tick.
      if (!isDaemonModeActive()) {
        releaseAllParked();
        return;
      }
      useStore.getState().sweepColdPark(Date.now(), COLD_PARK_THRESHOLD_MS);
    };
    const timer = setInterval(tick, COLD_PARK_TICK_MS);
    return () => clearInterval(timer);
  }, [coldParkEnabled]);
}
