// ─── Phone channel Inbox (contract §9) — grants, re-auth, attention ring ────
// Web-layer cases that need a paired device or an approval source: join needs
// the caller's input grant while ack does not; ack re-authenticates after the
// body arrives; and `channel.mention` traffic cannot push a pending approval
// out of the recorded attention ring.

import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { ChannelPhoneApi } from '../channelsApi';
import type { ChannelMentionNotification } from '../../channels/ChannelService';
import type { ApprovalEvent } from '../../approvals/types';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

type DeviceRecord = { secret: string; revoked: boolean; allowInput: boolean };

function makeHarness() {
  const roster = new Map<string, DeviceRecord>();
  let seq = 0;
  const devices: WebDeviceResolver = {
    async mint(params) {
      seq += 1;
      const deviceId = `dev-${seq}`;
      roster.set(deviceId, { secret: `s-${seq}`, revoked: false, allowInput: params.allowInput !== false });
      return { deviceId, deviceSecret: `s-${seq}` };
    },
    resolve(deviceId, secret) {
      const rec = roster.get(deviceId);
      if (!rec || rec.secret !== secret) return { ok: false, reason: 'unknown' };
      if (rec.revoked) return { ok: false, reason: 'revoked' };
      return { ok: true, deviceId, allowInput: rec.allowInput };
    },
  };
  const mentionListeners = new Set<(n: ChannelMentionNotification) => void>();
  const calls = { ack: [] as unknown[], join: [] as string[] };
  const channels: ChannelPhoneApi = {
    list: () => ({ channels: [] }),
    messages: () => ({ ok: true, messages: [], nextSince: 0, oldestRetainedSeq: 1, gap: false }),
    ack: async (id, body) => {
      calls.ack.push(body);
      return { ok: true, lastReadSeq: (body as { lastReadSeq: number }).lastReadSeq };
    },
    join: async (id) => {
      calls.join.push(id);
      return { ok: true, lastReadSeq: 0, alreadyMember: false };
    },
    onMention: (l) => {
      mentionListeners.add(l);
      return () => mentionListeners.delete(l);
    },
  };
  const approvalListeners = new Set<(e: ApprovalEvent) => void>();
  const approvals = {
    list: () => ({ pending: [], recentlyResolved: [] }),
    pendingCount: () => 0,
    resolve: async () => ({ ok: false, reason: 'not-found' }),
    onEvent: (l: (e: ApprovalEvent) => void) => {
      approvalListeners.add(l);
      return () => approvalListeners.delete(l);
    },
  };
  const sessionManager = Object.assign(new EventEmitter(), {
    getSession: () => undefined,
    listLiveSessions: () => [] as [],
  });
  const server = new WebTerminalServer({
    sessionManager: sessionManager as unknown as DaemonSessionManager,
    devices,
    channels,
    approvals: approvals as unknown as NonNullable<ConstructorParameters<typeof WebTerminalServer>[0]['approvals']>,
    log: () => {
      /* silent in tests */
    },
    assetsDir: os.tmpdir(),
  });
  const mention = (channelId: string, s: number): void => {
    for (const l of mentionListeners) l({ channelId, seq: s, fromMemberName: 'worker', text: 'hi', postedAt: 1 });
  };
  const approval = (id: string): void => {
    for (const l of approvalListeners) {
      l({
        type: 'create',
        request: { id, sessionId: 's1', agent: 'claude', kind: 'awaiting_input', createdAt: 1, state: 'pending' },
      } as unknown as ApprovalEvent);
    }
  };
  return { server, roster, calls, mention, approval };
}

const servers: WebTerminalServer[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    if (s.isRunning) await s.stop();
  }
});

async function boot(allowInput: boolean) {
  const h = makeHarness();
  servers.push(h.server);
  const info = await h.server.start({ port: 0, host: '127.0.0.1', allowInput, allowUpload: false });
  const base = `http://127.0.0.1:${h.server.status().port}`;
  const pair = async (deviceInput: boolean) => {
    const started = h.server.startPairing({ name: 'phone', allowInput: deviceInput });
    if (!started.ok) throw new Error('pairing refused');
    const res = await fetch(`${base}/api/pair?code=${started.code}`);
    return (await res.json()) as { deviceId: string; token: string };
  };
  return { ...h, base, operator: info.token as string, pair };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('phone channels — input grant', () => {
  it('a read-only device may ack but not join; a device with the input grant may join', async () => {
    const h = await boot(true);
    const readOnly = await h.pair(false);
    const join = await fetch(`${h.base}/api/channels/ch-1/join`, { method: 'POST', headers: auth(readOnly.token) });
    expect(join.status).toBe(403);
    expect(await join.json()).toEqual({
      error: 'read-only: this device was paired without permission to type',
      detail: 'Joining a channel requires input permission. Grant it from "Paired devices" on the machine running wmux web.',
    });
    expect(h.calls.join).toEqual([]);

    const ack = await fetch(`${h.base}/api/channels/ch-1/ack`, {
      method: 'POST',
      headers: auth(readOnly.token),
      body: '{"lastReadSeq":3}',
    });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ lastReadSeq: 3 });

    const typing = await h.pair(true);
    const granted = await fetch(`${h.base}/api/channels/ch-1/join`, { method: 'POST', headers: auth(typing.token) });
    expect(granted.status).toBe(200);
    expect(h.calls.join).toEqual(['ch-1']);
  });

  it('a read-only server refuses join even for the operator token', async () => {
    const h = await boot(false);
    const join = await fetch(`${h.base}/api/channels/ch-1/join`, { method: 'POST', headers: auth(h.operator) });
    expect(join.status).toBe(403);
    expect(((await join.json()) as { error: string }).error).toBe('read-only: server started without --allow-input');
  });
});

describe('phone channels — ack re-authenticates after the body', () => {
  it('a device revoked while its ack body is in flight gets 401 and the cursor does not move', async () => {
    const h = await boot(false);
    const phone = await h.pair(false);
    let entered!: () => void;
    const authenticated = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lookup = Map.prototype.get.bind(h.roster);
    const spy = vi.spyOn(h.roster, 'get').mockImplementation((id: string) => {
      entered();
      return lookup(id);
    });
    const body = '{"lastReadSeq":3}';
    let request!: ReturnType<typeof httpReq>;
    const status = new Promise<number | undefined>((resolve, reject) => {
      request = httpReq(
        `${h.base}/api/channels/ch-1/ack`,
        { method: 'POST', headers: { ...auth(phone.token), 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      request.on('error', reject);
      request.write(body.slice(0, 5));
    });
    try {
      await authenticated;
      lookup(phone.deviceId)!.revoked = true;
      request.end(body.slice(5));
      expect(await status).toBe(401);
    } finally {
      spy.mockRestore();
      request.destroy();
    }
    expect(h.calls.ack).toEqual([]);
  });
});

describe('channel.mention cannot evict a pending approval', () => {
  type Replay = { reset: boolean; events: Array<Record<string, unknown>> };
  const replay = async (base: string, token: string, since: string): Promise<Replay> =>
    (await (await fetch(`${base}/api/events?since=${since}`, { headers: auth(token) })).json()) as Replay;

  it('a flood on one channel coalesces to its latest mention; the approval stays in replay with no reset', async () => {
    const h = await boot(false);
    h.approval('ap-1');
    for (let i = 1; i <= 250; i += 1) h.mention('ch-busy', i);
    const first = (await (await fetch(`${h.base}/api/events`, { headers: auth(h.operator) })).json()) as Replay & {
      epoch: string;
    };
    const kinds = first.events.map((e) => e.kind);
    expect(kinds).toEqual(['approval', 'channel.mention']);
    expect(first.events[1]).toMatchObject({ channelId: 'ch-busy', seq: 250 });
    // A client that saw nothing yet resumes from 0 without a reset: superseded
    // mentions were coalesced, not lost.
    const resumed = await replay(h.base, h.operator, `${first.epoch}:0`);
    expect(resumed.reset).toBe(false);
    expect(resumed.events.map((e) => e.approvalId ?? e.channelId)).toEqual(['ap-1', 'ch-busy']);
  });

  it('mentions across many channels are capped; the approval survives and a client behind a dropped mention gets reset', async () => {
    const h = await boot(false);
    h.approval('ap-1');
    for (let i = 1; i <= 150; i += 1) h.mention(`ch-${i}`, 1);
    const all = (await (await fetch(`${h.base}/api/events`, { headers: auth(h.operator) })).json()) as Replay & {
      epoch: string;
    };
    expect(all.events.filter((e) => e.kind === 'approval').map((e) => e.approvalId)).toEqual(['ap-1']);
    const mentions = all.events.filter((e) => e.kind === 'channel.mention');
    expect(mentions).toHaveLength(20);
    expect(mentions.at(-1)).toMatchObject({ channelId: 'ch-150' });
    // A cursor at the approval missed dropped mentions: reset, never a silent hole.
    const behind = await replay(h.base, h.operator, `${all.epoch}:${all.events[0].id as number}`);
    expect(behind.reset).toBe(true);
    expect(behind.events.some((e) => e.approvalId === 'ap-1')).toBe(true);
  });
});
