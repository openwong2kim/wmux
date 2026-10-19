// ─── Bot group chats — the owner's (main-window IPC only) ──────────────────
//
// The `groups` factory module: it loads the owner's group chats
// (main/factory/groupStore.ts), moves workspace rooms into groups once, and
// answers BOT_GROUP_IPC from the main window's top frame only. Bots have no
// call here: they cannot make, change or list groups.
//
// The one-time move (owner decision 2026-10-15: no workspace has a room by
// itself any more): a workspace with two or more bots whose room holds a
// message of the owner's outside the 1:1 threads becomes a group named after
// the workspace, with that workspace's bots, living on in the room's
// `general` and its threads (nothing is moved or deleted). A room the owner
// never wrote in is simply no longer listed. Room files are never touched.
//
// The IPC handlers are registered with the module (at boot, before any
// window), not when it starts: the Bots page lists groups as it mounts, which
// can be before the factory has started. Until the store is loaded a list
// waits for it (bounded), and a change answers `not_started` at once.

import path from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_EVENT } from '../../../shared/bot';
import {
  BOT_GROUP_IPC,
  GROUP_ID_RE,
  type BotGroupListResult,
  type BotGroupRemoveResult,
  type BotGroupResult,
} from '../../../shared/botGroup';
import { dmThreadBot } from '../../../shared/room';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle } from '../../factory/factoryHost';
import { GroupStore, getGroupStore, groupsFilePath, setGroupStore, type GroupBotRef } from '../../factory/groupStore';
import { getBotStore } from '../../factory/botStore';
import { getRoomWriter, type RoomWriter } from '../../factory/roomWriter';
import { isMainWindowSender } from '../../ipc/mainWindowSender';

export interface GroupIpcDeps {
  store: () => GroupStore | null;
  /** Resolves once the store is loaded, or after `timeoutMs` (absent: a list
   *  before the store answers `not_started` at once). */
  ready?: (timeoutMs: number) => Promise<void>;
}

/** How long a list made before the factory started waits for the store. */
export const GROUP_STORE_WAIT_MS = 15_000;

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const NOT_STARTED = { ok: false as const, code: 'not_started' as const, message: 'Group chats are not running yet.' };

function memberList(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.every((m) => typeof m === 'string') ? (raw as string[]) : null;
}

export function listGroups(raw: unknown, deps: GroupIpcDeps): BotGroupListResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  return { ok: true, groups: store.list(typeof p.workspaceId === 'string' ? p.workspaceId : undefined) };
}

export function createGroup(raw: unknown, deps: GroupIpcDeps): BotGroupResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  const memberIds = memberList(p.memberIds);
  if (typeof p.workspaceId !== 'string') return { ok: false, code: 'invalid', field: 'workspace', message: 'Pick a workspace.' };
  if (typeof p.name !== 'string') return { ok: false, code: 'invalid', field: 'name', message: 'Give the group a name.' };
  if (!memberIds) return { ok: false, code: 'invalid', field: 'members', message: 'Pick the bots.' };
  return store.create({ workspaceId: p.workspaceId, name: p.name, memberIds });
}

export function updateGroup(raw: unknown, deps: GroupIpcDeps): BotGroupResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.id !== 'string' || !GROUP_ID_RE.test(p.id)) return { ok: false, code: 'invalid', message: 'No group chat is named.' };
  if (p.name !== undefined && typeof p.name !== 'string') return { ok: false, code: 'invalid', field: 'name', message: 'Give the group a name.' };
  const memberIds = p.memberIds === undefined ? undefined : memberList(p.memberIds);
  if (memberIds === null) return { ok: false, code: 'invalid', field: 'members', message: 'Pick the bots.' };
  return store.update(p.id, {
    ...(typeof p.name === 'string' ? { name: p.name } : {}),
    ...(memberIds ? { memberIds } : {}),
  });
}

export function removeGroup(raw: unknown, deps: GroupIpcDeps): BotGroupRemoveResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.id !== 'string' || !GROUP_ID_RE.test(p.id)) return { ok: false, code: 'invalid', message: 'No group chat is named.' };
  const removed = store.remove(p.id);
  if (!removed) return { ok: false, code: 'not_found', message: store.writeRefusal() ?? 'That group chat no longer exists.' };
  return { ok: true };
}

/** listGroups, after waiting (bounded) for a store that is not loaded yet. */
export async function listGroupsWhenReady(raw: unknown, deps: GroupIpcDeps, timeoutMs: number = GROUP_STORE_WAIT_MS): Promise<BotGroupListResult> {
  if (!deps.store() && deps.ready) await deps.ready(timeoutMs);
  return listGroups(raw, deps);
}

/** The main-window IPC handlers. Each answers only the main window's top
 *  frame and never throws. */
export function registerGroupIpc(getWindow: () => BrowserWindow | null, deps: GroupIpcDeps, opts: { waitMs?: number } = {}): () => void {
  const channels = Object.values(BOT_GROUP_IPC);
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
  ipcMain.handle(BOT_GROUP_IPC.list, guard((req) => listGroupsWhenReady(req, deps, opts.waitMs)));
  ipcMain.handle(BOT_GROUP_IPC.create, guard((req) => createGroup(req, deps)));
  ipcMain.handle(BOT_GROUP_IPC.update, guard((req) => updateGroup(req, deps)));
  ipcMain.handle(BOT_GROUP_IPC.remove, guard((req) => removeGroup(req, deps)));
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

/** Did the owner write in this room: a message of theirs outside the 1:1
 *  threads? */
export function ownerWroteInRoom(writer: Pick<RoomWriter, 'find'>, workspaceId: string): boolean {
  return writer.find(workspaceId, (c) => c.kind === 'human' && c.actor.kind === 'human' && dmThreadBot(c.threadId) === null) !== null;
}

/** The one-time move of workspace rooms into groups (see the header).
 *  Returns the workspaces made into groups. A no-op once done, and while the
 *  bots or the rooms cannot be read. */
export function migrateRoomsToGroups(store: GroupStore, bots: readonly GroupBotRef[] | null, writer: Pick<RoomWriter, 'find'> | null): string[] {
  if (store.isMigrated() || !bots || !writer || store.writeRefusal()) return [];
  const byWs = new Map<string, GroupBotRef[]>();
  for (const b of [...bots].sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id))) {
    byWs.set(b.workspaceId, [...(byWs.get(b.workspaceId) ?? []), b]);
  }
  const made: string[] = [];
  for (const [workspaceId, team] of byWs) {
    if (team.length < 2 || store.hadRoomGroup(workspaceId)) continue;
    let wrote = false;
    try {
      wrote = ownerWroteInRoom(writer, workspaceId);
    } catch {
      wrote = false;
    }
    if (wrote && store.adoptRoom(workspaceId, team.map((b) => b.id))) made.push(workspaceId);
  }
  store.markMigrated();
  return made;
}

function botRefs(): GroupBotRef[] | null {
  const bots = getBotStore();
  return bots ? bots.list().map((b) => ({ id: b.id, workspaceId: b.workspaceId, createdAt: b.createdAt })) : null;
}

export function createGroupModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>, opts: { waitMs?: number } = {}): FactoryModuleHandle {
  /** Lists waiting for the store. */
  let waiters: Array<() => void> = [];
  const release = (): void => {
    const all = waiters;
    waiters = [];
    for (const done of all) done();
  };
  const ready = (timeoutMs: number): Promise<void> => new Promise((resolve) => {
    if (getGroupStore()) {
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
  let offIpc: (() => void) | null = registerGroupIpc(deps.getMainWindow, { store: getGroupStore, ready }, opts);
  const notify = (): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, { type: 'groups-changed' });
  };
  return {
    start() {
      if (getGroupStore()) return;
      const file = groupsFilePath(deps.wmuxDir());
      const store = new GroupStore(file, { bots: botRefs, onChange: notify });
      store.load();
      setGroupStore(store);
      const made = migrateRoomsToGroups(store, botRefs(), getRoomWriter());
      release();
      // A list that gave up waiting reads again.
      notify();
      console.log(`[factory] groups: ${store.list().length} loaded from ${path.basename(file)}${made.length > 0 ? ` (${made.length} made from rooms)` : ''}`);
    },
    dispose() {
      offIpc?.();
      offIpc = null;
      setGroupStore(null);
      release();
    },
  };
}

registerFactoryRpcModule('groups', (_router, deps) => createGroupModule(deps));
