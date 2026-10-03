import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebTerminalStartOptions } from '../WebTerminalServer';
import type { ApprovalRegistryApi, ApprovalRequest } from '../../approvals/types';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { ChatBridge, ChatResolution } from '../../chat/chatBridge';
import type { ChatV2Binding, ChatV2EventsPush } from '../../../shared/chatv2/ipc';
import { applyHarnessEvent } from '../../../shared/chatv2/apply';
import { newChatSession, type Session } from '../../../shared/chatv2/session';
import type { ChatV2PhoneHost } from '../chatWire';

/**
 * Phone chat routes for a chat-v2 record, against a FAKE host (the driver host
 * lands separately). The record must read like a managed one to a shipped
 * phone: `/turns` binding `managed`, send `409 managed-read-only`.
 */

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-chatv2-home-'));
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => { process.env.HOME = isolatedHome; process.env.USERPROFILE = isolatedHome; });
afterAll(() => {
  process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

function mkPane(id: string) {
  return {
    meta: { id, incarnationId: `${id}-inc-1`, env: {}, spawnCwd: isolatedHome, cwd: '/tmp', state: 'detached', cols: 80, rows: 24 },
    ptyProcess: { write: vi.fn() },
    bridge: new EventEmitter(),
    ringBuffer: { readAll: () => Buffer.from(''), totalBytesWritten: 0 },
  };
}

const PROVIDER_ID = '0199f1c2-0000-4000-8000-000000000001';
const EPOCH = 'a'.repeat(16);

const binding = (over: Partial<ChatV2Binding> = {}): ChatV2Binding => ({
  paneId: 's1', chatSessionId: 'c1', agent: 'claude', mode: 'default', model: '', status: 'running',
  providerSessionId: PROVIDER_ID, epoch: EPOCH, seq: 3,
  capabilities: { send: true, interrupt: true, approvals: true, questions: true, images: true, toTerminal: true },
  ...over,
});

function conversation(): Session {
  let session = newChatSession({ id: 'c1', harness: 'claude', cwd: '/w' });
  const events = [
    { type: 'user.message', text: 'add a test', clientMessageId: 'cm-00000001' },
    { type: 'tool.started', callId: 't1', title: 'Write', kind: 'write', preview: { kind: 'write', path: '/w/a.test.ts' } },
    { type: 'approval.requested', requestId: 'r1', title: 'Write', callId: 't1' },
  ] as const;
  events.forEach((event, i) => { session = applyHarnessEvent(session, { seq: i + 1, at: 1000 + i, event }); });
  return session;
}

/** The managed object as today's bridge serves it (chatBridgeRoutes.test.ts fixture). */
const managedResolution: ChatResolution = {
  source: 'managed',
  status: {
    available: true, reason: 'ok', agentSessionId: 'm-1', agentStatus: 'idle', agentAlive: false,
    managed: {
      provider: { id: 'codex', name: 'Codex', transport: 'codex' }, phase: 'disconnected',
      capabilities: { send: true, cancel: true, resume: true, permissions: true, questions: true, fileDiff: true, fileUndo: false, liveTerminalAttach: false },
      pending: [], historyTruncated: false,
    },
  },
  epoch: 'm1:' + 'b'.repeat(16),
};

describe('phone chat routes for a chat-v2 record', () => {
  let server: WebTerminalServer;
  let box: { binding: ChatV2Binding | null; session: Session | null; interrupted: boolean };
  let host: ChatV2PhoneHost & { call: ReturnType<typeof vi.fn> };
  let pushListeners: Array<(push: ChatV2EventsPush) => void>;
  let bridge: { resolve: ReturnType<typeof vi.fn>; managedSnapshot: ReturnType<typeof vi.fn>; blocked: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; launch: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  let approvals: ApprovalRequest[];
  let pane: ReturnType<typeof mkPane>;

  beforeEach(() => {
    box = { binding: binding(), session: conversation(), interrupted: true };
    pushListeners = [];
    host = {
      bindingForPane: (id: string) => (id === 's1' ? box.binding : null),
      sessionForPane: (id: string) => (id === 's1' ? box.session : null),
      call: vi.fn(async () => ({ ok: true, interrupted: box.interrupted })),
      onPush: (listener: (push: ChatV2EventsPush) => void) => { pushListeners.push(listener); return () => undefined; },
    } as unknown as ChatV2PhoneHost & { call: ReturnType<typeof vi.fn> };
    bridge = {
      resolve: vi.fn(async () => managedResolution),
      managedSnapshot: vi.fn(() => ({ events: [{ id: 'm1', kind: 'assistant_text', text: 'managed' }], cursor: { headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 }, hasMore: false, truncatedHead: false })),
      blocked: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ clientMessageId: 'x', replayed: false, result: 'sent', effect: 'submitted' })),
      launch: vi.fn(async () => ({ ok: true, effect: 'submitted' })),
      cancel: vi.fn(async () => ({ clientCancelId: 'x', replayed: false, effect: 'interrupt-requested' })),
    };
    approvals = [];
    const registry: ApprovalRegistryApi = {
      list: () => ({ pending: approvals.filter((r) => r.state === 'pending'), recentlyResolved: [] }),
      pendingCount: () => approvals.length,
      resolve: async () => ({ ok: false, reason: 'not-found' }),
      onEvent: () => () => undefined,
    };
    pane = mkPane('s1');
    const panes = new Map([['s1', pane]]);
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: (id: string) => panes.get(id),
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      approvals: registry,
      chat: () => bridge as unknown as ChatBridge,
      chatV2: () => host,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
  });

  /** Start the server; resolves to the operator token. */
  const start = async (over: Partial<WebTerminalStartOptions> = {}): Promise<string> => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true, ...over });
    return info.token ?? '';
  };
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const auth = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
  const turns = async (token: string, query = '', headers: Record<string, string> = {}) => {
    const res = await fetch(`${base()}/api/sessions/s1/turns${query}`, { headers: auth(token, headers) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const post = async (token: string, route: string, body: unknown) => {
    const res = await fetch(`${base()}/api/sessions/s1/chat/${route}`, {
      method: 'POST', headers: auth(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const freshId = () => `${Date.now()}-${crypto.randomUUID()}`;

  it('serves /turns as a managed binding with the managed key set, plus streaming:false', async () => {
    const token = await start();
    const managed = await (async () => {
      box.binding = null;
      return (await turns(token)).body.chat as Record<string, unknown>;
    })();
    box.binding = binding();
    const { status, body } = await turns(token);
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: true, mode: 'snapshot', hasMore: false });
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(['1.1', '2.1', '2.1:approval']);
    expect(body.events[1]).toMatchObject({ kind: 'tool_use', toolUseId: 't1', argSummary: '/w/a.test.ts' });
    expect(Object.keys(body.chat).sort()).toEqual(Object.keys(managed).sort());
    expect(Object.keys(body.chat.capabilities).sort()).toEqual([...Object.keys(managed.capabilities as object), 'streaming'].sort());
    expect(body.chat).toMatchObject({
      binding: 'managed', agentSessionId: PROVIDER_ID, historyEpoch: `c2:c1:${EPOCH}`,
      capabilities: { history: true, send: false, streaming: false, cancel: false },
    });
    expect(bridge.managedSnapshot).toHaveBeenCalledTimes(1);
  });

  it('answers a carried cursor with a full snapshot and reset, and dir=back with an empty older page', async () => {
    const token = await start();
    const first = await turns(token);
    const forward = await turns(token, `?cursor=${first.body.cursor}`);
    expect(forward.body).toMatchObject({ mode: 'snapshot', reset: true });
    expect(forward.body.events).toHaveLength(3);
    const back = await turns(token, `?cursor=${first.body.cursor}&dir=back`);
    expect(back.body).toMatchObject({ mode: 'older', reset: false, events: [], hasMore: false });
  });

  it('shows the pending driver approval as blocked, by its registry id', async () => {
    approvals.push({
      id: 'apr_1', sessionId: 's1', agent: 'claude', kind: 'terminal_prompt', state: 'pending', createdAt: 1,
      native: { adapter: 'claude', requestId: 'r1', threadId: 'c1', relayId: EPOCH },
    } as unknown as ApprovalRequest);
    const token = await start();
    expect((await turns(token)).body.chat.blocked).toEqual({ by: 'approval', approvalId: 'apr_1' });
  });

  it('refuses a send with 409 managed-read-only and never reaches the bridge', async () => {
    const token = await start();
    const clientMessageId = freshId();
    const { status, body } = await post(token, 'messages', { agentSessionId: PROVIDER_ID, historyEpoch: `c2:c1:${EPOCH}`, clientMessageId, text: 'hi' });
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'managed-read-only', effect: 'none', clientMessageId });
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('refuses a launch into the anchor shell of a v2 pane', async () => {
    const token = await start();
    const clientLaunchId = freshId();
    const { status, body } = await post(token, 'launch', { agent: 'claude', clientLaunchId, prompt: 'hello' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'launch-not-ready', reason: 'agent-running', effect: 'none', clientLaunchId });
    expect(bridge.launch).not.toHaveBeenCalled();
    expect(pane.ptyProcess.write).not.toHaveBeenCalled();
  });

  /** Open `/api/events` and collect the wire until `until` matches or 3 s pass. */
  const sse = async (token: string, headers: Record<string, string> = {}) => {
    const ac = new AbortController();
    const res = await fetch(`${base()}/api/events`, { signal: ac.signal, headers: auth(token, { Accept: 'text/event-stream', ...headers }) });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const box = { wire: '' };
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          box.wire += Buffer.from(chunk.value).toString('utf8');
        }
      } catch { /* aborted */ }
    })();
    const until = async (text: string) => {
      const deadline = Date.now() + 3000;
      while (!box.wire.includes(text) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      return box.wire;
    };
    return { box, until, close: () => ac.abort() };
  };

  it('marks the history truncated whenever the page starts mid-history', async () => {
    let session = conversation();
    for (let i = 0; i < 100; i++) session = applyHarnessEvent(session, { seq: 10 + i, at: 1, event: { type: 'status', text: `s${i}` } });
    box.session = session;
    const token = await start();
    const { body } = await turns(token);
    expect(body.truncatedHead).toBe(true);
    expect(body.chat.historyTruncated).toBe(true);
    box.session = conversation();
    expect((await turns(token)).body.chat.historyTruncated).toBe(false);
  });

  it('refuses a launch the desktop overtook with a chat-v2 record, without typing', async () => {
    box.binding = null;
    bridge.launch.mockImplementation(async (req: { authorized: (stage: string) => Promise<boolean> }) => {
      box.binding = binding({ status: 'starting' }); // the desktop's create reserved the pane meanwhile
      if (!(await req.authorized('first-write'))) return { ok: false, error: 'authorization-expired', effect: 'none' };
      pane.ptyProcess.write('claude\r');
      return { ok: true, effect: 'submitted' };
    });
    const token = await start();
    const clientLaunchId = freshId();
    const { status, body } = await post(token, 'launch', { agent: 'claude', clientLaunchId, prompt: 'hello' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'launch-not-ready', reason: 'agent-running', effect: 'none', clientLaunchId });
    expect(pane.ptyProcess.write).not.toHaveBeenCalled();
    const receipt = await fetch(`${base()}/api/sessions/s1/chat/launch/${clientLaunchId}`, { headers: auth(token) });
    const view = await receipt.json() as { state: string };
    expect(view.state).not.toBe('submitted');
    expect(view.state).not.toBe('pending');
  });

  it('cancels through the host interrupt, replays a retry, and serves the receipt and its SSE', async () => {
    const token = await start();
    await turns(token);
    const events = await sse(token);
    const body = { agentSessionId: PROVIDER_ID, clientCancelId: freshId() };
    const first = await post(token, 'cancel', body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ result: 'sent', replayed: false, turnId: '1.1', clientCancelId: body.clientCancelId,
      effect: 'interrupt-requested', cancel: { state: 'requested', turnId: '1.1' } });
    expect(host.call).toHaveBeenCalledWith('interrupt', { paneId: 's1', chatSessionId: 'c1', epoch: EPOCH, turnId: '1.1' }, 'web');
    const again = await post(token, 'cancel', body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, effect: 'interrupt-requested' });
    expect(host.call).toHaveBeenCalledTimes(1);
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(await events.until('event: chat.cancel')).toContain(`"clientCancelId":"${body.clientCancelId}","state":"requested"`);

    // The turn ends: the push settles the receipt and announces it.
    box.session = applyHarnessEvent(box.session as Session, { seq: 9, at: 2000, event: { type: 'turn.ended', outcome: 'interrupted' } });
    pushListeners[0]({ paneId: 's1', chatSessionId: 'c1', epoch: EPOCH, events: [], blockCount: 2, lastBlockId: '2.1', touchedFrom: 1 });
    expect(await events.until('"state":"ended"')).toContain('"endedAs":"interrupted"');
    events.close();
    const receipt = await fetch(`${base()}/api/sessions/s1/chat/cancel/${body.clientCancelId}`, { headers: auth(token) });
    expect(await receipt.json()).toMatchObject({ clientCancelId: body.clientCancelId, state: 'ended', endedAs: 'interrupted', evidence: 'native', turnId: '1.1' });
  });

  it('announces a driver approval opening and closing as chat.blocked / chat.unblocked', async () => {
    const token = await start();
    await turns(token);
    const events = await sse(token);
    approvals.push({
      id: 'apr_2', sessionId: 's1', agent: 'claude', kind: 'terminal_prompt', state: 'pending', createdAt: 1,
      native: { adapter: 'claude', requestId: 'r1', threadId: 'c1', relayId: EPOCH },
    } as unknown as ApprovalRequest);
    pushListeners[0]({ paneId: 's1', chatSessionId: 'c1', epoch: EPOCH, events: [], blockCount: 2, lastBlockId: '2.1', touchedFrom: 1 });
    expect(await events.until('event: chat.blocked')).toContain('"approvalId":"apr_2"');
    approvals.length = 0;
    pushListeners[0]({ paneId: 's1', chatSessionId: 'c1', epoch: EPOCH, events: [], blockCount: 2, lastBlockId: '2.1', touchedFrom: 1 });
    expect(await events.until('event: chat.unblocked')).toContain('event: chat.unblocked');
    events.close();
  });

  it('ignores a claude approval of another conversation or an earlier load', async () => {
    approvals.push({
      id: 'apr_old', sessionId: 's1', agent: 'claude', kind: 'terminal_prompt', state: 'pending', createdAt: 1,
      native: { adapter: 'claude', requestId: 'r0', threadId: 'c1', relayId: 'b'.repeat(16) },
    } as unknown as ApprovalRequest);
    const token = await start();
    expect((await turns(token)).body.chat.blocked).toBeUndefined();
  });

  it('nudges the pane watchers on a host push', async () => {
    const token = await start();
    await turns(token);
    expect(pushListeners).toHaveLength(1);
    const ac = new AbortController();
    const res = await fetch(`${base()}/api/events`, { signal: ac.signal, headers: auth(token, { Accept: 'text/event-stream' }) });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let wire = '';
    const read = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          wire += Buffer.from(chunk.value).toString('utf8');
          if (wire.includes('transcript.nudge')) break;
        }
      } catch { /* aborted */ }
    })();
    pushListeners[0]({ paneId: 's1', chatSessionId: 'c1', epoch: EPOCH, events: [], blockCount: 3, lastBlockId: '2.1', touchedFrom: 2 });
    await Promise.race([read, new Promise((r) => setTimeout(r, 3000))]);
    ac.abort();
    expect(wire).toContain('event: transcript.nudge');
  });

  it('hands a handed-off record back to the bridge (the TUI now owns the pane)', async () => {
    box.binding = binding({ status: 'handed-off' });
    const token = await start();
    expect((await turns(token)).body.chat.binding).toBe('managed');
    expect(bridge.resolve).toHaveBeenCalled();
    const clientMessageId = freshId();
    await post(token, 'messages', { agentSessionId: 'm-1', historyEpoch: 'm1:x', clientMessageId, text: 'hi' });
    expect(bridge.send).toHaveBeenCalledTimes(1);
  });
});
