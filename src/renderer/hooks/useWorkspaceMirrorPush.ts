// useWorkspaceMirrorPush — pushes the full workspace tree + per-pane agent
// status snapshot to the main-process WorkspaceMirror (IPC.WORKSPACE_MIRROR_PUSH)
// whenever it changes. This is what lets main resolve hooks / routing locally
// instead of round-tripping `workspace.list` back to the renderer (which a
// large-buffer flush storm starves — see hooks.rpc.ts / WorkspaceMirror.ts).
//
// Push policy (matches the mirror's snapshot-only contract):
//   - LEADING-EDGE immediate push on a STRUCTURAL change — the workspaces array
//     identity changing (tree mutation, incl. per-workspace activePaneId) or the
//     active workspace switching. Routing correctness depends on these landing
//     promptly, so they are never debounced.
//   - TRAILING 300ms debounce for STATUS-ONLY churn (agent status / activity /
//     label / supervision). These are high-frequency and non-structural, so one
//     coalesced push per quiet-down is enough.
//   - SLOW PERIODIC refresh (30s) while ready. The decay-derived running/idle
//     status flips off `agentClockMs`, which ticks ~2s while any agent runs.
//     Keying the trailing debounce on that clock re-pushed the full payload
//     every 2s all session for a change no consumer needs at that fidelity
//     (hook routing tolerates coarse status freshness; the heartbeat reads every
//     3min; the pull-path fallback + 10s staleness bound protect routing). So
//     the clock is NOT a churn key — a periodic push carries decay-only changes
//     to the mirror boundedly instead.
//
// Gated on the SAME pane-readiness gate as useRpcBridge (`paneGate === 'ready'`):
// during startup reconcile the tree's ptyIds are stale / mid-clear, so a snapshot
// pushed then would seed the mirror with ids that are about to change.

import { useEffect } from 'react';
import { useStore } from '../stores';
import { buildWorkspaceMirrorPayload } from './workspaceMirrorSnapshot';

/** Trailing-debounce window for status-only churn (ms). */
const STATUS_DEBOUNCE_MS = 300;

/** Slow periodic refresh so decay-derived (clock-only) status changes still
 *  reach the mirror without keying the debounce on the ~2s agent clock. */
const PERIODIC_REFRESH_MS = 30_000;

export function useWorkspaceMirrorPush(): void {
  useEffect(() => {
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;

    const push = (): void => {
      const s = useStore.getState();
      // Gate: never seed the mirror from a mid-reconcile tree.
      if (s.paneGate !== 'ready') return;
      const payload = buildWorkspaceMirrorPayload(s);
      // Optional-chained: a stale preload (packaged update under a running
      // renderer) or a partial test mock may not expose the send surface.
      window.electronAPI?.workspaceMirror?.push?.(payload);
    };

    const flushLeading = (): void => {
      // A structural push supersedes any pending trailing one.
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      push();
    };

    const scheduleTrailing = (): void => {
      if (trailingTimer) return; // already coalescing this window
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        push();
      }, STATUS_DEBOUNCE_MS);
    };

    const listener = (
      s: ReturnType<typeof useStore.getState>,
      prev: ReturnType<typeof useStore.getState>,
    ): void => {
      // The gate flipping pending→ready is itself the moment the first real
      // snapshot becomes valid — push it immediately (leading).
      if (s.paneGate === 'ready' && prev.paneGate !== 'ready') {
        flushLeading();
        return;
      }
      if (s.paneGate !== 'ready') return;

      // Structural: workspaces array identity (tree / activePaneId mutations all
      // produce a fresh immutable array) or the active workspace switching.
      const structural =
        s.workspaces !== prev.workspaces || s.activeWorkspaceId !== prev.activeWorkspaceId;
      if (structural) {
        flushLeading();
        return;
      }

      // Status-only churn: the fleet selector's per-pane status inputs. Debounce.
      // `agentClockMs` is deliberately NOT here — it ticks ~2s while agents run
      // and only drives decay-derived running/idle, which the periodic refresh
      // below carries boundedly instead of re-pushing every 2s.
      const statusChurn =
        s.surfaceAgentStatus !== prev.surfaceAgentStatus ||
        s.surfaceActivity !== prev.surfaceActivity ||
        s.surfaceActivityAt !== prev.surfaceActivityAt ||
        s.paneLabel !== prev.paneLabel ||
        s.supervisionByPtyId !== prev.supervisionByPtyId;
      if (statusChurn) scheduleTrailing();
    };

    const unsub = useStore.subscribe(listener);
    // Slow periodic refresh so decay-derived status changes (agentClockMs) still
    // reach the mirror. `push` self-gates on paneGate === 'ready', so a tick
    // during startup is a no-op. Unref'd so it never pins a Node process (a
    // renderer timer has no unref — the optional call is a harmless no-op there).
    const refreshTimer = setInterval(push, PERIODIC_REFRESH_MS);
    (refreshTimer as unknown as { unref?: () => void }).unref?.();
    // Seed the mirror on mount when the gate is already open (the pending→ready
    // transition above covers the cold-start case).
    if (useStore.getState().paneGate === 'ready') flushLeading();

    return () => {
      if (trailingTimer) clearTimeout(trailingTimer);
      clearInterval(refreshTimer);
      unsub();
    };
  }, []);
}
