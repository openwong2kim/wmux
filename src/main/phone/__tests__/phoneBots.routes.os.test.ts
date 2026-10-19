import { describe, it, expect, afterEach, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../../../daemon/web/WebTerminalServer';
import type { DaemonSessionManager } from '../../../daemon/DaemonSessionManager';
import { DesktopPhoneBridge } from '../../../daemon/phone/DesktopPhoneBridge';
import { AnswerReceiptStore } from '../../../daemon/approvals/AnswerReceiptStore';
import { MoaWakeService } from '../../../daemon/phone/MoaWakeService';
import { RoomWriter } from '../../factory/roomWriter';
import { WakeQueue, wakeQueuePath } from '../../factory/wakeQueue';
import { factoryPhoneMessageSaved } from '../../factory/factoryWiring';
import { handlePhoneMoaWake, setFactoryPhoneMessageHandler } from '../../factory/phoneMessage';
import { handlePhoneBotsCommand, type PhoneBotsPorts } from '../PhoneFactory';
import { DEFAULT_FACTORY_SETTINGS } from '../../../shared/factorySettings';
import type { BotProfile, BotStatus } from '../../../shared/bot';
import type { BotGroup } from '../../../shared/botGroup';

/**
 * The Bots page on the phone contract (daemon/web/bots.ts and
 * WebTerminalServer.handleRoomMessage), end to end over the real server, the
 * real desktop bridge and the real Moa message path (MoaWakeService and its
 * receipt file). Main's side is real too: PhoneFactory's list, the `moa.wake`
 * dispatcher and factoryPhoneMessageSaved over a real RoomWriter and
 * WakeQueue, with fake bot, group and settings ports.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-bots-'));
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => { process.env.HOME = tmp; process.env.USERPROFILE = tmp; });
afterAll(() => {
  process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
  setFactoryPhoneMessageHandler(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bot = (over: Partial<BotProfile>): BotProfile => ({
  version: 1, id: 'bot-0000aaaa', workspaceId: 'ws-hq', role: 'moa', name: 'Moa',
  engine: { kind: 'claude-sdk' }, triggers: [], enabled: true, createdAt: 1, updatedAt: 1, hue: 0,
  budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 0, maxWorkerHoursPerDay: 0, turnTimeoutMs: 1 },
  ...over,
} as BotProfile);

const HQ = bot({});
const LEAD = bot({ id: 'bot-1111bbbb', workspaceId: 'ws-1', role: 'lead', name: 'Lead', createdAt: 2, hue: 3, avatar: 'data:image/png;base64,AAAA' });
const OFF = bot({ id: 'bot-2222cccc', workspaceId: 'ws-1', role: 'triage', name: 'Sleepy', createdAt: 3, hue: 5, enabled: false });
const GROUP: BotGroup = { id: 'grp-0000abcd', workspaceId: 'ws-1', name: 'Crew', memberIds: [LEAD.id, OFF.id], threadId: 'group:grp-0000abcd', createdAt: 4, updatedAt: 4 };
const ROOM_GROUP: BotGroup = { id: 'grp-0000beef', workspaceId: 'ws-1', name: '', memberIds: [OFF.id], threadId: 'general', createdAt: 5, updatedAt: 5 };

const freshId = () => `${Date.now()}-${crypto.randomUUID()}`;
const chatSpentId = freshId();

describe('GET /api/bots and POST /api/rooms/:workspaceId/messages', () => {
  let server: WebTerminalServer | undefined;
  let writer: RoomWriter;
  let queue: WakeQueue;
  let enabled: boolean;
  let wakesUp: boolean;
  let queueFull: boolean;
  let groups: BotGroup[];
  let dir: string;
  let toMain: Array<{ command: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmp, 'case-'));
    // Each card a millisecond after the last: the list orders by time.
    let clock = Date.now();
    writer = new RoomWriter({ dir: path.join(dir, 'rooms'), log: () => undefined, now: () => ++clock });
    queue = new WakeQueue(wakeQueuePath(dir), { isBotEnabled: () => true });
    enabled = true;
    wakesUp = true;
    queueFull = false;
    groups = [GROUP, ROOM_GROUP];
    toMain = [];
    const all = [HQ, LEAD, OFF];
    const directory = { listEnabled: () => all.filter((b) => b.enabled), get: (id: string) => all.find((b) => b.id === id) ?? null };
    setFactoryPhoneMessageHandler((payload) => factoryPhoneMessageSaved(payload, {
      settings: () => ({ ...DEFAULT_FACTORY_SETTINGS, enabled }),
      writer: () => writer,
      ports: () => ({
        bots: directory,
        ...(wakesUp ? { wakes: queueFull ? { enqueue: () => null, flush: () => queue.flush() } : queue } : {}),
        groups: { byThread: (ws, t) => groups.find((g) => g.workspaceId === ws && g.threadId === t) ?? null },
      }),
    }));
  });
  afterEach(async () => {
    if (server?.isRunning) await server.stop();
    server = undefined;
  });

  const ports = (): PhoneBotsPorts => ({
    settings: () => ({ enabled, hqWorkspaceId: null }),
    bots: () => [OFF, LEAD, HQ],
    status: (id): BotStatus | null => (id === LEAD.id
      ? { botId: id, presence: 'running', queueDepth: 2, budgetLeft: { turnsHour: 1, turnsDay: 1, workerHoursDay: 0 } }
      : null),
    rooms: () => writer,
    handoffs: () => [],
    roomFileExists: () => true,
    roomReadable: () => true,
    now: () => Date.now(),
    groups: () => groups,
    workspaceName: (ws) => (ws === 'ws-1' ? 'wmux' : null),
  });

  async function start(opts: { allowTranscript?: boolean; announce?: string[] } = {}) {
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      toMain.push({ command: data.command, payload: data.payload });
      queueMicrotask(() => {
        void (async () => {
          const result = data.command === 'moa.wake' ? await handlePhoneMoaWake(data.payload)
            : data.command === 'workspaces.list' ? { workspaces: [] }
              : await handlePhoneBotsCommand(data.command, ports);
          bridge.complete(clientId, { requestId: data.requestId, ok: true, result });
        })();
      });
      return true;
    }, 500);
    bridge.register('main', opts.announce ?? ['moa.wake', 'factory.message', 'factory.threadMessage', 'workspaces.bots']);
    const store = new AnswerReceiptStore(dir, Date.now, undefined, 'phone-moa-wake-receipts.json');
    const wake = new MoaWakeService({ receipts: () => store, desktop: () => bridge });
    const roster: Record<string, boolean> = { d1: true, d3: false };
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        return deviceId in roster && secret === `s${deviceId.slice(1)}` ? { ok: true, deviceId, allowInput: roster[deviceId] } : { ok: false, reason: 'unknown' };
      },
      list: () => [],
      hasExplicitInputGrant: (deviceId) => roster[deviceId] === true,
    };
    const sessionManager = Object.assign(new EventEmitter(), { getSession: () => undefined, listLiveSessions: () => [] }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager, devices, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir(),
      moaWake: () => wake, moaPane: () => null,
      // Only the chat send receipts: one id this caller spent on a pane.
      chat: () => ({
        priorSend: (owner: string, cmid: string) => (cmid === chatSpentId
          ? { paneId: 's1', view: { clientMessageId: cmid, state: 'submitted' as const, result: 'sent' as const } }
          : undefined),
      }) as never,
    });
    await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: opts.allowTranscript ?? true });
    const call = async (method: string, route: string, body?: unknown, auth = 'Bearer d1.s1') => {
      const res = await fetch(`http://127.0.0.1:${server!.status().port}${route}`, {
        method, headers: { Authorization: auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get('cache-control'), retryAfter: res.headers.get('retry-after') };
    };
    return {
      get: (route: string, auth?: string) => call('GET', route, undefined, auth),
      send: (ws: string, body: unknown, auth?: string) => call('POST', `/api/rooms/${encodeURIComponent(ws)}/messages`, body, auth),
    };
  }

  describe('GET /api/bots', () => {
    it('every bot and conversation across workspaces, newest first, as the desktop draws them', async () => {
      const { get } = await start();
      const post = (threadId: string, actor: 'human' | BotProfile, title: string, ws = 'ws-1') => writer.post({
        workspaceId: ws, threadId: threadId as never, kind: actor === 'human' ? 'human' : 'status', title,
        actor: actor === 'human' ? { kind: 'human' } : { kind: 'bot', workspaceId: actor.workspaceId, botId: actor.id },
      });
      post(`dm:${HQ.id}`, 'human', 'morning', 'ws-hq');
      post(`dm:${LEAD.id}`, 'human', 'Can you fix the login?');
      post(`dm:${LEAD.id}`, LEAD, 'On it — PR soon');
      writer.post({ workspaceId: 'ws-1', threadId: `dm:${LEAD.id}`, kind: 'fact', title: 'Task started', actor: { kind: 'system' } });
      post(GROUP.threadId, LEAD, 'Crew: standup');

      const r = await get('/api/bots');
      expect(r.status).toBe(200);
      expect(r.cache).toBe('no-store');
      expect(r.body.factoryEnabled).toBe(true);
      // Bots oldest first; the HQ is the phone bot; the avatar is the stored slot.
      expect(r.body.bots).toEqual([
        { id: HQ.id, name: 'Moa', role: 'moa', workspaceId: 'ws-hq', enabled: true, isHq: true, presence: 'unknown', queueDepth: 0, avatar: { hue: 0, picture: false } },
        { id: LEAD.id, name: 'Lead', role: 'lead', workspaceId: 'ws-1', enabled: true, isHq: false, presence: 'running', queueDepth: 2, avatar: { hue: 3, picture: true } },
        { id: OFF.id, name: 'Sleepy', role: 'triage', workspaceId: 'ws-1', enabled: false, isHq: false, presence: 'unknown', queueDepth: 0, avatar: { hue: 5, picture: false } },
      ]);
      const rows = r.body.conversations as Array<Record<string, unknown>>;
      // Newest activity first; a conversation with nothing said sorts by its creation.
      expect(rows.map((c) => c.threadId)).toEqual([GROUP.threadId, `dm:${LEAD.id}`, `dm:${HQ.id}`, 'general', `dm:${OFF.id}`]);
      expect(rows[0]).toMatchObject({
        kind: 'group', groupId: GROUP.id, workspaceId: 'ws-1', workspaceName: 'wmux', name: 'Crew', memberBotIds: [LEAD.id, OFF.id],
        lastPreview: 'Crew: standup', lastActor: { kind: 'bot', botId: LEAD.id, role: 'lead', name: 'Lead' }, unread: null, openQuestions: 0,
      });
      // wmux's own line is newer, but the preview is the newest message.
      expect(rows[1]).toMatchObject({ kind: 'dm', botId: LEAD.id, name: 'Lead', memberBotIds: [LEAD.id], lastPreview: 'On it — PR soon', lastActor: { kind: 'bot', botId: LEAD.id } });
      expect(rows[1].lastSeq).toBe(3);
      expect(rows[2]).toMatchObject({ kind: 'dm', botId: HQ.id, lastPreview: 'morning', lastActor: { kind: 'human' } });
      expect(rows[2]).not.toHaveProperty('workspaceName');
      // The group a room became lives in General and is named after its workspace.
      expect(rows[3]).toMatchObject({ kind: 'group', groupId: ROOM_GROUP.id, threadId: 'general', name: 'wmux', lastAt: ROOM_GROUP.createdAt });
      // A switched-off bot keeps its 1:1 (read-only on the desktop).
      expect(rows[4]).toMatchObject({ kind: 'dm', botId: OFF.id, lastAt: OFF.createdAt, lastSeq: 0 });
      expect(rows[4]).not.toHaveProperty('lastPreview');
    });

    it("a row's open questions are its own thread's, not those of the task threads it started", async () => {
      const { get } = await start();
      const ask = (threadId: string, title: string) => writer.post({
        workspaceId: 'ws-1', threadId: threadId as never, kind: 'question', title, state: 'open',
        actor: { kind: 'bot', workspaceId: 'ws-1', botId: LEAD.id },
      });
      ask('handoff:h-1', 'Should I take the old task?');
      ask(GROUP.threadId, 'Crew: ship it?');
      const rows = (await get('/api/bots')).body.conversations as Array<Record<string, unknown>>;
      expect(rows.find((c) => c.threadId === 'general')).toMatchObject({ openQuestions: 0 });
      expect(rows.find((c) => c.threadId === GROUP.threadId)).toMatchObject({ openQuestions: 1 });
    });

    it('the factory off still lists, and says so', async () => {
      enabled = false;
      const { get } = await start();
      const r = await get('/api/bots');
      expect(r.body).toMatchObject({ factoryEnabled: false });
      expect((r.body.bots as Array<{ isHq: boolean }>).some((b) => b.isHq)).toBe(false);
    });

    it('gates: transcript first; a desktop without the list or a factory not started is 503', async () => {
      let s = await start({ allowTranscript: false });
      expect(await s.get('/api/bots')).toMatchObject({ status: 403, body: { error: 'transcript-disabled' } });
      expect((await s.get('/api/config')).body).not.toHaveProperty('bots');
      await server!.stop();
      s = await start({ announce: ['moa.wake', 'factory.message'] });
      expect(await s.get('/api/bots')).toMatchObject({ status: 503, body: { error: 'bots-unavailable' } });
      expect((await s.get('/api/config')).body).not.toHaveProperty('bots');
      expect((await s.get('/api/config')).body).not.toHaveProperty('botMessages');
      await server!.stop();
      groups = null as never;
      s = await start();
      expect(await s.get('/api/bots')).toMatchObject({ status: 503, body: { error: 'bots-unavailable' } });
    });

    it('/api/config: bots and botMessages for a caller who may send; bots only for one without input', async () => {
      const { get } = await start();
      expect((await get('/api/config')).body).toMatchObject({ bots: true, botMessages: true });
      const readOnly = (await get('/api/config', 'Bearer d3.s3')).body;
      expect(readOnly).toMatchObject({ bots: true });
      expect(readOnly).not.toHaveProperty('botMessages');
    });
  });

  describe('POST /api/rooms/:workspaceId/messages', () => {
    it('202 queued: the owner card lands in that conversation with the clientMessageId, and a replay is the same answer', async () => {
      const { send, get } = await start();
      const clientMessageId = freshId();
      const body = { clientMessageId, text: 'Can you fix the login?', threadId: `dm:${LEAD.id}` };
      const first = await send('ws-1', body);
      expect(first).toMatchObject({ status: 202, body: { state: 'queued', clientMessageId, replayed: false } });
      expect(first.cache).toBe('no-store');
      expect(toMain.find((m) => m.command === 'moa.wake')?.payload).toMatchObject({ mode: 'factory', workspaceId: 'ws-1', threadId: `dm:${LEAD.id}`, clientMessageId });
      expect(queue.list({ states: ['queued'] }).map((i) => [i.botId, i.threadId])).toEqual([[LEAD.id, `dm:${LEAD.id}`]]);
      // The room routes serve the card with the id it was sent under.
      const cards = writer.read('ws-1', { threadId: `dm:${LEAD.id}` }).cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].clientPostId?.endsWith(`:${clientMessageId}`)).toBe(true);

      expect(await send('ws-1', body)).toMatchObject({ status: 202, body: { state: 'queued', clientMessageId, replayed: true } });
      expect(writer.read('ws-1').cards).toHaveLength(1);
      // Reused: other text, or the same text to another conversation (or to Moa).
      expect(await send('ws-1', { ...body, text: 'something else' })).toMatchObject({ status: 409, body: { error: 'message-id-reused' } });
      expect(await send('ws-1', { ...body, threadId: GROUP.threadId })).toMatchObject({ status: 409, body: { error: 'message-id-reused' } });
      expect(await send('ws-hq', { ...body, threadId: `dm:${HQ.id}` })).toMatchObject({ status: 409, body: { error: 'message-id-reused' } });
      // An id spent on a chat send to a pane is reused too.
      expect(await send('ws-1', { ...body, clientMessageId: chatSpentId })).toMatchObject({ status: 409, body: { error: 'message-id-reused', clientMessageId: chatSpentId } });
      // The Moa receipt reads it.
      expect(await get(`/api/moa/messages/${clientMessageId}`)).toMatchObject({ status: 200, body: { clientMessageId, state: 'queued' } });
    });

    it('a group chat: one card, a wake for each bot that is on', async () => {
      const { send } = await start();
      const r = await send('ws-1', { clientMessageId: freshId(), text: 'standup', threadId: GROUP.threadId });
      expect(r).toMatchObject({ status: 202, body: { state: 'queued' } });
      expect(writer.read('ws-1', { threadId: GROUP.threadId }).cards).toMatchObject([{ kind: 'human', refs: { botId: LEAD.id, botIds: [LEAD.id] } }]);
      expect(queue.list({ states: ['queued'] }).map((i) => i.botId)).toEqual([LEAD.id]);
    });

    it('409 moa-busy with Retry-After while the factory starts: nothing posted, the id released', async () => {
      const { send } = await start();
      wakesUp = false;
      const body = { clientMessageId: freshId(), text: 'hello', threadId: `dm:${LEAD.id}` };
      const busy = await send('ws-1', body);
      expect(busy).toMatchObject({ status: 409, body: { error: 'moa-busy', state: 'failed' } });
      expect(busy.retryAfter).toBe('5');
      wakesUp = true;
      expect(await send('ws-1', body)).toMatchObject({ status: 202, body: { state: 'queued', replayed: false } });
    });

    it('a full queue after the card is up: 409 moa-busy, then the id stays that card\'s (other text or thread is reused)', async () => {
      const { send } = await start();
      queueFull = true;
      const body = { clientMessageId: freshId(), text: 'first words', threadId: `dm:${LEAD.id}` };
      const busy = await send('ws-1', body);
      expect(busy).toMatchObject({ status: 409, body: { error: 'moa-busy' } });
      expect(busy.retryAfter).toBe('5');
      queueFull = false;
      expect(await send('ws-1', { ...body, text: 'other words' })).toMatchObject({ status: 409, body: { error: 'message-id-reused' } });
      expect(await send('ws-1', { ...body, threadId: GROUP.threadId })).toMatchObject({ status: 409, body: { error: 'message-id-reused' } });
      expect(queue.list({ states: ['queued'] })).toEqual([]);
      expect(writer.read('ws-1').cards).toHaveLength(1);
    });

    it('409 no-recipient before anything is posted: a switched-off or missing bot, a missing group, a group with no bot on; final for the id', async () => {
      const { send } = await start();
      const cases: Array<[string, string, string]> = [
        ['ws-1', `dm:${OFF.id}`, 'bot-off'],
        ['ws-1', 'dm:bot-9999ffff', 'bot-missing'],
        ['ws-2', `dm:${LEAD.id}`, 'bot-missing'],
        ['ws-1', 'group:grp-00000000', 'group-missing'],
        ['ws-2', 'general', 'group-missing'],
        ['ws-1', 'general', 'group-off'],
      ];
      for (const [ws, threadId, reason] of cases) {
        const body = { clientMessageId: freshId(), text: 'hi', threadId };
        expect(await send(ws, body)).toMatchObject({ status: 409, body: { error: 'no-recipient', reason, state: 'failed' } });
        expect(await send(ws, body)).toMatchObject({ status: 409, body: { error: 'no-recipient', reason, replayed: true } });
      }
      expect(writer.read('ws-1').cards).toEqual([]);
      expect(writer.read('ws-2').cards).toEqual([]);
      expect(queue.list({ states: ['queued'] })).toEqual([]);
    });

    it('a desktop that changes while the receipt is written is never sent the target; the id is released', async () => {
      const caps = new Set(['moa.wake', 'factory.threadMessage']);
      const request = vi.fn(async () => ({ ok: true, accepted: true, queued: true }));
      const desktop = { available: true, supports: (c: string) => caps.has(c), request };
      const store = new AnswerReceiptStore(dir, Date.now, undefined, 'phone-moa-wake-receipts.json');
      const begin = store.begin.bind(store);
      // An older desktop takes over while the receipt is written.
      vi.spyOn(store, 'begin').mockImplementationOnce(async (...args) => { caps.delete('factory.threadMessage'); return begin(...args); });
      const wake = new MoaWakeService({ receipts: () => store, desktop: () => desktop as never });
      const input = { owner: 'device:d1', clientMessageId: freshId(), text: 'hi', target: { workspaceId: 'ws-1', threadId: `dm:${LEAD.id}` } };
      expect(await wake.roomMessage(input)).toMatchObject({ status: 503, body: { error: 'desktop-unavailable' } });
      expect(request).not.toHaveBeenCalled();
      caps.add('factory.threadMessage');
      expect(await wake.roomMessage(input)).toMatchObject({ status: 202, body: { state: 'queued', replayed: false } });
    });

    it('409 factory-off with the factory switched off; the id is released', async () => {
      const { send } = await start();
      enabled = false;
      const body = { clientMessageId: freshId(), text: 'hi', threadId: `dm:${LEAD.id}` };
      expect(await send('ws-1', body)).toMatchObject({ status: 409, body: { error: 'factory-off', state: 'failed' } });
      enabled = true;
      expect(await send('ws-1', body)).toMatchObject({ status: 202, body: { state: 'queued' } });
    });

    it('a body that fails the rules is 400 before anything is sent; a thread that is no conversation too', async () => {
      const { send } = await start();
      const ok = { clientMessageId: freshId(), text: 'hi', threadId: `dm:${LEAD.id}` };
      for (const [body, detail] of [
        [{ ...ok, extra: 1 }, 'unknown field: extra'],
        [{ ...ok, clientMessageId: 'x' }, 'clientMessageId'],
        [{ ...ok, text: '  ' }, 'text'],
        [{ ...ok, threadId: 'pr:github.com/o/r#1' }, 'threadId'],
        [{ ...ok, threadId: undefined }, 'threadId'],
      ] as const) {
        expect(await send('ws-1', body)).toMatchObject({ status: 400, body: { error: 'invalid-chat-request', detail } });
      }
      expect(await send('ws-1', { ...ok, text: 'x'.repeat(16_001) })).toMatchObject({ status: 400, body: { error: 'text-too-long' } });
      expect(await send('not a room', ok)).toMatchObject({ status: 404, body: { error: 'room-not-found' } });
      expect(toMain.some((m) => m.command === 'moa.wake')).toBe(false);
    });

    it('gates: transcript and input, like POST /api/moa/messages; never sent to a desktop that would ignore the target', async () => {
      let s = await start();
      const body = () => ({ clientMessageId: freshId(), text: 'hi', threadId: `dm:${LEAD.id}` });
      expect((await s.send('ws-1', body(), 'Bearer d3.s3')).status).toBe(403);
      await server!.stop();
      s = await start({ allowTranscript: false });
      expect(await s.send('ws-1', body())).toMatchObject({ status: 403, body: { error: expect.stringMatching(/^transcript-disabled/) } });
      await server!.stop();
      s = await start({ announce: ['moa.wake', 'factory.message', 'workspaces.bots'] });
      expect(await s.send('ws-1', body())).toMatchObject({ status: 503, body: { error: 'desktop-unavailable' } });
      expect(toMain.some((m) => m.command === 'moa.wake')).toBe(false);
    });
  });
});
