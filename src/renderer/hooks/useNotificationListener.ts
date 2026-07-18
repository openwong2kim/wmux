import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../stores';
import type { AgentStatus, NotificationType, Pane, Workspace } from '../../shared/types';
import type { AgentSlug } from '../../shared/events';
import { playNotificationSound } from './useNotificationSound';
import { createThrottler, type Throttler } from '../utils/createThrottler';
import {
  decideNotificationActions,
  type NotifPayload,
  type PolicyContext,
} from './useNotificationPolicy';
import { findSurfaceByPtyId, findSurfaceById, findActiveLeaf } from '../utils/paneTraversal';
import { FrameCoalescer } from '../utils/frameCoalescer';
import { normalizeWorktreePath } from '../../shared/workTask';

/**
 * J3 §4 — cwd가 태스크 worktree 경계 안인지(best-effort, OSC 협조 기반). 정규화
 * 후 동일 경로거나 `{worktree}/` 접두면 안. 원본 repo 등 경계 밖이면 이탈.
 */
function isWithinWorktree(cwd: string, worktreePath: string): boolean {
  const c = normalizeWorktreePath(cwd);
  const w = normalizeWorktreePath(worktreePath);
  if (!c || !w) return true; // 판정 불가 → 이탈로 몰지 않음(경고만·오탐 방지).
  return c === w || c.startsWith(w + '/');
}

// ─── Target resolution helpers (regression-locked, unchanged from pre-T8) ───
// `findSurfaceByPtyId` / `findActiveLeaf` now live in ../utils/paneTraversal
// (extracted to kill the in-file duplicates). They were verified by the
// integration tests below (R1-R4) to behave identically to the previous
// implementation. Any change there would shift workspace resolution semantics
// and break callers.

/** Check if a ptyId belongs to the active pane's active surface in a workspace */
function isActivePtySurface(ws: { rootPane: Pane; activePaneId: string }, ptyId: string): boolean {
  const leaf = findActiveLeaf(ws.rootPane, ws.activePaneId);
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
  const leaf = findActiveLeaf(ws.rootPane, ws.activePaneId);
  const surfaceId = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId)?.id;
  return { workspaceId: ws.id, surfaceId, paneId: leaf?.id };
}

// ─── Toast click → pane jump (X2) ──────────────────────────────────────────

/**
 * Minimal store surface `focusNotificationTarget` needs. Indirected through
 * a getState() thunk (same pattern as NotificationHandlerDeps) because the
 * jump is a multi-step mutation: setActivePane/setActiveSurface only operate
 * on the ACTIVE workspace, so each step must observe the previous step's
 * state — a snapshot taken before setActiveWorkspace would silently no-op.
 */
export interface FocusTargetState {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  zoomedPaneId: string | null;
  setActiveWorkspace: (id: string) => void;
  setActivePane: (paneId: string) => void;
  setActiveSurface: (paneId: string, surfaceId: string, workspaceId?: string) => void;
  togglePaneZoom: (paneId: string) => void;
  notifications: Array<{ id: string; read: boolean; surfaceId?: string }>;
  markRead: (id: string) => void;
  setPaneNotificationRing: (paneId: string, ring: 'flash' | 'glow' | null) => void;
}

/**
 * Core jump sequence shared by the notification-toast jump and the Fleet View
 * jump: activate workspace → re-read → pane → surface, with zoom coherence
 * (#182). Returns the post-mutation state so callers can layer extra behavior
 * (the toast path clears notification rings; Fleet View does not). Each step
 * re-reads via getState() because setActivePane/setActiveSurface only operate
 * on the ACTIVE workspace — a snapshot from before setActiveWorkspace no-ops.
 */
export function activatePaneTarget(
  getState: () => FocusTargetState,
  target: { workspaceId: string; paneId: string; surfaceId: string },
): FocusTargetState {
  const state = getState();
  if (target.workspaceId !== state.activeWorkspaceId) {
    state.setActiveWorkspace(target.workspaceId);
  }
  const fresh = getState();
  fresh.setActivePane(target.paneId);
  fresh.setActiveSurface(target.paneId, target.surfaceId, target.workspaceId);
  if (fresh.zoomedPaneId !== null && fresh.zoomedPaneId !== target.paneId) {
    fresh.togglePaneZoom(fresh.zoomedPaneId);
  }
  return fresh;
}

/**
 * Jump to the pane that originated a notification (OS toast click, panel
 * row click, in-app toast click — all three share this). Resolution order:
 * ptyId is the strongest signal (activates workspace + pane + surface);
 * surfaceId is the durable fallback when the PTY died or was reconnected
 * since the notification was recorded (surface ids outlive PTYs — panel
 * entries can be minutes old); workspaceId is the last resort for
 * app-level notifications (activates the workspace only). Unresolvable
 * ids are a silent no-op.
 *
 * Read/ring semantics: unread notifications for the TARGET surface (not the
 * whole pane — narrower than Pane's click handler, which clears every tab)
 * are marked read, and the attention ring is cleared only when something was
 * actually marked (a no-unread jump must not wipe a fresh flash that belongs
 * to a notification the user hasn't seen). On a cross-workspace jump the
 * real setActiveWorkspace already marks the whole workspace read and wipes
 * its rings, so this loop only adds behavior for same-workspace jumps.
 *
 * Zoom coherence: a zoomed sibling hides every other leaf via
 * display:none (#182), so jumping to a pane outside the zoomed one would
 * land focus on an invisible pane. Same rule split/close apply — clear the
 * zoom unless the jump target IS the zoomed pane.
 *
 * Returns true when any activation happened (test observability).
 */
export function focusNotificationTarget(
  getState: () => FocusTargetState,
  payload: { ptyId?: string | null; workspaceId?: string | null; surfaceId?: string | null },
): boolean {
  const state = getState();
  // Shared tail of both resolver branches: jump (workspace + pane +
  // surface + zoom coherence), then mark this surface's unread
  // notifications read and clear the ring iff something was marked.
  const jumpToSurface = (workspaceId: string, paneId: string, surfaceId: string): void => {
    const fresh = activatePaneTarget(getState, { workspaceId, paneId, surfaceId });
    let markedAny = false;
    for (const n of fresh.notifications) {
      if (!n.read && n.surfaceId !== undefined && n.surfaceId === surfaceId) {
        fresh.markRead(n.id);
        markedAny = true;
      }
    }
    if (markedAny) {
      fresh.setPaneNotificationRing(paneId, null);
    }
  };
  if (payload.ptyId) {
    for (const ws of state.workspaces) {
      const found = findSurfaceByPtyId(ws.rootPane, payload.ptyId);
      if (!found) continue;
      jumpToSurface(ws.id, found.paneId, found.surfaceId);
      return true;
    }
    // PTY closed since the notification fired — fall through to surfaceId
    // (durable across reconnects), then workspaceId.
  }
  if (payload.surfaceId) {
    for (const ws of state.workspaces) {
      const found = findSurfaceById(ws.rootPane, payload.surfaceId);
      if (!found) continue;
      jumpToSurface(ws.id, found.paneId, payload.surfaceId);
      return true;
    }
  }
  if (payload.workspaceId) {
    const ws = state.workspaces.find((w) => w.id === payload.workspaceId);
    if (ws) {
      if (ws.id !== state.activeWorkspaceId) {
        state.setActiveWorkspace(ws.id);
      }
      return true;
    }
  }
  return false;
}

/**
 * S-C1 Fleet View jump: focus a pane by its active surface's ptyId, reusing the
 * hardened `focusNotificationTarget` sequence verbatim (workspace switch +
 * getState re-read + pane/surface activation + zoom coherence — the #182
 * lesson). A Fleet card already carries the active surface ptyId, so ptyId
 * resolution is the one signal needed; an empty/closed ptyId is a silent no-op.
 * A thin, well-named wrapper rather than refactoring the race-tested
 * notification path during the S-C1 kickoff.
 */
export function focusPaneByPtyId(getState: () => FocusTargetState, ptyId: string): boolean {
  if (!ptyId) return false;
  return focusNotificationTarget(getState, { ptyId });
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
    addNotification: (n: { workspaceId: string; surfaceId?: string; ptyId?: string; type: NotificationType; title: string; body: string }) => void;
    pushToast: (t: {
      message: string;
      level: 'info' | 'warn' | 'error';
      target?: { ptyId?: string | null; workspaceId?: string | null; surfaceId?: string | null };
    }) => string;
    setPaneNotificationRing: (paneId: string, ring: 'flash' | 'glow' | null) => void;
    paneNotificationRing: Record<string, 'flash' | 'glow'>;
  };
  /** Returns true when the OS-level window is focused. */
  isWindowFocused: () => boolean;
  /** Trigger the taskbar flash (preload IPC bridge). */
  flashFrame: (on: boolean) => void;
  /** Audio cue for a given notification type. */
  playSound: (type: NotificationType) => void;
  /**
   * Relay a policy-decided OS toast to main (IPC.NOTIFICATION_OS_TOAST →
   * ToastManager.showDirect). ptyId/workspaceId become the click-jump
   * context main attaches to the native notification.
   */
  showOsToast: (payload: { title: string; body: string; ptyId?: string | null; workspaceId?: string | null; windowsFlashEnabled?: boolean; dockBounceEnabled?: boolean }) => void;
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
            // Originating PTY (when any) rides on the record so the panel
            // click-jump has the strongest signal; surfaceId above is the
            // durable fallback after a PTY reconnect.
            ptyId: ptyId ?? undefined,
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
            // Click-jump target: body click on the in-app toast lands on
            // the originating pane, same contract as the OS toast click.
            target: {
              ptyId: ptyId ?? null,
              workspaceId: target.workspaceId,
              surfaceId: target.surfaceId ?? null,
            },
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
        case 'osToast':
          deps.showOsToast({
            title: action.payload.title,
            body: action.payload.body,
            ptyId: ptyId ?? null,
            workspaceId: target.workspaceId,
            // Codex review catches (rounds 1+2): main's ToastManager must
            // NOT also flash the Windows taskbar here — the `flashFrame`
            // action above already does that, throttled (500ms burst
            // protection) and gated on taskbarFlashEnabled; a second,
            // untethered flash from showDirect both double-flashed the
            // first notification and bypassed the throttle on every
            // subsequent one. macOS has no renderer-side dock-bounce
            // action at all, so that gate still follows the real setting.
            windowsFlashEnabled: false,
            dockBounceEnabled: state.taskbarFlashEnabled,
          });
          break;
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

    // A3 (NB2 파동 0) — 메타 기록 프레임 코얼레싱.
    //
    // 타이틀/cwd/gitBranch는 같은 pty로 초당 수 회(주기 틱마다) 도착하는데,
    // 각 갱신이 updateSurface*/updateWorkspaceMetadata를 즉시 호출하면 immer
    // set이 workspaces 참조를 매번 새로 만들고 s.workspaces 구독자 전부가
    // 리렌더된다. 같은 pty의 연속 갱신을 프레임당 1회(마지막 값 승리)로 병합해
    // 팬아웃을 줄인다.
    //
    // 동작 불변: 데몬 정본·session.json 영속에는 무영향 — 값은 이미 main이
    // 소유하며, 여기서 미루는 것은 "렌더러 스토어에 반영하는 시점"(최대 ~16ms)
    // 뿐이다. 시각/저장 시맨틱은 동일. onUpdate(meta)의 복잡 경로(agentStatus
    // 전이·per-surface 맵·포트 유니온·principal 등록)는 중간 전이/부수효과를
    // 잃을 수 있어 의도적으로 코얼레싱하지 않는다.
    const cwdCoalescer = new FrameCoalescer<string, string>((ptyId, cwd) => {
      const state = useStore.getState();
      // Per-surface cwd + owning workspace metadata, 프레임당 1회로 병합.
      state.updateSurfaceCwd(ptyId, cwd);
      for (const ws of state.workspaces) {
        if (findSurfaceByPtyId(ws.rootPane, ptyId)) {
          state.updateWorkspaceMetadata(ws.id, { cwd });
          break;
        }
      }
    });
    const titleCoalescer = new FrameCoalescer<string, string>((ptyId, title) => {
      useStore.getState().updateSurfaceTitleByPty(ptyId, title);
    });
    const gitBranchCoalescer = new FrameCoalescer<string, string>((ptyId, branch) => {
      const state = useStore.getState();
      for (const ws of state.workspaces) {
        if (findSurfaceByPtyId(ws.rootPane, ptyId)) {
          state.updateWorkspaceMetadata(ws.id, { gitBranch: branch });
          break;
        }
      }
    });

    const handleNotification = createNotificationHandler({
      getState: () => useStore.getState(),
      isWindowFocused: () => (typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true),
      flashFrame: (on) => window.electronAPI.window.flashFrame(on),
      playSound: (type) => playNotificationSound(type),
      showOsToast: (payload) => window.electronAPI.notification.showOsToast(payload),
      flashFrameThrottler,
      getSoundThrottler,
      scheduleRingDecay,
    });

    const unsubNotif = window.electronAPI.notification.onNew(handleNotification);

    // Confirm to main that this listener is live — see IPC.NOTIFICATION_LISTENER_READY.
    // Fires on every mount (including a post-crash mainWindow.reload()), which is
    // exactly when main's mirrored flag needs to flip back to true.
    window.electronAPI.notification.listenerReady();

    // X2 — OS toast clicked: main already restored/focused the window;
    // jump to the originating workspace/pane/surface.
    const unsubFocus = window.electronAPI.notification.onFocusRequest((payload) => {
      focusNotificationTarget(() => useStore.getState(), payload);
    });

    const unsubCwd = window.electronAPI.notification.onCwdChanged((ptyId, cwd) => {
      // Per-surface cwd: every terminal tracks its own working directory (not
      // just the workspace's active cwd), so the "Working directories" menu and
      // the tab tooltip can show each powershell's path — and it persists.
      // A3: 프레임당 1회로 병합(마지막 cwd 승리) — 실제 반영은 cwdCoalescer.
      if (!ptyId) return;
      cwdCoalescer.push(ptyId, cwd);

      // J3 §4 — 태스크 워크스페이스의 페인 cwd가 worktree 경계 밖으로 벗어나면
      // 이탈 뱃지(경고만·차단 없음). ptyId→워크스페이스→미션(worktreePath) 해석 후
      // 경계 비교. 미션이 아니거나 미물질화면 무시.
      const st = useStore.getState();
      const target = resolveNotificationTarget(st, ptyId, undefined);
      if (target) {
        const mission = st.getMissionForPaneGroup(target.workspaceId);
        if (mission?.worktreePath) {
          const inside = isWithinWorktree(cwd, mission.worktreePath);
          st.setPaneGroupDeparted(target.workspaceId, inside ? null : cwd);
        }
      }
    });

    const unsubTitle = window.electronAPI.notification.onTitleChanged((ptyId, title) => {
      // OSC 0/2 window title (e.g. Claude Code `/rename`) → the tab title,
      // unless the user manually renamed this surface (titleLocked).
      // A3: 프레임당 1회로 병합(마지막 title 승리) — 반영은 titleCoalescer.
      if (!ptyId) return;
      titleCoalescer.push(ptyId, title);
    });

    // codex review (PR #471): with the main-side poll dedup, an UNCHANGED
    // payload is never re-broadcast — but exclusive workspace context
    // (cwd/git/PR) only applies from the surface that is ACTIVE at receipt
    // time. Switching panes therefore has to PULL the newly active surface's
    // context explicitly; pre-dedup, the every-5s re-broadcast covered this
    // implicitly. The request handler broadcasts the payload back through
    // the normal METADATA_UPDATE path below.
    let lastActivePtyId: string | null = null;
    const pullActiveContext = (s: ReturnType<typeof useStore.getState>) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
      const leaf = ws ? findActiveLeaf(ws.rootPane, ws.activePaneId) : null;
      const surf = leaf?.surfaces.find((x) => x.id === leaf.activeSurfaceId);
      const ptyId = surf?.ptyId ?? null;
      if (ptyId === lastActivePtyId) return;
      lastActivePtyId = ptyId;
      // Optional-chained: a stale preload (packaged update under a running
      // renderer) or a partial test mock may not expose request.
      if (ptyId) void window.electronAPI.metadata.request?.(ptyId);
    };
    const unsubActivePull = useStore.subscribe(pullActiveContext);
    pullActiveContext(useStore.getState());

    const unsubMeta = window.electronAPI.metadata.onUpdate((payload) => {
      const state = useStore.getState();
      // Discriminator: ptyId routes to its workspace; workspaceId is direct;
      // neither means "active workspace" (e.g. meta.setStatus from a CLI).
      // `activity` (Fleet per-pane line) is per-ptyId surface state, NOT
      // workspace metadata — pull it OUT here, alongside ptyId, so it can never
      // flow into `...rest` and get written into updateWorkspaceMetadata by
      // applyToWorkspace's spread.
      const { ptyId, workspaceId: payloadWsId, activity, paneId, paneLabel, paneRole, agentSlug, ...rest } = payload;

      // P2 (checklist D): a paneId-only payload is the pane-label relay from
      // MetadataStore. Route it to the per-pane label + role mirrors and return
      // so paneId/paneLabel/paneRole never reach applyToWorkspace (whose spread
      // would mis-record them onto the active workspace's metadata).
      if (paneId !== undefined) {
        state.setPaneLabel(paneId, typeof paneLabel === 'string' ? paneLabel : undefined);
        // paneRole is teed on the same relay. Only touch the role mirror when the
        // payload actually carries it (a string, incl. '' as the clear tombstone);
        // an omitted paneRole must NOT wipe an existing role, in case some other
        // emitter ever sends a label-only paneId payload.
        if (typeof paneRole === 'string') {
          state.setPaneRole(paneId, paneRole);
        }
        return;
      }

      // X1: workspace metadata is one record per workspace, but context
      // updates arrive per-PTY. Two rules keep multi-pane workspaces from
      // flickering (pane A's branch line erased by pane B's empty value on
      // every 5s tick):
      //  - exclusive fields (cwd, git context, PR) only follow the ACTIVE
      //    pane's active surface — same policy cwd always had;
      //  - listeningPorts go through the per-surface map and the workspace
      //    value is recomputed as the UNION over its surfaces, so a dev
      //    server in a background pane stays visible and order of arrival
      //    doesn't matter.
      const applyToWorkspace = (wsId: string, restrictContext: boolean) => {
        const data: Partial<typeof rest> = restrictContext ? (() => {
          const passthrough = { ...rest };
          delete passthrough.cwd;
          delete passthrough.gitBranch;
          delete passthrough.gitIsWorktree;
          delete passthrough.pr;
          delete passthrough.gitSync;
          return passthrough;
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
          // Byte-based per-PTY 'running' (daemon ActivityMonitor) is otherwise
          // DROPPED by setSurfaceAgentStatus (attention-only). Stamp the running
          // freshness clock so a BACKGROUND pane's dot lights from bytes — this
          // replaced the per-tool-call PostToolUse hook as the running source.
          if (rest.agentStatus === 'running') {
            state.markSurfaceRunning(ptyId);
          }
        }
        // Part A: stamp per-surface agent IDENTITY (name + status) keyed by
        // ptyId so a2a_discover / surface_list / pane_list can label each pane
        // individually. setSurfaceAgent keeps an already-known name when only a
        // status arrives, and ignores empty names (the 'running' broadcast may
        // carry agentName='' before a gate matches).
        const slugArg = typeof agentSlug === 'string' ? (agentSlug as AgentSlug) : undefined;
        if (typeof rest.agentName === 'string' || typeof rest.agentStatus === 'string' || slugArg) {
          state.setSurfaceAgent(
            ptyId,
            typeof rest.agentName === 'string' ? rest.agentName : undefined,
            typeof rest.agentStatus === 'string' ? (rest.agentStatus as AgentStatus) : undefined,
            slugArg,
          );
          // R2: register/refresh the pane whose agent identity was just resolved
          // into the principal registry. A fresh getState() reads the name that
          // was just stamped. When the content is unchanged the slice's internal
          // debounce cache skips the daemon round-trip, so it is safe to call on
          // every periodic broadcast.
          if (useStore.getState().surfaceAgent[ptyId]?.name) {
            void useStore.getState().principalRegisterPane(ptyId);
          }
        }
        // Fleet View per-pane activity line: store the (already main-side
        // sanitized + throttled) string in the transient per-ptyId map. Main
        // only sets `activity` on its own; an empty string clears the entry.
        if (typeof activity === 'string') {
          state.setSurfaceActivity(ptyId, activity);
        }
        for (const ws of state.workspaces) {
          const found = findSurfaceByPtyId(ws.rootPane, ptyId);
          if (found) {
            // X1 — ports: store per-surface, publish the workspace union.
            if (Array.isArray(rest.listeningPorts)) {
              state.setSurfacePorts(ptyId, rest.listeningPorts);
              const merged = new Set<number>();
              const collectPtyIds = (pane: Pane): string[] =>
                pane.type === 'leaf'
                  ? pane.surfaces.map((s) => s.ptyId).filter(Boolean)
                  : pane.children.flatMap(collectPtyIds);
              const freshPorts = useStore.getState().surfacePorts;
              for (const id of collectPtyIds(ws.rootPane)) {
                for (const p of freshPorts[id] ?? []) merged.add(p);
              }
              rest.listeningPorts = [...merged].sort((a, b) => a - b);
            }
            // Only update exclusive context (cwd/git/PR) from the active
            // pane's active surface to prevent stale PTYs from overwriting it.
            applyToWorkspace(ws.id, !isActivePtySurface(ws, ptyId));
            // agentStatus='running'은 주기적으로 오지만 agentName(session:agent
            // gate emit)은 1회성이라, ptyId↔surface 매핑이 준비되기 전에 발화하면
            // 영영 유실된다. 매핑이 생긴 지금(running 수신 + agentName 비어 있음)
            // main의 lastAgentNameByPty 캐시에서 race-free하게 pull해 메운다.
            if (rest.agentStatus === 'running') {
              const needWsBackfill = !ws.metadata?.agentName;
              // Per-surface backfill (Codex review): the one-shot agentName can
              // miss this pty's surfaceAgent map just as it misses ws metadata.
              // The ws may already carry a name from another pane while THIS
              // surface still has none, so check the per-surface entry too.
              const needSurfaceBackfill = !state.surfaceAgent[ptyId]?.name;
              if (needWsBackfill || needSurfaceBackfill) {
                const targetWsId = ws.id;
                void window.electronAPI.metadata.resolveAgent(ptyId).then((name) => {
                  if (!name) return;
                  const s = useStore.getState();
                  if (needWsBackfill) s.updateWorkspaceMetadata(targetWsId, { agentName: name });
                  // Backfill the NAME only — pass undefined status so a newer
                  // status (the surface may have gone complete/idle while this
                  // async resolveAgent was in flight) is preserved, not stomped
                  // back to 'running'. setSurfaceAgent keeps the existing status.
                  if (needSurfaceBackfill) {
                    s.setSurfaceAgent(ptyId, name, undefined);
                    // R2: a pane that first gained an identity via backfill also takes the principal registration path.
                    void useStore.getState().principalRegisterPane(ptyId);
                  }
                });
              }
            }
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

    // P2 bootstrap (checklist C): seed the paneLabel mirror from the MetadataStore
    // snapshot so a restart re-displays existing renames (hydrate emits no events).
    // Early boot can hand back an empty list or reject (the snapshot IPC handler is
    // registered slightly after the renderer mounts), so retry a few times —
    // otherwise a persisted rename silently fails to re-display until its next live
    // change. Once a non-empty snapshot lands we stop; a genuinely label-less
    // session simply exhausts the short retry budget (≈1.5s of light polling).
    // Primary seeding is the main-side push after hydrate (index.ts) — it covers
    // the daemon-mode case where the store hydrates after the renderer mounts.
    // This pull is the complement: it covers a hydrate-BEFORE-mount boot, where
    // the push would land before onUpdate is registered. Retry briefly on an
    // empty/failed snapshot to ride out a small handler-registration race.
    let snapAttempts = 0;
    let snapTimer: ReturnType<typeof setTimeout> | null = null;
    let snapCancelled = false;
    const seedPaneLabels = (): void => {
      const p = window.electronAPI.metadata.snapshot?.();
      if (!p) return;
      void p.then((entries) => {
        // The retry loop outlives a fast unmount/remount otherwise — guard the
        // store write and the reschedule so a disposed listener can't mutate
        // state or keep polling (CodeRabbit review).
        if (snapCancelled) return;
        if (entries.length > 0) {
          const s = useStore.getState();
          for (const e of entries) {
            s.setPaneLabel(e.paneId, e.label);
            // Seed the role mirror too so a persisted role shows after restart
            // even if the boot push raced the listener subscription.
            s.setPaneRole(e.paneId, e.role);
          }
        } else if (snapAttempts < 5) {
          snapAttempts += 1;
          snapTimer = setTimeout(seedPaneLabels, 300);
        }
      }).catch(() => {
        if (snapCancelled) return;
        if (snapAttempts < 5) {
          snapAttempts += 1;
          snapTimer = setTimeout(seedPaneLabels, 300);
        }
      });
    };
    seedPaneLabels();

    const unsubGitBranch = window.electronAPI.notification.onGitBranchChanged((ptyId, branch) => {
      // A3: 프레임당 1회로 병합(마지막 branch 승리) — 반영은 gitBranchCoalescer.
      if (!ptyId) return;
      gitBranchCoalescer.push(ptyId, branch);
    });

    // J3 §3 — initialCommand 재시도 소진(프롬프트 미발사) 통지. fan-out 결과가
    // taskPtyRegistry에 등록해 둔 ptyId→태스크로 토스트 + [재발사]. 재발사는 main이
    // prompt.md 실존을 검사(파일 소실 시 사유), 실제 inject는 pty.write. 상태 영속
    // 없음(§3 G8 — 리부트로 토스트 소실 수용).
    const unsubExhausted = window.electronAPI.notification.onInitialCmdExhausted((ptyId) => {
      if (!ptyId) return;
      const st = useStore.getState();
      const entry = st.taskPtyRegistry[ptyId];
      if (!entry) return; // 매핑 부재(non-fanout·핸드셰이크 ptyId 누락) → best-effort 생략.
      const worktreePath = entry.worktreePath;
      const initialCommand = entry.initialCommand;
      // F2 — 재발사는 원래 initialCommand(에이전트 기동+프롬프트 주입)를 재전송해야
      // 한다(맨 셸에 원문 프롬프트를 흘리면 셸이 실행). 둘 다 있어야 [재발사] 제공.
      const canRefire = Boolean(worktreePath && initialCommand);
      st.pushToast({
        level: 'warn',
        message: `태스크 "${entry.title}": 프롬프트가 발사되지 않았습니다(에이전트 페인이 비어 있을 수 있음).`,
        ...(canRefire
          ? {
              action: {
                label: '재발사',
                onClick: () => {
                  void (async () => {
                    const api = window.electronAPI.workTask;
                    if (!api) return;
                    try {
                      const res = await api.refire({ ptyId, worktreePath: worktreePath as string, initialCommand: initialCommand as string });
                      if (res.ok) {
                        useStore.getState().pushToast({ level: 'info', message: `태스크 "${entry.title}": 프롬프트를 재발사했습니다.` });
                      } else {
                        useStore.getState().pushToast({ level: 'error', message: `재발사 불가: ${res.error}` });
                      }
                    } catch (e) {
                      useStore.getState().pushToast({ level: 'error', message: `재발사 불가: ${e instanceof Error ? e.message : String(e)}` });
                    }
                  })();
                },
              },
            }
          : {}),
      });
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
      unsubFocus();
      unsubCwd();
      unsubTitle();
      unsubMeta();
      unsubActivePull();
      unsubGitBranch();
      unsubExhausted();
      unsubSignalHealth();
      unsubUsage();
      // Reset throttlers so a hot-reloaded listener doesn't inherit stale
      // last-fire timestamps that would suppress the first notification.
      flashFrameThrottler.cancel();
      for (const t of Object.values(soundThrottlersRef.current)) t.cancel();
      // Cancel any pending flash→glow decay timeouts.
      for (const t of ringTimersRef.current.values()) clearTimeout(t);
      // Stop the pane-label snapshot retry loop so it can't fire after unmount.
      snapCancelled = true;
      if (snapTimer) clearTimeout(snapTimer);
      ringTimersRef.current.clear();
      // A3: 언마운트 직전 코얼레서에 남은 마지막 값을 동기 반영한 뒤 정리한다.
      // (hot-reload/재마운트 시 마지막 title/cwd/branch 유실 방지.)
      cwdCoalescer.flushNow();
      titleCoalescer.flushNow();
      gitBranchCoalescer.flushNow();
    };
  }, [flashFrameThrottler]);
}
