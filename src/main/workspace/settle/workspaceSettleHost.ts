// Main-process host for WorkspaceSettleService: the persisted file, the IPC
// surface, the event subscriptions and the clock. Everything here runs in main
// with no renderer dependency, so settle and snooze keep moving while the
// window is closed (the mirror then holds the last tree the renderer pushed).
//
// HQ exemption: the HQ id comes from deck-hq.json (deckHqStore), read at most
// every HQ_CACHE_MS — the rules ask once per workspace on every mirror push.

import path from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import type { WorkspaceSettleCommand } from '../../../shared/workspaceSettle';
import { getWmuxDir } from '../../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../../daemon/util/atomicWrite';
import { eventBus } from '../../events/EventBus';
import { prStatusCache } from '../../metadata/PrStatusCache';
import { gitSyncStatusCache } from '../../metadata/GitSyncStatusCache';
import { getHqWorkspaceId } from '../../deck/deckHqStore';
import { getWorkspaceMirror } from '../WorkspaceMirror';
import { notePrCiObservation } from '../../ipc/handlers/metadata.handler';
import type { DaemonClient } from '../../DaemonClient';
import type { PTYManager } from '../../pty/PTYManager';
import { WorkspaceSettleService, type PersistedWorkspaceSettle } from './WorkspaceSettleService';

/** Expiry, idle and PR rules are evaluated once a minute. */
export const WORKSPACE_SETTLE_TICK_MS = 60_000;
const SAVE_DEBOUNCE_MS = 1_000;
const HQ_CACHE_MS = 5_000;
/** PR observation interval while the window is hidden. */
const PR_OBSERVE_HIDDEN_MS = 5 * 60 * 1000;

// One service per process: handler re-registration rebinds the IPC and the
// subscriptions but keeps the rows and the last mirror it saw.
let service: WorkspaceSettleService | null = null;
let saver: { save: (data: PersistedWorkspaceSettle) => void; flush: () => void } | null = null;

/** The service, or null before the first registration (tests, early boot). */
export function getWorkspaceSettleService(): WorkspaceSettleService | null {
  return service;
}

export function getWorkspaceSettlePath(dir?: string): string {
  return path.join(dir ?? getWmuxDir(), 'workspace-settle.json');
}

/** Debounced atomic save; `flush` writes a pending save now. */
function createSaver(filePath: string): { save: (data: PersistedWorkspaceSettle) => void; flush: () => void } {
  let pending: PersistedWorkspaceSettle | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    const data = pending;
    pending = null;
    if (data) atomicWriteJSON(filePath, data).catch((err) => console.error('[workspaceSettle] save failed:', err));
  };
  return {
    save: (data) => {
      pending = data;
      if (!timer) {
        timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
        timer.unref?.();
      }
    },
    flush,
  };
}

function createHqResolver(): () => string | null {
  let readAt = -Infinity;
  let hq: string | null = null;
  return () => {
    const now = Date.now();
    if (now - readAt > HQ_CACHE_MS) {
      readAt = now;
      try { hq = getHqWorkspaceId(); } catch { hq = null; }
    }
    return hq;
  };
}

function loadPersisted(filePath: string): unknown {
  try {
    return atomicReadJSONSync<unknown>(filePath);
  } catch (err) {
    console.error('[workspaceSettle] load failed, starting empty:', err);
    return null;
  }
}

/**
 * Read the PR and git state of every workspace a PR transition can matter for,
 * in parallel, through the shared caches. `feedCi` while the window is hidden:
 * the metadata poll (the CI router's usual feeder) is stopped then.
 */
async function observePrs(svc: WorkspaceSettleService, feedCi: boolean): Promise<void> {
  const entries = getWorkspaceMirror().getEntries() ?? [];
  const present = new Set(svc.presentIds());
  await Promise.all(entries.map(async (e) => {
    const cwd = e.metadata?.cwd;
    const branch = e.metadata?.gitBranch;
    if (!present.has(e.id) || !cwd || !branch || !svc.wantsPrObservation(e.id)) return;
    const [{ pr, failed }, sync] = await Promise.all([prStatusCache.observe(cwd, branch), gitSyncStatusCache.get(cwd)]);
    svc.notePr(e.id, failed ? undefined : pr, sync?.hasUpstream ? sync.ahead : undefined);
    if (feedCi && !failed && e.activePtyId) notePrCiObservation(e.activePtyId, pr);
  }));
}

export interface WorkspaceSettleInputs {
  /** Daemon mode: the daemon reports typed input from every input path. */
  daemonClient?: DaemonClient;
  /** Local mode: every write goes through the PTY manager. */
  ptyManager?: PTYManager;
}

export function registerWorkspaceSettle(getWindow: () => BrowserWindow | null, inputs: WorkspaceSettleInputs = {}): () => void {
  if (!service || !saver) {
    const filePath = getWorkspaceSettlePath();
    const s = createSaver(filePath);
    saver = s;
    service = new WorkspaceSettleService({ load: () => loadPersisted(filePath), save: s.save, hqId: createHqResolver() });
  }
  const svc = service;
  const flushSave = saver.flush;

  const unsubscribeChange = svc.onChange((payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.WORKSPACE_SETTLE_CHANGED, payload);
  });
  const unsubscribeBus = eventBus.subscribe((event) => {
    if (event.type === 'agent.lifecycle') svc.noteLifecycle(event.workspaceId, event.kind);
    else if (event.type === 'pr.ci') svc.noteAttention(event.workspaceId);
  });
  // Input from any path: desktop keys, phone/web, MCP input.send, A2A.
  const onTyped = (payload: { sessionId: string }): void => svc.noteInput(payload.sessionId);
  const { daemonClient, ptyManager } = inputs;
  if (daemonClient) daemonClient.on('session:input', onTyped);
  else ptyManager?.setInputObserver((id, data) => svc.noteInput(id, data));

  ipcMain.removeHandler(IPC.WORKSPACE_SETTLE_GET);
  ipcMain.handle(IPC.WORKSPACE_SETTLE_GET, () => svc.snapshot());
  ipcMain.removeHandler(IPC.WORKSPACE_SETTLE_COMMAND);
  ipcMain.handle(IPC.WORKSPACE_SETTLE_COMMAND, (_event, cmd: unknown) => {
    if (typeof cmd !== 'object' || cmd === null || typeof (cmd as { op?: unknown }).op !== 'string') {
      return { ok: false, error: 'invalid' };
    }
    return svc.command(cmd as WorkspaceSettleCommand);
  });

  let ticking = false;
  let observedAt = -Infinity;
  const timer = setInterval(() => {
    if (ticking) return;
    const win = getWindow();
    const hidden = !win || win.isDestroyed() || !win.isVisible();
    // Nobody is looking: PR state can wait longer (the gh cache TTL is 5 min anyway).
    if (Date.now() - observedAt < (hidden ? PR_OBSERVE_HIDDEN_MS : 0)) {
      svc.tick();
      return;
    }
    ticking = true;
    observedAt = Date.now();
    observePrs(svc, hidden)
      .catch((err) => console.error('[workspaceSettle] PR observation failed:', err))
      .finally(() => {
        ticking = false;
        svc.tick();
      });
  }, WORKSPACE_SETTLE_TICK_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    unsubscribeChange();
    unsubscribeBus();
    if (daemonClient) daemonClient.off('session:input', onTyped);
    else ptyManager?.setInputObserver(null);
    ipcMain.removeHandler(IPC.WORKSPACE_SETTLE_GET);
    ipcMain.removeHandler(IPC.WORKSPACE_SETTLE_COMMAND);
    flushSave();
  };
}
