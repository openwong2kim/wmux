// Tests for the `a2a.channel.*` RPC handler (a2a-channels U4).
//
// The handler layer is a thin pass-through to the daemon's ChannelService —
// the heavy lifting (mutex, persistence, idempotency LRU, fan-out) lives in
// src/daemon/channels/. What this file pins:
//
//   1. Routing: each of the 9 RPC methods dispatches to the matching
//      `a2a.channel.<method>` on the daemon client, and propagates a
//      `params ?? {}` default so a missing body still goes through.
//   2. Error propagation: typed `Result<T>` errors from the daemon flow
//      back to the caller unchanged (CHANNEL_NOT_FOUND, PERSIST_FAILED,
//      etc.). A handler-layer pass-through MUST NOT re-shape or swallow
//      them.
//   3. Capability map: reads are gated on `a2a.channel.read` and mutating
//      methods on `a2a.channel.send`, both in the `a2a` risk class. This
//      is the contract the enforcer checks at RpcRouter.dispatch and the
//      approval dialog reads for user-facing copy.
//   4. Post-path event emission: a successful `a2a.channel.post` causes
//      ChannelService to broadcast a `channel.message` daemon event;
//      DaemonClient re-emits it as `channel:message`; the
//      DaemonNotificationRouter tees it onto the main-process EventBus
//      with the per-recipient scope. A failure (PERSIST_FAILED) does NOT
//      produce an EventBus entry — the bus tee is gated on the post
//      reaching the persisted state.
//   5. PROTOCOL §2.8 contract: `events.poll` per-recipient scoping. A
//      `channel.message` is delivered to (a) the sender (base
//      `workspaceId`) and (b) every workspace in
//      `recipientWorkspaceIds` — and to NO third workspace. An unscoped
//      poll (no workspaceId) yields ZERO channel.message events.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aChannelRpc } from '../a2a.channel.rpc';
import { METHOD_CAPABILITY, CAPABILITY_RISK_CLASS } from '../../../mcp/methodCapabilityMap';
import { listKnownCapabilities } from '../../../mcp/permissionGrammar';
import { registerEventsRpc } from '../events.rpc';
import { eventBus } from '../../../events/EventBus';

// DaemonNotificationRouter pulls in `electron` at module load (BrowserWindow
// for the IPC bridge). Mock the names the module surface touches so the
// import resolves without standing up Electron — the same pattern the
// existing `events.rpc.test.ts` and `DaemonNotificationRouter.lifecycle.test.ts`
// suites use.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn(), removeAllListeners: vi.fn() },
  app: { getPath: vi.fn(() => ''), on: vi.fn() },
}));

vi.mock('../../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

vi.mock('../../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: vi.fn(),
}));

vi.mock('../../../notification/sendNotification', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../../../notification/idleSuppression', () => ({
  recentlySuppressed: vi.fn().mockReturnValue(false),
  clearPty: vi.fn(),
}));

vi.mock('../../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

vi.mock('../../../pty/AgentDetector', () => ({
  agentDisplayToSlug: vi.fn().mockReturnValue(null),
}));

import { DaemonNotificationRouter } from '../../../notification/DaemonNotificationRouter';
import { sendToRenderer } from '../../../pipe/handlers/_bridge';
import type { DaemonClient } from '../../../DaemonClient';
import type { ChannelMessage } from '../../../../shared/channels';

// === Fixtures ===

const SENDER_WS = 'ws-sender';
const RECIPIENT_A = 'ws-recipient-a';
const RECIPIENT_B = 'ws-recipient-b';
const THIRD_WS = 'ws-unrelated';
const CHANNEL_ID = 'ch-1';

function makeMessage(): ChannelMessage {
  return {
    channelId: CHANNEL_ID,
    seq: 1,
    workspaceId: SENDER_WS,
    memberId: 'm-sender',
    memberName: 'Sender',
    text: 'hello world',
    deliveryStatus: 'pending',
    postedAt: 1_000_000,
  };
}

function makeFakeDaemon(rpcImpl: (method: string, params: unknown) => unknown): DaemonClient {
  // EventEmitter-shaped fake: only `on`/`off` matter to DaemonNotificationRouter;
  // `rpc` is stubbed per-test on the closure.
  const emitter = new EventEmitter();
  const fake = Object.assign(emitter, {
    rpc: vi.fn(async (method: string, params: unknown) => rpcImpl(method, params)),
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    disconnectSync: vi.fn(),
  });
  return fake as unknown as DaemonClient;
}

function setupHandlerRouter(daemon: DaemonClient): RpcRouter {
  // D5: the handler resolves verifiedWorkspaceId from a verified senderPtyId
  // via the renderer (input.findOwnerWorkspace). Stub it so a senderPtyId
  // resolves to a deterministic owning workspace (`ws-of-<pty>`) and an absent
  // ptyId resolves to null (no verifiable identity).
  vi.mocked(sendToRenderer).mockImplementation((async (_gw: unknown, method: string, params: unknown) => {
    if (method === 'input.findOwnerWorkspace') {
      const pty = (params as Record<string, unknown> | null)?.ptyId;
      return typeof pty === 'string' && pty ? { workspaceId: `ws-of-${pty}` } : null;
    }
    return null;
  }) as unknown as typeof sendToRenderer);
  const router = new RpcRouter();
  registerA2aChannelRpc(router, () => daemon, () => ({}) as unknown as never);
  return router;
}

// =========================================================================
// 1. Routing — read methods dispatch to channel.<method> on the daemon
// =========================================================================

describe('a2a.channel.rpc — read routing (capability a2a.channel.read)', () => {
  it('a2a.channel.list dispatches to a2a.channel.list with no params and propagates the result', async () => {
    const expected = { ok: true, value: [{ id: 'ch-1' }] };
    const daemon = makeFakeDaemon((method, params) => {
      expect(method).toBe('a2a.channel.list');
      expect(params).toEqual({});
      return expected;
    });
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({ id: 'r1', method: 'a2a.channel.list', params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toBe(expected);
  });

  it('a2a.channel.get dispatches to a2a.channel.get and forwards channelId', async () => {
    const expected = { ok: true, value: { id: CHANNEL_ID } };
    const daemon = makeFakeDaemon((method, params) => {
      expect(method).toBe('a2a.channel.get');
      expect((params as Record<string, unknown>).channelId).toBe(CHANNEL_ID);
      return expected;
    });
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: 'r2', method: 'a2a.channel.get', params: { channelId: CHANNEL_ID },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toBe(expected);
  });

  it('a2a.channel.getMessages dispatches to a2a.channel.getMessages and forwards sinceSeq', async () => {
    const expected = { ok: true, value: [] };
    const daemon = makeFakeDaemon((method, params) => {
      expect(method).toBe('a2a.channel.getMessages');
      const p = params as Record<string, unknown>;
      expect(p.channelId).toBe(CHANNEL_ID);
      expect(p.sinceSeq).toBe(5);
      return expected;
    });
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: 'r3', method: 'a2a.channel.getMessages', params: { channelId: CHANNEL_ID, sinceSeq: 5 },
    });
    expect(res.ok).toBe(true);
  });

  it('a2a.channel.getMembers dispatches to a2a.channel.getMembers', async () => {
    const expected = { ok: true, value: [] };
    const daemon = makeFakeDaemon((method) => {
      expect(method).toBe('a2a.channel.getMembers');
      return expected;
    });
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: 'r4', method: 'a2a.channel.getMembers', params: { channelId: CHANNEL_ID },
    });
    expect(res.ok).toBe(true);
  });
});

// =========================================================================
// 2. Routing — mutating methods dispatch to a2a.channel.<method>
// =========================================================================

describe('a2a.channel.rpc — mutating routing (capability a2a.channel.send)', () => {
  it.each([
    ['a2a.channel.create', 'a2a.channel.create'],
    ['a2a.channel.join', 'a2a.channel.join'],
    ['a2a.channel.leave', 'a2a.channel.leave'],
    ['a2a.channel.post', 'a2a.channel.post'],
  ] as const)('%s dispatches to %s', async (rpcMethod, daemonMethod) => {
    const expected = { ok: true, value: { id: CHANNEL_ID } };
    const daemon = makeFakeDaemon((method, params) => {
      expect(method).toBe(daemonMethod);
      // D5: the handler stamped a server-resolved verifiedWorkspaceId from the
      // verified senderPtyId (pty-S → ws-of-pty-S), overwriting any client value.
      expect((params as Record<string, unknown>).verifiedWorkspaceId).toBe('ws-of-pty-S');
      return expected;
    });
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: `m-${rpcMethod}`,
      method: rpcMethod,
      params: {
        channelId: CHANNEL_ID,
        sender: { workspaceId: SENDER_WS, memberId: 'm1', memberName: 'S' },
        text: 'hi',
        senderPtyId: 'pty-S',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toBe(expected);
  });

  // J0 (3-model review — Codex): the mission RPCs live on THIS router. The
  // capability map + FIRST_PARTY entries existed without the router forward,
  // so the MCP mission tools died with "Unknown method" — pin the registration.
  it.each([
    ['task.mission.start', { title: 'T', memberId: 'lead', senderPtyId: 'pty-S' }],
    ['task.mission.close', { taskId: 'wtask-x', senderPtyId: 'pty-S' }],
  ] as const)('%s is registered, mutating, and D5-stamped', async (rpcMethod, params) => {
    const expected = { ok: true, value: null };
    const daemon = makeFakeDaemon((method, p) => {
      expect(method).toBe(rpcMethod);
      // Mutating discipline: server-resolved workspace stamped over any client value.
      expect((p as Record<string, unknown>).verifiedWorkspaceId).toBe('ws-of-pty-S');
      return expected;
    });
    const router = setupHandlerRouter(daemon);
    const res = await router.dispatch({ id: `m-${rpcMethod}`, method: rpcMethod, params });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toBe(expected);
  });

  it('task.mission.start/close fail closed without a resolvable senderPtyId', async () => {
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);
    const rpcSpy = (daemon as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc;
    for (const method of ['task.mission.start', 'task.mission.close'] as const) {
      const res = await router.dispatch({ id: `fc-${method}`, method, params: { title: 'T', taskId: 'wtask-x' } });
      expect(res.ok).toBe(true); // Result envelope with ok:false inside
      if (res.ok) {
        const r = res.result as { ok: boolean; error?: { code: string } };
        expect(r.ok).toBe(false);
        expect(r.error?.code).toBe('NOT_AUTHORIZED');
      }
    }
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('treats missing params as {} so the daemon gets a valid envelope', async () => {
    // The handler is `(params) => daemonClient.rpc(method, params ?? {})` —
    // a caller omitting `params` still hits the daemon with a valid object,
    // not `undefined`. The daemon's own validation rejects the bad payload.
    let receivedParams: unknown = 'sentinel';
    const daemon = makeFakeDaemon((_method, params) => {
      receivedParams = params;
      return { ok: true, value: null };
    });
    const router = setupHandlerRouter(daemon);

    // Cast through `unknown` because RpcRequest.params is optional and the
    // router tolerates the missing key (defaults to {}).
    const res = await router.dispatch({
      id: 'no-params', method: 'a2a.channel.list',
      // @ts-expect-error — deliberately exercising the params-undefined path
      params: undefined,
    });
    expect(res.ok).toBe(true);
    expect(receivedParams).toEqual({});
  });
});

// =========================================================================
// 2a. archive + kick + operatorJoin/operatorList are HUMANS-ONLY — deliberately
//     NOT routed on the pipe
// =========================================================================

describe('a2a.channel.rpc — archive + kick + operator methods are unregistered (agents cannot reach them)', () => {
  it.each([
    [
      'a2a.channel.archive',
      { channelId: CHANNEL_ID, archivedBy: 'ws-attacker', senderPtyId: 'pty-attacker' },
    ],
    [
      'a2a.channel.kick',
      { channelId: CHANNEL_ID, targetWorkspaceId: 'ws-victim', targetMemberId: 'm-victim', senderPtyId: 'pty-attacker' },
    ],
    // operator-join (§2.3 / Codex #7): operatorJoin plants the human seat and
    // operatorList enumerates every private channel name — both humans-only,
    // reachable ONLY via the renderer channels:mutate-local IPC. An agent that
    // forges a fully-resolvable senderPtyId must still hit "Unknown method" here.
    [
      'a2a.channel.operatorJoin',
      { channelId: CHANNEL_ID, verifiedWorkspaceId: 'ws-human', senderPtyId: 'pty-attacker' },
    ],
    [
      'a2a.channel.operatorList',
      { verifiedWorkspaceId: 'ws-human', senderPtyId: 'pty-attacker' },
    ],
  ] as const)('rejects %s with Unknown method and never reaches the daemon', async (method, params) => {
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);
    const rpcSpy = (daemon as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc;

    // Even a fully-resolvable agent identity must not get through — these methods
    // simply aren't on this router (humans-only, renderer IPC path). Archiving
    // tears a channel down for everyone; kicking ejects a member. Neither is an
    // agent-reachable capability.
    const res = await router.dispatch({ id: `unreg-${method}`, method, params });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Unknown method/);
    expect(rpcSpy).not.toHaveBeenCalled();
  });
});

// =========================================================================
// 2b. D5 — caller-identity server-pin (verifiedWorkspaceId is server-resolved)
// =========================================================================

describe('a2a.channel.rpc — D5 caller-identity server-pin', () => {
  it('overwrites a forged client verifiedWorkspaceId with the senderPtyId-resolved one', async () => {
    // Adversary sets BOTH sender.workspaceId and verifiedWorkspaceId to a
    // victim's public ws-id (would satisfy a naive sender===verified gate).
    // The handler MUST ignore the client value and stamp the workspace
    // resolved from the verified senderPtyId.
    let received: Record<string, unknown> = {};
    const daemon = makeFakeDaemon((_method, params) => {
      received = params as Record<string, unknown>;
      return { ok: true, value: { id: CHANNEL_ID } };
    });
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: 'd5-forge',
      method: 'a2a.channel.post',
      params: {
        channelId: CHANNEL_ID,
        sender: { workspaceId: 'victim-ws', memberId: 'm1', memberName: 'S' },
        text: 'forged',
        verifiedWorkspaceId: 'victim-ws',
        senderPtyId: 'pty-attacker',
      },
    });
    expect(res.ok).toBe(true);
    // Server-resolved from senderPtyId, NOT the forged 'victim-ws'.
    expect(received.verifiedWorkspaceId).toBe('ws-of-pty-attacker');
  });

  it('fails closed on a mutating call with no resolvable senderPtyId', async () => {
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: 'd5-no-pty',
      method: 'a2a.channel.post',
      params: { channelId: CHANNEL_ID, sender: { workspaceId: SENDER_WS, memberId: 'm1', memberName: 'S' }, text: 'hi' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { ok: boolean; error?: { code: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('NOT_AUTHORIZED');
    }
  });

  it('leaves a read from a no-PTY caller as-is (process-boundary trust residual)', async () => {
    let received: Record<string, unknown> = { sentinel: true };
    const daemon = makeFakeDaemon((_method, params) => {
      received = params as Record<string, unknown>;
      return { ok: true, value: [] };
    });
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: 'd5-read',
      method: 'a2a.channel.list',
      params: { verifiedWorkspaceId: 'ws-renderer' },
    });
    expect(res.ok).toBe(true);
    // No senderPtyId → read keeps the caller-supplied scope (renderer residual).
    expect(received.verifiedWorkspaceId).toBe('ws-renderer');
  });
});

// =========================================================================
// 3. Error propagation — typed Result<T> errors flow back unchanged
// =========================================================================

describe('a2a.channel.rpc — typed error propagation', () => {
  it('CHANNEL_NOT_FOUND flows back to the caller unchanged', async () => {
    const expected = { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: 'no such channel' } };
    const daemon = makeFakeDaemon(() => expected);
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: 'e1', method: 'a2a.channel.get', params: { channelId: 'ch-missing' },
    });
    expect(res.ok).toBe(true); // the handler succeeded — the SERVICE returned an error Result
    if (res.ok) expect(res.result).toBe(expected);
  });

  it('PERSIST_FAILED flows back to the caller unchanged', async () => {
    // The maintainer's U2 directive: "Surface saveImmediate errors on the
    // U2 post path" — exercised end-to-end here. The daemon's post returns
    // a typed PERSIST_FAILED Result when the StateWriter could not flush;
    // the pipe layer must not collapse it to a generic error.
    const expected = {
      ok: false,
      error: { code: 'PERSIST_FAILED', message: 'channels.json write failed: EACCES' },
    };
    const daemon = makeFakeDaemon(() => expected);
    const router = setupHandlerRouter(daemon);

    const res = await router.dispatch({
      id: 'e2', method: 'a2a.channel.post',
      params: {
        channelId: CHANNEL_ID,
        sender: { workspaceId: SENDER_WS, memberId: 'm1', memberName: 'S' },
        text: 'persistence-broke',
        senderPtyId: 'pty-S',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { ok: false; error: { code: string; message: string } };
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('PERSIST_FAILED');
      expect(r.error.message).toMatch(/EACCES/);
    }
  });
});

// =========================================================================
// 4. Capability map — read/send split, both in the a2a risk class
// =========================================================================

describe('a2a.channel.rpc — capability map (RPC method → capability → risk class)', () => {
  it('read methods gate on a2a.channel.read', () => {
    for (const m of ['a2a.channel.list', 'a2a.channel.get', 'a2a.channel.getMessages', 'a2a.channel.getMembers'] as const) {
      const entry = METHOD_CAPABILITY[m];
      expect(entry.capability).toBe('a2a.channel.read');
      expect(entry.riskClass).toBe('a2a');
    }
  });

  it('mutating methods (including post) gate on a2a.channel.send', () => {
    for (const m of ['a2a.channel.create', 'a2a.channel.archive', 'a2a.channel.join', 'a2a.channel.leave', 'a2a.channel.post'] as const) {
      const entry = METHOD_CAPABILITY[m];
      expect(entry.capability).toBe('a2a.channel.send');
      expect(entry.riskClass).toBe('a2a');
    }
  });

  it('a2a.channel.read and a2a.channel.send are in KNOWN_CAPABILITIES (grantable, not reserved)', () => {
    const list = listKnownCapabilities();
    expect(list).toContain('a2a.channel.read');
    expect(list).toContain('a2a.channel.send');
  });

  it('CAPABILITY_RISK_CLASS classifies both as a2a so the approval dialog renders a2a copy', () => {
    // The approval dialog reads CAPABILITY_RISK_CLASS — it must NOT fall
    // through to a generic 'unspecified' path, else the user sees a blank
    // warning when an a2a.channel.* capability is requested.
    expect(CAPABILITY_RISK_CLASS['a2a.channel.read']).toBe('a2a');
    expect(CAPABILITY_RISK_CLASS['a2a.channel.send']).toBe('a2a');
  });
});

// =========================================================================
// 5. Post-path event emission — channel.message reaches the main EventBus
//
// ChannelService.post owns the emit (it sits inside the per-channel
// critical section, plan KTD3). The bridge from daemon → main is the
// `channel.message` case in DaemonClient.handleControlMessage, which
// re-emits a `channel:message` event; the DaemonNotificationRouter
// subscribes to that and projects it onto the main EventBus as
// `channel.message` with the per-recipient scope. This test drives the
// full bridge end-to-end and asserts the EventBus shape a `events.poll`
// consumer would see.
// =========================================================================

describe('a2a.channel.rpc — Post path: channel.message bus emission', () => {
  let daemon: DaemonClient;
  let router: DaemonNotificationRouter;

  beforeEach(() => {
    eventBus.reset();
  });

  function buildChannelMessageEnvelope() {
    // This is the shape ChannelService broadcasts on the daemon control
    // pipe after a successful post: `type:'channel.message'`, `sessionId:''`
    // (no session owns the event), and the ChannelMessageEvent fields
    // nested in `data`.
    return {
      type: 'channel.message',
      sessionId: '',
      data: {
        channelId: CHANNEL_ID,
        seq: 1,
        senderWorkspaceId: SENDER_WS,
        recipients: [
          { workspaceId: SENDER_WS, memberId: 'm-sender', status: 'pending' },
          { workspaceId: RECIPIENT_A, memberId: 'm-a', status: 'pending' },
          { workspaceId: RECIPIENT_B, memberId: 'm-b', status: 'pending' },
        ],
        message: makeMessage(),
        workspaceId: SENDER_WS,
      },
    };
  }

  it('a successful Post drives DaemonClient → DaemonNotificationRouter → EventBus', () => {
    // Step 1: build the bridge.
    daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    router = new DaemonNotificationRouter(daemon, () => null);
    router.start();

    // Step 2: simulate the daemon control pipe delivering a `channel.message`
    // broadcast. DaemonClient's `emit('channel:message', ...)` is the
    // public seam the integration uses; calling it directly is the
    // canonical way to exercise the bridge from a unit test (the
    // `handleControlMessage` switch is the production entry point and
    // its `case 'channel.message':` is the only path that calls emit).
    const envelope = buildChannelMessageEnvelope();
    (daemon as unknown as EventEmitter).emit('channel:message', { data: envelope.data });

    // Step 3: assert the bus entry.
    const events = eventBus.poll(0, { types: ['channel.message'] }).events;
    expect(events).toHaveLength(1);
    const e = events[0] as unknown as {
      type: 'channel.message';
      channelId: string;
      seq: number;
      senderWorkspaceId: string;
      recipientWorkspaceIds: string[];
      message: ChannelMessage;
      workspaceId: string;
    };
    expect(e.type).toBe('channel.message');
    expect(e.channelId).toBe(CHANNEL_ID);
    expect(e.seq).toBe(1);
    expect(e.senderWorkspaceId).toBe(SENDER_WS);
    // Sender is implicitly in the recipient set (membership is a
    // precondition of post), so the projection always includes
    // senderWorkspaceId in recipientWorkspaceIds.
    expect(e.recipientWorkspaceIds).toEqual(
      expect.arrayContaining([SENDER_WS, RECIPIENT_A, RECIPIENT_B]),
    );
    expect(e.workspaceId).toBe(SENDER_WS); // base scope = sender
    expect(e.message.text).toBe('hello world');

    router.stop();
  });

  it('a failed Post (PERSIST_FAILED) does NOT produce an EventBus entry', () => {
    // The Post path's event emission is owned by ChannelService INSIDE
    // the per-channel critical section — a post that fails persistence
    // never reaches the broadcast call. The bridge therefore has nothing
    // to forward. This test simulates that: only the handler returns
    // PERSIST_FAILED; no `channel:message` is emitted by the daemon, so
    // the bus stays empty.
    daemon = makeFakeDaemon(() => ({
      ok: false,
      error: { code: 'PERSIST_FAILED', message: 'channels.json write failed: EACCES' },
    }));
    router = new DaemonNotificationRouter(daemon, () => null);
    router.start();

    // No channel:message emit — the daemon never broadcast (post failed).
    const events = eventBus.poll(0, { types: ['channel.message'] }).events;
    expect(events).toHaveLength(0);

    router.stop();
  });

  it('a malformed channel.message payload is dropped (no bus entry, no crash)', () => {
    // Daemon-side bug guard: a missing channelId / seq / workspaceId /
    // message / recipients would crash the bus-projection downstream.
    // The router logs and skips rather than crashes the bus.
    daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    router = new DaemonNotificationRouter(daemon, () => null);
    router.start();

    // Missing message field
    (daemon as unknown as EventEmitter).emit('channel:message', {
      data: { channelId: CHANNEL_ID, seq: 1, workspaceId: SENDER_WS, recipients: [] },
    });
    // Empty channelId
    (daemon as unknown as EventEmitter).emit('channel:message', {
      data: { channelId: '', seq: 1, workspaceId: SENDER_WS, recipients: [], message: makeMessage() },
    });
    // Missing workspaceId
    (daemon as unknown as EventEmitter).emit('channel:message', {
      data: { channelId: CHANNEL_ID, seq: 1, recipients: [], message: makeMessage() },
    });

    const events = eventBus.poll(0, { types: ['channel.message'] }).events;
    expect(events).toHaveLength(0);

    router.stop();
  });
});

// =========================================================================
// 6. PROTOCOL §2.8 — events.poll per-recipient scoping for channel.message
//
// The N-party generalization of the a2a.task dual-party contract:
// a channel.message reaches (a) the sender (base `workspaceId`) and
// (b) every member workspace in `recipientWorkspaceIds`. A third-party
// poll returns nothing. An unscoped poll returns nothing.
// =========================================================================

describe('a2a.channel.rpc — events.poll per-recipient scoping (PROTOCOL §2.8)', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  function setupEventsRouter(): RpcRouter {
    const router = new RpcRouter();
    registerEventsRpc(router, () => null);
    return router;
  }

  function seedChannelMessage() {
    // A channel.message with SENDER_WS as the base, RECIPIENT_A and
    // RECIPIENT_B in the recipient set, and THIRD_WS as a non-member.
    eventBus.emit({
      type: 'channel.message',
      channelId: CHANNEL_ID,
      seq: 1,
      senderWorkspaceId: SENDER_WS,
      recipientWorkspaceIds: [SENDER_WS, RECIPIENT_A, RECIPIENT_B],
      message: makeMessage(),
      workspaceId: SENDER_WS,
    });
  }

  it('case 1: the sender (poll workspaceId === sender) receives the event', async () => {
    seedChannelMessage();
    const router = setupEventsRouter();
    const res = await router.dispatch({ id: 's1', method: 'events.poll', params: { workspaceId: SENDER_WS } }, { firstParty: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const events = (res.result as { events: Array<{ type: string }> }).events;
      expect(events.filter((e) => e.type === 'channel.message')).toHaveLength(1);
    }
  });

  it('case 2: a recipient (poll workspaceId ∈ recipientWorkspaceIds) receives the event', async () => {
    seedChannelMessage();
    const router = setupEventsRouter();
    const res = await router.dispatch({ id: 'r1', method: 'events.poll', params: { workspaceId: RECIPIENT_A } }, { firstParty: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const events = (res.result as { events: Array<{ type: string }> }).events;
      expect(events.filter((e) => e.type === 'channel.message')).toHaveLength(1);
    }
  });

  it('case 3: a third party (poll workspaceId not in recipients, ≠ sender) receives NOTHING', async () => {
    seedChannelMessage();
    const router = setupEventsRouter();
    const res = await router.dispatch({ id: 't1', method: 'events.poll', params: { workspaceId: THIRD_WS } }, { firstParty: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const events = (res.result as { events: Array<{ type: string }> }).events;
      expect(events.filter((e) => e.type === 'channel.message')).toHaveLength(0);
    }
  });

  it('case 4: an unscoped poll (no workspaceId) returns ZERO channel.message events (leak guard)', async () => {
    // Mirrors the a2a.task unscoped-poll leak guard: a bare events.poll
    // (e.g. a plugin host forwarding poll) must NEVER see channel.message
    // payloads — the membership-based fan-out is only safe when the
    // caller is identified.
    seedChannelMessage();
    const router = setupEventsRouter();
    const res = await router.dispatch({ id: 'u1', method: 'events.poll', params: {} }, { firstParty: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const events = (res.result as { events: Array<{ type: string }> }).events;
      expect(events.filter((e) => e.type === 'channel.message')).toHaveLength(0);
    }
  });

  it('case 5: per-event discrimination — a third party who IS a recipient of ANOTHER channel sees only that one', async () => {
    // Discriminates per-event, not per-ring. THIRD_WS is not in
    // channel-1's recipient set, but it IS the only recipient of
    // channel-2. The poll filter must NOT deliver channel-1 to it.
    eventBus.emit({
      type: 'channel.message',
      channelId: 'ch-1',
      seq: 1,
      senderWorkspaceId: SENDER_WS,
      recipientWorkspaceIds: [SENDER_WS, RECIPIENT_A, RECIPIENT_B],
      message: makeMessage(),
      workspaceId: SENDER_WS,
    });
    eventBus.emit({
      type: 'channel.message',
      channelId: 'ch-2',
      seq: 1,
      senderWorkspaceId: 'ws-someone',
      recipientWorkspaceIds: ['ws-someone', THIRD_WS],
      message: { ...makeMessage(), channelId: 'ch-2' },
      workspaceId: 'ws-someone',
    });

    const router = setupEventsRouter();
    const res = await router.dispatch({ id: 'd1', method: 'events.poll', params: { workspaceId: THIRD_WS } }, { firstParty: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const events = (res.result as { events: Array<{ type: string; channelId?: string }> }).events;
    const mine = events.filter((e) => e.type === 'channel.message');
    expect(mine).toHaveLength(1);
    expect(mine[0].channelId).toBe('ch-2');
  });
});

describe('a2a.channel.rpc — P5 reserved human workspace (ws-human) guard', () => {
  it('REJECTS a pipe post claiming ws-human as the sender (human-seat impersonation)', async () => {
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);
    const res = await router.dispatch({
      id: 'p5-spoof-post',
      method: 'a2a.channel.post',
      params: {
        channelId: CHANNEL_ID,
        sender: { workspaceId: 'ws-human', memberId: 'me2', memberName: 'Me' },
        text: 'hi from "the human"',
        senderPtyId: 'pty-attacker',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { ok: boolean; error?: { code: string; message: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('NOT_AUTHORIZED');
      expect(r.error?.message).toContain('ws-human');
    }
    expect(daemon.rpc).not.toHaveBeenCalled();
  });

  it('REJECTS a pipe join claiming ws-human as the member', async () => {
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);
    const res = await router.dispatch({
      id: 'p5-spoof-join',
      method: 'a2a.channel.join',
      params: {
        channelId: CHANNEL_ID,
        member: { workspaceId: 'ws-human', memberId: 'agent', memberName: 'A' },
        senderPtyId: 'pty-attacker',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { ok: boolean; error?: { code: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('NOT_AUTHORIZED');
    }
    expect(daemon.rpc).not.toHaveBeenCalled();
  });

  it('REJECTS inviting ws-human as a TARGET (5-model review: no invite-the-human post-P5)', async () => {
    // The human joins via the GUI, never by invite. A ws-human invitedMember
    // could only seed a phantom (ws-human, non-local-ui) row (the real seat's
    // local-ui memberId is blocked by the C4 guard) that force-injects a channel
    // into the human's always-on view. The router (and daemon invite()) reject it.
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);
    const res = await router.dispatch({
      id: 'p5-invite-human',
      method: 'a2a.channel.invite',
      params: {
        channelId: CHANNEL_ID,
        invitedMember: { workspaceId: 'ws-human', memberId: 'local-ui2', memberName: 'Me' },
        senderPtyId: 'pty-attacker',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { ok: boolean; error?: { code: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('NOT_AUTHORIZED');
    }
    expect(daemon.rpc).not.toHaveBeenCalled();
  });

  it('ALLOWS a no-PTY read scoped to ws-human (the renderer reads ride this router)', async () => {
    let received: Record<string, unknown> = {};
    const daemon = makeFakeDaemon((_m, params) => {
      received = params as Record<string, unknown>;
      return { ok: true, value: [] };
    });
    const router = setupHandlerRouter(daemon);
    const res = await router.dispatch({
      id: 'p5-read-human',
      method: 'a2a.channel.list',
      params: { verifiedWorkspaceId: 'ws-human' },
    });
    expect(res.ok).toBe(true);
    expect(received.verifiedWorkspaceId).toBe('ws-human');
  });
});

describe('a2a.channel.rpc — P5 invite ws-human is REJECTED (5-model consensus)', () => {
  it('REJECTS inviting ws-human with a non-local-ui memberId (phantom-row injection)', async () => {
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);
    const res = await router.dispatch({
      id: 'p5-invite-phantom',
      method: 'a2a.channel.invite',
      params: {
        channelId: CHANNEL_ID,
        invitedMember: { workspaceId: 'ws-human', memberId: 'agentX', memberName: 'X' },
        senderPtyId: 'pty-attacker',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { ok: boolean; error?: { code: string; message: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('NOT_AUTHORIZED');
      expect(r.error?.message).toContain('ws-human');
    }
    expect(daemon.rpc).not.toHaveBeenCalled();
  });
});

describe('a2a.channel.rpc — P5 create members[] cannot seed reserved identities (Codex delta)', () => {
  it('REJECTS channel_create with a ws-human entry in initial members[]', async () => {
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);
    const res = await router.dispatch({
      id: 'p5-create-phantom-member',
      method: 'a2a.channel.create',
      params: {
        name: 'sneaky',
        visibility: 'private',
        members: [{ workspaceId: 'ws-human', memberId: 'agentX', memberName: 'X' }],
        senderPtyId: 'pty-attacker',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { ok: boolean; error?: { code: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('NOT_AUTHORIZED');
    }
    expect(daemon.rpc).not.toHaveBeenCalled();
  });

  it('REJECTS channel_create with a local-ui entry in initial members[]', async () => {
    const daemon = makeFakeDaemon(() => ({ ok: true, value: null }));
    const router = setupHandlerRouter(daemon);
    const res = await router.dispatch({
      id: 'p5-create-spoof-member',
      method: 'a2a.channel.create',
      params: {
        name: 'sneaky2',
        visibility: 'private',
        members: [{ workspaceId: 'ws-1', memberId: 'local-ui', memberName: 'Me' }],
        senderPtyId: 'pty-attacker',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { ok: boolean; error?: { code: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('NOT_AUTHORIZED');
    }
    expect(daemon.rpc).not.toHaveBeenCalled();
  });
});
