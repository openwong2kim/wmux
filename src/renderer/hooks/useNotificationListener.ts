import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../stores';
import type { AgentStatus, NotificationType, Pane, PaneLeaf, Workspace } from '../../shared/types';
import { playNotificationSound } from './useNotificationSound';
import { createThrottler, type Throttler } from '../utils/createThrottler';
import {
  decideNotificationActions,
  type NotifPayload,
  type PolicyContext,
} from './useNotificationPolicy';

// ─── Target resolution helpers (regression-locked, unchanged from pre-T8) ───
// These two helpers were verified by the integration tests below (R1-R4)
// to behave identically to the previous implementation. Any change here
// would shift workspace resolution semantics and break callers.

function findSurfaceByPtyId(root: Pane, ptyId: string): { surfaceId: string; paneId: string } | null {
  if (root.type === 'leaf') {
    const surface = root.surfaces.find((s) => s.ptyId === ptyId);
    if (surface) return { surfaceId: surface.id, paneId: root.id };
    return null;
  }
  for (const child of root.children) {
    const found = findSurfaceByPtyId(child, ptyId);
    if (found) return found;
  }
  return null;
}

/** Check if a ptyId belongs to the active pane's active surface in a workspace */
function isActivePtySurface(ws: { rootPane: Pane; activePaneId: string }, ptyId: string): boolean {
  const findActiveLeaf = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = findActiveLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findActiveLeaf(ws.rootPane);
  if (!leaf) return false;
  const activeSurface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  return activeSurface?.ptyId === ptyId;
}

/**
 * Resolve a notification's destination workspace + (optional) surface + paneId.
 *
 * Order of preference:
 *  1. ptyId — strongest signal, originates from a specific surface
 *  2. workspaceId hint from the payload (e.g. external MCP notify with
 *     mcp.claimWorkspace context) — use the workspace's active surface
 *  3. Active workspace fallback — backward compat for CLI `wmux notify`
 *     which sends neither ptyId nor workspaceId
 */
export function resolveNotificationTarget(
  state: { workspaces: Workspace[]; activeWorkspaceId: string },
  ptyId: string | null,
  workspaceIdHint: string | undefined,
): { workspaceId: string; surfaceId?: string; paneId?: string } | null {
  if (ptyId) {
    for (const ws of state.workspaces) {
      const found = findSurfaceByPtyId(ws.rootPane, ptyId);
      if (found) return { workspaceId: ws.id, surfaceId: found.surfaceId, paneId: found.paneId };
    }
    return null;
  }
  const targetWsId = workspaceIdHint ?? state.activeWorkspaceId;
  if (!targetWsId) return null;
  const ws = state.workspaces.find((w) => w.id === targetWsId);
  if (!ws) return null;
  // Best-effort active surface lookup. If no active leaf, the notification
  // is still recorded at the workspace level with no surfaceId / paneId.
  const findActiveLeaf = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = findActiveLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findActiveLeaf(ws.rootPane);
  const surfaceId = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId)?.id;
  return { workspaceId: ws.id, surfaceId, paneId: leaf?.id };
}

// ─── Throttle windows ──────────────────────────────────────────────────────
// - Sound: 2s per NotificationType (preserves pre-T8 behavior — `agent`
//   and `error` were already independent, see the old lastSoundTime map).
// - flashFrame: 500ms GLOBAL (CEO A3 — burst protection. We do NOT key by
//   pane or workspace; multiple unfocused notifications in quick succession
//   should still trigger only one taskbar flash. The native flashFrame
//   stops on the next 'focus' anyway, so further calls would be wasted
//   IPC traffic.)
//
// Ring flash→glow timeout is 500ms — matches the visible flash CSS animation
// length so the ring doesn't get stuck in 'flash' if a second notification
// arrives before the timeout fires (we reset to 'flash' first, then schedule
// a fresh glow transition).

export const SOUND_THROTTLE_MS = 2000;
export const FLASH_FRAME_THROTTLE_MS = 500;
export const RING_FLASH_DURATION_MS = 500;

/**
 * Dependencies injected into the notification IPC handler. Extracted so
 * the test suite can exercise the dispatcher without bootstrapping React /
 * an Electron preload / a real zustand store. The renderer hook below
 * builds these once per mount and passes them in.
 *
 * Each function indirects through `useStore.getState()` rather than
 * capturing a snapshot, so settings toggled at runtime (T8 R9 test)
 * affect subsequent notifications immediately.
 */
export interface NotificationHandlerDeps {
  /** Read renderer state at action-execution time. */
  getState: () => {
    workspaces: Workspace[];
    activeWorkspaceId: string;
    toastEnabled: boolean;
    notificationSoundEnabled: boolean;
    notificationSoundChoice: 'default' | 'none';
    paneRingEnabled: boolean;
    paneFlashEnabled: boolean;
    taskbarFlashEnabled: boolean;
    addNotification: (n: { workspaceId: string; surfaceId?: string; type: NotificationType; title: string; body: string }) => void;
    pushToast: (t: { message: string; level: 'info' | 'warn' | 'error' }) => string;
    setPaneNotificationRing: (paneId: string, ring: 'flash' | 'glow' | null) => void;
    paneNotificationRing: Record<string, 'flash' | 'glow'>;
  };
  /** Returns true when the OS-level window is focused. */
  isWindowFocused: () => boolean;
  /** Trigger the taskbar flash (preload IPC bridge). */
  flashFrame: (on: boolean) => void;
  /** Audio cue for a given notification type. */
  playSound: (type: NotificationType) => void;
  flashFrameThrottler: Throttler;
  /** Per-type sound throttler factory (memoized per call site). */
  getSoundThrottler: (type: string) => Throttler;
  /**
   * Track the ring decay timer so the listener can cancel it on unmount
   * AND so a re-flash can extend the window (clearTimeout + reschedule)
   * without leaking the previous handle.
   */
  scheduleRingDecay: (paneId: string) => void;
}

/**
 * Factory for the notification.onNew handler. Pure — no React, no IPC, no
 * direct store import. Same shape as `createPrefixActions` in useKeyboard.ts
 * so the test pattern is consistent.
 */
export function createNotificationHandler(deps: NotificationHandlerDeps) {
  return function handleNotification(
    ptyId: string | null,
    data: { type: string; title: string; body: string; workspaceId?: string },
  ): void {
    const state = deps.getState();
    const target = resolveNotificationTarget(
      { workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId },
      ptyId,
      data.workspaceId,
    );
    if (!target) return;

    const ws = state.workspaces.find((w) => w.id === target.workspaceId);
    const isActive = !!(
      ptyId &&
      ws &&
      target.workspaceId === state.activeWorkspaceId &&
      target.surfaceId &&
      isActivePtySurface(ws, ptyId)
    );

    const payload: NotifPayload = {
      type: data.type as NotificationType,
      title: data.title,
      body: data.body,
      workspaceId: data.workspaceId,
    };

    const ctx: PolicyContext = {
      windowFocused: deps.isWindowFocused(),
      isActiveSurface: isActive,
      isMutedWorkspace: ws?.metadata?.notificationsMuted === true,
      paneId: target.paneId ?? null,
      settings: {
        toastEnabled: state.toastEnabled,
        notificationSoundEnabled: state.notificationSoundEnabled,
        notificationSoundChoice: state.notificationSoundChoice,
        paneRingEnabled: state.paneRingEnabled,
        paneFlashEnabled: state.paneFlashEnabled,
        taskbarFlashEnabled: state.taskbarFlashEnabled,
      },
    };

    const actions = decideNotificationActions(
      payload,
      { workspaceId: target.workspaceId, surfaceId: target.surfaceId },
      ctx,
    );

    for (const action of actions) {
      switch (action.kind) {
        case 'addNotification':
          state.addNotification({
            surfaceId: action.surfaceId,
            workspaceId: action.workspaceId,
            type: action.payload.type,
            title: action.payload.title,
            body: action.payload.body,
          });
          break;
        case 'pushToast':
          state.pushToast({
            message: action.payload.title,
            level:
              action.payload.type === 'error'
                ? 'error'
                : action.payload.type === 'warning'
                  ? 'warn'
                  : 'info',
          });
          break;
        case 'playSound':
          if (deps.getSoundThrottler(action.type).try()) {
            deps.playSound(action.type);
          }
          break;
        case 'flashFrame':
          if (deps.flashFrameThrottler.try()) {
            deps.flashFrame(true);
          }
          break;
        case 'setPaneRing': {
          // Set the ring synchronously; schedule the flash→glow transition
          // 500ms later. The state mutation is unconditional — even if a
          // prior ring was already 'glow', the new event should re-trigger
          // the flash so the user gets a fresh visual cue.
          state.setPaneNotificationRing(action.paneId, action.ring);
          if (action.ring === 'flash') {
            deps.scheduleRingDecay(action.paneId);
          }
          break;
        }
      }
    }
  };
}

export function useNotificationListener() {
  // Stable throttler instances. `useMemo` with [] guarantees identity
  // across re-renders so timestamps inside each throttler persist for
  // the entire hook lifetime. Cleanup `.cancel()`s each one on unmount
  // so a hot-reloaded listener starts fresh.
  const flashFrameThrottler = useMemo<Throttler>(() => createThrottler(FLASH_FRAME_THROTTLE_MS), []);
  // Lazily-populated per-NotificationType sound throttler map. Created on
  // first use so we don't carry empty Throttler closures for types that
  // never fire (`agent` is rare for non-Claude-Code users, etc.).
  const soundThrottlersRef = useRef<Record<string, Throttler>>({});

  // Per-pane flash→glow timeout handles. Cleared on unmount so a quick
  // unmount during the 500ms window doesn't leak a setTimeout into the
  // next listener instance.
  const ringTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const getSoundThrottler = (type: string): Throttler => {
      const map = soundThrottlersRef.current;
      let t = map[type];
      if (!t) {
        t = createThrottler(SOUND_THROTTLE_MS);
        map[type] = t;
      }
      return t;
    };

    const scheduleRingDecay = (paneId: string) => {
      // If a prior decay timer is still pending for this pane, clear it so
      // the new flash gets its full 500ms before transitioning to glow.
      const prev = ringTimersRef.current.get(paneId);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        ringTimersRef.current.delete(paneId);
        // Only transition if the ring is still in 'flash' for this pane —
        // user may have cleared it by clicking through, or closePane may
        // have deleted the entry. Don't overwrite either case.
        const current = useStore.getState().paneNotificationRing[paneId];
        if (current === 'flash') {
          useStore.getState().setPaneNotificationRing(paneId, 'glow');
        }
      }, RING_FLASH_DURATION_MS);
      ringTimersRef.current.set(paneId, t);
    };

    const handleNotification = createNotificationHandler({
      getState: () => useStore.getState(),
      isWindowFocused: () => (typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true),
      flashFrame: (on) => window.electronAPI.window.flashFrame(on),
      playSound: (type) => playNotificationSound(type),
      flashFrameThrottler,
      getSoundThrottler,
      scheduleRingDecay,
    });

    const unsubNotif = window.electronAPI.notification.onNew(handleNotification);

    const unsubCwd = window.electronAPI.notification.onCwdChanged((ptyId, cwd) => {
      const state = useStore.getState();
      for (const ws of state.workspaces) {
        const found = findSurfaceByPtyId(ws.rootPane, ptyId);
        if (found) {
          state.updateWorkspaceMetadata(ws.id, { cwd });
          break;
        }
      }
    });

    const unsubMeta = window.electronAPI.metadata.onUpdate((payload) => {
      const state = useStore.getState();
      // Discriminator: ptyId routes to its workspace; workspaceId is direct;
      // neither means "active workspace" (e.g. meta.setStatus from a CLI).
      const { ptyId, workspaceId: payloadWsId, ...rest } = payload;

      const applyToWorkspace = (wsId: string, restrictCwd: boolean) => {
        const data: Partial<typeof rest> = restrictCwd ? (() => {
          const { cwd: _cwd, ...withoutCwd } = rest;
          return withoutCwd;
        })() : rest;
        if (Object.keys(data).length > 0) {
          state.updateWorkspaceMetadata(wsId, data as Parameters<typeof state.updateWorkspaceMetadata>[1]);
        }
      };

      if (ptyId) {
        // B8: mirror agent lifecycle status into the per-surface map so an
        // inactive pane whose terminal completed (or is awaiting input) can
        // blink for attention. setSurfaceAgentStatus itself filters to the
        // attention statuses and clears on running/idle, so a plain CWD/git
        // metadata update (no agentStatus) is a no-op here.
        if (typeof rest.agentStatus === 'string') {
          state.setSurfaceAgentStatus(ptyId, rest.agentStatus as AgentStatus);
        }
        for (const ws of state.workspaces) {
          const found = findSurfaceByPtyId(ws.rootPane, ptyId);
          if (found) {
            // Only update CWD from the active pane's active surface to prevent
            // stale PTYs from overwriting the current directory.
            applyToWorkspace(ws.id, !isActivePtySurface(ws, ptyId));
            break;
          }
        }
        return;
      }

      const targetWsId = payloadWsId ?? state.activeWorkspaceId;
      if (targetWsId) {
        applyToWorkspace(targetWsId, false);
      }
    });

    const unsubGitBranch = window.electronAPI.notification.onGitBranchChanged((ptyId, branch) => {
      const state = useStore.getState();
      for (const ws of state.workspaces) {
        const found = findSurfaceByPtyId(ws.rootPane, ptyId);
        if (found) {
          state.updateWorkspaceMetadata(ws.id, { gitBranch: branch });
          break;
        }
      }
    });

    // Phase 1.5 — Claude Code hook signal health. Main throttles to 1Hz so
    // this fires at most once per second. Just slots into the existing
    // uiSlice field; no derived state required.
    const unsubSignalHealth = window.electronAPI.signalHealth.onUpdate((stats) => {
      useStore.getState().setHookSignalHealth(stats);
    });

    // Phase 2 — Anthropic 5h/7d usage meter. Main pushes a PollerState
    // snapshot on initial fetch, hourly tick, manual refresh, and on
    // error transitions. Renderer treats the payload as opaque.
    const unsubUsage = window.electronAPI.usage.onUpdate((state) => {
      useStore.getState().setAnthropicUsage(state);
    });
    // Hydrate main from persisted opt-in. Main boots with the poller
    // stopped; if the user had it enabled before app restart, the
    // SessionData restore in workspaceSlice.loadSession sets
    // `anthropicUsageEnabled` back to true, and we mirror that to
    // main here so the poller starts again. Calling setEnabled on a
    // poller already in the requested state is a no-op (idempotent).
    if (useStore.getState().anthropicUsageEnabled) {
      window.electronAPI.usage.setEnabled(true);
    }

    return () => {
      unsubNotif();
      unsubCwd();
      unsubMeta();
      unsubGitBranch();
      unsubSignalHealth();
      unsubUsage();
      // Reset throttlers so a hot-reloaded listener doesn't inherit stale
      // last-fire timestamps that would suppress the first notification.
      flashFrameThrottler.cancel();
      for (const t of Object.values(soundThrottlersRef.current)) t.cancel();
      // Cancel any pending flash→glow decay timeouts.
      for (const t of ringTimersRef.current.values()) clearTimeout(t);
      ringTimersRef.current.clear();
    };
  }, [flashFrameThrottler]);
}
