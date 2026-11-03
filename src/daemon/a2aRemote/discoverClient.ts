import crypto from 'node:crypto';
import {
  A2A_DISCOVER_NAME_MAX,
  A2A_DISCOVER_TOKEN_HEADER,
  A2A_REMOTE_PROTOCOL,
  A2A_ROUTES,
  formatInvite,
  isCanonicalIpv4,
  normalizeFingerprint256,
  type A2aDiscoverRequestBody,
  type A2aRemoteHostRecordV1,
  type HostId,
  type PeerCredential,
} from '../../shared/a2aRemote';
import type {
  A2aDiscoverConnectError,
  A2aDiscoverConnectResult,
  A2aDiscoverOutgoingStatus,
  A2aDiscoverPc,
  A2aDiscoverScanResult,
} from '../../shared/rpc';
import { decodeSecret, discoverCode, discoverCommit, randomSecret } from './discoverCode';
import { joinRemoteHost, type JoinDeps, type JsonClient } from './joiner';
import { PinnedClientError, PinnedTlsClient, probeUnpinned, type PinnedClientOptions, type UnpinnedProbe } from './pinnedClient';
import type { NewRemoteHost } from './remoteHostStore';
import type { TailnetCli } from './tailnet';

/**
 * The requesting side of tailnet discovery: find the wmux PCs on this user's
 * tailnet that are discoverable right now, and ask one to pair.
 *
 * Scan reads `tailscale status`, keeps this user's own online desktops (not
 * this PC, no phones, no other user's or tagged nodes, at most 64) and probes
 * each on the default A2A port and this PC's own, 8 at a time. The probe is
 * unpinned and carries nothing; it records the certificate the PC presented.
 * Every later call to that PC pins that recorded fingerprint, and `connect`
 * takes only an IP from the last scan, never an address or a port from the
 * caller. The 6-digit code binds the pinned fingerprint, so a man in the
 * middle shows a different code on each screen.
 *
 * One outgoing request at a time. Allowed, it pairs exactly as an invite
 * join does, merging the tailnet address into an existing pairing's
 * addresses rather than replacing them.
 */

export const DISCOVER_SCAN_MAX = 64;
export const DISCOVER_PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUTS = { connectMs: 1_500, requestMs: 1_500 };
const REQUEST_TIMEOUTS = { connectMs: 3_000, requestMs: 5_000 };
const STATUS_TIMEOUT_MS = 5_000;
const POLL_MS = 1_500;
/** A poll past the card's deadline by this much with no answer ends the wait as expired. */
const POLL_GRACE_MS = 10_000;
/** A PC missing from this many scans in a row is greyed (stale); one more and it is dropped. */
const STALE_AFTER = 2;
const DROP_AFTER = 3;

const DESKTOP_OS = new Set(['windows', 'macos', 'linux']);
const MOBILE_OS = new Set(['ios', 'ipados', 'android', 'tvos']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DiscoverClientDeps {
  tailnet: TailnetCli;
  /** This PC's identity (hostId + fingerprint). */
  self: () => { hostId: string; fingerprint256: string };
  selfName: () => string;
  /** The ports to probe, in order: the default A2A port, then this PC's own when it differs. */
  ports: () => number[];
  remoteHosts: {
    list(): A2aRemoteHostRecordV1[];
    get(hostId: HostId): A2aRemoteHostRecordV1 | undefined;
    add(input: NewRemoteHost, credential: PeerCredential): A2aRemoteHostRecordV1;
  };
  now?: () => number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seams. */
  dial?: (ip: string) => string;
  probe?: typeof probeUnpinned;
  client?: (opts: PinnedClientOptions) => JsonClient;
  pollMs?: number;
  joinTimeouts?: { connectMs: number; requestMs: number };
}

interface Found {
  pc: Omit<A2aDiscoverPc, 'state'> & { state: 'ready' | 'version-mismatch' };
  port: number;
  fingerprint256: string;
  missed: number;
}

interface Session {
  status: A2aDiscoverOutgoingStatus;
  ownerClientId: string | null;
  ip: string;
  port: number;
  fingerprint256: string;
  requestId: string | null;
  token: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const ACTIVE = new Set<A2aDiscoverOutgoingStatus['state']>(['asking', 'waiting', 'joining']);

class ConnectFailure extends Error {
  constructor(
    readonly error: A2aDiscoverConnectError,
    detail: string,
    readonly extra: { reason?: 'unidentified' | 'other-user' | 'denied' | 'self'; retryAfterMs?: number } = {},
  ) {
    super(detail);
  }
}

export class DiscoverClient {
  private readonly deps: DiscoverClientDeps;
  private readonly now: () => number;
  private readonly found = new Map<string, Found>();
  private scanning: Promise<A2aDiscoverScanResult> | null = null;
  private session: Session | null = null;

  constructor(deps: DiscoverClientDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  // --- scan ----------------------------------------------------------------------

  /** Find discoverable PCs. A scan already running is shared. */
  scan(): Promise<A2aDiscoverScanResult> {
    this.scanning ??= this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doScan(): Promise<A2aDiscoverScanResult> {
    const read = await this.deps.tailnet.status(AbortSignal.timeout(STATUS_TIMEOUT_MS));
    if (!read.ok) return { ok: false, reason: 'tailscale-not-ready', check: read.check };
    const { self, peers, selfLogin } = read.status;
    if (self.ipv4s.length === 0) return { ok: false, reason: 'no-tailnet-ipv4' };
    const selfIps = new Set(self.ipv4s);
    const skipped = { offline: 0, mobile: 0, otherUser: 0, unsupported: 0, overCap: 0 };
    const targets: Array<{ ip: string; device: string; dnsName: string; os: string }> = [];
    for (const peer of peers) {
      if (peer.stableId === self.stableId) continue;
      if (self.userId === null || peer.userId !== self.userId || peer.tags.length > 0 || peer.sharee) {
        skipped.otherUser += 1;
        continue;
      }
      const os = peer.os.toLowerCase();
      if (MOBILE_OS.has(os)) {
        skipped.mobile += 1;
        continue;
      }
      const ip = peer.ipv4s.find((a) => !selfIps.has(a));
      if (!DESKTOP_OS.has(os) || !ip) {
        skipped.unsupported += 1;
        continue;
      }
      if (!peer.online) {
        skipped.offline += 1;
        continue;
      }
      targets.push({ ip, device: peer.hostName || peer.dnsName.split('.')[0] || ip, dnsName: peer.dnsName, os: peer.os });
    }
    if (targets.length > DISCOVER_SCAN_MAX) {
      skipped.overCap = targets.length - DISCOVER_SCAN_MAX;
      targets.length = DISCOVER_SCAN_MAX;
    }

    const own = normalizeFingerprint256(this.deps.self().fingerprint256);
    const joined = new Set(this.deps.remoteHosts.list().map((h) => h.fingerprint256));
    const seen = new Map<string, Found>();
    await mapLimit(targets, DISCOVER_PROBE_CONCURRENCY, async (t) => {
      const hit = await this.probe(t.ip);
      if (!hit || hit.fingerprint256 === own) return;
      seen.set(t.ip, {
        pc: {
          ip: t.ip,
          device: t.device,
          dnsName: t.dnsName,
          os: t.os,
          login: selfLogin,
          name: hit.name,
          version: hit.version,
          state: hit.protocol === A2A_REMOTE_PROTOCOL ? 'ready' : 'version-mismatch',
          alreadyConnected: joined.has(hit.fingerprint256),
        },
        port: hit.port,
        fingerprint256: hit.fingerprint256,
        missed: 0,
      });
    });

    // A PC missing from a scan is kept, greyed after two misses, dropped at the third.
    for (const [ip, f] of this.found) {
      if (seen.has(ip)) continue;
      f.missed += 1;
      if (f.missed >= DROP_AFTER) this.found.delete(ip);
    }
    for (const [ip, f] of seen) this.found.set(ip, f);
    const pcs: A2aDiscoverPc[] = [...this.found.values()].map((f) => ({ ...f.pc, state: f.missed >= STALE_AFTER ? 'stale' : f.pc.state }));
    return { ok: true, pcs, checked: targets.length, skipped };
  }

  /** The first port on which `ip` answers as a discoverable wmux. */
  private async probe(ip: string): Promise<{ port: number; fingerprint256: string; name: string; version: string; protocol: number } | null> {
    for (const port of [...new Set(this.deps.ports())]) {
      let answer: UnpinnedProbe;
      try {
        answer = await (this.deps.probe ?? probeUnpinned)({
          address: this.dial(ip),
          port,
          path: A2A_ROUTES.discover,
          connectTimeoutMs: PROBE_TIMEOUTS.connectMs,
          requestTimeoutMs: PROBE_TIMEOUTS.requestMs,
        });
      } catch {
        continue;
      }
      const body = isRecord(answer.json) ? answer.json : {};
      if (answer.status !== 200 || body['discover'] !== 1) continue;
      const protocol = body['protocol'];
      return {
        port,
        fingerprint256: answer.fingerprint256,
        name: typeof body['name'] === 'string' ? body['name'].slice(0, A2A_DISCOVER_NAME_MAX) : '',
        version: typeof body['version'] === 'string' ? body['version'].slice(0, 32) : '',
        protocol: typeof protocol === 'number' ? protocol : 0,
      };
    }
    return null;
  }

  // --- connect -------------------------------------------------------------------

  /** Ask the PC at `ip` (from the last scan) to pair. Resolves once both screens can show the code. */
  async connect(ip: string, clientId: string | null = null): Promise<A2aDiscoverConnectResult> {
    if (this.session && ACTIVE.has(this.session.status.state)) return { ok: false, error: 'outgoing-busy' };
    const found = isCanonicalIpv4(ip) ? this.found.get(ip) : undefined;
    if (!found || found.missed >= STALE_AFTER) return { ok: false, error: 'not-found' };
    if (found.pc.state === 'version-mismatch') return { ok: false, error: 'version-mismatch' };

    const sessionId = crypto.randomUUID();
    const session: Session = {
      status: { state: 'asking', sessionId, pc: { ...found.pc }, code: null, expiresAt: null },
      ownerClientId: clientId,
      ip,
      port: found.port,
      fingerprint256: found.fingerprint256,
      requestId: null,
      token: null,
      timer: null,
    };
    this.session = session;
    try {
      const { code, expiresAt } = await this.ask(session);
      if (this.session !== session || session.status.state !== 'asking') {
        // Cancelled while asking: the request it made is withdrawn.
        void this.withdraw(session);
        return { ok: false, error: 'failed', detail: 'cancelled' };
      }
      session.status = { ...session.status, state: 'waiting', code, expiresAt };
      this.schedulePoll(session);
      return { ok: true, sessionId, code, expiresAt };
    } catch (err) {
      const f = err instanceof ConnectFailure ? err : new ConnectFailure('failed', errMsg(err));
      if (this.session === session && session.status.state === 'asking') {
        session.status = { ...session.status, state: f.error === 'gone' ? 'gone' : 'failed', detail: f.message };
      }
      return { ok: false, error: f.error, detail: f.message, ...f.extra };
    }
  }

  /** Request, then reveal: the code both screens show. */
  private async ask(session: Session): Promise<{ code: string; expiresAt: number }> {
    const self = this.deps.self();
    const nonceR = randomSecret();
    const body: A2aDiscoverRequestBody = {
      protocol: A2A_REMOTE_PROTOCOL,
      hostId: self.hostId,
      name: this.deps.selfName().slice(0, A2A_DISCOVER_NAME_MAX),
      fingerprint256: self.fingerprint256,
      commit: discoverCommit(nonceR),
    };
    const created = await this.call(session, 'POST', `${A2A_ROUTES.discover}/requests`, body);
    if (created.status !== 201) throw refusalOf(created.status, created.json);
    const c = isRecord(created.json) ? created.json : {};
    const requestId = c['requestId'];
    const token = c['token'];
    const nonceS = c['nonce'];
    if (typeof requestId !== 'string' || !UUID_RE.test(requestId) || !decodeSecret(token) || !decodeSecret(nonceS)) {
      throw new ConnectFailure('protocol', 'the request answer is malformed');
    }
    session.requestId = requestId;
    session.token = token as string;

    const revealed = await this.call(session, 'POST', `${A2A_ROUTES.discover}/requests/${requestId}/reveal`, { nonce: nonceR });
    if (revealed.status !== 200) throw refusalOf(revealed.status, revealed.json);
    const r = isRecord(revealed.json) ? revealed.json : {};
    const expiresAt = typeof r['expiresAt'] === 'number' ? r['expiresAt'] : this.now();
    const code = discoverCode({
      nonceS: nonceS as string,
      nonceR,
      fingerprintS: session.fingerprint256,
      fingerprintR: self.fingerprint256,
      hostIdR: self.hostId,
    });
    return { code, expiresAt };
  }

  private schedulePoll(session: Session): void {
    session.timer = setTimeout(() => {
      session.timer = null;
      void this.poll(session);
    }, this.deps.pollMs ?? POLL_MS);
    session.timer.unref?.();
  }

  private async poll(session: Session): Promise<void> {
    if (this.session !== session || session.status.state !== 'waiting' || !session.requestId) return;
    let answer: { status: number; json: unknown } | null = null;
    try {
      answer = await this.call(session, 'GET', `${A2A_ROUTES.discover}/requests/${session.requestId}`);
    } catch {
      answer = null;
    }
    if (this.session !== session || session.status.state !== 'waiting') return;
    if (answer === null) {
      // No answer this time. Past the card's deadline, the wait is over.
      if (this.now() > (session.status.expiresAt ?? 0) + POLL_GRACE_MS) this.end(session, 'expired');
      else this.schedulePoll(session);
      return;
    }
    if (answer.status !== 200) return this.end(session, 'gone');
    const p = isRecord(answer.json) ? answer.json : {};
    switch (p['state']) {
      case 'waiting':
        this.schedulePoll(session);
        return;
      case 'allowed':
        if (typeof p['code'] === 'string') return void this.join(session, p['code']);
        return this.end(session, 'failed', { error: 'protocol', detail: 'allowed without a pairing code' });
      case 'denied':
        return this.end(session, 'denied');
      case 'expired':
        return this.end(session, 'expired');
      case 'closed':
        return p['reason'] === 'failed' ? this.end(session, 'failed', { error: 'failed', detail: 'the other PC could not complete the pairing' }) : this.end(session, 'gone');
      default:
        return this.end(session, 'failed', { error: 'protocol', detail: 'unexpected poll answer' });
    }
  }

  /** Allowed: pair exactly as an invite join would, with the code the other PC granted and the pinned fingerprint. */
  private async join(session: Session, grant: string): Promise<void> {
    session.status = { ...session.status, state: 'joining' };
    const remoteHosts = this.deps.remoteHosts;
    const deps: JoinDeps = {
      self: this.deps.self,
      selfName: this.deps.selfName(),
      // Re-pairing keeps the addresses the pairing already had, after the tailnet one.
      remoteHosts: {
        add: (input, credential) => {
          const prev = remoteHosts.get(input.hostId);
          return remoteHosts.add({ ...input, addresses: [...input.addresses, ...(prev?.addresses ?? [])] }, credential);
        },
      },
      client: (opts) => this.client({ ...opts, addresses: opts.addresses.map((a) => this.dial(a)) }),
      ...(this.deps.joinTimeouts ? { timeouts: this.deps.joinTimeouts } : {}),
    };
    const result = await joinRemoteHost(formatInvite({ host: session.ip, port: session.port, code: grant, fingerprint256: session.fingerprint256 }), deps);
    if (this.session !== session) return;
    if (result.ok) {
      session.status = { ...session.status, state: 'joined', host: result.host };
      this.deps.log('info', `[a2a-remote] paired with ${result.host.name} (${session.ip}) through tailnet discovery`);
    } else {
      this.end(session, 'failed', { error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
    }
  }

  // --- status and cancel ------------------------------------------------------------

  outgoingStatus(): A2aDiscoverOutgoingStatus {
    return this.session ? structuredClone(this.session.status) : { state: 'idle', sessionId: null, pc: null, code: null, expiresAt: null };
  }

  /** Stop asking; the other PC is told (best effort). A pairing already joining finishes. */
  async cancel(): Promise<A2aDiscoverOutgoingStatus> {
    const session = this.session;
    if (session && (session.status.state === 'asking' || session.status.state === 'waiting')) {
      this.end(session, 'cancelled');
      await this.withdraw(session);
    }
    return this.outgoingStatus();
  }

  /** The app connection that asked went away: cancel its request. */
  clientGone(clientId: string): void {
    if (this.session && this.session.ownerClientId === clientId) void this.cancel();
  }

  // --- helpers --------------------------------------------------------------------

  private end(session: Session, state: A2aDiscoverOutgoingStatus['state'], extra: Pick<A2aDiscoverOutgoingStatus, 'error' | 'detail'> = {}): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.status = { ...session.status, state, ...extra };
  }

  private async withdraw(session: Session): Promise<void> {
    if (!session.requestId || !session.token) return;
    await this.call(session, 'POST', `${A2A_ROUTES.discover}/requests/${session.requestId}/withdraw`, {}).catch(() => undefined);
  }

  /** One pinned call to the session's PC; the token rides along once there is one. */
  private async call(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    try {
      return await this.client({
        addresses: [this.dial(session.ip)],
        port: session.port,
        fingerprint256: session.fingerprint256,
        connectTimeoutMs: REQUEST_TIMEOUTS.connectMs,
        requestTimeoutMs: REQUEST_TIMEOUTS.requestMs,
        ...(session.token ? { headers: { [A2A_DISCOVER_TOKEN_HEADER]: session.token } } : {}),
      }).requestJson(method, path, body);
    } catch (err) {
      throw transportFailure(err);
    }
  }

  private client(opts: PinnedClientOptions): JsonClient {
    return (this.deps.client ?? ((o: PinnedClientOptions) => new PinnedTlsClient(o)))(opts);
  }

  private dial(ip: string): string {
    return this.deps.dial ? this.deps.dial(ip) : ip;
  }
}

function refusalOf(status: number, json: unknown): ConnectFailure {
  const body = isRecord(json) ? json : {};
  const reason = body['reason'];
  const after = body['retryAfterMs'];
  const retryAfterMs = typeof after === 'number' && Number.isFinite(after) && after >= 0 ? Math.ceil(after) : undefined;
  const timing = retryAfterMs !== undefined ? { retryAfterMs } : {};
  if (status === 401) return new ConnectFailure('gone', 'the PC is no longer discoverable');
  if (status === 429) return new ConnectFailure(reason === 'busy' ? 'busy' : 'rate-limited', `the PC answered ${String(reason)}`, timing);
  if (status === 403 && (reason === 'unidentified' || reason === 'other-user' || reason === 'denied' || reason === 'self')) {
    return new ConnectFailure('refused', `the PC refused: ${reason}`, { reason });
  }
  if (status === 400 && body['error'] === 'protocol') return new ConnectFailure('protocol', 'the PC speaks another protocol version');
  if (status === 404 || status === 409) return new ConnectFailure('gone', `the request is no longer open (HTTP ${status})`);
  return new ConnectFailure('failed', `the PC answered HTTP ${status}`);
}

function transportFailure(err: unknown): ConnectFailure {
  const msg = errMsg(err);
  if (!(err instanceof PinnedClientError)) return new ConnectFailure('failed', msg);
  switch (err.code) {
    case 'fingerprint-mismatch':
      return new ConnectFailure('fingerprint-mismatch', msg);
    case 'timeout':
      return new ConnectFailure('timeout', msg);
    case 'connect-failed':
      if (/ECONNREFUSED/.test(msg)) return new ConnectFailure('connect-refused', msg);
      if (/timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(msg)) return new ConnectFailure('timeout', msg);
      return new ConnectFailure('failed', msg);
    default:
      return new ConnectFailure('failed', msg);
  }
}

/** Run `fn` over `items`, at most `limit` at once. */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
