// The owner's bot folders: made, renamed, collapsed, filled and deleted,
// one folder per bot, checked on every write and again on read.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotFolderStore, botFoldersFilePath } from '../botFolderStore';

let dir = '';
/** Stores made by a test: their queued writes land before the dir goes. */
let stores: BotFolderStore[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-bot-folders-'));
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((s) => s.flush().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

const A = 'bot-0000000a';
const B = 'bot-0000000b';
const C = 'bot-0000000c';

function rig(initial: string[] = [A, B, C]) {
  let n = 0;
  let changes = 0;
  const bots = [...initial];
  const file = botFoldersFilePath(dir);
  const make = () => {
    const s = new BotFolderStore(file, {
      now: () => 100 + n,
      newId: () => `fld-${(++n).toString(16).padStart(8, '0')}`,
      bots: () => bots,
      onChange: () => { changes += 1; },
      log: () => undefined,
    });
    stores.push(s);
    return s;
  };
  const store = make();
  store.load();
  return { store, bots, file, make, changes: () => changes };
}

function mustFolder(r: { ok: boolean }): { id: string } {
  const x = r as { ok: true; folder: { id: string } };
  if (!x.ok) throw new Error('refused');
  return x.folder;
}

describe('BotFolderStore', () => {
  it('assignMany files a set in one change, moves bots out of other folders, and unfiles with null', () => {
    const { store, changes } = rig();
    const f1 = mustFolder(store.create('One')).id;
    const f2 = mustFolder(store.create('Two')).id;
    expect(store.assign(C, f2)).toEqual({ ok: true });
    const before = changes();
    expect(store.assignMany([A, B, C], f1)).toEqual({ ok: true });
    expect(changes()).toBe(before + 1);
    expect(store.get(f1)?.botIds).toEqual([A, B, C]);
    expect(store.get(f2)?.botIds).toEqual([]);
    // Nothing to change, nothing announced.
    expect(store.assignMany([A, B], f1)).toEqual({ ok: true });
    expect(changes()).toBe(before + 1);
    expect(store.assignMany([A, C], null)).toEqual({ ok: true });
    expect(changes()).toBe(before + 2);
    expect(store.get(f1)?.botIds).toEqual([B]);
  });

  it('assignMany is all-or-none: an unknown bot, folder or malformed id changes nothing', () => {
    const { store, changes } = rig();
    const f1 = mustFolder(store.create('One')).id;
    expect(store.assign(A, f1)).toEqual({ ok: true });
    const before = changes();
    expect(store.assignMany([B, 'bot-000000ff'], f1)).toMatchObject({ ok: false, code: 'invalid', field: 'bot' });
    expect(store.assignMany([B, 'nope'], f1)).toMatchObject({ ok: false, code: 'invalid', field: 'bot' });
    expect(store.assignMany([B], 'fld-ffffffff')).toMatchObject({ ok: false, code: 'not_found' });
    expect(store.assignMany([], f1)).toMatchObject({ ok: false, code: 'invalid', field: 'bot' });
    expect(store.assignMany(Array.from({ length: 65 }, (_, i) => `bot-${i.toString(16).padStart(8, '0')}`), f1)).toMatchObject({ ok: false, code: 'invalid' });
    expect(changes()).toBe(before);
    expect(store.get(f1)?.botIds).toEqual([A]);
  });

  it('creates, renames and collapses a folder; ids are fld-<8hex>', () => {
    const { store, changes } = rig();
    const made = store.create('  Ship\n it  ');
    expect(made).toMatchObject({ ok: true, folder: { id: 'fld-00000001', name: 'Ship it', botIds: [], collapsed: false } });
    const id = mustFolder(made).id;
    expect(store.rename(id, 'Release')).toMatchObject({ ok: true, folder: { name: 'Release' } });
    expect(store.setCollapsed(id, true)).toMatchObject({ ok: true, folder: { collapsed: true } });
    const before = changes();
    // No change, no write.
    expect(store.setCollapsed(id, true)).toMatchObject({ ok: true });
    expect(changes()).toBe(before);
    expect(store.create('   ')).toMatchObject({ ok: false, code: 'invalid', field: 'name' });
    expect(store.rename(id, '')).toMatchObject({ ok: false, code: 'invalid', field: 'name' });
    expect(store.rename('fld-ffffffff', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(store.setCollapsed('fld-ffffffff', true)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a bot is in at most one folder: assigning moves it, null unfiles it', () => {
    const { store } = rig();
    const f1 = mustFolder(store.create('One')).id;
    const f2 = mustFolder(store.create('Two')).id;
    expect(store.assign(A, f1)).toEqual({ ok: true });
    expect(store.assign(B, f1)).toEqual({ ok: true });
    expect(store.assign(A, f1)).toEqual({ ok: true });
    expect(store.get(f1)?.botIds).toEqual([A, B]);
    expect(store.assign(A, f2)).toEqual({ ok: true });
    expect(store.get(f1)?.botIds).toEqual([B]);
    expect(store.get(f2)?.botIds).toEqual([A]);
    expect(store.assign(A, null)).toEqual({ ok: true });
    expect(store.list().flatMap((f) => f.botIds)).toEqual([B]);
    // Unfiling an unfiled bot is fine.
    expect(store.assign(C, null)).toEqual({ ok: true });
    expect(store.assign(C, 'fld-ffffffff')).toMatchObject({ ok: false, code: 'not_found' });
    expect(store.assign('nope', f1)).toMatchObject({ ok: false, code: 'invalid', field: 'bot' });
    expect(store.assign('bot-000000ff', f1)).toMatchObject({ ok: false, code: 'invalid', field: 'bot' });
  });

  it('removing a folder returns its bots to unfiled; the bots are untouched', () => {
    const { store } = rig();
    const f1 = mustFolder(store.create('One')).id;
    store.assign(A, f1);
    expect(store.remove(f1)).toMatchObject({ ok: true, folder: { id: f1, botIds: [A] } });
    expect(store.list()).toEqual([]);
    expect(store.remove(f1)).toMatchObject({ ok: false, code: 'not_found' });
    const f2 = mustFolder(store.create('Again')).id;
    expect(store.get(f2)?.botIds).toEqual([]);
  });

  it('reads leave out bots that no longer exist, and an unknown bot list prunes nothing', async () => {
    const r = rig();
    const f = mustFolder(r.store.create('One')).id;
    r.store.assign(A, f);
    r.store.assign(B, f);
    r.bots.splice(r.bots.indexOf(A), 1);
    expect(r.store.get(f)?.botIds).toEqual([B]);
    await r.store.flush();
    const blind = new BotFolderStore(r.file, { bots: () => null, log: () => undefined });
    stores.push(blind);
    blind.load();
    // The pruned bot is still on disk; only the read leaves it out.
    expect(blind.get(f)?.botIds).toEqual([A, B]);
  });

  it('persists and reloads; a bot named by two folders on disk stays in the first; malformed records are dropped', async () => {
    const r = rig();
    const f = mustFolder(r.store.create('One')).id;
    r.store.assign(A, f);
    r.store.setCollapsed(f, true);
    await r.store.flush();
    const again = r.make();
    again.load();
    expect(again.list()).toEqual([expect.objectContaining({ id: f, name: 'One', botIds: [A], collapsed: true })]);

    const good = { id: 'fld-00000001', name: 'First', botIds: [A, B], collapsed: false, createdAt: 1, updatedAt: 1 };
    fs.writeFileSync(r.file, JSON.stringify({
      version: 1,
      folders: [
        good,
        { ...good, id: 'fld-00000002', name: 'Second', botIds: [B, C] },
        { ...good, id: 'fld-00000001', name: 'Dup' },
        { ...good, id: 'bad', name: 'Bad id' },
        { ...good, id: 'fld-00000003', name: '' },
        { ...good, id: 'fld-00000004', botIds: 'nope' },
        'junk',
      ],
    }));
    const loaded = r.make();
    loaded.load();
    expect(loaded.list().map((x) => [x.name, x.botIds])).toEqual([['First', [A, B]], ['Second', [C]]]);
  });

  it('one malformed bot id drops only that id, not the folder', () => {
    const r = rig();
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, JSON.stringify({
      version: 1,
      folders: [{ id: 'fld-00000001', name: 'Keep', botIds: [A, 'nope', 7, B, A], collapsed: true, createdAt: 1, updatedAt: 1 }],
    }));
    const loaded = r.make();
    loaded.load();
    expect(loaded.list()).toEqual([expect.objectContaining({ name: 'Keep', botIds: [A, B], collapsed: true })]);
  });

  it('an unreadable or other-version file loads as no folders and is never written over', async () => {
    const r = rig();
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    for (const content of ['{ not json', JSON.stringify({ version: 99, folders: [] })]) {
      fs.writeFileSync(r.file, content);
      const s = r.make();
      s.load();
      expect(s.list()).toEqual([]);
      expect(s.writeRefusal()).toMatch(/bot-folders\.json/);
      expect(s.create('X')).toMatchObject({ ok: false, code: 'store_unreadable' });
      expect(s.rename('fld-00000001', 'X')).toMatchObject({ ok: false, code: 'store_unreadable' });
      expect(s.setCollapsed('fld-00000001', true)).toMatchObject({ ok: false, code: 'store_unreadable' });
      expect(s.assign(A, null)).toMatchObject({ ok: false, code: 'store_unreadable' });
      expect(s.remove('fld-00000001')).toMatchObject({ ok: false, code: 'store_unreadable' });
      await s.flush().catch(() => undefined);
      expect(fs.readFileSync(r.file, 'utf8')).toBe(content);
    }
  });

  it('tells the listener after each change and survives a throwing one', () => {
    let calls = 0;
    const s = new BotFolderStore(botFoldersFilePath(dir), { onChange: () => { calls += 1; throw new Error('boom'); }, log: () => undefined });
    stores.push(s);
    s.load();
    expect(s.create('One')).toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });
});
