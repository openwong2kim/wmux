// ─── Bot folders — the owner's (main-window IPC only) ──────────────────────
//
// The `bot-folders` factory module: it loads the owner's bot folders
// (main/factory/botFolderStore.ts) and answers BOT_FOLDER_IPC from the main
// window's top frame only. Bots have no call here.
//
// As with group.rpc, the IPC handlers are registered with the module (at
// boot, before any window): the Bots page lists folders as it mounts, which
// can be before the factory has started. Until the store is loaded a list
// waits for it (bounded), and a change answers `not_started` at once.

import path from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_EVENT } from '../../../shared/bot';
import {
  BOT_FOLDER_ID_RE,
  BOT_FOLDER_IPC,
  type BotFolderListResult,
  type BotFolderOkResult,
  type BotFolderResult,
} from '../../../shared/botFolder';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle } from '../../factory/factoryHost';
import { BotFolderStore, botFoldersFilePath, getBotFolderStore, setBotFolderStore } from '../../factory/botFolderStore';
import { getBotStore } from '../../factory/botStore';
import { isMainWindowSender } from '../../ipc/mainWindowSender';

export interface FolderIpcDeps {
  store: () => BotFolderStore | null;
  /** Resolves once the store is loaded, or after `timeoutMs` (absent: a list
   *  before the store answers `not_started` at once). */
  ready?: (timeoutMs: number) => Promise<void>;
}

/** How long a list made before the factory started waits for the store. */
export const FOLDER_STORE_WAIT_MS = 15_000;

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const NOT_STARTED = { ok: false as const, code: 'not_started' as const, message: 'Bot folders are not running yet.' };
const NO_FOLDER = { ok: false as const, code: 'invalid' as const, field: 'folder' as const, message: 'No folder is named.' };

export function listFolders(_raw: unknown, deps: FolderIpcDeps): BotFolderListResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  return { ok: true, folders: store.list() };
}

export function createFolder(raw: unknown, deps: FolderIpcDeps): BotFolderResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.name !== 'string') return { ok: false, code: 'invalid', field: 'name', message: 'Give the folder a name.' };
  return store.create(p.name);
}

export function renameFolder(raw: unknown, deps: FolderIpcDeps): BotFolderResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.id !== 'string' || !BOT_FOLDER_ID_RE.test(p.id)) return NO_FOLDER;
  if (typeof p.name !== 'string') return { ok: false, code: 'invalid', field: 'name', message: 'Give the folder a name.' };
  return store.rename(p.id, p.name);
}

export function setFolderCollapsed(raw: unknown, deps: FolderIpcDeps): BotFolderResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.id !== 'string' || !BOT_FOLDER_ID_RE.test(p.id)) return NO_FOLDER;
  if (typeof p.collapsed !== 'boolean') return { ok: false, code: 'invalid', message: 'Say whether the folder is collapsed.' };
  return store.setCollapsed(p.id, p.collapsed);
}

export function assignBotToFolder(raw: unknown, deps: FolderIpcDeps): BotFolderOkResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.botId !== 'string') return { ok: false, code: 'invalid', field: 'bot', message: 'Pick a bot.' };
  if (p.folderId !== null && (typeof p.folderId !== 'string' || !BOT_FOLDER_ID_RE.test(p.folderId))) return NO_FOLDER;
  return store.assign(p.botId, p.folderId as string | null);
}

export function assignBotsToFolder(raw: unknown, deps: FolderIpcDeps): BotFolderOkResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (!Array.isArray(p.botIds)) return { ok: false, code: 'invalid', field: 'bot', message: 'Pick the bots to move.' };
  if (p.folderId !== null && (typeof p.folderId !== 'string' || !BOT_FOLDER_ID_RE.test(p.folderId))) return NO_FOLDER;
  return store.assignMany(p.botIds, p.folderId as string | null);
}

export function removeFolder(raw: unknown, deps: FolderIpcDeps): BotFolderOkResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.id !== 'string' || !BOT_FOLDER_ID_RE.test(p.id)) return NO_FOLDER;
  const removed = store.remove(p.id);
  return removed.ok ? { ok: true } : removed;
}

/** listFolders, after waiting (bounded) for a store that is not loaded yet. */
export async function listFoldersWhenReady(raw: unknown, deps: FolderIpcDeps, timeoutMs: number = FOLDER_STORE_WAIT_MS): Promise<BotFolderListResult> {
  if (!deps.store() && deps.ready) await deps.ready(timeoutMs);
  return listFolders(raw, deps);
}

/** The main-window IPC handlers. Each answers only the main window's top
 *  frame and never throws. */
export function registerFolderIpc(getWindow: () => BrowserWindow | null, deps: FolderIpcDeps, opts: { waitMs?: number } = {}): () => void {
  const channels = Object.values(BOT_FOLDER_IPC);
  for (const c of channels) ipcMain.removeHandler(c);
  const denied = { ok: false, code: 'not_authorized', message: 'only the wmux window may do this' } as const;
  const guard = <R>(fn: (req: unknown) => R | Promise<R>) =>
    async (e: Electron.IpcMainInvokeEvent, req: unknown): Promise<R | typeof denied | { ok: false; code: 'error'; message: string }> => {
      if (!isMainWindowSender(e, getWindow())) return denied;
      try {
        return await fn(req);
      } catch {
        return { ok: false, code: 'error', message: 'The request failed.' };
      }
    };
  ipcMain.handle(BOT_FOLDER_IPC.list, guard((req) => listFoldersWhenReady(req, deps, opts.waitMs)));
  ipcMain.handle(BOT_FOLDER_IPC.create, guard((req) => createFolder(req, deps)));
  ipcMain.handle(BOT_FOLDER_IPC.rename, guard((req) => renameFolder(req, deps)));
  ipcMain.handle(BOT_FOLDER_IPC.setCollapsed, guard((req) => setFolderCollapsed(req, deps)));
  ipcMain.handle(BOT_FOLDER_IPC.assign, guard((req) => assignBotToFolder(req, deps)));
  ipcMain.handle(BOT_FOLDER_IPC.assignMany, guard((req) => assignBotsToFolder(req, deps)));
  ipcMain.handle(BOT_FOLDER_IPC.remove, guard((req) => removeFolder(req, deps)));
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

function botIds(): string[] | null {
  const bots = getBotStore();
  return bots ? bots.list().map((b) => b.id) : null;
}

export function createFolderModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>, opts: { waitMs?: number } = {}): FactoryModuleHandle {
  /** Lists waiting for the store. */
  let waiters: Array<() => void> = [];
  const release = (): void => {
    const all = waiters;
    waiters = [];
    for (const done of all) done();
  };
  const ready = (timeoutMs: number): Promise<void> => new Promise((resolve) => {
    if (getBotFolderStore()) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      waiters = waiters.filter((w) => w !== done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    waiters.push(done);
  });
  // Registered now, before the factory starts (see the header).
  let offIpc: (() => void) | null = registerFolderIpc(deps.getMainWindow, { store: getBotFolderStore, ready }, opts);
  const notify = (): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, { type: 'folders-changed' });
  };
  return {
    start() {
      if (getBotFolderStore()) return;
      const file = botFoldersFilePath(deps.wmuxDir());
      const store = new BotFolderStore(file, { bots: botIds, onChange: notify });
      store.load();
      setBotFolderStore(store);
      release();
      // A list that gave up waiting reads again.
      notify();
      console.log(`[factory] bot folders: ${store.list().length} loaded from ${path.basename(file)}`);
    },
    dispose() {
      offIpc?.();
      offIpc = null;
      setBotFolderStore(null);
      release();
    },
  };
}

registerFactoryRpcModule('bot-folders', (_router, deps) => createFolderModule(deps));
