import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { createRemoteSurface, createSurface, generateId } from '../../../shared/types';
import { isPlausibleCwd } from '../../../shared/cwdShape';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { isSafeBrowserUrl } from '../../utils/browserPane';
import { clearNudgesFor } from '../../hooks/channelMentionRateLimit';
import { saveSessionNow } from '../../utils/sessionSaveBridge';
import { publishPaneClosed } from '../../events/publisher';
import { panePrincipalId } from '../../../shared/principals';
import { computePaneAutoName } from '../../utils/paneNaming';
import { recomputeWorkspacePorts } from './workspacePorts';

export interface SurfaceSlice {
  /** Add a terminal surface to a pane. `workspaceId` lets RPC / eager-spawn
   * callers (e.g. the pane.split background-workspace path, #236) target a
   * non-active workspace — defaults to the active one, so existing positional
   * callers are unchanged. */
  addSurface: (paneId: string, ptyId: string, shell: string, cwd: string, workspaceId?: string) => void;
  addBrowserSurface: (paneId: string, url?: string, partition?: string, workspaceId?: string) => void;
  /** #1086/#1091 — mirror a session on a paired remote host as a surface in
   * an ordinary LOCAL workspace's own pane tree (stage 1: store only, no
   * SSE attach yet — that's the renderer wiring in Pane.tsx, a follow-up).
   * Same shape as addBrowserSurface: caller splits an empty leaf first via
   * splitPane, then calls this to populate it. ptyId stays '' (see
   * createRemoteSurface), so every ptyId-gated check already treats this
   * surface as non-local without further changes. */
  addRemoteSurface: (paneId: string, hostId: string, sessionId: string, shell?: string, cwd?: string, workspaceId?: string, owned?: boolean) => void;
  addEditorSurface: (paneId: string, filePath: string) => void;
  /** J2 — diff 리뷰 서피스 추가. taskId만 영속(diff 내용은 파생 데이터).
   * 같은 taskId가 이미 열려 있으면 그 탭으로 전환. editor/browser처럼 ptyId 없음. */
  addDiffSurface: (paneId: string, taskId: string, title?: string, workspaceId?: string, ownerWorkspaceId?: string) => void;
  /** 워크스페이스 diff 서피스 — repoPath(worktree toplevel)만 영속(diff 내용은 파생).
   * 같은 repoPath가 이미 열려 있으면 그 탭으로 전환. diff/editor처럼 ptyId 없음. */
  addWorkspaceDiffSurface: (paneId: string, repoPath: string, title?: string, workspaceId?: string) => void;
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
  /** #1086/#1091 — the remote-terminal twin of updateSurfaceTitleByPty. A
   *  remote-terminal surface's ptyId is always '' (see createRemoteSurface),
   *  so it can never be found by that lookup — this one is keyed by surfaceId
   *  directly instead, the same identity RemotePaneSurface already has to
   *  hand. Same manual-rename guard: never overrides a titleLocked surface. */
  updateRemoteSurfaceTitle: (surfaceId: string, title: string) => void;
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

/**
 * Locate a leaf by id anywhere a workspace OWNS it — visible tree or stash.
 *
 * This is the write seam (#977). Widening only the READ paths would have made
 * the feature look correct and behave broken: reconcile decides a stashed pty
 * is dead, calls updateSurfacePtyId to clear it, the visible-tree lookup misses,
 * the CAS logs a SKIP, and the derived `exited` state — the whole reason the
 * user is told a stashed session died — never arrives for any pane.
 */
function findOwnedLeafPane(ws: Workspace, id: string): PaneLeaf | null {
  const visible = findLeafPane(ws.rootPane, id);
  if (visible) return visible;
  for (const entry of ws.stashedPanes ?? []) {
    const pane = entry?.pane;
    if (pane && pane.type === 'leaf' && pane.id === id) return pane;
  }
  return null;
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

  addRemoteSurface: (paneId, hostId, sessionId, shell, cwd, workspaceId, owned) => set((state: StoreState) => {
    const targetWsId = workspaceId || state.activeWorkspaceId;
    const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    const surface = createRemoteSurface(hostId, sessionId, shell || '', cwd || '', owned === true);
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

  addWorkspaceDiffSurface: (paneId, repoPath, title, workspaceId) => set((state: StoreState) => {
    const targetWsId = workspaceId || state.activeWorkspaceId;
    const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
    if (!ws) return;
    const pane = findLeafPane(ws.rootPane, paneId);
    if (!pane) return;
    // 같은 repo diff가 이미 열려 있으면 그 탭으로 전환(addDiffSurface와 동형).
    const existing = pane.surfaces.find(
      (s) => s.surfaceType === 'diff' && s.diffRepoPath === repoPath,
    );
    if (existing) {
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
      diffRepoPath: repoPath,
    };
    pane.surfaces.push(surface);
    pane.activeSurfaceId = surface.id;
  }),

  // A stashed pane's tabs are still closable — the surface is an ADDRESS, not
  // a position, and pane.close/surface.close on a stashed pane must work or the
  // agent that created it cannot clean it up (E-7).
  closeSurface: (paneId, surfaceId, workspaceId) => {
    // Captured for the post-producer teardown of a stashed pane that just lost
    // its LAST tab. closePane publishes pane.closed and purges the channel
    // principal for exactly this destruction; doing less here left pollers and
    // channel membership holding a pane that no longer exists (review).
    let stashDropped: {
      wsId: string;
      paneId: string;
      principal: { principalId: string; autoName: string } | null;
    } | null = null;
    set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === (workspaceId || state.activeWorkspaceId));
    if (!ws) return;
    const pane = findOwnedLeafPane(ws, paneId);
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
    const closedSurfaceType = pane.surfaces[idx].surfaceType ?? 'terminal';
    // Read BEFORE the evictions below: the principal-purge gate needs to know
    // whether the tab that is closing was an agent — the same test closePane
    // applies per leaf, asked here about the one surface being destroyed.
    const closedAgent = closedPtyId ? state.surfaceAgent?.[closedPtyId] : undefined;
    if (state.pendingDeadPaneRecoveryBySurfaceId) {
      delete state.pendingDeadPaneRecoveryBySurfaceId[surfaceId];
    }
    if (closedPtyId && state.deadPaneRecoveryOfferByPtyId?.[closedPtyId]) {
      delete state.deadPaneRecoveryOfferByPtyId[closedPtyId];
      delete state.resumeHintByPtyId[closedPtyId];
      delete state.resumeBindingByPtyId[closedPtyId];
    }
    if (closedPtyId && state.surfaceAgent) delete state.surfaceAgent[closedPtyId];
    if (closedPtyId && state.surfaceActivity) delete state.surfaceActivity[closedPtyId];
    // Drop the pending question too: a leaked entry would let a REUSED ptyId
    // inherit a dead pane's question and read as blocked from birth.
    if (closedPtyId && state.surfacePendingQuestion) delete state.surfacePendingQuestion[closedPtyId];
    // Drop per-surface ports and agent status too (fleet-activity adversarial
    // review): without this, every closed surface leaves a dead ptyId entry
    // behind, and a REUSED ptyId inherits the previous surface's status.
    if (closedPtyId && state.surfacePorts) {
      delete state.surfacePorts[closedPtyId];
      // #1135: the workspace badge is a union over surfacePorts — recompute it
      // here or the closed surface's ports stay on the sidebar forever.
      recomputeWorkspacePorts(state.workspaces, state.surfacePorts);
    }
    if (closedPtyId && state.surfaceAgentStatus) delete state.surfaceAgentStatus[closedPtyId];
    // Same rule for the turn latch: it outranks the byte heuristic, so a leaked
    // entry would pin a REUSED ptyId at 'running' with no live agent to end it.
    if (closedPtyId && state.surfaceTurnOpenAt) delete state.surfaceTurnOpenAt[closedPtyId];
    if (closedPtyId) clearNudgesFor(closedPtyId); // A5: free the rate-cap entry for a reusable ptyId
    // J3 F4: onExhausted 매핑도 이 ptyId 소멸과 함께 evict(무한 성장·재사용 ptyId 오염 방지).
    if (closedPtyId && state.taskPtyRegistry) delete state.taskPtyRegistry[closedPtyId];

    pane.surfaces.splice(idx, 1);
    if (pane.activeSurfaceId === surfaceId) {
      pane.activeSurfaceId = pane.surfaces[Math.min(idx, pane.surfaces.length - 1)]?.id || '';
    }

    // #977 — a STASHED pane that just lost its last surface has to go with it.
    // An empty leaf is a legitimate thing on screen (the funnel backfills it),
    // but an empty STASHED pane is unreachable: the roster builds its row from a
    // surface and skips it, so the pane would sit there holding an ordinal and a
    // slot against the pane cap with no way to click it back. The teardown above
    // already ran for the surface that was removed; what is left is dropping the
    // entry and the pane-level mirrors.
    if (pane.surfaces.length === 0) {
      const stashIdx = (ws.stashedPanes ?? []).findIndex((e) => e?.pane?.id === paneId);
      if (stashIdx !== -1) {
        ws.stashedPanes!.splice(stashIdx, 1);
        if (ws.stashedPanes!.length === 0) delete ws.stashedPanes;
        if (state.paneLabel) delete state.paneLabel[paneId];
        if (state.paneRole) delete state.paneRole[paneId];
        if (state.paneNotificationRing) delete state.paneNotificationRing[paneId];
        console.log(`[wmux:stash] dropped empty stashed pane=${paneId} (last surface closed)`);
        stashDropped = {
          wsId: ws.id,
          paneId,
          principal:
            closedSurfaceType !== 'browser' && closedPtyId && closedAgent?.name
              ? {
                  principalId: panePrincipalId(ws.id, paneId),
                  autoName: computePaneAutoName(ws.wsOrdinal ?? 0, pane.ordinal ?? 0, closedAgent.slug),
                }
              : null,
        };
      }
    }
    });
    if (stashDropped) {
      const d = stashDropped as {
        wsId: string;
        paneId: string;
        principal: { principalId: string; autoName: string } | null;
      };
      // The pane is genuinely gone now — not stashed, GONE — so this is the one
      // stash-adjacent path that DOES report pane.closed (stash/unstash have
      // their own event pair precisely because they are not this).
      publishPaneClosed(d.wsId, d.paneId);
      // Same R2 cleanup closePane runs, gated the same way (the closed tab was
      // an agent): channel member rows by canonical principalId, legacy rows by
      // autoName, then the principal itself. Optional-chained for test stores
      // composed without the channels slice.
      if (d.principal) {
        void get().purgeMembershipDaemon?.({ workspaceId: d.wsId, principalId: d.principal.principalId });
        void get().purgeMembershipDaemon?.({ workspaceId: d.wsId, memberId: d.principal.autoName });
        void get().principalRemoveDaemon?.(d.principal.principalId);
      }
    }
  },

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
        const pane = findOwnedLeafPane(ws, paneId);
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
      for (const pane of getWorkspaceLeafPanes(ws)) {
        const surface = pane.surfaces.find((s) => s.id === surfaceId);
        if (surface) { surface.title = title; surface.titleLocked = true; return; }
      }
    }
  }),

  updateSurfaceCwd: (ptyId, cwd) => set((state: StoreState) => {
    if (!ptyId) return;
    // 프롬프트 스크래핑 오탐 방어 — 구버전 데몬이 화면 텍스트에서 긁은
    // 불가능한 모양의 경로(맥에서 "C:\…")는 기존 cwd를 덮지 않는다.
    if (!isPlausibleCwd(cwd)) return;
    for (const ws of state.workspaces) {
      for (const pane of getWorkspaceLeafPanes(ws)) {
        const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
        if (surface) { surface.cwd = cwd; return; }
      }
    }
  }),

  updateSurfaceTitleByPty: (ptyId, title) => set((state: StoreState) => {
    if (!ptyId) return;
    for (const ws of state.workspaces) {
      for (const pane of getWorkspaceLeafPanes(ws)) {
        const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
        if (!surface) continue;
        // Terminal surfaces only, and never override a user's manual rename.
        if ((surface.surfaceType ?? 'terminal') === 'terminal' && !surface.titleLocked) {
          surface.title = title;
        }
        return;
      }
    }
  }),

  updateRemoteSurfaceTitle: (surfaceId, title) => set((state: StoreState) => {
    for (const ws of state.workspaces) {
      for (const pane of getWorkspaceLeafPanes(ws)) {
        const surface = pane.surfaces.find((s) => s.id === surfaceId);
        if (!surface) continue;
        if (surface.surfaceType === 'remote-terminal' && !surface.titleLocked) {
          surface.title = title;
        }
        return;
      }
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
