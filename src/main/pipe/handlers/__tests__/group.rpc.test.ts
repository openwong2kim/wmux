// Group chat IPC (main window only) and the one-time move of workspace rooms
// into groups: a room the owner wrote in becomes a group in General; a room
// with no owner message is no longer listed; room files are never touched.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: class {} }));

vi.mock('../../../ipc/mainWindowSender', () => ({ isMainWindowSender: () => true }));

import { ipcMain } from 'electron';
import { RoomWriter } from '../../../factory/roomWriter';
import { GroupStore, getGroupStore, groupsFilePath, type GroupBotRef } from '../../../factory/groupStore';
import { BOT_GROUP_IPC } from '../../../../shared/botGroup';
import { createGroup, createGroupModule, listGroups, migrateRoomsToGroups, removeGroup, updateGroup } from '../group.rpc';

let dir = '';
/** Stores made by a test: their queued writes land before the dir goes. */
let stores: GroupStore[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-group-rpc-'));
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((s) => s.flush().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

const A = 'bot-0000000a';
const B = 'bot-0000000b';
const C = 'bot-0000000c';
const D = 'bot-0000000d';
const SOLO = 'bot-000000e0';

const BOTS: GroupBotRef[] = [
  { id: B, workspaceId: 'talked', createdAt: 2 },
  { id: A, workspaceId: 'talked', createdAt: 1 },
  { id: C, workspaceId: 'quiet', createdAt: 3 },
  { id: D, workspaceId: 'quiet', createdAt: 4 },
  { id: SOLO, workspaceId: 'solo', createdAt: 5 },
];

function rig() {
  const store = new GroupStore(groupsFilePath(dir), { bots: () => BOTS, log: () => undefined });
  store.load();
  stores.push(store);
  const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
  return { store, writer };
}

describe('migrateRoomsToGroups', () => {
  it('a team room with an owner message becomes a group in General; a quiet room and a lone bot\'s get none; once only', () => {
    const { store, writer } = rig();
    writer.append({ workspaceId: 'talked', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: 'Hi team' });
    writer.append({ workspaceId: 'talked', threadId: 'general', kind: 'status', actor: { kind: 'bot', workspaceId: 'talked', botId: A }, title: 'Hello' });
    // The owner only ever spoke in a 1:1 here, and bots chatted in General.
    writer.append({ workspaceId: 'quiet', threadId: `dm:${C}`, kind: 'human', actor: { kind: 'human' }, title: 'Private', refs: { botId: C } });
    writer.append({ workspaceId: 'quiet', threadId: 'general', kind: 'status', actor: { kind: 'bot', workspaceId: 'quiet', botId: D }, title: 'Hi' });
    writer.append({ workspaceId: 'solo', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: 'Hi' });
    const roomFile = path.join(dir, 'factory', 'rooms', 'talked.jsonl');
    const before = fs.readFileSync(roomFile, 'utf8');

    expect(migrateRoomsToGroups(store, BOTS, writer)).toEqual(['talked']);
    expect(store.list()).toEqual([expect.objectContaining({ workspaceId: 'talked', name: '', threadId: 'general', memberIds: [A, B] })]);
    expect(store.isMigrated()).toBe(true);
    // The room's cards are where they were: the group reads General as is.
    expect(fs.readFileSync(roomFile, 'utf8')).toBe(before);
    expect(writer.read('talked').cards.map((c) => c.threadId)).toEqual(['general', 'general']);
    // Done once: a later owner message elsewhere makes nothing.
    writer.append({ workspaceId: 'quiet', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: 'Late' });
    expect(migrateRoomsToGroups(store, BOTS, writer)).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it('waits while the bots or the rooms cannot be read (nothing is marked done)', () => {
    const { store, writer } = rig();
    expect(migrateRoomsToGroups(store, null, writer)).toEqual([]);
    expect(migrateRoomsToGroups(store, BOTS, null)).toEqual([]);
    expect(store.isMigrated()).toBe(false);
  });
});

describe('group IPC', () => {
  it('create, list, update and remove, refusing a malformed request', () => {
    const { store } = rig();
    const deps = { store: () => store };
    const made = createGroup({ workspaceId: 'talked', name: 'Ship', memberIds: [A, B] }, deps);
    expect(made).toMatchObject({ ok: true, group: { name: 'Ship', memberIds: [A, B] } });
    if (!made.ok) throw new Error('refused');
    expect(listGroups({ workspaceId: 'talked' }, deps)).toMatchObject({ ok: true, groups: [{ id: made.group.id }] });
    expect(listGroups({ workspaceId: 'quiet' }, deps)).toEqual({ ok: true, groups: [] });
    expect(updateGroup({ id: made.group.id, name: 'Release', memberIds: [B, A] }, deps)).toMatchObject({ ok: true, group: { name: 'Release', memberIds: [B, A] } });
    expect(createGroup({ workspaceId: 'talked', name: 'X', memberIds: 'nope' }, deps)).toMatchObject({ ok: false, code: 'invalid', field: 'members' });
    expect(updateGroup({ id: 'grp-x' }, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(removeGroup({ id: made.group.id }, deps)).toEqual({ ok: true });
    expect(removeGroup({ id: made.group.id }, deps)).toMatchObject({ ok: false, code: 'not_found' });
    expect(listGroups({}, { store: () => null })).toMatchObject({ ok: false, code: 'not_started' });
  });
});

describe('group IPC at boot (before the factory starts)', () => {
  type Handler = (e: unknown, req: unknown) => Promise<unknown>;
  const handlerFor = (channel: string): Handler => {
    const calls = vi.mocked(ipcMain.handle).mock.calls.filter((c) => c[0] === channel);
    return calls[calls.length - 1][1] as unknown as Handler;
  };

  it('is registered with the module; a list waits for the store and answers once it starts, a change refuses until then', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };
    const mod = createGroupModule({ wmuxDir: () => dir, getMainWindow: () => win as never }, { waitMs: 5_000 });
    try {
      expect(vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(Object.values(BOT_GROUP_IPC)));
      expect(getGroupStore()).toBeNull();
      const listed = handlerFor(BOT_GROUP_IPC.list)({}, {});
      expect(await handlerFor(BOT_GROUP_IPC.create)({}, { workspaceId: 'w', name: 'n', memberIds: [] })).toMatchObject({ ok: false, code: 'not_started' });
      await mod.start?.();
      expect(await listed).toEqual({ ok: true, groups: [] });
      // A list that gave up waiting is told to read again.
      expect(send).toHaveBeenCalledWith(expect.any(String), { type: 'groups-changed' });
    } finally {
      await getGroupStore()?.flush().catch(() => undefined);
      await mod.dispose?.();
    }
  });

  it('a list that waited too long answers not_started', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const mod = createGroupModule({ wmuxDir: () => dir, getMainWindow: () => null }, { waitMs: 20 });
    try {
      expect(await handlerFor(BOT_GROUP_IPC.list)({}, {})).toMatchObject({ ok: false, code: 'not_started' });
    } finally {
      await mod.dispose?.();
    }
  });
});
