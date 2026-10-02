// ─── Phone channel Inbox (contract §9) web-layer tests ──────────────────────
// Covers the web-owned cases of test plan 2026-09-13-phone-channels-inbox.md:
// D3 (HTTP query validation + default/max limit), D8 (backlog replay —
// id:number/epoch:UUID), D10 (503 when the seam is absent), plus seam error →
// HTTP status mapping. Route status mapping is checked with a fake
// ChannelPhoneApi; query validation and paging with the real adapter
// (makeChannelPhoneApi + ChannelService) — same split as the approvals seam tests.

import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer } from '../WebTerminalServer';
import { makeChannelPhoneApi, type ChannelPhoneApi, type PhoneChannelsResult } from '../channelsApi';
import {
  ChannelService,
  type ChannelMentionNotification,
  type ChannelServiceEmit,
  type PhoneChannelMessage,
} from '../../channels/ChannelService';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { type ChannelState } from '../../../shared/channels';

// ── Real service (legacy mode) — for D3 adapter checks ──────────────────────

function makeFakeWriter() {
  let lastSaved: ChannelState | null = null;
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      lastSaved = state;
      return true;
    }),
    load: vi.fn((): ChannelState =>
      lastSaved
        ? structuredClone(lastSaved)
        : { version: 1, channels: [], members: {}, messages: {}, idempotency: {} },
    ),
  };
}

function makeRealService() {
  return new ChannelService({
    writer: makeFakeWriter() as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: 'co-test',
    emit: vi.fn<ChannelServiceEmit>(),
    now: () => 1_700_000_000_000,
  });
}

// ── Fake seam — for route status-code mapping checks ────────────────────────

function makeChannelsFake() {
  const listeners = new Set<(n: ChannelMentionNotification) => void>();
  const box = {
    listBody: { channels: [] as unknown[] },
    messagesResult: null as PhoneChannelsResult<{ messages: PhoneChannelMessage[]; nextSince: number }> | null,
    ackResult: null as PhoneChannelsResult<{ lastReadSeq: number }> | null,
    joinResult: null as PhoneChannelsResult<{ lastReadSeq: number; alreadyMember: boolean }> | null,
  };
  const calls = {
    messages: [] as Array<[string, string | null, string | null]>,
    ack: [] as Array<[string, unknown]>,
    join: [] as string[],
  };
  const channels: ChannelPhoneApi = {
    list: () => box.listBody as ReturnType<ChannelPhoneApi['list']>,
    messages: (id, since, limit) => {
      calls.messages.push([id, since, limit]);
      return box.messagesResult!;
    },
    ack: async (id, body) => {
      calls.ack.push([id, body]);
      return box.ackResult!;
    },
    join: async (id) => {
      calls.join.push(id);
      return box.joinResult!;
    },
    onMention: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emitMention = (n: ChannelMentionNotification): void => {
    for (const l of listeners) l(n);
  };
  return { channels, box, calls, emitMention, listeners };
}

// ── Server harness — minimal deps + optional channels seam ──────────────────

const servers: WebTerminalServer[] = [];

function makeServer(channels?: ChannelPhoneApi): WebTerminalServer {
  const sessionManager = Object.assign(new EventEmitter(), {
    getSession: () => undefined,
    listLiveSessions: () => [] as [],
  });
  const server = new WebTerminalServer({
    sessionManager: sessionManager as unknown as DaemonSessionManager,
    log: () => {
      /* silent in tests */
    },
    assetsDir: os.tmpdir(),
    ...(channels ? { channels } : {}),
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    if (s.isRunning) await s.stop();
  }
});

async function start(server: WebTerminalServer) {
  const info = await server.start({
    port: 0,
    host: '127.0.0.1',
    allowInput: false,
    allowUpload: false,
  });
  return {
    base: `http://127.0.0.1:${server.status().port}`,
    headers: { Authorization: `Bearer ${info.token}` },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── D10: seam absent → 503 ──────────────────────────────────────────────────

describe('phone channels routes — seam absent (D10)', () => {
  it('without a channels seam all 4 routes return 503 {error:"channels-unavailable"}', async () => {
    const server = makeServer(); // no channels injected
    const { base, headers } = await start(server);

    const list = await fetch(`${base}/api/channels`, { headers });
    expect(list.status).toBe(503);
    expect(await list.json()).toEqual({ error: 'channels-unavailable' });

    const messages = await fetch(`${base}/api/channels/ch-1/messages`, { headers });
    expect(messages.status).toBe(503);
    expect(await messages.json()).toEqual({ error: 'channels-unavailable' });

    const ack = await fetch(`${base}/api/channels/ch-1/ack`, {
      method: 'POST',
      headers,
      body: '{"lastReadSeq":3}',
    });
    expect(ack.status).toBe(503);
    expect(await ack.json()).toEqual({ error: 'channels-unavailable' });

    const join = await fetch(`${base}/api/channels/ch-1/join`, { method: 'POST', headers });
    expect(join.status).toBe(503);
    expect(await join.json()).toEqual({ error: 'channels-unavailable' });
  });
});

// ── /api/config capability flag ─────────────────────────────────────────────

describe('/api/config channels flag', () => {
  it('advertises channels: true with the seam wired, and omits the key without it', async () => {
    const wired = await start(makeServer(makeChannelsFake().channels));
    const on = (await (await fetch(`${wired.base}/api/config`, { headers: wired.headers })).json()) as Record<string, unknown>;
    expect(on.channels).toBe(true);

    const bare = await start(makeServer());
    const off = (await (await fetch(`${bare.base}/api/config`, { headers: bare.headers })).json()) as Record<string, unknown>;
    expect('channels' in off).toBe(false);
  });
});

// ── Route status-code mapping (fake seam) ───────────────────────────────────

describe('phone channels routes — seam result → HTTP mapping', () => {
  it('list 200 returns the seam body as-is; messages passes the raw query to the seam', async () => {
    const { channels, box, calls } = makeChannelsFake();
    const server = makeServer(channels);
    const { base, headers } = await start(server);

    box.listBody = {
      channels: [{ channelId: 'ch-1', visibility: 'public', lastSeq: 9, lastPost: null }],
    };
    const list = await fetch(`${base}/api/channels`, { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(box.listBody);

    box.messagesResult = {
      ok: true,
      messages: [{ seq: 5 }] as unknown as PhoneChannelMessage[],
      nextSince: 5,
    };
    const res = await fetch(`${base}/api/channels/ch-1/messages?since=4&limit=7`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [{ seq: 5 }], nextSince: 5 });
    // The route does not parse — raw strings as-is (null when absent).
    expect(calls.messages).toEqual([['ch-1', '4', '7']]);
  });

  it('404 not-found / 400 no-seat (+detail) / 400 archived / join success shape', async () => {
    const { channels, box } = makeChannelsFake();
    const server = makeServer(channels);
    const { base, headers } = await start(server);

    box.messagesResult = { ok: false, error: { status: 404, error: 'not-found' } };
    const missing = await fetch(`${base}/api/channels/ch-x/messages`, { headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not-found' });

    box.ackResult = { ok: false, error: { status: 400, error: 'no-seat', detail: 'No human seat' } };
    const noSeat = await fetch(`${base}/api/channels/ch-1/ack`, {
      method: 'POST',
      headers,
      body: '{"lastReadSeq":3}',
    });
    expect(noSeat.status).toBe(400);
    expect(await noSeat.json()).toEqual({ error: 'no-seat', detail: 'No human seat' });

    box.joinResult = { ok: false, error: { status: 400, error: 'archived' } };
    const archived = await fetch(`${base}/api/channels/ch-1/join`, { method: 'POST', headers });
    expect(archived.status).toBe(400);
    expect(await archived.json()).toEqual({ error: 'archived' });

    box.joinResult = { ok: true, lastReadSeq: 7, alreadyMember: true };
    const join = await fetch(`${base}/api/channels/ch-1/join`, { method: 'POST', headers });
    expect(join.status).toBe(200);
    expect(await join.json()).toEqual({ lastReadSeq: 7, alreadyMember: true });
  });
});

// ── D8: mention → recorded event, backlog replay ────────────────────────────

describe('channel.mention — recorded attention event (D8)', () => {
  it('subscribes in start(); a mention lands in the recorded log and is reached via ?since= replay — id:number, epoch:UUID, tier:act', async () => {
    const { channels, emitMention, listeners } = makeChannelsFake();
    const server = makeServer(channels);
    const { base, headers } = await start(server);

    // start() subscribed to the seam (approvals onEvent pattern).
    expect(listeners.size).toBe(1);

    emitMention({
      channelId: 'ch-9',
      seq: 139,
      fromMemberName: 'worker',
      text: 'deploy done',
      postedAt: 1757700000000,
    });

    const first = await fetch(`${base}/api/events`, { headers });
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      epoch: string;
      headId: number;
      reset: boolean;
      events: Array<Record<string, unknown>>;
    };
    const ev = body.events.find((e) => e.kind === 'channel.mention');
    expect(ev).toMatchObject({
      channelId: 'ch-9',
      seq: 139,
      fromMemberName: 'worker',
      text: 'deploy done',
      postedAt: 1757700000000,
      tier: 'act', // server-authoritative — always act (contract §9)
    });
    // id is a number, epoch a UUID string (§9 correction: <epoch>:<id> cursor).
    expect(typeof ev!.id).toBe('number');
    expect(body.epoch).toMatch(UUID_RE);

    // Backlog replay: re-requesting from just before the cursor reaches it; at the cursor it is excluded.
    const id = ev!.id as number;
    const replay = await fetch(`${base}/api/events?since=${body.epoch}:${id - 1}`, { headers });
    const replayBody = (await replay.json()) as { events: Array<Record<string, unknown>> };
    expect(replayBody.events.some((e) => e.kind === 'channel.mention')).toBe(true);
    const caught = await fetch(`${base}/api/events?since=${body.epoch}:${id}`, { headers });
    const caughtBody = (await caught.json()) as { events: Array<Record<string, unknown>> };
    expect(caughtBody.events.some((e) => e.kind === 'channel.mention')).toBe(false);

    // stop() unsubscribes (no listener leak).
    await server.stop();
    expect(listeners.size).toBe(0);
  });
});

// ── D3: real adapter — query validation and paging ──────────────────────────

describe('makeChannelPhoneApi — query validation and paging (D3)', () => {
  it('malformed since/limit → 400 invalid-cursor; values within bounds pass validation', () => {
    const api = makeChannelPhoneApi(makeRealService());
    const invalid = { ok: false, error: { status: 400, error: 'invalid-cursor' } };
    expect(api.messages('ch-x', 'abc', null)).toMatchObject(invalid);
    expect(api.messages('ch-x', '-1', null)).toMatchObject(invalid);
    expect(api.messages('ch-x', '1.5', null)).toMatchObject(invalid);
    expect(api.messages('ch-x', null, '0')).toMatchObject(invalid);
    expect(api.messages('ch-x', null, '201')).toMatchObject(invalid);
    expect(api.messages('ch-x', null, 'x')).toMatchObject(invalid);
    // Within bounds (1..200) passes validation — then falls through to the service 404.
    expect(api.messages('ch-x', '5', '200')).toMatchObject({
      ok: false,
      error: { status: 404, error: 'not-found' },
    });
  });

  it('ack body validation — 400 invalid-body unless lastReadSeq is a non-negative integer', async () => {
    const api = makeChannelPhoneApi(makeRealService());
    const invalid = { ok: false, error: { status: 400, error: 'invalid-body' } };
    await expect(api.ack('ch-x', { lastReadSeq: -1 })).resolves.toMatchObject(invalid);
    await expect(api.ack('ch-x', { lastReadSeq: '3' })).resolves.toMatchObject(invalid);
    await expect(api.ack('ch-x', { lastReadSeq: 1.5 })).resolves.toMatchObject(invalid);
    await expect(api.ack('ch-x', {})).resolves.toMatchObject(invalid);
    await expect(api.ack('ch-x', null)).resolves.toMatchObject(invalid);
  });

  it('default limit 50 — of 60, the first page has 50 (oldest-first), then 10', async () => {
    const svc = makeRealService();
    const created = await svc.create({
      name: 'pub',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1' },
      verifiedWorkspaceId: 'ws-agent',
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    for (let i = 1; i <= 60; i++) {
      const res = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-agent', memberId: 'agent-1' },
        text: `m${i}`,
        verifiedWorkspaceId: 'ws-agent',
      });
      if (!res.ok) throw new Error(`post failed: ${res.error.code}`);
    }
    const api = makeChannelPhoneApi(svc);

    const p1 = api.messages(created.channel.id, null, null);
    expect(p1.ok && p1.messages).toHaveLength(50);
    expect(p1.ok && p1.messages[0].seq).toBe(1);
    expect(p1.ok && p1.messages[49].seq).toBe(50);
    expect(p1.ok && p1.nextSince).toBe(50);

    const p2 = api.messages(created.channel.id, '50', null);
    expect(p2.ok && p2.messages.map((m) => m.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => 51 + i),
    );
    expect(p2.ok && p2.nextSince).toBe(60);
  });
});
