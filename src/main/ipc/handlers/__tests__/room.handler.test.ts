import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, fn); }),
    removeHandler: vi.fn((channel: string) => { ipcHandlers.delete(channel); }),
  },
}));

import { IPC } from '../../../../shared/constants';
import { RoomWriter } from '../../../factory/roomWriter';
import { liveFactoryState, readFactoryStateFile, registerRoomIpcHandlers, unwrapRpc } from '../room.handler';
import { FactorySettingsStore, setFactorySettingsStore } from '../../../factory/factorySettings';
import { handleRoomPost, handleRoomRead, handleRoomResolve, handleRoomThreads } from '../../../pipe/handlers/room.rpc';
import { ROOM_RPC } from '../../../../shared/room';
import type { RpcContext } from '../../../../shared/rpc';
import type { WorkspaceDecision } from '../../../deck/deckDecisionStore';
import type { RemovedBot } from '../../../../shared/bot';

const WS = 'ws-room-1';

function setup(opts: { decisions?: WorkspaceDecision[]; factory?: { enabled: boolean; hqWorkspaceId: string | null }; removed?: RemovedBot[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp7-room-ipc-'));
  const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
  const mainFrame = { name: 'main' };
  const webContents = { id: 1, mainFrame };
  const win = { isDestroyed: () => false, webContents };
  // The router's operator lane, reduced to the room handlers.
  const deps = { writer: () => writer, ports: () => ({}), wmuxDir: () => dir };
  const ctx: RpcContext = { origin: 'local', operator: true };
  const handlers: Record<string, (raw: unknown) => unknown> = {
    [ROOM_RPC.read]: (raw) => handleRoomRead(raw, ctx, deps),
    [ROOM_RPC.threads]: (raw) => handleRoomThreads(raw, ctx, deps),
    [ROOM_RPC.post]: (raw) => handleRoomPost(raw, ctx, deps),
    [ROOM_RPC.resolve]: (raw) => handleRoomResolve(raw, ctx, deps),
  };
  const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => ({ id: 'x', ok: true, result: await handlers[method](params) }));
  const dispose = registerRoomIpcHandlers(() => win as never, {
    invoke,
    writer: () => writer,
    wmuxDir: () => dir,
    decisions: () => opts.decisions ?? [],
    bots: () => [{ id: 'bot-00000001', role: 'verifier', name: 'Verifier' }],
    removedBots: () => opts.removed ?? [],
    ...(opts.factory ? { factoryState: () => opts.factory! } : {}),
  });
  const call = (channel: string, raw?: unknown, sender: unknown = webContents, senderFrame: unknown = mainFrame) =>
    (ipcHandlers.get(channel) as (e: unknown, raw: unknown) => Promise<unknown>)({ sender, senderFrame }, raw);
  return { dir, writer, call, dispose, invoke };
}

describe('room.handler', () => {
  const dirs: string[] = [];
  beforeEach(() => ipcHandlers.clear());
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('refuses every channel to a sender that is not the main window', async () => {
    const s = setup();
    dirs.push(s.dir);
    const other = { id: 2 };
    for (const ch of [IPC.ROOM_STATUS, IPC.ROOM_READ, IPC.ROOM_THREADS, IPC.ROOM_POST, IPC.ROOM_RESOLVE, IPC.ROOM_DECISION, IPC.ROOM_ACTORS]) {
      const raw = { workspaceId: WS, title: 'x', cardId: 'c', resolution: 'ok' };
      expect(await s.call(ch, raw, other)).toMatchObject({ ok: false, code: 'operator_only' });
      // A subframe of the main window, and a frame that is gone.
      expect(await s.call(ch, raw, undefined, { name: 'iframe' })).toMatchObject({ ok: false, code: 'operator_only' });
      expect(await s.call(ch, raw, undefined, null)).toMatchObject({ ok: false, code: 'operator_only' });
    }
    expect(s.writer.read(WS).cards).toEqual([]);
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it('posts only human cards, whatever kind the renderer sends', async () => {
    const s = setup();
    dirs.push(s.dir);
    await s.call(IPC.ROOM_POST, { workspaceId: WS, title: 'x', kind: 'verdict' });
    expect(s.invoke).toHaveBeenCalledWith(ROOM_RPC.post, expect.objectContaining({ kind: 'human' }));
  });

  it('answers not_wired without the operator bridge, and unwraps router errors', async () => {
    const mainFrame = {};
    const webContents = { id: 1, mainFrame };
    registerRoomIpcHandlers(() => ({ isDestroyed: () => false, webContents }) as never, {});
    const read = ipcHandlers.get(IPC.ROOM_READ) as (e: unknown, raw: unknown) => Promise<unknown>;
    expect(await read({ sender: webContents, senderFrame: mainFrame }, { workspaceId: WS })).toMatchObject({ ok: false, code: 'not_wired' });
    expect(unwrapRpc({ id: 'x', ok: false, error: 'denied' })).toEqual({ ok: false, code: 'rpc_error', message: 'denied' });
  });

  it('posts a human card as the owner and reads it back by thread', async () => {
    const s = setup();
    dirs.push(s.dir);
    const r = await s.call(IPC.ROOM_POST, { workspaceId: WS, threadId: 'general', title: 'hello @lead', clientPostId: 'p1' });
    expect(r).toMatchObject({ ok: true, card: { kind: 'human', actor: { kind: 'human' }, title: 'hello @lead' }, addressee: null });
    const read = await s.call(IPC.ROOM_READ, { workspaceId: WS, threadId: 'general' });
    expect(read).toMatchObject({ ok: true, cards: [{ title: 'hello @lead' }], hasMore: false });
    const threads = await s.call(IPC.ROOM_THREADS, { workspaceId: WS }) as { threads: { threadId: string; unread: number | null }[] };
    expect(threads.threads.find((t) => t.threadId === 'general')?.unread).toBeNull();
  });

  it('records a read position only forward, through room:read', async () => {
    const s = setup();
    dirs.push(s.dir);
    await s.call(IPC.ROOM_POST, { workspaceId: WS, title: 'one' });
    await s.call(IPC.ROOM_POST, { workspaceId: WS, title: 'two' });
    await s.call(IPC.ROOM_READ, { workspaceId: WS, threadId: 'general', markThroughSeq: 1 });
    const threads = await s.call(IPC.ROOM_THREADS, { workspaceId: WS }) as { threads: { threadId: string; unread: number | null }[] };
    expect(threads.threads.find((t) => t.threadId === 'general')?.unread).toBe(1);
  });

  it('closes an open plan card through room:resolve', async () => {
    const s = setup();
    dirs.push(s.dir);
    const plan = s.writer.append({ workspaceId: WS, threadId: 'plan:p1', kind: 'plan', actor: { kind: 'system' }, title: 'Plan', state: 'open' })!;
    const r = await s.call(IPC.ROOM_RESOLVE, { workspaceId: WS, cardId: plan.id, resolution: 'approve' });
    expect(r).toMatchObject({ ok: true, card: { id: plan.id, state: 'resolved' } });
  });

  it('gives the decision behind a question card, and none for another card', async () => {
    const decision: WorkspaceDecision = { id: 'd-1', question: 'Ship?', options: ['yes', 'no'], context: '', status: 'pending', raisedAt: 1 };
    const s = setup({ decisions: [decision] });
    dirs.push(s.dir);
    const q = s.writer.append({ workspaceId: WS, threadId: 'general', kind: 'question', actor: { kind: 'system' }, title: 'Ship?', state: 'open', refs: { decisionId: 'd-1' } })!;
    const other = s.writer.append({ workspaceId: WS, kind: 'status', actor: { kind: 'system' }, title: 'x', refs: { decisionId: 'd-1' } })!;
    expect(await s.call(IPC.ROOM_DECISION, { workspaceId: WS, cardId: q.id })).toEqual({ decision });
    expect(await s.call(IPC.ROOM_DECISION, { workspaceId: WS, cardId: other.id })).toEqual({ decision: null });
    expect(await s.call(IPC.ROOM_DECISION, { workspaceId: '../x', cardId: q.id })).toEqual({ decision: null });
  });

  it('names bot authors by role and name only', async () => {
    const s = setup();
    dirs.push(s.dir);
    expect(await s.call(IPC.ROOM_ACTORS)).toEqual({ actors: { 'bot-00000001': { role: 'verifier', name: 'Verifier' } } });
  });

  it('a removed bot keeps its name, picture and colour slot, marked removed', async () => {
    const s = setup({ removed: [{ id: 'bot-0000000d', workspaceId: WS, role: 'lead', template: 'developer', name: 'Developer', hue: 2, removedAt: 5 }] });
    dirs.push(s.dir);
    expect(await s.call(IPC.ROOM_ACTORS)).toEqual({ actors: {
      'bot-00000001': { role: 'verifier', name: 'Verifier' },
      'bot-0000000d': { role: 'lead', name: 'Developer', removed: true, hue: 2 },
    } });
  });

  it('reports whether rooms run and the factory state', async () => {
    const s = setup({ factory: { enabled: true, hqWorkspaceId: 'ws-hq' } });
    dirs.push(s.dir);
    expect(await s.call(IPC.ROOM_STATUS)).toEqual({ running: true, enabled: true, hqWorkspaceId: 'ws-hq' });
  });
});

describe('readFactoryStateFile', () => {
  it('reads enabled from a version-1 file (never an HQ), and anything else as off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp7-room-fs-'));
    try {
      expect(readFactoryStateFile(dir)).toEqual({ enabled: false, hqWorkspaceId: null });
      fs.mkdirSync(path.join(dir, 'factory'));
      const file = path.join(dir, 'factory', 'settings.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, hqWorkspaceId: 'ws-hq' }));
      expect(readFactoryStateFile(dir)).toEqual({ enabled: true, hqWorkspaceId: null });
      fs.writeFileSync(file, JSON.stringify({ version: 2, enabled: true }));
      expect(readFactoryStateFile(dir)).toEqual({ enabled: false, hqWorkspaceId: null });
      fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: 'yes', hqWorkspaceId: '../etc' }));
      expect(readFactoryStateFile(dir)).toEqual({ enabled: false, hqWorkspaceId: null });
      fs.writeFileSync(file, '{not json');
      expect(readFactoryStateFile(dir)).toEqual({ enabled: false, hqWorkspaceId: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('liveFactoryState', () => {
  it('reads the runtime\'s live settings once it started, the file before', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp3a-room-live-'));
    try {
      fs.mkdirSync(path.join(dir, 'factory'));
      fs.writeFileSync(path.join(dir, 'factory', 'settings.json'), JSON.stringify({ version: 1, enabled: true, hqWorkspaceId: 'ws-file' }));
      // The HQ setting is read by nobody: it never comes back.
      expect(liveFactoryState(() => dir)).toEqual({ enabled: true, hqWorkspaceId: null });
      const store = new FactorySettingsStore(path.join(dir, 'other-settings.json'));
      store.load();
      await store.update({ enabled: false, hqWorkspaceId: 'ws-live' });
      setFactorySettingsStore(store);
      expect(liveFactoryState(() => dir)).toEqual({ enabled: false, hqWorkspaceId: null });
      await store.update({ enabled: true, planConsent: { version: 1, at: '2026-10-15T00:00:00.000Z' } });
      expect(liveFactoryState(() => dir).enabled).toBe(true);
    } finally {
      setFactorySettingsStore(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
