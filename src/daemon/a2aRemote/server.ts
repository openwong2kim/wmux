import fs from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import os from 'node:os';
import {
  A2A_REMOTE_BODY_MAX,
  A2A_REMOTE_PROTOCOL,
  A2A_ROUTES,
  INVITE_ALT_MAX,
  formatPeerCredential,
  isA2aRoute,
  isHostId,
  isTailnetIpv4,
  looksLikePeerCredential,
  parsePeerCredential,
  type A2aHelloResponse,
  type A2aPairRefusal,
  type A2aPairResponse,
  type A2aRemoteErrorCode,
} from '../../shared/a2aRemote';
import type { A2aRemotePairBeginResult, A2aRemotePairStatus, A2aRemoteStatus } from '../../shared/rpc';
import type { WebA2aPeer, WebA2aRoutes } from '../web/WebTerminalServer';
import { A2A_REMOTE_CONFIG_CHANGED, type A2aRemoteConfig, type A2aRemoteController } from './controller';
import { loadOrCreateHostIdentity, type HostIdentity, type HostIdentityOptions } from './hostIdentity';
import { PairingSlot, inviteHost } from './pairing';
import type { PeerAuthResult } from './peerStore';

/**
 * The dedicated cross-host A2A listener: a small HTTPS server serving the
 * host identity's self-signed certificate on `0.0.0.0:<port>`, and nothing
 * but `/api/a2a/*`.
 *
 * Deliberately NOT the phone web server (WebTerminalServer): that server
 * cannot run native TLS beside tailscale, opens device pairing to the whole
 * LAN once TLS is on, and has one bind/TLS setting for both jobs. This one
 * holds no operator token and no device store, so it has nothing to issue
 * but a PEER credential.
 *
 * No Host allowlist: there is no browser client. Instead any request that
 * carries an `Origin` header is refused (403) before anything else — a
 * server-to-server call never sends one, and a browser always does on a
 * cross-origin fetch, so a DNS-rebinding page cannot reach a route.
 */

/**
 * Cap on a request body. The contract caps a message's TEXT at
 * `A2A_REMOTE_BODY_MAX`; JSON escaping can grow that text, so the envelope
 * around a full-size text gets twice the room plus the fixed fields.
 */
export const A2A_REQUEST_BODY_MAX = 2 * A2A_REMOTE_BODY_MAX + 4096;

const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 64;

/**
 * Per-source-address backoff on failed pairings (wrong or expired code), on
 * top of the invite's own 5-attempt burn: the first `PAIR_FREE_FAILURES` are
 * free, then each further failure doubles a lockout (429) up to the cap.
 */
export const PAIR_FREE_FAILURES = 3;
export const PAIR_BACKOFF_BASE_MS = 1_000;
export const PAIR_BACKOFF_MAX_MS = 60_000;
const PAIR_BACKOFF_TRACKED_MAX = 1024;

/** The slice of `PeerStore` the listener needs. */
export interface A2aPeerSource {
  resolve(peerId: string, secret: string): Promise<PeerAuthResult>;
  touch(peerId: string): void;
  mint(params: { hostId: string; name: string }): Promise<{ peerId: string; secret: string }>;
  listByHost(hostId: string): Array<{ peerId: string; revokedAt?: string }>;
  revoke(peerId: string): boolean;
}

export type A2aServerLog = (level: 'info' | 'warn' | 'error', msg: string) => void;

export interface A2aServerDeps {
  controller: A2aRemoteController;
  /** Directory holding the host identity (`<wmux dir>/a2a`). */
  identityDir: string;
  peers: A2aPeerSource;
  /**
   * Revoke cascade, run after this listener revoked a peer (a re-pair or an
   * unpair): end that host's links and drop what it could see.
   */
  onPeerRevoked?: (hostId: string) => void;
  /** Every other `/api/a2a/*` route, reached only with an authenticated peer. Absent: 503. */
  routes?: WebA2aRoutes;
  /** This machine's name. Default `os.hostname()`. */
  hostname?: () => string;
  /** The IPv4s another PC should try, best first. Default `inviteIpv4s()`. */
  ipv4s?: () => string[];
  /**
   * This PC's tailnet IPv4s (100.64/10 on a Tailscale adapter). Default: from
   * `rankedExternalIpv4s()`, or none when `ipv4s` is overridden.
   */
  tailnetIpv4s?: () => string[];
  /** Bind address. Default `0.0.0.0` (PoC); tests bind loopback. */
  bindHost?: string;
  /** Clock for the invite's lifetime and the pairing backoff. Default `Date.now`. */
  now?: () => number;
  /** Test seam; default `loadOrCreateHostIdentity`. */
  loadIdentity?: (opts: HostIdentityOptions) => HostIdentity;
  log?: A2aServerLog;
}

/** Interface names of virtual adapters, whose addresses another PC usually cannot reach. */
const VIRTUAL_NIC_RE = /vEthernet|docker|^br-|veth|vmnet|virtualbox|vboxnet|utun|tailscale|wsl|hyper-v/i;
/** Interface names Tailscale uses: `tailscale0` (Linux), `Tailscale` (Windows), `utunN` (macOS). */
const TAILSCALE_NIC_RE = /tailscale|utun/i;

function octets(ip: string): number[] {
  return ip.split('.').map(Number);
}

function isRfc1918(ip: string): boolean {
  const [a, b] = octets(ip);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export interface RankedIpv4 {
  address: string;
  /** A physical adapter's address outside the CGNAT range: worth offering to another LAN PC. */
  preferred: boolean;
  /** A tailnet address (100.64/10 on a Tailscale adapter): reachable from this PC's other tailnet PCs. */
  tailnet: boolean;
}

/**
 * External IPv4s, best candidate for another LAN PC first: physical adapters
 * before virtual ones (Hyper-V, WSL, Docker, VPN tunnels…) and before the
 * CGNAT/Tailscale range, then RFC1918 private addresses before others.
 * Link-local (169.254/16) is left out. Tailnet addresses are flagged so an
 * invite can offer them after the LAN ones.
 */
export function rankedExternalIpv4s(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): RankedIpv4[] {
  const found: Array<RankedIpv4 & { priv: boolean; order: number }> = [];
  const seen = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal || nic.address.startsWith('169.254.') || seen.has(nic.address)) continue;
      seen.add(nic.address);
      const cgnat = isTailnetIpv4(nic.address);
      const preferred = !VIRTUAL_NIC_RE.test(name) && !cgnat;
      const tailnet = cgnat && TAILSCALE_NIC_RE.test(name);
      found.push({ address: nic.address, preferred, tailnet, priv: isRfc1918(nic.address), order: found.length });
    }
  }
  found.sort((x, y) => Number(y.preferred) - Number(x.preferred) || Number(y.priv) - Number(x.priv) || x.order - y.order);
  return found.map(({ address, preferred, tailnet }) => ({ address, preferred, tailnet }));
}

/**
 * The addresses an invite offers, best first: the preferred (LAN) ones, then
 * this PC's tailnet addresses, so the pairing also works between PCs on one
 * tailnet. Other virtual adapters' addresses (Docker, WSL, Hyper-V…) would
 * only cost the other PC a timeout and are left out — unless nothing is
 * preferred, in which case they follow the tailnet ones so a PC whose
 * adapters all look virtual can still be reached.
 */
export function inviteIpv4s(ranked: RankedIpv4[] = rankedExternalIpv4s()): string[] {
  const preferred = ranked.filter((r) => r.preferred);
  const tailnet = ranked.filter((r) => r.tailnet);
  const rest = preferred.length > 0 ? [] : ranked.filter((r) => !r.tailnet);
  return [...preferred, ...tailnet, ...rest].map((r) => r.address);
}

/**
 * An invite's `alt`: the offered IPv4s other than `host`, at most
 * `INVITE_ALT_MAX`. When LAN addresses would fill every slot, the last one
 * goes to a tailnet address instead, so a PC with many adapters is still
 * reachable over the tailnet.
 */
export function inviteAlt(ips: readonly string[], host: string, tailnet: ReadonlySet<string>): string[] {
  const isTailnet = (ip: string): boolean => tailnet.has(ip);
  const rest = ips.filter((ip) => ip !== host);
  const alt = rest.slice(0, INVITE_ALT_MAX);
  const reserve = rest.find(isTailnet);
  if (reserve && !isTailnet(host) && !alt.some(isTailnet)) alt[alt.length - 1] = reserve;
  return alt;
}

export class A2aServer {
  private readonly deps: A2aServerDeps;
  private readonly hostname: () => string;
  private readonly ipv4s: () => string[];
  private readonly tailnetIpv4s: () => string[];
  private readonly now: () => number;
  private readonly loadIdentity: (opts: HostIdentityOptions) => HostIdentity;
  private readonly log: A2aServerLog;
  private readonly pairing: PairingSlot;
  private readonly onChanged = (): void => this.scheduleReconcile();
  private readonly pairFailures = new Map<string, { count: number; blockedUntil: number }>();
  private server: https.Server | null = null;
  private port: number | null = null;
  /** The slice the live listener was bound for (what a failed rebind restores). */
  private boundSlice: A2aRemoteConfig | null = null;
  private identity: HostIdentity | null = null;
  private lastError: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(deps: A2aServerDeps) {
    this.deps = deps;
    this.hostname = deps.hostname ?? ((): string => os.hostname());
    this.ipv4s = deps.ipv4s ?? ((): string[] => inviteIpv4s());
    this.tailnetIpv4s =
      deps.tailnetIpv4s ??
      (deps.ipv4s ? (): string[] => [] : (): string[] => rankedExternalIpv4s().filter((r) => r.tailnet).map((r) => r.address));
    this.now = deps.now ?? Date.now;
    this.loadIdentity = deps.loadIdentity ?? loadOrCreateHostIdentity;
    this.pairing = new PairingSlot({ now: this.now });
    this.log = deps.log ?? ((level, msg): void => void console[level === 'info' ? 'log' : level](msg));
    deps.controller.on(A2A_REMOTE_CONFIG_CHANGED, this.onChanged);
    // `changed` does not fire at boot: an enabled listener starts here.
    if (deps.controller.current().enabled) this.scheduleReconcile();
  }

  /** Resolves once every queued start/stop/rebind has run. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  /**
   * This PC's identity, loading (and on a fresh data directory creating) it
   * on first use. The joiner needs the hostId even while the listener is off.
   */
  ensureIdentity(): HostIdentity {
    if (!this.identity) this.identity = this.readIdentity();
    return this.identity;
  }

  /** The port actually bound, or null when not listening. */
  boundPort(): number | null {
    return this.port;
  }

  name(): string {
    return this.hostname().trim() || 'wmux';
  }

  status(): A2aRemoteStatus {
    const cfg = this.deps.controller;
    return {
      enabled: cfg.current().enabled,
      port: cfg.effectivePort(),
      listening: this.server !== null,
      hostId: this.identity?.hostId ?? null,
      name: this.name(),
      fingerprint256: this.identity?.fingerprint256 ?? null,
      lastError: this.lastError,
    };
  }

  /**
   * Open (or replace) the one-shot invite. Throws while the listener is down.
   * The invite names this PC (its machine name when usable) plus up to
   * `INVITE_ALT_MAX` fallback IPv4s, best first.
   */
  beginPairing(): A2aRemotePairBeginResult {
    if (!this.server || this.port === null || !this.identity) {
      throw new Error('a2a.remote.pair.begin: the A2A listener is not running');
    }
    const ips = this.ipv4s();
    const host = inviteHost(this.hostname(), ips);
    if (!host) throw new Error('a2a.remote.pair.begin: this PC has no usable name or IPv4 address');
    const tailnet = new Set(this.tailnetIpv4s());
    const alt = inviteAlt(ips, host, tailnet);
    const opened = this.pairing.begin({ host, port: this.port, fingerprint256: this.identity.fingerprint256, alt });
    const addresses = [host, ...alt];
    return { ...opened, addresses, tailnet: addresses.filter((a) => tailnet.has(a)) };
  }

  cancelPairing(): void {
    this.pairing.cancel();
  }

  /**
   * The invite slot plus the per-address lockout: while some address is
   * locked out, even the right code from it is refused, so the UI must say
   * so rather than show the attempts left as if they were usable.
   */
  pairingStatus(): A2aRemotePairStatus {
    const now = this.now();
    let lockedUntil: number | null = null;
    for (const f of this.pairFailures.values()) {
      if (f.blockedUntil > now && (lockedUntil === null || f.blockedUntil > lockedUntil)) lockedUntil = f.blockedUntil;
    }
    return { ...this.pairing.status(), lockedUntil };
  }

  dispose(): void {
    this.disposed = true;
    // Nothing may restart the listener after this.
    this.deps.controller.off(A2A_REMOTE_CONFIG_CHANGED, this.onChanged);
    this.pairing.cancel();
    this.scheduleReconcile();
  }

  // --- lifecycle --------------------------------------------------------------

  private scheduleReconcile(): void {
    this.chain = this.chain
      .then(() => this.reconcile())
      .catch((err: unknown) => this.log('error', `[a2a-remote] reconcile failed: ${errMsg(err)}`));
  }

  private readIdentity(): HostIdentity {
    return this.loadIdentity({ dir: this.deps.identityDir, hostname: this.name(), ipAddresses: this.ipv4s() });
  }

  private async reconcile(): Promise<void> {
    const cfg = this.deps.controller.current();
    if (this.disposed || !cfg.enabled) {
      // An invite names the listener it was minted for.
      this.pairing.cancel();
      await this.closeCurrent();
      this.lastError = null;
      return;
    }
    const port = this.deps.controller.effectivePort();
    if (this.server && this.boundSlice && (this.boundSlice.port ?? null) === (cfg.port ?? null)) return;

    let identity: HostIdentity;
    try {
      // Every (re)bind re-reads the identity so the served certificate is the
      // active generation (renewed when close to expiry).
      identity = this.readIdentity();
    } catch (err) {
      this.lastError = `identity: ${errMsg(err)}`;
      this.log('error', `[a2a-remote] cannot load the host identity: ${errMsg(err)}`);
      this.keepPrevious();
      return;
    }

    // Bind the new listener BEFORE closing the old one: a port that cannot be
    // bound must not cost the PC the listener it already had.
    const bound = await this.bind(identity, port);
    if ('error' in bound) {
      this.lastError = bound.error;
      this.keepPrevious();
      return;
    }
    if (this.identity && identity.fingerprint256 !== this.identity.fingerprint256) {
      this.log('warn', '[a2a-remote] certificate re-issued: paired PCs must be invited again');
    }
    const old = this.server;
    this.pairing.cancel();
    this.identity = identity;
    this.server = bound.server;
    this.port = (bound.server.address() as net.AddressInfo).port;
    this.boundSlice = { ...cfg };
    this.lastError = null;
    if (old) await closeServer(old);
    this.log('info', `[a2a-remote] listening on ${this.deps.bindHost ?? '0.0.0.0'}:${this.port}`);
  }

  /** A failed (re)bind: an old listener keeps serving, and its slice is put back on disk. */
  private keepPrevious(): void {
    if (!this.server || !this.boundSlice) return;
    try {
      this.deps.controller.restore(this.boundSlice);
    } catch (err) {
      this.log('error', `[a2a-remote] could not restore the previous listener settings: ${errMsg(err)}`);
    }
  }

  private async bind(identity: HostIdentity, port: number): Promise<{ server: https.Server } | { error: string }> {
    let server: https.Server;
    try {
      server = https.createServer(
        {
          cert: fs.readFileSync(identity.certPath),
          key: fs.readFileSync(identity.keyPath),
          minVersion: 'TLSv1.2',
          handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        },
        (req, res) => {
          this.handle(req, res).catch((err: unknown) => {
            this.log('warn', `[a2a-remote] request failed: ${errMsg(err)}`);
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'unavailable' });
            else res.destroy();
          });
        },
      );
    } catch (err) {
      this.log('error', `[a2a-remote] cannot build the TLS listener: ${errMsg(err)}`);
      return { error: `tls: ${errMsg(err)}` };
    }
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.maxConnections = MAX_CONNECTIONS;

    const bindHost = this.deps.bindHost ?? '0.0.0.0';
    const listenError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => resolve(err);
      server.once('error', onError);
      server.listen(port, bindHost, () => {
        server.off('error', onError);
        resolve(null);
      });
    });
    if (listenError) {
      // Never listened, so there is nothing to close (close() would throw
      // ERR_SERVER_NOT_RUNNING). No retry loop: the operator changes the port.
      this.log('warn', `[a2a-remote] cannot listen on ${bindHost}:${port}: ${errMsg(listenError)}`);
      return { error: listenError.code ?? errMsg(listenError) };
    }
    server.on('error', (err) => this.log('warn', `[a2a-remote] listener error: ${errMsg(err)}`));
    return { server };
  }

  private async closeCurrent(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.boundSlice = null;
    if (server) await closeServer(server);
  }

  // --- requests ---------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const refuse = (status: number, error: A2aRemoteErrorCode, extra?: Record<string, unknown>): void =>
      sendJson(res, status, { ok: false, error, ...extra });

    // Before anything else, on every path: a browser sent this (see the class note).
    if (req.headers['origin'] !== undefined) return refuse(403, 'forbidden');

    const url = new URL(req.url ?? '/', 'https://a2a.invalid');
    const p = url.pathname;
    if (!isA2aRoute(p)) return refuse(404, 'bad-request', { message: 'not found' });

    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > A2A_REQUEST_BODY_MAX) return refuseTooLarge(req, res);

    // The one route that takes no credential: it is how a joiner gets one.
    if (p === A2A_ROUTES.pair) {
      if (req.method !== 'POST') return refuse(405, 'bad-request');
      return this.handlePair(req, res);
    }

    const peer = await this.authenticate(req, url, refuse);
    if (!peer) return;

    if (p === A2A_ROUTES.hello) {
      if (req.method !== 'GET') return refuse(405, 'bad-request');
      const identity = this.identity;
      if (!identity) return refuse(503, 'unavailable');
      const hello: A2aHelloResponse = { protocol: A2A_REMOTE_PROTOCOL, hostId: identity.hostId, name: this.name() };
      return sendJson(res, 200, hello);
    }

    if (p === A2A_ROUTES.unpair) {
      if (req.method !== 'POST') return refuse(405, 'bad-request');
      // The joiner withdraws its own pairing; it can only ever name itself.
      try {
        this.deps.peers.revoke(peer.peerId);
      } catch (err) {
        // PeerStore keeps a revocation in memory even when the write failed.
        this.log('error', `[a2a-remote] unpair of ${peer.peerId} could not be persisted: ${errMsg(err)}`);
      }
      this.cascade(peer.hostId);
      this.log('info', `[a2a-remote] host ${peer.hostId} withdrew its pairing`);
      return sendJson(res, 200, { ok: true });
    }

    const routes = this.deps.routes;
    if (!routes) return refuse(503, 'unavailable');
    await routes.handle(req, res, url, p, peer);
  }

  private cascade(hostId: string): void {
    try {
      this.deps.onPeerRevoked?.(hostId);
    } catch (err) {
      this.log('error', `[a2a-remote] revoke cascade for ${hostId} failed: ${errMsg(err)}`);
    }
  }

  /**
   * Peer authentication, the same judgement as the phone web server's peer
   * gate: a malformed peer credential or none at all is a failed peer login
   * (401); any other credential shape (a device credential, a `?token=` or a
   * stream ticket) is a principal never allowed here (403).
   */
  private async authenticate(
    req: http.IncomingMessage,
    url: URL,
    refuse: (status: number, error: A2aRemoteErrorCode, extra?: Record<string, unknown>) => void,
  ): Promise<WebA2aPeer | null> {
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const cred = parsePeerCredential(bearer);
    if (!cred) {
      const otherCredential =
        (bearer !== null && !looksLikePeerCredential(bearer) && bearer.includes('.')) ||
        url.searchParams.has('token') ||
        url.searchParams.has('ticket');
      refuse(otherCredential ? 403 : 401, otherCredential ? 'forbidden' : 'unauthorized');
      return null;
    }
    let result: PeerAuthResult;
    try {
      result = await this.deps.peers.resolve(cred.peerId, cred.secret);
    } catch (err) {
      this.log('warn', `[a2a-remote] peer auth failed: ${errMsg(err)}`);
      refuse(401, 'unauthorized', { reason: 'unknown' });
      return null;
    }
    if (!result.ok) {
      refuse(401, 'unauthorized', { reason: result.reason });
      return null;
    }
    try {
      this.deps.peers.touch(result.peerId);
    } catch (err) {
      this.log('warn', `[a2a-remote] peer touch failed: ${errMsg(err)}`);
    }
    return { peerId: result.peerId, hostId: result.hostId, name: result.name };
  }

  /**
   * `POST /api/a2a/pair` — redeem the open invite for a PEER credential.
   * Issues nothing else: this listener holds no operator token and no device
   * store.
   *
   * The code is judged BEFORE anything about the joiner's hostId, so nothing
   * about which hosts are paired leaks to a request without the code. A valid
   * code is the operator's approval: if that host already holds a live peer
   * (a pairing whose answer never reached it, or a PC re-pairing after losing
   * its record), the old peer is revoked — with its cascade — and a new one
   * is minted, so a half-finished pairing never locks the host out.
   *
   * Accepted for the owner-only PoC: the joiner REPORTS its hostId, so an
   * invite holder could claim another host's id. The colleague tier binds the
   * joiner's certificate fingerprint to its hostId instead.
   */
  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const refusePair = (status: number, error: A2aRemoteErrorCode, reason?: A2aPairRefusal): void =>
      sendJson(res, status, { ok: false, error, ...(reason ? { reason } : {}) });

    const body = await readJsonBody(req, A2A_REMOTE_BODY_MAX);
    if (body === 'too-large') return refuseTooLarge(req, res);
    if (!isRecord(body)) return refusePair(400, 'bad-request');
    const { code, hostId, name, protocol } = body;
    if (typeof code !== 'string' || !isHostId(hostId) || typeof name !== 'string' || typeof protocol !== 'number') {
      return refusePair(400, 'bad-request');
    }
    if (protocol !== A2A_REMOTE_PROTOCOL) return refusePair(400, 'protocol');

    const source = req.socket.remoteAddress ?? '';
    const retryAfterMs = this.pairRetryAfterMs(source);
    if (retryAfterMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return sendJson(res, 429, { ok: false, error: 'forbidden', reason: 'rate-limited', retryAfterMs });
    }

    const identity = this.identity;
    if (!identity) return refusePair(503, 'unavailable');
    const check = this.pairing.check(code);
    if (!check.ok) {
      this.notePairFailure(source);
      return refusePair(403, 'forbidden', check.reason);
    }
    if (hostId === identity.hostId) return refusePair(400, 'bad-request', 'self');
    // Consume BEFORE any await: a second request with the same code must not mint again.
    this.pairing.consume();
    this.pairFailures.delete(source);

    for (const stale of this.deps.peers.listByHost(hostId).filter((r) => r.revokedAt === undefined)) {
      try {
        this.deps.peers.revoke(stale.peerId);
      } catch (err) {
        // Revoked in memory regardless (PeerStore rule); the mint below still runs.
        this.log('error', `[a2a-remote] re-pair: revoking ${stale.peerId} could not be persisted: ${errMsg(err)}`);
      }
      this.cascade(hostId);
      this.log('info', `[a2a-remote] host ${hostId} re-paired; its previous pairing was revoked`);
    }

    let minted: { peerId: string; secret: string };
    try {
      minted = await this.deps.peers.mint({ hostId, name });
    } catch (err) {
      this.log('warn', `[a2a-remote] pairing could not mint a peer credential: ${errMsg(err)}`);
      // Only a concurrent pairing for the same host winning the race lands here as a conflict.
      if (this.deps.peers.listByHost(hostId).some((r) => r.revokedAt === undefined)) return refusePair(409, 'conflict');
      return refusePair(500, 'unavailable');
    }
    this.log('info', `[a2a-remote] paired with host ${hostId}`);
    const response: A2aPairResponse = {
      credential: formatPeerCredential(minted),
      hostId: identity.hostId,
      name: this.name(),
      protocol: A2A_REMOTE_PROTOCOL,
    };
    sendJson(res, 200, response);
  }

  /** How long `source` is still locked out of pairing; 0 when it is not. */
  private pairRetryAfterMs(source: string): number {
    const f = this.pairFailures.get(source);
    return f === undefined ? 0 : Math.max(0, f.blockedUntil - this.now());
  }

  private notePairFailure(source: string): void {
    const f = this.pairFailures.get(source) ?? { count: 0, blockedUntil: 0 };
    f.count += 1;
    if (f.count >= PAIR_FREE_FAILURES) {
      f.blockedUntil = this.now() + Math.min(PAIR_BACKOFF_BASE_MS * 2 ** (f.count - PAIR_FREE_FAILURES), PAIR_BACKOFF_MAX_MS);
    }
    this.pairFailures.delete(source);
    this.pairFailures.set(source, f);
    // Bounded: forget the longest-quiet address first.
    if (this.pairFailures.size > PAIR_BACKOFF_TRACKED_MAX) {
      const oldest = this.pairFailures.keys().next();
      if (!oldest.done) this.pairFailures.delete(oldest.value);
    }
  }
}

function closeServer(server: https.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Read a JSON body of at most `max` bytes. Non-JSON is `undefined`; over the
 * cap is `'too-large'` — reading stops there and the caller answers 413 and
 * drops the connection (`refuseTooLarge`) instead of draining the rest.
 */
export function readJsonBody(req: http.IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) {
        req.off('data', onData);
        req.pause();
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (size > max) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', (err) => {
      if (size <= max) reject(err);
    });
  });
}

/** 413, then cut the connection once the answer is written — never drain an oversized body. */
function refuseTooLarge(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader('Connection', 'close');
  res.once('finish', () => req.socket.destroy());
  sendJson(res, 413, { ok: false, error: 'too-large' satisfies A2aRemoteErrorCode });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
