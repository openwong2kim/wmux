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
//     clock tick / label / supervision). These are high-frequency and
//     non-structural, so one coalesced push per quiet-down is enough.
//
// Gated on the SAME pane-readiness gate as useRpcBridge (`paneGate === 'ready'`):
// during startup reconcile the tree's ptyIds are stale / mid-clear, so a snapshot
// pushed then would seed the mirror with ids that are about to change.

import { useEffect } from 'react';
import { useStore } from '../stores';
import { buildWorkspaceMirrorPayload } from './workspaceMirrorSnapshot';

/** Trailing-debounce window for status-only churn (ms). */
const STATUS_DEBOUNCE_MS = 300;

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
      const statusChurn =
        s.surfaceAgentStatus !== prev.surfaceAgentStatus ||
        s.surfaceActivity !== prev.surfaceActivity ||
        s.surfaceActivityAt !== prev.surfaceActivityAt ||
        s.agentClockMs !== prev.agentClockMs ||
        s.paneLabel !== prev.paneLabel ||
        s.supervisionByPtyId !== prev.supervisionByPtyId;
      if (statusChurn) scheduleTrailing();
    };

    const unsub = useStore.subscribe(listener);
    // Seed the mirror on mount when the gate is already open (the pending→ready
    // transition above covers the cold-start case).
    if (useStore.getState().paneGate === 'ready') flushLeading();

    return () => {
      if (trailingTimer) clearTimeout(trailingTimer);
      unsub();
    };
  }, []);
}
