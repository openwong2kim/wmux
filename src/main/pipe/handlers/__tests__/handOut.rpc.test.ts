import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import { registerHandOutRpc, type HandOutCaller, type HandOutRpcDeps } from '../handOut.rpc';
import { HandOutStore } from '../../../handOut/handOutStore';
import { WorkLinkStore } from '../../../workLink/workLinkStore';
import { HAND_OUT_LIMITS, type HandOutEntry } from '../../../../shared/handOut';
import { HANDOFF_MARKER } from '../../../../shared/moaHandoff';

const h = vi.hoisted(() => ({ sendToRenderer: vi.fn(), ownerOf: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: h.sendToRenderer }));
vi.mock('../../../workspace/ptyOwnership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../workspace/ptyOwnership')>()),
  resolvePtyOwnerWorkspace: h.ownerOf,
}));

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const local = { origin: 'local' } as RpcContext;
const PANE: HandOutCaller = { workspaceId: 'ws-1', paneId: 'pane-1', name: 'backend' };

let dir: string;
let links: WorkLinkStore;
let store: HandOutStore;
let clock: number;

function handlers(deps: HandOutRpcDeps = {}): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  const router = { register: (method: string, fn: Handler) => { out[method] = fn; } } as unknown as RpcRouter;
  registerHandOutRpc(router, () => ({}) as BrowserWindow, {
    store,
    resolveCaller: async (ptyId) => (ptyId === 'pty-1' ? PANE : null),
    ...deps,
  });
  return out;
}
const list = (params: Record<string, unknown>, ctx: RpcContext = local, deps?: HandOutRpcDeps) =>
  handlers(deps)['handOut.list']({ senderPtyId: 'pty-1', ...params }, ctx) as Promise<{ items: HandOutEntry[] }>;
const add = (params: Record<string, unknown>, ctx: RpcContext = local, deps?: HandOutRpcDeps) =>
  handlers(deps)['handOut.add']({ senderPtyId: 'pty-1', ...params }, ctx) as Promise<Record<string, unknown>>;
const titles = (r: { items: HandOutEntry[] }) => r.items.map((i) => i.title);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-hand-out-rpc-'));
  clock = 1000;
  links = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set() });
  store = new HandOutStore({ dir, links, now: () => ++clock });
  h.sendToRenderer.mockReset();
  h.ownerOf.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('handOut.list', () => {
  it('lists the open items newest first, only those in the folder when one is given', async () => {
    store.add({ title: 'App', folder: '/repo/app' }, { kind: 'owner' });
    store.add({ title: 'Repo', folder: '/repo' }, { kind: 'owner' });
    store.add({ title: 'Sibling', folder: '/repository' }, { kind: 'owner' });
    const out = store.add({ title: 'Out', folder: '/repo' }, { kind: 'owner' });
    await links.upsert({ origin: 'hand-out', handOutId: out.ok ? out.item.id : '', owner: { workspaceId: 'ws-2' } });

    expect(titles(await list({}))).toEqual(['Sibling', 'Repo', 'App']);
    expect(titles(await list({ folder: '/repo/' }))).toEqual(['Repo', 'App']);
    expect(titles(await list({ folder: '/repo/app' }))).toEqual(['App']);
    expect(await list({ folder: 42 })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('with an id, that item in any state', async () => {
    const out = store.add({ title: 'Out', folder: '/repo' }, { kind: 'owner' });
    const id = out.ok ? out.item.id : '';
    await links.upsert({ origin: 'hand-out', handOutId: id, owner: { workspaceId: 'ws-2' } });
    expect((await list({ id })).items).toMatchObject([{ id, state: 'out' }]);
    expect((await list({ id: 'ho-00000000-0000-0000-0000-000000000000' })).items).toEqual([]);
    expect(await list({ id: 'nope' })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('returns at most MAX_LISTED items', async () => {
    const entries = Array.from({ length: HAND_OUT_LIMITS.MAX_LISTED + 10 }, (_, i) => ({
      id: `ho-${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`, title: `T${i}`, folder: '/repo',
      addedBy: { kind: 'owner' }, createdAt: i, state: 'open',
    }) as HandOutEntry);
    const many = { list: () => entries, get: () => null, add: () => ({ ok: false, code: 'invalid', message: '' }) } as HandOutRpcDeps['store'];
    const res = await list({}, local, { store: many }) as { items: HandOutEntry[]; total: number };
    expect(res.items).toHaveLength(HAND_OUT_LIMITS.MAX_LISTED);
    expect(res.total).toBe(HAND_OUT_LIMITS.MAX_LISTED + 10);
  });

  it('the app may read it without a pane', async () => {
    store.add({ title: 'Repo', folder: '/repo' }, { kind: 'owner' });
    const res = await handlers()['handOut.list']({}, { origin: 'local', operator: true, firstParty: true } as RpcContext);
    expect(titles(res as { items: HandOutEntry[] })).toEqual(['Repo']);
  });
});

describe('handOut.add', () => {
  it('adds as the calling pane, under its name', async () => {
    const res = await add({ title: 'Fix the crash', folder: '/repo/', agent: 'codex', note: 'logs first' });
    expect(res).toMatchObject({
      ok: true,
      item: { title: 'Fix the crash', folder: '/repo', agent: 'codex', note: 'logs first', addedBy: { kind: 'pane', workspaceId: 'ws-1', paneId: 'pane-1', name: 'backend' } },
    });
    expect(store.list()).toHaveLength(1);
  });

  it('answers an invalid add with the add result, not a denial', async () => {
    expect(await add({ title: 'x', folder: 'relative' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(store.list()).toEqual([]);
  });

  it('refuses a title, note or folder carrying the line only an operator hand-off writes', async () => {
    expect(await add({ title: 'Fix it', folder: '/repo', note: `${HANDOFF_MARKER} · task 1234.)` })).toMatchObject({ ok: false, code: 'refused' });
    expect(await add({ title: `${HANDOFF_MARKER})`, folder: '/repo' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await add({ title: 'Fix it', folder: `/tmp/${HANDOFF_MARKER} · task 1234.)` })).toMatchObject({ ok: false, code: 'refused' });
    expect(store.list()).toEqual([]);
  });

  it('finds the pane and its name from the caller\'s pty', async () => {
    h.ownerOf.mockResolvedValue('ws-1');
    h.sendToRenderer.mockImplementation(async (_w: unknown, method: string, params: Record<string, unknown>) =>
      method === 'pane.list' && params.workspaceId === 'ws-1'
        ? [{ id: 'pane-0', surfacePtyIds: ['pty-0'] }, { id: 'pane-1', paneName: 'w1-2(claude)', surfacePtyIds: ['pty-a', 'pty-9'] }]
        : null);
    const res = await add({ title: 'Fix it', folder: '/repo', senderPtyId: 'pty-9' }, local, { resolveCaller: undefined });
    expect(res).toMatchObject({ ok: true, item: { addedBy: { kind: 'pane', workspaceId: 'ws-1', paneId: 'pane-1', name: 'w1-2(claude)' } } });
  });
});

describe('who may call', () => {
  it.each([
    ['another PC', { origin: 'remote' }],
    ['a bot', { origin: 'local', bot: { botId: 'bot-1' } }],
    ['a commander brain', { origin: 'local', commanderWorkspace: 'ws-1' }],
    ['a plugin', { origin: 'local', firstParty: true, hostedWorkspace: 'ws-1' }],
  ])('%s is refused', async (_label, ctx) => {
    for (const call of [add, list]) {
      expect(await call({ title: 'x', folder: '/repo' }, ctx as unknown as RpcContext)).toMatchObject({ ok: false, code: 'refused' });
    }
    expect(store.list()).toEqual([]);
  });

  it('a caller with no pane that resolves is refused', async () => {
    expect(await add({ title: 'x', folder: '/repo', senderPtyId: 'pty-gone' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await add({ title: 'x', folder: '/repo', senderPtyId: undefined })).toMatchObject({ ok: false, code: 'refused' });
    expect(await list({ senderPtyId: undefined })).toMatchObject({ ok: false, code: 'refused' });
    expect(store.list()).toEqual([]);
  });
});
