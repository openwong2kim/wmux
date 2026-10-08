import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver, type WebTerminalStartOptions } from '../WebTerminalServer';
import type { TranscriptProjector } from '../../transcript/TranscriptProjector';
import type { TranscriptPage, TranscriptStatus } from '../../../shared/transcript/turnEvents';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { ChatBridge, ChatResolution, ChatSendOutcome, ChatSendRequest } from '../../chat/chatBridge';
import type { MoaPaneFact } from '../moaPane';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { AnswerReceiptStore } from '../../approvals/AnswerReceiptStore';
import { MoaWakeService } from '../../phone/MoaWakeService';
import { createMoaWakeHandler, type MoaWakeReport } from '../../../main/deck/moaWake';
import type { MoaWakeRefusalCode, MoaWakeResult } from '../../../shared/moaWake';
import type { CommanderSendResult } from '../../../main/deck/CommanderSessionManager';

/**
 * `POST/GET /api/moa/messages`: the phone's message to Moa before its brain
 * runs. The daemon side is real (routes, MoaWakeService, its receipt file,
 * the desktop bridge); main is the real wake handler over fake deck ports.
 */

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moawake-home-'));
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => { process.env.HOME = isolatedHome; process.env.USERPROFILE = isolatedHome; });
afterAll(() => {
  process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

function mkPane(id: string, env: Record<string, string> = {}) {
  return {
    meta: { id, incarnationId: `${id}-inc-1`, env, spawnCwd: isolatedHome, cwd: isolatedHome, state: 'detached', cols: 80, rows: 24 },
    ptyProcess: { write: vi.fn() },
    bridge: new EventEmitter(),
    ringBuffer: { readAll: () => Buffer.from(''), totalBytesWritten: 0 },
  };
}

const HQ: MoaPaneFact = { sessionId: 'brain-hq', workspaceId: 'ws-hq' };
const status = (): TranscriptStatus => ({
  available: true, reason: 'ok', transcriptBasename: 'conv-a.jsonl', agentSessionId: 'sess-a', agentStatus: 'idle', agentAlive: true,
  terminal: { kind: 'terminal', agent: 'claude', nativeSessionId: 'sess-a', capabilities: { history: true, send: true, permissions: false, cancel: true, fileUndo: false } },
});
const freshId = () => `${Date.now()}-${crypto.randomUUID()}`;

describe('POST/GET /api/moa/messages', () => {
  let server: WebTerminalServer;
  let moa: MoaPaneFact | null;
  let roster: Map<string, { secret: string; allowInput: boolean }>;
  let chat: ChatBridge & { send: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> };
  let bridge: DesktopPhoneBridge;
  let wakeService: MoaWakeService;
  let dir: string;
  // Main: the real wake handler over a fake deck.
  let refuse: MoaWakeRefusalCode | null;
  let brainBusy: boolean;
  let turns: string[];
  let turnDone: Array<(v: CommanderSendResult) => void>;
  let reports: MoaWakeReport[];
  /** 'answer' = main answers; 'silent' = main never answers (timeout); 'fail-first' = its failure report lands before its accept. */
  let mainMode: 'answer' | 'silent' | 'fail-first';
  let requests: number;
  let audits: Array<{ deviceId: string; route: string }>;
  let logs: string[];

  beforeEach(() => {
    moa = null;
    roster = new Map();
    refuse = null;
    brainBusy = false;
    turns = [];
    turnDone = [];
    reports = [];
    mainMode = 'answer';
    requests = 0;
    audits = [];
    logs = [];
    dir = fs.mkdtempSync(path.join(isolatedHome, 'wmux-dir-'));
    const handler = createMoaWakeHandler({
      refuse: () => refuse,
      hqWorkspaceId: () => 'ws-hq',
      vendor: () => 'claude-pty',
      idle: () => !brainBusy,
      run: (_ws, text) => {
        // The manager flips to busy synchronously inside send.
        brainBusy = true;
        turns.push(text);
        return new Promise<CommanderSendResult>((resolve) => turnDone.push((v) => { brainBusy = false; resolve(v); }));
      },
    });
    bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; payload: Record<string, unknown> } }).data;
      requests++;
      if (mainMode === 'silent') return true;
      // Main handles each request as it arrives, like installPhoneBridge.
      queueMicrotask(() => {
        const p = data.payload as { clientMessageId: string; text: string; actor: string };
        const result: MoaWakeResult = handler(p, (r) => reports.push(r));
        // Both lines in one pipe read: the report is handled before the accept's continuation runs.
        if (mainMode === 'fail-first') void wakeService.recordFailure(p.actor, p.clientMessageId, 'spawn-failed');
        bridge.complete(clientId, { requestId: data.requestId, ok: true, result });
      });
      return true;
    }, 200);
    bridge.register('main', ['moa.wake']);
    // One store per service, like the daemon's lazy getter.
    const store = new AnswerReceiptStore(dir, Date.now, undefined, 'phone-moa-wake-receipts.json');
    wakeService = new MoaWakeService({ receipts: () => store, desktop: () => bridge });
    const resolution: ChatResolution = { source: 'file', status: status() };
    chat = {
      resolve: vi.fn(async () => resolution),
      managedSnapshot: vi.fn(() => null),
      turn: vi.fn(() => undefined),
      blocked: vi.fn(async () => undefined),
      send: vi.fn(async (req: ChatSendRequest): Promise<ChatSendOutcome> => {
        if (req.authorized && !(await req.authorized('first-write'))) {
          return { clientMessageId: req.clientMessageId, replayed: false, error: 'authorization-expired', result: 'error', effect: 'none' };
        }
        if (req.authorized && !(await req.authorized('submit'))) {
          return { clientMessageId: req.clientMessageId, replayed: false, error: 'authorization-expired', result: 'error', effect: 'uncertain' };
        }
        return { clientMessageId: req.clientMessageId, replayed: false, result: 'sent', effect: 'submitted' };
      }),
      cancel: vi.fn(),
      receipt: vi.fn((_o, _id, cmid: string) => ({ clientMessageId: cmid, state: 'unknown' as const })),
      launch: vi.fn(),
      skills: vi.fn(async () => ({ state: 'ready' as const, skills: [] })),
      watch: vi.fn(),
      unwatch: vi.fn(),
      traceDangerousLaunch: vi.fn(),
    } as unknown as typeof chat;
    const panes = new Map([['brain-hq', mkPane('brain-hq', { WMUX_BRAIN_PTY: '1', WMUX_WORKSPACE_ID: 'ws-hq' })]]);
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        const rec = roster.get(deviceId);
        if (!rec || rec.secret !== secret) return { ok: false, reason: 'unknown' };
        return { ok: true, deviceId, allowInput: rec.allowInput };
      },
      list: () => [...roster].map(([deviceId, rec]) => ({ deviceId, name: deviceId, createdAt: 0, lastSeenAt: 0, allowInput: rec.allowInput })),
    };
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: (id: string) => panes.get(id),
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      devices,
      projector: () => ({
        status: vi.fn(() => status()),
        transcriptPath: vi.fn(() => null),
        snapshot: vi.fn((): TranscriptPage => ({
          events: [{ id: 'u1', kind: 'user_text', text: 'wake up Moa', ts: Date.now() + 1000 }] as unknown as TranscriptPage['events'],
          cursor: { headOffset: 0, tailOffset: 10, fileSize: 10, mtimeMs: 1 },
          hasMore: false,
          truncatedHead: false,
        })),
        delta: vi.fn(() => null),
        staleCursor: vi.fn(() => false),
      }) as unknown as TranscriptProjector,
      chat: () => chat,
      moaPane: () => moa,
      moaWake: () => wakeService,
      desktop: () => bridge,
      auditMoaSend: (entry) => { audits.push({ deviceId: entry.deviceId, route: entry.route }); },
      log: (_level, message) => { logs.push(message); },
      assetsDir: os.tmpdir(),
    });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
  });

  const start = (over: Partial<WebTerminalStartOptions> = {}) =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true, ...over });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const device = (id: string, allowInput = true) => {
    roster.set(id, { secret: `secret-${id}`, allowInput });
    return { Authorization: `Bearer ${id}.secret-${id}` };
  };
  const post = async (h: Record<string, string>, body: unknown) => {
    const r = await fetch(`${base()}/api/moa/messages`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown>, retryAfter: r.headers.get('retry-after') };
  };
  const receipt = async (h: Record<string, string>, id: string) => {
    const r = await fetch(`${base()}/api/moa/messages/${id}`, { headers: h });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('wakes Moa with the first message, answers accepted on accept, and replays the same id without a second turn', async () => {
    await start();
    const h = device('d1');
    const id = freshId();
    const first = await post(h, { clientMessageId: id, text: 'wake up Moa' });
    expect(first).toMatchObject({ status: 202, body: { state: 'accepted', replayed: false, clientMessageId: id } });
    expect(turns).toEqual(['wake up Moa']);
    expect(audits).toEqual([{ deviceId: 'd1', route: 'wake' }]);
    expect(await receipt(h, id)).toEqual({ status: 200, body: { clientMessageId: id, state: 'accepted' } });
    // The brain is still starting: another message waits.
    const other = await post(h, { clientMessageId: freshId(), text: 'and another' });
    expect(other).toMatchObject({ status: 409, body: { error: 'moa-starting' }, retryAfter: '3' });
    // The pane publishes; a retry of the first id right after is a replay, not a chat send.
    moa = { ...HQ };
    server.emitMoaChanged();
    const retry = await post(h, { clientMessageId: id, text: 'wake up Moa' });
    expect(retry).toMatchObject({ status: 202, body: { state: 'accepted', replayed: true } });
    expect(turns).toHaveLength(1);
    expect(chat.send).not.toHaveBeenCalled();
    expect(requests).toBe(1);
    // The receipt names the pane as soon as it is up, and the wake's row in /turns carries its id.
    expect((await receipt(h, id)).body).toEqual({ clientMessageId: id, state: 'accepted', moaSessionId: 'brain-hq' });
    const page = await (await fetch(`${base()}/api/sessions/brain-hq/turns`, { headers: h })).json() as { events: Array<Record<string, unknown>> };
    expect(page.events.find((e) => e.kind === 'user_text')).toMatchObject({ clientMessageId: id });
    // Same id, other text: refused, never sent.
    expect(await post(h, { clientMessageId: id, text: 'something else' })).toMatchObject({ status: 409, body: { error: 'message-id-reused' } });
  });

  it('with the Moa pane up, a new id takes the chat send path with the same id', async () => {
    moa = { ...HQ };
    await start();
    const h = device('d1');
    const id = freshId();
    expect(await post(h, { clientMessageId: id, text: 'status?' })).toMatchObject({ status: 202, body: { result: 'sent', clientMessageId: id } });
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(chat.send.mock.calls[0][0]).toMatchObject({ id: 'brain-hq', clientMessageId: id, agentSessionId: 'sess-a', text: 'status?' });
    expect(requests).toBe(0);
  });

  it('two different ids racing: one turn starts, the other reads moa-busy (retryable, same id)', async () => {
    await start();
    const h = device('d1');
    const [a, b] = [freshId(), freshId()];
    const [ra, rb] = await Promise.all([
      post(h, { clientMessageId: a, text: 'first' }),
      post(h, { clientMessageId: b, text: 'second' }),
    ]);
    const statuses = [ra, rb].map((r) => r.status).sort();
    expect(statuses).toEqual([202, 409]);
    const busy = ra.status === 409 ? ra : rb;
    expect(busy).toMatchObject({ body: { error: 'moa-busy' }, retryAfter: '5' });
    expect(turns).toHaveLength(1);
    // Busy is released: the same id comes back once the brain is idle and the start is over.
    turnDone[0]({ ok: true });
    await settle();
    moa = { ...HQ };
    server.emitMoaChanged();
    moa = null;
    server.emitMoaChanged();
    const busyId = ra.status === 409 ? a : b;
    expect(await post(h, { clientMessageId: busyId, text: ra.status === 409 ? 'first' : 'second' })).toMatchObject({ status: 202, body: { state: 'accepted' } });
    expect(turns).toHaveLength(2);
  });

  it('a timeout after the request left is uncertain, and retrying the same id sends nothing', async () => {
    mainMode = 'silent';
    await start();
    const h = device('d1');
    const id = freshId();
    expect(await post(h, { clientMessageId: id, text: 'hello' })).toMatchObject({ status: 202, body: { state: 'uncertain' } });
    expect(requests).toBe(1);
    mainMode = 'answer';
    expect(await post(h, { clientMessageId: id, text: 'hello' })).toMatchObject({ status: 202, body: { state: 'uncertain', replayed: true } });
    expect(requests).toBe(1);
    expect(turns).toEqual([]);
    expect((await receipt(h, id)).body).toEqual({ clientMessageId: id, state: 'uncertain' });
  });

  it('maps every typed refusal to its own code', async () => {
    await start();
    const h = device('d1');
    const cases: Array<[MoaWakeRefusalCode, number, string, string | null]> = [
      ['moa_off', 409, 'moa-off', null],
      ['mode_off', 409, 'moa-mode-off', null],
      ['not_hq', 409, 'no-hq', null],
      ['hq_missing', 409, 'no-hq', null],
      ['hq_unknown', 409, 'no-hq', null],
      ['busy', 409, 'moa-busy', '5'],
      ['unsupported_vendor', 503, 'desktop-unavailable', null],
    ];
    const seen = new Set<string>();
    for (const [code, status, error, retryAfter] of cases) {
      refuse = code;
      const r = await post(h, { clientMessageId: freshId(), text: 'hi' });
      expect([code, r.status, r.body.error, r.retryAfter]).toEqual([code, status, error, retryAfter]);
      seen.add(`${r.body.error}:${String(r.body.reason ?? '')}`);
    }
    expect(seen.size).toBe(cases.length);
    expect(turns).toEqual([]);
  });

  it('without a desktop that announced moa.wake: 503 desktop-unavailable and nothing recorded', async () => {
    bridge.disconnect('main');
    await start();
    const h = device('d1');
    const id = freshId();
    expect(await post(h, { clientMessageId: id, text: 'hi' })).toMatchObject({ status: 503, body: { error: 'desktop-unavailable' } });
    expect(await receipt(h, id)).toMatchObject({ status: 404, body: { error: 'unknown-message' } });
  });

  it('a cold start stopped on a startup screen: the receipt fails tui-dialog and chat sends are blocked', async () => {
    await start();
    const h = device('d1');
    const id = freshId();
    expect(await post(h, { clientMessageId: id, text: 'wake' })).toMatchObject({ status: 202, body: { state: 'accepted' } });
    // Main publishes the pane stopped on its trust screen, then reports the failure.
    moa = { ...HQ, blockedOnTui: true };
    server.emitMoaChanged();
    expect(await wakeService.recordFailure('device:d1', id, 'tui-dialog')).toBe(true);
    expect((await receipt(h, id)).body).toEqual({ clientMessageId: id, state: 'failed', code: 'tui-dialog', moaSessionId: 'brain-hq' });
    const blocked = await fetch(`${base()}/api/sessions/brain-hq/chat/messages`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSessionId: 'sess-a', historyEpoch: 'h1:x', clientMessageId: freshId(), text: 'yes' }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: 'chat-blocked', blockedBy: 'terminal' });
    expect(await post(h, { clientMessageId: freshId(), text: 'yes' })).toMatchObject({ status: 409, body: { error: 'chat-blocked' } });
    // Live shape: the screen fired no hook, so there is no conversation either — still blocked, not starting.
    chat.resolve.mockResolvedValue({ source: 'none', status: { ...status(), available: false, reason: 'no-binding' }, launch: {} } as unknown as ChatResolution);
    expect(await post(h, { clientMessageId: freshId(), text: 'yes' })).toMatchObject({ status: 409, body: { error: 'chat-blocked' } });
    expect(chat.send).not.toHaveBeenCalled();
  });

  it('a failure reported before the accept was recorded still lands, and does not hold the start open', async () => {
    mainMode = 'fail-first';
    await start();
    const h = device('d1');
    const id = freshId();
    expect(await post(h, { clientMessageId: id, text: 'wake' }))
      .toMatchObject({ status: 409, body: { state: 'failed', error: 'moa-wake-failed', code: 'spawn-failed' } });
    expect((await receipt(h, id)).body).toEqual({ clientMessageId: id, state: 'failed', code: 'spawn-failed' });
    // No stuck "starting" window: the next id goes straight to main.
    turnDone[0]({ ok: true, code: 'errored' });
    await settle();
    mainMode = 'answer';
    expect(await post(h, { clientMessageId: freshId(), text: 'again' })).toMatchObject({ status: 202, body: { state: 'accepted' } });
  });

  it('same limits and gates as chat send; operators allowed and logged; unknown ids 404', async () => {
    await start();
    const h = device('d1');
    expect(await post(h, { clientMessageId: freshId(), text: 'x'.repeat(16_001) }))
      .toMatchObject({ status: 400, body: { error: 'text-too-long', limit: 'units' } });
    expect(await post(h, { clientMessageId: 'nope', text: 'hi' })).toMatchObject({ status: 400, body: { error: 'invalid-chat-request' } });
    expect(await post(h, { clientMessageId: freshId(), text: 'hi', extra: 1 })).toMatchObject({ status: 400 });
    expect((await post(device('ro', false), { clientMessageId: freshId(), text: 'hi' })).status).toBe(403);
    expect(await receipt(h, freshId())).toMatchObject({ status: 404, body: { error: 'unknown-message' } });
    expect(requests).toBe(0);
    const token = server.status().token as string;
    const op = await post({ Authorization: `Bearer ${token}` }, { clientMessageId: freshId(), text: 'from the desk' });
    expect(op).toMatchObject({ status: 202, body: { state: 'accepted' } });
    expect(logs.some((l) => l.includes('operator'))).toBe(true);
    expect(audits).toEqual([]);
  });

  it('without --allow-transcript both routes refuse', async () => {
    await start({ allowTranscript: false });
    const h = device('d1');
    expect((await post(h, { clientMessageId: freshId(), text: 'hi' })).status).toBe(403);
    expect((await receipt(h, freshId())).status).toBe(403);
  });
});
