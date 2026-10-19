import { describe, it, expect, afterEach, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { MoaWakeService } from '../../phone/MoaWakeService';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { RoomWriter } from '../../../main/factory/roomWriter';
import { handlePhoneRoomCommand, withPhoneFactory, type PhoneFactoryPorts } from '../../../main/phone/PhoneFactory';
import { handlePhoneBotApprovalCommand } from '../../../main/phone/PhoneBotApprovals';
import { parsePhoneSidebarSnapshot } from '../../../shared/phoneFleetSidebar';
import { PHONE_ROOM_LIMITS } from '../../../shared/phoneRooms';
import type { BotProfile, BotStatus } from '../../../shared/bot';
import type { Handoff } from '../../../shared/handoff';

/**
 * The agent factory on the phone contract, end to end over the real server and
 * the real desktop bridge: main's side is the real PhoneFactory (overlay and
 * room commands) over a real RoomWriter and fake bot / settings / handoff ports.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp8-rooms-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const bot = (over: Partial<BotProfile>): BotProfile => ({
  version: 1, id: 'bot-0000aaaa', workspaceId: 'ws-hq', role: 'moa', name: 'Moa',
  engine: { kind: 'claude-sdk' }, triggers: [], enabled: true, createdAt: 1, updatedAt: 1,
  budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 0, maxWorkerHoursPerDay: 0, turnTimeoutMs: 1 },
  ...over,
} as BotProfile);

const APPROVAL = {
  requestId: 'apr-aaaaaaaa1', action: 'merge', workspaceId: 'ws-1', threadId: 'general', botId: 'bot-1111bbbb',
  repoKey: 'github.com/o/r', prNumber: 3, reason: 'ready', tainted: false, state: 'pending', createdAt: 1, updatedAt: 1,
};

const legacySidebar = {
  activeWorkspaceId: 'ws-1',
  workspaces: [{ id: 'ws-1', order: 0, pinned: false }, { id: 'ws-hq', order: 1, pinned: false }],
  panes: [{ ptyId: 's1', workspaceId: 'ws-1' }],
  hqWorkspaceId: 'ws-hq',
};

describe('factory phone routes', () => {
  let server: WebTerminalServer | undefined;
  let writer: RoomWriter;
  let enabled: boolean;
  let bots: BotProfile[] | null;
  let roomsUp: boolean;
  let handoffs: Handoff[];
  let legacyMoa: boolean;
  let roomDir: string;
  let approvals: { get: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    roomDir = fs.mkdtempSync(path.join(tmp, 'rooms-'));
    writer = new RoomWriter({ dir: roomDir, log: () => undefined });
    enabled = true;
    bots = [bot({}), bot({ id: 'bot-1111bbbb', workspaceId: 'ws-1', role: 'lead', name: 'Lead', createdAt: 2 })];
    roomsUp = true;
    handoffs = [];
    legacyMoa = false;
    approvals = { get: vi.fn(() => APPROVAL), decide: vi.fn(() => ({ ok: true, request: { ...APPROVAL, state: 'denied', decidedBy: 'owner', decidedAt: 2 } })) };
  });
  afterEach(async () => { if (server?.isRunning) await server.stop(); server = undefined; });

  const ports = (): PhoneFactoryPorts => ({
    settings: () => ({ enabled, hqWorkspaceId: 'ws-hq' }),
    bots: () => bots,
    status: (id): BotStatus | null => (id === 'bot-0000aaaa'
      ? { botId: id, presence: 'idle', sessionId: 'sess-hq', queueDepth: 0, budgetLeft: { turnsHour: 1, turnsDay: 1, workerHoursDay: 0 } }
      : { botId: id, presence: 'running', queueDepth: 2, budgetLeft: { turnsHour: 1, turnsDay: 1, workerHoursDay: 0 } }),
    rooms: () => (roomsUp ? writer : null),
    handoffs: () => handoffs,
    roomFileExists: (ws) => fs.existsSync(path.join(roomDir, `${ws}.jsonl`)),
    roomReadable: () => true,
    now: () => Date.now(),
  });

  async function start(opts: { allowTranscript?: boolean; allowInput?: boolean; desktop?: boolean; announce?: string[] } = {}) {
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      queueMicrotask(() => {
        let result: unknown;
        if (data.command === 'workspaces.list') {
          const parsed = parsePhoneSidebarSnapshot({ ...legacySidebar, ...(legacyMoa ? { moa: true } : {}) })!;
          result = { workspaces: [], sidebar: withPhoneFactory(parsed, ports()) };
        } else if (data.command.startsWith('workspaces.botApproval')) {
          result = handlePhoneBotApprovalCommand(data.command, data.payload, () => approvals as never);
        } else {
          result = handlePhoneRoomCommand(data.command, data.payload, ports());
        }
        bridge.complete(clientId, { requestId: data.requestId, ok: true, result });
      });
      return true;
    }, 500);
    if (opts.desktop !== false) {
      bridge.register('main', opts.announce ?? ['moa.wake', 'factory.message', 'workspaces.roomThreads', 'workspaces.roomCards']);
    }
    // d1: input granted explicitly; d2: paired before grants existed (may
    // type, grant never set); d3: no input grant; d4: revoked; d5: revoked
    // while its request is read (every credential check after the first).
    const roster: Record<string, { allowInput: boolean; explicit: boolean }> = {
      d1: { allowInput: true, explicit: true },
      d2: { allowInput: true, explicit: false },
      d3: { allowInput: false, explicit: false },
      d5: { allowInput: true, explicit: true },
    };
    let d5Checks = 0;
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        if (deviceId === 'd4' || (deviceId === 'd5' && d5Checks++ > 0)) return { ok: false, reason: 'revoked' };
        const d = roster[deviceId];
        return d && secret === `s${deviceId.slice(1)}` ? { ok: true, deviceId, allowInput: d.allowInput } : { ok: false, reason: 'unknown' };
      },
      list: () => [{ deviceId: 'd1', name: 'd1', createdAt: 0, lastSeenAt: 0, allowInput: true }],
      hasExplicitInputGrant: (deviceId) => roster[deviceId]?.explicit === true && deviceId !== 'd4',
    };
    const live = [{ id: 's1', cwd: '/x', cols: 80, rows: 24, state: 'detached', env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'One' }, cmd: '/bin/zsh' }];
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => live,
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager, devices, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir(),
      moaWake: () => ({}) as MoaWakeService,
      moaPane: () => null,
    });
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: opts.allowInput ?? true, allowUpload: false, allowTranscript: opts.allowTranscript ?? true });
    const get = async (route: string, auth = 'Bearer d1.s1', caps?: string) => {
      const res = await fetch(`http://127.0.0.1:${server!.status().port}${route}`, { headers: { Authorization: auth, ...(caps !== undefined ? { 'X-Wmux-Client-Caps': caps } : {}) } });
      return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get('cache-control') };
    };
    const post = async (route: string, body: unknown, auth = 'Bearer d1.s1') => {
      const res = await fetch(`http://127.0.0.1:${server!.status().port}${route}`, {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get('cache-control') };
    };
    return { get, post, bridge, operator: `Bearer ${info.token as string}` };
  }

  describe('/api/config', () => {
    it('factory on, a rooms-v1 client: factory block, moa from the HQ bot, moaWake, rooms; never a moaSessionId', async () => {
      const { get } = await start();
      const body = (await get('/api/config', 'Bearer d1.s1', 'decision-v2, Rooms-V1')).body;
      expect(body.factory).toEqual({ enabled: true, hqBotId: 'bot-0000aaaa', hqWorkspaceId: 'ws-hq', hqSessionId: 'sess-hq' });
      expect(body).toMatchObject({ moa: true, moaWake: true, rooms: true });
      expect(body).not.toHaveProperty('moaSessionId');
      expect(body).not.toHaveProperty('moaWakeBlocked');
    });

    it('factory on, a client without rooms-v1 (the shipped app): moa with needs-app-update, never moaWake', async () => {
      const { get } = await start();
      for (const caps of [undefined, 'decision-v2, chat-queue', 'rooms-v2']) {
        const body = (await get('/api/config', 'Bearer d1.s1', caps)).body;
        expect(body).toMatchObject({ moa: true, moaWakeBlocked: 'needs-app-update', rooms: true });
        expect(body).not.toHaveProperty('moaWake');
        expect(body).not.toHaveProperty('moaSessionId');
      }
    });

    it('the first snapshot that says the factory is on re-sends the moa event (no pane named); a legacy one does not', async () => {
      const { get } = await start();
      const emit = vi.spyOn(server!, 'emitMoaChanged');
      await get('/api/config');
      expect(emit).toHaveBeenCalledTimes(1);
      await server!.stop();
      enabled = false;
      legacyMoa = true;
      const legacy = await start();
      const emitLegacy = vi.spyOn(server!, 'emitMoaChanged');
      await legacy.get('/api/config');
      expect(emitLegacy).not.toHaveBeenCalled();
    });

    it('factory on with no enabled HQ bot: no moa, moaWakeBlocked no-hq-bot', async () => {
      bots = [bot({ enabled: false })];
      const body = (await (await start()).get('/api/config', 'Bearer d1.s1', 'rooms-v1')).body;
      expect(body.factory).toEqual({ enabled: true });
      expect(body).not.toHaveProperty('moa');
      expect(body.moaWakeBlocked).toBe('no-hq-bot');
      expect(body).not.toHaveProperty('moaWake');
    });

    it('factory off: legacy Moa keys stand; with no legacy Moa, moaWakeBlocked factory-off', async () => {
      enabled = false;
      legacyMoa = true;
      let body = (await (await start()).get('/api/config')).body;
      expect(body).toMatchObject({ factory: { enabled: false }, moa: true, moaWake: true });
      await server!.stop();
      legacyMoa = false;
      body = (await (await start()).get('/api/config')).body;
      expect(body).toMatchObject({ factory: { enabled: false }, moaWakeBlocked: 'factory-off' });
      expect(body).not.toHaveProperty('moa');
    });

    it('a desktop whose factory has not started serves no factory keys at all', async () => {
      bots = null;
      legacyMoa = true;
      const body = (await (await start()).get('/api/config')).body;
      expect(body).not.toHaveProperty('factory');
      expect(body).toMatchObject({ moa: true, moaWake: true });
    });

    it('rooms is omitted without --allow-transcript or without the announced commands', async () => {
      expect((await (await start({ allowTranscript: false })).get('/api/config')).body).not.toHaveProperty('rooms');
      await server!.stop();
      expect((await (await start({ announce: ['moa.wake', 'factory.message'] })).get('/api/config')).body).not.toHaveProperty('rooms');
    });
  });

  it('/api/workspaces: bots and openQuestions per workspace, delegations from dispatch handoffs', async () => {
    writer.append({ workspaceId: 'ws-1', threadId: 'handoff:h-1', kind: 'question', actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-1111bbbb' }, title: 'Which branch?', state: 'open' });
    handoffs = [{
      version: 1, id: 'h-1', runId: 'r', threadId: 'handoff:h-1', depth: 1, hopsInRun: 1,
      from: { kind: 'bot', workspaceId: 'ws-hq', botId: 'bot-0000aaaa' }, to: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-1111bbbb' },
      kind: 'dispatch', attribution: { originator: { kind: 'human' }, chain: [] }, landing: 'room',
      payload: { title: 'Fix the flaky test', body: '' }, status: 'delivered', createdAt: 1, updatedAt: Date.now(),
    }];
    const { get } = await start();
    const body = (await get('/api/workspaces')).body as { workspaces: Array<Record<string, unknown>>; moaDelegations: unknown[] };
    expect(body.workspaces[0]).toMatchObject({ id: 'ws-1', bots: [{ id: 'bot-1111bbbb', role: 'lead', presence: 'running', queueDepth: 2 }], openQuestions: 1 });
    expect(body.moaDelegations).toEqual([expect.objectContaining({ taskId: 'h-1', workspaceId: 'ws-1', agentName: 'Lead', title: 'Fix the flaky test', state: 'blocked' })]);
  });

  describe('/api/rooms', () => {
    const post = (n: number, threadId: 'general' | 'task:t1' = 'general', body?: string) => {
      for (let i = 0; i < n; i++) writer.append({ workspaceId: 'ws-1', threadId, kind: 'status', actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-1111bbbb' }, title: `s${i}`, ...(body ? { body } : {}) });
    };

    it('threads and cards answer with the allowlisted shapes, no-store', async () => {
      post(2);
      post(1, 'task:t1');
      const { get } = await start();
      const threads = await get('/api/rooms/ws-1/threads');
      expect(threads).toMatchObject({ status: 200, cache: 'no-store', body: { workspaceId: 'ws-1' } });
      expect((threads.body.threads as Array<{ threadId: string }>).map((t) => t.threadId).sort()).toEqual(['general', 'task:t1']);
      const cards = await get('/api/rooms/ws-1/cards?thread=task%3At1');
      expect(cards.status).toBe(200);
      expect(cards.body).toMatchObject({ workspaceId: 'ws-1', threadId: 'task:t1', hasMore: false });
      const [card] = cards.body.cards as Array<Record<string, unknown>>;
      expect(card).toMatchObject({ threadId: 'task:t1', kind: 'status', actor: { kind: 'bot', botId: 'bot-1111bbbb', role: 'lead', name: 'Lead' } });
      expect(card).not.toHaveProperty('workspaceId');
      expect(card).not.toHaveProperty('clientPostId');
    });

    it('a bot\'s reply carries replyTo: the owner card it answers', async () => {
      const owner = writer.post({ workspaceId: 'ws-1', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: 'status?' });
      if (!owner.ok) throw new Error('post failed');
      writer.post({ workspaceId: 'ws-1', threadId: 'general', kind: 'status', actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-1111bbbb' }, title: 'green', replyTo: owner.card.id });
      const { get } = await start();
      const cards = (await get('/api/rooms/ws-1/cards?thread=general')).body.cards as Array<Record<string, unknown>>;
      expect(cards.map((c) => [c.kind, c.replyTo])).toEqual([['human', undefined], ['status', owner.card.id]]);
    });

    it('pages forward by seq and stays under the bridge budget with large bodies', async () => {
      post(30, 'general', 'y'.repeat(8000));
      const { get } = await start();
      const first = await get('/api/rooms/ws-1/cards?sinceSeq=0&limit=100');
      expect(first.status).toBe(200);
      const page = first.body as { cards: Array<{ seq: number }>; nextSinceSeq: number; hasMore: boolean };
      expect(page.hasMore).toBe(true);
      expect(page.cards.length).toBeLessThan(30);
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(PHONE_ROOM_LIMITS.replyBytes);
      const seen = [...page.cards.map((c) => c.seq)];
      let next = page.nextSinceSeq;
      for (let i = 0; i < 10; i++) {
        const more = (await get(`/api/rooms/ws-1/cards?sinceSeq=${next}&limit=100`)).body as typeof page;
        seen.push(...more.cards.map((c) => c.seq));
        next = more.nextSinceSeq;
        if (!more.hasMore) break;
      }
      expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      const limited = (await get('/api/rooms/ws-1/cards?sinceSeq=0&limit=2')).body as typeof page;
      expect(limited.cards.map((c) => c.seq)).toEqual([1, 2]);
      expect(limited.hasMore).toBe(true);
    });

    it('refuses bad requests and unknown rooms', async () => {
      const { get } = await start();
      expect((await get('/api/rooms/ws-1/cards?limit=0')).status).toBe(400);
      expect((await get('/api/rooms/ws-1/cards?limit=101')).status).toBe(400);
      expect((await get('/api/rooms/ws-1/cards?sinceSeq=-1')).status).toBe(400);
      expect((await get('/api/rooms/ws-1/cards?thread=nope')).status).toBe(400);
      expect((await get('/api/rooms/..%2Fx/threads')).body).toEqual({ error: 'room-not-found' });
      // No bot, not the HQ, no room on disk: main never loads a room for it.
      expect((await get('/api/rooms/ws-nobody/threads'))).toMatchObject({ status: 404, body: { error: 'room-not-found' } });
    });

    it('403 without --allow-transcript before asking the desktop; 401 without auth', async () => {
      const { get } = await start({ allowTranscript: false });
      expect(await get('/api/rooms/ws-1/threads')).toMatchObject({ status: 403, body: { error: 'transcript-disabled' } });
      expect((await get('/api/rooms/ws-1/threads', 'Bearer d1.wrong')).status).toBe(401);
    });

    it('fails closed: no desktop, a desktop without the commands, a factory not started, a disconnect', async () => {
      let r = await start({ desktop: false });
      expect(await r.get('/api/rooms/ws-1/threads')).toMatchObject({ status: 503, body: { error: 'desktop-unavailable' } });
      await server!.stop();
      r = await start({ announce: ['moa.wake'] });
      expect(await r.get('/api/rooms/ws-1/cards')).toMatchObject({ status: 503, body: { error: 'rooms-unavailable' } });
      await server!.stop();
      roomsUp = false;
      r = await start();
      expect(await r.get('/api/rooms/ws-1/cards')).toMatchObject({ status: 503, body: { error: 'rooms-unavailable' } });
      r.bridge.disconnect('main');
      expect(await r.get('/api/rooms/ws-1/threads')).toMatchObject({ status: 503, body: { error: 'desktop-unavailable' } });
    });
  });

  describe('/api/bot-approvals', () => {
    const APPROVAL_COMMANDS = ['workspaces.botApproval', 'workspaces.botApprovalDecide'];
    const route = '/api/bot-approvals/apr-aaaaaaaa1';
    const decide = (r: { post: (route: string, body: unknown, auth?: string) => Promise<{ status: number; body: Record<string, unknown> }> }, auth?: string) =>
      r.post(`${route}/decision`, { decision: 'deny' }, auth);

    it('/api/config announces the routes to the operator and to a device', async () => {
      const r = await start({ announce: APPROVAL_COMMANDS });
      expect((await r.get('/api/config', r.operator)).body.botApprovals).toBe(true);
      expect((await r.get('/api/config')).body.botApprovals).toBe(true);
      await server!.stop();
      const without = await start();
      expect((await without.get('/api/config')).body).not.toHaveProperty('botApprovals');
    });

    it('every paired device reads; the operator and an explicitly granted device decide', async () => {
      const r = await start({ announce: APPROVAL_COMMANDS });
      for (const auth of [r.operator, 'Bearer d1.s1', 'Bearer d2.s2', 'Bearer d3.s3']) {
        expect(await r.get(route, auth)).toMatchObject({ status: 200, cache: 'no-store', body: { request: { requestId: 'apr-aaaaaaaa1', state: 'pending' } } });
      }
      expect(await decide(r, r.operator)).toMatchObject({ status: 200, body: { request: { state: 'denied', decidedBy: 'owner' } } });
      expect(approvals.decide).toHaveBeenLastCalledWith({ requestId: 'apr-aaaaaaaa1', decision: 'deny' }, 'phone', undefined);
      expect(await decide(r, 'Bearer d1.s1')).toMatchObject({ status: 200, body: { request: { state: 'denied' } } });
      // Main records the device that decided.
      expect(approvals.decide).toHaveBeenLastCalledWith({ requestId: 'apr-aaaaaaaa1', decision: 'deny' }, 'phone', 'd1');
    });

    it('refuses a legacy grant, no grant, a revoked device and a device revoked mid-request', async () => {
      const r = await start({ announce: APPROVAL_COMMANDS });
      expect(await decide(r, 'Bearer d2.s2')).toMatchObject({ status: 403, body: { error: 'read-only: this device has no explicit input grant' } });
      expect(await decide(r, 'Bearer d3.s3')).toMatchObject({ status: 403, body: { error: 'read-only: this device was paired without permission to type' } });
      expect(await decide(r, 'Bearer d4.s4')).toMatchObject({ status: 401, body: { error: 'unauthorized', reason: 'revoked' } });
      expect((await r.get(route, 'Bearer d4.s4')).status).toBe(401);
      expect(await decide(r, 'Bearer d5.s5')).toMatchObject({ status: 401, body: { error: 'authorization-expired' } });
      expect(approvals.decide).not.toHaveBeenCalled();
    });

    it('a read-only server answers reads and refuses every decision', async () => {
      const r = await start({ announce: APPROVAL_COMMANDS, allowInput: false });
      expect((await r.get(route)).status).toBe(200);
      expect(await decide(r, r.operator)).toMatchObject({ status: 403, body: { error: 'read-only' } });
      expect(await decide(r, 'Bearer d1.s1')).toMatchObject({ status: 403, body: { error: 'read-only' } });
      expect(approvals.decide).not.toHaveBeenCalled();
    });
  });
});
