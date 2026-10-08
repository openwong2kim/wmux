import dns from 'node:dns';
import net from 'node:net';
import {
  A2A_REMOTE_PROTOCOL,
  A2A_ROUTES,
  formatPeerCredential,
  isHostId,
  normalizeFingerprint256,
  parseInvite,
  parsePeerCredential,
  type A2aPairRequest,
  type A2aRemoteHostRecordV1,
  type PeerCredential,
} from '../../shared/a2aRemote';
import type { A2aRemoteJoinError, A2aRemoteJoinResult } from '../../shared/rpc';
import { PinnedClientError, PinnedTlsClient, type PinnedClientOptions } from './pinnedClient';
import type { NewRemoteHost } from './remoteHostStore';

/**
 * Joiner side of invite pairing. The invite carries the server's certificate
 * fingerprint, so the very first byte this side writes already goes over a
 * pinned connection: a wrong certificate fails before the pairing code (or,
 * later, the credential) leaves this machine.
 */

/** What the joiner needs from a pinned client (a seam for tests). */
export interface JsonClient {
  requestJson(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

export interface JoinDeps {
  /** This PC's identity (hostId + fingerprint). Loaded on demand. */
  self: () => { hostId: string; fingerprint256: string };
  selfName: string;
  remoteHosts: { add(input: NewRemoteHost, credential: PeerCredential): A2aRemoteHostRecordV1 };
  /** Resolve a host name to the IPv4 it reaches, to remember next to the name. */
  lookup?: (host: string) => Promise<string | null>;
  /** Test seam. */
  timeouts?: { connectMs: number; requestMs: number };
  /** Test seam; default `new PinnedTlsClient(opts)`. */
  client?: (opts: PinnedClientOptions) => JsonClient;
}

const DEFAULT_TIMEOUTS = { connectMs: 5_000, requestMs: 10_000 };

class JoinFailure extends Error {
  constructor(
    readonly code: A2aRemoteJoinError,
    detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(detail);
  }
}

async function defaultLookup(host: string): Promise<string | null> {
  try {
    return (await dns.promises.lookup(host, { family: 4 })).address;
  } catch {
    return null;
  }
}

const defaultClient = (opts: PinnedClientOptions): JsonClient => new PinnedTlsClient(opts);

export async function joinRemoteHost(inviteString: string, deps: JoinDeps): Promise<A2aRemoteJoinResult> {
  try {
    return { ok: true, host: await join(inviteString, deps) };
  } catch (err) {
    if (err instanceof JoinFailure) {
      return {
        ok: false,
        error: err.code,
        detail: err.message,
        ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      };
    }
    return { ok: false, error: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function join(inviteString: string, deps: JoinDeps): Promise<A2aRemoteHostRecordV1> {
  const parsed = parseInvite(inviteString);
  if (!parsed.ok) throw new JoinFailure('invite-invalid', `invite: ${parsed.error}`);
  const invite = parsed.invite;

  const self = deps.self();
  if (normalizeFingerprint256(self.fingerprint256) === invite.fingerprint256) {
    throw new JoinFailure('self', 'the invite was made on this PC');
  }

  const timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS;
  const makeClient = deps.client ?? defaultClient;
  const optsFor = (address: string, credential?: string): PinnedClientOptions => ({
    addresses: [address],
    port: invite.port,
    fingerprint256: invite.fingerprint256,
    connectTimeoutMs: timeouts.connectMs,
    requestTimeoutMs: timeouts.requestMs,
    ...(credential ? { credential } : {}),
  });

  // Try the invite's addresses in order, one at a time, so the one that
  // answered is known. Only "nothing was sent" connect failures move on; a
  // wrong certificate or a sent request stops here.
  const request: A2aPairRequest = { code: invite.code, hostId: self.hostId, name: deps.selfName, protocol: A2A_REMOTE_PROTOCOL };
  const candidates = [invite.host, ...(invite.alt ?? [])];
  let reached: string | null = null;
  let paired: { status: number; json: unknown } | null = null;
  let lastConnectFailure: unknown = null;
  for (const address of candidates) {
    try {
      paired = await makeClient(optsFor(address)).requestJson('POST', A2A_ROUTES.pair, request);
      reached = address;
      break;
    } catch (err) {
      if (err instanceof PinnedClientError && err.code === 'connect-failed') {
        lastConnectFailure = err;
        continue;
      }
      throw transportFailure(err);
    }
  }
  if (!paired || !reached) throw transportFailure(lastConnectFailure);
  if (paired.status !== 200) throw pairRefusal(paired.status, paired.json);

  const body = isRecord(paired.json) ? paired.json : {};
  const credential = parsePeerCredential(body['credential']);
  if (!credential) throw new JoinFailure('protocol', 'the pairing answer is malformed');
  const bearer = formatPeerCredential(credential);
  const authed = makeClient(optsFor(reached, bearer));

  // From here the server holds a live peer for this PC. Any failure withdraws
  // it (best effort) so the pairing never exists on one side only.
  try {
    const serverHostId = body['hostId'];
    const serverName = typeof body['name'] === 'string' ? body['name'] : '';
    if (!isHostId(serverHostId) || body['protocol'] !== A2A_REMOTE_PROTOCOL) {
      throw new JoinFailure('protocol', 'the pairing answer is malformed');
    }
    if (serverHostId === self.hostId) throw new JoinFailure('self', 'the invite was made on this PC');

    // Prove the credential works and that the same host answers with it.
    let hello: { status: number; json: unknown };
    try {
      hello = await authed.requestJson('GET', A2A_ROUTES.hello);
    } catch (err) {
      throw transportFailure(err);
    }
    const helloBody = isRecord(hello.json) ? hello.json : {};
    if (hello.status !== 200 || helloBody['hostId'] !== serverHostId) {
      throw new JoinFailure('protocol', `hello answered ${hello.status} for another identity`);
    }

    // Save the address that answered first, then the rest of the invite's
    // (minus any that failed to connect before it). A name that answered is
    // also remembered with the IPv4 it resolved to, so a later DNS outage
    // does not strand the pairing.
    const failedBefore = new Set(candidates.slice(0, candidates.indexOf(reached)));
    const resolved = net.isIPv4(reached) ? null : await (deps.lookup ?? defaultLookup)(reached);
    const addresses = [reached, ...(resolved ? [resolved] : []), ...candidates.filter((a) => a !== reached && !failedBefore.has(a))];
    try {
      return deps.remoteHosts.add(
        {
          hostId: serverHostId,
          name: serverName,
          addresses,
          port: invite.port,
          fingerprint256: invite.fingerprint256,
          peerId: credential.peerId,
        },
        credential,
      );
    } catch (err) {
      throw new JoinFailure('failed', `could not save the pairing: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    await withdraw(authed);
    throw err;
  }
}

/** Ask the server to revoke the calling peer. Best effort: true only on a 200. */
async function withdraw(client: JsonClient): Promise<boolean> {
  try {
    return (await client.requestJson('POST', A2A_ROUTES.unpair, {})).status === 200;
  } catch {
    return false;
  }
}

/**
 * Tell a paired server this PC is leaving (`POST /api/a2a/unpair`) over the
 * pinned connection. Best effort: false when it could not be confirmed.
 */
export async function unpairRemoteHost(
  host: A2aRemoteHostRecordV1,
  credential: PeerCredential,
  opts: { timeouts?: { connectMs: number; requestMs: number }; client?: (o: PinnedClientOptions) => JsonClient } = {},
): Promise<boolean> {
  const timeouts = opts.timeouts ?? { connectMs: 3_000, requestMs: 5_000 };
  return withdraw(
    (opts.client ?? defaultClient)({
      addresses: host.addresses,
      port: host.port,
      fingerprint256: host.fingerprint256,
      credential: formatPeerCredential(credential),
      connectTimeoutMs: timeouts.connectMs,
      requestTimeoutMs: timeouts.requestMs,
    }),
  );
}

function transportFailure(err: unknown): JoinFailure {
  if (err instanceof JoinFailure) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (!(err instanceof PinnedClientError)) return new JoinFailure('failed', msg);
  switch (err.code) {
    case 'fingerprint-mismatch':
      return new JoinFailure('fingerprint-mismatch', msg);
    case 'timeout':
      return new JoinFailure('timeout', msg);
    case 'connect-failed':
      if (/ECONNREFUSED/.test(msg)) return new JoinFailure('connect-refused', msg);
      if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(msg)) return new JoinFailure('not-found', msg);
      if (/timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(msg)) return new JoinFailure('timeout', msg);
      return new JoinFailure('failed', msg);
    default:
      return new JoinFailure('failed', msg);
  }
}

function pairRefusal(status: number, json: unknown): JoinFailure {
  const body = isRecord(json) ? json : {};
  const reason = body['reason'];
  const error = body['error'];
  if (status === 429 || reason === 'rate-limited') {
    const after = body['retryAfterMs'];
    const retryAfterMs = typeof after === 'number' && Number.isFinite(after) && after > 0 ? Math.ceil(after) : undefined;
    return new JoinFailure('rate-limited', 'too many failed attempts; wait and retry', retryAfterMs);
  }
  if (status === 409) return new JoinFailure('already-paired', 'another pairing for this PC finished at the same time');
  if (reason === 'self') return new JoinFailure('self', 'the invite was made on this PC');
  if (reason === 'expired') return new JoinFailure('code-expired', 'the invite expired or was cancelled');
  if (reason === 'invalid-code') return new JoinFailure('code-invalid', 'the invite code was not accepted');
  if (error === 'protocol') return new JoinFailure('protocol', 'the other PC speaks another protocol version');
  return new JoinFailure('failed', `pairing answered HTTP ${status}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
