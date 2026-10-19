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
  dialog: {},
  nativeImage: {},
}));

import { IPC } from '../../../../shared/constants';
import { RoomWriter } from '../../../factory/roomWriter';
import { RoomAttachmentStore, type RoomImageNormalizer } from '../../../factory/roomAttachments';
import { postWithPhotos, registerRoomIpcHandlers } from '../room.handler';
import { handleRoomPost, type RoomHandlerDeps } from '../../../pipe/handlers/room.rpc';
import { ROOM_RPC, type RoomCard } from '../../../../shared/room';
import { sniffRoomImage } from '../../../../shared/roomAttachments';
import type { RpcContext } from '../../../../shared/rpc';
import type { BotBinding } from '../../../../shared/bot';

/**
 * The desktop composer's photos: the room IPC handler copies the picked
 * files into the room's store and passes only stored records on; room.post
 * reads them for the operator alone, checked against the store.
 */

const WS = 'ws-photo-1';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
const normalize: RoomImageNormalizer = (s) => (sniffRoomImage(s) ? { data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), s.subarray(0, 8)]), width: 10, height: 8 } : null);
const OPERATOR: RpcContext = { origin: 'local', operator: true };
const WIRE: RpcContext = { origin: 'local', externalWire: true };
const BOT: RpcContext = { origin: 'local', bot: { workspaceId: WS, botId: 'bot-0a1b2c3d', role: 'lead' } as BotBinding };

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-room-photos-ipc-'));
  ipcHandlers.clear();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
  const store = new RoomAttachmentStore({ root: path.join(dir, 'factory', 'room-attachments'), uploadsDir: path.join(dir, 'uploads'), normalize, log: () => undefined });
  const deps: RoomHandlerDeps = { writer: () => writer, ports: () => ({}), wmuxDir: () => dir, attachments: () => store };
  const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => ({ id: 'x', ok: true, result: method === ROOM_RPC.post ? await handleRoomPost(params, OPERATOR, deps) : null }));
  const mainFrame = { name: 'main' };
  const webContents = { id: 1, mainFrame };
  registerRoomIpcHandlers(() => ({ isDestroyed: () => false, webContents }) as never, {
    invoke, writer: () => writer, wmuxDir: () => dir, attachments: () => store, resolvePath: async (p) => p, pickFiles: async () => ['/picked.jpg'],
  });
  const call = (channel: string, raw?: unknown, sender: unknown = webContents) =>
    (ipcHandlers.get(channel) as (e: unknown, raw: unknown) => Promise<unknown>)({ sender, senderFrame: mainFrame }, raw);
  const files = () => (fs.existsSync(path.join(dir, 'factory', 'room-attachments', WS)) ? fs.readdirSync(path.join(dir, 'factory', 'room-attachments', WS)) : []);
  const photo = (name: string) => { const p = path.join(dir, name); fs.writeFileSync(p, JPEG); return p; };
  return { writer, store, deps, call, files, photo, invoke };
}

describe('the desktop composer photos', () => {
  it('posts the stored copies on the owner card; the photo reads back as a data URL', async () => {
    const s = setup();
    const r = await s.call(IPC.ROOM_POST, { workspaceId: WS, title: 'look', body: 'look', clientPostId: 'desk-1', attachmentPaths: [s.photo('a.jpg'), s.photo('b.jpg')] }) as { ok: true; card: RoomCard };
    expect(r.ok).toBe(true);
    expect(r.card.attachments).toHaveLength(2);
    expect(s.files().sort()).toEqual(r.card.attachments!.map((a) => `${a.id}.jpg`).sort());
    const got = await s.call(IPC.ROOM_ATTACHMENT, { workspaceId: WS, attachmentId: r.card.attachments![0].id }) as { ok: true; dataUrl: string };
    expect(got.dataUrl).toBe(`data:image/jpeg;base64,${s.store.read(WS, r.card.attachments![0].id)!.toString('base64')}`);
    // Another room's id, or a stored file no card names, is not served.
    expect(await s.call(IPC.ROOM_ATTACHMENT, { workspaceId: 'ws-other', attachmentId: r.card.attachments![0].id })).toEqual({ ok: false });
    expect(await s.call(IPC.ROOM_PICK_ATTACHMENTS)).toEqual(['/picked.jpg']);
    // Another window is not the operator.
    expect(await s.call(IPC.ROOM_POST, { workspaceId: WS, title: 'x', attachmentPaths: [s.photo('c.jpg')] }, { id: 2 })).toMatchObject({ ok: false, code: 'operator_only' });
  });

  it('a retry of the same clientPostId copies nothing; a double send makes one copy', async () => {
    const s = setup();
    const params = { workspaceId: WS, title: 'twice', body: 'twice', clientPostId: 'desk-2', attachmentPaths: [s.photo('a.jpg')] };
    const [a, b] = await Promise.all([s.call(IPC.ROOM_POST, params), s.call(IPC.ROOM_POST, params)]) as Array<{ ok: true; card: RoomCard }>;
    expect(a.card.id).toBe(b.card.id);
    expect(s.files()).toHaveLength(1);
    await s.call(IPC.ROOM_POST, params);
    expect(s.files()).toHaveLength(1);
    // The owner moved the file since: the retry still answers with the card.
    fs.rmSync(params.attachmentPaths[0]);
    expect(await s.call(IPC.ROOM_POST, params)).toMatchObject({ ok: true, card: { id: a.card.id } });
  });

  it('a refused photo or a post with no card leaves no copy', async () => {
    const s = setup();
    const text = path.join(dir, 'notes.jpg');
    fs.writeFileSync(text, 'not an image');
    expect(await s.call(IPC.ROOM_POST, { workspaceId: WS, title: 'x', clientPostId: 'desk-3', attachmentPaths: [s.photo('a.jpg'), text] })).toMatchObject({ ok: false, code: 'attachment', reason: 'type', index: 1 });
    expect(s.files()).toEqual([]);
    // room.post refuses (a reply to no card): the copy is removed.
    expect(await s.call(IPC.ROOM_POST, { workspaceId: WS, title: 'x', replyTo: 'c-none', clientPostId: 'desk-4', attachmentPaths: [s.photo('b.jpg')] })).toMatchObject({ ok: false });
    expect(s.files()).toEqual([]);
    expect(await s.call(IPC.ROOM_POST, { workspaceId: WS, title: 'x', attachmentPaths: Array.from({ length: 5 }, (_, i) => s.photo(`${i}.jpg`)) })).toMatchObject({ ok: false, reason: 'count' });
  });

  it('records reach room.post only from the operator, and only stored ones', async () => {
    const s = setup();
    const imported = s.store.importFile(WS, s.photo('a.jpg'));
    if (!imported.ok) throw new Error('import failed');
    const record = imported.attachment;
    // The renderer's own `attachments` is never forwarded by the IPC handler.
    const viaIpc = await postWithPhotos({ workspaceId: WS, title: 'x', attachments: [record] }, {
      post: async (p) => p, writer: () => s.writer, store: () => s.store, resolvePath: async (p) => p, posting: new Map(),
    }) as Record<string, unknown>;
    expect(viaIpc).not.toHaveProperty('attachments');
    // The operator lane: a stored record posts; a made-up one is refused.
    const ok = await handleRoomPost({ workspaceId: WS, kind: 'human', title: 'op', attachments: [record] }, OPERATOR, s.deps) as { ok: true; card: RoomCard };
    expect(ok.card.attachments).toEqual([record]);
    expect(await handleRoomPost({ workspaceId: WS, kind: 'human', title: 'op', attachments: [{ ...record, id: 'e'.repeat(32) }] }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handleRoomPost({ workspaceId: WS, kind: 'human', title: 'op', attachments: [{ ...record, bytes: record.bytes + 1 }] }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    // A bot and the external wire: the field is ignored or the call refused.
    const bot = await handleRoomPost({ kind: 'status', title: 'bot', attachments: [record] }, BOT, s.deps) as { ok: boolean; card?: RoomCard };
    if (bot.ok) expect(bot.card?.attachments).toBeUndefined();
    expect(await handleRoomPost({ workspaceId: WS, kind: 'human', title: 'wire', attachments: [record] }, WIRE, s.deps)).toMatchObject({ ok: false, code: 'not_bot' });
    expect(s.writer.read(WS).cards.filter((c) => c.attachments?.length)).toHaveLength(1);
  });
});
