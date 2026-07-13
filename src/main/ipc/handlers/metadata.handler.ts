import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import { IPC } from '../../../shared/constants';
import type { MetadataUpdatePayload } from '../../../shared/types';
import { MetadataCollector } from '../../metadata/MetadataCollector';
import { prStatusCache } from '../../metadata/PrStatusCache';
import { PTYManager } from '../../pty/PTYManager';
import { wrapHandler } from '../wrapHandler';
import { metadataStore } from '../../metadata/MetadataStore';
import { ORCH_ROLE_KEY, readOrchRole } from '../../../shared/orchestratorRole';

/**
 * Single source for IPC.METADATA_UPDATE outgoing messages. All metadata-like
 * channels (this handler's CWD/git polling, PTYBridge's agent status events,
 * meta.rpc's status/progress RPCs) send through `MetadataUpdatePayload` so
 * the preload + renderer contract has exactly one shape.
 */
export function broadcastMetadataUpdate(
  window: BrowserWindow | null,
  payload: MetadataUpdatePayload,
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.METADATA_UPDATE, payload);
}

/**
 * Whether the 5 s metadata poll should run for this window right now.
 *
 * Metadata (git branch, listening ports, PR badge) is purely cosmetic and
 * only matters for a UI the user can actually see. When the window is hidden
 * to tray or minimized, the per-PTY git / `gh` / `/proc` work the poll drives
 * is the dominant idle cost on the main process for a UI nobody is looking at.
 * Skipping it then makes a backgrounded wmux go quiet; the next visible tick
 * (≤5 s after the window returns) refreshes everything, so staleness is
 * bounded. Mirrors UsagePoller's hidden-window cost control.
 */
export function shouldPollMetadata(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;
  if (win.webContents.isLoading()) return false;
  if (!win.isVisible() || win.isMinimized()) return false;
  return true;
}

const collector = new MetadataCollector();

// Track CWD per ptyId (updated via OSC 7, prompt detection, or initial registration)
const cwdMap = new Map<string, string>();

// Track git branch per ptyId. X1: fed by the fs.watch GitContextWatcher
// (daemon broadcast → WorkspaceContextRouter, or localContextWatch in local
// mode); OSC 7727 shell integration also still writes here.
const branchMap = new Map<string, string>();

// X1 — linked-worktree flag per ptyId (same watcher as branchMap).
const worktreeMap = new Map<string, boolean>();

// X1 — PID-tree-scoped listening ports per ptyId, fed by PortWatcher.
// Replaces the old machine-global Get-NetTCPConnection scan that showed the
// same first-20 ports on every workspace.
const portsMap = new Map<string, number[]>();

// X1 — local-mode hook: GitContextWatcher needs to re-resolve the repo on
// every cwd change, and updateCwd() is the single funnel both PTY modes
// already call. Daemon mode registers nothing here (the daemon process owns
// the watcher); local mode registers via localContextWatch.
type CwdListener = (ptyId: string, cwd: string) => void;
const cwdListeners = new Set<CwdListener>();
export function onCwdUpdate(listener: CwdListener): () => void {
  cwdListeners.add(listener);
  return () => { cwdListeners.delete(listener); };
}

/**
 * Build the poll/request payload for one PTY from the watcher-fed caches.
 * `gh` PR resolution rides the 5 min PrStatusCache TTL, so including it on
 * the 5 s tick costs one subprocess per repo per TTL window.
 */
async function buildMetadataPayload(ptyId: string): Promise<MetadataUpdatePayload | null> {
  const cwd = cwdMap.get(ptyId);
  if (!cwd) return null;
  // Watcher/shell-integration branch wins; exec git only as fallback so a
  // session that predates the watcher (or a watch failure) still resolves.
  const gitBranch = branchMap.get(ptyId) ?? (await collector.getGitBranch(cwd)) ?? '';
  const payload: MetadataUpdatePayload = { ptyId, cwd, gitBranch };
  const isWorktree = worktreeMap.get(ptyId);
  if (isWorktree !== undefined) payload.gitIsWorktree = isWorktree;
  const ports = portsMap.get(ptyId);
  if (ports !== undefined) payload.listeningPorts = ports;
  if (gitBranch) {
    payload.pr = await prStatusCache.get(cwd, gitBranch);
  } else {
    payload.pr = null;
  }
  return payload;
}

export function registerMetadataHandlers(
  ptyManager: PTYManager,
  getWindow: () => BrowserWindow | null,
  // X1: in daemon mode, PTYs live in the daemon — `ptyManager.get()` is
  // empty for every daemon session, and the historical unconditional prune
  // wiped cwdMap within one tick of registration (which is why the 5 s poll
  // never produced metadata on the default production path). Liveness-prune
  // only when this process actually owns the PTYs; daemon-session cleanup
  // is event-driven via WorkspaceContextRouter's session:died/destroyed.
  opts: { localPtyOwnership?: boolean } = {},
): () => void {
  const localPtyOwnership = opts.localPtyOwnership !== false;
  // Handle metadata request from renderer
  ipcMain.removeHandler(IPC.METADATA_REQUEST);
  ipcMain.handle(IPC.METADATA_REQUEST, wrapHandler(IPC.METADATA_REQUEST, async (_event: Electron.IpcMainInvokeEvent, ptyId: string) => {
    const payload = await buildMetadataPayload(ptyId);
    if (!payload) return {};
    const rest = { ...payload };
    delete rest.ptyId;
    return rest;
  }));

  // P2 bootstrap (checklist C): MetadataStore.hydrate emits no events, so the
  // renderer's volatile paneLabel mirror is empty after a restart. The renderer
  // pulls this snapshot once on mount to seed labels for already-labeled panes;
  // live renames then flow via the pane.metadata.changed relay.
  ipcMain.removeHandler(IPC.METADATA_SNAPSHOT);
  ipcMain.handle(IPC.METADATA_SNAPSHOT, wrapHandler(IPC.METADATA_SNAPSHOT, async () => {
    // Seed BOTH the label and the orchestrator-role mirrors on mount. The
    // boot-time push (index.ts) can land before useNotificationListener
    // subscribes, so this pull is the reliable complement — and it must carry
    // role too, or a persisted role stays invisible after restart until the
    // next metadata change (CodeRabbit review). Include a pane if it has EITHER
    // a label or a role; send '' for the absent field. Non-empty gate matches
    // the live relay so a cleared value never resurrects from the snapshot.
    return metadataStore.snapshot().entries
      .map((e) => ({
        paneId: e.paneId,
        label: typeof e.metadata.label === 'string' ? e.metadata.label : '',
        role: readOrchRole(e.metadata.custom) ?? '',
      }))
      .filter((e) => e.label.length > 0 || e.role.length > 0);
  }));

  // P2 GUI pane rename: the renderer is the only non-MCP writer of pane labels.
  // Route through MetadataStore (the sole authority) so the rename persists
  // (metadata.json) and relays to every renderer via pane.metadata.changed.
  ipcMain.removeHandler(IPC.METADATA_SET);
  ipcMain.handle(IPC.METADATA_SET, wrapHandler(IPC.METADATA_SET, async (
    _event: Electron.IpcMainInvokeEvent,
    paneId: string,
    workspaceId: string,
    label: string,
  ) => {
    metadataStore.set(paneId, { label }, { workspaceId });
    return { ok: true };
  }));

  // Fleet dropdown → set a pane's operator-assigned orchestrator role. Writes
  // custom['orchestrator.role'] through the SAME MetadataStore authority as the
  // MCP pane_set_metadata tool (custom deep-merge, so a role write never clobbers
  // the pane's label or other tools' custom keys), so it persists (metadata.json)
  // and relays to every renderer + the orchestrator via pane.metadata.changed.
  // An empty string is the "unassigned" sentinel (additive merge has no
  // delete-one-key op); readOrchRole normalizes '' → undefined on read.
  ipcMain.removeHandler(IPC.METADATA_SET_ROLE);
  ipcMain.handle(IPC.METADATA_SET_ROLE, wrapHandler(IPC.METADATA_SET_ROLE, async (
    _event: Electron.IpcMainInvokeEvent,
    paneId: string,
    workspaceId: string,
    role: string,
  ) => {
    metadataStore.set(paneId, { custom: { [ORCH_ROLE_KEY]: role } }, { workspaceId, mergeMode: 'merge' });
    return { ok: true };
  }));

  // Periodic metadata polling (every 5 seconds)
  const pollingInterval = setInterval(async () => {
    const win = getWindow();
    if (!win || !shouldPollMetadata(win)) return;

    for (const [ptyId] of cwdMap) {
      const instance = ptyManager.get(ptyId);
      if (localPtyOwnership && !instance) {
        cwdMap.delete(ptyId);
        branchMap.delete(ptyId);
        worktreeMap.delete(ptyId);
        portsMap.delete(ptyId);
        continue;
      }

      // On Linux/macOS, try reading /proc/PID/cwd for live CWD detection
      if (instance && process.platform !== 'win32') {
        try {
          const liveCwd = await fs.promises.readlink(`/proc/${instance.process.pid}/cwd`);
          if (liveCwd && liveCwd !== cwdMap.get(ptyId)) {
            updateCwd(ptyId, liveCwd);
          }
        } catch { /* not available on macOS without /proc */ }
      }

      const payload = await buildMetadataPayload(ptyId);
      if (payload) broadcastMetadataUpdate(win, payload);
    }
  }, 5000);

  // cleanup 함수 반환 — 앱 종료 시 호출
  return () => {
    clearInterval(pollingInterval);
    ipcMain.removeHandler(IPC.METADATA_REQUEST);
    ipcMain.removeHandler(IPC.METADATA_SNAPSHOT);
    ipcMain.removeHandler(IPC.METADATA_SET);
    ipcMain.removeHandler(IPC.METADATA_SET_ROLE);
  };
}

export function updateCwd(ptyId: string, cwd: string): void {
  cwdMap.set(ptyId, cwd);
  for (const listener of cwdListeners) {
    try { listener(ptyId, cwd); } catch { /* listener errors must not break PTY flow */ }
  }
}

export function removeCwd(ptyId: string): void {
  cwdMap.delete(ptyId);
}

export function updateBranch(ptyId: string, branch: string): void {
  branchMap.set(ptyId, branch);
}

export function removeBranch(ptyId: string): void {
  branchMap.delete(ptyId);
}

export function getCwd(ptyId: string): string | undefined {
  return cwdMap.get(ptyId);
}

export function getBranch(ptyId: string): string | undefined {
  return branchMap.get(ptyId);
}

// ── X1 watcher-fed caches ──

export function updateWorktree(ptyId: string, isWorktree: boolean): void {
  worktreeMap.set(ptyId, isWorktree);
}

export function removeWorktree(ptyId: string): void {
  worktreeMap.delete(ptyId);
}

export function updatePorts(ptyId: string, ports: number[]): void {
  portsMap.set(ptyId, ports);
}

export function removePorts(ptyId: string): void {
  portsMap.delete(ptyId);
}

export function getPorts(ptyId: string): number[] | undefined {
  return portsMap.get(ptyId);
}
