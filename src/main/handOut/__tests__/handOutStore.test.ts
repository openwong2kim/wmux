import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HandOutStore, getHandOutPath } from '../handOutStore';
import { WorkLinkStore } from '../../workLink/workLinkStore';
import { HAND_OUT_LIMITS, type HandOutItem } from '../../../shared/handOut';
import type { WorkLink } from '../../../shared/workLink';

let dir: string;
let clock: number;
let links: WorkLinkStore;
const make = () => new HandOutStore({ dir, links, now: () => ++clock });
const owner = { kind: 'owner' } as const;
const stored = (over: Partial<HandOutItem> = {}): HandOutItem => ({
  id: `ho-${randomUUID()}`, title: 'Fix it', folder: '/repo', addedBy: owner, createdAt: 1, ...over,
});
const onDisk = () => JSON.parse(readFileSync(getHandOutPath(dir), 'utf8')) as { version: number; items: HandOutItem[] };
async function pickLink(handOutId: string): Promise<WorkLink> {
  const link = await links.upsert({ origin: 'hand-out', handOutId, title: 'Fix it', owner: { workspaceId: 'ws-1', paneId: 'pane-1' } });
  if (!link) throw new Error('the link was not recorded');
  return link;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-hand-out-'));
  clock = 1000;
  links = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set() });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('HandOutStore', () => {
  it('drops a done item when its link finishes before anyone read the list', async () => {
    const a = make();
    const added = a.add({ title: 'Done unseen', folder: '/repo' }, owner);
    if (!added.ok) throw new Error('add failed');
    const link = await pickLink(added.item.id);
    await links.upsert({ id: link.id, a2aTaskId: 'task-9' });
    await a.flush();
    await links.flush();

    // A restart: fresh stores over the same files, the list not read yet.
    links = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set() });
    make();
    await links.upsert({ id: link.id, a2aState: 'completed' });
    expect(links.get(link.id)?.state).toBe('done');
    await vi.waitFor(() => expect(onDisk().items).toEqual([]), { timeout: 5_000 });
  });

  it('puts an item back when the app stopped between recording a pick and sending it', async () => {
    const a = make();
    const stranded = a.add({ title: 'Stranded', folder: '/repo' }, owner);
    const sent = a.add({ title: 'Sent', folder: '/repo' }, owner);
    if (!stranded.ok || !sent.ok) throw new Error('add failed');
    await pickLink(stranded.item.id);
    await links.upsert({ origin: 'hand-out', handOutId: sent.item.id, title: 'Sent', a2aTaskId: 'task-1', owner: { workspaceId: 'ws-1', paneId: 'pane-1' } });
    expect(a.get(stranded.item.id)?.state).toBe('out');
    await a.flush();

    const b = make();
    expect(b.list()).toHaveLength(2);
    await links.flush();
    expect(b.get(stranded.item.id)?.state).toBe('open');
    expect(b.get(sent.item.id)?.state).toBe('out');
  });

  it('adds, lists newest first, removes, and keeps the list across a reload', async () => {
    const a = make();
    const first = a.add({ title: 'First', folder: '/repo' }, owner);
    const second = a.add({ title: 'Second', folder: '/repo/app', agent: 'codex', note: 'n' }, { kind: 'pane', workspaceId: 'ws-1', paneId: 'pane-1', name: 'w1-2' });
    expect(first).toMatchObject({ ok: true, item: { title: 'First', addedBy: owner } });
    expect(second.ok && second.item.id).toMatch(/^ho-[0-9a-f-]{36}$/);
    expect(a.list().map((e) => [e.title, e.state])).toEqual([['Second', 'open'], ['First', 'open']]);
    await a.flush();
    expect(make().list().map((e) => e.title)).toEqual(['Second', 'First']);

    expect(a.remove(first.ok ? first.item.id : '')).toBe(true);
    expect(a.remove(first.ok ? first.item.id : '')).toBe(false);
    await a.flush();
    expect(onDisk()).toMatchObject({ version: 1, items: [{ title: 'Second' }] });
  });

  it('refuses an invalid add, and an add past the cap', () => {
    writeFileSync(getHandOutPath(dir), JSON.stringify({
      version: 1,
      items: Array.from({ length: HAND_OUT_LIMITS.MAX_ITEMS }, () => stored()),
    }));
    const a = make();
    expect(a.add({ title: ' ', folder: '/repo' }, owner)).toMatchObject({ ok: false, code: 'invalid' });
    expect(a.add({ title: 'One more', folder: '/repo' }, owner)).toMatchObject({ ok: false, code: 'full' });
    expect(a.list()).toHaveLength(HAND_OUT_LIMITS.MAX_ITEMS);
  });

  it('starts empty on a torn file and writes a good one over it', async () => {
    writeFileSync(getHandOutPath(dir), '{"items": [ torn');
    const a = make();
    expect(a.list()).toEqual([]);
    a.add({ title: 'Fix it', folder: '/repo' }, owner);
    await a.flush();
    expect(onDisk().items).toHaveLength(1);
  });

  it('never writes over a file it cannot read, and merges its adds once the file reads again', async () => {
    const file = getHandOutPath(dir);
    mkdirSync(file);
    const a = make();
    const added = a.add({ title: 'Added while unreadable', folder: '/repo' }, owner);
    expect(added.ok).toBe(true);
    await a.flush();
    expect(statSync(file).isDirectory()).toBe(true);

    rmSync(file, { recursive: true, force: true });
    const kept = stored({ title: 'On disk' });
    writeFileSync(file, JSON.stringify({ version: 1, items: [kept] }));
    expect(a.list().map((e) => e.title).sort()).toEqual(['Added while unreadable', 'On disk']);
    await a.flush();
    expect(onDisk().items.map((i) => i.title).sort()).toEqual(['Added while unreadable', 'On disk']);
  });

  it('closes a stopped app\'s picks on the first read though the file cannot be read, and never its own later', async () => {
    const left = await pickLink(`ho-${randomUUID()}`);
    const file = getHandOutPath(dir);
    mkdirSync(file);
    const a = make();
    const added = a.add({ title: 'Picked while unreadable', folder: '/repo' }, owner);
    if (!added.ok) throw new Error('add failed');
    await vi.waitFor(() => expect(links.get(left.id)?.state).toBe('abandoned'), { timeout: 5_000 });

    // This process's pick, still sending when the file reads again.
    await pickLink(added.item.id);
    rmSync(file, { recursive: true, force: true });
    expect(a.get(added.item.id)?.state).toBe('out');
    await links.flush();
    expect(a.get(added.item.id)?.state).toBe('out');
  });

  it('drops a bad record on its own', () => {
    const good = stored({ title: 'Good' });
    writeFileSync(getHandOutPath(dir), JSON.stringify({ version: 1, items: [{ ...stored(), folder: 'relative' }, good, 'junk', good] }));
    expect(make().list().map((e) => e.title)).toEqual(['Good']);
  });

  it('an item is out while its pick\'s link is live, and open again once that link is abandoned', async () => {
    const a = make();
    const added = a.add({ title: 'Fix it', folder: '/repo' }, owner);
    const id = added.ok ? added.item.id : '';
    const changed = vi.fn();
    a.onChange(changed);
    const link = await pickLink(id);
    expect(changed).toHaveBeenCalled();
    expect(a.get(id)).toMatchObject({ state: 'out', linkId: link.id });
    expect(a.list()[0]).toMatchObject({ state: 'out', linkId: link.id });
    await links.setState(link.id, 'abandoned');
    expect(a.get(id)).toMatchObject({ state: 'open' });
    expect(a.get(id)?.linkId).toBeUndefined();
  });

  it('a link that names no item on the list pushes nothing', async () => {
    const a = make();
    a.add({ title: 'Fix it', folder: '/repo' }, owner);
    const changed = vi.fn();
    a.onChange(changed);
    await links.upsert({ origin: 'manual', owner: { workspaceId: 'ws-1' } });
    await pickLink(`ho-${randomUUID()}`);
    expect(changed).not.toHaveBeenCalled();
  });

  it('an item whose work is done leaves the list, on disk too', async () => {
    const a = make();
    const added = a.add({ title: 'Fix it', folder: '/repo' }, owner);
    const id = added.ok ? added.item.id : '';
    const link = await pickLink(id);
    const changed = vi.fn();
    a.onChange(changed);
    await links.upsert({ id: link.id, a2aTaskId: 'task-1', a2aState: 'completed' });
    expect(changed).toHaveBeenCalled();
    expect(a.list()).toEqual([]);
    expect(a.get(id)).toBeNull();
    await a.flush();
    expect(onDisk().items).toEqual([]);
  });

  it('drops on load an item whose work finished while the app was closed', async () => {
    const item = stored();
    writeFileSync(getHandOutPath(dir), JSON.stringify({ version: 1, items: [item, stored({ title: 'Still open' })] }));
    const link = await pickLink(item.id);
    await links.setState(link.id, 'done');
    const a = make();
    expect(a.list().map((e) => e.title)).toEqual(['Still open']);
    await a.flush();
    expect(onDisk().items.map((i) => i.title)).toEqual(['Still open']);
  });

  it('a reservation holds an open item for one pick at a time', async () => {
    const a = make();
    const added = a.add({ title: 'Fix it', folder: '/repo' }, owner);
    const id = added.ok ? added.item.id : '';
    expect(a.reserve(id)).toBe(true);
    expect(a.reserve(id)).toBe(false);
    a.release(id);
    expect(a.reserve(id)).toBe(true);
    a.release(id);
    expect(a.reserve(`ho-${randomUUID()}`)).toBe(false);
    await pickLink(id);
    expect(a.reserve(id)).toBe(false);
  });
});
