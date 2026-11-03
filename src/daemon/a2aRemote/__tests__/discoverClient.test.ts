// The requesting side against a scripted receiver: each call it makes is
// answered by a route table here, so a receiver that misbehaves on purpose
// can be played without a listener.
import type os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, formatPeerCredential, type A2aRemoteHostRecordV1 } from '../../../shared/a2aRemote';
import type { TailnetStatus } from '../../../cli/tailscale';
import { DiscoverClient, type DiscoverClientDeps } from '../discoverClient';
import { randomSecret } from '../discoverCode';
import type { JsonClient } from '../joiner';
import { PinnedClientError, type PinnedClientOptions } from '../pinnedClient';
import { deliberateSleep } from '../../../test-utils/waitFor';

const A_IP = '100.100.1.1';
const B_IP = '100.100.1.2';
const FP_A = Array.from({ length: 32 }, () => 'AA').join(':');
const FP_B = Array.from({ length: 32 }, () => 'BB').join(':');
const FP_OTHER = Array.from({ length: 32 }, () => 'CC').join(':');
const A_HOST = '11111111-1111-4111-8111-111111111111';
const B_HOST = '22222222-2222-4222-8222-222222222222';
const PEER_ID = '33333333-3333-4333-8333-333333333333';
const REQ_ID = '44444444-4444-4444-8444-444444444444';

function tnode(over: Partial<TailnetStatus['self']>): TailnetStatus['self'] {
  return { stableId: '', hostName: '', dnsName: '', os: 'windows', userId: 7, ipv4s: [], online: true, tags: [], sharee: false, ...over };
}

const STATUS: TailnetStatus = {
  backendState: 'Running',
  version: '1.76.6',
  self: tnode({ stableId: 'nB', ipv4s: [B_IP], os: 'macOS' }),
  selfLogin: 'me@example.com',
  peers: [tnode({ stableId: 'nA', hostName: 'desk', ipv4s: [A_IP] })],
};

type Route = (body: unknown, opts: PinnedClientOptions) => { status: number; json: unknown };

function makeClient(routes: Record<string, Route>, over: Partial<DiscoverClientDeps> = {}) {
  const calls: Array<{ method: string; path: string; token?: string }> = [];
  const hosts = new Map<string, A2aRemoteHostRecordV1>();
  const client = (opts: PinnedClientOptions): JsonClient => ({
    requestJson: async (method, path, body) => {
      calls.push({ method, path, ...(opts.headers?.['x-wmux-discover-token'] ? { token: opts.headers['x-wmux-discover-token'] } : {}) });
      const route = routes[`${method} ${path}`];
      return route ? route(body, opts) : { status: 404, json: null };
    },
  });
  const deps: DiscoverClientDeps = {
    tailnet: { status: async () => ({ ok: true, status: STATUS, bin: 'tailscale' }), whois: async () => null },
    self: () => ({ hostId: B_HOST, fingerprint256: FP_B }),
    selfName: () => 'PC B',
    ports: () => [45660],
    remoteHosts: {
      list: () => [...hosts.values()],
      get: (hostId) => hosts.get(hostId),
      add: (input) => {
        const rec = { v: 1 as const, createdAt: new Date().toISOString(), ...input };
        hosts.set(input.hostId, rec);
        return rec;
      },
    },
    log: () => undefined,
    interfaces: () => ({}),
    probe: async () => ({ fingerprint256: FP_A, status: 200, json: { discover: 1, protocol: A2A_REMOTE_PROTOCOL, name: 'PC A', version: '9.9.9' } }),
    client,
    pollMs: 10,
    joinTimeouts: { connectMs: 100, requestMs: 100 },
    ...over,
  };
  return { discover: new DiscoverClient(deps), calls, hosts };
}

const TOKEN = randomSecret();
const created: Route = () => ({ status: 201, json: { requestId: REQ_ID, token: TOKEN, nonce: randomSecret(), expiresAt: Date.now() + 10_000 } });
const revealed: Route = () => ({ status: 200, json: { expiresAt: Date.now() + 120_000 } });
const REQUESTS = 'POST /api/a2a/discover/requests';
const REVEAL = `POST /api/a2a/discover/requests/${REQ_ID}/reveal`;
const POLL = `GET /api/a2a/discover/requests/${REQ_ID}`;
const WITHDRAW = `POST /api/a2a/discover/requests/${REQ_ID}/withdraw`;
const ok: Route = () => ({ status: 200, json: { ok: true } });

async function waitState(discover: DiscoverClient, state: string): Promise<void> {
  await vi.waitFor(() => expect(discover.outgoingStatus().state).toBe(state), { timeout: 5_000 });
}

describe('DiscoverClient — what a receiver answers cannot steer the pairing', () => {
  it('a pairing code that is not exactly a code ends the request as a protocol failure, withdrawn', async () => {
    const crafted = `ABCDEFGH#sha256=${FP_OTHER}&alt=203.0.113.7&`;
    const { discover, calls } = makeClient({
      [REQUESTS]: created,
      [REVEAL]: revealed,
      [POLL]: () => ({ status: 200, json: { state: 'allowed', expiresAt: Date.now() + 60_000, code: crafted } }),
      [WITHDRAW]: ok,
    });
    await discover.scan();
    expect((await discover.connect(A_IP)).ok).toBe(true);
    await waitState(discover, 'failed');
    expect(discover.outgoingStatus()).toMatchObject({ state: 'failed', error: 'protocol' });
    await vi.waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(WITHDRAW), { timeout: 5_000 });
    expect(calls.some((c) => c.path === '/api/a2a/pair')).toBe(false);
  });

  it('holds a valid code until confirmed, and never pairs without it', async () => {
    const { discover, calls } = makeClient({
      [REQUESTS]: created,
      [REVEAL]: revealed,
      [POLL]: () => ({ status: 200, json: { state: 'allowed', expiresAt: Date.now() + 60_000, code: 'ABCDEFGH' } }),
    });
    await discover.scan();
    await discover.connect(A_IP);
    await waitState(discover, 'confirm');
    await deliberateSleep(100, 'a negative check: several poll rounds pass and still nothing pairs');
    expect(discover.outgoingStatus().state).toBe('confirm');
    expect(calls.some((c) => c.path === '/api/a2a/pair')).toBe(false);
  });

  it('refuses to re-pair a PC already paired under another certificate', async () => {
    const { discover, hosts } = makeClient({
      [REQUESTS]: created,
      [REVEAL]: revealed,
      [POLL]: () => ({ status: 200, json: { state: 'allowed', expiresAt: Date.now() + 60_000, code: 'ABCDEFGH' } }),
      'POST /api/a2a/pair': () => ({
        status: 200,
        json: { credential: formatPeerCredential({ peerId: PEER_ID, secret: randomSecret() }), hostId: A_HOST, name: 'PC A', protocol: A2A_REMOTE_PROTOCOL },
      }),
      'GET /api/a2a/hello': () => ({ status: 200, json: { hostId: A_HOST, name: 'PC A', protocol: A2A_REMOTE_PROTOCOL } }),
      'POST /api/a2a/unpair': ok,
    });
    hosts.set(A_HOST, { v: 1, hostId: A_HOST, name: 'PC A', addresses: ['10.0.0.4'], port: 45660, fingerprint256: FP_OTHER, peerId: PEER_ID, createdAt: '' });
    await discover.scan();
    await discover.connect(A_IP);
    await waitState(discover, 'confirm');
    discover.confirm();
    await waitState(discover, 'failed');
    expect(discover.outgoingStatus()).toMatchObject({ error: 'fingerprint-mismatch' });
    expect(hosts.get(A_HOST)?.fingerprint256).toBe(FP_OTHER);
  });

  it('a join that fails withdraws the request, so the pairing code dies with it', async () => {
    const { discover, calls } = makeClient({
      [REQUESTS]: created,
      [REVEAL]: revealed,
      [POLL]: () => ({ status: 200, json: { state: 'allowed', expiresAt: Date.now() + 60_000, code: 'ABCDEFGH' } }),
      'POST /api/a2a/pair': () => ({ status: 500, json: { ok: false, error: 'unavailable' } }),
      [WITHDRAW]: ok,
    });
    await discover.scan();
    await discover.connect(A_IP);
    await waitState(discover, 'confirm');
    discover.confirm();
    await waitState(discover, 'failed');
    await vi.waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(WITHDRAW), { timeout: 5_000 });
  });

  it('a reveal that times out withdraws the request, so no card is left up', async () => {
    const { discover, calls } = makeClient({
      [REQUESTS]: created,
      [REVEAL]: () => {
        throw new PinnedClientError('timeout', 'no answer', { sent: true });
      },
      [WITHDRAW]: ok,
    });
    await discover.scan();
    expect(await discover.connect(A_IP)).toMatchObject({ ok: false, error: 'timeout' });
    await vi.waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(WITHDRAW), { timeout: 5_000 });
  });

  it('refuses before asking anything when a pairing at that address has another certificate', async () => {
    const { discover, calls, hosts } = makeClient({ [REQUESTS]: created });
    hosts.set(A_HOST, { v: 1, hostId: A_HOST, name: 'PC A', addresses: [A_IP], port: 45660, fingerprint256: FP_OTHER, peerId: PEER_ID, createdAt: '' });
    await discover.scan();
    expect(await discover.connect(A_IP)).toMatchObject({ ok: false, error: 'fingerprint-mismatch' });
    expect(calls).toEqual([]);
    expect(discover.outgoingStatus().state).toBe('idle');
  });

  it('a cancel while the request is being made withdraws it and reveals nothing', async () => {
    const ref: { discover?: DiscoverClient } = {};
    const made = makeClient({
      [REQUESTS]: (body, opts) => {
        void ref.discover?.cancel();
        return created(body, opts);
      },
      [REVEAL]: revealed,
      [WITHDRAW]: ok,
    });
    const discover = made.discover;
    ref.discover = discover;
    await discover.scan();
    expect(await discover.connect(A_IP)).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(made.calls.map((c) => `${c.method} ${c.path}`)).toContain(WITHDRAW), { timeout: 5_000 });
    expect(made.calls.some((c) => `${c.method} ${c.path}` === REVEAL)).toBe(false);
  });

  it('keeps its own deadlines when the other PC’s clock runs 5 minutes behind, and joins on confirm', async () => {
    const behind = (): number => Date.now() - 300_000;
    const { discover } = makeClient({
      [REQUESTS]: created,
      [REVEAL]: () => ({ status: 200, json: { expiresAt: behind() + 120_000 } }),
      [POLL]: () => ({ status: 200, json: { state: 'allowed', expiresAt: behind() + 60_000, code: 'ABCDEFGH' } }),
      'POST /api/a2a/pair': () => ({
        status: 200,
        json: { credential: formatPeerCredential({ peerId: PEER_ID, secret: randomSecret() }), hostId: A_HOST, name: 'PC A', protocol: A2A_REMOTE_PROTOCOL },
      }),
      'GET /api/a2a/hello': () => ({ status: 200, json: { hostId: A_HOST, name: 'PC A', protocol: A2A_REMOTE_PROTOCOL } }),
    });
    await discover.scan();
    const connected = await discover.connect(A_IP);
    if (!connected.ok) throw new Error('connect failed');
    expect(connected.expiresAt).toBeGreaterThan(Date.now() + 110_000);
    await waitState(discover, 'confirm');
    expect(discover.outgoingStatus().expiresAt).toBeGreaterThan(Date.now() + 55_000);
    await deliberateSleep(100, 'a negative check: several poll rounds pass and the confirm window is still open');
    expect(discover.outgoingStatus().state).toBe('confirm');
    discover.confirm();
    await waitState(discover, 'joined');
  });

  it('a far-future deadline from the other PC does not extend the confirm window', async () => {
    const { discover } = makeClient({
      [REQUESTS]: created,
      [REVEAL]: revealed,
      [POLL]: () => ({ status: 200, json: { state: 'allowed', expiresAt: Date.now() + 365 * 86_400_000, code: 'ABCDEFGH' } }),
    });
    await discover.scan();
    await discover.connect(A_IP);
    await waitState(discover, 'confirm');
    expect(discover.outgoingStatus().expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('clamps the card’s deadline and ends a wait past it, withdrawn', async () => {
    let skew = 0;
    const { discover, calls } = makeClient(
      {
        [REQUESTS]: created,
        [REVEAL]: () => ({ status: 200, json: { expiresAt: Date.now() + 365 * 86_400_000 } }),
        [POLL]: () => ({ status: 200, json: { state: 'waiting', expiresAt: Date.now() + 365 * 86_400_000 } }),
        [WITHDRAW]: ok,
      },
      { now: () => Date.now() + skew },
    );
    await discover.scan();
    const connected = await discover.connect(A_IP);
    if (!connected.ok) throw new Error('connect failed');
    expect(connected.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000 + 1_000);
    skew = 140_000;
    await waitState(discover, 'expired');
    await vi.waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(WITHDRAW), { timeout: 5_000 });
  });

  it('dispose withdraws a live request', async () => {
    const { discover, calls } = makeClient({
      [REQUESTS]: created,
      [REVEAL]: revealed,
      [POLL]: () => ({ status: 200, json: { state: 'waiting', expiresAt: Date.now() + 60_000 } }),
      [WITHDRAW]: ok,
    });
    await discover.scan();
    await discover.connect(A_IP);
    discover.dispose();
    expect(discover.outgoingStatus().state).toBe('cancelled');
    await vi.waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(WITHDRAW), { timeout: 5_000 });
    // The token rode along.
    expect(calls.find((c) => `${c.method} ${c.path}` === WITHDRAW)?.token).toBe(TOKEN);
  });
});

describe('DiscoverClient — scan', () => {
  it('refuses on a LAN that uses the tailnet range, as the receiver does', async () => {
    const { discover } = makeClient({}, { interfaces: () => ({ en0: [{ address: '100.72.0.9', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] }) });
    expect(await discover.scan()).toEqual({ ok: false, reason: 'tailnet-range-on-lan' });
  });
});
