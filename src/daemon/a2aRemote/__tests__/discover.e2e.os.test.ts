// In-process end to end for tailnet discovery: two "PCs" on loopback. A is
// discoverable; B scans, connects, and pairs once A allows. A's `tailnetGate`
// makes B's loopback connections arrive as B's tailnet address, and B dials
// A's tailnet address on loopback; fakes stand in for `tailscale`.
import fs from 'node:fs';
import https from 'node:https';
import type http from 'node:http';
import type net from 'node:net';
import type os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatInvite, parseInvite } from '../../../shared/a2aRemote';
import type { A2aDiscoverConnectResult, A2aDiscoverOutgoingStatus, A2aDiscoverScanResult } from '../../../shared/rpc';
import type { TailnetStatus, TailnetWhois } from '../../../cli/tailscale';
import { DISCOVER_DECIDE_MS } from '../discovery';
import { EXPOSURE_FILE } from '../exposureStore';
import { joinRemoteHost } from '../joiner';
import { registerA2aRemoteRpc } from '../rpc';
import type { TailnetCli } from '../tailnet';
import { disposeAll, makePc, type Pc } from './a2aServerRig';
import { deliberateSleep } from '../../../test-utils/waitFor';

const A_IP = '100.100.1.1';
const B_IP = '100.100.1.2';
const FAST = { connectMs: 2_000, requestMs: 5_000 };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (let close = closers.pop(); close; close = closers.pop()) await close();
  await disposeAll();
});

function tnode(over: Partial<TailnetStatus['self']>): TailnetStatus['self'] {
  return { stableId: '', hostName: '', dnsName: '', os: 'linux', userId: 7, ipv4s: [], online: true, tags: [], sharee: false, ...over };
}

function whoisOf(ip: string, stableId: string, deviceName: string): TailnetWhois {
  return {
    nodeName: `${deviceName}.tail1.ts.net`,
    deviceName,
    os: 'macOS',
    stableId,
    userId: 7,
    tags: [],
    addresses: [`${ip}/32`],
    allowedIps: [`${ip}/32`],
    routableIps: [],
    primaryRoutes: [],
    loginName: 'me@example.com',
    displayName: 'Me',
  };
}

function fakeTailnet(status: TailnetStatus, whois: Record<string, TailnetWhois>): TailnetCli {
  return { status: async () => ({ ok: true, status, bin: 'tailscale' }), whois: async (ip) => whois[ip] ?? null };
}

/** The receiving PC: discoverable once its window opens. */
async function receiver(name: string, opts: { now?: () => number; port?: number } = {}): Promise<Pc> {
  const status: TailnetStatus = {
    backendState: 'Running',
    version: '1.76.6',
    self: tnode({ stableId: 'nA', hostName: 'desk', ipv4s: [A_IP] }),
    selfLogin: 'me@example.com',
    peers: [tnode({ stableId: 'nB', hostName: 'laptop', ipv4s: [B_IP], os: 'macOS' })],
  };
  return makePc(name, {
    ...(opts.port ? { port: opts.port } : {}),
    deps: {
      tailnet: fakeTailnet(status, { [A_IP]: whoisOf(A_IP, 'nA', 'desk'), [B_IP]: whoisOf(B_IP, 'nB', 'laptop') }),
      discoverVersion: () => '9.9.9',
      ...(opts.now ? { now: opts.now } : {}),
      tailnetGate: {
        addressesOf: () => ({ local: A_IP, remote: B_IP }),
        interfaces: () => ({ tailscale0: [{ address: A_IP, family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] }),
        platform: 'linux',
      },
    },
  });
}

/** The requesting PC and its `a2a.remote.discover.*` RPCs, probing `ports()` on loopback. */
async function requester(ports: () => number[], opts: { now?: () => number } = {}) {
  const status: TailnetStatus = {
    backendState: 'Running',
    version: '1.76.6',
    self: tnode({ stableId: 'nB', hostName: 'laptop', ipv4s: [B_IP], os: 'macOS' }),
    selfLogin: 'me@example.com',
    peers: [
      tnode({ stableId: 'nA', hostName: 'desk', dnsName: 'desk.tail1.ts.net', ipv4s: [A_IP], os: 'windows' }),
      tnode({ stableId: 'nPHONE', hostName: 'phone', ipv4s: ['100.100.1.5'], os: 'iOS' }),
      tnode({ stableId: 'nOFF', hostName: 'asleep', ipv4s: ['100.100.1.6'], online: false }),
      tnode({ stableId: 'nFRIEND', hostName: 'friend', ipv4s: ['100.100.1.7'], userId: 8, sharee: true }),
    ],
  };
  const pc = await makePc('PC B', { deps: { tailnet: fakeTailnet(status, {}) } });
  const handlers = new Map<string, (params: Record<string, unknown>, ctx?: { clientId: string }) => Promise<unknown>>();
  const { discover } = registerA2aRemoteRpc((m, h) => handlers.set(m, h), {
    controller: pc.controller,
    server: pc.server,
    peers: pc.peers,
    remoteHosts: pc.remoteHosts,
    cascade: () => undefined,
    log: () => undefined,
    discoverOverrides: {
      ports,
      dial: () => '127.0.0.1',
      // This machine's own interfaces (perhaps a real tailnet address) are not the fake tailnet's.
      interfaces: () => ({}),
      pollMs: 50,
      joinTimeouts: FAST,
      ...(opts.now ? { now: opts.now } : {}),
    },
  });
  const call = (m: string, params: Record<string, unknown> = {}) => handlers.get(`a2a.remote.discover.${m}`)!(params, { clientId: 'b1' });
  return {
    pc,
    discover,
    scan: () => call('scan') as Promise<A2aDiscoverScanResult>,
    connect: (ip: string) => call('connect', { ip }) as Promise<A2aDiscoverConnectResult>,
    outgoing: () => call('outgoing.status') as Promise<A2aDiscoverOutgoingStatus>,
    cancel: () => call('outgoing.cancel') as Promise<A2aDiscoverOutgoingStatus>,
    confirm: () => call('outgoing.confirm') as Promise<A2aDiscoverOutgoingStatus>,
  };
}

const portOf = (pc: Pc): number => pc.server.boundPort() ?? 0;

async function waitOutgoing(b: Awaited<ReturnType<typeof requester>>, state: A2aDiscoverOutgoingStatus['state']): Promise<A2aDiscoverOutgoingStatus> {
  await vi.waitFor(async () => expect((await b.outgoing()).state).toBe(state), { timeout: 10_000 });
  return b.outgoing();
}

describe('tailnet discovery, end to end', () => {
  it('Allow, then this PC’s confirm: both screens show the same code, both PCs record the pairing, nothing is exposed', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)]);

    const scan = await b.scan();
    expect(scan).toMatchObject({
      ok: true,
      checked: 1,
      skipped: { mobile: 1, offline: 1, otherUser: 1, unsupported: 0, overCap: 0 },
      pcs: [{ ip: A_IP, device: 'desk', os: 'windows', login: 'me@example.com', name: 'PC A', version: '9.9.9', state: 'ready', alreadyConnected: false }],
    });

    const connected = await b.connect(A_IP);
    if (!connected.ok) throw new Error(`connect failed: ${connected.error}`);
    expect(connected.code).toMatch(/^\d{6}$/);
    const incoming = a.server.discovery.status().incoming;
    expect(incoming).toMatchObject({ state: 'deciding', code: connected.code, device: { name: 'laptop', ip: B_IP, login: 'me@example.com' } });
    expect(await b.outgoing()).toMatchObject({ state: 'waiting', code: connected.code });

    a.server.discovery.decide(incoming!.requestId, true);
    // Allowed there; nothing pairs until this PC's human confirms the code too.
    expect(await waitOutgoing(b, 'confirm')).toMatchObject({ code: connected.code });
    await deliberateSleep(300, 'a negative check: several poll rounds pass and still nothing pairs');
    expect(a.peers.list()).toEqual([]);
    expect((await b.outgoing()).state).toBe('confirm');
    expect(await b.confirm()).toMatchObject({ state: 'joining' });
    const done = await waitOutgoing(b, 'joined');
    const aId = a.server.status().hostId!;
    const bId = b.pc.server.status().hostId!;
    expect(done.host).toMatchObject({ hostId: aId, name: 'PC A', addresses: [A_IP], port: portOf(a), fingerprint256: a.server.status().fingerprint256 });
    expect(b.pc.remoteHosts.credentialFor(aId)).not.toBeNull();
    expect(a.peers.list()).toEqual([expect.objectContaining({ hostId: bId, name: 'PC B' })]);
    expect(a.server.discovery.status()).toMatchObject({ open: false, ended: { reason: 'paired' } });
    // Nothing is exposed by a pairing: no exposure was ever written.
    expect(fs.existsSync(path.join(a.dir, 'a2a', EXPOSURE_FILE))).toBe(false);
  });

  it('Deny: the requester learns it was denied', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)]);
    await b.scan();
    expect((await b.connect(A_IP)).ok).toBe(true);
    a.server.discovery.decide(a.server.discovery.status().incoming!.requestId, false);
    await waitOutgoing(b, 'denied');
    expect(a.peers.list()).toEqual([]);
  });

  it('a card nobody answers expires on both sides', async () => {
    let skew = 0;
    const a = await receiver('PC A', { now: () => Date.now() + skew });
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)]);
    await b.scan();
    expect((await b.connect(A_IP)).ok).toBe(true);
    skew = DISCOVER_DECIDE_MS;
    await waitOutgoing(b, 'expired');
    expect(a.server.discovery.status()).toMatchObject({ open: true, incoming: null, lastOutcome: { outcome: 'expired' } });
  });

  it('an allowance this PC never confirms expires, and the other PC is told', async () => {
    let skew = 0;
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)], { now: () => Date.now() + skew });
    await b.scan();
    expect((await b.connect(A_IP)).ok).toBe(true);
    a.server.discovery.decide(a.server.discovery.status().incoming!.requestId, true);
    await waitOutgoing(b, 'confirm');
    skew = 61_000;
    await waitOutgoing(b, 'expired');
    // The withdraw voids the code there: the window ends without a pairing.
    await vi.waitFor(() => expect(a.server.discovery.status()).toMatchObject({ open: false, ended: { reason: 'failed' } }), { timeout: 10_000 });
    expect(a.peers.list()).toEqual([]);
    expect(await b.confirm()).toMatchObject({ state: 'expired' });
  });

  it('Cancel during confirm withdraws, and nothing pairs', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)]);
    await b.scan();
    expect((await b.connect(A_IP)).ok).toBe(true);
    a.server.discovery.decide(a.server.discovery.status().incoming!.requestId, true);
    await waitOutgoing(b, 'confirm');
    expect(await b.cancel()).toMatchObject({ state: 'cancelled' });
    expect(a.server.discovery.status()).toMatchObject({ open: false, ended: { reason: 'failed' } });
    expect(a.peers.list()).toEqual([]);
  });

  it('Cancel withdraws the request from the other PC’s card', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)]);
    await b.scan();
    expect((await b.connect(A_IP)).ok).toBe(true);
    expect(await b.cancel()).toMatchObject({ state: 'cancelled' });
    expect(a.server.discovery.status()).toMatchObject({ incoming: null, lastOutcome: { outcome: 'withdrawn', ip: B_IP } });
  });

  it('closing the app connection that asked withdraws the request too', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)]);
    await b.scan();
    expect((await b.connect(A_IP)).ok).toBe(true);
    b.discover.clientGone('someone-else');
    expect((await b.outgoing()).state).toBe('waiting');
    b.discover.clientGone('b1');
    await vi.waitFor(() => expect(a.server.discovery.status().lastOutcome).toMatchObject({ outcome: 'withdrawn' }), { timeout: 10_000 });
  });

  it('a man in the middle with another certificate makes the two codes differ', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const c = await makePc('PC C');
    const id = c.server.ensureIdentity();
    // Terminates TLS with C's certificate and forwards everything to A.
    const mitm = https.createServer({ cert: fs.readFileSync(id.certPath), key: fs.readFileSync(id.keyPath) }, (req, res) => {
      const up = https.request(
        { host: '127.0.0.1', port: portOf(a), method: req.method, path: req.url, headers: req.headers, rejectUnauthorized: false, agent: false },
        (ur: http.IncomingMessage) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      req.pipe(up);
    });
    await new Promise<void>((resolve) => mitm.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => mitm.close(() => resolve())));
    const b = await requester(() => [(mitm.address() as net.AddressInfo).port]);

    expect(await b.scan()).toMatchObject({ ok: true, pcs: [{ ip: A_IP, name: 'PC A' }] });
    const connected = await b.connect(A_IP);
    if (!connected.ok) throw new Error(`connect failed: ${connected.error}`);
    const shown = a.server.discovery.status().incoming;
    expect(shown?.code).toMatch(/^\d{6}$/);
    expect(shown?.code).not.toBe(connected.code);
  });

  it('a certificate that changed between scan and connect fails the pin', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const port = portOf(a);
    const b = await requester(() => [port]);
    expect(await b.scan()).toMatchObject({ ok: true, pcs: [{ ip: A_IP }] });
    // Another PC takes the port the scan saw A on.
    a.controller.configure({ enabled: false });
    await a.server.whenIdle();
    await receiver('PC C', { port });
    expect(await b.connect(A_IP)).toMatchObject({ ok: false, error: 'fingerprint-mismatch' });
  });

  it('refuses an IP the last scan did not list', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)]);
    expect(await b.connect(A_IP)).toMatchObject({ ok: false, error: 'not-found' });
    await b.scan();
    expect(await b.connect('100.100.9.9')).toMatchObject({ ok: false, error: 'not-found' });
    expect(await b.connect('127.0.0.1')).toMatchObject({ ok: false, error: 'not-found' });
    expect(a.server.discovery.status().incoming).toBeNull();
  });

  it('re-pairing through discovery keeps the addresses the pairing already had', async () => {
    const a = await receiver('PC A');
    const b = await requester(() => [portOf(a)]);
    const parsed = parseInvite(a.server.beginPairing().invite);
    if (!parsed.ok) throw new Error('invite did not parse');
    const joined = await joinRemoteHost(formatInvite(parsed.invite), {
      self: () => b.pc.server.ensureIdentity(),
      selfName: 'PC B',
      remoteHosts: b.pc.remoteHosts,
      timeouts: FAST,
    });
    expect(joined).toMatchObject({ ok: true, host: { addresses: ['127.0.0.1'] } });

    await a.server.discovery.open({ turnOn: false });
    expect(await b.scan()).toMatchObject({ ok: true, pcs: [{ ip: A_IP, alreadyConnected: true }] });
    expect((await b.connect(A_IP)).ok).toBe(true);
    a.server.discovery.decide(a.server.discovery.status().incoming!.requestId, true);
    await waitOutgoing(b, 'confirm');
    await b.confirm();
    const done = await waitOutgoing(b, 'joined');
    expect(done.host?.addresses).toEqual([A_IP, '127.0.0.1']);
    expect(b.pc.remoteHosts.get(a.server.status().hostId!)?.addresses).toEqual([A_IP, '127.0.0.1']);
  });

  it('greys a PC that stops answering after two scans and drops it at the third', async () => {
    const a = await receiver('PC A');
    await a.server.discovery.open({ turnOn: false });
    const b = await requester(() => [portOf(a)]);
    expect(await b.scan()).toMatchObject({ ok: true, pcs: [{ ip: A_IP, state: 'ready' }] });
    a.server.discovery.close('stopped');
    expect(await b.scan()).toMatchObject({ ok: true, pcs: [{ ip: A_IP, state: 'ready' }] });
    expect(await b.scan()).toMatchObject({ ok: true, pcs: [{ ip: A_IP, state: 'stale' }] });
    expect(await b.connect(A_IP)).toMatchObject({ ok: false, error: 'not-found' });
    expect(await b.scan()).toMatchObject({ ok: true, pcs: [] });
  });
});
