// The owner's group chats: made, renamed, members changed and deleted (the
// record kept, hidden), checked on every write and again on read.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GroupStore, groupsFilePath, type GroupBotRef } from '../groupStore';

let dir = '';
/** Stores made by a test: their queued writes land before the dir goes. */
let stores: GroupStore[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-groups-'));
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((s) => s.flush().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

const A = 'bot-0000000a';
const B = 'bot-0000000b';
const C = 'bot-0000000c';
const FAR = 'bot-000000ff';

function track(s: GroupStore): GroupStore {
  stores.push(s);
  return s;
}

function rig(bots: GroupBotRef[] = [
  { id: A, workspaceId: 'ws1', createdAt: 1 },
  { id: B, workspaceId: 'ws1', createdAt: 2 },
  { id: C, workspaceId: 'ws1', createdAt: 3 },
  { id: FAR, workspaceId: 'ws2', createdAt: 0 },
]) {
  let n = 0;
  let changes = 0;
  const list = [...bots];
  const file = groupsFilePath(dir);
  const make = () => track(new GroupStore(file, {
    now: () => 100 + n,
    newId: () => `grp-${(++n).toString(16).padStart(8, '0')}`,
    bots: () => list,
    onChange: () => { changes += 1; },
    log: () => undefined,
  }));
  const store = make();
  store.load();
  return { store, list, file, make, changes: () => changes };
}

describe('GroupStore', () => {
  it('a bot on My Hermes talks one to one: no group takes it, by create, update or the room move', () => {
    const r = rig([
      { id: A, workspaceId: 'ws1', createdAt: 1, name: 'Alpha', ownHermes: true },
      { id: B, workspaceId: 'ws1', createdAt: 2, name: 'Beta' },
      { id: C, workspaceId: 'ws1', createdAt: 3, name: 'Gamma' },
    ]);
    expect(r.store.create({ workspaceId: 'ws1', name: 'Team', memberIds: [A, B] })).toMatchObject({ ok: false, field: 'members', message: expect.stringContaining('Alpha uses your own Hermes') });
    const made = r.store.create({ workspaceId: 'ws1', name: 'Team', memberIds: [B, C] });
    if (!made.ok) throw new Error(made.message);
    expect(r.store.update(made.group.id, { memberIds: [A, B, C] })).toMatchObject({ ok: false, field: 'members' });
    // One bot left is no group: the room stays a room and can still be adopted later.
    expect(r.store.adoptRoom('ws1', [A, B])).toBeNull();
    expect(r.store.adoptRoom('ws1', [A, B, C])?.memberIds).toEqual([B, C]);
  });

  it('creates a named group of two or more bots of one workspace, in its own thread', () => {
    const r = rig();
    const made = r.store.create({ workspaceId: 'ws1', name: '  Ship\nit  ', memberIds: [B, A, B] });
    expect(made).toEqual({ ok: true, group: { id: 'grp-00000001', workspaceId: 'ws1', name: 'Ship it', memberIds: [B, A], threadId: 'group:grp-00000001', createdAt: 101, updatedAt: 101 } });
    expect(r.changes()).toBe(1);
    expect(r.store.byThread('ws1', 'group:grp-00000001')?.id).toBe('grp-00000001');
    expect(r.store.byThread('ws2', 'group:grp-00000001')).toBeNull();
    // Refused: no name, one bot, a bot of another workspace, a stray id.
    expect(r.store.create({ workspaceId: 'ws1', name: '   ', memberIds: [A, B] })).toMatchObject({ ok: false, field: 'name' });
    expect(r.store.create({ workspaceId: 'ws1', name: 'Solo', memberIds: [A] })).toMatchObject({ ok: false, field: 'members' });
    expect(r.store.create({ workspaceId: 'ws1', name: 'Mixed', memberIds: [A, FAR] })).toMatchObject({ ok: false, field: 'members' });
    expect(r.store.create({ workspaceId: 'ws1', name: 'Odd', memberIds: [A, 'moa'] })).toMatchObject({ ok: false, field: 'members' });
    expect(r.store.create({ workspaceId: '../x', name: 'Bad', memberIds: [A, B] })).toMatchObject({ ok: false, field: 'workspace' });
    expect(r.store.list()).toHaveLength(1);
  });

  it('renames and changes members; a deleted group is hidden but kept, and survives a reload', async () => {
    const r = rig();
    const made = r.store.create({ workspaceId: 'ws1', name: 'Ship', memberIds: [A, B] });
    if (!made.ok) throw new Error('refused');
    const id = made.group.id;
    expect(r.store.update(id, { name: 'Release' })).toMatchObject({ ok: true, group: { name: 'Release', memberIds: [A, B] } });
    expect(r.store.update(id, { memberIds: [A, B, C] })).toMatchObject({ ok: true, group: { name: 'Release', memberIds: [A, B, C] } });
    expect(r.store.update(id, { memberIds: [A] })).toMatchObject({ ok: false, field: 'members' });
    expect(r.store.update(id, { name: '' })).toMatchObject({ ok: false, field: 'name' });
    expect(r.store.remove(id)?.id).toBe(id);
    expect(r.store.list()).toEqual([]);
    expect(r.store.get(id)).toBeNull();
    expect(r.store.byThread('ws1', `group:${id}`)).toBeNull();
    expect(r.store.update(id, { name: 'Back' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(r.store.remove(id)).toBeNull();
    await r.store.flush();
    const raw = JSON.parse(fs.readFileSync(r.file, 'utf8')) as { version: number; groups: Array<{ id: string; deletedAt?: number }> };
    expect(raw.version).toBe(1);
    expect(raw.groups).toEqual([expect.objectContaining({ id, deletedAt: expect.any(Number) })]);
    const again = r.make();
    again.load();
    expect(again.list()).toEqual([]);
  });

  it('reads members that are bots of the workspace now; a deleted bot drops out', () => {
    const r = rig();
    const made = r.store.create({ workspaceId: 'ws1', name: 'Trio', memberIds: [A, B, C] });
    if (!made.ok) throw new Error('refused');
    r.list.splice(r.list.findIndex((b) => b.id === C), 1);
    expect(r.store.get(made.group.id)?.memberIds).toEqual([A, B]);
  });

  it('a room becomes a group once per workspace, in General with no name of its own; never again after a delete', async () => {
    const r = rig();
    const g = r.store.adoptRoom('ws1', [A, B, C]);
    expect(g).toMatchObject({ workspaceId: 'ws1', name: '', threadId: 'general', memberIds: [A, B, C] });
    expect(r.store.byThread('ws1', 'general')?.id).toBe(g?.id);
    expect(r.store.adoptRoom('ws1', [A, B])).toBeNull();
    r.store.remove(g!.id);
    expect(r.store.adoptRoom('ws1', [A, B])).toBeNull();
    expect(r.store.hadRoomGroup('ws1')).toBe(true);
    expect(r.store.isMigrated()).toBe(false);
    r.store.markMigrated();
    await r.store.flush();
    const again = r.make();
    again.load();
    expect(again.isMigrated()).toBe(true);
    expect(again.hadRoomGroup('ws1')).toBe(true);
  });

  it('a file of another version or garbage loads nothing and is never written over; a malformed record is dropped', () => {
    const r = rig();
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, JSON.stringify({ version: 2, groups: [] }));
    const bad = r.make();
    bad.load();
    expect(bad.writeRefusal()).toMatch(/cannot be read/);
    expect(bad.create({ workspaceId: 'ws1', name: 'X', memberIds: [A, B] })).toMatchObject({ ok: false, code: 'store_unreadable' });
    expect(bad.adoptRoom('ws1', [A, B])).toBeNull();
    expect(JSON.parse(fs.readFileSync(r.file, 'utf8')).version).toBe(2);
    fs.writeFileSync(r.file, JSON.stringify({ version: 1, migrated: true, groups: [
      { id: 'grp-00000001', workspaceId: 'ws1', name: 'Ok', memberIds: [A, B], threadId: 'group:grp-00000001', createdAt: 1, updatedAt: 1 },
      // A thread that is not its own, an empty name outside General, a bad member.
      { id: 'grp-00000002', workspaceId: 'ws1', name: 'Bad', memberIds: [A, B], threadId: 'group:grp-00000001', createdAt: 1, updatedAt: 1 },
      { id: 'grp-00000003', workspaceId: 'ws1', name: '', memberIds: [A, B], threadId: 'group:grp-00000003', createdAt: 1, updatedAt: 1 },
      { id: 'grp-00000004', workspaceId: 'ws1', name: 'X', memberIds: ['nope'], threadId: 'group:grp-00000004', createdAt: 1, updatedAt: 1 },
    ] }));
    const ok = r.make();
    ok.load();
    expect(ok.list().map((g) => g.id)).toEqual(['grp-00000001']);
    expect(ok.isMigrated()).toBe(true);
  });
});
