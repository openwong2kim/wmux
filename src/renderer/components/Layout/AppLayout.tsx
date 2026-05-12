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
import { useNotificationListener } from '../../hooks/useNotificationListener';
import { useRpcBridge } from '../../hooks/useRpcBridge';
import { useResizeGuard } from '../../hooks/useResizeGuard';
import { useIpc } from '../../hooks/useIpc';
import type { SessionData, PaneLeaf, Pane, Surface, Workspace } from '../../../shared/types';
import { FIRST_RUN_REOPEN_EVENT } from '../../../shared/firstRun';
import { isFileDrag } from '../../../shared/dragDrop';
import { Terminal } from '@xterm/xterm';
import { terminalRegistry } from '../../hooks/useTerminal';
import { withDefaultShell } from '../../utils/ptyCreateOptions';

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

/** Serialize an xterm Terminal buffer to plain text.
 *  Only includes lines up to the cursor position (skips empty viewport padding). */
function serializeTerminalBuffer(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  // Only read up to baseY + cursorY (actual content), not the full viewport
  const lastLine = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  for (let i = 0; i <= lastLine && i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\r\n');
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

/** Deep-clone pane tree, setting scrollbackFile on dumped surfaces */
function cloneWithScrollback(pane: Pane, dumped: Map<string, boolean>): Pane {
  if (pane.type === 'leaf') {
    return {
      ...pane,
      surfaces: pane.surfaces.map((s) => ({
        ...s,
        scrollbackFile: dumped.has(s.id) ? s.id : s.scrollbackFile,
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
    tokenDataByPty: Object.keys(state.tokenDataByPty).length > 0 ? state.tokenDataByPty : undefined,
    // User preferences
    theme: state.theme,
    locale: state.locale,
    terminalFontSize: state.terminalFontSize,
    terminalFontFamily: state.terminalFontFamily,
    defaultShell: state.defaultShell,
    scrollbackLines: state.scrollbackLines,
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

  const multiviewIds = useStore((s) => s.multiviewIds);
  const clearMultiview = useStore((s) => s.clearMultiview);
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
  const setFirstRunCompleted = useStore((s) => s.setFirstRunCompleted);
  const [showFirstRunWizard, setShowFirstRunWizard] = useState<'firstRun' | 'reopen' | null>(null);

  const [showAutoUpdatePrompt, setShowAutoUpdatePrompt] = useState(false);
  const t = useT();

  useKeyboard();
  useNotificationListener();
  useRpcBridge();
  const { invoke: ipcInvoke } = useIpc();

  // ─── File drop — handled in preload where File.path is accessible ──────
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const sessionLoadedRef = useRef(false);

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
      window.electronAPI.pty.write(activeSurface.ptyId, text);
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

  // Reconcile saved PTY IDs with daemon's active sessions.
  // If a saved ptyId exists in the daemon, reconnect to it.
  // Otherwise, clear it so Terminal.tsx creates a fresh PTY.
  const reconcilePtys = useCallback(async () => {
    const listResult = await ipcInvoke<{ id: string }[]>(() =>
      window.electronAPI.pty.list()
    );
    if (!listResult.ok) {
      // Toast already shown by useIpc; skip reconciliation silently.
      console.error('[AppLayout] PTY reconciliation aborted:', listResult.error.code);
      return;
    }
    try {
      const activePtys = listResult.data;
      const activeIds = new Set(activePtys.map((p: { id: string }) => p.id));
      console.log('[AppLayout] Daemon active PTYs:', [...activeIds]);

      const state = useStore.getState();
      const reconcile = async (pane: Pane, wsId: string) => {
        if (pane.type === 'leaf') {
          for (const surface of pane.surfaces) {
            if (surface.surfaceType === 'browser' || surface.surfaceType === 'editor') continue;
            if (!surface.ptyId) {
              console.log(`[AppLayout] Surface ${surface.id}: no ptyId, will create new`);
              continue;
            }
            if (activeIds.has(surface.ptyId)) {
              console.log(`[AppLayout] Surface ${surface.id}: reconnecting to ${surface.ptyId}`);
              const result = await window.electronAPI.pty.reconnect(surface.ptyId);
              console.log(`[AppLayout] Reconnect result:`, result);
              if (!result.success) {
                console.warn(`[AppLayout] Reconnect failed, clearing ptyId`);
                useStore.getState().updateSurfacePtyId(pane.id, surface.id, '');
              }
            } else {
              console.log(`[AppLayout] Surface ${surface.id}: ptyId ${surface.ptyId} not in daemon, creating new PTY`);
              try {
                const newPty = await window.electronAPI.pty.create(
                  withDefaultShell({ cwd: surface.cwd, workspaceId: wsId }, useStore.getState().defaultShell)
                );
                useStore.getState().updateSurfacePtyId(pane.id, surface.id, newPty.id);
              } catch (err) {
                console.error(`[AppLayout] Failed to create replacement PTY:`, err);
                useStore.getState().updateSurfacePtyId(pane.id, surface.id, '');
              }
            }
          }
        } else {
          for (const child of pane.children) await reconcile(child, wsId);
        }
      };

      for (const ws of state.workspaces) {
        console.log(`[AppLayout] Reconciling workspace: ${ws.name}`);
        await reconcile(ws.rootPane, ws.id);
      }
      console.log('[AppLayout] Reconciliation complete');
    } catch (err) {
      console.error('[AppLayout] PTY reconciliation failed:', err);
    }
  }, [ipcInvoke]);

  // 앱 시작 시 세션 복원
  useEffect(() => {
    window.electronAPI.session.load().then(async (saved: SessionData | null) => {
      if (!saved) {
        sessionLoadedRef.current = true;
        // First ever launch — ask about auto-update
        setShowAutoUpdatePrompt(true);
        return;
      }

      // If autoUpdateEnabled was never set (upgrade from older version), prompt
      const isFirstAutoUpdateChoice = saved.autoUpdateEnabled == null;

      useStore.getState().loadSession(saved);
      sessionLoadedRef.current = true;

      if (isFirstAutoUpdateChoice) {
        setShowAutoUpdatePrompt(true);
      }

      // v2.8.1 hotfix (Bug 3): defer reconciliation until main has
      // settled the daemon-vs-local decision. Without this gate, the
      // reconcile fires while IPC handlers are mid-swap and pty.list
      // can hit a "no handler registered" rejection — the renderer
      // surfaces that as a generic "알 수 없는 오류" toast spam.
      await window.electronAPI.daemon.whenReady();

      await reconcilePtys();
    });
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
    const remove = window.electronAPI.daemon.onConnected(() => {
      console.log('[AppLayout] Daemon connected late — re-reconciling PTYs');
      reconcilePtys();
    });
    return remove;
  }, [reconcilePtys]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- collectEmptyLeaves & addSurface & ipcInvoke are stable; emptyLeafIdsKey is the meaningful trigger
  }, [activeWorkspace?.id, emptyLeafIdsKey]);

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
            single view while the group is preserved for later restoration. */}
        {multiviewIds.length >= 2 && multiviewIds.includes(activeWorkspaceId) ? (
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
                    onClick={(e) => { e.stopPropagation(); clearMultiview(); }}
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
                    title="Exit multiview"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex-1 min-h-0 relative">
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
                    <PaneContainer pane={ws.rootPane} isWorkspaceVisible={true} />
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
                <PaneContainer pane={ws.rootPane} isWorkspaceVisible={ws.id === activeWorkspaceId} />
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
          the sheet. The component itself is a no-op when dismissed (D11). */}
      {firstRunCompleted && !cheatSheetDismissed && <KeyboardCheatSheet />}

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
