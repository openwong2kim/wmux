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
import type { ApprovalEvent, ApprovalRegistryApi, ApprovalRequest, ApprovalResolveParams, ApprovalResolveResult } from '../../approvals/types';
import { TERMINAL_PROMPT_WEB_ANSWER } from '../../approvals/types';

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
  // #1772 — a stand-in registry: the routes' own gates and authorize closures
  // are what is under test, not the registry's fences.
  let records: ApprovalRequest[];
  let resolveCalls: Array<Omit<ApprovalResolveParams, 'authorize'>>;
  let verdicts: string[];
  let beforeAuthorize: (() => void) | null;
  let resolveResult: ApprovalResolveResult | null;
  let approvalListeners: Set<(e: ApprovalEvent) => void>;
  let refused: string[];

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
    records = [];
    resolveCalls = [];
    verdicts = [];
    beforeAuthorize = null;
    resolveResult = null;
    approvalListeners = new Set();
    refused = [];
    const approvals: ApprovalRegistryApi = {
      list: () => ({ pending: records.filter((r) => r.state === 'pending'), recentlyResolved: records.filter((r) => r.state !== 'pending') }),
      pendingCount: () => records.filter((r) => r.state === 'pending').length,
      resolve: async (params) => {
        const { authorize, ...recorded } = params;
        resolveCalls.push(recorded);
        const pending = records.find((r) => r.id === params.id && r.state === 'pending');
        if (!pending) return { ok: false, reason: 'not-found' };
        beforeAuthorize?.();
        const verdict = authorize ? await authorize(pending) : 'ok';
        verdicts.push(verdict);
        if (verdict !== 'ok') return { ok: false, reason: verdict === 'expired' ? 'unauthorized' : 'input-revoked', request: pending };
        return resolveResult ?? { ok: true, durable: true, request: { ...pending, pressedAt: 1 } };
      },
      onEvent: (listener) => {
        approvalListeners.add(listener);
        return () => { approvalListeners.delete(listener); };
      },
      terminalPromptDetail: (id) => (records.some((r) => r.id === id && r.state === 'pending')
        ? { id, command: 'rm -rf build', commandHash: 'h', commandBytes: 12, truncated: false } : null),
    };
    const resolution: ChatResolution = { source: 'file', status: status() };
    chat = {
      resolve: vi.fn(async () => { await resolveGate?.(); return resolution; }),
      managedSnapshot: vi.fn(() => null),
      turn: vi.fn(() => undefined),
      blocked: vi.fn(async () => undefined),
      // Like the real delivery: checked before the paste, then again before Enter.
      send: vi.fn(async (req: ChatSendRequest): Promise<ChatSendOutcome> => {
        await sendHook?.(req);
        if (req.authorized && !(await req.authorized('first-write'))) {
          return { clientMessageId: req.clientMessageId, replayed: false, error: 'authorization-expired', result: 'error', effect: 'none' };
        }
        if (req.authorized && !(await req.authorized('submit'))) {
          return { clientMessageId: req.clientMessageId, replayed: false, error: 'authorization-expired', result: 'error', effect: 'uncertain' };
        }
        return { clientMessageId: req.clientMessageId, replayed: false, result: 'sent', effect: 'submitted' };
      }),
      cancel: vi.fn(async (req) => {
        if (req.authorized && !(await req.authorized('first-write'))) return { clientCancelId: req.clientCancelId, replayed: false, effect: 'none', error: 'authorization-expired' };
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
      approvals,
      moaPromptRefused: (sessionId) => { refused.push(sessionId); },
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
      // The legacy command list (a directory read) stays refused; the composer's skill list does not.
      expect((await fetch(`${brain}/commands`, { headers: h })).status).toBe(404);
      expect((await fetch(`${brain}/commands?agent=claude`, { headers: h })).status).toBe(200);
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
      // The drain's pre-check types nothing and logs nothing; Enter after the paste does.
      expect(await deliver!('first-write')).toBe(true);
      expect(audits).toEqual([]);
      expect(await deliver!('submit')).toBe(true);
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

  describe('Moa\'s own permission dialog', () => {
    const dialogUp = () => { moa = { ...HQ, dialog: { fingerprint: 'ab12' } }; };

    it('refuses typed input that could answer it; ESC and ^C still get through', async () => {
      await start();
      const h = device('dev-1');
      dialogUp();
      for (const body of ['1', '\r', '1\r', 'y']) {
        const res = await fetch(`${base()}/api/input?session=brain-hq`, { method: 'POST', headers: h, body });
        expect([body, res.status, (await res.json() as { error: string }).error]).toEqual([body, 409, 'terminal-prompt-active']);
      }
      expect(panes.get('brain-hq')!.ptyProcess.write).not.toHaveBeenCalled();
      expect(await inputStatus(h, 'brain-hq')).toBe(409);
      for (const body of ['\x1b', '\x03']) {
        expect((await fetch(`${base()}/api/input?session=brain-hq`, { method: 'POST', headers: h, body })).status).toBe(204);
      }
      expect(audits).toEqual([
        { deviceId: 'dev-1', sessionId: 'brain-hq', route: 'input' },
        { deviceId: 'dev-1', sessionId: 'brain-hq', route: 'input' },
      ]);
      // An ordinary pane is not touched by Moa's dialog.
      expect(await inputStatus(h, 's1')).toBe(204);
    });

    it('refuses a chat send with chat-blocked (terminal), before anything reaches the bridge', async () => {
      await start();
      const h = device('dev-1');
      dialogUp();
      const res = await postJson(`${base()}/api/sessions/brain-hq/chat/messages`, h, sendBody());
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'chat-blocked', result: 'blocked', blockedBy: 'terminal', effect: 'none' });
      expect(chat.send).not.toHaveBeenCalled();
    });

    it('refuses a send whose dialog opens between admission and Enter', async () => {
      await start();
      const h = device('dev-1');
      sendHook = async () => { dialogUp(); };
      const res = await postJson(`${base()}/api/sessions/brain-hq/chat/messages`, h, sendBody());
      expect(await res.json()).toMatchObject({ error: 'authorization-expired', effect: 'none' });
      expect(audits).toEqual([]);
    });

    it('still lets a cancel through (ESC declines the dialog, it cannot approve it)', async () => {
      await start();
      const h = device('dev-1');
      dialogUp();
      const res = await postJson(`${base()}/api/sessions/brain-hq/chat/cancel`, h, { agentSessionId: 'sess-a', clientCancelId: freshId(), turnId: 't1:abc.3' });
      expect(res.status).not.toBe(404);
      expect(chat.cancel).toHaveBeenCalledTimes(1);
      expect(audits).toEqual([{ deviceId: 'dev-1', sessionId: 'brain-hq', route: 'chat' }]);
    });

    it('reports the pane blocked by the terminal in /turns', async () => {
      await start();
      const h = device('dev-1');
      dialogUp();
      const body = await (await fetch(`${base()}/api/sessions/brain-hq/turns`, { headers: h })).json() as { chat?: { blocked?: unknown } };
      expect(body.chat?.blocked).toMatchObject({ by: 'terminal' });
      moa = { ...HQ };
      const clear = await (await fetch(`${base()}/api/sessions/brain-hq/turns`, { headers: h })).json() as { chat?: { blocked?: unknown } };
      expect(clear.chat?.blocked).toBeUndefined();
    });
  });

  describe('Moa\'s own permission prompt as an approval record (#1772)', () => {
    const FP = 'f'.repeat(32);
    const prompt = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
      id: 'ap-moa', sessionId: 'brain-hq', agent: 'claude', kind: 'terminal_prompt', workspaceId: 'ws-hq',
      createdAt: 1, state: 'pending', toolName: 'Bash', summary: 'rm -rf build', question: 'Do you want to proceed?',
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], promptFingerprint: FP, ...over,
    });
    const caps = { 'X-Wmux-Client-Caps': 'terminal-prompt-answer, terminal-prompt-decline' };
    const emit = (type: ApprovalEvent['type'], request: ApprovalRequest) => { for (const l of approvalListeners) l({ type, request }); };
    const listIds = async (h: Record<string, string>) =>
      ((await (await fetch(`${base()}/api/approvals`, { headers: { ...h, ...caps } })).json()) as { pending: Array<{ id: string }> }).pending.map((r) => r.id);
    const answer = (h: Record<string, string>, id = 'ap-moa') =>
      postJson(`${base()}/api/approvals/${id}`, { ...h, ...caps }, { decision: 'approve', choiceKey: '1', promptFingerprint: FP });

    it('a device lists and answers the Moa pane\'s record while Moa is on — no other brain\'s, and none once Moa is off', async () => {
      records.push(prompt(), prompt({ id: 'ap-other', sessionId: 'brain-other', workspaceId: 'ws-2' }));
      await start();
      const h = device('dev-1');
      expect(await listIds(h)).toEqual(['ap-moa']);
      const res = await answer(h);
      expect(res.status).toBe(200);
      expect(resolveCalls).toHaveLength(1);
      expect(resolveCalls[0]).toMatchObject({ id: 'ap-moa', choiceKey: '1', promptFingerprint: FP, terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER });
      expect((await answer(h, 'ap-other')).status).toBe(404);
      for (const path of ['detail']) {
        expect((await fetch(`${base()}/api/approvals/ap-moa/${path}`, { headers: { ...h, ...caps } })).status).toBe(200);
        expect((await fetch(`${base()}/api/approvals/ap-other/${path}`, { headers: { ...h, ...caps } })).status).toBe(404);
      }
      moa = null;
      expect(await listIds(h)).toEqual([]);
      expect((await answer(h)).status).toBe(404);
      expect((await postJson(`${base()}/api/approvals/ap-moa/decline`, { ...h, ...caps }, {})).status).toBe(404);
      expect((await fetch(`${base()}/api/approvals/ap-moa/detail`, { headers: { ...h, ...caps } })).status).toBe(404);
      expect(resolveCalls).toHaveLength(1);
      // The operator's view of every brain is unchanged.
      expect((await fetch(`${base()}/api/approvals`, { headers: { ...bearer(server.status().token as string), ...caps } })).status).toBe(200);
    });

    it('Moa switched off while an answer or a decline waits → the authorize re-check refuses, no key', async () => {
      records.push(prompt());
      await start();
      const h = device('dev-1');
      beforeAuthorize = () => { moa = null; };
      const res = await answer(h);
      expect(res.status).toBe(401);
      moa = { ...HQ };
      const declined = await postJson(`${base()}/api/approvals/ap-moa/decline`, { ...h, ...caps }, {});
      expect(declined.status).toBe(401);
      expect(verdicts).toEqual(['expired', 'expired']);
      expect(panes.get('brain-hq')!.ptyProcess.write).not.toHaveBeenCalled();
    });

    it('a decision-v2 answer to the record of a Moa that is off is the same 404', async () => {
      records.push(prompt());
      await start();
      const h = device('dev-1');
      moa = null;
      const res = await postJson(`${base()}/api/approvals/ap-moa/answer`, { ...h, 'X-Wmux-Client-Caps': 'decision-v2' },
        { clientAnswerId: freshId(), formFingerprint: FP, action: 'approve' });
      expect(res.status).toBe(404);
      expect(resolveCalls).toEqual([]);
    });

    it('a prompt-changed refusal asks the daemon to look at the screen', async () => {
      records.push(prompt());
      await start();
      const h = device('dev-1');
      resolveResult = { ok: false, reason: 'prompt-changed', request: prompt() };
      expect((await answer(h)).status).toBe(409);
      expect(refused).toEqual(['brain-hq']);
    });

    it('/turns shows the record: a capable caller sees the approval id, an older one the terminal', async () => {
      records.push(prompt());
      moa = { ...HQ, dialog: { fingerprint: 'ab12' } };
      await start();
      const h = device('dev-1');
      const read = async (extra: Record<string, string>) =>
        ((await (await fetch(`${base()}/api/sessions/brain-hq/turns`, { headers: { ...h, ...extra } })).json()) as { chat?: { blocked?: unknown } }).chat?.blocked;
      expect(await read(caps)).toEqual({ by: 'approval', approvalId: 'ap-moa' });
      expect(await read({})).toEqual({ by: 'terminal' });
      // Answered already: the badge stays, but it points at the terminal.
      records[0] = prompt({ pressedAt: 5 });
      expect(await read(caps)).toEqual({ by: 'terminal' });
      // No record yet, only main's flag: the bare terminal block.
      records.length = 0;
      expect(await read(caps)).toEqual({ by: 'terminal' });
    });

    it('SSE: the card and its close reach the phone, and its chat badge clears, even after Moa is off; another brain\'s card never does', async () => {
      records.push(prompt());
      await start();
      const h = device('dev-1');
      emit('create', prompt());
      emit('create', prompt({ id: 'ap-other', sessionId: 'brain-other' }));
      const blocked = (await (await fetch(`${base()}/api/sessions/brain-hq/turns`, { headers: { ...h, ...caps } })).json()) as { chat?: { blocked?: unknown } };
      expect(blocked.chat?.blocked).toEqual({ by: 'approval', approvalId: 'ap-moa' });
      const ac = new AbortController();
      const res = await fetch(`${base()}/api/events`, { signal: ac.signal, headers: { ...h, ...caps, Accept: 'text/event-stream' } });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let wire = '';
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            wire += Buffer.from(chunk.value).toString('utf8');
          }
        } catch { /* aborted */ }
      })();
      const until = async (cond: () => boolean) => {
        const deadline = Date.now() + 4000;
        while (!cond()) {
          if (Date.now() > deadline) throw new Error(`timed out: ${wire}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      try {
        await until(() => wire.includes('"approvalId":"ap-moa"'));
        moa = null;
        records[0] = prompt({ state: 'expired', resolvedAt: 9 });
        emit('expire', records[0]);
        await until(() => wire.includes('"phase":"expire"') && wire.includes('chat.unblocked'));
        expect(wire).not.toContain('ap-other');
      } finally {
        ac.abort();
      }
    });
  });

  describe('live pane and phone notifications', () => {
    it('a dead or suspended session under the pushed id is not the Moa pane', async () => {
      await start();
      const h = device('dev-1');
      for (const state of ['dead', 'suspended']) {
        panes.get('brain-hq')!.meta.state = state;
        expect(await turnsStatus(h, 'brain-hq')).toBe(404);
        expect(await inputStatus(h, 'brain-hq')).toBe(404);
      }
      panes.get('brain-hq')!.meta.state = 'attached';
      expect(await turnsStatus(h, 'brain-hq')).toBe(200);
    });

    it('a transcript nudge for the Moa pane reaches the phone reading it, and stops once Moa is withdrawn', async () => {
      await start();
      const h = device('dev-1');
      expect(await turnsStatus(h, 'brain-hq')).toBe(200);
      const ac = new AbortController();
      const res = await fetch(`${base()}/api/events`, { signal: ac.signal, headers: { ...h, Accept: 'text/event-stream' } });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let wire = '';
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            wire += Buffer.from(chunk.value).toString('utf8');
          }
        } catch { /* aborted */ }
      })();
      try {
        const until = async (cond: () => boolean) => {
          const deadline = Date.now() + 4000;
          while (!cond()) {
            if (Date.now() > deadline) throw new Error('timed out');
            await new Promise((r) => setTimeout(r, 20));
          }
        };
        await until(() => wire.length > 0);
        server.emitTranscriptNudge('brain-hq');
        await until(() => wire.includes('transcript.nudge'));
        expect(wire).toContain('"sessionId":"brain-hq"');
        const seen = wire.split('transcript.nudge').length;
        moa = null;
        server.emitTranscriptNudge('brain-hq');
        await new Promise((r) => setTimeout(r, 1300));
        expect(wire.split('transcript.nudge').length).toBe(seen);
      } finally {
        ac.abort();
      }
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
