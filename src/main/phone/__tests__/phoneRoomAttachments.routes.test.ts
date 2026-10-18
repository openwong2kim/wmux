import { describe, it, expect, afterEach, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({ nativeImage: {} }));

import { WebTerminalServer, type WebDeviceResolver } from '../../../daemon/web/WebTerminalServer';
import type { DaemonSessionManager } from '../../../daemon/DaemonSessionManager';
import { DesktopPhoneBridge } from '../../../daemon/phone/DesktopPhoneBridge';
import { AnswerReceiptStore } from '../../../daemon/approvals/AnswerReceiptStore';
import { MoaWakeService } from '../../../daemon/phone/MoaWakeService';
import { getWmuxDir } from '../../../daemon/config';
import { RoomWriter } from '../../factory/roomWriter';
import { WakeQueue, wakeQueuePath } from '../../factory/wakeQueue';
import { PHOTO_ONLY_WAKE_TEXT, factoryPhoneMessageSaved } from '../../factory/factoryWiring';
import { handlePhoneMoaWake, setFactoryPhoneMessageHandler } from '../../factory/phoneMessage';
import { RoomAttachmentStore, type RoomImageNormalizer } from '../../factory/roomAttachments';
import { handlePhoneRoomCommand, type PhoneFactoryPorts } from '../PhoneFactory';
import { DEFAULT_FACTORY_SETTINGS } from '../../../shared/factorySettings';
import { sniffRoomImage } from '../../../shared/roomAttachments';
import type { BotProfile } from '../../../shared/bot';

/**
 * Photos on a Bots room message from the phone, end to end: the real
 * server's upload and message routes, the real desktop bridge and Moa
 * message receipts, and main's real moa.wake dispatcher, phone message
 * path, RoomWriter, WakeQueue and photo store (only the image decoder is a
 * stand-in). Then the photo route serving the stored copy.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-photos-'));
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => { process.env.HOME = tmp; process.env.USERPROFILE = tmp; });
afterAll(() => {
  process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
  setFactoryPhoneMessageHandler(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const LEAD = {
  version: 1, id: 'bot-1111bbbb', workspaceId: 'ws-1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [], enabled: true,
  createdAt: 2, updatedAt: 2, hue: 3,
  budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 0, maxWorkerHoursPerDay: 0, turnTimeoutMs: 1 },
} as unknown as BotProfile;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(256)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(256)]);
const fakeNormalize: RoomImageNormalizer = (source) => (sniffRoomImage(source) ? { data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), source.subarray(4, 68)]), width: 800, height: 600 } : null);
const freshId = () => `${Date.now()}-${crypto.randomUUID()}`;
const ALL_COMMANDS = ['moa.wake', 'factory.message', 'factory.threadMessage', 'factory.threadAttachments', 'workspaces.roomAttachment'];

describe('photos on POST /api/rooms/:workspaceId/messages and GET …/attachments/:id', () => {
  let server: WebTerminalServer | undefined;
  let writer: RoomWriter;
  let queue: WakeQueue;
  let photos: RoomAttachmentStore;
  let queueFull: boolean;
  let flushFails: boolean;
  let dir: string;
  let toMain: Array<{ command: string; payload: Record<string, unknown> }>;
  const uploadsDir = () => path.join(getWmuxDir(), 'uploads', 'phone');
  const photoDir = () => path.join(getWmuxDir(), 'factory', 'room-attachments');
  const stored = () => (fs.existsSync(path.join(photoDir(), 'ws-1')) ? fs.readdirSync(path.join(photoDir(), 'ws-1')).sort() : []);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmp, 'case-'));
    fs.rmSync(photoDir(), { recursive: true, force: true });
    let clock = Date.now();
    writer = new RoomWriter({ dir: path.join(dir, 'rooms'), log: () => undefined, now: () => ++clock });
    queue = new WakeQueue(wakeQueuePath(dir), { isBotEnabled: () => true });
    photos = new RoomAttachmentStore({ root: photoDir(), uploadsDir: uploadsDir(), normalize: fakeNormalize, log: () => undefined });
    queueFull = false;
    flushFails = false;
    toMain = [];
    const directory = { listEnabled: () => [LEAD], get: (id: string) => (id === LEAD.id ? LEAD : null) };
    setFactoryPhoneMessageHandler((payload) => factoryPhoneMessageSaved(payload, {
      settings: () => ({ ...DEFAULT_FACTORY_SETTINGS, enabled: true }),
      writer: () => writer,
      attachments: () => photos,
      ports: () => ({
        bots: directory,
        wakes: {
          enqueue: (input: Parameters<WakeQueue['enqueue']>[0]) => (queueFull ? null : queue.enqueue(input)),
          flush: () => (flushFails ? Promise.reject(new Error('disk full')) : queue.flush()),
        } as never,
        groups: { byThread: () => null },
      }),
    }));
  });
  afterEach(async () => {
    if (server?.isRunning) await server.stop();
    server = undefined;
  });

  async function start(opts: { allowTranscript?: boolean; allowUpload?: boolean; announce?: string[] } = {}) {
    const ports = { rooms: () => writer } as unknown as PhoneFactoryPorts;
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      toMain.push({ command: data.command, payload: data.payload });
      queueMicrotask(() => {
        void (async () => {
          const result = data.command === 'moa.wake' ? await handlePhoneMoaWake(data.payload) : handlePhoneRoomCommand(data.command, data.payload, ports);
          bridge.complete(clientId, { requestId: data.requestId, ok: true, result });
        })();
      });
      return true;
    }, 2000);
    bridge.register('main', opts.announce ?? ALL_COMMANDS);
    const store = new AnswerReceiptStore(dir, Date.now, undefined, 'phone-moa-wake-receipts.json');
    const wake = new MoaWakeService({ receipts: () => store, desktop: () => bridge });
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        return deviceId === 'd1' && secret === 's1' ? { ok: true, deviceId, allowInput: true } : { ok: false, reason: 'unknown' };
      },
      list: () => [],
      hasExplicitInputGrant: () => true,
    };
    const sessionManager = Object.assign(new EventEmitter(), { getSession: () => undefined, listLiveSessions: () => [] }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager, devices, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir(),
      moaWake: () => wake, moaPane: () => null, uploadsDir: uploadsDir(), roomAttachmentsDir: photoDir(),
    });
    await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: opts.allowUpload ?? true, allowTranscript: opts.allowTranscript ?? true });
    const base = () => `http://127.0.0.1:${server!.status().port}`;
    const auth = { Authorization: 'Bearer d1.s1' };
    const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });
    return {
      config: async () => (await json(await fetch(`${base()}/api/config`, { headers: auth }))).body,
      upload: async (bytes: Buffer, ext?: string) => {
        const r = await json(await fetch(`${base()}${ext ? '/api/upload-file' : '/api/upload'}`, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream', ...(ext ? { 'X-Wmux-File-Extension': ext } : {}) }, body: new Uint8Array(bytes),
        }));
        expect(r.status).toBe(201);
        return path.basename(r.body.path as string);
      },
      send: async (body: unknown) => json(await fetch(`${base()}/api/rooms/ws-1/messages`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })),
      photo: (ws: string, id: string, query = '') => fetch(`${base()}/api/rooms/${ws}/attachments/${id}${query}`, { headers: auth }),
    };
  }

  const cards = () => writer.read('ws-1', { threadId: `dm:${LEAD.id}` }).cards;

  it('/api/config advertises sending and fetching only with every grant', async () => {
    let s = await start();
    expect(await s.config()).toMatchObject({ botMessages: true, botAttachments: true, roomAttachments: true });
    await server!.stop();
    s = await start({ allowUpload: false });
    const noUpload = await s.config();
    expect(noUpload).toMatchObject({ botMessages: true, roomAttachments: true });
    expect(noUpload).not.toHaveProperty('botAttachments');
    await server!.stop();
    s = await start({ announce: ['moa.wake', 'factory.message', 'factory.threadMessage'] });
    const old = await s.config();
    expect(old).toMatchObject({ botMessages: true });
    expect(old).not.toHaveProperty('botAttachments');
    expect(old).not.toHaveProperty('roomAttachments');
  });

  it('a photo and words: one card with the stored copy, the bot queued, and a replay after the upload was swept', async () => {
    const s = await start();
    const uploadId = await s.upload(JPEG);
    const clientMessageId = freshId();
    const body = { clientMessageId, text: 'This crashes on launch', threadId: `dm:${LEAD.id}`, attachments: [{ uploadId }] };
    expect(await s.send(body)).toMatchObject({ status: 202, body: { state: 'queued', clientMessageId, replayed: false } });
    const sent = toMain.find((m) => m.command === 'moa.wake')?.payload;
    expect(sent?.attachments).toEqual([{ uploadId, bytes: JPEG.length, sha256: crypto.createHash('sha256').update(JPEG).digest('hex') }]);
    const [card] = cards();
    expect(card).toMatchObject({ title: 'This crashes on launch', body: 'This crashes on launch' });
    expect(card.attachments).toHaveLength(1);
    expect(card.attachments![0]).toMatchObject({ mediaType: 'image/jpeg', width: 800, height: 600, upload: uploadId });
    expect(stored()).toEqual([`${card.attachments![0].id}.jpg`]);
    expect(queue.list({ states: ['queued'] }).map((i) => i.botId)).toEqual([LEAD.id]);

    // The 24 h prune took the upload: the same message still replays.
    fs.rmSync(path.join(uploadsDir(), uploadId));
    expect(await s.send(body)).toMatchObject({ status: 202, body: { state: 'queued', replayed: true } });
    // The same id with another photo is another message.
    const other = await s.upload(PNG);
    expect(await s.send({ ...body, attachments: [{ uploadId: other }] })).toMatchObject({ status: 409, body: { error: 'message-id-reused' } });
    expect(cards()).toHaveLength(1);
    expect(stored()).toHaveLength(1);

    // The photo route serves the stored copy, inert and uncached.
    const res = await s.photo('ws-1', card.attachments![0].id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes).toEqual(fs.readFileSync(path.join(photoDir(), 'ws-1', `${card.attachments![0].id}.jpg`)));
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect((await s.photo('ws-1', card.attachments![0].id, '?variant=thumb')).status).toBe(200);
    expect((await s.photo('ws-1', card.attachments![0].id, '?variant=big')).status).toBe(400);
    // Not on a card of that room, not an id, or its file gone: one 404.
    expect((await s.photo('ws-2', card.attachments![0].id)).status).toBe(404);
    expect((await s.photo('ws-1', 'f'.repeat(32))).status).toBe(404);
    expect((await s.photo('ws-1', '..%2F..%2Fsecret')).status).toBe(404);
    fs.rmSync(path.join(photoDir(), 'ws-1', `${card.attachments![0].id}.jpg`));
    expect(await (await s.photo('ws-1', card.attachments![0].id)).json()).toEqual({ error: 'attachment-not-found' });
  });

  it('a photo-only message: no words on the card, the placeholder title, a wake that says so', async () => {
    const s = await start();
    const uploadId = await s.upload(PNG);
    expect(await s.send({ clientMessageId: freshId(), text: '', threadId: `dm:${LEAD.id}`, attachments: [{ uploadId }] })).toMatchObject({ status: 202 });
    const [card] = cards();
    expect(card.title).toBe('Photo');
    expect(card.body).toBeUndefined();
    const [item] = queue.list({ states: ['queued'] });
    expect(item.reason).toMatchObject({ kind: 'human', text: PHOTO_ONLY_WAKE_TEXT });
    // Without photos an empty text is still refused.
    expect(await s.send({ clientMessageId: freshId(), text: '', threadId: `dm:${LEAD.id}` })).toMatchObject({ status: 400, body: { detail: 'text' } });
  });

  it('refusals before anything is posted, the id not spent', async () => {
    const s = await start();
    const thread = `dm:${LEAD.id}`;
    const clientMessageId = freshId();
    expect(await s.send({ clientMessageId, text: 'x', threadId: thread, attachments: [{ path: '/etc/passwd' }] })).toMatchObject({ status: 400, body: { error: 'invalid-chat-request', detail: 'attachments', effect: 'none' } });
    expect(await s.send({ clientMessageId, text: 'x', threadId: thread, attachments: [{ uploadId: '../../secret.jpg' }] })).toMatchObject({ status: 400, body: { detail: 'attachments' } });
    expect(await s.send({ clientMessageId, text: 'x', threadId: thread, attachments: [] })).toMatchObject({ status: 400, body: { detail: 'attachments' } });
    const missing = 'photo-2026-10-18T01-02-03-456Z-0a1b2c3d.jpg';
    expect(await s.send({ clientMessageId, text: 'x', threadId: thread, attachments: [{ uploadId: missing }] })).toMatchObject({ status: 400, body: { error: 'attachment-not-found', index: 0, effect: 'none' } });
    const gif = await s.upload(Buffer.from('GIF89a……not a png or jpeg'), 'gif');
    expect(await s.send({ clientMessageId, text: 'x', threadId: thread, attachments: [{ uploadId: gif }] })).toMatchObject({ status: 415, body: { error: 'attachment-unsupported', index: 0 } });
    if (process.platform !== 'win32') {
      const link = 'photo-2026-10-18T01-02-03-456Z-0a1b2c3e.jpg';
      const outside = path.join(dir, 'outside.jpg');
      fs.writeFileSync(outside, JPEG);
      fs.symlinkSync(outside, path.join(uploadsDir(), link));
      expect(await s.send({ clientMessageId, text: 'x', threadId: thread, attachments: [{ uploadId: link }] })).toMatchObject({ status: 400, body: { error: 'attachment-not-found' } });
    }
    expect(cards()).toEqual([]);
    expect(stored()).toEqual([]);
    // None of them spent the id.
    const good = await s.upload(JPEG);
    expect(await s.send({ clientMessageId, text: 'x', threadId: thread, attachments: [{ uploadId: good }] })).toMatchObject({ status: 202, body: { replayed: false } });
  });

  it('a desktop that takes no photos is never sent them', async () => {
    const s = await start({ announce: ['moa.wake', 'factory.message', 'factory.threadMessage'] });
    const uploadId = await s.upload(JPEG);
    expect(await s.send({ clientMessageId: freshId(), text: 'x', threadId: `dm:${LEAD.id}`, attachments: [{ uploadId }] })).toMatchObject({ status: 409, body: { error: 'attachments-unsupported' } });
    expect(toMain.filter((m) => m.command === 'moa.wake')).toEqual([]);
  });

  it('a full queue or a failed flush keeps the card and its photos; the retry copies nothing', async () => {
    const s = await start();
    for (const fail of ['queue', 'flush'] as const) {
      const uploadId = await s.upload(JPEG);
      queueFull = fail === 'queue';
      flushFails = fail === 'flush';
      const body = { clientMessageId: freshId(), text: `try ${fail}`, threadId: `dm:${LEAD.id}`, attachments: [{ uploadId }] };
      expect(await s.send(body)).toMatchObject({ status: 409, body: { error: 'moa-busy' } });
      const card = cards().find((c) => c.title === `try ${fail}`)!;
      expect(card.attachments).toHaveLength(1);
      const before = stored();
      expect(before).toContain(`${card.attachments![0].id}.jpg`);
      queueFull = false;
      flushFails = false;
      expect(await s.send(body)).toMatchObject({ status: 202, body: { state: 'queued' } });
      expect(stored()).toEqual(before);
      expect(cards().filter((c) => c.title === `try ${fail}`)).toHaveLength(1);
    }
  });

  it('a replay answers whatever the grants and the desktop are now; a new photo message needs the upload grant', async () => {
    let s = await start();
    const uploadId = await s.upload(JPEG);
    const body = { clientMessageId: freshId(), text: 'kept', threadId: `dm:${LEAD.id}`, attachments: [{ uploadId }] };
    expect(await s.send(body)).toMatchObject({ status: 202, body: { replayed: false } });
    await server!.stop();
    // Uploads switched off: the sent message still replays; a new one is refused.
    s = await start({ allowUpload: false });
    expect(await s.send(body)).toMatchObject({ status: 202, body: { replayed: true } });
    expect(await s.send({ ...body, clientMessageId: freshId() })).toMatchObject({ status: 403, body: { effect: 'none' } });
    expect(((await s.send({ ...body, clientMessageId: freshId() })).body.error as string).startsWith('uploads-disabled:')).toBe(true);
    await server!.stop();
    // A desktop that no longer takes photos: the replay is still the answer.
    s = await start({ announce: ['moa.wake', 'factory.message', 'factory.threadMessage'] });
    expect(await s.send(body)).toMatchObject({ status: 202, body: { replayed: true } });
  });

  it('a retry after a full queue needs no upload file: the card keeps its photos', async () => {
    const s = await start();
    const uploadId = await s.upload(JPEG);
    queueFull = true;
    const body = { clientMessageId: freshId(), text: 'after prune', threadId: `dm:${LEAD.id}`, attachments: [{ uploadId }] };
    expect(await s.send(body)).toMatchObject({ status: 409, body: { error: 'moa-busy' } });
    const before = stored();
    fs.rmSync(path.join(uploadsDir(), uploadId));
    queueFull = false;
    expect(await s.send(body)).toMatchObject({ status: 202, body: { state: 'queued' } });
    expect(stored()).toEqual(before);
    expect(cards().filter((c) => c.title === 'after prune')).toHaveLength(1);
  });

  it('the photo route needs the transcript grant', async () => {
    const s = await start({ allowTranscript: false });
    expect((await s.photo('ws-1', 'a'.repeat(32))).status).toBe(403);
  });
});
