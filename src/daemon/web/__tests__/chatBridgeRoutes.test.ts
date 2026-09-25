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
import type { ApprovalEvent, ApprovalRegistryApi, ApprovalRequest } from '../../approvals/types';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import {
  OPENCODE_MAX_SEND_BYTES,
  fileHistoryEpoch,
  type ChatBlocked,
  type ChatBridge,
  type ChatLaunchOutcome,
  type ChatLaunchRequest,
  type ChatOwner,
  type ChatResolution,
  type ChatSendOutcome,
  type ChatSendReceiptView,
  type ChatSendRequest,
} from '../../chat/chatBridge';
import type { ChatSkillCatalog } from '../../../shared/transcript/chatSkills';

/**
 * Phone native chat routes (contract v0.3.1) against a FAKE ChatBridge: the
 * web server's half only — principal gates, re-authorization, wire mapping,
 * cursor v2, live-only blocked events and the watch lifetime. The daemon side
 * of the bridge has its own tests.
 */

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-chat-home-'));
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
    meta: { id, incarnationId: `${id}-inc-1`, env, spawnCwd: isolatedHome, cwd: '/tmp/osc7', state: 'detached', cols: 80, rows: 24 },
    ptyProcess: { write: vi.fn() },
    bridge: new EventEmitter(),
    ringBuffer: { readAll: () => Buffer.from(''), totalBytesWritten: 0 },
  };
}

const page = (events: Array<Record<string, unknown>>, cursor = { headOffset: 0, tailOffset: 10, fileSize: 10, mtimeMs: 1 }, extra: Partial<TranscriptPage> = {}): TranscriptPage => ({
  events: events as unknown as TranscriptPage['events'],
  cursor,
  hasMore: false,
  truncatedHead: false,
  ...extra,
});

const claudeStatus = (over: Partial<TranscriptStatus> = {}): TranscriptStatus => ({
  available: true,
  reason: 'ok',
  transcriptBasename: 'conv-a.jsonl',
  agentSessionId: 'sess-a',
  agentStatus: 'idle',
  agentAlive: true,
  terminal: {
    kind: 'terminal', agent: 'claude', nativeSessionId: 'sess-a',
    capabilities: { history: true, send: true, permissions: false, cancel: false, fileUndo: false },
  },
  ...over,
});

const fileResolution = (over: Partial<TranscriptStatus> = {}): ChatResolution => ({ source: 'file', status: claudeStatus(over) });

const tuiResolution = (epoch = 't1:' + 'a'.repeat(32), events = [{ id: 'o1', kind: 'user_text', text: 'hi' }], rawEpoch = 'deadbeef'.repeat(4) + ':1:ses_1'): ChatResolution => ({
  source: 'tui',
  status: {
    available: true, reason: 'ok', agentSessionId: 'ses_1', agentStatus: 'running', agentAlive: true,
    terminal: {
      kind: 'terminal', agent: 'opencode', nativeSessionId: 'ses_1', historyTruncated: true,
      capabilities: { history: true, send: false, permissions: false, cancel: false, fileUndo: false },
    },
  },
  page: page(events, { headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 }, { hasMore: true }),
  epoch,
  rawEpoch,
});

const managedResolution = (): ChatResolution => ({
  source: 'managed',
  status: {
    available: true, reason: 'ok', agentSessionId: 'm-1', agentAlive: false,
    managed: {
      provider: { id: 'codex', name: 'Codex', transport: 'codex' }, phase: 'disconnected',
      capabilities: { send: true, cancel: true, resume: true, permissions: true, questions: true, fileDiff: true, fileUndo: false, liveTerminalAttach: false },
      pending: [], historyTruncated: false,
    },
  },
  epoch: 'm1:' + 'b'.repeat(16),
});

const noneResolution = (ready = true): ChatResolution => ({
  source: 'none',
  status: { available: false, reason: 'no-hook' },
  launch: { ready, reason: ready ? 'ok' : 'shell-not-empty', agents: ['claude', 'codex'], maxPromptUnits: 2000 },
});

const cursorOf = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url');
const decodeCursor = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
const freshId = (at = Date.now()) => `${at}-${crypto.randomUUID()}`;

function makeFakeChat() {
  const box = {
    resolution: fileResolution() as ChatResolution,
    blocked: undefined as ChatBlocked | undefined,
    managedPage: page([{ id: 'm1', kind: 'assistant_text', text: 'managed' }], { headOffset: 3, tailOffset: 3, fileSize: 0, mtimeMs: 0 }) as TranscriptPage | null,
    send: async (req: ChatSendRequest): Promise<ChatSendOutcome> => {
      if (req.authorized && !(await req.authorized())) {
        return { clientMessageId: req.clientMessageId, replayed: false, error: 'authorization-expired', result: 'error', effect: 'none' };
      }
      return { clientMessageId: req.clientMessageId, replayed: false, result: 'sent', effect: 'submitted' };
    },
    receipts: new Map<string, ChatSendReceiptView>(),
    launch: async (req: ChatLaunchRequest): Promise<ChatLaunchOutcome> => {
      if (req.authorized && !(await req.authorized())) return { ok: false, error: 'authorization-expired', effect: 'none' };
      return { ok: true, effect: 'submitted' };
    },
    skills: { state: 'ready', skills: [{ name: 'review', description: 'Review the diff', invocation: '$review', source: 'user' }] } as ChatSkillCatalog,
  };
  const bridge = {
    resolve: vi.fn(async (_id: string) => box.resolution),
    managedSnapshot: vi.fn((_id: string) => box.managedPage),
    blocked: vi.fn(async (_id: string, _r: ChatResolution) => box.blocked),
    send: vi.fn((req: ChatSendRequest) => box.send(req)),
    receipt: vi.fn((owner: ChatOwner, id: string, cmid: string): ChatSendReceiptView =>
      box.receipts.get(`${owner}|${id}|${cmid}`) ?? { clientMessageId: cmid, state: 'unknown' }),
    launch: vi.fn((req: ChatLaunchRequest) => box.launch(req)),
    skills: vi.fn(async () => box.skills),
    watch: vi.fn(),
    unwatch: vi.fn(),
    traceDangerousLaunch: vi.fn(),
  } satisfies ChatBridge;
  return { box, bridge };
}

describe('native chat routes (contract v0.3.1)', () => {
  let server: WebTerminalServer;
  let panes: Map<string, Pane>;
  let roster: Map<string, { secret: string; revoked: boolean; allowInput: boolean }>;
  let chatBox: ReturnType<typeof makeFakeChat>['box'];
  let chat: ReturnType<typeof makeFakeChat>['bridge'];
  let chatWired: boolean;
  let projectorMock: { status: ReturnType<typeof vi.fn>; transcriptPath: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn>; delta: ReturnType<typeof vi.fn>; staleCursor: ReturnType<typeof vi.fn> };
  let approvalRecords: ApprovalRequest[];
  let approvalListeners: Set<(e: ApprovalEvent) => void>;
  let clock: number | null;

  beforeEach(() => {
    panes = new Map([['s1', mkPane('s1')], ['s2', mkPane('s2')], ['brain-1', mkPane('brain-1', { WMUX_BRAIN_PTY: '1' })]]);
    roster = new Map();
    clock = null;
    const fake = makeFakeChat();
    chatBox = fake.box;
    chat = fake.bridge;
    chatWired = true;
    projectorMock = {
      status: vi.fn(() => ({ available: false, reason: 'no-hook' })),
      transcriptPath: vi.fn(() => null),
      snapshot: vi.fn(() => page([{ id: 'u1', kind: 'user_text', text: 'snap' }], { headOffset: 5, tailOffset: 50, fileSize: 50, mtimeMs: 1 }, { hasMore: true })),
      delta: vi.fn(() => ({ events: [{ id: 'd1', kind: 'assistant_text', text: 'delta' }], cursor: { headOffset: 5, tailOffset: 80, fileSize: 80, mtimeMs: 1 }, reset: false })),
      staleCursor: vi.fn(() => false),
    };
    approvalRecords = [];
    approvalListeners = new Set();
    const approvals: ApprovalRegistryApi = {
      list: () => ({ pending: approvalRecords.filter((r) => r.state === 'pending'), recentlyResolved: [] }),
      pendingCount: () => approvalRecords.length,
      resolve: async () => ({ ok: false, reason: 'not-found' }),
      onEvent: (l) => { approvalListeners.add(l); return () => approvalListeners.delete(l); },
    };
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        const rec = roster.get(deviceId);
        if (!rec || rec.secret !== secret) return { ok: false, reason: 'unknown' };
        if (rec.revoked) return { ok: false, reason: 'revoked' };
        return { ok: true, deviceId, allowInput: rec.allowInput };
      },
    };
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: (id: string) => panes.get(id),
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      approvals,
      devices,
      projector: () => projectorMock as unknown as TranscriptProjector,
      chat: () => (chatWired ? chat : null),
      now: () => clock ?? Date.now(),
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (server.isRunning) await server.stop();
  });

  const start = (over: Partial<WebTerminalStartOptions> = {}) =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true, ...over });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const device = (id: string, allowInput = true) => {
    roster.set(id, { secret: `secret-${id}`, revoked: false, allowInput });
    return bearer(`${id}.secret-${id}`);
  };
  const postJson = (url: string, headers: Record<string, string>, body: unknown) =>
    fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const turns = async (h: Record<string, string>, query = '', id = 's1') => {
    const res = await fetch(`${base()}/api/sessions/${id}/turns${query}`, { headers: h });
    return { res, body: await res.json() as Record<string, any> };
  };
  const sendBody = (over: Record<string, unknown> = {}) => ({
    agentSessionId: 'sess-a', historyEpoch: 'h1:x', clientMessageId: freshId(), text: '실패한 테스트만 고쳐 줘', ...over,
  });
  const launchBody = (over: Record<string, unknown> = {}) => ({
    agent: 'codex', clientLaunchId: freshId(), prompt: '테스트 구조를 설명해 줘\n파일은 고치지 마', ...over,
  });

  /** Open `/api/events` as SSE and collect the raw wire. */
  const openEvents = async (h: Record<string, string>) => {
    const ac = new AbortController();
    const res = await fetch(`${base()}/api/events`, { signal: ac.signal, headers: { ...h, Accept: 'text/event-stream' } });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const box = { wire: '' };
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value) box.wire += Buffer.from(chunk.value).toString('utf8');
        }
      } catch { /* aborted */ }
    })();
    return { box, close: () => ac.abort() };
  };
  const until = async (cond: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  /**
   * POST whose body is held open until the route has passed its entry gates
   * (the pane lookup is the last of them), so the test can change the
   * credential or the pane between headers and body.
   */
  const midBody = async (url: string, deviceId: string, body: string, change: () => void) => {
    let entered!: () => void;
    const gated = new Promise<void>((resolve) => { entered = resolve; });
    const lookup = Map.prototype.get.bind(panes);
    const spy = vi.spyOn(panes, 'get').mockImplementation((id: string) => { entered(); return lookup(id); });
    let request!: ReturnType<typeof httpReq>;
    const response = new Promise<{ status?: number; body: string }>((resolve, reject) => {
      request = httpReq(url, { method: 'POST', headers: { ...bearer(`${deviceId}.secret-${deviceId}`), 'Content-Type': 'application/json' } }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => { text += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      request.on('error', reject);
      request.write(body.slice(0, 10));
    });
    try {
      await gated;
      spy.mockRestore();
      change();
      request.end(body.slice(10));
      return await response;
    } finally { spy.mockRestore(); request.destroy(); }
  };

  // ------------------------------------------------------------------ /turns

  describe('GET /turns', () => {
    it('keeps the legacy answer exactly when the bridge is not wired', async () => {
      chatWired = false;
      const info = await start();
      projectorMock.status.mockReturnValue(claudeStatus());
      const { body } = await turns(bearer(info.token as string));
      expect(body).not.toHaveProperty('chat');
      expect(body).not.toHaveProperty('mode');
      expect(body).not.toHaveProperty('reset');
      expect(decodeCursor(body.cursor)).toEqual({ head: 5, tail: 50, fileSize: 50 });
      expect(chat.resolve).not.toHaveBeenCalled();
    });

    it('403 without --allow-transcript and 404 for a brain pane, before the bridge is asked', async () => {
      const ro = await start({ allowTranscript: false });
      const off = await turns(bearer(ro.token as string));
      expect(off.res.status).toBe(403);
      expect(off.res.headers.get('cache-control')).toBe('no-store');
      expect(off.body.error.startsWith('transcript-disabled:')).toBe(true);
      await server.stop();
      await start();
      const brain = await turns(device('dev-1'), '', 'brain-1');
      expect(brain.res.status).toBe(404);
      expect(chat.resolve).not.toHaveBeenCalled();
      expect(chat.blocked).not.toHaveBeenCalled();
    });

    it('file snapshot: the chat object, mode, v2 cursor, and no reset without a cursor', async () => {
      const info = await start();
      const { res, body } = await turns(bearer(info.token as string));
      expect(res.headers.get('cache-control')).toBe('no-store');
      const epoch = fileHistoryEpoch('claude', 'sess-a', 'conv-a.jsonl');
      expect(body).toMatchObject({ available: true, mode: 'snapshot', hasMore: true });
      expect(body).not.toHaveProperty('reset');
      expect(body.chat).toEqual({
        binding: 'terminal', agent: 'claude', agentSessionId: 'sess-a', historyEpoch: epoch,
        historyTruncated: false, agentStatus: 'idle', agentAlive: true,
        capabilities: { history: true, send: true, permissions: false, cancel: false, fileUndo: false, streaming: false, launch: false, skills: true },
      });
      expect(decodeCursor(body.cursor)).toEqual({ v: 2, src: 'file', a: 'sess-a', e: epoch, head: 5, tail: 50, fileSize: 50 });
      expect(projectorMock.snapshot).toHaveBeenCalledWith('s1');
    });

    it('never advertises Stop or image attachments, which the phone has no route for; queue passes through', async () => {
      const info = await start();
      const resolution = chatBox.resolution as Extract<ChatResolution, { source: 'file' }>;
      chatBox.resolution = { ...resolution, status: { ...resolution.status, terminal: { ...resolution.status.terminal!,
        capabilities: { ...resolution.status.terminal!.capabilities, cancel: true, images: true, queue: true } } } };
      const { body } = await turns(bearer(info.token as string));
      expect(body.chat.capabilities).toMatchObject({ send: true, cancel: false, queue: true });
      expect(body.chat.capabilities).not.toHaveProperty('images');
    });

    it('file forward read with a matching cursor is a delta with reset:false', async () => {
      const info = await start();
      const first = await turns(bearer(info.token as string));
      const { body } = await turns(bearer(info.token as string), `?cursor=${first.body.cursor}`);
      expect(projectorMock.delta).toHaveBeenCalledWith('s1', 50, { cursorFileSize: 50 });
      expect(body).toMatchObject({ available: true, mode: 'delta', reset: false, events: [{ id: 'd1' }] });
      expect(decodeCursor(body.cursor)).toMatchObject({ v: 2, src: 'file', tail: 80 });
    });

    it('a projector reset on the delta path answers mode snapshot with reset:true', async () => {
      const info = await start();
      const first = await turns(bearer(info.token as string));
      projectorMock.delta.mockReturnValueOnce({ events: [], cursor: { headOffset: 0, tailOffset: 5, fileSize: 5, mtimeMs: 1 }, reset: true });
      const { body } = await turns(bearer(info.token as string), `?cursor=${first.body.cursor}`);
      expect(body).toMatchObject({ mode: 'snapshot', reset: true });
    });

    it('resets to a tail snapshot on source, id, epoch or v1 mismatch — forward AND back', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      const epoch = fileHistoryEpoch('claude', 'sess-a', 'conv-a.jsonl');
      const bad = [
        cursorOf({ head: 0, tail: 50, fileSize: 50 }),
        cursorOf({ v: 2, src: 'tui', a: 'sess-a', e: epoch, head: 0, tail: 50 }),
        cursorOf({ v: 2, src: 'file', a: 'sess-OTHER', e: epoch, head: 0, tail: 50 }),
        cursorOf({ v: 2, src: 'file', a: 'sess-a', e: 'h1:other', head: 0, tail: 50 }),
        'not-base64-json',
      ];
      for (const dir of ['', '&dir=back']) {
        for (const c of bad) {
          projectorMock.snapshot.mockClear();
          const { res, body } = await turns(h, `?cursor=${c}${dir}`);
          expect(res.status).toBe(200);
          expect(body).toMatchObject({ available: true, mode: 'snapshot', reset: true });
          expect(projectorMock.snapshot).toHaveBeenCalledWith('s1');
        }
      }
      expect(projectorMock.delta).not.toHaveBeenCalled();
    });

    it('a matching back read pages from the cursor head with mode older and reset:false', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      const first = await turns(h);
      const { body } = await turns(h, `?cursor=${first.body.cursor}&dir=back`);
      expect(projectorMock.snapshot).toHaveBeenLastCalledWith('s1', { before: 5 });
      expect(body).toMatchObject({ mode: 'older', reset: false });
      expect(projectorMock.staleCursor).toHaveBeenCalledWith('s1', 5, 50);
    });

    it('a back read whose file shrank or moved off a line boundary is a tail snapshot with reset:true', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      const first = await turns(h);
      projectorMock.staleCursor.mockReturnValue(true);
      const { body } = await turns(h, `?cursor=${first.body.cursor}&dir=back`);
      expect(projectorMock.snapshot).toHaveBeenLastCalledWith('s1');
      expect(body).toMatchObject({ available: true, mode: 'snapshot', reset: true, events: [{ id: 'u1' }] });
    });

    it('tui: full page every read; reset:true on every forward read with a cursor; raw epoch never leaves', async () => {
      chatBox.resolution = tuiResolution();
      const info = await start();
      const h = bearer(info.token as string);
      const first = await turns(h);
      expect(first.body).toMatchObject({ available: true, mode: 'snapshot', hasMore: false, events: [{ id: 'o1' }] });
      expect(first.body).not.toHaveProperty('reset');
      expect(first.body.chat).toMatchObject({
        binding: 'terminal', agent: 'opencode', agentSessionId: 'ses_1', historyEpoch: 't1:' + 'a'.repeat(32),
        historyTruncated: true, maxSendBytes: OPENCODE_MAX_SEND_BYTES,
      });
      expect(first.body.chat.capabilities).not.toHaveProperty('streaming');
      expect(JSON.stringify(first.body)).not.toContain('deadbeef');
      const again = await turns(h, `?cursor=${first.body.cursor}`);
      expect(again.body).toMatchObject({ mode: 'snapshot', reset: true, events: [{ id: 'o1' }] });
      const back = await turns(h, `?cursor=${first.body.cursor}&dir=back`);
      expect(back.body).toMatchObject({ mode: 'older', reset: false, events: [], hasMore: false });
      // Route switch: a new epoch invalidates the old cursor even on a back read.
      chatBox.resolution = tuiResolution('t1:' + 'c'.repeat(32));
      const switched = await turns(h, `?cursor=${first.body.cursor}&dir=back`);
      expect(switched.body).toMatchObject({ mode: 'snapshot', reset: true, events: [{ id: 'o1' }] });
    });

    it('managed: read-only snapshot with the managed block, reset:true with a cursor, empty back page', async () => {
      chatBox.resolution = managedResolution();
      const info = await start();
      const h = bearer(info.token as string);
      const first = await turns(h);
      expect(first.body.chat).toEqual({
        binding: 'managed', agentSessionId: 'm-1', historyEpoch: 'm1:' + 'b'.repeat(16), historyTruncated: false, agentAlive: false,
        capabilities: { history: true, send: false, permissions: false, cancel: false, fileUndo: false, launch: false, skills: false },
        managed: { provider: { id: 'codex', name: 'Codex', transport: 'codex' }, phase: 'disconnected' },
      });
      expect(decodeCursor(first.body.cursor)).toEqual({ v: 2, src: 'managed', a: 'm-1', e: 'm1:' + 'b'.repeat(16), head: 3 });
      expect((await turns(h, `?cursor=${first.body.cursor}`)).body).toMatchObject({ mode: 'snapshot', reset: true });
      expect((await turns(h, `?cursor=${first.body.cursor}&dir=back`)).body).toMatchObject({ mode: 'older', events: [], hasMore: false });
    });

    it('binding none: launch preview; after a conversation it answers reset:true, no rows, no cursor', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      const had = await turns(h);
      chatBox.resolution = noneResolution();
      const fresh = await turns(h);
      expect(fresh.body).toEqual({
        available: false, reason: 'no-hook',
        chat: {
          binding: 'none',
          capabilities: { history: false, send: false, permissions: false, cancel: false, fileUndo: false, launch: true, skills: true },
          launch: { ready: true, reason: 'ok', agents: ['claude', 'codex'], maxPromptUnits: 2000 },
        },
      });
      const gone = await turns(h, `?cursor=${had.body.cursor}`);
      expect(gone.body).toMatchObject({ available: false, reason: 'no-hook', reset: true, events: [] });
      expect(gone.body).not.toHaveProperty('cursor');
    });

    it('binding none: skills off while a launch is not ready (a live OpenCode pane)', async () => {
      const info = await start();
      chatBox.resolution = { ...noneResolution(false), launch: { ready: false, reason: 'agent-running', agents: ['claude', 'codex'], maxPromptUnits: 2000 } } as ChatResolution;
      const { body } = await turns(bearer(info.token as string));
      expect(body.chat.capabilities).toMatchObject({ launch: false, skills: false });
      expect(body.chat.launch).toMatchObject({ ready: false, reason: 'agent-running' });
    });

    it('reads the file page before the blocked await, so a binding that moves meanwhile never leaks in', async () => {
      const info = await start();
      chat.blocked.mockImplementationOnce(async () => {
        projectorMock.snapshot.mockReturnValue(page([{ id: 'x1', kind: 'user_text', text: 'another conversation' }]));
        return undefined;
      });
      const { body } = await turns(bearer(info.token as string));
      expect(body.events).toEqual([{ id: 'u1', kind: 'user_text', text: 'snap' }]);
      expect(body.chat.agentSessionId).toBe('sess-a');
    });

    it('carries the read-time blocked state', async () => {
      chatBox.blocked = { by: 'approval', approvalId: 'ap-1' };
      const info = await start();
      const { body } = await turns(bearer(info.token as string));
      expect(body.chat.blocked).toEqual({ by: 'approval', approvalId: 'ap-1' });
    });
  });

  // -------------------------------------------------------------------- send

  describe('POST /chat/messages', () => {
    const url = (id = 's1') => `${base()}/api/sessions/${id}/chat/messages`;

    it('gate matrix: read-only server, read-only device, no transcript, brain, missing pane, no bridge', async () => {
      const ro = await start({ allowInput: false });
      let res = await postJson(url(), bearer(ro.token as string), sendBody());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/^read-only:/);
      await server.stop();
      await start();
      res = await postJson(url(), device('ro', false), sendBody());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/^read-only:/);
      res = await postJson(url('brain-1'), device('dev-1'), sendBody());
      expect(res.status).toBe(404);
      res = await postJson(url('nope'), device('dev-1'), sendBody());
      expect(res.status).toBe(404);
      chatWired = false;
      res = await postJson(url(), device('dev-1'), sendBody());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chat-unavailable' });
      chatWired = true;
      await server.stop();
      const noTranscript = await start({ allowTranscript: false });
      res = await postJson(url(), bearer(noTranscript.token as string), sendBody());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/^transcript-disabled:/);
      expect(chat.send).not.toHaveBeenCalled();
    });

    it('sends through the bridge with the device owner and answers 202 submitted', async () => {
      await start();
      const body = sendBody();
      const res = await postJson(url(), device('dev-1'), body);
      expect(res.status).toBe(202);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ result: 'sent', replayed: false, clientMessageId: body.clientMessageId, effect: 'submitted' });
      const req = chat.send.mock.calls[0][0];
      expect(req).toMatchObject({ owner: 'device:dev-1', id: 's1', agentSessionId: 'sess-a', historyEpoch: 'h1:x', text: body.text, clientMessageId: body.clientMessageId, managedReadOnly: true });
      expect(typeof req.authorized).toBe('function');
    });

    it('the operator token sends as owner operator', async () => {
      const info = await start();
      await postJson(url(), bearer(info.token as string), sendBody());
      expect(chat.send.mock.calls[0][0].owner).toBe('operator');
    });

    it('refuses unknown keys and non-string fields with 400 invalid-chat-request, effect none', async () => {
      await start();
      const h = device('dev-1');
      const body = sendBody({ mode: 'bypass' });
      let res = await postJson(url(), h, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid-chat-request', effect: 'none', clientMessageId: body.clientMessageId });
      res = await postJson(url(), h, sendBody({ text: 42 }));
      expect(res.status).toBe(400);
      res = await postJson(url(), h, '[1,2]');
      expect(res.status).toBe(400);
      expect(chat.send).not.toHaveBeenCalled();
    });

    it('caps the body at 96 KiB (413), and a legal 16,000-unit Korean text fits', async () => {
      await start();
      const h = device('dev-1');
      const legal = await postJson(url(), h, sendBody({ text: '가'.repeat(16_000) }));
      expect(legal.status).toBe(202);
      const huge = await postJson(url(), h, sendBody({ text: 'x'.repeat(97 * 1024) }));
      expect(huge.status).toBe(413);
      expect(chat.send).toHaveBeenCalledTimes(1);
    });

    it('a device revoked while its body is on the wire gets 401 and nothing is sent', async () => {
      await start();
      device('dev-1');
      const r = await midBody(url(), 'dev-1', JSON.stringify(sendBody()), () => { roster.get('dev-1')!.revoked = true; });
      expect(r.status).toBe(401);
      expect(JSON.parse(r.body)).toEqual({ error: 'authorization-expired' });
      expect(chat.send).not.toHaveBeenCalled();
    });

    it('input withdrawn during the body → 403; pane restarted during the body → 409', async () => {
      await start();
      device('dev-1');
      let r = await midBody(url(), 'dev-1', JSON.stringify(sendBody()), () => { roster.get('dev-1')!.allowInput = false; });
      expect(r.status).toBe(403);
      roster.get('dev-1')!.allowInput = true;
      r = await midBody(url(), 'dev-1', JSON.stringify(sendBody()), () => { panes.get('s1')!.meta.incarnationId = 's1-inc-2'; });
      expect(r.status).toBe(409);
      expect(JSON.parse(r.body)).toEqual({ error: 'pane-incarnation-changed' });
      expect(chat.send).not.toHaveBeenCalled();
    });

    it('revoked at the first write: the predicate says no and the answer is 401 effect none', async () => {
      await start();
      const h = device('dev-1');
      chatBox.send = async (req) => {
        roster.get('dev-1')!.revoked = true;
        expect(await req.authorized!()).toBe(false);
        return { clientMessageId: req.clientMessageId, replayed: false, error: 'authorization-expired', result: 'error', effect: 'none' };
      };
      const res = await postJson(url(), h, sendBody());
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'authorization-expired', result: 'error', effect: 'none' });
    });

    it('revoked between paste and Enter: 401 with effect uncertain', async () => {
      await start();
      const h = device('dev-1');
      chatBox.send = async (req) => {
        expect(await req.authorized!('first-write')).toBe(true);
        roster.get('dev-1')!.allowInput = false;
        expect(await req.authorized!('submit')).toBe(false);
        return { clientMessageId: req.clientMessageId, replayed: false, error: 'authorization-expired', result: 'error', effect: 'uncertain' };
      };
      const res = await postJson(url(), h, sendBody());
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'authorization-expired', result: 'error', effect: 'uncertain' });
    });

    it('a phone that hangs up between paste and Enter still gets Enter while its grant holds', async () => {
      await start();
      const h = device('dev-1');
      let pasted!: () => void;
      const afterPaste = new Promise<void>((resolve) => { pasted = resolve; });
      let done!: (v: { hungUp: boolean; submit: boolean }) => void;
      const seen = new Promise<{ hungUp: boolean; submit: boolean }>((resolve) => { done = resolve; });
      chatBox.send = async (req) => {
        expect(await req.authorized!('first-write')).toBe(true);
        pasted();
        // Wait until the server sees the hang-up: the first-write check then refuses.
        let hungUp = false;
        for (let i = 0; i < 300 && !hungUp; i++) {
          hungUp = !(await req.authorized!('first-write'));
          if (!hungUp) await new Promise((r) => setTimeout(r, 10));
        }
        done({ hungUp, submit: await req.authorized!('submit') });
        return { clientMessageId: req.clientMessageId, replayed: false, result: 'sent', effect: 'submitted' };
      };
      const ac = new AbortController();
      const request = fetch(url(), { method: 'POST', signal: ac.signal, headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify(sendBody()) }).catch(() => undefined);
      await afterPaste;
      ac.abort();
      await request;
      expect(await seen).toEqual({ hungUp: true, submit: true });
    });

    it('the predicate also fails for a pane restarted after the body', async () => {
      await start();
      const h = device('dev-1');
      chatBox.send = async (req) => {
        panes.get('s1')!.meta.incarnationId = 's1-inc-9';
        return { clientMessageId: req.clientMessageId, replayed: false, ...(await req.authorized!() ? { result: 'sent' as const, effect: 'submitted' as const } : { error: 'authorization-expired' as const, result: 'error' as const, effect: 'none' as const }) };
      };
      expect((await postJson(url(), h, sendBody())).status).toBe(401);
    });

    it('maps every §6.2 outcome row to its status, body and effect', async () => {
      await start();
      const h = device('dev-1');
      const rows: Array<[Partial<ChatSendOutcome>, number, Record<string, unknown>]> = [
        [{ error: 'chat-busy', result: 'busy', effect: 'none' }, 409, { error: 'chat-busy', result: 'busy', effect: 'none' }],
        [{ error: 'chat-blocked', result: 'blocked', blockedBy: 'terminal', effect: 'none' }, 409, { error: 'chat-blocked', result: 'blocked', blockedBy: 'terminal', effect: 'none' }],
        [{ error: 'session-changed', result: 'session_changed', agentSessionId: 'sess-b', historyEpoch: 'h1:b', effect: 'none' }, 409, { error: 'session-changed', result: 'session_changed', agentSessionId: 'sess-b', historyEpoch: 'h1:b', effect: 'none' }],
        [{ error: 'chat-unavailable', result: 'unavailable', effect: 'none' }, 409, { error: 'chat-unavailable', result: 'unavailable', effect: 'none' }],
        [{ error: 'input-not-provably-empty', result: 'unconfirmed', effect: 'none' }, 409, { error: 'input-not-provably-empty', result: 'unconfirmed', effect: 'none' }],
        [{ error: 'send-interrupted', result: 'error', effect: 'uncertain' }, 409, { error: 'send-interrupted', result: 'error', effect: 'uncertain' }],
        [{ error: 'delivery-unconfirmed', result: 'unconfirmed', effect: 'uncertain' }, 409, { error: 'delivery-unconfirmed', result: 'unconfirmed', effect: 'uncertain' }],
        [{ error: 'invalid-chat-request', result: 'error', detail: 'blank', effect: 'none' }, 400, { error: 'invalid-chat-request', result: 'error', detail: 'blank', effect: 'none' }],
        [{ error: 'text-too-long', limit: 'units', effect: 'none' }, 400, { error: 'text-too-long', limit: 'units', effect: 'none' }],
        [{ error: 'text-too-long', limit: 'bytes', maxSendBytes: 23000, effect: 'none' }, 400, { error: 'text-too-long', limit: 'bytes', maxSendBytes: 23000, effect: 'none' }],
        [{ error: 'message-id-expired', detail: 'too old', effect: 'none' }, 400, { error: 'message-id-expired', detail: 'too old', effect: 'none' }],
        [{ error: 'message-id-conflict', effect: 'none' }, 409, { error: 'message-id-conflict', effect: 'none' }],
        [{ error: 'message-history-full', effect: 'none' }, 409, { error: 'message-history-full', effect: 'none' }],
        [{ error: 'opencode-receipts-full', result: 'unavailable', effect: 'none' }, 409, { error: 'opencode-receipts-full', result: 'unavailable', effect: 'none' }],
        [{ error: 'no-conversation', effect: 'none' }, 409, { error: 'no-conversation', effect: 'none' }],
        [{ error: 'managed-read-only', effect: 'none' }, 409, { error: 'managed-read-only', effect: 'none' }],
        [{ error: 'chat-persist-failed', effect: 'none' }, 500, { error: 'chat-persist-failed', effect: 'none' }],
      ];
      for (const [outcome, status, expected] of rows) {
        const body = sendBody();
        chatBox.send = async () => ({ clientMessageId: body.clientMessageId, replayed: false, ...outcome });
        const res = await postJson(url(), h, body);
        expect(res.status, outcome.error).toBe(status);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ ...expected, clientMessageId: body.clientMessageId });
      }
    });

    it('replays a final outcome with 200 replayed:true, and a pending one with 202 and NO effect', async () => {
      await start();
      const h = device('dev-1');
      const body = sendBody();
      chatBox.send = async () => ({ clientMessageId: body.clientMessageId, replayed: true, result: 'sent', effect: 'submitted' });
      let res = await postJson(url(), h, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: 'sent', replayed: true, clientMessageId: body.clientMessageId, effect: 'submitted' });
      chatBox.send = async () => ({ clientMessageId: body.clientMessageId, replayed: true, error: 'chat-busy', result: 'busy', effect: 'none' });
      res = await postJson(url(), h, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ error: 'chat-busy', replayed: true, effect: 'none' });
      chatBox.send = async () => ({ clientMessageId: body.clientMessageId, replayed: true, pending: true });
      res = await postJson(url(), h, body);
      expect(res.status).toBe(202);
      const pending = await res.json();
      expect(pending).toEqual({ state: 'pending', replayed: true, clientMessageId: body.clientMessageId });
      expect(pending).not.toHaveProperty('effect');
    });

    it('a send the agent queued mid-turn says queued:true on 202, on replay and on the receipt', async () => {
      await start();
      const h = device('dev-1');
      const body = sendBody();
      chatBox.send = async () => ({ clientMessageId: body.clientMessageId, replayed: false, result: 'sent', effect: 'submitted', queued: true });
      let res = await postJson(url(), h, body);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ result: 'sent', replayed: false, clientMessageId: body.clientMessageId, effect: 'submitted', queued: true });
      chatBox.send = async () => ({ clientMessageId: body.clientMessageId, replayed: true, result: 'sent', effect: 'submitted', queued: true });
      res = await postJson(url(), h, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ result: 'sent', replayed: true, queued: true });
      chatBox.receipts.set(`device:dev-1|s1|${body.clientMessageId}`, { clientMessageId: body.clientMessageId, state: 'submitted', result: 'sent', queued: true });
      res = await fetch(`${base()}/api/sessions/s1/chat/messages/${body.clientMessageId}`, { headers: h });
      expect(await res.json()).toEqual({ clientMessageId: body.clientMessageId, state: 'submitted', result: 'sent', queued: true });
    });

    it('a bridge that throws is a 500 without effect (unknown, never "nothing sent")', async () => {
      await start();
      chatBox.send = async () => { throw new Error('boom'); };
      const body = sendBody();
      const res = await postJson(url(), device('dev-1'), body);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'chat-send-failed', clientMessageId: body.clientMessageId });
    });
  });

  // ------------------------------------------------------------ send receipt

  describe('brain pane', () => {
    it('the operator token gets 404 on every chat write, receipt and skills route', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      const brain = `${base()}/api/sessions/brain-1`;
      expect((await postJson(`${brain}/chat/messages`, h, sendBody())).status).toBe(404);
      expect((await fetch(`${brain}/chat/messages/${freshId()}`, { headers: h })).status).toBe(404);
      expect((await postJson(`${brain}/chat/launch`, h, launchBody())).status).toBe(404);
      expect((await fetch(`${brain}/chat/launch/${freshId()}`, { headers: h })).status).toBe(404);
      expect((await fetch(`${brain}/commands?agent=claude`, { headers: h })).status).toBe(404);
      expect(chat.skills).not.toHaveBeenCalled();
      expect(chat.send).not.toHaveBeenCalled();
      expect(chat.launch).not.toHaveBeenCalled();
      expect(chat.receipt).not.toHaveBeenCalled();
      expect(panes.get('brain-1')!.ptyProcess.write).not.toHaveBeenCalled();
    });
  });

  describe('GET /chat/messages/:clientMessageId', () => {
    it('is owner-bound, needs no input grant, and 404s a brain or missing pane', async () => {
      await start();
      const cmid = freshId();
      chatBox.receipts.set(`device:dev-1|s1|${cmid}`, { clientMessageId: cmid, state: 'submitted', result: 'sent', agentSessionId: 'sess-a', historyEpoch: 'h1:x', at: 1758712345123 });
      const mine = device('dev-1', false);
      let res = await fetch(`${base()}/api/sessions/s1/chat/messages/${cmid}`, { headers: mine });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ clientMessageId: cmid, state: 'submitted', result: 'sent', agentSessionId: 'sess-a', historyEpoch: 'h1:x', at: 1758712345123 });
      res = await fetch(`${base()}/api/sessions/s1/chat/messages/${cmid}`, { headers: device('dev-2') });
      expect(await res.json()).toEqual({ clientMessageId: cmid, state: 'unknown' });
      expect(chat.receipt).toHaveBeenLastCalledWith('device:dev-2', 's1', cmid);
      res = await fetch(`${base()}/api/sessions/brain-1/chat/messages/${cmid}`, { headers: mine });
      expect(res.status).toBe(404);
      res = await fetch(`${base()}/api/sessions/gone/chat/messages/${cmid}`, { headers: mine });
      expect(res.status).toBe(404);
    });

    it('403 without --allow-transcript', async () => {
      const info = await start({ allowTranscript: false });
      const res = await fetch(`${base()}/api/sessions/s1/chat/messages/${freshId()}`, { headers: bearer(info.token as string) });
      expect(res.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------ launch

  describe('POST /chat/launch', () => {
    const url = (id = 's1') => `${base()}/api/sessions/${id}/chat/launch`;

    it('gate matrix: read-only device, read-only server, no transcript, brain', async () => {
      await start();
      expect((await postJson(url(), device('ro', false), launchBody())).status).toBe(403);
      expect((await postJson(url('brain-1'), device('dev-1'), launchBody())).status).toBe(404);
      await server.stop();
      const ro = await start({ allowInput: false });
      expect((await postJson(url(), bearer(ro.token as string), launchBody())).status).toBe(403);
      await server.stop();
      const nt = await start({ allowTranscript: false });
      expect((await postJson(url(), bearer(nt.token as string), launchBody())).status).toBe(403);
      expect(chat.launch).not.toHaveBeenCalled();
    });

    it('launches with refuseConversation and answers 202 submitted, untraced for default mode', async () => {
      await start();
      const body = launchBody();
      const res = await postJson(url(), device('dev-1'), body);
      expect(res.status).toBe(202);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ ok: true, replayed: false, clientLaunchId: body.clientLaunchId, effect: 'submitted' });
      expect(chat.launch.mock.calls[0][0]).toMatchObject({ id: 's1', agent: 'codex', prompt: body.prompt, mode: 'default', refuseConversation: true });
      expect(chat.traceDangerousLaunch).not.toHaveBeenCalled();
    });

    it('schema: unknown keys, bad agent/mode combos, and prompt rules are 400', async () => {
      await start();
      const h = device('dev-1');
      for (const over of [
        { model: 'opus' },
        { agent: 'opencode' },
        { agent: 'claude', mode: 'yolo', confirm: 'claude:yolo' },
        { agent: 'codex', mode: 'bypass', confirm: 'codex:bypass' },
        { prompt: '   ' },
        { prompt: 'x'.repeat(2001) },
        { prompt: 'line\rreturn' },
        { prompt: 'esc\u001b[31m' },
        { prompt: 'del\u007f' },
        { clientLaunchId: 'not-an-id' },
      ]) {
        const res = await postJson(url(), h, launchBody(over));
        expect(res.status, JSON.stringify(over)).toBe(400);
        expect((await res.json()).error).toBe('invalid-chat-request');
      }
      expect(chat.launch).not.toHaveBeenCalled();
      expect((await postJson(url(), h, launchBody({ prompt: 'x'.repeat(2000) }))).status).toBe(202);
    });

    it('an id past the 10-minute receipt lifetime is launch-id-expired', async () => {
      await start();
      const res = await postJson(url(), device('dev-1'), launchBody({ clientLaunchId: freshId(Date.now() - 11 * 60_000) }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'launch-id-expired', effect: 'none' });
    });

    it('caps the body at 16 KiB (413)', async () => {
      await start();
      const res = await postJson(url(), device('dev-1'), launchBody({ prompt: 'x'.repeat(17 * 1024) }));
      expect(res.status).toBe(413);
    });

    it('dangerous mode with the ceiling off: 403, traced as a refusal, never launched', async () => {
      await start();
      const body = launchBody({ mode: 'yolo', confirm: 'codex:yolo' });
      const res = await postJson(url(), device('dev-1'), body);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/^dangerous-launch-disabled: /);
      expect(chat.launch).not.toHaveBeenCalled();
      expect(chat.traceDangerousLaunch).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'device:dev-1', paneId: 's1', agent: 'codex', mode: 'yolo', clientLaunchId: body.clientLaunchId, outcome: 'dangerous-launch-disabled',
      }));
    });

    it('dangerous mode with the ceiling on: 428 without the exact confirm, 202 and traced with it', async () => {
      await start({ allowDangerousLaunch: true });
      const h = device('dev-1');
      for (const confirm of [undefined, 'claude:yolo', 'codex:default']) {
        const res = await postJson(url(), h, launchBody({ mode: 'yolo', ...(confirm ? { confirm } : {}) }));
        expect(res.status).toBe(428);
        expect(await res.json()).toMatchObject({ error: 'dangerous-mode-unconfirmed', effect: 'none' });
      }
      expect(chat.traceDangerousLaunch).toHaveBeenCalledTimes(3);
      expect(chat.launch).not.toHaveBeenCalled();
      const body = launchBody({ agent: 'claude', mode: 'bypass', confirm: 'claude:bypass' });
      const res = await postJson(url(), h, body);
      expect(res.status).toBe(202);
      expect(chat.launch.mock.calls[0][0]).toMatchObject({ agent: 'claude', mode: 'bypass' });
      expect(chat.traceDangerousLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'bypass', outcome: 'submitted' }));
    });

    it('the ceiling is re-read inside the predicate that runs before typing', async () => {
      await start({ allowDangerousLaunch: true });
      chatBox.launch = async (req) => {
        (server as unknown as { opts: WebTerminalStartOptions }).opts.allowDangerousLaunch = false;
        return (await req.authorized!()) ? { ok: true, effect: 'submitted' } : { ok: false, error: 'authorization-expired', effect: 'none' };
      };
      const res = await postJson(url(), device('dev-1'), launchBody({ mode: 'yolo', confirm: 'codex:yolo' }));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'authorization-expired', effect: 'none' });
    });

    it('a device revoked during the body gets 401 before the bridge is called', async () => {
      await start();
      device('dev-1');
      const r = await midBody(url(), 'dev-1', JSON.stringify(launchBody()), () => { roster.get('dev-1')!.revoked = true; });
      expect(r.status).toBe(401);
      expect(chat.launch).not.toHaveBeenCalled();
    });

    it('maps every §6.4 outcome row', async () => {
      await start({ allowDangerousLaunch: true });
      const h = device('dev-1');
      const rows: Array<[ChatLaunchOutcome, number, Record<string, unknown>]> = [
        [{ ok: false, error: 'launch-pending', effect: 'none' }, 409, { error: 'launch-pending', effect: 'none' }],
        [{ ok: false, error: 'conversation-exists', effect: 'none' }, 409, { error: 'conversation-exists', effect: 'none' }],
        [{ ok: false, error: 'launch-not-ready', reason: 'shell-not-empty', effect: 'none' }, 409, { error: 'launch-not-ready', reason: 'shell-not-empty', effect: 'none' }],
        [{ ok: false, error: 'launch-unsupported', reason: 'shell-has-children', effect: 'none' }, 409, { error: 'launch-unsupported', reason: 'shell-has-children', effect: 'none' }],
        [{ ok: false, error: 'agent-not-installed', effect: 'none' }, 409, { error: 'agent-not-installed', effect: 'none' }],
        [{ ok: false, error: 'agent-runtime-unavailable', effect: 'none' }, 502, { error: 'agent-runtime-unavailable', effect: 'none' }],
        [{ ok: false, error: 'launch-unconfirmed', effect: 'uncertain' }, 502, { error: 'launch-unconfirmed', effect: 'uncertain' }],
        [{ ok: false, error: 'authorization-expired', effect: 'none' }, 401, { error: 'authorization-expired', effect: 'none' }],
        [{ ok: false, error: 'invalid-chat-request', effect: 'none' }, 400, { error: 'invalid-chat-request', effect: 'none' }],
      ];
      for (const [outcome, status, expected] of rows) {
        chatBox.launch = async () => outcome;
        const body = launchBody();
        const res = await postJson(url(), h, body);
        expect(res.status, outcome.ok ? 'ok' : outcome.error).toBe(status);
        expect(await res.json()).toEqual({ ...expected, clientLaunchId: body.clientLaunchId });
      }
      // A dangerous attempt that may have typed is traced; one refused before typing is not.
      chat.traceDangerousLaunch.mockClear();
      chatBox.launch = async () => ({ ok: false, error: 'launch-unconfirmed', effect: 'uncertain' });
      await postJson(url(), h, launchBody({ mode: 'yolo', confirm: 'codex:yolo' }));
      chatBox.launch = async () => ({ ok: false, error: 'launch-not-ready', reason: 'shell-busy', effect: 'none' });
      await postJson(url(), h, launchBody({ mode: 'yolo', confirm: 'codex:yolo' }));
      expect(chat.traceDangerousLaunch.mock.calls.map((c) => c[0].outcome)).toEqual(['launch-unconfirmed']);
    });

    it('a bridge that throws after the checks is 502 launch-unconfirmed, effect uncertain', async () => {
      await start();
      chatBox.launch = async () => { throw new Error('pty gone'); };
      const body = launchBody();
      const res = await postJson(url(), device('dev-1'), body);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'launch-unconfirmed', effect: 'uncertain', clientLaunchId: body.clientLaunchId });
      const receipt = await fetch(`${base()}/api/sessions/s1/chat/launch/${body.clientLaunchId}`, { headers: device('dev-1') });
      expect((await receipt.json()).state).toBe('uncertain');
    });

    it('receipts: replay 200, conflict 409, concurrent pending 202 — the launcher is typed once', async () => {
      await start();
      const h = device('dev-1');
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      chatBox.launch = async () => { await gate; return { ok: true, effect: 'submitted' }; };
      const body = launchBody();
      const first = postJson(url(), h, body);
      await until(() => chat.launch.mock.calls.length === 1);
      const concurrent = await postJson(url(), h, body);
      expect(concurrent.status).toBe(202);
      expect(await concurrent.json()).toEqual({ state: 'pending', replayed: true, clientLaunchId: body.clientLaunchId });
      const pendingState = await fetch(`${base()}/api/sessions/s1/chat/launch/${body.clientLaunchId}`, { headers: h });
      expect((await pendingState.json()).state).toBe('pending');
      release();
      expect((await first).status).toBe(202);
      const replay = await postJson(url(), h, body);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, replayed: true, clientLaunchId: body.clientLaunchId, effect: 'submitted' });
      const conflict = await postJson(url(), h, { ...body, prompt: 'something else' });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: 'launch-id-conflict', effect: 'none' });
      expect(chat.launch).toHaveBeenCalledTimes(1);
    });

    it('receipt GET is owner-bound and pane-bound, and works after the input grant is withdrawn', async () => {
      await start();
      const body = launchBody();
      await postJson(url(), device('dev-1'), body);
      roster.get('dev-1')!.allowInput = false;
      const get = (h: Record<string, string>, id = 's1', clid = body.clientLaunchId) =>
        fetch(`${base()}/api/sessions/${id}/chat/launch/${clid}`, { headers: h }).then(async (r) => ({ status: r.status, body: await r.json() }));
      expect(await get(bearer('dev-1.secret-dev-1'))).toEqual({ status: 200, body: { clientLaunchId: body.clientLaunchId, state: 'submitted' } });
      expect((await get(device('dev-2'))).body.state).toBe('unknown');
      expect((await get(bearer('dev-1.secret-dev-1'), 's2')).body.state).toBe('unknown');
      expect((await get(bearer('dev-1.secret-dev-1'), 's1', freshId())).body.state).toBe('unknown');
      expect((await get(bearer('dev-1.secret-dev-1'), 'brain-1')).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ skills

  describe('GET /commands?agent=', () => {
    it('without agent: the legacy list, bridge untouched', async () => {
      const info = await start();
      const res = await fetch(`${base()}/api/sessions/s1/commands`, { headers: bearer(info.token as string) });
      const body = await res.json();
      expect(body).toHaveProperty('commands');
      expect(body).not.toHaveProperty('state');
      expect(chat.skills).not.toHaveBeenCalled();
    });

    it('with agent: native rows with kind skill and the verbatim invocation', async () => {
      await start({ allowInput: false });
      const h = device('ro', false);
      const res = await fetch(`${base()}/api/sessions/s1/commands?agent=codex`, { headers: h });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: 'ready',
        commands: [{ name: 'review', description: 'Review the diff', source: 'user', kind: 'skill', invocation: '$review' }],
      });
      expect(chat.skills).toHaveBeenCalledWith('s1', 'codex');
      chatBox.skills = { state: 'unavailable', skills: [], reason: 'bridge-outdated' };
      expect(await (await fetch(`${base()}/api/sessions/s1/commands?agent=claude`, { headers: h })).json())
        .toEqual({ state: 'unavailable', reason: 'bridge-outdated', commands: [] });
    });

    it('unknown agent 400, brain 404, no bridge or a failing bridge → 200 unavailable', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      expect((await fetch(`${base()}/api/sessions/s1/commands?agent=opencode`, { headers: h })).status).toBe(400);
      expect((await fetch(`${base()}/api/sessions/brain-1/commands?agent=claude`, { headers: device('dev-1') })).status).toBe(404);
      chat.skills.mockRejectedValueOnce(new Error('relay down'));
      expect(await (await fetch(`${base()}/api/sessions/s1/commands?agent=codex`, { headers: h })).json()).toEqual({ state: 'unavailable', commands: [] });
      chatWired = false;
      expect(await (await fetch(`${base()}/api/sessions/s1/commands?agent=codex`, { headers: h })).json()).toEqual({ state: 'unavailable', commands: [] });
    });
  });

  // ------------------------------------------------------------------ config

  describe('/api/config', () => {
    const config = async (h: Record<string, string>) => (await fetch(`${base()}/api/config`, { headers: h })).json() as Promise<Record<string, unknown>>;

    it('omits every chat key when the bridge is not wired', async () => {
      chatWired = false;
      const info = await start();
      const body = await config(bearer(info.token as string));
      for (const key of ['chatBinding', 'chatSend', 'chatLaunch', 'chatLaunchModes', 'chatSkills', 'chatVersion']) {
        expect(body).not.toHaveProperty(key);
      }
    });

    it('advertises per caller: operator, read-only device, ceiling on, transcript off', async () => {
      const info = await start();
      expect(await config(bearer(info.token as string))).toMatchObject({
        chatBinding: true, chatSend: true, chatLaunch: true, chatSkills: true, chatVersion: 1,
        chatLaunchModes: { claude: ['default'], codex: ['default'] },
      });
      const ro = await config(device('ro', false));
      expect(ro).toMatchObject({ chatBinding: true, chatSend: false, chatLaunch: false, chatSkills: true, chatVersion: 1 });
      expect(ro).not.toHaveProperty('chatLaunchModes');
      await server.stop();
      const open = await start({ allowDangerousLaunch: true });
      expect((await config(bearer(open.token as string))).chatLaunchModes).toEqual({ claude: ['default', 'bypass'], codex: ['default', 'yolo'] });
      expect(server.status().allowDangerousLaunch).toBe(true);
      await server.stop();
      const off = await start({ allowTranscript: false, allowDangerousLaunch: true });
      const offBody = await config(bearer(off.token as string));
      expect(offBody).toMatchObject({ chatBinding: false, chatSend: false, chatLaunch: false, chatSkills: true });
      expect(offBody).not.toHaveProperty('chatLaunchModes');
    });
  });

  // ------------------------------------------------------------ live events

  describe('chat.blocked / chat.unblocked', () => {
    it('goes to /turns watchers only, with no id line, and never into the replay log', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      const events = await openEvents(h);
      const other = await openEvents(device('dev-9'));
      try {
        await turns(h);
        chatBox.blocked = { by: 'terminal' };
        await turns(h);
        await until(() => events.box.wire.includes('event: chat.blocked'));
        const frame = events.box.wire.slice(events.box.wire.indexOf('event: chat.blocked'));
        expect(events.box.wire).not.toMatch(/id: [^\n]*\nevent: chat\.blocked/);
        const data = JSON.parse(frame.split('\n')[1].slice('data: '.length));
        expect(data).toMatchObject({ sessionId: 's1', by: 'terminal', agent: 'claude' });
        expect(typeof data.at).toBe('number');
        chatBox.blocked = undefined;
        await turns(h);
        await until(() => events.box.wire.includes('event: chat.unblocked'));
        const backlog = await (await fetch(`${base()}/api/events`, { headers: h })).json();
        expect(JSON.stringify(backlog)).not.toContain('chat.');
        expect(other.box.wire).not.toContain('chat.');
      } finally { events.close(); other.close(); }
    });

    it('an approval for a watched pane triggers a coalesced recompute', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      const events = await openEvents(h);
      try {
        await turns(h);
        chat.resolve.mockClear();
        chatBox.blocked = { by: 'approval', approvalId: 'ap-7' };
        const request: ApprovalRequest = { id: 'ap-7', sessionId: 's1', agent: 'claude', kind: 'awaiting_input', createdAt: 1, state: 'pending' };
        for (const l of approvalListeners) { l({ type: 'create', request }); l({ type: 'create', request }); }
        await until(() => events.box.wire.includes('event: chat.blocked'));
        expect(chat.resolve).toHaveBeenCalledTimes(1);
        expect(events.box.wire).toContain('"approvalId":"ap-7"');
      } finally { events.close(); }
    });

    it('never computes or emits for the brain pane', async () => {
      const info = await start();
      const h = bearer(info.token as string);
      const events = await openEvents(h);
      try {
        // The operator may read a brain pane nowhere through /turns; force a
        // watcher entry to prove the producer gate, not the route, refuses.
        (server as unknown as { transcriptWatchers: Map<string, Set<string>> }).transcriptWatchers.set('brain-1', new Set(['operator']));
        chatBox.blocked = { by: 'terminal' };
        const request: ApprovalRequest = { id: 'ap-b', sessionId: 'brain-1', agent: 'claude', kind: 'awaiting_input', createdAt: 1, state: 'pending' };
        for (const l of approvalListeners) l({ type: 'create', request });
        server.emitTranscriptNudge('brain-1');
        await new Promise((r) => setTimeout(r, 1300));
        expect(chat.resolve).not.toHaveBeenCalledWith('brain-1');
        expect(chat.blocked).not.toHaveBeenCalled();
        expect(events.box.wire).not.toContain('chat.');
      } finally { events.close(); }
    });
  });

  // ---------------------------------------------------------- watch lifetime

  describe('OpenCode watch lifetime (N7)', () => {
    it('watches on a tui read, keeps it while read recently with SSE open, then unwatches', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      chatBox.resolution = tuiResolution();
      clock = 1_000_000;
      const info = await start();
      const h = bearer(info.token as string);
      const events = await openEvents(h);
      try {
        await turns(h);
        expect(chat.watch).toHaveBeenCalledWith('s1');
        clock += 100_000;
        vi.advanceTimersByTime(30_000);
        expect(chat.unwatch).not.toHaveBeenCalled();
        clock += 21_000;
        vi.advanceTimersByTime(30_000);
        expect(chat.unwatch).toHaveBeenCalledWith('s1');
      } finally { events.close(); }
    });

    it('unwatches once no reader holds an SSE connection, and on stop()', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      chatBox.resolution = tuiResolution();
      const info = await start();
      const h = bearer(info.token as string);
      await turns(h);
      vi.advanceTimersByTime(30_000);
      expect(chat.unwatch).toHaveBeenCalledWith('s1');
      chat.unwatch.mockClear();
      await turns(h, '', 's2');
      expect(chat.watch).toHaveBeenCalledWith('s2');
      await server.stop();
      expect(chat.unwatch).toHaveBeenCalledWith('s2');
    });

    it('file and managed reads never open a watch', async () => {
      const info = await start();
      await turns(bearer(info.token as string));
      chatBox.resolution = managedResolution();
      await turns(bearer(info.token as string));
      expect(chat.watch).not.toHaveBeenCalled();
    });
  });
});
