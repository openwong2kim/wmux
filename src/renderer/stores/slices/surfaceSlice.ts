import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { createSurface, generateId } from '../../../shared/types';
import { isSafeBrowserUrl } from '../../utils/browserPane';
import { clearNudgesFor } from '../../hooks/channelMentionRateLimit';
import { saveSessionNow } from '../../utils/sessionSaveBridge';

export interface SurfaceSlice {
  /** Add a terminal surface to a pane. `workspaceId` lets RPC / eager-spawn
   * callers (e.g. the pane.split background-workspace path, #236) target a
   * non-active workspace — defaults to the active one, so existing positional
   * callers are unchanged. */
  addSurface: (paneId: string, ptyId: string, shell: string, cwd: string, workspaceId?: string) => void;
  addBrowserSurface: (paneId: string, url?: string, partition?: string, workspaceId?: string) => void;
  addEditorSurface: (paneId: string, filePath: string) => void;
  /** J2 — diff 리뷰 서피스 추가. taskId만 영속(diff 내용은 파생 데이터).
   * 같은 taskId가 이미 열려 있으면 그 탭으로 전환. editor/browser처럼 ptyId 없음. */
  addDiffSurface: (paneId: string, taskId: string, title?: string, workspaceId?: string, ownerWorkspaceId?: string) => void;
  /** Close a surface tab. `workspaceId` lets RPC/CLI callers target a
   * non-active workspace (defaults to the active one — existing callers are
   * unchanged). */
  closeSurface: (paneId: string, surfaceId: string, workspaceId?: string) => void;
  /** Activate a surface tab. `workspaceId` lets RPC/helper callers target a
   * non-active workspace (defaults to the active one — existing callers are
   * unchanged). */
  setActiveSurface: (paneId: string, surfaceId: string, workspaceId?: string) => void;
  nextSurface: (paneId: string) => void;
  prevSurface: (paneId: string) => void;
  updateSurfacePtyId: (paneId: string, surfaceId: string, ptyId: string) => void;
  updateSurfaceTitle: (surfaceId: string, title: string) => void;
  updateSurfaceTitleByPty: (ptyId: string, title: string) => void;
  /**
   * Update the live working directory of the surface bound to `ptyId`. Driven
   * by the OSC 7 shell-integration channel (onCwdChanged), so each terminal
   * tracks its own cwd — not just the workspace's single active cwd. Because
   * surfaces are persisted in session.json, this also makes the last cwd
   * survive a close/reopen, which the workspace "Working directories" menu and
   * the tab tooltip rely on. No-op for an empty ptyId or an unknown pty.
   */
  updateSurfaceCwd: (ptyId: string, cwd: string) => void;
  /**
   * Persist the browser surface's current URL. Driven by BrowserPanel's
   * did-navigate events (user clicks, toolbar, MCP/CDP navigations alike), so
   * a session restore reopens the page the user last saw instead of the URL
   * the surface was created with. Only http(s) URLs are recorded —
   * about:blank / devtools schemes must not survive into session.json — and a
   * same-value write returns without mutating (immer keeps the object
   * identity, so zustand does not notify; SPAs spam did-navigate-in-page).
   */
  updateBrowserUrl: (surfaceId: string, url: string) => void;
  updateBrowserPartition: (partition: string, surfaceId?: string) => void;
}

function findLeafPane(root: Pane, id: string): PaneLeaf | null {
  if (root.id === id && root.type === 'leaf') return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findLeafPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * v2 RCA fix (reboot-reattach, axis A): centralized immediate persistence for
 * surface↔ptyId bindings. EVERY caller of addSurface / updateSurfacePtyId
 * (Terminal self-create, '+' tab, palette, keyboard split, project commands,
 * MCP surface_new / pane_split, reconcile rebind/clear, …) gets the flush for
 * free — call-site-by-call-site saveSessionNow() sprinkling covered only 2 of
 * 9 binding sites (codex P2 + maintainability review).
 *
 * Gated on paneGate==='ready': startup-reconcile mutations (clears/rebinds
 * while the gate is still 'pending') are deliberately NOT persisted here — the
 * startup path saves once on SUCCESSFUL reconcile completion, and persisting a
 * mid-reconcile snapshot is exactly the half-reconciled-garbage class the 5s
 * periodic tick's own gate guards against. The registered saver additionally
 * no-ops until session.load() succeeded (sessionLoadedRef guard in AppLayout).
 */
function persistBindingNow(get: () => StoreState): void {
  if (get().paneGate !== 'ready') return;
  saveSessionNow();
}

export const createSurfaceSlice: StateCreator<StoreState, [['zustand/immer', never]], [], SurfaceSlice> = (set, get) => ({
  addSurface: (paneId, ptyId, shell, cwd, workspaceId) => {
    set((state: StoreState) => {
      const targetWsId = workspaceId || state.activeWorkspaceId;
      const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
      if (!ws) return;
      const pane = findLeafPane(ws.rootPane, paneId);
      if (!pane) return;
      const surface = createSurface(ptyId, shell, cwd);
      pane.surfaces.push(surface);
      pane.activeSurfaceId = surface.id;
    });
    persistBindingNow(get);
  },

  addBrowserSurface: (paneId, url, partition, workspaceId) => set((state: StoreState) => {
    const targetWsId = workspaceId || state.activeWorkspaceId;
    const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    const surface: Surface = {
      id: generateId('surface'),
      ptyId: '',
      title: 'Browser',
      shell: '',
      cwd: '',
      surfaceType: 'browser',
      browserUrl: url || 'https://google.com',
      browserPartition: partition || 'persist:wmux-default',
    };
    pane.surfaces.push(surface);
    pane.activeSurfaceId = surface.id;
  }),

  addEditorSurface: (paneId, filePath) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    // If the same file is already open, switch to that tab
    const existing = pane.surfaces.find((s) => s.surfaceType === 'editor' && s.editorFilePath === filePath);
    if (existing) {
      pane.activeSurfaceId = existing.id;
      return;
    }
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const surface: Surface = {
      id: generateId('surface'),
      ptyId: '',
      title: fileName,
      shell: '',
      cwd: '',
      surfaceType: 'editor',
      editorFilePath: filePath,
    };
    pane.surfaces.push(surface);
    pane.activeSurfaceId = surface.id;
  }),

  addDiffSurface: (paneId, taskId, title, workspaceId, ownerWorkspaceId) => set((state: StoreState) => {
    const targetWsId = workspaceId || state.activeWorkspaceId;
    const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    // 같은 태스크 diff가 이미 열려 있으면 그 탭으로 전환. F1 backfill: J3 이전에
    // 만들어진 서피스는 diffOwnerWorkspaceId가 없다 — 재사용 시 이번에 전달된
    // owner를 채워 owner 스코프 RPC(close/PR/meta)가 자식 ws로 폴백하지 않게 한다.
    const existing = pane.surfaces.find((s) => s.surfaceType === 'diff' && s.diffTaskId === taskId);
    if (existing) {
      if (ownerWorkspaceId && !existing.diffOwnerWorkspaceId) {
        existing.diffOwnerWorkspaceId = ownerWorkspaceId;
      }
      pane.activeSurfaceId = existing.id;
      return;
    }
    const surface: Surface = {
      id: generateId('surface'),
      ptyId: '',
      title: title || 'Diff',
      shell: '',
      cwd: '',
      surfaceType: 'diff',
      diffTaskId: taskId,
      // F1: task.mission.* RPC가 owner 스코프라 owner(부모) ws id를 실어둔다.
      ...(ownerWorkspaceId ? { diffOwnerWorkspaceId: ownerWorkspaceId } : {}),
    };
    pane.surfaces.push(surface);
    pane.activeSurfaceId = surface.id;
  }),

  closeSurface: (paneId, surfaceId, workspaceId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === (workspaceId || state.activeWorkspaceId));
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;

    const idx = pane.surfaces.findIndex((s) => s.id === surfaceId);
    if (idx === -1) return;

    // Part A: drop per-surface agent identity so the surfaceAgent map doesn't
    // retain a label for a PTY that no longer has a surface. (surfaceAgent is
    // owned by paneSlice; guard the cross-slice access so an isolated test store
    // composed without paneSlice doesn't trip on an undefined map.) The Fleet
    // activity line (surfaceActivity, also paneSlice-owned, keyed by ptyId) is
    // the OTHER real teardown site — clear it here too so a closed surface's
    // last activity string doesn't survive on a re-used ptyId.
    const closedPtyId = pane.surfaces[idx].ptyId;
    if (closedPtyId && state.surfaceAgent) delete state.surfaceAgent[closedPtyId];
    if (closedPtyId && state.surfaceActivity) delete state.surfaceActivity[closedPtyId];
    if (closedPtyId) clearNudgesFor(closedPtyId); // A5: free the rate-cap entry for a reusable ptyId
    // J3 F4: onExhausted 매핑도 이 ptyId 소멸과 함께 evict(무한 성장·재사용 ptyId 오염 방지).
    if (closedPtyId && state.taskPtyRegistry) delete state.taskPtyRegistry[closedPtyId];

    pane.surfaces.splice(idx, 1);
    if (pane.activeSurfaceId === surfaceId) {
      pane.activeSurfaceId = pane.surfaces[Math.min(idx, pane.surfaces.length - 1)]?.id || '';
    }
  }),

  setActiveSurface: (paneId, surfaceId, workspaceId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === (workspaceId || state.activeWorkspaceId));
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    if (pane.surfaces.some((s) => s.id === surfaceId)) {
      pane.activeSurfaceId = surfaceId;
    }
  }),

  nextSurface: (paneId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane || pane.surfaces.length <= 1) return;
    const idx = pane.surfaces.findIndex((s) => s.id === pane.activeSurfaceId);
    pane.activeSurfaceId = pane.surfaces[(idx + 1) % pane.surfaces.length].id;
  }),

  prevSurface: (paneId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane || pane.surfaces.length <= 1) return;
    const idx = pane.surfaces.findIndex((s) => s.id === pane.activeSurfaceId);
    pane.activeSurfaceId = pane.surfaces[(idx - 1 + pane.surfaces.length) % pane.surfaces.length].id;
  }),

  updateSurfacePtyId: (paneId, surfaceId, ptyId) => {
    set((state: StoreState) => {
      for (const ws of state.workspaces) {
        const pane = findLeafPane(ws.rootPane, paneId);
        if (!pane) continue;
        const surface = pane.surfaces.find((s) => s.id === surfaceId);
        if (surface) {
          surface.ptyId = ptyId;
          return;
        }
      }
    });
    persistBindingNow(get);
  },

  updateSurfaceTitle: (surfaceId, title) => set((state: StoreState) => {
    for (const ws of state.workspaces) {
      const updateInPane = (pane: Pane): boolean => {
        if (pane.type === 'leaf') {
          const surface = pane.surfaces.find((s) => s.id === surfaceId);
          if (surface) { surface.title = title; surface.titleLocked = true; return true; }
          return false;
        }
        return pane.children.some(updateInPane);
      };
      if (updateInPane(ws.rootPane)) return;
    }
  }),

  updateSurfaceCwd: (ptyId, cwd) => set((state: StoreState) => {
    if (!ptyId) return;
    for (const ws of state.workspaces) {
      const updateInPane = (pane: Pane): boolean => {
        if (pane.type === 'leaf') {
          const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
          if (surface) { surface.cwd = cwd; return true; }
          return false;
        }
        return pane.children.some(updateInPane);
      };
      if (updateInPane(ws.rootPane)) return;
    }
  }),

  updateSurfaceTitleByPty: (ptyId, title) => set((state: StoreState) => {
    if (!ptyId) return;
    for (const ws of state.workspaces) {
      const updateInPane = (pane: Pane): boolean => {
        if (pane.type === 'leaf') {
          const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
          if (!surface) return false;
          // Terminal surfaces only, and never override a user's manual rename.
          if ((surface.surfaceType ?? 'terminal') === 'terminal' && !surface.titleLocked) {
            surface.title = title;
          }
          return true;
        }
        return pane.children.some(updateInPane);
      };
      if (updateInPane(ws.rootPane)) return;
    }
  }),

  updateBrowserUrl: (surfaceId, url) => set((state: StoreState) => {
    if (!isSafeBrowserUrl(url)) return;
    for (const ws of state.workspaces) {
      const updateInPane = (pane: Pane): boolean => {
        if (pane.type === 'leaf') {
          const surface = pane.surfaces.find((s) => s.id === surfaceId);
          if (!surface) return false;
          if (surface.surfaceType !== 'browser') return true; // found but not a browser — ignore
          if (surface.browserUrl !== url) surface.browserUrl = url;
          return true;
        }
        return pane.children.some(updateInPane);
      };
      if (updateInPane(ws.rootPane)) return;
    }
  }),

  updateBrowserPartition: (partition, surfaceId) => set((state: StoreState) => {
    for (const ws of state.workspaces) {
      const updateInPane = (pane: Pane): boolean => {
        if (pane.type === 'leaf') {
          let updated = false;
          for (const surface of pane.surfaces) {
            if (surface.surfaceType !== 'browser') continue;
            if (surfaceId && surface.id !== surfaceId) continue;
            surface.browserPartition = partition;
            updated = true;
          }
          return updated;
        }
        return pane.children.some(updateInPane);
      };
      if (updateInPane(ws.rootPane) && surfaceId) return;
    }
  }),
});
