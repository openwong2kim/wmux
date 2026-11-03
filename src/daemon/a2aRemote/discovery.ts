import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  A2A_DISCOVER_NAME_MAX,
  A2A_REMOTE_PROTOCOL,
  A2A_ROUTES,
  isHostId,
  isTailnetIpv4,
  normalizeFingerprint256,
  type A2aDiscoverPoll,
  type A2aDiscoverProbe,
  type A2aDiscoverRefusal,
  type A2aDiscoverRequestCreated,
  type A2aRemoteErrorCode,
} from '../../shared/a2aRemote';
import { getExecEnv } from '../../shared/execEnv';
import type {
  A2aDiscoverDecideResult,
  A2aDiscoverDevice,
  A2aDiscoverEndReason,
  A2aDiscoverLastOutcome,
  A2aDiscoverOpenResult,
  A2aDiscoverStatus,
  A2aRemoteStatus,
} from '../../shared/rpc';
import { judgeWhois, type TailnetStatus } from '../../cli/tailscale';
import { A2A_REMOTE_CONFIG_CHANGED, type A2aRemoteController } from './controller';
import { commitMatches, decodeSecret, discoverCode, randomSecret } from './discoverCode';
import { mintPairCode } from './pairing';
import { tailnetRangeOnLan, type TailnetCli } from './tailnet';

/**
 * The receiving side of tailnet discovery: a window, in memory only, during
 * which this PC answers the `A2A_ROUTES.discover` routes, opened by the app
 * ("make this PC discoverable") for at most 5 minutes.
 *
 * It rides the A2A listener; there is no second socket. A request reaches it
 * only when `accepts()` says so: the window is open, the connection arrived
 * on one of this PC's tailnet IPv4s, and it came from a tailnet IPv4 that the
 * last `tailscale status` lists as one of this user's untagged nodes.
 * Anything else falls through to the listener's usual unauthenticated answer,
 * byte for byte, so outside a window nothing about discovery is visible.
 *
 * A request is identified by Tailscale (`whois`), never by what the requester
 * says, and pairs only after this PC's human allows a card whose 6-digit code
 * (`discoverCode`) matches the requester's screen. Allow mints a one-shot
 * pairing code that `/api/a2a/pair` redeems (`redeem`) for the requester's
 * source and HostId only.
 *
 * Trust boundary on this PC: the `a2a.remote.discover.*` RPCs are
 * `wmux.internal`, which keeps MCP and plugin callers out; like `pair.begin`,
 * any same-user process holding the daemon auth token can call them.
 *
 * A window that had to turn A2A on turns it off again when it ends without a
 * pairing, unless something else changed the A2A settings meanwhile or a PC
 * paired through an invite. A marker file covers a daemon that stops first.
 */

export const DISCOVER_WINDOW_MS = 5 * 60_000;
/** How long a request waits for its reveal before it is dropped (no card yet). */
export const DISCOVER_COMMIT_MS = 10_000;
/** How long the card waits for Allow or Deny. */
export const DISCOVER_DECIDE_MS = 120_000;
/** How long the requester has to redeem the pairing code once allowed. */
export const DISCOVER_GRANT_MS = 60_000;
export const DISCOVER_SNAPSHOT_REFRESH_MS = 30_000;
/** At most one status re-read per this long when a source is not in the snapshot. */
export const DISCOVER_MISS_REFRESH_MS = 5_000;
export const DISCOVER_PROBES_PER_MINUTE = 30;
/** Requests one source may make in one window, refused ones included. */
export const DISCOVER_REQUESTS_PER_SOURCE = 3;
/** Identified requests one window takes; the next one closes it. */
export const DISCOVER_REQUESTS_PER_WINDOW = 10;
/** Written when a window turns A2A on; removed when it is turned off again or the flag clears. */
export const DISCOVERY_MARKER_FILE = 'a2a-discovery-turned-on.json';

const STATUS_TIMEOUT_MS = 5_000;
const ROUTE_TIMEOUT_MS = 2_000;
const PROBE_WINDOW_MS = 60_000;
/** Ended requests kept answerable to their requester's poll while the window lives. */
const ENDED_KEPT = 16;

const REQUESTS_PATH = `${A2A_ROUTES.discover}/requests`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True iff `pathname` is the discovery probe or under it. */
export function isDiscoverRoute(pathname: string): boolean {
  return pathname === A2A_ROUTES.discover || pathname.startsWith(`${A2A_ROUTES.discover}/`);
}

// --- the tailnet source gate (pure) --------------------------------------------

/** What `accepts()` reads: taken from `tailscale status` when the window opens, refreshed while it is open. */
export interface DiscoverySnapshot {
  /** This PC's tailnet IPv4s. */
  selfIps: ReadonlySet<string>;
  /** IPv4s of this user's untagged, not shared-in nodes; this PC's own removed. */
  peerIps: ReadonlySet<string>;
  selfStableId: string;
  selfUserId: number | null;
}

export function snapshotFromStatus(status: TailnetStatus): DiscoverySnapshot {
  const selfIps = new Set(status.self.ipv4s);
  const peerIps = new Set<string>();
  for (const peer of status.peers) {
    if (status.self.userId === null || peer.userId !== status.self.userId || peer.tags.length > 0 || peer.sharee) continue;
    for (const ip of peer.ipv4s) if (!selfIps.has(ip)) peerIps.add(ip);
  }
  return { selfIps, peerIps, selfStableId: status.self.stableId, selfUserId: status.self.userId };
}

/** An IPv4-mapped IPv6 address as its IPv4. */
export function plainIpv4(address: string): string {
  return address.toLowerCase().startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * Where a connection stands with the snapshot. `accept`: it arrived on this
 * PC's tailnet address from a listed node. `unknown`: the same, but the
 * source is a tailnet address the snapshot does not list (a node that just
 * joined; worth one re-read). `refuse`: anything else, including a LAN
 * address, a connection to a LAN address, and this PC itself.
 */
export function judgeTailnetSource(snap: DiscoverySnapshot, localAddress: string, remoteAddress: string): 'accept' | 'unknown' | 'refuse' {
  const local = plainIpv4(localAddress);
  const remote = plainIpv4(remoteAddress);
  if (!snap.selfIps.has(local)) return 'refuse';
  if (!isTailnetIpv4(remote) || snap.selfIps.has(remote)) return 'refuse';
  return snap.peerIps.has(remote) ? 'accept' : 'unknown';
}

// --- macOS: which interface a source routes through ----------------------------

/** The interface `route -n get <ip>` names, or null. macOS only. */
export function routeInterface(ip: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/sbin/route',
      ['-n', 'get', ip],
      { timeout: ROUTE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024, env: getExecEnv(), signal },
      (err, stdout) => resolve(err ? null : parseRouteInterface(String(stdout))),
    );
  });
}

export function parseRouteInterface(stdout: string): string | null {
  const m = /^\s*interface:\s*(\S+)\s*$/m.exec(stdout);
  return m ? m[1] : null;
}

/** The name of the interface holding one of `ips`, or null. */
export function interfaceHolding(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, ips: ReadonlySet<string>): string | null {
  for (const [name, list] of Object.entries(ifaces)) {
    if ((list ?? []).some((nic) => nic.family === 'IPv4' && ips.has(nic.address))) return name;
  }
  return null;
}

// --- the turned-on marker ------------------------------------------------------

/**
 * At boot: a marker left by a window that turned A2A on and never turned it
 * off again (the daemon stopped first) turns A2A off before the listener
 * starts, then goes. When the setting cannot be written, the marker stays for
 * the next boot.
 */
export function revertDiscoveryTurnOn(controller: A2aRemoteController, dataDir: string, log: (level: 'info' | 'warn' | 'error', msg: string) => void): void {
  const marker = path.join(dataDir, DISCOVERY_MARKER_FILE);
  if (!fs.existsSync(marker)) return;
  try {
    controller.configure({ enabled: false });
  } catch (err) {
    log('error', `[a2a-remote] could not turn A2A off after an unfinished discovery window: ${errMsg(err)}`);
    return;
  }
  removeFile(marker, log);
  log('info', '[a2a-remote] turned A2A off again: a discovery window had turned it on and never finished');
}

function removeFile(file: string, log: (level: 'info' | 'warn' | 'error', msg: string) => void): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `[a2a-remote] could not remove ${file}: ${errMsg(err)}`);
  }
}

// --- the window ----------------------------------------------------------------

export interface DiscoveryListener {
  whenIdle(): Promise<void>;
  status(): A2aRemoteStatus;
  /** This PC's identity while the listener runs. */
  identity(): { hostId: string; fingerprint256: string } | null;
  name(): string;
}

export interface DiscoveryDeps {
  tailnet: TailnetCli;
  controller: A2aRemoteController;
  /** Where the turned-on marker lives. */
  dataDir: string;
  listener: DiscoveryListener;
  /** The name of the live pairing `hostId` holds here, or null. */
  livePeerName: (hostId: string) => string | null;
  /** This build's wmux version, for the probe. */
  version: () => string;
  now?: () => number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seams. */
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  platform?: NodeJS.Platform;
  routeInterface?: (ip: string, signal: AbortSignal) => Promise<string | null>;
}

type RequestState = 'committed' | 'deciding' | 'allowed' | 'redeemed' | 'denied' | 'expired' | 'withdrawn' | 'failed' | 'closed';

interface DiscoverRequest {
  requestId: string;
  token: Buffer;
  source: string;
  hostId: string;
  fingerprint256: string;
  commit: string;
  nonceS: string;
  device: A2aDiscoverDevice;
  state: RequestState;
  /** The current state's deadline. */
  expiresAt: number;
  /** The 6 digits, once revealed. */
  code: string | null;
  /** The one-shot pairing code, once allowed. */
  grant: string | null;
}

interface SourceState {
  probeWindowStart: number;
  probes: number;
  requests: number;
  blocked: boolean;
}

interface OpenWindow {
  expiresAt: number;
  ownerClientId: string | null;
  snapshot: DiscoverySnapshot;
  sources: Map<string, SourceState>;
  /** The request holding the single slot (a reservation is `pending`). */
  active: DiscoverRequest | null;
  pending: boolean;
  ended: Map<string, DiscoverRequest>;
  identified: number;
  lastRefreshAt: number;
  refreshing: boolean;
}

/** An answer to a discovery route. */
export interface DiscoverAnswer {
  status: number;
  body: unknown;
  retryAfterMs?: number;
}

export interface DiscoverRouteInput {
  method: string;
  path: string;
  /** The source tailnet IPv4 (as `accepts` judged it). */
  source: string;
  token: string | undefined;
  /** Reads the JSON body: the value, undefined when not JSON, or 'too-large'. */
  readBody: () => Promise<unknown>;
}

export type RedeemResult = 'none' | 'mismatch' | 'ok';

export class DiscoveryWindow {
  private readonly deps: DiscoveryDeps;
  private readonly now: () => number;
  private readonly markerPath: string;
  private win: OpenWindow | null = null;
  private opening: Promise<A2aDiscoverOpenResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** This window turned A2A on (cleared by any other settings change or an invite pairing). */
  private turnedOn = false;
  /** Set around this window's own `configure`, whose `changed` must not clear `turnedOn`. */
  private configuring = false;
  private lastOutcome: A2aDiscoverLastOutcome | null = null;
  private ended: A2aDiscoverStatus['ended'] = null;
  private readonly onConfigChanged = (): void => {
    if (!this.configuring) this.clearTurnedOn();
  };

  constructor(deps: DiscoveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.markerPath = path.join(deps.dataDir, DISCOVERY_MARKER_FILE);
    deps.controller.on(A2A_REMOTE_CONFIG_CHANGED, this.onConfigChanged);
  }

  isOpen(): boolean {
    this.sweep();
    return this.win !== null;
  }

  // --- RPC side ----------------------------------------------------------------

  /** Open the window (or answer the one already open). */
  open(opts: { turnOn: boolean }, clientId: string | null = null): Promise<A2aDiscoverOpenResult> {
    if (this.isOpen()) return Promise.resolve({ ok: true, status: this.status() });
    this.opening ??= this.doOpen(opts, clientId).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(opts: { turnOn: boolean }, clientId: string | null): Promise<A2aDiscoverOpenResult> {
    const read = await this.deps.tailnet.status(AbortSignal.timeout(STATUS_TIMEOUT_MS));
    if (!read.ok) return { ok: false, reason: 'tailscale-not-ready', check: read.check };
    const snapshot = snapshotFromStatus(read.status);
    const [selfIp] = [...snapshot.selfIps];
    if (!selfIp) return { ok: false, reason: 'no-tailnet-ipv4' };
    if (tailnetRangeOnLan(this.interfaces(), [...snapshot.selfIps])) return { ok: false, reason: 'tailnet-range-on-lan' };
    // `whois --json` must work here, or no request could ever be identified.
    if (!(await this.deps.tailnet.whois(selfIp))) return { ok: false, reason: 'tailscale-whois-unsupported' };

    if (!this.deps.controller.current().enabled) {
      if (!opts.turnOn) return { ok: false, reason: 'a2a-off' };
      // The marker goes first: a daemon that stops right after the switch still turns it off again at boot.
      try {
        fs.mkdirSync(this.deps.dataDir, { recursive: true });
        fs.writeFileSync(this.markerPath, JSON.stringify({ v: 1, at: new Date(this.now()).toISOString() }));
        this.ownConfigure({ enabled: true });
      } catch (err) {
        removeFile(this.markerPath, this.deps.log);
        return { ok: false, reason: 'listen-failed', listen: this.listenFacts(errMsg(err)) };
      }
      this.turnedOn = true;
    }
    await this.deps.listener.whenIdle();
    const listening = this.deps.listener.status().listening && this.deps.listener.identity() !== null;
    if (!listening) {
      const listen = this.listenFacts();
      this.revertTurnOn();
      return { ok: false, reason: 'listen-failed', listen };
    }
    // A concurrent close or settings change may have run while this awaited.
    if (this.win) return { ok: true, status: this.status() };

    const now = this.now();
    this.lastOutcome = null;
    this.ended = null;
    this.win = {
      expiresAt: now + DISCOVER_WINDOW_MS,
      ownerClientId: clientId,
      snapshot,
      sources: new Map(),
      active: null,
      pending: false,
      ended: new Map(),
      identified: 0,
      lastRefreshAt: now,
      refreshing: false,
    };
    this.refreshTimer = setInterval(() => this.refresh(), DISCOVER_SNAPSHOT_REFRESH_MS);
    this.refreshTimer.unref?.();
    this.schedule();
    this.deps.log('info', `[a2a-remote] discoverable on the tailnet for ${DISCOVER_WINDOW_MS / 60_000} minutes${this.turnedOn ? ' (A2A turned on for it)' : ''}`);
    return { ok: true, status: this.status() };
  }

  status(): A2aDiscoverStatus {
    this.sweep();
    const win = this.win;
    const active = win?.active ?? null;
    const shown = active && (active.state === 'deciding' || active.state === 'allowed') ? active : null;
    const replaces = shown ? this.deps.livePeerName(shown.hostId) : null;
    return {
      open: win !== null,
      expiresAt: win?.expiresAt ?? null,
      name: this.deps.listener.name(),
      turnedOn: win !== null && this.turnedOn,
      incoming: shown
        ? {
            requestId: shown.requestId,
            state: shown.state === 'allowed' ? 'allowed' : 'deciding',
            device: { ...shown.device },
            code: shown.code ?? '',
            expiresAt: shown.expiresAt,
            ...(replaces !== null ? { replaces } : {}),
          }
        : null,
      lastOutcome: this.lastOutcome ? { ...this.lastOutcome } : null,
      ended: this.ended ? { ...this.ended } : null,
    };
  }

  /** Allow or deny the request on the card. */
  decide(requestId: string, allow: boolean): A2aDiscoverDecideResult {
    this.sweep();
    const win = this.win;
    const req = win?.active;
    if (!win || !req || req.requestId !== requestId || req.state !== 'deciding') return { ok: false, status: this.status() };
    if (allow) {
      req.state = 'allowed';
      req.grant = mintPairCode();
      req.expiresAt = this.now() + DISCOVER_GRANT_MS;
      this.deps.log('info', `[a2a-remote] discovery request from ${req.device.name} (${req.source}) allowed`);
    } else {
      sourceOf(win, req.source).blocked = true;
      this.endRequest(req, 'denied');
      this.lastOutcome = { outcome: 'denied', device: { ...req.device }, ip: req.source, at: this.now() };
    }
    this.schedule();
    return { ok: true, status: this.status() };
  }

  /** Stop (or any other end). Ending a window that turned A2A on without a pairing turns A2A off again. */
  close(reason: A2aDiscoverEndReason = 'stopped', peer?: { hostId: string; name: string }): void {
    const win = this.win;
    if (!win) return;
    this.win = null;
    this.clearTimers();
    if (win.active) win.active.grant = null;
    this.ended = { reason, at: this.now(), ...(peer ? { peer } : {}) };
    if (reason === 'paired') this.clearTurnedOn();
    else this.revertTurnOn();
    this.deps.log('info', `[a2a-remote] discovery window ended: ${reason}`);
  }

  /** The app connection that opened the window went away. */
  clientGone(clientId: string): void {
    if (this.win && this.win.ownerClientId === clientId) this.close('disconnected');
  }

  /** The listener stopped or rebound. */
  listenerStopped(): void {
    this.close('listener-stopped');
  }

  dispose(): void {
    this.close('listener-stopped');
    this.deps.controller.off(A2A_REMOTE_CONFIG_CHANGED, this.onConfigChanged);
  }

  // --- listener side -------------------------------------------------------------

  /**
   * Whether a discovery route gets an answer from the window. Synchronous and
   * reads only the cached snapshot; a source that is a tailnet address the
   * snapshot does not list schedules a background re-read (at most one per
   * `DISCOVER_MISS_REFRESH_MS`) and is refused this time.
   */
  accepts(localAddress: string, remoteAddress: string, method: string | undefined, pathname: string): boolean {
    const win = this.win;
    if (!win || this.now() >= win.expiresAt) return false;
    const verdict = judgeTailnetSource(win.snapshot, localAddress, remoteAddress);
    if (verdict === 'unknown') this.refreshSoon();
    if (verdict !== 'accept') return false;
    // Once a request is allowed the window takes no new probe or request.
    const granted = win.active?.state === 'allowed' || win.active?.state === 'redeemed';
    if (granted && (pathname === A2A_ROUTES.discover || (pathname === REQUESTS_PATH && method === 'POST'))) return false;
    return true;
  }

  /** Answer a route `accepts` let in. Null: the window closed meanwhile; answer as outside it. */
  async route(input: DiscoverRouteInput): Promise<DiscoverAnswer | 'too-large' | null> {
    // A poll after a deadline must see it passed, even before the timer fires.
    this.sweep();
    if (!this.win) return null;
    const { method, path: p } = input;
    if (p === A2A_ROUTES.discover) return method === 'GET' ? this.probe(input.source) : badMethod();
    if (p === REQUESTS_PATH) return method === 'POST' ? this.create(input) : badMethod();
    const m = /^\/api\/a2a\/discover\/requests\/([^/]+)(\/reveal|\/withdraw)?$/.exec(p);
    if (!m || !UUID_RE.test(m[1])) return notFound();
    const id = m[1];
    if (m[2] === '/reveal') return method === 'POST' ? this.reveal(id, input) : badMethod();
    if (m[2] === '/withdraw') return method === 'POST' ? this.withdraw(id, input) : badMethod();
    return method === 'GET' ? this.poll(id, input) : badMethod();
  }

  /**
   * `/api/a2a/pair` asks whether `code` is the allowed request's pairing code.
   * `none`: it is not (no grant, or another code); nothing is spent, since
   * that route is open to the whole LAN. `mismatch`: it is, but from another
   * source or for another HostId; the grant is burned. `ok`: consumed here,
   * synchronously; the caller mints, then reports `notePaired` or
   * `noteMintFailed`.
   */
  redeem(code: string, source: string, hostId: string): RedeemResult {
    this.sweep();
    const req = this.win?.active;
    if (!req || req.state !== 'allowed' || !req.grant) return 'none';
    if (!sameCode(code.trim().toUpperCase(), req.grant)) return 'none';
    if (plainIpv4(source) !== req.source || hostId !== req.hostId) {
      this.deps.log('warn', `[a2a-remote] a discovery pairing code was presented from ${source}, not the allowed ${req.source}; it is void`);
      req.grant = null;
      req.state = 'failed';
      this.close('failed');
      return 'mismatch';
    }
    req.grant = null;
    req.state = 'redeemed';
    return 'ok';
  }

  notePaired(peer: { hostId: string; name: string }): void {
    this.close('paired', peer);
  }

  noteMintFailed(): void {
    const req = this.win?.active;
    if (req && req.state === 'redeemed') req.state = 'failed';
    this.close('failed');
  }

  /** A PC paired through an invite: whatever turned A2A on, it is in use now. */
  noteInvitePaired(): void {
    this.clearTurnedOn();
  }

  // --- routes ------------------------------------------------------------------

  private probe(source: string): DiscoverAnswer | null {
    const win = this.win;
    if (!win) return null;
    const now = this.now();
    const s = sourceOf(win, plainIpv4(source));
    if (now - s.probeWindowStart >= PROBE_WINDOW_MS) {
      s.probeWindowStart = now;
      s.probes = 0;
    }
    s.probes += 1;
    if (s.probes > DISCOVER_PROBES_PER_MINUTE) return refusal(429, 'rate-limited', s.probeWindowStart + PROBE_WINDOW_MS - now);
    const probe: A2aDiscoverProbe = { discover: 1, protocol: A2A_REMOTE_PROTOCOL, name: this.deps.listener.name(), version: this.deps.version() };
    return { status: 200, body: probe };
  }

  private async create(input: DiscoverRouteInput): Promise<DiscoverAnswer | 'too-large' | null> {
    const win = this.win;
    if (!win) return null;
    const source = plainIpv4(input.source);
    const now = this.now();
    const s = sourceOf(win, source);
    if (s.requests >= DISCOVER_REQUESTS_PER_SOURCE) return refusal(429, 'rate-limited', win.expiresAt - now);
    if (s.blocked) return refusal(403, 'denied');
    if (win.pending || win.active) return refusal(429, 'busy', win.active ? Math.max(0, win.active.expiresAt - now) : DISCOVER_COMMIT_MS);
    // From here the slot is this request's until it is refused or ends, and it counts.
    win.pending = true;
    s.requests += 1;
    try {
      return await this.identifyAndCommit(win, source, input);
    } finally {
      win.pending = false;
    }
  }

  private async identifyAndCommit(win: OpenWindow, source: string, input: DiscoverRouteInput): Promise<DiscoverAnswer | 'too-large' | null> {
    const body = await input.readBody();
    if (body === 'too-large') return 'too-large';
    if (!isRecord(body)) return badRequest();
    const { protocol, hostId, name, fingerprint256, commit } = body;
    if (typeof protocol !== 'number') return badRequest();
    if (protocol !== A2A_REMOTE_PROTOCOL) return { status: 400, body: { ok: false, error: 'protocol' satisfies A2aRemoteErrorCode } };
    const fr = normalizeFingerprint256(fingerprint256);
    if (!isHostId(hostId) || typeof name !== 'string' || name.length > A2A_DISCOVER_NAME_MAX || !fr || !decodeSecret(commit)) {
      return badRequest();
    }
    const identity = this.deps.listener.identity();
    if (!identity) return null;
    if (hostId === identity.hostId) return this.refuse(source, 'self');

    // whois, and on macOS the route, one request at a time (the slot is held).
    const whois = await this.deps.tailnet.whois(source);
    if (this.win !== win) return null;
    if (!whois) return this.refuse(source, 'unidentified');
    if (!(await this.routesThroughTailnet(win, source))) return this.win === win ? this.refuse(source, 'unidentified') : null;
    if (this.win !== win) return null;
    const verdict = judgeWhois(whois, { stableId: win.snapshot.selfStableId, userId: win.snapshot.selfUserId });
    if (!verdict.ok) return this.refuse(source, verdict.reason === 'self' ? 'self' : verdict.reason === 'other-user' ? 'other-user' : 'unidentified');

    win.identified += 1;
    if (win.identified > DISCOVER_REQUESTS_PER_WINDOW) {
      this.close('too-many-requests');
      return null;
    }
    const req: DiscoverRequest = {
      requestId: crypto.randomUUID(),
      token: Buffer.from(randomSecret(), 'base64url'),
      source,
      hostId,
      fingerprint256: fr,
      commit: commit as string,
      nonceS: randomSecret(),
      device: { name: whois.deviceName, dnsName: whois.nodeName, login: whois.loginName, os: whois.os, ip: source },
      state: 'committed',
      expiresAt: this.now() + DISCOVER_COMMIT_MS,
      code: null,
      grant: null,
    };
    win.active = req;
    this.schedule();
    const created: A2aDiscoverRequestCreated = {
      requestId: req.requestId,
      token: req.token.toString('base64url'),
      nonce: req.nonceS,
      expiresAt: req.expiresAt,
    };
    return { status: 201, body: created };
  }

  private async reveal(id: string, input: DiscoverRouteInput): Promise<DiscoverAnswer | 'too-large' | null> {
    const req = this.find(id, input);
    if (!req) return notFound();
    const body = await input.readBody();
    if (body === 'too-large') return 'too-large';
    if (this.win?.active !== req) return this.win ? conflict() : null;
    if (req.state !== 'committed') return conflict();
    const nonceR = isRecord(body) ? body['nonce'] : undefined;
    if (typeof nonceR !== 'string' || !decodeSecret(nonceR)) return badRequest();
    if (!commitMatches(req.commit, nonceR)) {
      this.endRequest(req, 'closed');
      this.schedule();
      return refusal(403, 'commit-mismatch');
    }
    const identity = this.deps.listener.identity();
    if (!identity) return null;
    req.code = discoverCode({ nonceS: req.nonceS, nonceR, fingerprintS: identity.fingerprint256, fingerprintR: req.fingerprint256, hostIdR: req.hostId });
    req.state = 'deciding';
    req.expiresAt = this.now() + DISCOVER_DECIDE_MS;
    this.schedule();
    return { status: 200, body: { expiresAt: req.expiresAt } };
  }

  private poll(id: string, input: DiscoverRouteInput): DiscoverAnswer {
    const req = this.find(id, input);
    if (!req) return notFound();
    return { status: 200, body: pollOf(req) };
  }

  private withdraw(id: string, input: DiscoverRouteInput): DiscoverAnswer {
    const req = this.find(id, input);
    if (!req) return notFound();
    if (this.win?.active === req) {
      const wasAllowed = req.state === 'allowed' || req.state === 'redeemed';
      const reachedCard = req.state !== 'committed';
      this.endRequest(req, 'withdrawn');
      if (reachedCard) this.lastOutcome = { outcome: 'withdrawn', device: { ...req.device }, ip: req.source, at: this.now() };
      // A pairing code that went out is void now, and the window takes nothing new after an Allow.
      if (wasAllowed) this.close('failed');
      else this.schedule();
    }
    return { status: 200, body: { ok: true } };
  }

  // --- helpers ------------------------------------------------------------------

  /** The live or recently ended request `id`, when the caller is its requester (same source, same token). */
  private find(id: string, input: DiscoverRouteInput): DiscoverRequest | null {
    const win = this.win;
    if (!win) return null;
    const req = win.active?.requestId === id ? win.active : win.ended.get(id);
    if (!req || req.source !== plainIpv4(input.source)) return null;
    const token = decodeSecret(input.token);
    return token && crypto.timingSafeEqual(token, req.token) ? req : null;
  }

  private refuse(source: string, reason: 'unidentified' | 'other-user' | 'self'): DiscoverAnswer {
    this.lastOutcome = { outcome: 'refused', reason, ip: source, at: this.now() };
    this.deps.log('info', `[a2a-remote] discovery request from ${source} refused: ${reason}`);
    return refusal(403, reason);
  }

  /** macOS: the source must route through the interface that holds this PC's tailnet address. */
  private async routesThroughTailnet(win: OpenWindow, source: string): Promise<boolean> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') return true;
    const tailnetIf = interfaceHolding(this.interfaces(), win.snapshot.selfIps);
    if (!tailnetIf) return false;
    const via = await (this.deps.routeInterface ?? routeInterface)(source, AbortSignal.timeout(ROUTE_TIMEOUT_MS)).catch(() => null);
    return via === tailnetIf;
  }

  private endRequest(req: DiscoverRequest, state: RequestState): void {
    const win = this.win;
    req.state = state;
    req.grant = null;
    if (!win) return;
    if (win.active === req) win.active = null;
    win.ended.set(req.requestId, req);
    if (win.ended.size > ENDED_KEPT) {
      const oldest = win.ended.keys().next();
      if (!oldest.done) win.ended.delete(oldest.value);
    }
  }

  /** Apply every deadline that has passed. */
  private sweep(): void {
    const win = this.win;
    if (!win) return;
    const now = this.now();
    const req = win.active;
    if (req && now >= req.expiresAt) {
      if (req.state === 'allowed') {
        this.close('grant-expired');
        return;
      }
      if (req.state === 'committed' || req.state === 'deciding') {
        const reachedCard = req.state === 'deciding';
        this.endRequest(req, 'expired');
        if (reachedCard) this.lastOutcome = { outcome: 'expired', device: { ...req.device }, ip: req.source, at: now };
      }
    }
    if (now >= win.expiresAt) this.close('timeout');
  }

  /** One timer, for the nearest deadline, so a window ends on time with nobody asking. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const win = this.win;
    if (!win) return;
    const next = Math.min(win.expiresAt, win.active?.expiresAt ?? Infinity);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sweep();
      this.schedule();
    }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.timer = null;
    this.refreshTimer = null;
  }

  private refreshSoon(): void {
    const win = this.win;
    if (!win || win.refreshing || this.now() - win.lastRefreshAt < DISCOVER_MISS_REFRESH_MS) return;
    this.refresh();
  }

  /** Re-read the status in the background. A failed read keeps the last snapshot. */
  private refresh(): void {
    const win = this.win;
    if (!win || win.refreshing) return;
    win.refreshing = true;
    win.lastRefreshAt = this.now();
    this.deps.tailnet
      .status(AbortSignal.timeout(STATUS_TIMEOUT_MS))
      .then((read) => {
        if (read.ok && this.win === win) win.snapshot = snapshotFromStatus(read.status);
      })
      .catch((err: unknown) => this.deps.log('warn', `[a2a-remote] discovery could not re-read tailscale status: ${errMsg(err)}`))
      .finally(() => {
        win.refreshing = false;
      });
  }

  private interfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
    return (this.deps.interfaces ?? os.networkInterfaces)();
  }

  private listenFacts(error?: string): NonNullable<Extract<A2aDiscoverOpenResult, { ok: false }>['listen']> {
    const st = this.deps.listener.status();
    return {
      port: st.port,
      lastError: error ?? st.lastError,
      lastErrorCode: st.lastErrorCode ?? null,
      lastErrorPort: st.lastErrorPort ?? null,
    };
  }

  private ownConfigure(patch: { enabled: boolean }): void {
    this.configuring = true;
    try {
      this.deps.controller.configure(patch);
    } finally {
      this.configuring = false;
    }
  }

  /** Turn A2A off again when this window turned it on and nothing else claimed it since. */
  private revertTurnOn(): void {
    if (!this.turnedOn) return;
    this.turnedOn = false;
    try {
      this.ownConfigure({ enabled: false });
    } catch (err) {
      // The marker stays: the next boot turns it off.
      this.deps.log('error', `[a2a-remote] could not turn A2A off after the discovery window: ${errMsg(err)}`);
      return;
    }
    removeFile(this.markerPath, this.deps.log);
  }

  private clearTurnedOn(): void {
    if (!this.turnedOn && !fs.existsSync(this.markerPath)) return;
    this.turnedOn = false;
    removeFile(this.markerPath, this.deps.log);
  }
}

function sourceOf(win: OpenWindow, ip: string): SourceState {
  let s = win.sources.get(ip);
  if (!s) {
    s = { probeWindowStart: 0, probes: 0, requests: 0, blocked: false };
    win.sources.set(ip, s);
  }
  return s;
}

function pollOf(req: DiscoverRequest): A2aDiscoverPoll {
  switch (req.state) {
    case 'committed':
    case 'deciding':
      return { state: 'waiting', expiresAt: req.expiresAt };
    case 'allowed':
      return { state: 'allowed', expiresAt: req.expiresAt, ...(req.grant ? { code: req.grant } : {}) };
    case 'denied':
      return { state: 'denied', expiresAt: req.expiresAt };
    case 'expired':
      return { state: 'expired', expiresAt: req.expiresAt };
    case 'withdrawn':
      return { state: 'closed', expiresAt: req.expiresAt, reason: 'withdrawn' };
    case 'failed':
      return { state: 'closed', expiresAt: req.expiresAt, reason: 'failed' };
    default:
      return { state: 'closed', expiresAt: req.expiresAt };
  }
}

function refusal(status: number, reason: A2aDiscoverRefusal, retryAfterMs?: number): DiscoverAnswer {
  const error: A2aRemoteErrorCode = 'forbidden';
  const after = retryAfterMs === undefined ? undefined : Math.max(0, Math.ceil(retryAfterMs));
  return {
    status,
    body: { ok: false, error, reason, ...(after !== undefined ? { retryAfterMs: after } : {}) },
    ...(after !== undefined ? { retryAfterMs: after } : {}),
  };
}

function badRequest(): DiscoverAnswer {
  return { status: 400, body: { ok: false, error: 'bad-request' satisfies A2aRemoteErrorCode } };
}

function badMethod(): DiscoverAnswer {
  return { status: 405, body: { ok: false, error: 'bad-request' satisfies A2aRemoteErrorCode } };
}

function notFound(): DiscoverAnswer {
  return { status: 404, body: { ok: false, error: 'bad-request' satisfies A2aRemoteErrorCode, message: 'not found' } };
}

function conflict(): DiscoverAnswer {
  return { status: 409, body: { ok: false, error: 'conflict' satisfies A2aRemoteErrorCode } };
}

/** Constant-time equality of two pairing codes; a length mismatch compares against itself. */
function sameCode(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
