import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aDiscoverPoll, type A2aDiscoverRequestCreated } from '../../../shared/a2aRemote';
import type { TailnetStatus, TailnetWhois } from '../../../cli/tailscale';
import type { DaemonConfig } from '../../types';
import { A2aRemoteController } from '../controller';
import { discoverCode, discoverCommit, randomSecret } from '../discoverCode';
import {
  DISCOVER_COMMIT_MS,
  DISCOVER_DECIDE_MS,
  DISCOVER_GRANT_MS,
  DISCOVER_MINT_MS,
  DISCOVER_MISS_REFRESH_MS,
  DISCOVER_PROBES_PER_MINUTE,
  DISCOVER_WINDOW_MS,
  DISCOVERY_MARKER_FILE,
  DiscoveryWindow,
  judgeTailnetSource,
  parseRouteInterface,
  revertDiscoveryTurnOn,
  routeInterface,
  snapshotFromStatus,
  type DiscoverAnswer,
  type DiscoveryDeps,
} from '../discovery';
import type { TailnetCli } from '../tailnet';

const SELF_IP = '100.100.1.1';
const PEER_IP = '100.100.1.2';
const OTHER_USER_IP = '100.100.1.3';
const SELF_HOST = '11111111-1111-4111-8111-111111111111';
const PEER_HOST = '22222222-2222-4222-8222-222222222222';
const FS = Array.from({ length: 32 }, () => 'AA').join(':');
const FR = Array.from({ length: 32 }, () => 'BB').join(':');

function node(over: Partial<TailnetStatus['self']>): TailnetStatus['self'] {
  return { stableId: '', hostName: '', dnsName: '', os: 'linux', userId: 7, ipv4s: [], online: true, tags: [], sharee: false, ...over };
}

function tailnetStatus(): TailnetStatus {
  return {
    backendState: 'Running',
    version: '1.76.6',
    self: node({ stableId: 'nSELF', hostName: 'recv', ipv4s: [SELF_IP] }),
    selfLogin: 'me@example.com',
    peers: [
      node({ stableId: 'nPEER', hostName: 'asker', ipv4s: [PEER_IP], os: 'macOS' }),
      node({ stableId: 'nOTHER', hostName: 'friend', ipv4s: [OTHER_USER_IP], userId: 8, sharee: true }),
    ],
  };
}

function whoisFor(ip: string, over: Partial<TailnetWhois> = {}): TailnetWhois {
  return {
    nodeName: 'asker.tail1.ts.net',
    deviceName: 'asker',
    os: 'macOS',
    stableId: `n-${ip}`,
    userId: 7,
    tags: [],
    addresses: [`${ip}/32`],
    allowedIps: [`${ip}/32`],
    routableIps: [],
    primaryRoutes: [],
    loginName: 'me@example.com',
    displayName: 'Me',
    ...over,
  };
}

function nic(address: string, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null } as os.NetworkInterfaceInfo;
}

interface Rig {
  win: DiscoveryWindow;
  controller: A2aRemoteController;
  dir: string;
  whois: Map<string, TailnetWhois | null>;
  statusCalls: { n: number };
  listening: { value: boolean };
  /** Set one to hold that call until it resolves. */
  holds: { status?: Promise<void>; whois?: Promise<void>; idle?: Promise<void> };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const dirs: string[] = [];

function makeRig(opts: { enabled?: boolean; deps?: Partial<DiscoveryDeps>; status?: () => TailnetStatus | null } = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-discovery-'));
  dirs.push(dir);
  const config = { a2aRemote: { enabled: opts.enabled ?? true } } as unknown as DaemonConfig;
  const controller = new A2aRemoteController({ config, persist: () => undefined });
  const whois = new Map<string, TailnetWhois | null>([
    [SELF_IP, whoisFor(SELF_IP, { stableId: 'nSELF' })],
    [PEER_IP, whoisFor(PEER_IP)],
    [OTHER_USER_IP, whoisFor(OTHER_USER_IP, { userId: 8 })],
  ]);
  const statusCalls = { n: 0 };
  const holds: Rig['holds'] = {};
  const tailnet: TailnetCli = {
    status: async () => {
      statusCalls.n += 1;
      await holds.status;
      const s = (opts.status ?? tailnetStatus)();
      return s ? { ok: true, status: s, bin: 'tailscale' } : { ok: false, check: { id: 'installed', state: 'fail', reason: 'not-installed', fix: 'download' } };
    },
    whois: async (ip) => {
      await holds.whois;
      return whois.get(ip) ?? null;
    },
  };
  const listening = { value: true };
  const win = new DiscoveryWindow({
    tailnet,
    controller,
    dataDir: dir,
    listener: {
      whenIdle: async () => {
        await holds.idle;
      },
      status: () => ({
        enabled: controller.current().enabled,
        port: 45660,
        listening: controller.current().enabled && listening.value,
        hostId: SELF_HOST,
        name: 'RECV',
        fingerprint256: FS,
        lastError: listening.value ? null : 'EADDRINUSE',
        lastErrorCode: listening.value ? null : 'EADDRINUSE',
        lastErrorPort: listening.value ? null : 45660,
      }),
      identity: () => (controller.current().enabled && listening.value ? { hostId: SELF_HOST, fingerprint256: FS } : null),
      name: () => 'RECV',
    },
    livePeerName: () => null,
    version: () => '9.9.9',
    now: () => Date.now(),
    log: () => undefined,
    interfaces: () => ({ tailscale0: [nic(SELF_IP)], eth0: [nic('192.168.1.20')] }),
    platform: 'linux',
    ...opts.deps,
  });
  return { win, controller, dir, whois, statusCalls, listening, holds };
}

const route = (win: DiscoveryWindow, method: string, p: string, source = PEER_IP, token?: string, body?: unknown) =>
  win.route({ method, path: p, source, token, readBody: async () => body });

function requestBody(nonceR: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocol: A2A_REMOTE_PROTOCOL, hostId: PEER_HOST, name: 'Asker', fingerprint256: FR, commit: discoverCommit(nonceR), ...over };
}

/** Request, then reveal; the requester's own code. */
async function ask(win: DiscoveryWindow, source = PEER_IP): Promise<{ created: A2aDiscoverRequestCreated; code: string }> {
  const nonceR = randomSecret();
  const res = (await route(win, 'POST', '/api/a2a/discover/requests', source, undefined, requestBody(nonceR))) as DiscoverAnswer;
  expect(res.status).toBe(201);
  const created = res.body as A2aDiscoverRequestCreated;
  const revealed = (await route(win, 'POST', `/api/a2a/discover/requests/${created.requestId}/reveal`, source, created.token, { nonce: nonceR })) as DiscoverAnswer;
  expect(revealed.status).toBe(200);
  const code = discoverCode({ nonceS: created.nonce, nonceR, fingerprintS: FS, fingerprintR: FR, hostIdR: PEER_HOST });
  return { created, code };
}

async function poll(win: DiscoveryWindow, created: A2aDiscoverRequestCreated, source = PEER_IP): Promise<A2aDiscoverPoll> {
  const res = (await route(win, 'GET', `/api/a2a/discover/requests/${created.requestId}`, source, created.token)) as DiscoverAnswer;
  expect(res.status).toBe(200);
  return res.body as A2aDiscoverPoll;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('judgeTailnetSource — the synchronous source gate', () => {
  const snap = snapshotFromStatus(tailnetStatus());

  it('accepts a listed same-user node reaching this PC on its tailnet address, IPv4-mapped or not', () => {
    expect(judgeTailnetSource(snap, SELF_IP, PEER_IP)).toBe('accept');
    expect(judgeTailnetSource(snap, `::ffff:${SELF_IP}`, `::ffff:${PEER_IP}`)).toBe('accept');
  });

  it('refuses this PC as the source, a LAN source and a connection to a LAN address', () => {
    expect(judgeTailnetSource(snap, SELF_IP, SELF_IP)).toBe('refuse');
    expect(judgeTailnetSource(snap, SELF_IP, '192.168.1.30')).toBe('refuse');
    expect(judgeTailnetSource(snap, '192.168.1.20', PEER_IP)).toBe('refuse');
    expect(judgeTailnetSource(snap, '0.0.0.0', PEER_IP)).toBe('refuse');
  });

  it('calls a tailnet address the snapshot does not list unknown (worth one re-read)', () => {
    expect(judgeTailnetSource(snap, SELF_IP, '100.100.9.9')).toBe('unknown');
  });

  it('refuses a listed node that may not ask (another user’s) outright, with no re-read', () => {
    expect(judgeTailnetSource(snap, SELF_IP, OTHER_USER_IP)).toBe('refuse');
    expect([...snap.excludedIps]).toEqual([OTHER_USER_IP]);
  });

  it('lists only this user’s untagged, not shared-in nodes, never this PC', () => {
    const s = tailnetStatus();
    s.peers.push(node({ stableId: 'nTAG', ipv4s: ['100.100.1.4'], tags: ['tag:ci'] }), node({ stableId: 'nDUP', ipv4s: [SELF_IP] }));
    expect([...snapshotFromStatus(s).peerIps]).toEqual([PEER_IP]);
  });
});

describe('parseRouteInterface', () => {
  it('reads the interface line of route -n get', () => {
    expect(parseRouteInterface('   route to: 100.100.1.2\ndestination: 100.100.1.2\n  interface: utun4\n      flags: <UP,HOST>\n')).toBe('utun4');
    expect(parseRouteInterface('route: writing to routing socket: not in table')).toBeNull();
  });
});

describe('DiscoveryWindow — opening', () => {
  it('refuses when Tailscale is not ready, with the checklist item', async () => {
    const { win } = makeRig({ status: () => null });
    expect(await win.open({ turnOn: true })).toMatchObject({ ok: false, reason: 'tailscale-not-ready', check: { reason: 'not-installed' } });
  });

  it('refuses without a tailnet IPv4', async () => {
    const { win } = makeRig({ status: () => ({ ...tailnetStatus(), self: node({ stableId: 'nSELF', ipv4s: [] }) }) });
    expect(await win.open({ turnOn: true })).toMatchObject({ ok: false, reason: 'no-tailnet-ipv4' });
  });

  it('refuses on a LAN that uses the tailnet range', async () => {
    const { win } = makeRig({ deps: { interfaces: () => ({ tailscale0: [nic(SELF_IP)], eth0: [nic('100.72.0.9')] }) } });
    expect(await win.open({ turnOn: true })).toMatchObject({ ok: false, reason: 'tailnet-range-on-lan' });
  });

  it('refuses when whois --json does not answer for this PC (Tailscale too old)', async () => {
    const rig = makeRig();
    rig.whois.set(SELF_IP, null);
    expect(await rig.win.open({ turnOn: true })).toMatchObject({ ok: false, reason: 'tailscale-whois-unsupported' });
  });

  it('turns A2A on only when asked, and leaves a marker while it is on because of the window', async () => {
    const rig = makeRig({ enabled: false });
    expect(await rig.win.open({ turnOn: false })).toMatchObject({ ok: false, reason: 'a2a-off' });
    expect(rig.controller.current().enabled).toBe(false);
    const opened = await rig.win.open({ turnOn: true });
    expect(opened).toMatchObject({ ok: true, status: { open: true, turnedOn: true, name: 'RECV' } });
    expect(rig.controller.current().enabled).toBe(true);
    expect(fs.existsSync(path.join(rig.dir, DISCOVERY_MARKER_FILE))).toBe(true);
  });

  it('turns A2A off again when the listener cannot start, reporting the problem found before that', async () => {
    const seen: Array<{ failure: unknown; enabled: boolean }> = [];
    const report = { problem: { kind: 'port-in-use' as const, port: 45660 }, holder: { kind: 'wmux' as const, pid: 42 }, suggestion: 45661 };
    const rig = makeRig({
      enabled: false,
      deps: {
        diagnoseListen: async (failure) => {
          seen.push({ failure, enabled: rig.controller.current().enabled });
          return report;
        },
      },
    });
    rig.listening.value = false;
    expect(await rig.win.open({ turnOn: true })).toMatchObject({ ok: false, reason: 'listen-failed', listen: { lastErrorCode: 'EADDRINUSE', report } });
    // Diagnosed while A2A was still on, for the port that failed.
    expect(seen).toEqual([{ failure: { code: 'EADDRINUSE', port: 45660, address: null }, enabled: true }]);
    expect(rig.controller.current().enabled).toBe(false);
    expect(fs.existsSync(path.join(rig.dir, DISCOVERY_MARKER_FILE))).toBe(false);
  });
});

describe('DiscoveryWindow — lifetime and reverting', () => {
  it('ends after 5 minutes with nobody asking, and turns A2A off again', async () => {
    const rig = makeRig({ enabled: false });
    await rig.win.open({ turnOn: true });
    vi.advanceTimersByTime(DISCOVER_WINDOW_MS);
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'timeout' } });
    expect(rig.controller.current().enabled).toBe(false);
    expect(fs.existsSync(path.join(rig.dir, DISCOVERY_MARKER_FILE))).toBe(false);
  });

  it('leaves an A2A it did not turn on as it was', async () => {
    const rig = makeRig({ enabled: true });
    await rig.win.open({ turnOn: true });
    rig.win.close('stopped');
    expect(rig.controller.current().enabled).toBe(true);
  });

  it('does not turn A2A off after a settings change it did not make', async () => {
    const rig = makeRig({ enabled: false });
    await rig.win.open({ turnOn: true });
    rig.controller.configure({ port: 45999 });
    expect(fs.existsSync(path.join(rig.dir, DISCOVERY_MARKER_FILE))).toBe(false);
    rig.win.close('stopped');
    expect(rig.controller.current().enabled).toBe(true);
  });

  it('does not turn A2A off after a PC paired through an invite', async () => {
    const rig = makeRig({ enabled: false });
    await rig.win.open({ turnOn: true });
    rig.win.keepA2aOn();
    rig.win.close('stopped');
    expect(rig.controller.current().enabled).toBe(true);
  });

  it('ends when the app connection that opened it goes away, and only then', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true }, 'c7');
    win.clientGone('c8');
    expect(win.status().open).toBe(true);
    win.clientGone('c7');
    expect(win.status()).toMatchObject({ open: false, ended: { reason: 'disconnected' } });
  });

  it('a marker left at boot turns A2A off and goes', () => {
    const rig = makeRig({ enabled: true });
    fs.writeFileSync(path.join(rig.dir, DISCOVERY_MARKER_FILE), '{"v":1}');
    revertDiscoveryTurnOn(rig.controller, rig.dir, () => undefined);
    expect(rig.controller.current().enabled).toBe(false);
    expect(fs.existsSync(path.join(rig.dir, DISCOVERY_MARKER_FILE))).toBe(false);
  });

  it('a boot without a marker changes nothing', () => {
    const rig = makeRig({ enabled: true });
    revertDiscoveryTurnOn(rig.controller, rig.dir, () => undefined);
    expect(rig.controller.current().enabled).toBe(true);
  });
});

describe('DiscoveryWindow — the source gate', () => {
  it('lets in only a listed node on this PC’s tailnet address, and nothing once closed', async () => {
    const { win } = makeRig();
    expect(win.accepts(SELF_IP, PEER_IP, 'GET', '/api/a2a/discover')).toBe(false);
    await win.open({ turnOn: true });
    expect(win.accepts(SELF_IP, PEER_IP, 'GET', '/api/a2a/discover')).toBe(true);
    expect(win.accepts('192.168.1.20', PEER_IP, 'GET', '/api/a2a/discover')).toBe(false);
    expect(win.accepts(SELF_IP, '192.168.1.30', 'GET', '/api/a2a/discover')).toBe(false);
    win.close('stopped');
    expect(win.accepts(SELF_IP, PEER_IP, 'GET', '/api/a2a/discover')).toBe(false);
  });

  it('re-reads the status in the background for an unknown tailnet source, at most every 5 s', async () => {
    let extra = false;
    const rig = makeRig({
      status: () => {
        const s = tailnetStatus();
        if (extra) s.peers.push(node({ stableId: 'nNEW', ipv4s: ['100.100.1.9'] }));
        return s;
      },
    });
    await rig.win.open({ turnOn: true });
    const before = rig.statusCalls.n;
    extra = true;
    // Right after the open's own read, a miss reads nothing.
    expect(rig.win.accepts(SELF_IP, '100.100.1.9', 'GET', '/api/a2a/discover')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.statusCalls.n).toBe(before);
    vi.advanceTimersByTime(DISCOVER_MISS_REFRESH_MS);
    expect(rig.win.accepts(SELF_IP, '100.100.1.9', 'GET', '/api/a2a/discover')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.statusCalls.n).toBe(before + 1);
    expect(rig.win.accepts(SELF_IP, '100.100.1.9', 'GET', '/api/a2a/discover')).toBe(true);
    // A LAN source never triggers a read.
    rig.win.accepts(SELF_IP, '192.168.1.30', 'GET', '/api/a2a/discover');
    rig.win.accepts(SELF_IP, '100.100.7.7', 'GET', '/api/a2a/discover');
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.statusCalls.n).toBe(before + 1);
  });
});

describe('DiscoveryWindow — requests', () => {
  it('answers the probe with exactly four keys, 30 a minute per source', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true });
    const res = (await route(win, 'GET', '/api/a2a/discover')) as DiscoverAnswer;
    expect(res).toEqual({ status: 200, body: { discover: 1, protocol: A2A_REMOTE_PROTOCOL, name: 'RECV', version: '9.9.9' } });
    for (let i = 1; i < DISCOVER_PROBES_PER_MINUTE; i++) await route(win, 'GET', '/api/a2a/discover');
    expect(((await route(win, 'GET', '/api/a2a/discover')) as DiscoverAnswer).status).toBe(429);
    vi.advanceTimersByTime(60_000);
    expect(((await route(win, 'GET', '/api/a2a/discover')) as DiscoverAnswer).status).toBe(200);
  });

  it('shows the card only after a valid reveal, with the same code the requester derives', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true });
    const nonceR = randomSecret();
    const res = (await route(win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(nonceR))) as DiscoverAnswer;
    const created = res.body as A2aDiscoverRequestCreated;
    expect(win.status().incoming).toBeNull();
    await route(win, 'POST', `/api/a2a/discover/requests/${created.requestId}/reveal`, PEER_IP, created.token, { nonce: nonceR });
    const code = discoverCode({ nonceS: created.nonce, nonceR, fingerprintS: FS, fingerprintR: FR, hostIdR: PEER_HOST });
    expect(win.status().incoming).toMatchObject({
      requestId: created.requestId,
      state: 'deciding',
      code,
      device: { name: 'asker', login: 'me@example.com', os: 'macOS', ip: PEER_IP },
    });
  });

  it('kills a request whose reveal does not open its commit', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true });
    const res = (await route(win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))) as DiscoverAnswer;
    const created = res.body as A2aDiscoverRequestCreated;
    const revealed = (await route(win, 'POST', `/api/a2a/discover/requests/${created.requestId}/reveal`, PEER_IP, created.token, { nonce: randomSecret() })) as DiscoverAnswer;
    expect(revealed).toMatchObject({ status: 403, body: { reason: 'commit-mismatch' } });
    expect(await poll(win, created)).toMatchObject({ state: 'closed' });
    expect(win.status().incoming).toBeNull();
  });

  it('answers an :id route only to the original source with its token', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true });
    const { created } = await ask(win);
    expect(((await route(win, 'GET', `/api/a2a/discover/requests/${created.requestId}`, PEER_IP, randomSecret())) as DiscoverAnswer).status).toBe(404);
    expect(((await route(win, 'GET', `/api/a2a/discover/requests/${created.requestId}`, '100.100.1.4', created.token)) as DiscoverAnswer).status).toBe(404);
    expect(((await route(win, 'GET', `/api/a2a/discover/requests/${created.requestId}`, PEER_IP, created.token)) as DiscoverAnswer).status).toBe(200);
  });

  it('drops a request whose reveal does not come within 10 s, freeing the slot', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true });
    const res = (await route(win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))) as DiscoverAnswer;
    expect(((await route(win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))) as DiscoverAnswer)).toMatchObject({ status: 429, body: { reason: 'busy' } });
    vi.advanceTimersByTime(DISCOVER_COMMIT_MS);
    expect(await poll(win, res.body as A2aDiscoverRequestCreated)).toMatchObject({ state: 'expired' });
    await ask(win);
  });

  it('a poll sees a passed deadline even before the timer fires', async () => {
    let skew = 0;
    const { win } = makeRig({ deps: { now: () => Date.now() + skew } });
    await win.open({ turnOn: true });
    const { created } = await ask(win);
    skew = DISCOVER_DECIDE_MS;
    expect(await poll(win, created)).toMatchObject({ state: 'expired' });
  });

  it('expires the card after 120 s', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true });
    const { created } = await ask(win);
    vi.advanceTimersByTime(DISCOVER_DECIDE_MS);
    expect(await poll(win, created)).toMatchObject({ state: 'expired' });
    expect(win.status()).toMatchObject({ open: true, incoming: null, lastOutcome: { outcome: 'expired', ip: PEER_IP } });
  });

  it('refuses an unidentified requester and another user, counting both toward the per-source cap only', async () => {
    const rig = makeRig();
    await rig.win.open({ turnOn: true });
    rig.whois.set(PEER_IP, null);
    expect(await route(rig.win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))).toMatchObject({ status: 403, body: { reason: 'unidentified' } });
    expect(rig.win.status().lastOutcome).toMatchObject({ outcome: 'refused', reason: 'unidentified', ip: PEER_IP });
    rig.whois.set(PEER_IP, whoisFor(PEER_IP, { userId: 8 }));
    expect(await route(rig.win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))).toMatchObject({ status: 403, body: { reason: 'other-user' } });
    rig.whois.set(PEER_IP, whoisFor(PEER_IP, { tags: ['tag:x'] }));
    expect(await route(rig.win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))).toMatchObject({ status: 403, body: { reason: 'unidentified' } });
    // A fourth request from that source is over its cap, whatever it would be.
    rig.whois.set(PEER_IP, whoisFor(PEER_IP));
    expect(await route(rig.win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))).toMatchObject({ status: 429, body: { reason: 'rate-limited' } });
    expect(rig.win.status().open).toBe(true);
  });

  it('refuses a request naming this PC’s own HostId, and a subnet router', async () => {
    const rig = makeRig();
    await rig.win.open({ turnOn: true });
    expect(await route(rig.win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret(), { hostId: SELF_HOST }))).toMatchObject({ status: 403, body: { reason: 'self' } });
    rig.whois.set(PEER_IP, whoisFor(PEER_IP, { allowedIps: [`${PEER_IP}/32`, '192.168.0.0/24'] }));
    expect(await route(rig.win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))).toMatchObject({ status: 403, body: { reason: 'unidentified' } });
  });

  it('refuses a malformed body', async () => {
    const bodies = [
      undefined,
      [],
      requestBody(randomSecret(), { commit: 'x' }),
      requestBody(randomSecret(), { name: 'n'.repeat(65) }),
      requestBody(randomSecret(), { fingerprint256: 'x' }),
      requestBody(randomSecret(), { hostId: 'not-a-uuid' }),
      requestBody(randomSecret(), { protocol: 'one' }),
    ];
    for (const body of bodies) {
      // Each in its own window: a source has only three requests per window.
      const { win } = makeRig();
      await win.open({ turnOn: true });
      expect(((await route(win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, body)) as DiscoverAnswer).status).toBe(400);
      // A refused body frees the slot.
      expect(win.status().incoming).toBeNull();
    }
    const { win } = makeRig();
    await win.open({ turnOn: true });
    expect(await route(win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret(), { protocol: 99 }))).toMatchObject({ status: 400, body: { error: 'protocol' } });
  });

  it('on macOS, refuses a source that does not route through the tailnet interface', async () => {
    let via = 'en0';
    const rig = makeRig({ deps: { platform: 'darwin', interfaces: () => ({ utun4: [nic(SELF_IP)], en0: [nic('192.168.1.20')] }), routeInterface: async () => via } });
    await rig.win.open({ turnOn: true });
    expect(await route(rig.win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))).toMatchObject({ status: 403, body: { reason: 'unidentified' } });
    via = 'utun4';
    await ask(rig.win);
  });

  it('a Deny blocks that source for the rest of the window', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true });
    const { created } = await ask(win);
    expect(win.decide(created.requestId, false).ok).toBe(true);
    expect(await poll(win, created)).toMatchObject({ state: 'denied' });
    expect(win.status()).toMatchObject({ open: true, lastOutcome: { outcome: 'denied', device: { name: 'asker' } } });
    expect(await route(win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()))).toMatchObject({ status: 403, body: { reason: 'denied' } });
  });

  it('the 11th identified request closes the window as too many requests', async () => {
    const sources = Array.from({ length: 11 }, (_, i) => `100.100.2.${i + 1}`);
    const status = tailnetStatus();
    status.peers = sources.map((ip, i) => node({ stableId: `n${i}`, ipv4s: [ip] }));
    const rig = makeRig({ status: () => status });
    for (const ip of sources) rig.whois.set(ip, whoisFor(ip));
    await rig.win.open({ turnOn: true });
    for (const ip of sources.slice(0, 10)) {
      const { created } = await ask(rig.win, ip);
      rig.win.decide(created.requestId, false);
    }
    expect(await route(rig.win, 'POST', '/api/a2a/discover/requests', sources[10], undefined, requestBody(randomSecret()))).toBeNull();
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'too-many-requests' } });
  });
});

describe('DiscoveryWindow — Allow and the one-shot pairing code', () => {
  async function allowed(rig: Rig): Promise<{ created: A2aDiscoverRequestCreated; grant: string }> {
    await rig.win.open({ turnOn: true });
    const { created } = await ask(rig.win);
    rig.win.decide(created.requestId, true);
    const p = await poll(rig.win, created);
    expect(p.state).toBe('allowed');
    expect(p.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    return { created, grant: p.code! };
  }

  it('stops answering probes and new requests once allowed', async () => {
    const rig = makeRig();
    await allowed(rig);
    expect(rig.win.accepts(SELF_IP, PEER_IP, 'GET', '/api/a2a/discover')).toBe(false);
    expect(rig.win.accepts(SELF_IP, PEER_IP, 'POST', '/api/a2a/discover/requests')).toBe(false);
    expect(rig.win.status().incoming).toMatchObject({ state: 'allowed' });
  });

  it('redeems once, for its source and HostId; another code costs nothing', async () => {
    const rig = makeRig({ enabled: false });
    const { grant } = await allowed(rig);
    expect(rig.win.redeem('WRONGCDE', PEER_IP, PEER_HOST)).toBe('none');
    expect(rig.win.redeem(` ${grant.toLowerCase()} `, PEER_IP, PEER_HOST)).toBe('ok');
    expect(rig.win.redeem(grant, PEER_IP, PEER_HOST)).toBe('none');
    rig.win.notePaired({ hostId: PEER_HOST, name: 'Asker' });
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'paired', peer: { hostId: PEER_HOST } } });
    // Paired: A2A stays on.
    expect(rig.controller.current().enabled).toBe(true);
    expect(fs.existsSync(path.join(rig.dir, DISCOVERY_MARKER_FILE))).toBe(false);
  });

  it('burns the code presented from another source or for another HostId', async () => {
    const rig = makeRig({ enabled: false });
    const { grant } = await allowed(rig);
    expect(rig.win.redeem(grant, '100.100.1.4', PEER_HOST)).toBe('mismatch');
    expect(rig.win.redeem(grant, PEER_IP, PEER_HOST)).toBe('none');
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'failed' } });
    expect(rig.controller.current().enabled).toBe(false);

    const rig2 = makeRig();
    const second = await allowed(rig2);
    expect(rig2.win.redeem(second.grant, PEER_IP, '33333333-3333-4333-8333-333333333333')).toBe('mismatch');
  });

  it('ends the window when the code is not redeemed within 60 s, turning A2A off again', async () => {
    const rig = makeRig({ enabled: false });
    await allowed(rig);
    vi.advanceTimersByTime(DISCOVER_GRANT_MS);
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'grant-expired' } });
    expect(rig.controller.current().enabled).toBe(false);
  });

  it('a failed mint after a redeem ends the window as failed, as no pairing', async () => {
    const rig = makeRig({ enabled: false });
    const { grant } = await allowed(rig);
    expect(rig.win.redeem(grant, PEER_IP, PEER_HOST)).toBe('ok');
    rig.win.noteMintFailed();
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'failed' } });
    expect(rig.controller.current().enabled).toBe(false);
  });

  it('a withdraw after Allow voids the code', async () => {
    const rig = makeRig();
    const { created, grant } = await allowed(rig);
    expect(await route(rig.win, 'POST', `/api/a2a/discover/requests/${created.requestId}/withdraw`, PEER_IP, created.token)).toMatchObject({ status: 200 });
    expect(rig.win.redeem(grant, PEER_IP, PEER_HOST)).toBe('none');
    expect(rig.win.status().open).toBe(false);
  });
});

describe('DiscoveryWindow — a Stop while it opens', () => {
  for (const at of ['status', 'whois', 'idle'] as const) {
    it(`a Stop during the ${at} wait opens nothing and leaves A2A off`, async () => {
      const rig = makeRig({ enabled: false });
      const hold = deferred();
      rig.holds[at] = hold.promise;
      const opening = rig.win.open({ turnOn: true }, 'c1');
      await vi.advanceTimersByTimeAsync(0);
      rig.win.close('stopped');
      rig.holds[at] = undefined;
      hold.release();
      expect(await opening).toEqual({ ok: false, reason: 'cancelled' });
      expect(rig.win.status().open).toBe(false);
      expect(rig.controller.current().enabled).toBe(false);
      expect(fs.existsSync(path.join(rig.dir, DISCOVERY_MARKER_FILE))).toBe(false);
    });
  }

  it('the opener going away during the open cancels it; another connection going away does not', async () => {
    const rig = makeRig({ enabled: false });
    let hold = deferred();
    rig.holds.status = hold.promise;
    let opening = rig.win.open({ turnOn: true }, 'c1');
    rig.win.clientGone('c1');
    hold.release();
    expect(await opening).toEqual({ ok: false, reason: 'cancelled' });

    hold = deferred();
    rig.holds.status = hold.promise;
    opening = rig.win.open({ turnOn: true }, 'c1');
    rig.win.clientGone('c2');
    hold.release();
    expect(await opening).toMatchObject({ ok: true });
  });
});

describe('DiscoveryWindow — nothing ends a window while a pairing is minted', () => {
  async function redeemed(rig: Rig, ownerClientId = 'c1'): Promise<A2aDiscoverRequestCreated> {
    await rig.win.open({ turnOn: true }, ownerClientId);
    const { created } = await ask(rig.win);
    rig.win.decide(created.requestId, true);
    const p = await poll(rig.win, created);
    expect(rig.win.redeem(p.code ?? '', PEER_IP, PEER_HOST)).toBe('ok');
    return created;
  }

  it('a withdraw is refused once the code was redeemed', async () => {
    const rig = makeRig({ enabled: false });
    const created = await redeemed(rig);
    expect(await route(rig.win, 'POST', `/api/a2a/discover/requests/${created.requestId}/withdraw`, PEER_IP, created.token)).toMatchObject({ status: 409 });
    rig.win.notePaired({ hostId: PEER_HOST, name: 'Asker' });
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'paired' } });
    expect(rig.controller.current().enabled).toBe(true);
  });

  it('the window’s own timeout waits for the mint', async () => {
    const rig = makeRig({ enabled: false });
    await rig.win.open({ turnOn: true }, 'c1');
    vi.advanceTimersByTime(DISCOVER_WINDOW_MS - 20_000);
    const { created } = await ask(rig.win);
    rig.win.decide(created.requestId, true);
    const p = await poll(rig.win, created);
    expect(rig.win.redeem(p.code ?? '', PEER_IP, PEER_HOST)).toBe('ok');
    vi.advanceTimersByTime(25_000);
    expect(rig.win.status().open).toBe(true);
    rig.win.notePaired({ hostId: PEER_HOST, name: 'Asker' });
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'paired' } });
    expect(rig.controller.current().enabled).toBe(true);
  });

  it('the opener going away, a Stop or a listener stop wait for the mint too', async () => {
    const rig = makeRig({ enabled: false });
    await redeemed(rig, 'c1');
    rig.win.clientGone('c1');
    rig.win.close('stopped');
    rig.win.listenerStopped();
    expect(rig.win.status().open).toBe(true);
    expect(rig.controller.current().enabled).toBe(true);
    rig.win.notePaired({ hostId: PEER_HOST, name: 'Asker' });
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'paired' } });
    expect(rig.controller.current().enabled).toBe(true);
  });

  it('a mint that never reports ends the window as failed', async () => {
    const rig = makeRig({ enabled: false });
    await redeemed(rig);
    vi.advanceTimersByTime(DISCOVER_MINT_MS);
    expect(rig.win.status()).toMatchObject({ open: false, ended: { reason: 'failed' } });
    expect(rig.controller.current().enabled).toBe(false);
  });
});

describe('DiscoveryWindow — a window that closes while a request is read', () => {
  it('a request whose body arrives after the window closed answers as outside it', async () => {
    const { win } = makeRig();
    await win.open({ turnOn: true });
    const answer = await win.route({
      method: 'POST',
      path: '/api/a2a/discover/requests',
      source: PEER_IP,
      token: undefined,
      readBody: async () => {
        win.close('stopped');
        return requestBody(randomSecret(), { hostId: SELF_HOST });
      },
    });
    expect(answer).toBeNull();
    expect(win.status().lastOutcome).toBeNull();
  });

  it('a refusal after the window closed leaves no line behind', async () => {
    const rig = makeRig();
    await rig.win.open({ turnOn: true });
    rig.whois.set(PEER_IP, null);
    const hold = deferred();
    rig.holds.whois = hold.promise;
    const answer = route(rig.win, 'POST', '/api/a2a/discover/requests', PEER_IP, undefined, requestBody(randomSecret()));
    await vi.advanceTimersByTimeAsync(0);
    rig.win.close('stopped');
    hold.release();
    expect(await answer).toBeNull();
    expect(rig.win.status().lastOutcome).toBeNull();
  });
});

describe('routeInterface', () => {
  it('refuses an argument that is not a canonical tailnet IPv4', async () => {
    for (const bad of ['192.168.1.4', '-n', '100.100.1.2 ', '100.100.01.2']) {
      expect(await routeInterface(bad, AbortSignal.timeout(1_000))).toBeNull();
    }
  });
});
