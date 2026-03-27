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
import CompanyView from '../Company/CompanyView';
import MessageFeedPanel from '../Company/MessageFeedPanel';
import { ErrorBoundary } from '../ErrorBoundary';
import { useKeyboard } from '../../hooks/useKeyboard';
import { useNotificationListener } from '../../hooks/useNotificationListener';
import { useRpcBridge } from '../../hooks/useRpcBridge';
import { useResizeGuard } from '../../hooks/useResizeGuard';
import type { SessionData, PaneLeaf, Pane, Surface } from '../../../shared/types';
import { Terminal } from '@xterm/xterm';
import { terminalRegistry } from '../../hooks/useTerminal';

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

  const [showAutoUpdatePrompt, setShowAutoUpdatePrompt] = useState(false);
  const t = useT();

  useKeyboard();
  useNotificationListener();
  useRpcBridge();

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
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) setIsDragging(true);
    };
    const onLeave = () => {
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
    try {
      const activePtys = await window.electronAPI.pty.list();
      const activeIds = new Set(activePtys.map((p: { id: string }) => p.id));
      console.log('[AppLayout] Daemon active PTYs:', [...activeIds]);

      const state = useStore.getState();
      const reconcile = async (pane: Pane) => {
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
                const newPty = await window.electronAPI.pty.create({ cwd: surface.cwd });
                useStore.getState().updateSurfacePtyId(pane.id, surface.id, newPty.id);
              } catch (err) {
                console.error(`[AppLayout] Failed to create replacement PTY:`, err);
                useStore.getState().updateSurfacePtyId(pane.id, surface.id, '');
              }
            }
          }
        } else {
          for (const child of pane.children) await reconcile(child);
        }
      };

      for (const ws of state.workspaces) {
        console.log(`[AppLayout] Reconciling workspace: ${ws.name}`);
        await reconcile(ws.rootPane);
      }
      console.log('[AppLayout] Reconciliation complete');
    } catch (err) {
      console.error('[AppLayout] PTY reconciliation failed:', err);
    }
  }, []);

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

      await reconcilePtys();
    });
  }, []);

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

  // Auto-create initial surface for empty leaf panes
  // 세션 복원된 경우: surfaces가 이미 있으므로 이 effect는 실행되지 않음
  // 브라우저 surface만 있는 pane: surfaceType이 'browser'이면 PTY 생성 스킵
  useEffect(() => {
    if (!activeWorkspace) return;
    const root = activeWorkspace.rootPane;
    if (root.type !== 'leaf') return;

    // surfaces가 비어있을 때만 새 PTY 생성
    if (root.surfaces.length === 0) {
      let cancelled = false;
      const paneId = root.id;
      window.electronAPI.pty.create().then((result: { id: string; cwd?: string }) => {
        if (cancelled) {
          window.electronAPI.pty.dispose(result.id);
          return;
        }
        addSurface(paneId, result.id, 'Terminal', result.cwd || '');
        // Set initial CWD in workspace metadata so FileTree can use it immediately
        if (result.cwd && activeWorkspace) {
          useStore.getState().updateWorkspaceMetadata(activeWorkspace.id, { cwd: result.cwd });
        }
      });
      return () => { cancelled = true; };
    }

    // surfaces가 있지만 모두 browser 타입인 경우 PTY 생성 스킵
    const hasTerminalSurface = root.surfaces.some(
      (s) => !s.surfaceType || s.surfaceType === 'terminal'
    );
    if (!hasTerminalSurface) {
      // 브라우저만 있는 pane — PTY 불필요, 아무것도 하지 않음
      return;
    }
  }, [activeWorkspace?.id]);

  if (!activeWorkspace) return null;

  return (
    <ErrorBoundary name="AppLayout">
    <div className={`flex h-screen w-screen bg-[var(--bg-base)] overflow-hidden ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`}>
      <ErrorBoundary name="Sidebar">
        {sidebarVisible ? <Sidebar /> : <MiniSidebar />}
      </ErrorBoundary>
      <ErrorBoundary name="Main">
      <div className="flex-1 min-w-0 flex flex-col">
        <StatusBar />
        {/* Render workspaces: single view or multiview grid (Ctrl+click selected) */}
        {multiviewIds.length >= 2 ? (
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
            {workspaces.filter((ws) => multiviewIds.includes(ws.id)).map((ws) => (
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
                    color: ws.id === activeWorkspaceId ? '#fff' : 'var(--text-sub2)',
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
      <CommandPalette />
      <SettingsPanel />
      <ApprovalDialog />

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
                style={{ backgroundColor: 'var(--accent-blue)', color: '#1e1e2e' }}
              >
                {t('firstRun.enable')}
              </button>
            </div>
          </div>
        </div>
      )}

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
    </div>
    </ErrorBoundary>
  );
}
