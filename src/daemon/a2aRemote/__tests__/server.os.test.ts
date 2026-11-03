import fs from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A2A_REMOTE_BODY_MAX,
  A2A_REMOTE_PROTOCOL,
  A2A_ROUTES,
  parseInvite,
  parsePeerCredential,
} from '../../../shared/a2aRemote';
import { CONTINUE_BYTES_MAX } from '../../../shared/a2aContinue';
import {
  A2A_REQUEST_BODY_MAX,
  CONTINUE_TRANSFER_MAX_MS,
  PAIR_BACKOFF_BASE_MS,
  PAIR_FREE_FAILURES,
  continueTransferBudgetMs,
  continueWireMax,
  extendBodyDeadline,
  requestBodyMax,
} from '../server';
import { disposeAll, freePort, makePc, raw, type Pc } from './a2aServerRig';
import type { TailnetStatus, TailnetWhois } from '../../../cli/tailscale';
import type { A2aDiscoverRequestCreated } from '../../../shared/a2aRemote';
import type { DaemonConfig } from '../../types';
import { A2aRemoteController } from '../controller';
import { discoverCode, discoverCommit, randomSecret } from '../discoverCode';
import { DISCOVERY_MARKER_FILE } from '../discovery';
import { registerA2aRemoteRpc } from '../rpc';
import { A2aServer } from '../server';
import type { TailnetCli } from '../tailnet';

const JOINER = '33333333-3333-4333-8333-333333333333';

afterEach(async () => {
  await disposeAll();
});

function portOf(pc: Pc): number {
  const port = pc.server.boundPort();
  if (port === null) throw new Error('listener is not running');
  return port;
}

function pairBody(code: string, hostId = JOINER): string {
  return JSON.stringify({ code, hostId, name: 'Joiner', protocol: A2A_REMOTE_PROTOCOL });
}

function codeOf(pc: Pc): string {
  const parsed = parseInvite(pc.server.beginPairing().invite);
  if (!parsed.ok) throw new Error('invite did not parse');
  return parsed.invite.code;
}

async function pairedCredential(pc: Pc): Promise<string> {
  const res = await raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(codeOf(pc)) });
  expect(res.status).toBe(200);
  return res.json!['credential'] as string;
}

describe('A2aServer — request edges', () => {
  // No Host allowlist on this listener (there is no browser client). A
  // browser always sends Origin on a cross-origin request and a server-to-
  // server call never does, so Origin -> 403 is the DNS-rebinding defence.
  it('refuses any request carrying Origin, on every path, before anything else', async () => {
    const pc = await makePc('PC A');
    const port = portOf(pc);
    const cred = await pairedCredential(pc);
    for (const p of ['/api/a2a/hello', '/api/a2a/pair', '/', '/api/web']) {
      const res = await raw(port, 'GET', p, {
        headers: { Origin: 'http://evil.example', Authorization: `Bearer ${cred}` },
      });
      expect(res.status, p).toBe(403);
      expect(res.json).toMatchObject({ ok: false, error: 'forbidden' });
    }
  });

  it('answers 404 outside /api/a2a/, even with a valid peer credential', async () => {
    const pc = await makePc('PC A');
    const cred = await pairedCredential(pc);
    for (const p of ['/', '/api/pair', '/api/sessions', '/api/a2a', '/api/a2a/../pair']) {
      const res = await raw(portOf(pc), 'GET', p, { headers: { Authorization: `Bearer ${cred}` } });
      expect(res.status, p).toBe(404);
    }
  });

  it('caps the request body (declared length and streamed pair body)', async () => {
    const pc = await makePc('PC A');
    const port = portOf(pc);
    const declared = await raw(port, 'POST', '/api/a2a/messages', {
      headers: { 'Content-Length': String(A2A_REQUEST_BODY_MAX + 1) },
      body: Buffer.alloc(16),
    }).catch(() => null);
    // The listener answers 413 and closes; the client may see the reset first.
    if (declared) expect(declared.status).toBe(413);

    pc.server.beginPairing();
    const big = JSON.stringify({ code: 'X'.repeat(A2A_REMOTE_BODY_MAX + 10), hostId: JOINER, name: 'n', protocol: 1 });
    const res = await raw(port, 'POST', '/api/a2a/pair', { body: big });
    expect(res.status).toBe(413);
    expect(res.json).toMatchObject({ error: 'too-large' });
    // An over-size body is not a guess: the invite keeps all its attempts.
    expect(pc.server.pairingStatus()).toMatchObject({ active: true, attemptsLeft: 5 });
  });

  it('refuses operator- and device-shaped bearers and query credentials on peer routes', async () => {
    const pc = await makePc('PC A');
    const port = portOf(pc);
    const cases: Array<[string, Record<string, string>, number]> = [
      ['/api/a2a/hello', {}, 401],
      ['/api/a2a/hello', { Authorization: `Bearer ${'ab'.repeat(32)}` }, 401],
      ['/api/a2a/hello', { Authorization: 'Bearer 0123456789abcdef.c2VjcmV0c2VjcmV0c2VjcmV0' }, 403],
      ['/api/a2a/hello?token=abc', {}, 403],
      ['/api/a2a/hello?ticket=abc', {}, 403],
      ['/api/a2a/hello', { Authorization: 'Bearer wmuxpeer~not-a-uuid~x' }, 401],
      ['/api/a2a/exposed', { Authorization: 'Bearer 0123456789abcdef.c2VjcmV0c2VjcmV0c2VjcmV0' }, 403],
    ];
    for (const [p, headers, status] of cases) {
      const res = await raw(port, 'GET', p, { headers });
      expect(res.status, `${p} ${JSON.stringify(headers)}`).toBe(status);
    }
  });

  it('hello answers the identity to an authenticated peer', async () => {
    const pc = await makePc('PC A');
    const cred = await pairedCredential(pc);
    const res = await raw(portOf(pc), 'GET', '/api/a2a/hello', { headers: { Authorization: `Bearer ${cred}` } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ protocol: A2A_REMOTE_PROTOCOL, hostId: pc.server.status().hostId, name: 'PC A' });
  });

  it('other peer routes are 503 without a route table, delegated with one', async () => {
    const pc = await makePc('PC A');
    const cred = await pairedCredential(pc);
    const res = await raw(portOf(pc), 'GET', '/api/a2a/exposed', { headers: { Authorization: `Bearer ${cred}` } });
    expect(res.status).toBe(503);

    const handle = vi.fn(async (_req, res2: import('node:http').ServerResponse, _url, p: string, peer) => {
      res2.writeHead(200, { 'Content-Type': 'application/json' });
      res2.end(JSON.stringify({ p, peer }));
    });
    const pc2 = await makePc('PC B', { deps: { routes: { handle } } });
    const cred2 = await pairedCredential(pc2);
    const res2 = await raw(portOf(pc2), 'GET', '/api/a2a/exposed', { headers: { Authorization: `Bearer ${cred2}` } });
    expect(res2.status).toBe(200);
    expect(res2.json).toMatchObject({ p: '/api/a2a/exposed', peer: { hostId: JOINER, name: 'Joiner' } });
  });

  it('holds every request body to its deadline, and lets a route give a large one longer', async () => {
    const handle = vi.fn(async (req: http.IncomingMessage, res: http.ServerResponse, _url: URL, p: string) => {
      if (p.startsWith(`${A2A_ROUTES.continue}/`)) extendBodyDeadline(req, 10_000);
      let n = 0;
      for await (const chunk of req) n += (chunk as Buffer).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ n }));
    });
    const pc = await makePc('PC A', { deps: { routes: { handle }, bodyTimeoutMs: 300 } });
    const cred = await pairedCredential(pc);
    // Half the body now, the rest after the listener's deadline: -1 when the connection was cut.
    const slow = (p: string): Promise<number> =>
      new Promise((resolve) => {
        const req = https.request(
          { host: '127.0.0.1', port: portOf(pc), method: 'PUT', path: p, headers: { Authorization: `Bearer ${cred}`, 'Content-Length': 20 }, rejectUnauthorized: false, agent: false },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', () => resolve(-1));
        req.write(Buffer.alloc(10));
        setTimeout(() => req.end(Buffer.alloc(10)), 1_000);
      });
    expect(await slow(A2A_ROUTES.messages)).toBe(-1);
    expect(await slow(`${A2A_ROUTES.continue}/ct-x/${'a'.repeat(64)}`)).toBe(200);
  });

  it('lets a continue upload declare the largest file gzipped, with a budget its size sets', () => {
    const put = `${A2A_ROUTES.continue}/ct-x/${'a'.repeat(64)}`;
    expect(requestBodyMax('PUT', put)).toBe(continueWireMax(CONTINUE_BYTES_MAX, 'gzip'));
    expect(continueWireMax(CONTINUE_BYTES_MAX, 'gzip')).toBeGreaterThan(CONTINUE_BYTES_MAX);
    expect(continueWireMax(1000, 'identity')).toBe(1000);
    expect(requestBodyMax('POST', put)).toBe(A2A_REQUEST_BODY_MAX);
    // 30 s, plus the bytes at 1 Mbit/s; the largest file still fits under the ceiling.
    expect(continueTransferBudgetMs(0)).toBe(30_000);
    expect(continueTransferBudgetMs(1_000_000)).toBe(38_000);
    expect(continueTransferBudgetMs(CONTINUE_BYTES_MAX)).toBeLessThan(CONTINUE_TRANSFER_MAX_MS);
    expect(continueTransferBudgetMs(10 * CONTINUE_BYTES_MAX)).toBe(CONTINUE_TRANSFER_MAX_MS);
  });
});

describe('A2aServer — pairing', () => {
  it('issues a peer credential and NOTHING else', async () => {
    const pc = await makePc('PC A');
    const res = await raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(codeOf(pc)) });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json!).sort()).toEqual(['credential', 'hostId', 'name', 'protocol']);
    expect(parsePeerCredential(res.json!['credential'])).not.toBeNull();
    expect(JSON.stringify(res.json)).not.toMatch(/token|deviceId|deviceSecret|operator/i);
    expect(res.json).toMatchObject({ hostId: pc.server.status().hostId, name: 'PC A', protocol: A2A_REMOTE_PROTOCOL });
    // Single use.
    expect(pc.server.pairingStatus().active).toBe(false);
    expect(pc.peers.listByHost(JOINER)).toHaveLength(1);
  });

  it('ignores any Authorization on the pair route (it is how a joiner gets one)', async () => {
    const pc = await makePc('PC A');
    const res = await raw(portOf(pc), 'POST', '/api/a2a/pair', {
      headers: { Authorization: 'Bearer 0123456789abcdef.c2VjcmV0c2VjcmV0c2VjcmV0' },
      body: pairBody(codeOf(pc)),
    });
    expect(res.status).toBe(200);
  });

  it('refuses malformed bodies and another protocol without spending an attempt', async () => {
    const pc = await makePc('PC A');
    const code = codeOf(pc);
    const port = portOf(pc);
    expect((await raw(port, 'POST', '/api/a2a/pair', { body: 'not json' })).status).toBe(400);
    expect((await raw(port, 'POST', '/api/a2a/pair', { body: pairBody(code, 'nope') })).status).toBe(400);
    const proto = await raw(port, 'POST', '/api/a2a/pair', {
      body: JSON.stringify({ code, hostId: JOINER, name: 'n', protocol: 99 }),
    });
    expect(proto).toMatchObject({ status: 400, json: { error: 'protocol' } });
    expect((await raw(port, 'GET', '/api/a2a/pair')).status).toBe(405);
    expect(pc.server.pairingStatus()).toMatchObject({ active: true, attemptsLeft: 5 });
  });

  it('refuses the server’s own hostId', async () => {
    const pc = await makePc('PC A');
    const code = codeOf(pc);
    const res = await raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(code, pc.server.status().hostId!) });
    expect(res).toMatchObject({ status: 400, json: { reason: 'self' } });
    expect(pc.peers.list()).toHaveLength(0);
  });

  it('a valid code re-pairs an already-paired host: the old peer is revoked, with its cascade', async () => {
    const pc = await makePc('PC A');
    const old = await pairedCredential(pc);
    const fresh = await pairedCredential(pc);
    expect(fresh).not.toBe(old);
    const live = pc.peers.listByHost(JOINER).filter((r) => r.revokedAt === undefined);
    expect(live).toHaveLength(1);
    expect(pc.cascaded).toEqual([JOINER]);
    const port = portOf(pc);
    expect((await raw(port, 'GET', '/api/a2a/hello', { headers: { Authorization: `Bearer ${old}` } })).status).toBe(401);
    expect((await raw(port, 'GET', '/api/a2a/hello', { headers: { Authorization: `Bearer ${fresh}` } })).status).toBe(200);
  });

  it('judges the code before the hostId: no answer tells a paired host from an unknown one', async () => {
    const pc = await makePc('PC A');
    await pairedCredential(pc);
    pc.server.beginPairing();
    const port = portOf(pc);
    const paired = await raw(port, 'POST', '/api/a2a/pair', { body: pairBody('ZZZZZZZZ', JOINER) });
    const unknown = await raw(port, 'POST', '/api/a2a/pair', {
      body: pairBody('ZZZZZZZZ', '55555555-5555-4555-8555-555555555555'),
    });
    expect(paired).toEqual(unknown);
    expect(paired).toMatchObject({ status: 403, json: { reason: 'invalid-code' } });
    // And with no invite open at all.
    pc.server.cancelPairing();
    expect((await raw(port, 'POST', '/api/a2a/pair', { body: pairBody('ZZZZZZZZ', JOINER) })).status).toBe(403);
  });

  it('backs off a source address after repeated failures, without touching the invite', async () => {
    let now = 1_800_000_000_000;
    const pc = await makePc('PC A', { deps: { now: () => now } });
    const code = codeOf(pc);
    const port = portOf(pc);
    const wrong = (): Promise<{ status: number; json: Record<string, unknown> | null }> =>
      raw(port, 'POST', '/api/a2a/pair', { body: pairBody('ZZZZZZZZ') });
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) expect((await wrong()).status).toBe(403);
    // Locked out: even the right code is not judged (so the lockout costs no attempt).
    expect(await raw(port, 'POST', '/api/a2a/pair', { body: pairBody(code) })).toMatchObject({
      status: 429,
      json: { reason: 'rate-limited', retryAfterMs: PAIR_BACKOFF_BASE_MS },
    });
    expect(pc.server.pairingStatus()).toEqual({
      active: true,
      expiresAt: expect.any(Number),
      attemptsLeft: 5 - PAIR_FREE_FAILURES,
      lockedUntil: now + PAIR_BACKOFF_BASE_MS,
    });
    now += PAIR_BACKOFF_BASE_MS;
    expect(pc.server.pairingStatus().lockedUntil).toBeNull();
    expect((await raw(port, 'POST', '/api/a2a/pair', { body: pairBody(code) })).status).toBe(200);
  });

  it('two concurrent redemptions of one code mint once', async () => {
    const pc = await makePc('PC A');
    const code = codeOf(pc);
    const [a, b] = await Promise.all([
      raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(code) }),
      raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(code, '44444444-4444-4444-8444-444444444444') }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect(pc.peers.list()).toHaveLength(1);
  });

  it('unpair revokes only the calling peer and runs the cascade', async () => {
    const pc = await makePc('PC A');
    const cred = await pairedCredential(pc);
    const port = portOf(pc);
    expect((await raw(port, 'POST', '/api/a2a/unpair')).status).toBe(401);
    const res = await raw(port, 'POST', '/api/a2a/unpair', { headers: { Authorization: `Bearer ${cred}` } });
    expect(res).toMatchObject({ status: 200, json: { ok: true } });
    expect(pc.peers.listByHost(JOINER)[0].revokedAt).toBeDefined();
    expect(pc.cascaded).toEqual([JOINER]);
    expect((await raw(port, 'GET', '/api/a2a/hello', { headers: { Authorization: `Bearer ${cred}` } })).status).toBe(401);
  });

  it('revoked peer gets 401 on hello', async () => {
    const pc = await makePc('PC A');
    const cred = await pairedCredential(pc);
    pc.peers.revoke(parsePeerCredential(cred)!.peerId);
    const res = await raw(portOf(pc), 'GET', '/api/a2a/hello', { headers: { Authorization: `Bearer ${cred}` } });
    expect(res).toMatchObject({ status: 401, json: { error: 'unauthorized', reason: 'revoked' } });
  });

  it('pair.begin refuses while the listener is down; the invite names the bound port and fingerprint', async () => {
    const off = await makePc('PC A', { enabled: false });
    expect(() => off.server.beginPairing()).toThrow(/not running/);

    const pc = await makePc('PC A');
    const parsed = parseInvite(pc.server.beginPairing().invite);
    expect(parsed.ok && parsed.invite).toMatchObject({
      host: '127.0.0.1',
      port: portOf(pc),
      fingerprint256: pc.server.status().fingerprint256,
    });
  });

  it('pair.begin flags only the tailnet addresses it was told about, not every 100.64/10 one', async () => {
    const pc = await makePc('PC A', {
      deps: { ipv4s: () => ['127.0.0.1', '100.64.0.2', '100.100.0.7'], tailnetIpv4s: () => ['100.64.0.2'] },
    });
    const begun = pc.server.beginPairing();
    expect(begun.addresses).toEqual(['127.0.0.1', '100.64.0.2', '100.100.0.7']);
    expect(begun.tailnet).toEqual(['100.64.0.2']);
  });
});

// ─── Tailnet discovery on the listener ─────────────────────────────────────
//
// The rig listens on loopback; `tailnetGate` makes every connection look as if
// it reached this PC's tailnet address (100.100.1.1) from `gate.remote`, and a
// fake TailnetCli stands in for `tailscale status` and `whois`.

const SELF_IP = '100.100.1.1';
const PEER_IP = '100.100.1.2';
const ASKER_HOST = '22222222-2222-4222-8222-222222222222';
const FR = Array.from({ length: 32 }, () => 'BB').join(':');
const gate = { remote: PEER_IP };

function tailnetNode(over: Partial<TailnetStatus['self']>): TailnetStatus['self'] {
  return { stableId: '', hostName: '', dnsName: '', os: 'linux', userId: 7, ipv4s: [], online: true, tags: [], sharee: false, ...over };
}

function fakeTailnet(whois: Map<string, TailnetWhois | null>): TailnetCli {
  const status: TailnetStatus = {
    backendState: 'Running',
    version: '1.76.6',
    self: tailnetNode({ stableId: 'nSELF', ipv4s: [SELF_IP] }),
    selfLogin: 'me@example.com',
    peers: [tailnetNode({ stableId: 'nASKER', ipv4s: [PEER_IP] }), tailnetNode({ stableId: 'nOTHER', ipv4s: ['100.100.1.4'] })],
  };
  return { status: async () => ({ ok: true, status, bin: 'tailscale' }), whois: async (ip) => whois.get(ip) ?? null };
}

function whoisOf(ip: string, stableId: string): TailnetWhois {
  return {
    nodeName: 'asker.tail1.ts.net',
    deviceName: 'asker',
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

function defaultWhois(): Map<string, TailnetWhois | null> {
  return new Map([
    [SELF_IP, whoisOf(SELF_IP, 'nSELF')],
    [PEER_IP, whoisOf(PEER_IP, 'nASKER')],
    ['100.100.1.4', whoisOf('100.100.1.4', 'nOTHER')],
  ]);
}

function tailnetDeps(whois = defaultWhois()) {
  return {
    tailnet: fakeTailnet(whois),
    discoverVersion: () => '9.9.9',
    tailnetGate: {
      addressesOf: () => ({ local: SELF_IP, remote: gate.remote }),
      interfaces: () => ({ tailscale0: [{ address: SELF_IP, family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] }),
      platform: 'linux' as const,
    },
  };
}

/** Status, the headers that matter, and the body as bytes: for byte-for-byte comparisons. */
function exact(port: number, method: string, pathname: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: pathname, headers, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve(
          JSON.stringify([
            res.statusCode,
            res.headers['content-type'],
            res.headers['content-length'],
            res.headers['cache-control'],
            res.headers['retry-after'] ?? null,
            Buffer.concat(chunks).toString('base64'),
          ]),
        ),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function askOverHttp(pc: Pc): Promise<{ created: A2aDiscoverRequestCreated; code: string }> {
  const port = portOf(pc);
  const nonceR = randomSecret();
  const body = { protocol: A2A_REMOTE_PROTOCOL, hostId: ASKER_HOST, name: 'Asker', fingerprint256: FR, commit: discoverCommit(nonceR) };
  const res = await raw(port, 'POST', '/api/a2a/discover/requests', { body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  const created = res.json as unknown as A2aDiscoverRequestCreated;
  const revealed = await raw(port, 'POST', `/api/a2a/discover/requests/${created.requestId}/reveal`, {
    headers: { 'x-wmux-discover-token': created.token },
    body: JSON.stringify({ nonce: nonceR }),
  });
  expect(revealed.status).toBe(200);
  const fingerprintS = pc.server.status().fingerprint256 ?? '';
  return { created, code: discoverCode({ nonceS: created.nonce, nonceR, fingerprintS, fingerprintR: FR, hostIdR: ASKER_HOST }) };
}

async function grantOf(pc: Pc, created: A2aDiscoverRequestCreated): Promise<string> {
  const res = await raw(portOf(pc), 'GET', `/api/a2a/discover/requests/${created.requestId}`, { headers: { 'x-wmux-discover-token': created.token } });
  expect(res.json).toMatchObject({ state: 'allowed' });
  return res.json!['code'] as string;
}

describe('A2aServer — tailnet discovery', () => {
  beforeEach(() => {
    gate.remote = PEER_IP;
  });

  const PROBES: Array<[string, string, Record<string, string>]> = [
    ['GET', '/api/a2a/discover', {}],
    ['POST', '/api/a2a/discover/requests', {}],
    ['GET', '/api/a2a/discover/requests/33333333-3333-4333-8333-333333333333', {}],
    ['GET', '/api/a2a/discover', { Authorization: 'Bearer 0123456789abcdef.c2VjcmV0c2VjcmV0c2VjcmV0' }],
    ['GET', '/api/a2a/discover?token=abc', {}],
    ['GET', '/api/a2a/discover?ticket=abc', {}],
  ];

  /** What the same request gets on a route discovery never answers: today's unauthenticated answer. */
  async function today(port: number, method: string, p: string, headers: Record<string, string>): Promise<string> {
    return exact(port, method, p.replace('/api/a2a/discover', '/api/a2a/elsewhere'), headers);
  }

  it('outside a window, answers every discovery route byte for byte as today (401, or 403 for other credentials)', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    const port = portOf(pc);
    for (const [method, p, headers] of PROBES) {
      expect(await exact(port, method, p, headers), `${method} ${p}`).toBe(await today(port, method, p, headers));
    }
    expect((await raw(port, 'GET', '/api/a2a/discover')).status).toBe(401);
  });

  it('inside a window, a source that is not a listed tailnet node gets today’s answer too', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: false });
    const port = portOf(pc);
    for (const remote of ['192.168.1.30', SELF_IP, '100.100.9.9']) {
      gate.remote = remote;
      for (const [method, p, headers] of PROBES) {
        expect(await exact(port, method, p, headers), `${remote} ${method} ${p}`).toBe(await today(port, method, p, headers));
      }
    }
  });

  it('answers the probe with exactly four keys inside the window', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    expect(await pc.server.discovery.open({ turnOn: false })).toMatchObject({ ok: true });
    const res = await raw(portOf(pc), 'GET', '/api/a2a/discover');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ discover: 1, protocol: A2A_REMOTE_PROTOCOL, name: 'PC A', version: '9.9.9' });
  });

  it('still refuses an Origin header first, inside the window', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: false });
    const res = await raw(portOf(pc), 'GET', '/api/a2a/discover', { headers: { Origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ ok: false, error: 'forbidden' });
  });

  it('refuses a request whose source whois does not identify', async () => {
    const whois = defaultWhois();
    whois.set(PEER_IP, null);
    const pc = await makePc('PC A', { deps: tailnetDeps(whois) });
    await pc.server.discovery.open({ turnOn: false });
    const nonceR = randomSecret();
    const body = { protocol: A2A_REMOTE_PROTOCOL, hostId: ASKER_HOST, name: 'Asker', fingerprint256: FR, commit: discoverCommit(nonceR) };
    const res = await raw(portOf(pc), 'POST', '/api/a2a/discover/requests', { body: JSON.stringify(body) });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: 'unidentified' });
  });

  it('caps a chunked request body too', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: false });
    const res = await new Promise<number>((resolve) => {
      const req = https.request(
        { host: '127.0.0.1', port: portOf(pc), method: 'POST', path: '/api/a2a/discover/requests', rejectUnauthorized: false, agent: false },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.on('error', () => resolve(-1));
      req.write('x'.repeat(1500));
      req.end('x'.repeat(1500));
    });
    if (res !== -1) expect(res).toBe(413);
  });

  it('pairs once on Allow, through /pair, leaving an open invite alone and nothing exposed', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    const invite = pc.server.beginPairing();
    await pc.server.discovery.open({ turnOn: false });
    const { created, code } = await askOverHttp(pc);
    expect(pc.server.discovery.status().incoming).toMatchObject({ code, device: { name: 'asker', ip: PEER_IP } });
    pc.server.discovery.decide(created.requestId, true);
    const grant = await grantOf(pc, created);

    const pair = (c: string) => raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(c, ASKER_HOST) });
    const first = await pair(grant);
    expect(first.status).toBe(200);
    expect(parsePeerCredential(first.json!['credential'])).not.toBeNull();
    // The open invite is untouched: same deadline, every attempt left.
    expect(pc.server.pairingStatus()).toMatchObject({ active: true, expiresAt: invite.expiresAt, attemptsLeft: 5 });
    expect(pc.server.discovery.status()).toMatchObject({ open: false, ended: { reason: 'paired', peer: { hostId: ASKER_HOST, name: 'Joiner' } } });
    // The code was one-shot: a replay is judged against the invite and refused.
    const again = await pair(grant);
    expect(again.status).toBe(403);
    expect(pc.peers.list().filter((p) => p.hostId === ASKER_HOST)).toHaveLength(1);
  });

  it('burns the pairing code presented from another source', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: false });
    const { created } = await askOverHttp(pc);
    pc.server.discovery.decide(created.requestId, true);
    const grant = await grantOf(pc, created);
    gate.remote = '100.100.1.4';
    const stolen = await raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(grant, ASKER_HOST) });
    expect(stolen.status).toBe(403);
    expect(stolen.json).toMatchObject({ reason: 'invalid-code' });
    gate.remote = PEER_IP;
    const late = await raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(grant, ASKER_HOST) });
    expect(late.status).toBe(403);
    expect(pc.peers.list()).toHaveLength(0);
    expect(pc.server.discovery.status()).toMatchObject({ open: false, ended: { reason: 'failed' } });
  });

  it('a wrong code on /pair while a code is granted costs the grant nothing', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: false });
    const { created } = await askOverHttp(pc);
    pc.server.discovery.decide(created.requestId, true);
    const grant = await grantOf(pc, created);
    expect((await raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody('ABCDEFGH', ASKER_HOST) })).status).toBe(403);
    expect((await raw(portOf(pc), 'POST', '/api/a2a/pair', { body: pairBody(grant, ASKER_HOST) })).status).toBe(200);
  });

  it('a rebind (port change) closes the window', async () => {
    const pc = await makePc('PC A', { deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: false });
    pc.controller.configure({ port: await freePort() });
    await pc.server.whenIdle();
    expect(pc.server.discovery.status()).toMatchObject({ open: false, ended: { reason: 'listener-stopped' } });
    expect((await raw(portOf(pc), 'GET', '/api/a2a/discover')).status).toBe(401);
  });

  it('a window that turned A2A on turns it off when it ends unpaired', async () => {
    const pc = await makePc('PC A', { enabled: false, deps: tailnetDeps() });
    expect(await pc.server.discovery.open({ turnOn: true })).toMatchObject({ ok: true, status: { turnedOn: true } });
    expect(pc.server.status().listening).toBe(true);
    pc.server.discovery.close('stopped');
    await pc.server.whenIdle();
    expect(pc.controller.current().enabled).toBe(false);
    expect(pc.server.status().listening).toBe(false);
  });

  it('a window that cannot bind its port reports the problem and a port that looked free', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const pc = await makePc('PC A', { enabled: false, port, deps: tailnetDeps() });
      const opened = await pc.server.discovery.open({ turnOn: true });
      expect(opened).toMatchObject({
        ok: false,
        reason: 'listen-failed',
        listen: { lastErrorCode: 'EADDRINUSE', report: { problem: { kind: 'port-in-use', port } } },
      });
      const report = opened.ok ? undefined : opened.listen?.report;
      expect(typeof report?.suggestion).toBe('number');
      expect(report?.suggestion).not.toBe(port);
      expect(pc.controller.current().enabled).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 30_000);

  it('a port change during a window that turned A2A on closes it without turning A2A off', async () => {
    const pc = await makePc('PC A', { enabled: false, deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: true });
    pc.controller.configure({ port: await freePort() });
    await pc.server.whenIdle();
    expect(pc.server.discovery.status()).toMatchObject({ open: false, ended: { reason: 'listener-stopped' } });
    expect(pc.controller.current().enabled).toBe(true);
    expect(pc.server.status().listening).toBe(true);
  });

  it('a settings change from elsewhere during the window means no revert when it ends', async () => {
    const pc = await makePc('PC A', { enabled: false, deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: true });
    // A port another listener holds: the move fails and the window's listener keeps serving.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    try {
      pc.controller.configure({ port: (blocker.address() as net.AddressInfo).port });
      await pc.server.whenIdle();
      expect(pc.server.discovery.status().open).toBe(true);
      pc.server.discovery.close('stopped');
      await pc.server.whenIdle();
      expect(pc.controller.current().enabled).toBe(true);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('the discover RPCs: open belongs to the calling connection, close answers the ended status, decide wants a boolean', async () => {
    const pc = await makePc('PC A', { enabled: false, deps: tailnetDeps() });
    const handlers = new Map<string, (params: Record<string, unknown>, ctx?: { clientId: string }) => Promise<unknown>>();
    registerA2aRemoteRpc((method, handler) => handlers.set(method, handler), {
      controller: pc.controller,
      server: pc.server,
      peers: pc.peers,
      remoteHosts: pc.remoteHosts,
      cascade: () => undefined,
      log: () => undefined,
    });
    const call = (method: string, params: Record<string, unknown> = {}, ctx?: { clientId: string }) => handlers.get(`a2a.remote.discover.${method}`)!(params, ctx);
    expect(await call('open', {}, { clientId: 'c1' })).toMatchObject({ ok: false, reason: 'a2a-off' });
    expect(await call('open', { turnOn: true }, { clientId: 'c1' })).toMatchObject({ ok: true, status: { open: true, turnedOn: true } });
    await expect(call('decide', { requestId: 'x', allow: 'yes' })).rejects.toThrow(/boolean/);
    expect(await call('decide', { requestId: 'x', allow: true })).toMatchObject({ ok: false, status: { open: true } });
    pc.server.discovery.clientGone('c2');
    expect(await call('status')).toMatchObject({ open: true });
    pc.server.discovery.clientGone('c1');
    await pc.server.whenIdle();
    expect(await call('status')).toMatchObject({ open: false, ended: { reason: 'disconnected' } });
    expect(pc.controller.current().enabled).toBe(false);
    await call('open', { turnOn: true }, { clientId: 'c3' });
    expect(await call('close')).toMatchObject({ open: false, ended: { reason: 'stopped' } });
    expect(pc.server.status().listening).toBe(false);
  });

  it('an invite opened during a window that turned A2A on keeps A2A on', async () => {
    const pc = await makePc('PC A', { enabled: false, deps: tailnetDeps() });
    await pc.server.discovery.open({ turnOn: true });
    const invite = pc.server.beginPairing();
    pc.server.discovery.close('stopped');
    await pc.server.whenIdle();
    expect(pc.controller.current().enabled).toBe(true);
    expect(pc.server.pairingStatus()).toMatchObject({ active: true, expiresAt: invite.expiresAt });
  });

  it('a request body that trickles in is cut off, and the slot is free again', async () => {
    const pc = await makePc('PC A', { deps: { ...tailnetDeps(), bodyTimeoutMs: 300 } });
    await pc.server.discovery.open({ turnOn: false });
    const cut = await new Promise<string>((resolve) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: portOf(pc),
          method: 'POST',
          path: '/api/a2a/discover/requests',
          headers: { 'Content-Length': '500' },
          rejectUnauthorized: false,
          agent: false,
        },
        (res) => resolve(`answered ${res.statusCode}`),
      );
      req.on('error', () => resolve('cut'));
      req.write('{"protocol":');
    });
    expect(cut).toMatch(/cut|answered 400/);
    await askOverHttp(pc);
  });

  it('a daemon restart whose marker cannot turn A2A off does not start the listener', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-marker-'));
    try {
      const a2aDir = path.join(dir, 'a2a');
      fs.mkdirSync(a2aDir, { recursive: true });
      fs.writeFileSync(path.join(a2aDir, DISCOVERY_MARKER_FILE), '{"v":1}');
      const config = { a2aRemote: { enabled: true, port: await freePort() } } as unknown as DaemonConfig;
      const controller = new A2aRemoteController({
        config,
        persist: () => {
          throw new Error('disk full');
        },
      });
      const server = new A2aServer({
        controller,
        identityDir: a2aDir,
        peers: { resolve: async () => ({ ok: false, reason: 'unknown' }), touch: () => undefined, mint: async () => ({ peerId: '', secret: '' }), listByHost: () => [], revoke: () => false },
        bindHost: '127.0.0.1',
        log: () => undefined,
        ...tailnetDeps(),
      });
      await server.whenIdle();
      expect(server.status().listening).toBe(false);
      // The marker stays for the next boot.
      expect(fs.existsSync(path.join(a2aDir, DISCOVERY_MARKER_FILE))).toBe(true);
      server.dispose();
      await server.whenIdle();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a daemon restart with the marker present starts with A2A off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-marker-'));
    try {
      const a2aDir = path.join(dir, 'a2a');
      fs.mkdirSync(a2aDir, { recursive: true });
      fs.writeFileSync(path.join(a2aDir, DISCOVERY_MARKER_FILE), '{"v":1}');
      const config = { a2aRemote: { enabled: true, port: await freePort() } } as unknown as DaemonConfig;
      const controller = new A2aRemoteController({ config, persist: () => undefined });
      const server = new A2aServer({
        controller,
        identityDir: a2aDir,
        peers: { resolve: async () => ({ ok: false, reason: 'unknown' }), touch: () => undefined, mint: async () => ({ peerId: '', secret: '' }), listByHost: () => [], revoke: () => false },
        bindHost: '127.0.0.1',
        log: () => undefined,
        ...tailnetDeps(),
      });
      await server.whenIdle();
      expect(controller.current().enabled).toBe(false);
      expect(server.status().listening).toBe(false);
      expect(fs.existsSync(path.join(a2aDir, DISCOVERY_MARKER_FILE))).toBe(false);
      server.dispose();
      await server.whenIdle();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
