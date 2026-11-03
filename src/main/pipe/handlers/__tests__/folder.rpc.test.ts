// Bot folder IPC (main window only): error mapping, the sender guard, the
// `folders-changed` push, and the handlers being there before the factory
// starts.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sender = vi.hoisted(() => ({ allowed: true }));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: class {} }));

vi.mock('../../../ipc/mainWindowSender', () => ({ isMainWindowSender: () => sender.allowed }));

import { ipcMain } from 'electron';
import { BotFolderStore, botFoldersFilePath, getBotFolderStore } from '../../../factory/botFolderStore';
import { BOT_FOLDER_IPC } from '../../../../shared/botFolder';
import {
  assignBotToFolder,
  assignBotsToFolder,
  createFolder,
  createFolderModule,
  listFolders,
  removeFolder,
  renameFolder,
  setFolderCollapsed,
} from '../folder.rpc';

let dir = '';
/** Stores made by a test: their queued writes land before the dir goes. */
let stores: BotFolderStore[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-folder-rpc-'));
  stores = [];
  sender.allowed = true;
});
afterEach(async () => {
  await Promise.all(stores.map((s) => s.flush().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

const A = 'bot-0000000a';
const B = 'bot-0000000b';

function rig() {
  const store = new BotFolderStore(botFoldersFilePath(dir), { bots: () => [A, B], log: () => undefined });
  store.load();
  stores.push(store);
  return { store, deps: { store: () => store } };
}

describe('folder IPC functions', () => {
  it('create, rename, collapse, assign, list and remove; a malformed request is refused', () => {
    const { deps } = rig();
    const made = createFolder({ name: 'Ship' }, deps);
    expect(made).toMatchObject({ ok: true, folder: { name: 'Ship' } });
    if (!made.ok) throw new Error('refused');
    const id = made.folder.id;
    expect(renameFolder({ id, name: 'Release' }, deps)).toMatchObject({ ok: true, folder: { name: 'Release' } });
    expect(setFolderCollapsed({ id, collapsed: true }, deps)).toMatchObject({ ok: true, folder: { collapsed: true } });
    expect(assignBotToFolder({ botId: A, folderId: id }, deps)).toEqual({ ok: true });
    expect(listFolders({}, deps)).toMatchObject({ ok: true, folders: [{ id, botIds: [A] }] });
    expect(assignBotToFolder({ botId: A, folderId: null }, deps)).toEqual({ ok: true });
    expect(listFolders({}, deps)).toMatchObject({ ok: true, folders: [{ id, botIds: [] }] });

    expect(createFolder({ name: 5 }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'name' });
    expect(createFolder(null, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'name' });
    expect(renameFolder({ id: 'x', name: 'a' }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'folder' });
    expect(renameFolder({ id, name: 3 }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'name' });
    expect(setFolderCollapsed({ id, collapsed: 'yes' }, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(assignBotToFolder({ botId: 7, folderId: id }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'bot' });
    expect(assignBotToFolder({ botId: A }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'folder' });
    expect(assignBotToFolder({ botId: A, folderId: 'fld-ffffffff' }, deps)).toMatchObject({ ok: false, code: 'not_found' });
    expect(removeFolder({ id: 'x' }, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(removeFolder({ id }, deps)).toEqual({ ok: true });
    expect(removeFolder({ id }, deps)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('assignBotsToFolder files a batch and refuses a malformed request', () => {
    const { deps } = rig();
    const made = createFolder({ name: 'Ship' }, deps);
    if (!made.ok) throw new Error('refused');
    const id = made.folder.id;
    expect(assignBotsToFolder({ botIds: [A, B], folderId: id }, deps)).toEqual({ ok: true });
    expect(listFolders({}, deps)).toMatchObject({ ok: true, folders: [{ id, botIds: [A, B] }] });
    expect(assignBotsToFolder({ botIds: [A, B], folderId: null }, deps)).toEqual({ ok: true });
    expect(assignBotsToFolder({ botIds: 'x', folderId: id }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'bot' });
    expect(assignBotsToFolder({ botIds: [A, 7], folderId: id }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'bot' });
    expect(assignBotsToFolder({ botIds: [A] }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'folder' });
    expect(assignBotsToFolder({ botIds: [A], folderId: 'fld-ffffffff' }, deps)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('every call answers not_started without a store', () => {
    const deps = { store: () => null };
    for (const r of [
      listFolders({}, deps),
      createFolder({ name: 'a' }, deps),
      renameFolder({}, deps),
      setFolderCollapsed({}, deps),
      assignBotToFolder({}, deps),
      assignBotsToFolder({}, deps),
      removeFolder({}, deps),
    ]) expect(r).toMatchObject({ ok: false, code: 'not_started' });
  });

  it('an unreadable file surfaces as store_unreadable', () => {
    fs.mkdirSync(path.dirname(botFoldersFilePath(dir)), { recursive: true });
    fs.writeFileSync(botFoldersFilePath(dir), '{ nope');
    const { deps } = rig();
    expect(createFolder({ name: 'a' }, deps)).toMatchObject({ ok: false, code: 'store_unreadable' });
    // Delete answers the same, not not_found: the folder may well exist on disk.
    expect(removeFolder({ id: 'fld-00000001' }, deps)).toMatchObject({ ok: false, code: 'store_unreadable' });
  });
});

describe('folder IPC at boot (before the factory starts)', () => {
  type Handler = (e: unknown, req: unknown) => Promise<unknown>;
  const handlerFor = (channel: string): Handler => {
    const calls = vi.mocked(ipcMain.handle).mock.calls.filter((c) => c[0] === channel);
    return calls[calls.length - 1][1] as unknown as Handler;
  };

  it('is registered with the module; a list waits for the store and answers once it starts, a change refuses until then', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };
    const mod = createFolderModule({ wmuxDir: () => dir, getMainWindow: () => win as never }, { waitMs: 5_000 });
    try {
      expect(vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(Object.values(BOT_FOLDER_IPC)));
      expect(getBotFolderStore()).toBeNull();
      const listed = handlerFor(BOT_FOLDER_IPC.list)({}, {});
      expect(await handlerFor(BOT_FOLDER_IPC.create)({}, { name: 'n' })).toMatchObject({ ok: false, code: 'not_started' });
      await mod.start?.();
      expect(await listed).toEqual({ ok: true, folders: [] });
      // A list that gave up waiting is told to read again.
      expect(send).toHaveBeenCalledWith(expect.any(String), { type: 'folders-changed' });

      send.mockClear();
      expect(await handlerFor(BOT_FOLDER_IPC.create)({}, { name: 'Ship' })).toMatchObject({ ok: true, folder: { name: 'Ship' } });
      expect(send).toHaveBeenCalledWith(expect.any(String), { type: 'folders-changed' });

      // A batch pushes one folders-changed, not one per bot.
      const id = (await handlerFor(BOT_FOLDER_IPC.create)({}, { name: 'Two' }) as { folder: { id: string } }).folder.id;
      send.mockClear();
      expect(await handlerFor(BOT_FOLDER_IPC.assignMany)({}, { botIds: [A, B], folderId: id })).toEqual({ ok: true });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.any(String), { type: 'folders-changed' });
    } finally {
      await getBotFolderStore()?.flush().catch(() => undefined);
      await mod.dispose?.();
    }
  });

  it('refuses a sender that is not the main window top frame, and changes nothing', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const mod = createFolderModule({ wmuxDir: () => dir, getMainWindow: () => null }, { waitMs: 20 });
    try {
      await mod.start?.();
      sender.allowed = false;
      for (const channel of Object.values(BOT_FOLDER_IPC)) {
        expect(await handlerFor(channel)({}, { name: 'x', id: 'fld-00000001', botId: A, botIds: [A], folderId: null, collapsed: true })).toMatchObject({ ok: false, code: 'not_authorized' });
      }
      expect(getBotFolderStore()?.list()).toEqual([]);
    } finally {
      await getBotFolderStore()?.flush().catch(() => undefined);
      await mod.dispose?.();
    }
  });

  it('a list that waited too long answers not_started', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const mod = createFolderModule({ wmuxDir: () => dir, getMainWindow: () => null }, { waitMs: 20 });
    try {
      expect(await handlerFor(BOT_FOLDER_IPC.list)({}, {})).toMatchObject({ ok: false, code: 'not_started' });
    } finally {
      await mod.dispose?.();
    }
  });
});
