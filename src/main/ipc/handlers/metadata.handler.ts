import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import { IPC } from '../../../shared/constants';
import type { MetadataUpdatePayload } from '../../../shared/types';
import { MetadataCollector } from '../../metadata/MetadataCollector';
import { prStatusCache } from '../../metadata/PrStatusCache';
import { gitSyncStatusCache } from '../../metadata/GitSyncStatusCache';
import { PTYManager } from '../../pty/PTYManager';
import { wrapHandler } from '../wrapHandler';
import { metadataStore } from '../../metadata/MetadataStore';
import { ORCH_ROLE_KEY, readOrchRole } from '../../../shared/orchestratorRole';
import { eventBus } from '../../events/EventBus';
import { findWorkspaceIdForPty } from '../../pipe/handlers/hooks.rpc';
import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { PrCiRouter } from '../../metadata/PrCiRouter';
import { PrReviewRouter } from '../../metadata/PrReviewRouter';
import { ghPrService } from '../../github/GhPrService';
import { classifySessionLocation, type SessionLocation } from '../../../shared/sessionLocation';
import { resolveWslDistro } from '../../pty/wslDistro';
import type { PaneCommandTarget } from '../../git/paneCommand';
import { resolveGitToplevel } from '../../git/git';

// AO-style CI feedback (owner decision 2026-07-18). Module singletons set at
// registration (they need getWindow for workspace resolution). The poll feeds
// them each pane's PR status; PrCiRouter fires a one-shot `pr.ci` bus event on
// the red transition, PrReviewRouter a `pr.review` per batch of new comments.
// Null until registered, so the exported poll tick stays usable in unit tests
// that don't wire them.
let prCiRouter: PrCiRouter | null = null;
let prReviewRouter: PrReviewRouter | null = null;

// Minimal shape findWorkspaceIdForPty reads from the renderer's workspace.list.
interface WorkspaceListEntry {
  id: string;
  name: string;
  activePtyId?: string | null;
  ptyIds?: string[];
}

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

// Track CWD per ptyId (updated via OSC 7, prompt detection, or initial
// registration). SOLE owner of "where is this pane right now" — see
// getPaneCommandTarget.
const cwdMap = new Map<string, string>();

/**
 * The part of a pane's identity that its cwd cannot change: which interpreter
 * the pane runs (`shell`) and, for WSL, which distribution it runs in.
 *
 * Issue #21 I2: the pane's `SessionLocation` is DERIVED from this plus the live
 * `cwdMap` entry rather than stored alongside it. Holding a second copy of the
 * cwd here is what made a pane keep reporting the original repo's branch / PR /
 * dirty counts forever after a `cd` — the live feed (OSC 7, prompt scrape,
 * daemon `session:cwd`) writes `cwdMap`, while the location copy was refreshed
 * at only four registration sites. One piece of state, one writer.
 */
interface PaneIdentity {
  shell: string;
  distro?: string;
}
const paneIdentities = new Map<string, PaneIdentity>();

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
  const target = getPaneCommandTarget(ptyId);
  // Watcher/shell-integration branch wins; exec git only as fallback so a
  // session that predates the watcher (or a watch failure) still resolves.
  const gitBranch = branchMap.get(ptyId) ?? (target ? await collector.getGitBranch(target) : undefined) ?? '';
  const payload: MetadataUpdatePayload = { ptyId, cwd, gitBranch };
  const isWorktree = worktreeMap.get(ptyId);
  if (isWorktree !== undefined) payload.gitIsWorktree = isWorktree;
  const ports = portsMap.get(ptyId);
  if (ports !== undefined) payload.listeningPorts = ports;
  if (gitBranch) {
    payload.pr = target ? await prStatusCache.get(target, gitBranch) : null;
    // Rides the same 5 s tick behind a 15 s TTL — one git subprocess per
    // repo per TTL window (same cost discipline as the gh cache above).
    payload.gitSync = target ? await gitSyncStatusCache.get(target) : null;
  } else {
    payload.pr = null;
    payload.gitSync = null;
  }
  return payload;
}

// app-weight P1-2 — last-payload diff for the 5 s poll. Key = ptyId, value =
// JSON of the last payload actually SENT (buildMetadataPayload constructs
// fields in a fixed order and they are primitives/arrays/plain objects, so
// plain JSON.stringify equality is stable). Skipping identical payloads stops
// the renderer's per-pane immer store commit at idle (`shallowCopy` in
// profiles). Scoped to the poll ONLY: METADATA_REQUEST and the event-driven
// broadcastMetadataUpdate call sites elsewhere are never suppressed. The map
// is rebuilt from live panes each tick, so entries for closed panes are
// pruned automatically (leak-free without a separate cleanup hook).
// Known, accepted duplicate: an event-driven broadcast (OSC cwd etc.) does
// not update this cache, so the next poll tick re-sends once — self-healing
// and still strictly better than the old every-tick broadcast.
let lastPolledPayloads = new Map<string, string>();

/** Reset the poll dedup cache. Called on (re)registration: a recreated
 *  window's renderer starts with empty state, and a stale cache would
 *  suppress the first poll payload it actually needs (GLM review, PR #471).
 *  Cost: one duplicate burst per re-registration. */
export function resetMetadataPollCache(): void {
  lastPolledPayloads = new Map();
}

/**
 * One tick of the metadata poll. Exported for unit tests; production calls it
 * from the 5 s interval in registerMetadataHandlers.
 */
export async function runMetadataPollTick(
  ptyManager: PTYManager,
  win: BrowserWindow,
  localPtyOwnership: boolean,
): Promise<void> {
  const nextPayloads = new Map<string, string>();
  for (const [ptyId] of cwdMap) {
    const instance = ptyManager.get(ptyId);
    if (localPtyOwnership && !instance) {
      cwdMap.delete(ptyId);
      paneIdentities.delete(ptyId);
      branchMap.delete(ptyId);
      worktreeMap.delete(ptyId);
      portsMap.delete(ptyId);
      prCiRouter?.forget(ptyId);
      prReviewRouter?.forget(ptyId);
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
    if (!payload) continue;
    // AO-style CI + review feedback: fire-and-forget — both routers are
    // edge/watermark-triggered and never throw, so they must not gate the
    // metadata broadcast below.
    void prCiRouter?.note(ptyId, payload.pr ?? null);
    if (payload.cwd) {
      void prReviewRouter?.note(
        ptyId,
        payload.cwd,
        payload.pr ?? null,
        getPaneCommandTarget(ptyId),
      );
    }
    const serialized = JSON.stringify(payload);
    // First payload for a pane always sends (no cache entry); a value that
    // reverts after a change also sends (cache holds the last SENT payload).
    if (serialized !== lastPolledPayloads.get(ptyId)) {
      broadcastMetadataUpdate(win, payload);
    }
    nextPayloads.set(ptyId, serialized);
  }
  lastPolledPayloads = nextPayloads;
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

  // AO-style CI feedback router. Resolver: cache-free workspace.list round-trip
  // (a red transition is rare, so one lookup per fire is negligible); an
  // unresolved pty drops the event (workspace isolation). Sink: eventBus, whose
  // deck subscription routes pr.ci → the event-push coalescer.
  const resolvePtyWorkspace = async (ptyId: string): Promise<string | null> => {
    try {
      const result = await sendToRenderer(getWindow, 'workspace.list');
      if (!Array.isArray(result)) return null;
      return findWorkspaceIdForPty(ptyId, result as WorkspaceListEntry[]);
    } catch {
      return null;
    }
  };
  prCiRouter = new PrCiRouter(resolvePtyWorkspace, (e) => {
    eventBus.emit({
      type: 'pr.ci',
      workspaceId: e.workspaceId,
      ptyId: e.ptyId,
      prNumber: e.prNumber,
      url: e.url,
      checks: 'failing',
    });
  });
  // Slice 2: new review comments on a pane's PR → `pr.review`. Rides the
  // GhPrService caches (30 s list TTL + updatedAt-keyed detail), throttled
  // per pane inside the router.
  prReviewRouter = new PrReviewRouter(
    ghPrService,
    (cwd, target) => resolveGitToplevel(target ?? cwd),
    resolvePtyWorkspace,
    (e) => {
      eventBus.emit({
        type: 'pr.review',
        workspaceId: e.workspaceId,
        ptyId: e.ptyId,
        prNumber: e.prNumber,
        url: e.url,
        count: e.count,
        author: e.author,
        snippet: e.snippet,
      });
    },
    Date.now,
    // Slice 3: merge-conflict edge, riding the same throttled read.
    (e) => {
      eventBus.emit({
        type: 'pr.conflict',
        workspaceId: e.workspaceId,
        ptyId: e.ptyId,
        prNumber: e.prNumber,
        url: e.url,
      });
    },
  );

  // Handle metadata request from renderer
  ipcMain.removeHandler(IPC.METADATA_REQUEST);
  ipcMain.handle(IPC.METADATA_REQUEST, wrapHandler(IPC.METADATA_REQUEST, async (_event: Electron.IpcMainInvokeEvent, ptyId: string) => {
    const payload = await buildMetadataPayload(ptyId);
    if (!payload) return {};
    // Also broadcast (codex review, PR #471): the poll dedup never re-sends
    // an unchanged payload, but the renderer applies exclusive context
    // (cwd/git/PR) only from the surface that is ACTIVE at receipt time —
    // so a pane switch pulls via this request and the broadcast feeds the
    // renderer's normal METADATA_UPDATE apply path. Requests are explicitly
    // exempt from the dedup cache.
    const win = getWindow();
    if (win && !win.isDestroyed()) broadcastMetadataUpdate(win, payload);
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

  // Fresh dedup cache per registration — see resetMetadataPollCache.
  resetMetadataPollCache();

  // Periodic metadata polling (every 5 seconds). Re-entrancy guard
  // (CodeRabbit, PR #471): buildMetadataPayload awaits git/PR work that can
  // outlast the interval under load, and an older tick's final cache swap
  // would overwrite a newer tick's snapshot — a stale cache entry could then
  // suppress a legitimate change. Overlapping ticks are skipped (the next
  // 5 s tick covers), same discipline as snapshotRunner's `running` flag.
  let pollRunning = false;
  const pollingInterval = setInterval(async () => {
    if (pollRunning) return;
    const win = getWindow();
    if (!win || !shouldPollMetadata(win)) return;
    pollRunning = true;
    try {
      await runMetadataPollTick(ptyManager, win, localPtyOwnership);
    } finally {
      pollRunning = false;
    }
  }, 5000);

  // Return cleanup function — invoked on app shutdown
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
  prCiRouter?.forget(ptyId);
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

/**
 * Register a live pane's location. Only the cwd-independent part is kept (see
 * PaneIdentity) — `location.cwd` is deliberately ignored, because `updateCwd`
 * is the pane's cwd. Callers seed both; the create/reconnect paths call this
 * first so the cwd feed's listeners see a complete pane.
 *
 * Issue #21 I1: a WSL pane created as bare `wsl.exe` has no distro anywhere in
 * its location (nothing can be recovered from a `/home/...` cwd), and without
 * one every consumer fails with `WSL_DISTRO_REQUIRED` for the pane's whole
 * first session. Resolution is enumeration-only and never boots a distribution
 * (see wslDistro.ts), so it is safe to arm here for every WSL pane; it lands
 * asynchronously and the pane fails closed until it does.
 */
export function updatePaneLocation(ptyId: string, location: SessionLocation): void {
  const distro = location.domain === 'wsl' ? location.distro : undefined;
  paneIdentities.set(ptyId, { shell: location.shell, ...(distro ? { distro } : {}) });
  if (location.domain !== 'wsl' || distro) return;
  void resolveWslDistro({ shell: location.shell })
    .then((resolved) => {
      if (!resolved) return;
      const current = paneIdentities.get(ptyId);
      // The pane may have been closed, or re-registered with a real distro,
      // while the enumeration was in flight.
      if (!current || current.shell !== location.shell || current.distro) return;
      paneIdentities.set(ptyId, { ...current, distro: resolved });
    })
    .catch(() => { /* unresolved distro is a fail-closed state, not an error */ });
}

export function removePaneLocation(ptyId: string): void {
  paneIdentities.delete(ptyId);
}

/**
 * The pane's command target, composed from its identity and its LIVE cwd.
 *
 * The active-session context is derived rather than stored: an entry in
 * `paneIdentities` exists exactly while the pane is live, and a live WSL pane
 * has by definition already established its WSL context — which is the whole
 * point of `preparePaneCommand`'s ACTIVE_CONTEXT_REQUIRED gate (never start a
 * distro just to answer a background poll). Storing it separately is what left
 * the first session of every WSL pane permanently ungated (issue #21 I1).
 */
export function getPaneCommandTarget(ptyId: string): PaneCommandTarget | undefined {
  const identity = paneIdentities.get(ptyId);
  const cwd = cwdMap.get(ptyId);
  if (!identity || !cwd) return undefined;
  const location = classifySessionLocation(identity.shell, cwd, identity.distro);
  if (location.domain !== 'wsl') return { sessionId: ptyId, location };
  return {
    sessionId: ptyId,
    location,
    activeContext: {
      sessionId: ptyId,
      active: true,
      ...(location.distro ? { distro: location.distro } : {}),
    },
  };
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
