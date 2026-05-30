import { useEffect, useState, useRef, useCallback } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Sidebar from '../Sidebar/Sidebar';
import MiniSidebar from '../Sidebar/MiniSidebar';
import PaneContainer from '../Pane/PaneContainer';
import StatusBar from '../StatusBar/StatusBar';
import NotificationPanel from '../Notification/NotificationPanel';
import CommandPalette from '../Palette/CommandPalette';
import SettingsPanel from '../Settings/SettingsPanel';
import FileTreePanel from '../FileTree/FileTreePanel';
import ApprovalDialog from '../Company/ApprovalDialog';
import ExecuteApprovalDialog from '../A2a/ExecuteApprovalDialog';
import PermissionApprovalDialogContainer from '../Approval/PermissionApprovalDialogContainer';
import CompanyView from '../Company/CompanyView';
import MessageFeedPanel from '../Company/MessageFeedPanel';
import OnboardingOverlay from '../Onboarding/OnboardingOverlay';
import FirstRunWizard from '../FirstRunWizard';
import KeyboardCheatSheet from '../KeyboardCheatSheet';
import ToastContainer from '../Toast/ToastContainer';
import FloatingPane from '../Terminal/FloatingPane';
import SearchResultsPanel from '../Search/SearchResultsPanel';
import { ErrorBoundary } from '../ErrorBoundary';
import { useKeyboard } from '../../hooks/useKeyboard';
import { useActivePaneFocus } from '../../hooks/useActivePaneFocus';
import { useNotificationListener } from '../../hooks/useNotificationListener';
import { useRpcBridge } from '../../hooks/useRpcBridge';
import { useResizeGuard } from '../../hooks/useResizeGuard';
import { useIpc } from '../../hooks/useIpc';
import type { SessionData, PaneLeaf, Pane, Surface, Workspace } from '../../../shared/types';
import { FIRST_RUN_REOPEN_EVENT } from '../../../shared/firstRun';
import { isFileDrag } from '../../../shared/dragDrop';
import { terminalRegistry } from '../../hooks/useTerminal';
import { resolvePtyIdsToClear } from '../../hooks/reconcileWithReQuery';
import { withDefaultShell } from '../../utils/ptyCreateOptions';
import { serializeTerminalBuffer } from '../../utils/scrollbackDump';
import { pastePtyChunked } from '../../utils/clipboardChunk';
import { isDaemonModeActive, setDaemonModeActive } from '../../daemon/daemonMode';
import { RECONCILE_TIMEOUT_MS } from '../../../shared/timeouts';

/**
 * Fix 0 — startup reconcile timeout.
 *
 * startup state machine:
 *
 *   mount
 *     │
 *     ▼
 *   [pending] ──► session.load()
 *     │
 *     ▼
 *   loadSession(saved)  ── saved=null? ──► [ready]
 *     │ (ptyId preserved)                    ▲
 *     ▼                                      │
 *   daemon.whenReady()                       │
 *     │                                      │
 *     ▼                                      │
 *   gen = ++startupGenRef                    │
 *   abortCtl = new AbortController           │
 *   await raceWithAbort(                     │
 *     reconcilePtys(abortCtl.signal),        │
 *     RECONCILE_TIMEOUT_MS                   │
 *   )                                        │
 *     │                                      │
 *     ├── success ──────────────────────────┤
 *     │                                      │
 *     ├── timeout/throw ──► abortCtl.abort() │
 *     │                     if (gen === startupGenRef.current)
 *     │                       clearAllPtyState()
 *     │                     ────────────────┤
 *     │                                      │
 *     └── (always) finally: setPaneGate('ready') ───┘
 *
 * Generation token prevents late-arriving reconcile from mutating store
 * after a fresher startup ran. AbortController propagates cancellation
 * into reconcilePtys so its `signal.aborted` checks early-return.
 *
 * RCA A2 — RECONCILE_TIMEOUT_MS now lives in shared/timeouts.ts and is
 * derived as DAEMON_RPC_TIMEOUT_MS + 5s (= 15s). Previously this was a
 * standalone 5_000 that had drifted BELOW the 10s RPC ceiling, so a daemon
 * that answered pty.list in 6–9s under load still lost the race and the
 * startup catch wiped every live session via clearAllPtyState().
 */

/** Map shell executable path to a human-readable display name. */
function shellDisplayName(shellPath: string): string {
  const base = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  if (base.includes('pwsh')) return 'PowerShell 7';
  if (base.includes('powershell')) return 'PowerShell';
  if (base.includes('bash')) return 'Bash';
  if (base.includes('wsl')) return 'WSL';
  if (base.includes('cmd')) return 'CMD';
  if (base.includes('zsh')) return 'Zsh';
  if (base.includes('fish')) return 'Fish';
  // Strip extension and capitalize
  const name = base.replace(/\.exe$/i, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Collect all terminal surfaces from a pane tree */
function collectTerminalSurfaces(pane: Pane): Surface[] {
  if (pane.type === 'leaf') {
    return pane.surfaces.filter((s) => !s.surfaceType || s.surfaceType === 'terminal');
  }
  const result: Surface[] = [];
  for (const child of pane.children) {
    result.push(...collectTerminalSurfaces(child));
  }
  return result;
}

/** Dump all terminal scrollback buffers via IPC (fire-and-forget).
 *  Also sets scrollbackFile on each surface in the session data. */
/** Dump all terminal scrollback buffers via IPC (fire-and-forget).
 *  Returns a map of surfaceId → true for surfaces that were dumped.
 *  SessionData objects from Zustand may be frozen, so we return the map
 *  instead of mutating surfaces directly. */
/** Sync version — fire-and-forget for beforeunload (cannot await). */
function dumpScrollbackBuffersSync(): Map<string, boolean> {
  // Phase A — A6. In daemon mode the daemon RingBuffer is the single source
  // of truth for scrollback. Skip the helper entirely so the corresponding
  // scrollback:dump IPC is never invoked and the rotation chain cannot
  // self-destruct while daemon is healthy. The returned empty map flows
  // through cloneWithScrollback so no `scrollbackFile` field is stamped
  // onto session data, preventing a future restore from picking up a stale
  // entry from a session that ran in local mode.
  if (isDaemonModeActive()) {
    return new Map();
  }
  const dumped = new Map<string, boolean>();
  const state = useStore.getState();
  for (const ws of state.workspaces) {
    const surfaces = collectTerminalSurfaces(ws.rootPane);
    for (const surface of surfaces) {
      if (!surface.ptyId) continue;
      const terminal = terminalRegistry.get(surface.ptyId);
      if (!terminal) continue;
      const content = serializeTerminalBuffer(terminal);
      if (!content) continue;
      dumped.set(surface.id, true);
      window.electronAPI.scrollback.dump(surface.id, content).catch(() => {});
    }
  }
  return dumped;
}

/** Deep-clone pane tree, setting scrollbackFile on dumped surfaces.
 *
 * Phase A — A6 follow-up (codex review P2, session 019e2af8). When daemon
 * mode is active and dumped is empty, the previous logic preserved every
 * surface's existing `scrollbackFile` field. A session saved in local
 * mode therefore carried its stale `.txt` reference forward; if the
 * renderer ever reloaded before daemon readiness (or after a failed A7
 * migration), it would try to restore from the stale `.txt` despite the
 * IPC-level gate. Clear the field outright in daemon mode so session
 * data round-trips with the gates' intent.
 */
function cloneWithScrollback(pane: Pane, dumped: Map<string, boolean>): Pane {
  const daemonMode = isDaemonModeActive();
  if (pane.type === 'leaf') {
    return {
      ...pane,
      surfaces: pane.surfaces.map((s) => ({
        ...s,
        scrollbackFile: dumped.has(s.id) ? s.id : (daemonMode ? undefined : s.scrollbackFile),
      })),
    };
  }
  return {
    ...pane,
    children: pane.children.map((c) => cloneWithScrollback(c, dumped)),
  };
}

/** Build a consistent SessionData snapshot for save operations */
function buildSessionData(dumped: Map<string, boolean>): SessionData {
  const state = useStore.getState();
  const companySafe = state.company ? { ...state.company, skipPermissions: undefined } : null;
  return {
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      rootPane: cloneWithScrollback(ws.rootPane, dumped),
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    sidebarVisible: state.sidebarVisible,
    sidebarMode: state.sidebarMode,
    company: companySafe,
    memberCosts: state.memberCosts,
    sessionStartTime: state.sessionStartTime ?? undefined,
    // User preferences
    theme: state.theme,
    locale: state.locale,
    terminalFontSize: state.terminalFontSize,
    terminalFontFamily: state.terminalFontFamily,
    defaultShell: state.defaultShell,
    scrollbackLines: state.scrollbackLines,
    scrollbackRestoreEnabled: state.scrollbackRestoreEnabled,
    sidebarPosition: state.sidebarPosition,
    notificationSoundEnabled: state.notificationSoundEnabled,
    toastEnabled: state.toastEnabled,
    notificationRingEnabled: state.notificationRingEnabled,
    customKeybindings: state.customKeybindings,
    autoUpdateEnabled: state.autoUpdateEnabled,
    customThemeColors: state.customThemeColors ?? undefined,
    onboardingCompleted: state.onboardingCompleted,
    // T8a: persist first-run wizard + cheat sheet flags alongside onboardingCompleted.
    // workspaceSlice.loadSession (T5) reads these back, defaulting to false.
    firstRunCompleted: state.firstRunCompleted,
    cheatSheetDismissed: state.cheatSheetDismissed,
    floatingPanePtyId: state.floatingPanePtyId ?? undefined,
    prefixConfig: state.prefixConfig,
    // Persist user-created layout templates + recent commands so they survive
    // restart. loadSession (workspaceSlice) reads these back; builtins are
    // re-seeded from BUILTIN_TEMPLATES on load, so we exclude them here to
    // avoid bloat and stale duplicates. recentCommands follows the optional-
    // field convention (omit when empty).
    layoutTemplates: state.layoutTemplates.filter((t) => !t.builtin),
    recentCommands: state.recentCommands.length > 0 ? state.recentCommands : undefined,
  };
}

export default function AppLayout() {
  // Global guard: blocks webview pointer capture during panel separator drag
  useResizeGuard();
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const fileTreeVisible = useStore((s) => s.fileTreeVisible);
  const companyViewVisible = useStore((s) => s.companyViewVisible);
  const setCompanyViewVisible = useStore((s) => s.setCompanyViewVisible);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const addSurface = useStore((s) => s.addSurface);
  // Fix 0 startup gate. See state machine diagram at top of file.
  const paneGate = useStore((s) => s.paneGate);
  const setPaneGate = useStore((s) => s.setPaneGate);
  const clearAllPtyState = useStore((s) => s.clearAllPtyState);

  const multiviewIds = useStore((s) => s.multiviewIds);
  const removeMultiviewWorkspace = useStore((s) => s.removeMultiviewWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  const prefixMode = useStore((s) => s.prefixMode);
  // Gate the cross-pane SearchResultsPanel mount at the layout level so its
  // 6-field zustand subscription doesn't run when the panel is closed (I3).
  const searchPanelOpen = useStore((s) => s.searchPanelOpen);
  const onboardingActive = useStore((s) => s.onboardingActive);
  const onboardingCompleted = useStore((s) => s.onboardingCompleted);
  const startOnboarding = useStore((s) => s.startOnboarding);
  const completeOnboarding = useStore((s) => s.completeOnboarding);

  // ─── First-run wizard + cheat sheet (T8a) ───────────────────────────────
  // Local visibility state for the wizard (null = hidden, otherwise mode).
  // The cheat sheet visibility is derived from uiSlice: it mounts whenever
  // the first run is completed AND the user has not permanently dismissed it.
  // Flipping `cheatSheetDismissed` back to false from Settings (T8b) is what
  // re-mounts the cheat sheet — observing the slice directly here removes the
  // earlier local-state gate that left the Settings button dead (C1 fix).
  const firstRunCompleted = useStore((s) => s.firstRunCompleted);
  const cheatSheetDismissed = useStore((s) => s.cheatSheetDismissed);
  // Bypasses the dismissed gate when the `?` prefix action sets it. Without
  // this subscription here the component never mounts after a permanent
  // dismissal, so the override would have nothing to react to.
  const cheatSheetForceShown = useStore((s) => s.cheatSheetForceShown);
  const setFirstRunCompleted = useStore((s) => s.setFirstRunCompleted);
  const [showFirstRunWizard, setShowFirstRunWizard] = useState<'firstRun' | 'reopen' | null>(null);

  const [showAutoUpdatePrompt, setShowAutoUpdatePrompt] = useState(false);
  const t = useT();

  useKeyboard();
  // Pull DOM focus onto the active pane's xterm after keyboard/RPC pane &
  // surface switches — without this the red active border moves but typing
  // stays in the previously focused pane (see useActivePaneFocus).
  useActivePaneFocus();
  useNotificationListener();
  useRpcBridge();
  const { invoke: ipcInvoke } = useIpc();

  // ─── File drop — handled in preload where File.path is accessible ──────
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const sessionLoadedRef = useRef(false);
  // Fix 0: monotonic startup generation counter. Each mount-effect run
  // bumps it; the startup catch only fires clearAllPtyState if its own
  // gen still matches the current ref. Prevents a stale startup from
  // wiping state that a fresher startup already reconciled correctly.
  // Also used by the in-flight reconcile share (below) so late mutations
  // from an abandoned run are no-ops.
  const startupGenRef = useRef(0);
  // Fix 0: reconcilePtys in-flight promise (was a boolean ref). The
  // original boolean caused a race where daemon.onConnected fires
  // reconcile first, then startup's `await reconcilePtys()` returned
  // immediately because "already in flight" — flipping paneGate to ready
  // before the racing reconcile actually finished. Now startup awaits
  // the shared promise of whatever run is in flight. Late re-reconciles
  // after the first run completes still trigger a fresh pass.
  const reconcileInFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    // File drop via preload onFileDrop (reliable cross-platform)
    const removeDrop = window.electronAPI.onFileDrop((paths) => {
      setIsDragging(false);
      dragCounterRef.current = 0;

      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!ws) return;

      const findLeaf = (pane: typeof ws.rootPane): PaneLeaf | null => {
        if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
        for (const child of pane.children) {
          const found = findLeaf(child);
          if (found) return found;
        }
        return null;
      };
      const leaf = findLeaf(ws.rootPane);
      if (!leaf) return;

      const activeSurface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
      if (!activeSurface || activeSurface.surfaceType === 'browser') return;

      const text = paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
      // Route the joined path string through the paste chunker. Single-file
      // drops fit easily in one write, but a multi-file drop with long
      // Windows paths (UNC, OneDrive, long-form Program Files) can blow
      // through the main process's 100KB silent backstop. Chunking also
      // paces the IPC writes so the conpty input pipe drains between
      // sends. No bracketed-paste markers — drag-drop targets the prompt,
      // not a paste-aware foreground app.
      const surfacePtyId = activeSurface.ptyId;
      void pastePtyChunked(
        (d) => window.electronAPI.pty.write(surfacePtyId, d),
        text,
        null,
      ).catch((err) => console.error('[wmux:drag-drop] chunk write failed:', err));
    });

    // Visual drag overlay
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) setIsDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragging(false);
      }
    };
    document.addEventListener('dragenter', onEnter, true);
    document.addEventListener('dragleave', onLeave, true);
    return () => {
      removeDrop();
      document.removeEventListener('dragenter', onEnter, true);
      document.removeEventListener('dragleave', onLeave, true);
    };
  }, []);

  // Fix 0 — reconcile saved PTY IDs with daemon's active sessions.
  //
  // Contract changes from pre-Fix-0:
  //   1. Throws (not silently returns) on `pty.list` RPC failure. The
  //      AppLayout startup catch depends on this to fire clearAllPtyState
  //      as the explicit fallback.
  //   2. Accepts an AbortSignal. Each `await` boundary checks
  //      signal.aborted and early-returns; aborted runs do not mutate
  //      the store further.
  //   3. In-flight promise share (not boolean skip). A concurrent caller
  //      awaits the existing run instead of returning immediately —
  //      otherwise the startup gate could flip to ready before the
  //      racing reconcile actually finished.
  //   4. NO replacement pty.create on stale ptyId. The path that called
  //      pty.create + updateSurfacePtyId(newId) is the original
  //      propagation-race source. v2 clears the ptyId and lets
  //      Terminal.tsx self-create on mount — the well-tested fresh-pane
  //      path. The mount gate guarantees Terminal mounts AFTER this
  //      reconcile resolves, so the race is gone.
  const reconcilePtys = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (reconcileInFlightRef.current) {
      console.log('[AppLayout] reconcile already in flight — awaiting shared promise');
      return reconcileInFlightRef.current;
    }
    const run = (async () => {
      try {
        const listResult = await ipcInvoke<{ id: string }[]>(() =>
          window.electronAPI.pty.list()
        );
        if (!listResult.ok) {
          // Throw — the startup catch depends on this to fire
          // clearAllPtyState as the explicit fallback. Pre-Fix-0 this
          // silently returned, which broke the documented fallback
          // contract (codex outside-voice hole #3).
          throw new Error(`reconcilePtys aborted: ${listResult.error.code}`);
        }
        if (signal?.aborted) return;
        const activePtys = listResult.data;
        const activeIds = new Set(activePtys.map((p: { id: string }) => p.id));
        console.log('[AppLayout] Daemon active PTYs:', [...activeIds]);

        // RCA A1 — empty-list guard (the single most important non-destructive
        // change). `pty.list` returning ZERO live sessions on a reconnect
        // almost always means the daemon/RPC isn't ready yet (main just
        // reconnected, daemon mid-rehydrate), NOT that every session died.
        // The pre-fix code would then clear every surface's ptyId and let
        // Terminal self-create empty sessions — exactly the reported
        // "daemon reset, all sessions replaced" bug. Preserve everything this
        // cycle; useTerminal mount re-validates each ptyId individually (with
        // retry), and a subsequent reconcile / daemon:connected runs again
        // once the list is populated. A genuine "all sessions dead" state is
        // rare and self-heals on the next mount's reconnect.
        const hasSavedPtyIds = useStore.getState().workspaces.some(ws => {
          const walk = (p: Pane): boolean =>
            p.type === 'leaf'
              ? p.surfaces.some(s => !!s.ptyId)
              : p.children.some(walk);
          return walk(ws.rootPane);
        });
        if (activeIds.size === 0 && hasSavedPtyIds) {
          console.warn('[lifecycle] reconcile: daemon returned 0 live sessions but saved ptyIds exist — preserving all (no destructive clear, likely daemon not ready yet)');
          return;
        }

        // Fix 0 (round 3) — reconcile is now ONLY a liveness check.
        //
        // The PTY_DATA-loss race we hit in dogfood: reconcile used to call
        // `pty.reconnect(ptyId)` here, which kicked off daemon SessionPipe
        // attach + ringBuffer flush. The replay data left main process
        // BEFORE the renderer's Terminal component mounted, so
        // ipcRenderer.on(PTY_DATA) had no listener registered and Electron
        // IPC dropped every replay chunk. Result: dump succeeds, recovery
        // succeeds, flush succeeds, and the user still sees a fresh empty
        // terminal because the bytes vanished between main and renderer.
        //
        // Fix: reconcile only marks dead ptyIds (not in daemon active
        // list) as empty. Live ptyIds are left alone. useTerminal mount
        // is now responsible for calling pty.reconnect AFTER its
        // pty.onData listener is registered, so the SessionPipe replay
        // always lands on an attached listener.
        // RCA A1/A9 — collect candidate ptyIds (present in the store but
        // ABSENT from the first NON-EMPTY daemon snapshot) WITHOUT clearing.
        // Live ptyIds stay in place (useTerminal mount reconnects). The
        // partial-list case is the still-open hole the empty-list guard above
        // does not cover: a single snapshot can be partial (daemon
        // mid-rehydrate), so clearing on the first cycle could destroy a live
        // session. We defer the destructive decision to a 2-strike re-query.
        const absentCandidates: { paneId: string; surfaceId: string; ptyId: string }[] = [];
        const collect = (pane: Pane) => {
          if (signal?.aborted) return;
          if (pane.type === 'leaf') {
            for (const surface of pane.surfaces) {
              if (signal?.aborted) return;
              if (surface.surfaceType === 'browser' || surface.surfaceType === 'editor') continue;
              if (!surface.ptyId) {
                console.log(`[AppLayout] Surface ${surface.id}: no ptyId, Terminal will self-create`);
                continue;
              }
              if (activeIds.has(surface.ptyId)) {
                console.log(`[AppLayout] Surface ${surface.id}: ptyId ${surface.ptyId} alive in daemon, Terminal will reconnect on mount`);
                // Leave ptyId in place. useTerminal mount reconnects.
              } else {
                absentCandidates.push({ paneId: pane.id, surfaceId: surface.id, ptyId: surface.ptyId });
              }
            }
          } else {
            for (const child of pane.children) {
              if (signal?.aborted) return;
              collect(child);
            }
          }
        };

        // Iterate the freshest workspace snapshot per walk. The reconcile
        // path was previously seeded from a single getState() before the
        // loop, which froze the view of workspaces for the duration of
        // the walk — any concurrent store update (e.g. a fast-spawned
        // surface) was invisible until the next reconcile cycle.
        for (const ws of useStore.getState().workspaces) {
          if (signal?.aborted) return;
          console.log(`[AppLayout] Reconciling workspace: ${ws.name}`);
          collect(ws.rootPane);
        }

        // RCA A1/A9 — partial-list 2-strike guard. Before destructively
        // clearing any live ptyId absent from the first non-empty snapshot,
        // re-query the daemon ONCE (resolvePtyIdsToClear). It preserves
        // everything on uncertainty (re-query fails or the run aborts) and
        // returns only ptyIds absent from BOTH snapshots. RCA A8 — the actual
        // clear is logged at warn so it lands in the main log file and can be
        // correlated with the daemon's pty.list count.
        if (absentCandidates.length > 0 && !signal?.aborted) {
          const firstAbsent = absentCandidates.map((c) => c.ptyId);
          const toClear = await resolvePtyIdsToClear(firstAbsent, {
            reList: async () => {
              const r = await ipcInvoke<{ id: string }[]>(() => window.electronAPI.pty.list());
              return r.ok
                ? { ok: true, ids: new Set(r.data.map((p: { id: string }) => p.id)) }
                : { ok: false };
            },
            isCurrent: () => !signal?.aborted,
            log: (level, message) => (level === 'warn' ? console.warn(message) : console.log(message)),
          });
          for (const c of absentCandidates) {
            if (signal?.aborted) break;
            if (toClear.has(c.ptyId)) {
              console.warn(`[lifecycle] reconcile clearing ptyId=${c.ptyId} surface=${c.surfaceId} (absent from TWO daemon snapshots) → Terminal self-create`);
              useStore.getState().updateSurfacePtyId(c.paneId, c.surfaceId, '');
            }
          }
        }
        console.log('[AppLayout] Reconciliation complete');
      } finally {
        reconcileInFlightRef.current = null;
      }
    })();
    reconcileInFlightRef.current = run;
    return run;
  }, [ipcInvoke]);

  // 앱 시작 시 세션 복원 (Fix 0 — see state machine diagram at top of file)
  useEffect(() => {
    const gen = ++startupGenRef.current;
    let abortCtl: AbortController | null = null;
    // Codex P2 — wrap the entire startup in an async IIFE so a session.load()
    // rejection (preload gap, IPC handler swap mid-call, renderer reload race)
    // still reaches the outer try/finally. The previous structure put try inside
    // .then(), which left paneGate='pending' forever on .then-never-fires paths.
    void (async () => {
      try {
        const saved = await window.electronAPI.session.load();
        if (!saved) {
          sessionLoadedRef.current = true;
          // First ever launch — ask about auto-update
          setShowAutoUpdatePrompt(true);
          return;
        }

        // If autoUpdateEnabled was never set (upgrade from older version), prompt
        const isFirstAutoUpdateChoice = saved.autoUpdateEnabled == null;

        useStore.getState().loadSession(saved);

        // Sanitize stale per-workspace agent state. agentStatus/agentName
        // describe a live PTY's current state; carrying them across an app
        // restart is always wrong — the workspaces just rehydrated, no agent
        // has emitted anything yet in this session. Without this reset the
        // sidebar dot would lie about agents that died last time the user
        // closed wmux (Codex 1st review #4: lifecycle reset).
        const postLoadState = useStore.getState();
        for (const ws of postLoadState.workspaces) {
          // Only update workspaces whose persisted state actually carries a
          // live status. Plain truthiness on agentStatus is true for 'idle'
          // too, so the previous guard re-broadcast a no-op metadata update
          // for every workspace that had ever held agent state.
          const status = ws.metadata?.agentStatus;
          const hasLive = (status && status !== 'idle') || (ws.metadata?.agentName && ws.metadata.agentName.length > 0);
          if (hasLive) {
            postLoadState.updateWorkspaceMetadata(ws.id, { agentStatus: 'idle', agentName: '' });
          }
        }

        sessionLoadedRef.current = true;

        if (isFirstAutoUpdateChoice) {
          setShowAutoUpdatePrompt(true);
        }

        // v2.8.1 hotfix (Bug 3): defer reconciliation until main has
        // settled the daemon-vs-local decision. Without this gate, the
        // reconcile fires while IPC handlers are mid-swap and pty.list
        // can hit a "no handler registered" rejection — the renderer
        // surfaces that as a generic "알 수 없는 오류" toast spam.
        const daemonReady = await window.electronAPI.daemon.whenReady();

        // Codex P1 — set daemonMode flag here, BEFORE paneGate flips ready.
        // The separate daemonMode useEffect also calls setDaemonModeActive
        // from its own .then, but that runs on its own React schedule. If
        // paneGate flips first, Terminals mount with daemonModeAtMount=false
        // and never call pty.reconnect — reproducing blank-terminal exactly
        // as if reconcile never happened. Setting it inside this serialized
        // startup path guarantees daemonMode is correct before Terminal mount.
        setDaemonModeActive(daemonReady.connected);

        // User-facing scrollback restore toggle. OFF: skip reconcile entirely
        // and clear every pty-keyed surface field so each Terminal mounts
        // fresh (Terminal.tsx self-create). Daemon still dumps ringBuffers
        // on graceful Quit; cleanOrphanedBuffers reaps the now-unreferenced
        // .buf files on the next launch. Done renderer-side so the daemon
        // contract stays simple and no extra RPC is needed.
        const restoreEnabled = useStore.getState().scrollbackRestoreEnabled !== false;
        if (!restoreEnabled) {
          console.log('[AppLayout] scrollbackRestoreEnabled=false — clearing pty state for fresh start');
          clearAllPtyState();
          return;
        }

        // Fix 0 — generation-tokened, AbortController-cancellable
        // reconcile race. Timeout aborts the in-flight reconcile so
        // late mutations don't overwrite the cleared-fallback state.
        abortCtl = new AbortController();
        const signal = abortCtl.signal;
        await Promise.race([
          reconcilePtys(signal),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              abortCtl?.abort();
              reject(new Error(`reconcile timeout after ${RECONCILE_TIMEOUT_MS}ms`));
            }, RECONCILE_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        // Fix 0 explicit fallback. Reconcile aborted, timed out, session.load
        // rejected, daemon.whenReady rejected, or any other startup throw.
        // Clear all pty-keyed state so Terminal.tsx self-create receives a
        // consistent blank slate. Generation check prevents a stale startup
        // from wiping state a fresher startup already reconciled correctly.
        console.warn('[AppLayout] startup reconcile failed:', err);
        abortCtl?.abort();
        if (gen === startupGenRef.current) {
          clearAllPtyState();
        }
      } finally {
        // Always flip the gate, even on error — never leave the user
        // staring at a permanent "Restoring panes…" placeholder.
        setPaneGate('ready');
      }
    })();
  // setPaneGate / clearAllPtyState are stable zustand action refs; reconcilePtys
  // captured by closure. Empty deps mirror pre-Fix-0 mount-only behavior.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── First-run wizard: probe marker on mount (T8a) ────────────────────
  // Calls firstRun:check; if no marker exists yet, mount the wizard. If a
  // marker already exists we mirror that into uiSlice so the spotlight guard
  // (D8) sees firstRunCompleted=true even before SessionData loads.
  // TODO(T8a-tests): AppLayout has no existing test fixture. Adding a
  // mounting integration suite (mocking useStore, useResizeGuard, useIpc,
  // electronAPI surfaces) is its own task. Smoke-test target:
  //   - firstRun.check called once on mount
  //   - shown=false flips showFirstRunWizard to 'firstRun'
  //   - shown=true triggers setFirstRunCompleted(true)
  //   - FIRST_RUN_REOPEN_EVENT flips mode to 'reopen'
  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI.firstRun;
    if (!api) return; // preload may not yet expose firstRun in non-Electron contexts (tests)
    void api.check().then((result) => {
      if (cancelled) return;
      if (!result.shown) {
        setShowFirstRunWizard('firstRun');
      } else {
        setFirstRunCompleted(true);
      }
    }).catch(() => {
      // Best-effort. If main is unreachable, fall back to "completed" so
      // the user is not blocked by a missing wizard channel.
      if (!cancelled) setFirstRunCompleted(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setFirstRunCompleted]);

  // ─── First-run wizard: reopen contract for SettingsPanel (T8b) ───────
  // T8b's "Open setup wizard" button dispatches FIRST_RUN_REOPEN_EVENT on
  // window. No payload. AppLayout listens here and switches the wizard into
  // mode='reopen' (D9: sample task disabled).
  useEffect(() => {
    const handler = () => setShowFirstRunWizard('reopen');
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, handler);
    return () => window.removeEventListener(FIRST_RUN_REOPEN_EVENT, handler);
  }, []);

  // ─── First-run onboarding (spotlight) detection ─────────────────────
  // D8: spotlight stays gated behind firstRunCompleted so the wizard always
  // wins the first impression. Once the wizard completes/dismisses, the
  // spotlight tutorial picks up the UI tour for single-workspace users.
  useEffect(() => {
    if (!sessionLoadedRef.current) return;
    if (firstRunCompleted && !onboardingCompleted && workspaces.length === 1) {
      startOnboarding();
    }
  }, [firstRunCompleted, onboardingCompleted, workspaces.length, startOnboarding]);

  // Re-reconcile when daemon connects late (race condition:
  // renderer may have already reconciled with empty pty list
  // before main process finished connecting to daemon).
  useEffect(() => {
    let activeCtl: AbortController | null = null;
    const remove = window.electronAPI.daemon.onConnected(() => {
      console.log('[lifecycle] daemon connected late — re-reconciling PTYs');
      // RCA A1/A3 — the late reconcile previously ran as a bare
      // reconcilePtys() with NO abort, timeout, or catch (unlike the startup
      // path's 5 guards). A pty.list rejection here escaped as an unhandled
      // rejection, and the call could outlive a fresher reconcile. Add an
      // abort+timeout and swallow failures by PRESERVING ptyIds — crucially we
      // never fall through to clearAllPtyState here (that destructive fallback
      // is startup-only). reconcilePtys is itself non-destructive on empty
      // lists now (A1 empty-list guard), so a transient blip preserves state.
      activeCtl?.abort();
      const ctl = new AbortController();
      activeCtl = ctl;
      const timer = setTimeout(() => ctl.abort(), RECONCILE_TIMEOUT_MS);
      void reconcilePtys(ctl.signal)
        .catch((err) => {
          console.warn('[lifecycle] late reconcile failed — preserving ptyIds (no clear):', err);
        })
        .finally(() => clearTimeout(timer));
    });
    return () => {
      activeCtl?.abort();
      remove();
    };
  }, [reconcilePtys]);

  // Phase A — A6. Keep the module-level daemon-mode flag in sync with the
  // main process. The flag gates the renderer .txt scrollback path: while
  // daemon is connected, autosave skips and the IPC layer short-circuits
  // so the rotation-chain hazard (chronic 64-byte dumps overwriting good
  // backups) cannot fire. Local-mode users (daemon spawn fail / disconnect
  // mid-session) keep the .txt fallback exactly as before.
  useEffect(() => {
    // Read initial state — covers the case where main already finalised the
    // daemon decision before the renderer mounted (reload, crash recovery).
    void window.electronAPI.daemon.whenReady().then(({ connected }) => {
      setDaemonModeActive(connected);
    });
    const offConnected = window.electronAPI.daemon.onConnected(() => {
      setDaemonModeActive(true);
    });
    const offDisconnected = window.electronAPI.daemon.onDisconnected(() => {
      setDaemonModeActive(false);
    });
    return () => {
      offConnected();
      offDisconnected();
    };
  }, []);

  // Save session on beforeunload (with scrollback dump — sync fire-and-forget)
  useEffect(() => {
    const saveSession = () => {
      const dumped = dumpScrollbackBuffersSync();
      const data = buildSessionData(dumped);
      window.electronAPI.session.save(data);
    };

    window.addEventListener('beforeunload', saveSession);
    return () => window.removeEventListener('beforeunload', saveSession);
  }, []);

  // Periodic session save — protects against crashes.
  // Awaits scrollback dump completion before saving session.json to guarantee
  // files referenced in session data actually exist on disk.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!sessionLoadedRef.current) return;
      // Fix 0: skip autosave while startup reconcile is still in flight.
      // Without this guard, a half-reconciled snapshot (some surfaces
      // with old ptyId, some cleared) could be persisted on top of the
      // saved session — next startup would load garbage state.
      if (useStore.getState().paneGate !== 'ready') return;
      const dumped = dumpScrollbackBuffersSync();
      const data = buildSessionData(dumped);
      window.electronAPI.session.save(data);
    }, 5_000);
    return () => { clearInterval(interval); };
  }, []);

  // Auto-create initial surface for empty leaf panes (supports both single-leaf and preset branch roots)
  // 세션 복원된 경우: surfaces가 이미 있으므로 이 effect는 실행되지 않음
  // 브라우저 surface만 있는 pane: surfaceType이 'browser'이면 PTY 생성 스킵
  // Deps include the joined empty-leaf id signature so that splitPane (which adds
  // a new empty leaf without changing the workspace id) re-triggers PTY creation.
  // Without this, a freshly split pane stays as the "빈 창" placeholder forever.
  type LeafPane = import('../../../shared/types').PaneLeaf;
  const collectEmptyLeaves = (pane: import('../../../shared/types').Pane): LeafPane[] => {
    if (pane.type === 'leaf') {
      return pane.surfaces.length === 0 ? [pane] : [];
    }
    return pane.children.flatMap(collectEmptyLeaves);
  };
  const emptyLeafIdsKey = activeWorkspace
    ? collectEmptyLeaves(activeWorkspace.rootPane).map((l) => l.id).join('|')
    : '';

  useEffect(() => {
    if (!activeWorkspace) return;
    // Fix 0: wait until startup reconcile finishes before auto-creating
    // PTYs for empty leaves. Without this guard, the default workspace
    // (which has an empty leaf at app construction time) would spawn a
    // PTY before session.load() replaces it with the saved workspace —
    // leaking an orphaned daemon session and racing the user's restored
    // surfaces (codex outside-voice hole #4).
    if (paneGate !== 'ready') return;

    const emptyLeaves = collectEmptyLeaves(activeWorkspace.rootPane);
    if (emptyLeaves.length === 0) return;

    let cancelled = false;
    const wsId = activeWorkspace.id;

    for (const leaf of emptyLeaves) {
      const paneId = leaf.id;
      // Wrap through ipcInvoke so a rejected pty.create (e.g.
      // RESOURCE_EXHAUSTED when the daemon session cap is hit during a
      // Ctrl+D split) surfaces an actionable toast instead of leaving the
      // split as a permanent empty-leaf placeholder.
      void ipcInvoke<{ id: string; shell?: string; cwd?: string }>(() =>
        window.electronAPI.pty.create(
          withDefaultShell({ workspaceId: wsId }, useStore.getState().defaultShell)
        )
      ).then((result) => {
        if (!result.ok) return; // toast surfaced by useIpc
        const created = result.data;
        if (cancelled) {
          window.electronAPI.pty.dispose(created.id);
          return;
        }
        const shellName = created.shell ? shellDisplayName(created.shell) : 'Terminal';
        addSurface(paneId, created.id, shellName, created.cwd || '');
        // Set initial CWD in workspace metadata from first pane
        if (created.cwd) {
          const currentMeta = useStore.getState().workspaces.find((w) => w.id === wsId)?.metadata;
          if (!currentMeta?.cwd) {
            useStore.getState().updateWorkspaceMetadata(wsId, { cwd: created.cwd });
          }
        }
      });
    }

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- collectEmptyLeaves & addSurface & ipcInvoke are stable; emptyLeafIdsKey + paneGate are the meaningful triggers
  }, [activeWorkspace?.id, emptyLeafIdsKey, paneGate]);

  // Wizard close handler (T8a). Mirrors firstRunCompleted into uiSlice (main
  // already wrote the marker via firstRun:complete or :dismiss). The cheat
  // sheet auto-mounts via the derived condition below as soon as
  // firstRunCompleted flips true (D11) — no separate reveal flag needed.
  const handleWizardClose = useCallback(() => {
    setShowFirstRunWizard(null);
    setFirstRunCompleted(true);
  }, [setFirstRunCompleted]);

  if (!activeWorkspace) return null;

  return (
    <ErrorBoundary name="AppLayout">
    <div
      className={`flex h-screen w-screen bg-[var(--bg-base)] overflow-hidden ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`}
      style={{
        ...(prefixMode ? {
          boxShadow: 'inset 0 0 0 2px var(--accent-red)',
          transition: 'box-shadow 0.15s ease-in-out',
        } : {
          boxShadow: 'none',
          transition: 'box-shadow 0.15s ease-in-out',
        }),
      }}
    >
      <ErrorBoundary name="Sidebar">
        {sidebarVisible ? <Sidebar /> : <MiniSidebar />}
      </ErrorBoundary>
      <ErrorBoundary name="Main">
      <div className="flex-1 min-w-0 flex flex-col">
        <StatusBar />
        {/* Render workspaces: single view or multiview grid (Ctrl+click selected).
            Grid renders only when the active workspace is a member of the saved
            multiview group, so clicking outside the group shows that workspace's
            single view while the group is preserved for later restoration.

            Fix 0 — paneGate gate: while the startup reconcile is in flight, the
            PaneContainer area shows a "Restoring panes…" placeholder. Chrome
            (Sidebar, StatusBar) stays mounted so the user has immediate visual
            feedback that wmux is alive. Once reconcile resolves (success,
            timeout, or thrown), paneGate flips to 'ready' and the real panes
            mount with their final ptyId. */}
        {paneGate === 'pending' ? (
          <div className="flex-1 min-h-0 flex items-center justify-center text-sm" style={{ color: 'var(--text-sub2)' }}>
            {t('app.restoringPanes') || 'Restoring panes…'}
          </div>
        ) : multiviewIds.length >= 2 && multiviewIds.includes(activeWorkspaceId) ? (
          <div
            className="flex-1 min-h-0"
            style={{
              display: 'grid',
              gridTemplateColumns: multiviewIds.length === 2 ? '1fr 1fr'
                : multiviewIds.length <= 4 ? '1fr 1fr'
                : 'repeat(3, 1fr)',
              gridAutoRows: '1fr',
              gap: '2px',
              backgroundColor: 'var(--bg-surface)',
            }}
          >
            {multiviewIds
              .map((id) => workspaces.find((w) => w.id === id))
              .filter((ws): ws is Workspace => ws !== undefined)
              .map((ws) => (
              <div
                key={ws.id}
                className="relative flex flex-col min-w-0 min-h-0 overflow-hidden cursor-pointer"
                style={{
                  border: ws.id === activeWorkspaceId
                    ? '2px solid var(--accent-blue)'
                    : '2px solid transparent',
                  backgroundColor: 'var(--bg-base)',
                }}
                onClick={() => setActiveWorkspace(ws.id)}
              >
                {/* Workspace label */}
                <div
                  className="flex items-center gap-1.5 px-2 py-0.5 shrink-0 text-xs"
                  style={{
                    backgroundColor: ws.id === activeWorkspaceId ? 'var(--accent-blue)' : 'var(--bg-mantle)',
                    color: ws.id === activeWorkspaceId ? 'var(--bg-base)' : 'var(--text-sub2)',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  <span className="flex-1">{ws.name}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      // If we're closing the active tile and other members
                      // remain, hand focus to a neighbor first. Otherwise the
                      // grid render gate (multiviewIds.includes(activeId))
                      // fails the next render and the user sees the whole
                      // multiview collapse to the workspace they just closed,
                      // which reads as "the window reset" (codex P1).
                      if (ws.id === activeWorkspaceId && multiviewIds.length > 2) {
                        const removedIdx = multiviewIds.indexOf(ws.id);
                        const nextActive =
                          multiviewIds[removedIdx + 1] ?? multiviewIds[removedIdx - 1];
                        if (nextActive) setActiveWorkspace(nextActive);
                      }
                      removeMultiviewWorkspace(ws.id);
                    }}
                    className="ml-auto opacity-60 hover:opacity-100"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: 14,
                      lineHeight: 1,
                    }}
                    title="Remove from multiview"
                    aria-label={`Remove ${ws.name} from multiview`}
                  >
                    ✕
                  </button>
                </div>
                <div className="flex-1 min-h-0 relative">
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
                    <PaneContainer pane={ws.rootPane} workspace={ws} isWorkspaceVisible={true} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex-1 min-h-0 relative">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: ws.id === activeWorkspaceId ? 'flex' : 'none',
                  flexDirection: 'column',
                }}
              >
                <PaneContainer pane={ws.rootPane} workspace={ws} isWorkspaceVisible={ws.id === activeWorkspaceId} />
              </div>
            ))}
          </div>
        )}
      </div>
      </ErrorBoundary>
      {fileTreeVisible && (
        <ErrorBoundary name="FileTree">
          <FileTreePanel position={sidebarPosition === 'left' ? 'right' : 'left'} />
        </ErrorBoundary>
      )}
      <NotificationPanel />
      <MessageFeedPanel />
      {/* Cross-pane search results panel (T-F). Mount-gated on
          searchPanelOpen at this level (I3) so the panel's 6-field zustand
          subscriptions don't run when closed. */}
      {searchPanelOpen && (
        <ErrorBoundary name="SearchResultsPanel">
          <SearchResultsPanel />
        </ErrorBoundary>
      )}
      <CommandPalette />
      <SettingsPanel />
      <ApprovalDialog />
      <ExecuteApprovalDialog />
      <PermissionApprovalDialogContainer />

      {onboardingActive && (
        <OnboardingOverlay onComplete={() => { completeOnboarding(); }} />
      )}

      {/* First-run auto-update prompt */}
      {showAutoUpdatePrompt && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
        >
          <div
            className="flex flex-col gap-4 p-6 rounded-xl"
            style={{
              width: 400,
              backgroundColor: 'var(--bg-base)',
              border: '1px solid var(--bg-surface)',
              boxShadow: '0 25px 60px rgba(0,0,0,0.75)',
            }}
          >
            <p className="text-sm font-semibold text-[color:var(--text-main)] font-mono">
              {t('firstRun.autoUpdateTitle')}
            </p>
            <p className="text-xs text-[color:var(--text-sub)]">
              {t('firstRun.autoUpdateMessage')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  useStore.getState().setAutoUpdateEnabled(false);
                  window.electronAPI.settings.setAutoUpdateEnabled(false);
                  setShowAutoUpdatePrompt(false);
                }}
                className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-subtle)' }}
              >
                {t('firstRun.disable')}
              </button>
              <button
                onClick={() => {
                  useStore.getState().setAutoUpdateEnabled(true);
                  window.electronAPI.settings.setAutoUpdateEnabled(true);
                  setShowAutoUpdatePrompt(false);
                }}
                className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ backgroundColor: 'var(--accent-blue)', color: 'var(--bg-base)' }}
              >
                {t('firstRun.enable')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First-run wizard (T8a). Sits at z-[70] (declared inside the
          component) so it stacks above the auto-update prompt. T8b's
          SettingsPanel triggers a FIRST_RUN_REOPEN_EVENT window event to
          set mode='reopen' (D9). */}
      {showFirstRunWizard !== null && (
        <FirstRunWizard mode={showFirstRunWizard} onClose={handleWizardClose} />
      )}

      {/* Keyboard cheat sheet (T8a / Plan 1.18). Mounts derivatively from
          firstRunCompleted + !cheatSheetDismissed so that flipping
          cheatSheetDismissed=false from Settings (T8b) immediately re-mounts
          the sheet. The component itself is a no-op when dismissed (D11).
          `cheatSheetForceShown` (set by the `?` prefix action) bypasses the
          permanent dismissal so the cheat sheet can always be pulled back up. */}
      {firstRunCompleted && (!cheatSheetDismissed || cheatSheetForceShown) && <KeyboardCheatSheet />}

      {companyViewVisible && (
        <CompanyView onClose={() => setCompanyViewVisible(false)} />
      )}

      {/* Visual drag indicator — pointer-events always 'none' so it never
          blocks clicks, scrolling, or keyboard. Drop handling is done entirely
          via the window-level listeners registered in the useEffect above. */}
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            pointerEvents: 'none',
            backgroundColor: 'rgba(137, 180, 250, 0.08)',
          }}
        />
      )}
      <FloatingPane />
      <ToastContainer />
    </div>
    </ErrorBoundary>
  );
}
