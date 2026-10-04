import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer, type WebDeviceResolver, type WebTerminalStartOptions } from '../WebTerminalServer';
import type { TranscriptProjector } from '../../transcript/TranscriptProjector';
import type { TranscriptPage, TranscriptStatus } from '../../../shared/transcript/turnEvents';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { ChatBridge, ChatResolution, ChatSendOutcome, ChatSendRequest } from '../../chat/chatBridge';
import type { MoaPaneFact } from '../moaPane';

/**
 * The Moa (HQ brain) pane on the phone routes: which brain pane a paired
 * device may reach, through which routes, under which permissions, and that
 * withdrawing Moa closes it — including for a request already in flight.
 *
 * Panes: `s1` an ordinary pane; `brain-hq` the HQ's brain TUI; `brain-other`
 * another workspace's brain. `moa` is the fact main pushed (`daemon.moa.set`).
 */

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-home-'));
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => { process.env.HOME = isolatedHome; process.env.USERPROFILE = isolatedHome; });
afterAll(() => {
  process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

type Pane = {
  meta: { id: string; incarnationId: string; env: Record<string, string>; spawnCwd: string; cwd: string; state: string; cols: number; rows: number };
  ptyProcess: { write: ReturnType<typeof vi.fn> };
  bridge: EventEmitter;
  ringBuffer: { readAll: () => Buffer; totalBytesWritten: number };
};

function mkPane(id: string, env: Record<string, string> = {}): Pane {
  return {
    meta: { id, incarnationId: `${id}-inc-1`, env, spawnCwd: isolatedHome, cwd: isolatedHome, state: 'detached', cols: 80, rows: 24 },
    ptyProcess: { write: vi.fn() },
    bridge: new EventEmitter(),
    ringBuffer: { readAll: () => Buffer.from(''), totalBytesWritten: 0 },
  };
}

const HQ: MoaPaneFact = { sessionId: 'brain-hq', workspaceId: 'ws-hq' };

const page = (): TranscriptPage => ({
  events: [{ id: 'u1', kind: 'user_text', text: 'hello Moa' }] as unknown as TranscriptPage['events'],
  cursor: { headOffset: 0, tailOffset: 10, fileSize: 10, mtimeMs: 1 },
  hasMore: false,
  truncatedHead: false,
});

const status = (): TranscriptStatus => ({
  available: true, reason: 'ok', transcriptBasename: 'conv-a.jsonl', agentSessionId: 'sess-a', agentStatus: 'idle', agentAlive: true,
  terminal: { kind: 'terminal', agent: 'claude', nativeSessionId: 'sess-a', capabilities: { history: true, send: true, permissions: false, cancel: true, fileUndo: false } },
});

const freshId = () => `${Date.now()}-${crypto.randomUUID()}`;

describe('the Moa pane on the phone routes', () => {
  let server: WebTerminalServer;
  let panes: Map<string, Pane>;
  let roster: Map<string, { secret: string; allowInput: boolean }>;
  let moa: MoaPaneFact | null;
  let audits: Array<{ deviceId: string; sessionId: string; route: 'chat' | 'input' }>;
  let resolveGate: (() => Promise<void>) | null;
  let sendHook: ((req: ChatSendRequest) => Promise<void>) | null;
  let destroyed: string[];
  let chat: ChatBridge & { send: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    panes = new Map([
      ['s1', mkPane('s1', { WMUX_WORKSPACE_ID: 'ws-1' })],
      ['brain-hq', mkPane('brain-hq', { WMUX_BRAIN_PTY: '1', WMUX_WORKSPACE_ID: 'ws-hq' })],
      ['brain-other', mkPane('brain-other', { WMUX_BRAIN_PTY: '1', WMUX_WORKSPACE_ID: 'ws-2' })],
    ]);
    roster = new Map();
    moa = { ...HQ };
    audits = [];
    destroyed = [];
    resolveGate = null;
    sendHook = null;
    const resolution: ChatResolution = { source: 'file', status: status() };
    chat = {
      resolve: vi.fn(async () => { await resolveGate?.(); return resolution; }),
      managedSnapshot: vi.fn(() => null),
      turn: vi.fn(() => undefined),
      blocked: vi.fn(async () => undefined),
      send: vi.fn(async (req: ChatSendRequest): Promise<ChatSendOutcome> => {
        await sendHook?.(req);
        if (req.authorized && !(await req.authorized())) {
          return { clientMessageId: req.clientMessageId, replayed: false, error: 'authorization-expired', result: 'error', effect: 'none' };
        }
        return { clientMessageId: req.clientMessageId, replayed: false, result: 'sent', effect: 'submitted' };
      }),
      cancel: vi.fn(async (req) => {
        if (req.authorized && !(await req.authorized())) return { clientCancelId: req.clientCancelId, replayed: false, effect: 'none', error: 'authorization-expired' };
        return { clientCancelId: req.clientCancelId, replayed: false, effect: 'interrupt-requested', turnId: 't1:abc.3' };
      }),
      receipt: vi.fn((_o, _id, cmid: string) => ({ clientMessageId: cmid, state: 'unknown' as const })),
      launch: vi.fn(async () => ({ ok: true as const, effect: 'submitted' as const })),
      skills: vi.fn(async () => ({ state: 'ready' as const, skills: [] })),
      watch: vi.fn(),
      unwatch: vi.fn(),
      traceDangerousLaunch: vi.fn(),
    } as unknown as typeof chat;
    const projector = {
      status: vi.fn(() => status()),
      transcriptPath: vi.fn(() => null),
      snapshot: vi.fn(() => page()),
      delta: vi.fn(() => null),
      staleCursor: vi.fn(() => false),
    };
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
      projector: () => projector as unknown as TranscriptProjector,
      chat: () => chat,
      lifecycle: { create: async () => ({ id: 'new' }), destroy: async (id) => { destroyed.push(id); } },
      moaPane: () => moa,
      auditMoaSend: (entry) => { audits.push(entry); },
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
  });

  const start = (over: Partial<WebTerminalStartOptions> = {}) =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true, ...over });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const device = (id: string, allowInput = true) => {
    roster.set(id, { secret: `secret-${id}`, allowInput });
    return bearer(`${id}.secret-${id}`);
  };
  const postJson = (url: string, headers: Record<string, string>, body: unknown) =>
    fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const sendBody = () => ({ agentSessionId: 'sess-a', historyEpoch: 'h1:x', clientMessageId: freshId(), text: 'status of the fleet?' });
  const turnsStatus = async (h: Record<string, string>, id: string) => (await fetch(`${base()}/api/sessions/${id}/turns`, { headers: h })).status;
  const sendStatus = async (h: Record<string, string>, id: string) => (await postJson(`${base()}/api/sessions/${id}/chat/messages`, h, sendBody())).status;
  const inputStatus = async (h: Record<string, string>, id: string) =>
    (await fetch(`${base()}/api/input?session=${id}`, { method: 'POST', headers: h, body: 'hi' })).status;

  /** A POST whose body is held until the route passed its entry gates, so `change` lands mid-request. */
  const midBody = async (url: string, deviceId: string, body: string, change: () => void, contentType = 'application/json') => {
    let entered!: () => void;
    const gated = new Promise<void>((resolve) => { entered = resolve; });
    const lookup = Map.prototype.get.bind(panes);
    const spy = vi.spyOn(panes, 'get').mockImplementation((id: string) => { entered(); return lookup(id); });
    let request!: ReturnType<typeof httpReq>;
    const response = new Promise<{ status?: number; body: string }>((resolve, reject) => {
      request = httpReq(url, { method: 'POST', headers: { ...bearer(`${deviceId}.secret-${deviceId}`), 'Content-Type': contentType } }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => { text += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      request.on('error', reject);
      request.write(body.slice(0, 2));
    });
    try {
      await gated;
      spy.mockRestore();
      change();
      request.end(body.slice(2));
      return await response;
    } finally { spy.mockRestore(); request.destroy(); }
  };

  describe('matrix: Moa on/off × device permission × HQ brain / other brain / ordinary pane', () => {
    // [moa on, device may input] → expected [turns, chat send, raw input] per pane.
    const cases: Array<{ moaOn: boolean; input: boolean; expect: Record<string, [number, number, number]> }> = [
      { moaOn: true, input: true, expect: { s1: [200, 202, 204], 'brain-hq': [200, 202, 204], 'brain-other': [404, 404, 404] } },
      { moaOn: true, input: false, expect: { s1: [200, 403, 403], 'brain-hq': [200, 403, 403], 'brain-other': [404, 403, 403] } },
      { moaOn: false, input: true, expect: { s1: [200, 202, 204], 'brain-hq': [404, 404, 404], 'brain-other': [404, 404, 404] } },
      { moaOn: false, input: false, expect: { s1: [200, 403, 403], 'brain-hq': [404, 403, 403], 'brain-other': [404, 403, 403] } },
    ];
    for (const c of cases) {
      it(`Moa ${c.moaOn ? 'on' : 'off'}, device ${c.input ? 'with' : 'without'} input`, async () => {
        moa = c.moaOn ? { ...HQ } : null;
        await start();
        const h = device(`dev-${c.moaOn}-${c.input}`, c.input);
        for (const [id, [turns, send, input]] of Object.entries(c.expect)) {
          expect([id, await turnsStatus(h, id), await sendStatus(h, id), await inputStatus(h, id)]).toEqual([id, turns, send, input]);
        }
        // Nothing reached the other brain, ever.
        expect(panes.get('brain-other')!.ptyProcess.write).not.toHaveBeenCalled();
        expect(chat.send.mock.calls.map(([req]) => (req as ChatSendRequest).id)).not.toContain('brain-other');
      });
    }

    it('without --allow-transcript the turns and chat routes refuse every pane, the Moa pane included', async () => {
      await start({ allowTranscript: false });
      const h = device('dev-1');
      for (const id of ['s1', 'brain-hq']) {
        expect(await turnsStatus(h, id)).toBe(403);
        expect(await sendStatus(h, id)).toBe(403);
      }
    });

    it('a pushed fact that does not match the live pane opens nothing', async () => {
      await start();
      const h = device('dev-1');
      // Another workspace's brain named as the HQ's, the HQ's brain under another workspace, a gone pane.
      for (const fact of [{ sessionId: 'brain-other', workspaceId: 'ws-hq' }, { sessionId: 'brain-hq', workspaceId: 'ws-2' }, { sessionId: 'brain-gone', workspaceId: 'ws-hq' }]) {
        moa = fact;
        expect(await turnsStatus(h, 'brain-hq')).toBe(404);
        expect(await turnsStatus(h, 'brain-other')).toBe(404);
        expect(await inputStatus(h, 'brain-hq')).toBe(404);
      }
      expect(panes.get('brain-hq')!.ptyProcess.write).not.toHaveBeenCalled();
    });

    it('every other per-pane route still refuses the Moa pane to a device while Moa is on', async () => {
      const info = await start();
      const h = device('dev-1');
      const brain = `${base()}/api/sessions/brain-hq`;
      expect((await fetch(`${base()}/api/stream?session=brain-hq`, { headers: h })).status).toBe(404);
      expect((await fetch(brain, { method: 'DELETE', headers: h })).status).toBe(404);
      expect((await postJson(`${brain}/resize`, h, { cols: 100, rows: 30 })).status).toBe(404);
      expect((await fetch(`${brain}/commands?agent=claude`, { headers: h })).status).toBe(404);
      expect((await postJson(`${brain}/chat/launch`, h, { agent: 'claude', clientLaunchId: freshId(), prompt: 'x' })).status).toBe(404);
      expect((await fetch(`${brain}/turns/file?path=${encodeURIComponent('/etc/hosts')}`, { headers: h })).status).toBe(404);
      expect((await fetch(`${brain}/files`, { headers: h })).status).toBe(404);
      // It is not listed either: the phone learns the id from /api/config only.
      const listed = await (await fetch(`${base()}/api/sessions`, { headers: h })).json() as { sessions: Array<{ id: string }> };
      expect(listed.sessions.map((s) => s.id)).not.toContain('brain-hq');
      expect(destroyed).toEqual([]);
      expect(info.token).toBeTruthy();
    });

    it('a chat cancel and its receipts follow the same gate', async () => {
      await start();
      const h = device('dev-1');
      const cancel = (id: string) => postJson(`${base()}/api/sessions/${id}/chat/cancel`, h, { agentSessionId: 'sess-a', clientCancelId: freshId(), turnId: 't1:abc.3' });
      expect((await cancel('brain-hq')).status).not.toBe(404);
      expect(chat.cancel).toHaveBeenCalledTimes(1);
      expect((await fetch(`${base()}/api/sessions/brain-hq/chat/messages/${freshId()}`, { headers: h })).status).toBe(200);
      moa = null;
      expect((await cancel('brain-hq')).status).toBe(404);
      expect((await fetch(`${base()}/api/sessions/brain-hq/chat/messages/${freshId()}`, { headers: h })).status).toBe(404);
      expect(chat.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('revocation', () => {
    it('Moa withdrawn while a chat send body is on the wire: refused, nothing typed, nothing audited', async () => {
      await start();
      device('dev-1');
      const res = await midBody(`${base()}/api/sessions/brain-hq/chat/messages`, 'dev-1', JSON.stringify(sendBody()), () => { moa = null; });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'pane-incarnation-changed' });
      expect(chat.send).not.toHaveBeenCalled();
      expect(audits).toEqual([]);
    });

    it('Moa withdrawn while raw input is on the wire: refused, nothing written', async () => {
      await start();
      device('dev-1');
      const res = await midBody(`${base()}/api/input?session=brain-hq`, 'dev-1', 'ls -la\r', () => { moa = null; }, 'application/octet-stream');
      expect(res.status).toBe(409);
      expect(panes.get('brain-hq')!.ptyProcess.write).not.toHaveBeenCalled();
      expect(audits).toEqual([]);
    });

    it('Moa withdrawn between the send\'s admission and its first write: the write authorizer refuses', async () => {
      await start();
      const h = device('dev-1');
      sendHook = async () => { moa = null; };
      const res = await postJson(`${base()}/api/sessions/brain-hq/chat/messages`, h, sendBody());
      expect(await res.json()).toMatchObject({ error: 'authorization-expired', effect: 'none' });
      expect(audits).toEqual([]);
    });

    it('a queued send re-checks Moa at delivery, long after the request is gone', async () => {
      await start();
      const h = device('dev-1');
      let deliver: ChatSendRequest['authorized'] | undefined;
      Object.assign(chat, { queueEnabled: () => true, queue: () => [], delivered: () => [] });
      sendHook = async (req) => { deliver = req.queue?.authorized; };
      await postJson(`${base()}/api/sessions/brain-hq/chat/messages`, { ...h, 'x-wmux-client-caps': 'chat-queue' }, sendBody());
      expect(deliver).toBeDefined();
      audits.length = 0;
      expect(await deliver!('first-write')).toBe(true);
      expect(audits).toEqual([{ deviceId: 'dev-1', sessionId: 'brain-hq', route: 'chat' }]);
      moa = null;
      expect(await deliver!('first-write')).toBe(false);
    });

    it('Moa withdrawn while a turns read awaits the bridge: 404, no page served', async () => {
      await start();
      const h = device('dev-1');
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let entered!: () => void;
      const inside = new Promise<void>((r) => { entered = r; });
      resolveGate = async () => { entered(); await held; };
      const pending = fetch(`${base()}/api/sessions/brain-hq/turns`, { headers: h });
      await inside;
      moa = null;
      release();
      const res = await pending;
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('hello Moa');
    });

    it('an ordinary pane is not affected by the Moa re-check', async () => {
      await start();
      const h = device('dev-1');
      resolveGate = async () => { moa = null; };
      expect(await turnsStatus(h, 's1')).toBe(200);
    });
  });

  describe('audit', () => {
    it('logs every device send to the Moa pane with the device id and route, and nothing else', async () => {
      const info = await start();
      const h = device('dev-1');
      expect(await sendStatus(h, 'brain-hq')).toBe(202);
      expect(await inputStatus(h, 'brain-hq')).toBe(204);
      expect(audits).toEqual([
        { deviceId: 'dev-1', sessionId: 'brain-hq', route: 'chat' },
        { deviceId: 'dev-1', sessionId: 'brain-hq', route: 'input' },
      ]);
      audits.length = 0;
      // An ordinary pane, a read, and the operator token are not Moa sends by a device.
      expect(await sendStatus(h, 's1')).toBe(202);
      expect(await inputStatus(h, 's1')).toBe(204);
      expect(await turnsStatus(h, 'brain-hq')).toBe(200);
      expect(await inputStatus(bearer(info.token as string), 'brain-hq')).toBe(204);
      expect(audits).toEqual([]);
    });
  });
});
