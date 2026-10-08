// In-process end to end: two "PCs" (separate data dirs, separate listeners).
// B joins A's invite over the pinned client, exactly as the RPC does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_ROUTES, formatInvite, formatPeerCredential, parseInvite, type A2aInvite } from '../../../shared/a2aRemote';
import { joinRemoteHost, type JoinDeps } from '../joiner';
import { A2A_PAIR_TTL_MS } from '../pairing';
import { PinnedTlsClient } from '../pinnedClient';
import { forgetHostCascade, registerA2aRemoteRpc } from '../rpc';
import { PAIR_BACKOFF_BASE_MS, PAIR_BACKOFF_MAX_MS, PAIR_FREE_FAILURES } from '../server';
import { disposeAll, freePort, makePc, type Pc } from './a2aServerRig';

afterEach(async () => {
  await disposeAll();
});

const FAST = { connectMs: 2_000, requestMs: 5_000 };

function joinerDeps(pc: Pc, name = 'PC B'): JoinDeps {
  return { self: () => pc.server.ensureIdentity(), selfName: name, remoteHosts: pc.remoteHosts, timeouts: FAST };
}

function inviteOf(pc: Pc): A2aInvite {
  const parsed = parseInvite(pc.server.beginPairing().invite);
  if (!parsed.ok) throw new Error('invite did not parse');
  return parsed.invite;
}

function hello(credential: string, host: Pc): Promise<{ status: number; json: unknown }> {
  const status = host.server.status();
  return new PinnedTlsClient({
    addresses: ['127.0.0.1'],
    port: host.server.boundPort()!,
    fingerprint256: status.fingerprint256!,
    credential,
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 5_000,
  }).requestJson('GET', A2A_ROUTES.hello);
}

describe('cross-host pairing, end to end', () => {
  it('B joins A: both stores record the pairing and hello succeeds', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const invite = inviteOf(a);

    const result = await joinRemoteHost(formatInvite(invite), joinerDeps(b));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const aId = a.server.status().hostId!;
    const bId = b.server.status().hostId!;
    expect(result.host).toMatchObject({
      hostId: aId,
      name: 'PC A',
      addresses: ['127.0.0.1'],
      port: invite.port,
      fingerprint256: invite.fingerprint256,
    });
    // Joiner side: the record and its credential.
    expect(b.remoteHosts.list().map((h) => h.hostId)).toEqual([aId]);
    const cred = b.remoteHosts.credentialFor(aId)!;
    expect(cred.peerId).toBe(result.host.peerId);
    // Server side: the peer, bound to B's hostId and name.
    expect(a.peers.list()).toEqual([expect.objectContaining({ peerId: cred.peerId, hostId: bId, name: 'PC B' })]);

    const h = await hello(formatPeerCredential(cred), a);
    expect(h).toMatchObject({ status: 200, json: { hostId: aId, name: 'PC A' } });

    // Revoke on A: the credential stops working.
    expect(a.peers.revoke(cred.peerId)).toBe(true);
    const after = await hello(formatPeerCredential(cred), a);
    expect(after).toMatchObject({ status: 401, json: { reason: 'revoked' } });
  });

  it('a tampered fingerprint fails before the code is sent', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const invite = inviteOf(a);
    // A third PC's certificate (B's own would trip the self check).
    const c = await makePc('PC C');
    const forgedC = formatInvite({ ...invite, fingerprint256: c.server.status().fingerprint256! });

    const result = await joinRemoteHost(forgedC, joinerDeps(b));
    expect(result).toMatchObject({ ok: false, error: 'fingerprint-mismatch' });
    // Nothing reached A: the invite is intact and no peer exists.
    expect(a.server.pairingStatus()).toMatchObject({ active: true, attemptsLeft: 5 });
    expect(a.peers.list()).toHaveLength(0);
    expect(b.remoteHosts.list()).toHaveLength(0);
  });

  it('an expired invite is refused', async () => {
    let now = Date.now();
    const a = await makePc('PC A', { deps: { now: () => now } });
    const b = await makePc('PC B');
    const invite = inviteOf(a);
    now += A2A_PAIR_TTL_MS + 1;
    const result = await joinRemoteHost(formatInvite(invite), joinerDeps(b));
    expect(result).toMatchObject({ ok: false, error: 'code-expired' });
    expect(a.peers.list()).toHaveLength(0);
  });

  it('five wrong codes burn the invite (the per-address backoff does not change that)', async () => {
    let now = Date.now();
    const a = await makePc('PC A', { deps: { now: () => now } });
    const b = await makePc('PC B');
    const invite = inviteOf(a);
    const wrong = formatInvite({ ...invite, code: invite.code === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ' });
    for (let i = 0; i < 5; i++) {
      expect(await joinRemoteHost(wrong, joinerDeps(b))).toMatchObject({ ok: false, error: 'code-invalid' });
      now += PAIR_BACKOFF_MAX_MS;
    }
    expect(await joinRemoteHost(formatInvite(invite), joinerDeps(b))).toMatchObject({ ok: false, error: 'code-expired' });
    expect(a.peers.list()).toHaveLength(0);
  });

  it('a locked-out address is told to wait', async () => {
    const a = await makePc('PC A', { deps: { now: () => 1_800_000_000_000 } });
    const b = await makePc('PC B');
    const invite = inviteOf(a);
    const wrong = formatInvite({ ...invite, code: invite.code === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ' });
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) await joinRemoteHost(wrong, joinerDeps(b));
    expect(await joinRemoteHost(formatInvite(invite), joinerDeps(b))).toMatchObject({
      ok: false,
      error: 'rate-limited',
      retryAfterMs: PAIR_BACKOFF_BASE_MS,
    });
    expect(a.server.pairingStatus().lockedUntil).toBe(1_800_000_000_000 + PAIR_BACKOFF_BASE_MS);
  });

  it('a new invite re-pairs the same PC and retires the old credential', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const first = await joinRemoteHost(formatInvite(inviteOf(a)), joinerDeps(b));
    expect(first.ok).toBe(true);
    const aId = a.server.status().hostId!;
    const oldCred = formatPeerCredential(b.remoteHosts.credentialFor(aId)!);
    const again = await joinRemoteHost(formatInvite(inviteOf(a)), joinerDeps(b));
    expect(again.ok).toBe(true);
    expect((await hello(oldCred, a)).status).toBe(401);
    expect((await hello(formatPeerCredential(b.remoteHosts.credentialFor(aId)!), a)).status).toBe(200);
    expect(a.peers.list().filter((p) => p.revokedAt === undefined)).toHaveLength(1);
  });

  it('half pairing, answer lost: the server minted, the joiner never heard; a new invite still works', async () => {
    const minted: string[] = [];
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    // The mint lands after the joiner gave up waiting for the answer.
    const realMint = a.peers.mint.bind(a.peers);
    let slow = true;
    a.peers.mint = async (params) => {
      const c = await realMint(params);
      minted.push(formatPeerCredential(c));
      if (slow) await new Promise((r) => setTimeout(r, 600));
      return c;
    };
    const lost = await joinRemoteHost(formatInvite(inviteOf(a)), { ...joinerDeps(b), timeouts: { connectMs: 2_000, requestMs: 300 } });
    expect(lost).toMatchObject({ ok: false, error: 'timeout' });
    await new Promise((r) => setTimeout(r, 700));
    expect(a.peers.list().filter((p) => p.revokedAt === undefined)).toHaveLength(1);
    expect(b.remoteHosts.list()).toHaveLength(0);

    slow = false;
    const retry = await joinRemoteHost(formatInvite(inviteOf(a)), joinerDeps(b));
    expect(retry.ok).toBe(true);
    expect((await hello(minted[0], a)).status).toBe(401);
  });

  it('half pairing, hello fails: the joiner withdraws the credential it got', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    let issued: string | undefined;
    const client: JoinDeps['client'] = (opts) => {
      const real = new PinnedTlsClient(opts);
      return {
        async requestJson(method, path, body) {
          if (path === A2A_ROUTES.hello) {
            issued = opts.credential;
            return { status: 500, json: null };
          }
          return real.requestJson(method, path, body);
        },
      };
    };
    const failed = await joinRemoteHost(formatInvite(inviteOf(a)), { ...joinerDeps(b), client });
    expect(failed).toMatchObject({ ok: false, error: 'protocol' });
    expect(issued).toBeDefined();
    expect((await hello(issued!, a)).status).toBe(401);
    expect(a.peers.list().filter((p) => p.revokedAt === undefined)).toHaveLength(0);
    expect(a.cascaded).toEqual([b.server.status().hostId]);
    expect((await joinRemoteHost(formatInvite(inviteOf(a)), joinerDeps(b))).ok).toBe(true);
  });

  it('half pairing, saving fails: the joiner withdraws too', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const failing = { add: () => { throw new Error('disk full'); } };
    const failed = await joinRemoteHost(formatInvite(inviteOf(a)), { ...joinerDeps(b), remoteHosts: failing });
    expect(failed).toMatchObject({ ok: false, error: 'failed' });
    expect(a.peers.list().filter((p) => p.revokedAt === undefined)).toHaveLength(0);
  });

  it('falls back to the invite’s alt addresses, saves the one that answered first and keeps the failed ones last', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const invite = inviteOf(a);
    // A name that cannot resolve, then the real address, then one never tried.
    // The failed name is kept (last), not dropped: after the PC moves (office
    // LAN <-> tailnet) it may be the only address that works.
    const withAlt = formatInvite({ ...invite, host: 'no-such-host.invalid', alt: ['127.0.0.1', '100.64.0.9'] });
    const result = await joinRemoteHost(withAlt, joinerDeps(b));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.host.addresses).toEqual(['127.0.0.1', '100.64.0.9', 'no-such-host.invalid']);
  });

  it('joining this PC’s own invite is refused', async () => {
    const b = await makePc('PC B');
    const result = await joinRemoteHost(b.server.beginPairing().invite, joinerDeps(b));
    expect(result).toMatchObject({ ok: false, error: 'self' });
    expect(b.peers.list()).toHaveLength(0);
  });

  it('distinguishes refused from unparseable', async () => {
    const b = await makePc('PC B');
    const a = await makePc('PC A');
    const invite = inviteOf(a);
    const closedPort = await freePort();
    const refused = await joinRemoteHost(formatInvite({ ...invite, port: closedPort }), joinerDeps(b));
    expect(refused).toMatchObject({ ok: false, error: 'connect-refused' });
    expect(await joinRemoteHost('not an invite', joinerDeps(b))).toMatchObject({ ok: false, error: 'invite-invalid' });
  });

  function rpcFor(pc: Pc, cascade: (hostId: string) => void) {
    const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
    registerA2aRemoteRpc((m, h) => handlers.set(m, h), {
      controller: pc.controller,
      server: pc.server,
      peers: pc.peers,
      remoteHosts: pc.remoteHosts,
      cascade,
      log: () => undefined,
      joinOverrides: { timeouts: FAST },
    });
    return (method: string, params: Record<string, unknown> = {}) => handlers.get(method)!(params);
  }

  it('peers.revoke cascades to the link and exposure stores', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    expect((await joinRemoteHost(formatInvite(inviteOf(a)), joinerDeps(b))).ok).toBe(true);
    const links = { forgetHost: vi.fn(() => 0) };
    const exposures = { forgetHost: vi.fn(() => true) };
    const call = rpcFor(a, forgetHostCascade({ links, exposures }, () => undefined));
    const [peer] = a.peers.list();
    expect(await call('a2a.remote.peers.revoke', { peerId: peer.peerId })).toEqual({ ok: true });
    expect(links.forgetHost).toHaveBeenCalledWith(b.server.status().hostId);
    expect(exposures.forgetHost).toHaveBeenCalledWith(b.server.status().hostId);
    expect(a.peers.list()[0].revokedAt).toBeDefined();
    expect(await call('a2a.remote.peers.revoke', { peerId: 'unknown' })).toEqual({ ok: false });
  });

  it('hosts.remove tells the other PC, cascades here, and still removes when the other PC is gone', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const cascaded: string[] = [];
    const call = rpcFor(b, (h) => cascaded.push(h));
    expect((await call('a2a.remote.join', { invite: a.server.beginPairing().invite }) as { ok: boolean }).ok).toBe(true);
    const aId = a.server.status().hostId!;
    expect(await call('a2a.remote.hosts.remove', { hostId: aId })).toEqual({ ok: true, remoteRevoked: true });
    expect(b.remoteHosts.list()).toHaveLength(0);
    expect(cascaded).toEqual([aId]);
    expect(a.peers.list().filter((p) => p.revokedAt === undefined)).toHaveLength(0);
    expect(a.cascaded).toEqual([b.server.status().hostId]);

    // Pair again, then take A offline: the removal still happens here.
    expect((await call('a2a.remote.join', { invite: a.server.beginPairing().invite }) as { ok: boolean }).ok).toBe(true);
    a.controller.configure({ enabled: false });
    await a.server.whenIdle();
    expect(await call('a2a.remote.hosts.remove', { hostId: aId })).toEqual({ ok: true, remoteRevoked: false });
    expect(b.remoteHosts.list()).toHaveLength(0);
  });
});
