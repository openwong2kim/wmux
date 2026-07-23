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
// The whole feature is gated behind `coldParkEnabled` (default ON): while OFF the
// hook still mounts but never parks, and any already-parked workspaces are
// released once so their terminals remount.

import { useEffect } from 'react';
import { useStore } from '../stores';

/** Idle threshold before a hidden workspace is parked. */
export const COLD_PARK_THRESHOLD_MS = 5 * 60 * 1000;
/** Sweep cadence — coarse; parking is not latency-sensitive. */
export const COLD_PARK_TICK_MS = 30_000;

export function useColdParkSweep(): void {
  const coldParkEnabled = useStore((s) => s.coldParkEnabled);

  useEffect(() => {
    if (!coldParkEnabled) {
      // Escape hatch flipped OFF — release everything currently parked so the
      // terminals remount, then stop ticking.
      const state = useStore.getState();
      for (const id of Object.keys(state.parkedWorkspaceIds)) {
        state.unparkWorkspace(id);
      }
      return;
    }
    const tick = () => useStore.getState().sweepColdPark(Date.now(), COLD_PARK_THRESHOLD_MS);
    const timer = setInterval(tick, COLD_PARK_TICK_MS);
    return () => clearInterval(timer);
  }, [coldParkEnabled]);
}
