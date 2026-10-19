import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  A2A_REMOTE_BODY_MAX,
  A2A_REMOTE_PROTOCOL,
  parseInvite,
  parsePeerCredential,
} from '../../../shared/a2aRemote';
import { A2A_REQUEST_BODY_MAX, PAIR_BACKOFF_BASE_MS, PAIR_FREE_FAILURES } from '../server';
import { disposeAll, makePc, raw, type Pc } from './a2aServerRig';

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
