import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonSessionManager } from '../DaemonSessionManager';
// Types only — the registry implementation, its persistence and its
// headless-terminal dependency chain stay out of this module. The web server is
// a CONSUMER: it lists, it resolves, it republishes lifecycle events. It never
// constructs a request, and it never decides what bytes a decision means.
import type { ApprovalEvent, ApprovalRegistryApi, ApprovalRequest } from '../approvals/types';
import { ENV_KEYS } from '../../shared/constants';
import { capSnapshot } from './snapshotWindow';
import { startSseHeartbeat } from './sseHeartbeat';
import { buildWebCsp } from './webCsp';

/**
 * wmux web — a read-only-by-default browser terminal served BY THE DAEMON.
 *
 * Why here and not a ttyd wrapper: the daemon already owns the PTY bytes, a
 * per-session ring buffer, and a NON-exclusive output fan-out
 * (`DaemonPTYBridge` is an EventEmitter). ttyd would spawn its own shell and
 * could never surface the existing fleet. We tee the bridge, which — unlike the
 * GUI's single-client `SessionPipe` — accepts as many listeners as we attach,
 * so a phone browser and the desktop GUI can watch the same pane at once.
 *
 * Transport is SSE (output) + POST (input), not raw WebSocket: no new
 * dependency (Node `http` only), native browser auto-reconnect, and a clean
 * one-way fit for the read-only default.
 *
 * Security posture:
 *   - Nothing listens until `daemon.web.start` is invoked (default unchanged).
 *   - TWO credential forms, both checked timing-safe on every `/api/*` call:
 *     the OPERATOR token (minted per start, carried across restarts by #596,
 *     used by the CLI/GUI and the advertised URLs) and a per-DEVICE credential
 *     (`<deviceId>.<secret>`, minted by pairing, individually revocable). The
 *     daemon master token never touches the network in either case.
 *   - Only the operator token may ride in `?token=`. A device secret is durable
 *     and never expires, so it is header-only on every route including SSE. A
 *     browser device opens a stream with `?ticket=` instead: a two-minute,
 *     device-bound capability from `POST /api/stream-ticket` (B3).
 *   - FREE-FORM input is impossible unless the server was started with
 *     `allowInput` (execute-impossible stays the default — the operator opts in
 *     explicitly). The ONE carve-out is `POST /api/approvals/:id`, which works
 *     on a read-only server; see that handler for why a scoped approval is a
 *     strictly narrower grant than `--allow-input`.
 *
 * Route table (everything under `/api/` is Bearer-gated unless noted):
 *   GET  /                     app shell (unauthenticated, no secrets)
 *   GET  /api/pair?code=       the ONLY unauthenticated API route; mints this
 *                              device's own credential (refused over plaintext
 *                              off-machine transports — see mintRefusal)
 *   GET  /api/config           allowInput flag
 *   GET  /api/sessions         pane list
 *   POST /api/stream-ticket    device → short-lived `?ticket=` capability
 *   GET  /api/stream?session=  SSE pane bytes (`?token=`/`?ticket=` — EventSource)
 *   GET  /api/events           attention + approval channel; SSE (`?token=`
 *                              allowed) or JSON backlog (Bearer only)
 *   POST /api/input?session=   free-form bytes — 403 unless `--allow-input`
 *   GET  /api/approvals        pending + recently resolved approval requests
 *   POST /api/approvals/:id    resolve one — ALLOWED on a read-only server
 */

export interface WebTerminalStartOptions {
  port: number;
  host: string;
  allowInput: boolean;
  /**
   * Extra hostnames to accept in the `Host` header, beyond loopback and the
   * bound addresses. Needed when a reverse proxy in front of the loopback bind
   * forwards the browser's Host verbatim — `tailscale serve` forwards the
   * MagicDNS name, which the default allowlist would 403.
   */
  allowedHosts?: string[];
  /**
   * Reuse this bearer token instead of minting a fresh one (#596).
   *
   * Set ONLY by the daemon's own restore/start path, from the 0600
   * `web-state.json` it wrote itself — never from `daemon.web.start` RPC
   * params, so no pipe client can choose the token a browser will be handed.
   * Absent (the default, and every unit test) → a fresh `randomUUID`.
   */
  token?: string;
}

export interface WebTerminalInfo {
  running: boolean;
  port?: number;
  host?: string;
  allowInput?: boolean;
  token?: string;
  /** Reachable URLs with the token embedded (`http://<ip>:<port>/?token=…`). */
  urls?: string[];
  /** Live SSE client count. */
  clients?: number;
  /** Short single-use pairing code — typed on the phone instead of the token. */
  pairCode?: string;
  /** Epoch ms when the current pairing code expires. */
  pairExpiresAt?: number;
  /**
   * Whether per-device credentials are armed, i.e. whether a device store was
   * wired in.
   *
   * False means pairing still works but hands out the SHARED token exactly as
   * 3.34.0 shipped it — not a downgrade from that release, but not the upgrade
   * either, and critically there is nothing to revoke one device at a time. An
   * operator who believes revocation is available when it is not would keep a
   * lost phone's access alive while thinking they had cut it, so this is
   * surfaced rather than left to a daemon log nobody reads.
   */
  deviceCredentials?: boolean;
}

/**
 * The answer to "does this `<deviceId>.<secret>` belong to a live device?".
 *
 * The two failure reasons are NOT interchangeable and must not be collapsed:
 * `revoked` is the operator's own decision and the phone should say so ("this
 * device was removed — ask for a new pairing code"), while `unknown` is a
 * credential this daemon has never seen (a wiped roster, a different machine,
 * a typo). #599 shipped a 401 screen that could only guess; this is what lets
 * it stop guessing.
 */
export type DeviceAuthResult =
  | { ok: true; deviceId: string; name?: string }
  | { ok: false; reason: 'unknown' | 'revoked' };

/**
 * Per-device credentials as far as the HTTP surface is concerned (M3).
 *
 * STRUCTURAL ON PURPOSE. The implementation (`DeviceStore`) owns the KDF and
 * its parameters, the per-device salt, the roster file, the derived-key cache
 * and the audit log — none of which this module may know about, for the same
 * reason it does not know how the approval registry picks keystrokes. What the
 * web server needs is exactly two verbs: turn a presented credential into an
 * identity, and mint one for a device the operator just named.
 *
 * `resolve` MUST NOT throw: an unreadable roster is an auth failure, never a
 * 500 on a route that would otherwise have answered. It may be async because a
 * password KDF has to be — a synchronous scrypt on the request path would stall
 * the daemon's whole event loop once per call.
 *
 * NO EXPIRY. A device credential lives until it is revoked; there is no TTL and
 * no refresh (contract §7). Revocation is the whole mechanism, which is why it
 * has to be immediate — see `disconnectDevice`.
 */
export interface WebDeviceResolver {
  resolve(deviceId: string, secret: string): Promise<DeviceAuthResult> | DeviceAuthResult;
  mint(params: { name?: string }): Promise<{ deviceId: string; deviceSecret: string }>;
  /**
   * Record a successful auth. Optional because it is bookkeeping, not
   * authorization: a store that does not track `lastSeenAt` is still a valid
   * resolver, and a roster row with a stale timestamp is a cosmetic loss.
   * Called on every authenticated device request — the store decides how often
   * that is worth writing down.
   */
  touch?(deviceId: string): void;
}

/**
 * WHO is making this request. Tagged onto every SSE client so a revoke can find
 * that device's live streams and end them, instead of leaving a torn-down
 * device watching panes until it happens to reconnect.
 */
export type WebPrincipal =
  | { kind: 'operator' }
  | { kind: 'device'; deviceId: string; name?: string };

/** Authenticated identity, or why the credential was refused. */
type AuthOutcome = { ok: true; principal: WebPrincipal } | { ok: false; reason: 'unknown' | 'revoked' };

/**
 * What `daemon.web.pairStart` answers. A discriminated union rather than
 * `{ok, code?, error?}` so a caller cannot read `code` off a refusal — but
 * still structurally assignable to that looser shape if the RPC layer declares
 * one. `error` is operator-facing copy: it says what to do, not just "no".
 */
export type WebPairStartResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; error: string };

interface WebTerminalServerDeps {
  sessionManager: DaemonSessionManager;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Per-device credential store (M3). Optional, like `approvals`: a daemon that
   * could not build one still serves every route on the operator token, and
   * `/api/pair` degrades to the pre-M3 shared-token response with a warning
   * rather than leaving the operator unable to pair anything at all.
   */
  devices?: WebDeviceResolver;
  /**
   * The daemon's approval registry. Optional: a daemon that has not wired one
   * (or a unit test that does not care) still serves every other route, and the
   * approval routes answer 503 rather than pretending the surface exists.
   */
  approvals?: ApprovalRegistryApi;
  /**
   * Directory holding the built frontend assets (terminal.html, manifest,
   * sw.js, icons). Resolved by the caller relative to the daemon bundle so it
   * works in both dev (`dist/daemon-web`) and packaged
   * (`resources/daemon-web`) layouts.
   */
  assetsDir: string;
  /**
   * Clock seam. Only the attention log's TTL eviction reads it; injected so the
   * unit tests can age entries deterministically instead of sleeping half an
   * hour. Defaults to the wall clock.
   */
  now?: () => number;
}

/** Cap a single input POST body so a hostile client cannot exhaust memory. */
const MAX_INPUT_BYTES = 64 * 1024;
/** Pairing code lifetime — long enough to walk to the phone, short enough to matter. */
const PAIR_TTL_MS = 10 * 60 * 1000;
/** Wrong-code attempts before the pairing code is burned. */
const PAIR_MAX_ATTEMPTS = 5;
/**
 * Minimum gap between automatic pairing-code regenerations. Without a cooldown,
 * an attacker who can burn codes could force a regeneration loop; with one, a
 * burned code costs the legitimate operator a short wait instead of a restart.
 */
const PAIR_REGEN_COOLDOWN_MS = 30_000;
/** Pairing alphabet: A-Z2-9 minus the visually ambiguous 0/O/1/I. */
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LEN = 6;
/**
 * How many attention events the replay window holds. A phone that dropped
 * connection for a coffee break must get everything it missed; a phone that was
 * off overnight gets the most recent window and a `reset` marker rather than an
 * unbounded backlog the daemon paid RAM for all night.
 */
const ATTENTION_CAP = 100;
/** Attention entries older than this are dropped even if the cap allows them. */
const ATTENTION_TTL_MS = 30 * 60 * 1000;
/** A decision body is two fields; anything larger is not one of ours. */
const MAX_JSON_BODY_BYTES = 8 * 1024;
/**
 * Who the registry records as having answered, for anything resolved over HTTP.
 *
 * This used to be the constant `'web'`, on the reasoning that "the web token is
 * one shared secret held by whoever paired a device, so claiming a user
 * identity here would be a fabrication". That was true when every phone
 * presented the operator's token — and M3 made it false. A device now
 * authenticates as ITSELF, with a credential only it holds and that the
 * operator can revoke on its own, so the id is a fact we have rather than a
 * claim we would be inventing.
 *
 * Keeping the constant meant the one action in this whole surface that writes
 * bytes into somebody's terminal was also the one place the authenticated
 * identity was thrown away: `approvals.json`, the daemon log line, and the 409
 * body all said `web` no matter which phone pressed the key. The roster could
 * not answer "who approved that?" afterwards.
 *
 * The device NAME rides along with the id because the roster is not a permanent
 * record — a revoked device's tombstone is eventually pruned, and the audit
 * trail has to keep making sense after that.
 */
function describePrincipal(principal: WebPrincipal): string {
  if (principal.kind === 'operator') return 'operator';
  return principal.name
    ? `device ${principal.name} (${principal.deviceId})`
    : `device ${principal.deviceId}`;
}
/**
 * Separator inside a device credential (`<deviceId>.<secret>`). A dot because
 * the operator token is a `randomUUID` and contains none, so the two forms are
 * distinguishable without ever having to guess which one was presented.
 */
const DEVICE_CREDENTIAL_SEP = '.';
/**
 * Stream-ticket lifetime (B3).
 *
 * Long enough to open a stream and to survive the browser's own retry, short
 * enough that a ticket recovered from a proxy log or a Referer is worthless by
 * the time anyone reads it. Deliberately NOT the credential's lifetime: the
 * credential never expires, the ticket almost immediately does.
 */
const STREAM_TICKET_TTL_MS = 120_000;
/** 256 bits of CSPRNG — the reason a plain Map lookup is safe (see resolveStreamTicket). */
const STREAM_TICKET_BYTES = 32;
/**
 * Outstanding tickets held across all devices. Expired entries are pruned
 * first; the cap only bounds memory if an authenticated device asks for
 * tickets in a loop, which no client of ours does.
 */
const MAX_STREAM_TICKETS = 512;

interface SseClient {
  res: http.ServerResponse;
  sessionId: string;
  detach: () => void;
  /** Whose stream this is, so a revoke can end exactly that device's. */
  principal: WebPrincipal;
}

/**
 * A short-lived capability to OPEN a stream, and nothing else (B3).
 *
 * It exists because `EventSource` cannot set headers, and a device credential
 * is durable — putting one in a query string would write a permanent secret
 * into history, proxy logs and Referer headers. A ticket is the narrow thing a
 * URL can safely carry: it grants opening a stream, it expires in two minutes,
 * it is bound to one device, and revoking that device destroys it.
 */
interface StreamTicket {
  deviceId: string;
  name?: string;
  expiresAt: number;
}

/** A live `/api/events` subscriber (fleet-wide attention only, no pane bytes). */
interface EventClient {
  res: http.ServerResponse;
  detach: () => void;
  principal: WebPrincipal;
}

/**
 * What a recorded event IS, and the SSE event name it goes out under.
 *
 * `approval` joins the two attention kinds rather than opening a channel of its
 * own: it is the same question ("this pane needs a human") reaching the same
 * clients, and it must inherit the id/replay machinery — an approval raised
 * while the phone was in a tunnel is exactly the event that must survive the
 * reconnect.
 */
type EventKind = 'critical' | 'notify' | 'approval';

/**
 * One recorded attention event. `payload` is the flattened wire object
 * (`{sessionId, ...event}`) exactly as it goes out live, so a replay and a live
 * delivery are byte-identical apart from framing.
 */
interface AttentionEntry {
  id: number;
  at: number;
  kind: EventKind;
  payload: Record<string, unknown>;
}

/** A resume position: which server generation, and how far into it. */
interface AttentionCursor {
  epoch: string;
  id: number;
}

export class WebTerminalServer {
  private server: http.Server | null = null;
  private token = '';
  private opts: WebTerminalStartOptions | null = null;
  private readonly clients = new Set<SseClient>();
  /** Live `/api/events` subscribers — fleet attention, no pane stream attached. */
  private readonly eventClients = new Set<EventClient>();

  /**
   * Attention replay state.
   *
   * The epoch is minted ONCE per instance, in the constructor: a new daemon
   * process gets a new epoch, which is exactly the boundary at which a client's
   * stored cursor stops meaning anything (ids restart at 1). The OS boot id is
   * deliberately NOT used — two daemon restarts inside one boot would share it
   * and a client would silently replay against the wrong id space.
   *
   * The log survives `stop()`/`start()`: restarting the WEB server is not an
   * event-loss boundary, the daemon kept running and kept recording.
   */
  private readonly attentionEpoch = crypto.randomUUID();
  private attentionSeq = 0;
  private attentionLog: AttentionEntry[] = [];

  // Pairing state (single active code per running server).
  private pairCode = '';
  private pairExpiresAt = 0;
  private pairAttempts = 0;
  /**
   * Hostnames this server answers to. A local HTTP server that accepts any
   * `Host` can be reached by a malicious page that rebinds its own domain to
   * this address (DNS rebinding); the token still gates `/api/*`, but the
   * unauthenticated `/api/pair` route would be reachable and its code burnable.
   */
  private allowedHosts = new Set<string>();
  /** When the current pairing code was minted (throttles regeneration). */
  private pairRegeneratedAt = 0;
  /**
   * The name the operator gave the device they are pairing RIGHT NOW (§3:
   * naming happens before the code is minted, because a roster of UUIDs cannot
   * be operated). Survives an automatic code regeneration — a burned code does
   * not change who the operator was trying to pair — and is cleared the moment
   * a code is successfully redeemed, so the next device cannot inherit it.
   */
  private pendingDeviceName: string | undefined;
  /**
   * Outstanding stream tickets, keyed by the ticket itself (B3).
   *
   * In memory only and cleared on stop(): a ticket is a capability to open a
   * stream against THIS running server, so there is nothing to carry across a
   * restart — the client asks for another one, which costs it one request.
   */
  private readonly streamTickets = new Map<string, StreamTicket>();

  // Bound so on()/off() reference the SAME listener across start()/stop().
  private readonly onSessionCritical = (payload: { sessionId: string; event?: unknown }): void =>
    this.broadcastEvent('critical', payload);
  private readonly onSessionNotification = (payload: { sessionId: string; event?: unknown }): void =>
    this.broadcastEvent('notify', payload);
  private readonly onApprovalEvent = (e: ApprovalEvent): void => this.publishApproval(e);
  /**
   * The registry hands back an unsubscribe closure rather than taking off() —
   * so unlike the sessionManager listeners this one is held, not re-derived.
   * Non-null exactly while the server is running.
   */
  private approvalUnsub: (() => void) | null = null;

  // Static assets, loaded once on start and cached in memory (all small).
  private terminalHtml: Buffer | null = null;
  /** Full CSP for the HTML page, with per-build inline-script hashes. */
  private manifest: Buffer | null = null;
  private serviceWorker: Buffer | null = null;
  private icon: Buffer | null = null;
  /**
   * The CSP for the assets currently loaded. Initialized to the asset-less
   * policy (`script-src 'none'`) so a request that somehow arrives before
   * `loadAssets()` is served the locked-down header, never a permissive one.
   */
  private csp: string = buildWebCsp(null);

  constructor(private readonly deps: WebTerminalServerDeps) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Start (or restart) the web server. A running server is stopped first so a
   * second `wmux web --allow-input` cleanly re-applies options.
   *
   * The web token is minted fresh unless the caller supplies one to reuse
   * (`options.token`, #596) — see the field doc for why that seam is
   * daemon-internal only. The pairing code always rotates: it is single-use
   * and short-lived by design, so carrying one across a restart would only
   * hand the phone an already-burned code.
   */
  async start(options: WebTerminalStartOptions): Promise<WebTerminalInfo> {
    if (this.server) {
      await this.stop();
    }
    this.loadAssets();
    this.token = options.token || crypto.randomUUID();
    this.opts = options;
    this.pendingDeviceName = undefined;
    this.generatePairCode();

    const server = http.createServer((req, res) => {
      // Never let a handler error escape into the daemon event loop.
      try {
        this.handle(req, res);
      } catch (err) {
        this.failRequest(res, err);
      }
    });

    // A malformed request or a client that drops mid-handshake must not crash
    // the daemon. Log and move on.
    server.on('clientError', (_err, socket) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
    server.on('error', (err) => {
      this.deps.log('error', `[web] server error: ${errMsg(err)}`);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(options.port, options.host);
    });

    this.server = server;

    // Tee fleet-wide attention signals into EVERY connected SSE client — a
    // viewer watching pane A must still hear that pane B needs an answer.
    // Attached only AFTER the listen succeeded (a failed bind must not leak
    // listeners stop() would never remove) and removed in stop() so restarts
    // rotate cleanly.
    this.deps.sessionManager.on('session:critical', this.onSessionCritical);
    this.deps.sessionManager.on('session:notification', this.onSessionNotification);
    // Approval lifecycle rides the same channel; same attach point, same
    // restart hygiene (unsubscribed in stop(), so a restart never doubles up).
    this.approvalUnsub = this.deps.approvals?.onEvent(this.onApprovalEvent) ?? null;

    // Record the ACTUAL bound port so status()/urls report it even when the
    // caller requested port 0 (ephemeral — used by the unit tests for a
    // hermetic bind that never collides).
    const addr = server.address();
    if (addr && typeof addr === 'object') this.opts.port = addr.port;

    // Host allowlist: loopback names always (the PWA's own origin), plus every
    // concrete address we actually serve on, so a phone hitting the LAN /
    // tailnet IP is accepted while a rebound attacker domain is not.
    this.allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    if (options.host === '0.0.0.0' || options.host === '::') {
      for (const ip of collectIpv4()) this.allowedHosts.add(ip);
    }
    this.allowedHosts.add(options.host);
    // An IPv6 bind arrives in the Host header bracketed (`[fd00::5]:7681`),
    // which is the form the guard normalizes to — allow both spellings.
    if (options.host.includes(':') && !options.host.startsWith('[')) {
      this.allowedHosts.add(`[${options.host}]`.toLowerCase());
    }
    // Operator-supplied extra hostnames (e.g. the machine's MagicDNS name when
    // `tailscale serve` fronts the loopback bind and forwards Host verbatim).
    for (const extra of options.allowedHosts ?? []) {
      const name = extra.trim().toLowerCase();
      if (name) this.allowedHosts.add(name);
    }

    this.deps.log(
      'info',
      `[web] listening on ${this.opts.host}:${this.opts.port} (input ${options.allowInput ? 'ENABLED' : 'read-only'})`,
    );
    return this.status();
  }

  /** Stop the server, end every SSE stream, and drop all bridge listeners. */
  async stop(): Promise<{ stopped: boolean }> {
    if (!this.server) return { stopped: false };

    this.deps.sessionManager.off('session:critical', this.onSessionCritical);
    this.deps.sessionManager.off('session:notification', this.onSessionNotification);
    this.approvalUnsub?.();
    this.approvalUnsub = null;
    this.pairCode = '';
    this.pairExpiresAt = 0;
    this.pairAttempts = 0;
    this.pendingDeviceName = undefined;
    // Capabilities against a server that is going away. Nothing to preserve.
    this.streamTickets.clear();

    for (const client of this.clients) {
      try {
        client.detach();
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();

    // The attention log and epoch deliberately survive: a client that reconnects
    // after a web-server restart still has a valid cursor into the same daemon.
    for (const client of this.eventClients) {
      try {
        client.detach();
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.eventClients.clear();

    const server = this.server;
    this.server = null;
    this.opts = null;
    this.token = '';

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // close() only fires once every keep-alive socket (SSE streams) drains;
      // force them shut. closeAllConnections is Node 18.2+; guard for older types.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    this.deps.log('info', '[web] stopped');
    return { stopped: true };
  }

  /**
   * Mint a fresh pairing code on operator request.
   *
   * The lazy regeneration in `handlePair` is deliberately rate-limited because
   * it is reachable by whoever can hit the port. This path is different: it is
   * an authenticated control-plane call from the GUI, i.e. the operator asking
   * in person, so it mints immediately. Without it, a consumed or expired code
   * left no way to pair a second device short of restarting the server.
   */
  refreshPairCode(): WebTerminalInfo {
    if (!this.server) return { running: false };
    this.generatePairCode();
    return this.status();
  }

  /**
   * `daemon.web.pairStart {name}` — name the device, THEN mint its code (§3).
   *
   * Separate from `refreshPairCode` rather than a parameter on it because the
   * two answer different questions. `refreshPairCode` is "the code went stale,
   * give me another for whatever I was already doing"; this is "I am about to
   * pair THIS device", which is the only moment a human is present to say what
   * to call it, and the only moment the transport is worth refusing over.
   *
   * The transport check is deliberately made here as well as at redemption:
   * failing at redemption alone means the operator reads a code off the GUI,
   * walks to the phone, types it, and only then learns the server would never
   * have minted anything.
   */
  startPairing(params: { name?: string } = {}): WebPairStartResult {
    if (!this.server) return { ok: false, error: 'the web server is not running — start it first' };
    const refusal = this.mintRefusal();
    if (refusal) return { ok: false, error: refusal };
    const label = typeof params.name === 'string' ? params.name.trim() : '';
    this.generatePairCode();
    this.pendingDeviceName = label || undefined;
    return { ok: true, code: this.pairCode, expiresAt: this.pairExpiresAt };
  }

  /**
   * End every live SSE stream held by one device, right now.
   *
   * This is the teardown half of revocation (§5), and it is a METHOD rather
   * than a listener on the store so the ordering is visible at the call site:
   * `daemon.web.deviceRevoke` persists first, checks the write succeeded, and
   * only then calls this. A device the operator believes is gone must not be
   * watching panes until its next reconnect, and a stream that outlives the
   * roster entry is exactly that.
   *
   * Returns how many connections were closed, so the RPC can report it. The
   * operator's own streams and every other device's are untouched.
   */
  disconnectDevice(deviceId: string): number {
    if (!deviceId) return 0;
    const isTarget = (p: WebPrincipal): boolean => p.kind === 'device' && p.deviceId === deviceId;
    // Outstanding tickets die with the device (B3). Closing the streams alone
    // would leave a revoked phone holding a capability that reopens one for up
    // to the ticket TTL — a revocation with a two-minute hole in it.
    for (const [ticket, held] of [...this.streamTickets]) {
      if (held.deviceId === deviceId) this.streamTickets.delete(ticket);
    }
    let closed = 0;
    for (const client of [...this.clients]) {
      if (!isTarget(client.principal)) continue;
      this.clients.delete(client);
      closed += 1;
      try {
        client.detach();
        client.res.end();
      } catch {
        /* socket already gone — the end state we wanted either way */
      }
    }
    for (const client of [...this.eventClients]) {
      if (!isTarget(client.principal)) continue;
      this.eventClients.delete(client);
      closed += 1;
      try {
        client.detach();
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    if (closed > 0) {
      this.deps.log('info', `[web] revoked device ${deviceId}: closed ${closed} live stream(s)`);
    }
    return closed;
  }

  /**
   * `POST /api/stream-ticket` — trade a device credential (header, as always)
   * for a short-lived capability that MAY ride a query string.
   *
   * Devices only. The operator token already opens a stream with `?token=`, and
   * handing the operator a second way in would grow this into a parallel auth
   * system for no gain — the ticket exists solely because `EventSource` cannot
   * set headers, and the native app (URLSession sets headers on a streaming
   * request freely) will never need one either.
   */
  private issueStreamTicket(principal: WebPrincipal): { ticket: string; expiresAt: number } | null {
    if (principal.kind !== 'device') return null;
    this.pruneStreamTickets();
    const ticket = crypto.randomBytes(STREAM_TICKET_BYTES).toString('base64url');
    const expiresAt = Date.now() + STREAM_TICKET_TTL_MS;
    this.streamTickets.set(ticket, {
      deviceId: principal.deviceId,
      ...(principal.name ? { name: principal.name } : {}),
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  /**
   * Turn a presented ticket back into the device that asked for it, or `null`.
   *
   * A plain Map lookup, deliberately: the ticket is 256 bits of CSPRNG with a
   * two-minute life, so the only thing a timing difference could reveal is
   * whether a key the caller already chose exists — and finding one by guessing
   * is 2^256 work inside a 120-second window. There is no stored secret to
   * compare against here, which is the whole difference between a capability
   * and a credential.
   *
   * NOT single-use. `EventSource` retries the SAME url on its own, so burning
   * the ticket on first use would turn every ordinary reconnect into a
   * permanent failure with no way for the page to notice or recover.
   */
  private resolveStreamTicket(raw: string | null): WebPrincipal | null {
    if (!raw) return null;
    const held = this.streamTickets.get(raw);
    if (!held) return null;
    if (Date.now() > held.expiresAt) {
      this.streamTickets.delete(raw);
      return null;
    }
    return { kind: 'device', deviceId: held.deviceId, ...(held.name ? { name: held.name } : {}) };
  }

  /** Drop expired tickets, then the oldest if the cap is still exceeded. */
  private pruneStreamTickets(): void {
    const now = Date.now();
    for (const [ticket, held] of [...this.streamTickets]) {
      if (now > held.expiresAt) this.streamTickets.delete(ticket);
    }
    if (this.streamTickets.size < MAX_STREAM_TICKETS) return;
    const byAge = [...this.streamTickets].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const excess = this.streamTickets.size - MAX_STREAM_TICKETS + 1;
    for (let i = 0; i < excess && i < byAge.length; i++) this.streamTickets.delete(byAge[i][0]);
  }

  /**
   * Why a durable device secret must not be minted over this transport, or
   * `null` when it may be.
   *
   * The shared operator token was survivable in cleartext partly because it
   * died on restart; #599 made it durable and M3 makes the per-device one
   * durable too, so `--expose` without a TLS front now means handing a
   * long-lived secret to anything on the LAN. Loopback is fine (nothing
   * off-machine reaches it). A host the operator listed with `--allow-host` is
   * fine, because that flag exists precisely to name the TLS front (`tailscale
   * serve`) that forwards to us.
   *
   * `requestHost` is the Host of the redeeming request when there is one; with
   * none (the operator-side pairStart) the question is only whether a front is
   * configured at all.
   *
   * NOTE this refuses minting for a browser sitting at `127.0.0.1` on an
   * exposed server too. That is not an oversight: on a `0.0.0.0` bind the Host
   * header is caller-chosen and proves nothing about where the bytes came from,
   * so the bind is the only honest thing to judge. The operator token path is
   * untouched — this gate only guards NEW durable device credentials.
   */
  private mintRefusal(): string | null {
    const bind = this.opts?.host ?? '';
    // The BIND is the only honest judge, and for a while this also accepted a
    // request whose `Host` matched `--allow-host`. That was wrong: `Host` is
    // written by the caller. On a wildcard bind anyone who could reach the port
    // — and had the pair code — could send `Host: <the tailnet name>` straight
    // to the plaintext LAN address, skip the TLS front entirely, and collect a
    // credential that never expires. A header cannot be evidence that a
    // connection was encrypted.
    //
    // Nothing legitimate is lost by dropping it. `wmux web --tailscale` binds
    // 127.0.0.1 and lets `tailscale serve` front it (see
    // decideTailscaleBinding), so the normal tailnet flow takes the loopback
    // exit above and never reaches here. What now refuses is specifically
    // `--expose` + `--allow-host`, where the port really is answering in
    // plaintext on every interface — the case the CLI already warns about.
    // `--allow-host` keeps its other job: the Host allowlist that blocks DNS
    // rebinding.
    if (isLoopbackHost(bind)) return null;
    return (
      `refusing to mint a device credential: this server is bound to ${bind || 'a non-loopback address'} ` +
      'over plain HTTP, and a device secret never expires. Two ways forward: (1) run ' +
      '`wmux web --tailscale` on its own, which binds loopback and lets `tailscale serve` ' +
      'terminate HTTPS for your tailnet; or (2) pair over loopback BEFORE exposing, which ' +
      'keeps the handover off the wire — though a plaintext bind still carries the credential ' +
      'on every later request, so (1) is the one that actually protects it.'
    );
  }

  status(): WebTerminalInfo {
    if (!this.server || !this.opts) return { running: false };
    const pair = this.activePairCode();
    return {
      running: true,
      port: this.opts.port,
      host: this.opts.host,
      allowInput: this.opts.allowInput,
      token: this.token,
      urls: this.buildUrls(),
      clients: this.clients.size,
      pairCode: pair.code,
      pairExpiresAt: pair.expiresAt,
      deviceCredentials: !!this.deps.devices,
    };
  }

  /**
   * The pairing code as far as the OPERATOR surfaces (status/CLI/GUI) are
   * concerned. A code past its TTL must never be advertised — the phone would
   * only be told "expired" — so an expired code is dropped here and, when the
   * regeneration cooldown allows, replaced with a fresh one on the spot.
   */
  private activePairCode(): { code?: string; expiresAt?: number } {
    if (this.pairCode && Date.now() <= this.pairExpiresAt) {
      return { code: this.pairCode, expiresAt: this.pairExpiresAt };
    }
    this.pairCode = '';
    if (Date.now() - this.pairRegeneratedAt >= PAIR_REGEN_COOLDOWN_MS) {
      this.generatePairCode();
      return { code: this.pairCode, expiresAt: this.pairExpiresAt };
    }
    return {};
  }

  // --- request routing ---------------------------------------------------

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    // Reject anything addressed to a host we do not serve (DNS-rebinding guard).
    // Checked before routing so it also covers the unauthenticated /api/pair.
    const hostHeader = req.headers.host ?? '';
    // Strip the port; keep IPv6 literals ("[::1]:7681") intact.
    const hostname = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase()
      : hostHeader.split(':')[0].toLowerCase();
    if (!this.allowedHosts.has(hostname)) {
      return this.json(res, 403, { error: 'host not allowed' });
    }

    // Static, unauthenticated app shell (no secrets live in these). `/pair`
    // is the same SPA shell — the frontend renders the pairing screen for it.
    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/pair')) {
      // The whole app is inlined into this one file and it is rebuilt on every
      // release, so a stale copy is not a slightly-old page — it is the old
      // client talking to a new daemon. With no Cache-Control and no validator
      // a browser is free to heuristically cache it, which during dogfooding
      // meant a phone kept running a build that had already been fixed, with
      // nothing on either side to say so. `no-store` because there is nothing
      // worth revalidating: the payload is either current or wrong.
      return this.serveStatic(res, this.terminalHtml, 'text/html; charset=utf-8', {
        'Cache-Control': 'no-store',
        ...(this.csp ? { 'Content-Security-Policy': this.csp } : {}),
      });
    }
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      // Same reasoning as the shell: a cached manifest pins an installed app's
      // name, icons and start_url to whatever it first saw.
      return this.serveStatic(res, this.manifest, 'application/manifest+json; charset=utf-8', {
        'Cache-Control': 'no-cache',
      });
    }
    if (req.method === 'GET' && p === '/sw.js') {
      // A service worker may only control the scope it is served from; keep it
      // at the root and mark it non-cacheable so updates land immediately.
      return this.serveStatic(res, this.serviceWorker, 'text/javascript; charset=utf-8', {
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
    }
    if (req.method === 'GET' && (p === '/icon-192.png' || p === '/icon-512.png' || p === '/favicon.ico')) {
      return this.serveStatic(res, this.icon, 'image/png');
    }

    // Pairing exchange is the ONLY unauthenticated /api route: it trades a
    // short single-use code for the real token, so it cannot itself require the
    // token. Placed before the /api/* auth gate.
    if (req.method === 'GET' && p === '/api/pair') {
      // Cross-site loads (an `<img src="http://127.0.0.1:7681/api/pair?…">` on
      // any web page) pass the Host guard because they target the loopback
      // literal directly — and this is the one unauthenticated route, so five
      // such loads would burn the pairing code. Browsers stamp those requests
      // `Sec-Fetch-Site: cross-site`; refuse them before touching the attempt
      // budget. Same-origin fetches from the pairing page, direct navigation
      // ('none'), and non-browser clients (header absent) are unaffected.
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        return this.json(res, 403, { error: 'cross-site request refused' });
      }
      this.handlePair(res, url, hostname).catch((err: unknown) => this.failRequest(res, err));
      return;
    }

    if (p.startsWith('/api/')) {
      // Verifying a device credential means running a KDF, which is async by
      // construction, so the whole /api/* branch sits behind one await. The
      // route table itself is unchanged — see handleApi.
      this.handleApi(req, res, url, p).catch((err: unknown) => this.failRequest(res, err));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  /**
   * Everything under `/api/*`: authenticate, then route.
   *
   * Both credential forms are accepted here (operator token, device
   * credential), and the ROUTES do not care which — a paired phone can list
   * panes, watch a stream and answer an approval exactly as the operator can.
   * What differs is only what a revoke can take away, which is why the
   * principal is carried into the two SSE handlers and nowhere else.
   */
  private async handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    p: string,
  ): Promise<void> {
    // `/api/events` answers in two shapes on one route: an EventSource (which
    // cannot set headers, so it gets the same `?token=` exception as
    // `/api/stream`) and a plain JSON backlog fetch (Bearer only, like every
    // other endpoint). The Accept header decides which, and therefore also
    // which auth rule applies.
    const wantsEventStream =
      req.method === 'GET' &&
      p === '/api/events' &&
      String(req.headers.accept ?? '').includes('text/event-stream');
    const isStream = (req.method === 'GET' && p === '/api/stream') || wantsEventStream;
    const auth = await this.authenticate(req, url, isStream);
    if (!auth.ok) {
      // The reason is the point: #599's 401 screen had to guess between "the
      // server restarted" and "you were thrown out", and guessed wrong either
      // way. `revoked` is the operator's decision and deserves its own copy.
      //
      // IT IS COPY, NOT A CLAIM. `revoked` comes from a deviceId lookup alone —
      // the store answers it WITHOUT verifying the secret, deliberately, so a
      // revoked phone reconnecting in a loop cannot force a KDF derivation per
      // retry. So this field says "a credential naming this device was
      // presented", not "the holder proved they are that device". Never let
      // anything but wording key on it.
      return this.json(res, 401, { error: 'unauthorized', reason: auth.reason });
    }
    const principal = auth.principal;
    if (req.method === 'GET' && p === '/api/config') {
      return this.json(res, 200, { allowInput: this.opts?.allowInput === true });
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      return this.json(res, 200, { sessions: this.listSessions() });
    }
    if (req.method === 'GET' && p === '/api/stream') {
      return this.handleStream(req, res, url, principal);
    }
    if (req.method === 'GET' && p === '/api/events') {
      return wantsEventStream
        ? this.handleEventStream(req, res, url, principal)
        : this.handleEventBacklog(res, url);
    }
    if (req.method === 'POST' && p === '/api/stream-ticket') {
      const issued = this.issueStreamTicket(principal);
      if (!issued) {
        return this.json(res, 403, {
          error: 'tickets-are-for-devices',
          detail:
            'stream tickets exist so a paired device can open an EventSource, which cannot set headers. ' +
            'The operator token opens a stream with ?token= directly.',
        });
      }
      return this.json(res, 200, issued);
    }
    if (req.method === 'POST' && p === '/api/input') {
      return this.handleInput(req, res, url);
    }
    if (req.method === 'GET' && p === '/api/approvals') {
      return this.handleApprovalsList(res);
    }
    if (req.method === 'POST' && p.startsWith('/api/approvals/')) {
      return this.handleApprovalResolve(req, res, p.slice('/api/approvals/'.length), principal);
    }
    return this.json(res, 404, { error: 'not found' });
  }

  /** Last-resort 500 for a handler that threw or rejected. */
  private failRequest(res: http.ServerResponse, err: unknown): void {
    this.deps.log('warn', `[web] request handler threw: ${errMsg(err)}`);
    try {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    } catch {
      /* socket already gone */
    }
  }

  private listSessions(): Array<{
    id: string;
    cwd: string;
    cols: number;
    rows: number;
    state: string;
    agent: string | null;
    lastActivity: string;
    workspace?: string;
    /** Short program name (`pwsh`, `bash`) — what to call a pane with no agent. */
    shell?: string;
  }> {
    return this.deps.sessionManager.listLiveSessions().map((s) => ({
      id: s.id,
      cwd: s.cwd,
      cols: s.cols,
      rows: s.rows,
      state: s.state,
      agent: s.agent?.displayName ?? s.lastDetectedAgent ?? null,
      lastActivity: s.lastActivity,
      ...workspaceLabelOf(s.env),
      ...shellLabelOf(s.cmd),
    }));
  }

  // --- SSE output stream --------------------------------------------------

  private handleStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    principal: WebPrincipal,
  ): void {
    const sessionId = url.searchParams.get('session') ?? '';
    const managed = this.deps.sessionManager.getSession(sessionId);
    if (!managed) {
      return this.json(res, 404, { error: 'session not found' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...this.securityHeaders(),
    });

    // Initial paint: the bytes SessionPipe flushes to the GUI on attach, capped
    // to a window — the ring is 8 MB by default and up to 64 MB, and base64
    // inflates it by a third, which a phone reconnecting at every tunnel would
    // pull each time. The truncation rides `meta` rather than a new event name,
    // so a cached frontend that predates it is unaffected.
    const snapshot = capSnapshot(managed.ringBuffer.readAll());
    const meta = {
      cols: managed.meta.cols,
      rows: managed.meta.rows,
      truncated: snapshot.truncated,
      omittedBytes: snapshot.omittedBytes,
    };
    writeSse(res, 'meta', JSON.stringify(meta));
    writeSse(res, 'snapshot', snapshot.bytes.toString('base64'));

    // Live tee off the bridge. This is a SECOND, independent listener — it does
    // not disturb the GUI's SessionPipe. maxListeners is relaxed because each
    // web viewer adds one and we always remove on disconnect.
    const bridge = managed.bridge;
    bridge.setMaxListeners(0);
    const onData = (data: Buffer): void => {
      try {
        writeSse(res, 'data', data.toString('base64'));
      } catch {
        /* client stream broken — the 'close' handler cleans up */
      }
    };
    const onExit = (): void => {
      try {
        writeSse(res, 'exit', '1');
      } catch {
        /* ignore */
      }
    };
    bridge.on('data', onData);
    bridge.on('exit', onExit);

    const stopHeartbeat = startSseHeartbeat(res);

    const detach = (): void => {
      stopHeartbeat();
      bridge.removeListener('data', onData);
      bridge.removeListener('exit', onExit);
    };
    const client: SseClient = { res, sessionId, detach, principal };
    this.clients.add(client);

    req.on('close', () => {
      detach();
      this.clients.delete(client);
    });
  }

  // --- input (opt-in) -----------------------------------------------------

  private handleInput(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (this.opts?.allowInput !== true) {
      return this.json(res, 403, { error: 'read-only: server started without --allow-input' });
    }
    const sessionId = url.searchParams.get('session') ?? '';
    const managed = this.deps.sessionManager.getSession(sessionId);
    if (!managed) {
      return this.json(res, 404, { error: 'session not found' });
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) {
        aborted = true;
        this.json(res, 413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        managed.ptyProcess.write(body);
      } catch (err) {
        return this.json(res, 500, { error: `write failed: ${errMsg(err)}` });
      }
      res.writeHead(204);
      res.end();
    });
    req.on('error', () => {
      aborted = true;
    });
  }

  // --- approvals (M2) -----------------------------------------------------

  /**
   * `GET /api/approvals` — what a client needs the moment it connects: the
   * requests still waiting on a human, plus the recently settled tail.
   *
   * The settled tail is not decoration. Two people can be looking at the same
   * pending approval on two devices; the loser of that race gets a 409, and
   * without the settled record there is nothing to render but an error code.
   */
  private handleApprovalsList(res: http.ServerResponse): void {
    const approvals = this.deps.approvals;
    if (!approvals) return this.json(res, 503, { error: 'approvals unavailable' });
    let listed: { pending: ApprovalRequest[]; recentlyResolved: ApprovalRequest[] };
    try {
      listed = approvals.list();
    } catch (err) {
      this.deps.log('warn', `[web] approvals list failed: ${errMsg(err)}`);
      return this.json(res, 500, { error: 'approvals unavailable' });
    }
    // Both halves keep the registry's own names and order (recentlyResolved is
    // newest-first and already bounded there), so the two shapes agree today.
    // They are NOT one serializer: this goes through `approvalWire`, a
    // field-by-field allowlist, while `daemon.approvals.list` returns the
    // registry's records unfiltered. That is fine while the pipe stays
    // daemon-internal, but it means adding a field to ApprovalRequest puts it
    // on the pipe and not here — deliberately, since the allowlist exists so
    // registry internals cannot reach the network by default.
    return this.json(res, 200, {
      pending: listed.pending.map(approvalWire),
      recentlyResolved: listed.recentlyResolved.map(approvalWire),
    });
  }

  /**
   * `POST /api/approvals/:id` — answer one request.
   *
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ THIS ROUTE WORKS ON A READ-ONLY SERVER. THAT IS DELIBERATE.           │
   * └───────────────────────────────────────────────────────────────────────┘
   * Every other write path (`POST /api/input`) is 403 without `--allow-input`,
   * and that stays true — this carve-out widens NOTHING else. The reason it is
   * safe, and the reason the whole milestone exists:
   *
   *   - `--allow-input` grants ARBITRARY bytes to ANY pane at ANY time. This
   *     grants ONE answer to ONE request the DAEMON already decided to raise,
   *     from a hook-sourced `agent.awaiting_input` — the operator cannot invent
   *     a request, only respond to one.
   *   - The bytes are not the caller's. The caller sends `approve`/`deny`; the
   *     registry picks the keystrokes from its own per-agent map and re-reads
   *     the pane to confirm the prompt is still on screen before writing. A
   *     request that has expired, been superseded, or lost its prompt refuses.
   *   - Requiring `--allow-input` here would mean the answer to "my agent is
   *     blocked and I am not at my desk" is "you should have granted a fully
   *     writable terminal to the network in advance", which is a worse posture
   *     than the narrow grant it is trying to avoid.
   *
   * Still gated by the Bearer token like everything else, and the token is not
   * ambient authority (no cookie), so a hostile page cannot forge this POST.
   */
  private handleApprovalResolve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawId: string,
    principal: WebPrincipal,
  ): void {
    const approvals = this.deps.approvals;
    if (!approvals) return this.json(res, 503, { error: 'approvals unavailable' });

    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      // Malformed percent-escape — no such request, by definition.
      return this.json(res, 404, { error: 'not-found' });
    }
    if (!id || id.includes('/')) return this.json(res, 404, { error: 'not-found' });

    this.readJsonBody(req, res, (body) => {
      const decision = (body as { decision?: unknown } | null)?.decision;
      if (decision !== 'approve' && decision !== 'deny') {
        return this.json(res, 400, { error: "decision must be 'approve' or 'deny'" });
      }
      approvals
        .resolve({ id, decision, resolvedBy: describePrincipal(principal) })
        .then((result) => {
          if (result.ok) {
            // 200 with `durable:false` rather than an error: the keystroke IS in
            // the terminal, so the answer landed and the caller must not retry.
            // What did not land is the record of it — after a restart the
            // history will not show this decision or who made it. The client
            // says so instead of the daemon knowing it privately.
            return this.json(res, 200, { state: result.request.state, durable: result.durable });
          }
          switch (result.reason) {
            // Someone else got there first — hand back WHO, so the loser's UI
            // can say so instead of showing a bare conflict.
            case 'already-resolved':
              return this.json(res, 409, { error: 'already-resolved', resolvedBy: result.resolvedBy });
            // Gone: the request outlived its usefulness (timed out, replaced by
            // a newer prompt, or the prompt left the screen). 410, not 404 —
            // it existed, and the client should stop showing it. The registry
            // reports 'expired' for a supersede too, so the precise state rides
            // along when it knows it: "someone re-prompted" and "it timed out"
            // are the same status but not the same sentence to a human.
            case 'expired':
            case 'prompt-gone':
              return this.json(res, 410, {
                error: result.reason,
                ...(result.request ? { state: result.request.state } : {}),
              });
            // The daemon has no keystroke map for this agent, so it refuses to
            // guess bytes. Not the caller's fault: 501, not 4xx.
            case 'unsupported-agent':
              return this.json(res, 501, { error: 'unsupported-agent' });
            case 'not-found':
              return this.json(res, 404, { error: 'not-found' });
            default: {
              // A reason this surface does not know how to map. Never silently
              // report success — say the server does not understand its own
              // registry and log it.
              const reason = String(result.reason);
              this.deps.log('warn', `[web] approval resolve returned unknown reason: ${reason}`);
              return this.json(res, 500, { error: reason });
            }
          }
        })
        .catch((err: unknown) => {
          this.deps.log('warn', `[web] approval resolve threw: ${errMsg(err)}`);
          try {
            this.json(res, 500, { error: `resolve failed: ${errMsg(err)}` });
          } catch {
            /* socket already gone */
          }
        });
    });
  }

  /**
   * Read a small JSON body. On a body that is too large or not JSON, this
   * answers the request itself and never calls back — so a caller can treat the
   * callback as "a parsed body arrived". An empty body parses as `null`, which
   * the caller rejects as a missing decision.
   */
  private readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    onBody: (body: unknown) => void,
  ): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        aborted = true;
        this.json(res, 413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return onBody(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw, (key, value) => {
          // Prototype pollution guard (mirrors config.ts / webStateStore).
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
          return value;
        });
      } catch {
        return this.json(res, 400, { error: 'invalid JSON body' });
      }
      onBody(parsed);
    });
    req.on('error', () => {
      aborted = true;
    });
  }

  /**
   * Republish a registry lifecycle transition onto the attention channel.
   *
   * The CONTENT fields — `screenTail`, `question`, `options` — are deliberately
   * NOT on the wire here: a tail is a screenful of pane output, and this payload
   * is fanned out to every client AND kept in the replay window for the whole
   * TTL. Clients fetch `/api/approvals` on connect and on any `approval` event
   * for the full record: the event is the nudge, the route is the truth.
   *
   * CONSEQUENCE A UI MUST RESPECT: never render an approve/deny control from an
   * `approval` event alone. `approve` is encoded as "press the first option",
   * which is a safe word for a consent-shaped prompt and a dangerous one for
   * "which file should I delete?" — so the buttons belong to the route's record,
   * which carries the question, or to nothing at all.
   */
  private publishApproval(e: ApprovalEvent): void {
    if (!e || typeof e !== 'object' || !e.request) return;
    const r = e.request;
    this.publish('approval', {
      sessionId: r.sessionId,
      // NOT `id`: the envelope's own `id` is the replay cursor, and identity
      // fields are stamped last precisely so a payload cannot shadow them.
      approvalId: r.id,
      phase: e.type,
      state: r.state,
      agent: r.agent,
      // The record's own `kind` ('awaiting_input') is NOT copied: the backlog
      // route stamps the ENVELOPE kind onto that name, so carrying both would
      // mean `kind` said different things on the two shapes of the same event.
      createdAt: r.createdAt,
      ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
      ...(r.decision ? { decision: r.decision } : {}),
      ...(r.resolvedBy ? { resolvedBy: r.resolvedBy } : {}),
      ...(typeof r.resolvedAt === 'number' ? { resolvedAt: r.resolvedAt } : {}),
    });
  }

  // --- fleet-wide event tee -----------------------------------------------

  /**
   * Record an attention event, then fan it out to EVERY connected client —
   * pane streams (whatever session they watch) and `/api/events` subscribers
   * alike. The wire payload flattens the event so the frontend sees
   * `{id, epoch, sessionId, ...event}`.
   *
   * Recording happens FIRST and unconditionally. That is the whole point of
   * #598: an approval raised while nobody was connected used to evaporate,
   * because a fan-out over an empty client set is a no-op. Now it lands in the
   * log and the next connect replays it.
   */
  private broadcastEvent(kind: 'critical' | 'notify', payload: { sessionId: string; event?: unknown }): void {
    if (!payload || typeof payload !== 'object') return;
    const event = payload.event && typeof payload.event === 'object' ? (payload.event as Record<string, unknown>) : {};
    const entry = this.publish(kind, { sessionId: payload.sessionId, ...event });

    // BACK-COMPAT (remove after one release): attention still rides the pane
    // streams so a cached PWA frontend that predates `/api/events` keeps
    // working. The extra `id`/`epoch` fields are ignored by old clients; new
    // ones dedup on them, so the double delivery is harmless.
    //
    // Approvals deliberately do NOT get this second copy: no frontend older
    // than the approval channel can act on one, so it would be pure noise on
    // every pane stream.
    const body = this.attentionWireBody(entry);
    for (const client of this.clients) {
      try {
        writeSse(client.res, kind, body);
      } catch {
        /* client stream broken — its own 'close' handler cleans up */
      }
    }
  }

  /**
   * Record one event in the replay window and fan it out to `/api/events`.
   *
   * Every kind shares ONE id space and ONE log: a client's cursor is a single
   * number, so an approval and a notification cannot be interleaved in a way
   * that makes a resume ambiguous.
   */
  private publish(kind: EventKind, payload: Record<string, unknown>): AttentionEntry {
    const entry: AttentionEntry = { id: ++this.attentionSeq, at: this.now(), kind, payload };
    this.attentionLog.push(entry);
    this.evictAttention();

    const body = this.attentionWireBody(entry);
    for (const client of this.eventClients) {
      try {
        writeSse(client.res, kind, body, this.sseId(entry.id));
      } catch {
        /* client stream broken — its own 'close' handler cleans up */
      }
    }
    return entry;
  }

  /** Drop entries past the cap (oldest first) and anything past the TTL. */
  private evictAttention(): void {
    if (this.attentionLog.length > ATTENTION_CAP) {
      this.attentionLog.splice(0, this.attentionLog.length - ATTENTION_CAP);
    }
    const cutoff = this.now() - ATTENTION_TTL_MS;
    // Entries are appended in time order, so the expired ones are a prefix.
    let drop = 0;
    while (drop < this.attentionLog.length && this.attentionLog[drop].at < cutoff) drop += 1;
    if (drop > 0) this.attentionLog.splice(0, drop);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The exact JSON one attention event carries on the wire, live or replayed. */
  private attentionWireBody(entry: AttentionEntry): string {
    // Identity fields go LAST so pane-supplied payload data can never shadow them.
    return JSON.stringify({ ...entry.payload, id: entry.id, epoch: this.attentionEpoch });
  }

  /** SSE `id:` value — epoch-qualified so a stale cursor is detectable. */
  private sseId(id: number): string {
    return `${this.attentionEpoch}:${id}`;
  }

  /** Highest id ever issued (NOT the log's head — the log evicts, ids do not). */
  private headId(): number {
    return this.attentionSeq;
  }

  /**
   * Parse an `epoch:id` cursor. A UUID contains no colon, but split on the LAST
   * one anyway so a future epoch format cannot silently mis-parse.
   */
  private parseCursor(raw: string | undefined | null): AttentionCursor | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    const cut = value.lastIndexOf(':');
    if (cut <= 0) return null;
    const epoch = value.slice(0, cut);
    const id = Number(value.slice(cut + 1));
    if (!epoch || !Number.isFinite(id) || id < 0) return null;
    return { epoch, id: Math.floor(id) };
  }

  /**
   * Everything a cursor has not seen yet. A cursor from another epoch (or none
   * at all) cannot be positioned in this id space, so the caller is told to
   * resync and handed the whole current window.
   *
   * A MATCHING epoch is not on its own enough, and that was the gap. The log
   * evicts — 100 entries, 30 minutes — while ids never rewind, so a cursor can
   * be perfectly valid and still sit below everything still held. Answering
   * `reset:false` there hands back the retained tail and lets the client treat
   * it as contiguous with what it last saw: the events in between are gone, the
   * client is never told, and on a phone that reconnects after a long sleep
   * that silently swallows the attention events this whole channel exists to
   * deliver. `reset` is the only signal that continuity broke, so it has to
   * fire whenever it did — not only when the epoch changed.
   */
  private replayFrom(cursor: AttentionCursor | null): { reset: boolean; entries: AttentionEntry[] } {
    this.evictAttention();
    if (!cursor || cursor.epoch !== this.attentionEpoch) {
      return { reset: true, entries: this.attentionLog.slice() };
    }
    const oldest = this.attentionLog.length > 0 ? this.attentionLog[0].id : null;
    // With entries held, continuity survives only if the cursor's NEXT id is one
    // we still have. With none held, it survives only if nothing was issued
    // after the cursor — an empty log is "quiet", not "lost", until it isn't.
    const gap = oldest === null ? cursor.id < this.headId() : cursor.id < oldest - 1;
    // A cursor above every id we ever issued cannot be positioned either; it did
    // not come from us in this epoch.
    if (gap || cursor.id > this.headId()) {
      return { reset: true, entries: this.attentionLog.slice() };
    }
    return { reset: false, entries: this.attentionLog.filter((e) => e.id > cursor.id) };
  }

  /**
   * `GET /api/events` (SSE) — the durable attention channel.
   *
   * Unlike the pane streams this one is opened ONCE per page and never
   * torn down on a pane switch, which is what makes replay meaningful: the
   * browser resends `Last-Event-ID` on every automatic reconnect, so a phone
   * that lost signal picks up exactly where it stopped.
   */
  private handleEventStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    principal: WebPrincipal,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...this.securityHeaders(),
    });

    // EventSource's own resume header wins; `?since=` covers a page RELOAD,
    // where the browser starts a fresh EventSource with no memory of the id.
    const lastEventId = req.headers['last-event-id'];
    const cursor =
      this.parseCursor(typeof lastEventId === 'string' ? lastEventId : null) ??
      this.parseCursor(url.searchParams.get('since'));

    const { reset, entries } = this.replayFrom(cursor);
    if (reset) {
      // Say so BEFORE the backlog: the client renders a summary for a resync
      // instead of a burst of banners for events it may already have acted on.
      writeSse(res, 'reset', JSON.stringify({ epoch: this.attentionEpoch, headId: this.headId() }));
    }
    for (const entry of entries) {
      try {
        writeSse(res, entry.kind, this.attentionWireBody(entry), this.sseId(entry.id));
      } catch {
        /* client vanished mid-replay — its own 'close' handler cleans up */
        return;
      }
    }

    const detach = startSseHeartbeat(res);
    const client: EventClient = { res, detach, principal };
    this.eventClients.add(client);

    req.on('close', () => {
      detach();
      this.eventClients.delete(client);
    });
  }

  /**
   * `GET /api/events` (JSON) — the same window as a plain fetch, for a client
   * that wants the backlog up front (or has no EventSource at all, e.g. the
   * native app). Bearer-only: a non-SSE route never accepts `?token=`.
   */
  private handleEventBacklog(res: http.ServerResponse, url: URL): void {
    const cursor = this.parseCursor(url.searchParams.get('since'));
    const { reset, entries } = this.replayFrom(cursor);
    return this.json(res, 200, {
      epoch: this.attentionEpoch,
      headId: this.headId(),
      reset,
      // Identity fields go LAST so pane-supplied payload data can never shadow them.
      events: entries.map((e) => ({ ...e.payload, id: e.id, kind: e.kind, at: e.at })),
    });
  }

  // --- pairing ------------------------------------------------------------

  /** Mint a fresh single-use pairing code with a bounded lifetime + attempts. */
  private generatePairCode(): void {
    const bytes = crypto.randomBytes(PAIR_CODE_LEN);
    let code = '';
    for (let i = 0; i < PAIR_CODE_LEN; i++) {
      code += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
    }
    this.pairCode = code;
    this.pairExpiresAt = Date.now() + PAIR_TTL_MS;
    this.pairAttempts = PAIR_MAX_ATTEMPTS;
    this.pairRegeneratedAt = Date.now();
  }

  /**
   * Exchange a pairing code for THIS DEVICE'S OWN credential. Correct code →
   * `{deviceId, deviceSecret, token}` and the code is immediately invalidated
   * (single use). Wrong/expired → 403; a wrong code decrements the attempt
   * budget and burns the code when it hits zero.
   *
   * Before M3 this handed back the server-wide bearer token, which meant every
   * paired device shared one secret and losing a phone meant rotating everyone.
   * The wire keeps a `token` field carrying the composed `deviceId.secret`
   * because that is the string the client presents as its Bearer — one value to
   * store, and the pairing screen keeps working unchanged — but it is now a
   * per-device credential, not the operator's.
   */
  private async handlePair(res: http.ServerResponse, url: URL, requestHost: string): Promise<void> {
    const supplied = (url.searchParams.get('code') ?? '').trim().toUpperCase();

    if (!this.pairCode || Date.now() > this.pairExpiresAt) {
      // A burned or expired code used to be gone until the next `start()`,
      // which turned "5 wrong guesses" into a permanent pairing outage. Mint a
      // fresh one instead — rate-limited so this cannot be spun as an oracle —
      // and let the operator read it from `daemon.web.status` / the GUI popover.
      this.pairCode = '';
      if (Date.now() - this.pairRegeneratedAt >= PAIR_REGEN_COOLDOWN_MS) {
        this.generatePairCode();
      }
      return this.json(res, 403, { error: 'expired' });
    }
    if (this.pairAttempts <= 0) {
      this.pairCode = '';
      if (Date.now() - this.pairRegeneratedAt >= PAIR_REGEN_COOLDOWN_MS) {
        this.generatePairCode();
      }
      return this.json(res, 403, { error: 'too many attempts' });
    }

    if (!timingSafeEquals(supplied, this.pairCode)) {
      this.pairAttempts -= 1;
      if (this.pairAttempts <= 0) this.pairCode = '';
      return this.json(res, 403, {
        error: 'invalid code',
        attemptsLeft: Math.max(0, this.pairAttempts),
      });
    }

    // The code is right. Now the transport: a device credential is durable and
    // never expires, so it must not be handed over in the clear to something
    // off-machine. Checked HERE and not only at pairStart because the operator
    // may have restarted the server with `--expose` since the code was minted.
    // The code is NOT burned — the operator should be able to fix the transport
    // and use the code they already read out, and a refusal reveals nothing.
    const refusal = this.mintRefusal();
    if (refusal) return this.json(res, 403, { error: 'insecure-transport', detail: refusal });

    const devices = this.deps.devices;
    if (!devices) {
      // No identity core wired (a daemon that failed to build one). Falling
      // back to the shared token keeps pairing possible instead of bricking it,
      // but it is a real downgrade — per-device revocation does not exist on
      // this server — so say so out loud rather than degrading silently.
      this.deps.log('warn', '[web] pairing without a device store — issuing the shared operator token');
      this.burnPairCode();
      return this.json(res, 200, { token: this.token });
    }

    let minted: { deviceId: string; deviceSecret: string };
    try {
      minted = await devices.mint({ name: this.pendingDeviceName });
    } catch (err) {
      // The roster could not be persisted. Do NOT burn the code and do NOT
      // fall back to the shared token: a credential the daemon cannot
      // remember is one the operator can never revoke.
      this.deps.log('error', `[web] device mint failed: ${errMsg(err)}`);
      return this.json(res, 500, { error: 'pairing failed' });
    }

    // Success: hand the credential over exactly once, then burn the code.
    this.burnPairCode();
    return this.json(res, 200, {
      deviceId: minted.deviceId,
      deviceSecret: minted.deviceSecret,
      token: `${minted.deviceId}${DEVICE_CREDENTIAL_SEP}${minted.deviceSecret}`,
    });
  }

  /** Consume the active pairing code (single use) and its pending name. */
  private burnPairCode(): void {
    this.pairCode = '';
    this.pairExpiresAt = 0;
    this.pairAttempts = 0;
    this.pendingDeviceName = undefined;
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Authenticate an `/api/*` request. Two credential forms, one gate:
   *
   *   `Bearer <token>`             the OPERATOR (CLI, GUI, `--status` URLs)
   *   `Bearer <deviceId>.<secret>` a paired DEVICE
   *
   * The operator token is tried first and always timing-safe, so a device
   * credential that happens to contain a dot cannot be probed against it.
   * Device lookup is BY ID — the store compares one hash, never a linear scan
   * over the roster (§2).
   *
   * `allowQuery` is true ONLY for the two SSE routes, which must accept
   * `?token=` because EventSource cannot set headers. That exception is for the
   * OPERATOR TOKEN ALONE: a device secret is durable and never expires, and a
   * query string is the one place a credential is guaranteed to be written down
   * (history, proxy logs, Referer). So a device credential presented in the
   * query authenticates nothing, on any route.
   */
  private async authenticate(req: http.IncomingMessage, url: URL, allowQuery: boolean): Promise<AuthOutcome> {
    if (!this.token) return { ok: false, reason: 'unknown' };
    const header = req.headers['authorization'];
    const fromHeader =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const fromQuery = allowQuery ? url.searchParams.get('token') : null;

    if (timingSafeEquals(fromHeader ?? fromQuery ?? '', this.token)) {
      return { ok: true, principal: { kind: 'operator' } };
    }

    const devices = this.deps.devices;
    // Header only — see above. `null` here is "no Bearer header at all".
    const cut = fromHeader ? fromHeader.indexOf(DEVICE_CREDENTIAL_SEP) : -1;
    if (!devices || cut <= 0) {
      // No usable header credential. On the SSE routes a device may instead
      // present a stream TICKET (B3) — the narrow, expiring capability that
      // exists precisely because EventSource cannot send a header. Checked last
      // so it can never shadow a real credential, and never on a non-SSE route.
      const viaTicket = allowQuery ? this.resolveStreamTicket(url.searchParams.get('ticket')) : null;
      if (viaTicket && viaTicket.kind === 'device') {
        this.touchDevice(viaTicket.deviceId);
        return { ok: true, principal: viaTicket };
      }
      return { ok: false, reason: 'unknown' };
    }
    const deviceId = fromHeader!.slice(0, cut);
    const secret = fromHeader!.slice(cut + 1);
    // A credential with NOTHING after the separator is malformed, and refusing
    // it here is parsing, not comparison: this branch reads only the bytes the
    // caller sent, never anything stored, so it cannot leak a stored secret's
    // length or content. The constant-time property §2 asks for lives one layer
    // down, where the store derives a fixed-length key from an input of ANY
    // length and reaches the same `timingSafeEqual` every time. Passing a
    // secret-less credential through instead would buy nothing and would hand
    // an unauthenticated caller a free KDF derivation per request.
    if (!secret) return { ok: false, reason: 'unknown' };

    let result: DeviceAuthResult;
    try {
      result = await devices.resolve(deviceId, secret);
    } catch (err) {
      // A store that cannot answer is not an authorization. Fail closed, and
      // never turn an auth failure into a 500 on the route behind it.
      this.deps.log('warn', `[web] device auth failed: ${errMsg(err)}`);
      return { ok: false, reason: 'unknown' };
    }
    if (!result.ok) return { ok: false, reason: result.reason };
    this.touchDevice(result.deviceId);
    return {
      ok: true,
      principal: { kind: 'device', deviceId: result.deviceId, ...(result.name ? { name: result.name } : {}) },
    };
  }

  /** Report a device's activity to the roster. Bookkeeping — never fatal. */
  private touchDevice(deviceId: string): void {
    try {
      this.deps.devices?.touch?.(deviceId);
    } catch (err) {
      this.deps.log('warn', `[web] device touch failed: ${errMsg(err)}`);
    }
  }

  /**
   * Baseline headers every response carries — the hardening a local HTTP server
   * owes the browser (the same controls Docker / VS Code / Electron apply):
   *   - frame protection, so a page on evil.com cannot iframe this authenticated
   *     terminal and redress clicks into a pane (worse with `--allow-input`);
   *   - `nosniff`, so nothing is re-interpreted as an executable type;
   *   - `no-referrer`, which also keeps the SSE URL's `?token=` (the one route
   *     that must carry it) out of any outbound Referer;
   *   - the full CSP, which used to be `frame-ancestors 'none'` alone. That was
   *     defensible only while the credential an XSS could steal expired at the
   *     next restart; M3 made credentials durable, so `script-src` pinned to the
   *     inlined bundle's hashes is now part of what makes them safe to hand out.
   *     See webCsp.ts for how the hashes are derived and why `style-src` is the
   *     one directive that is not hash-pinned.
   */
  private securityHeaders(): Record<string, string> {
    return {
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Baseline only. The full policy — script hashes and all — rides the HTML
      // response, which is the only thing that executes; #612 made that call
      // and it is the right one, because the alternative puts ~250 bytes of
      // hashes on every JSON reply, and a phone typing pays that per keystroke.
      'Content-Security-Policy': "frame-ancestors 'none'",
    };
  }

  private serveStatic(
    res: http.ServerResponse,
    body: Buffer | null,
    contentType: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    if (!body) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...this.securityHeaders(),
      });
      res.end('wmux web assets not built — run `npm run build:daemon-web`.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      ...this.securityHeaders(),
      ...extraHeaders,
    });
    res.end(body);
  }

  private json(res: http.ServerResponse, status: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...this.securityHeaders(),
    });
    res.end(body);
  }

  private buildUrls(): string[] {
    if (!this.opts) return [];
    const { host, port } = this.opts;
    const token = this.token;
    const suffix = `:${port}/?token=${token}`;
    // When bound to all interfaces, enumerate concrete reachable addresses so
    // the operator can pick their tailnet IP; otherwise report the bind host.
    if (host === '0.0.0.0' || host === '::') {
      const addrs = collectIpv4();
      const urls = addrs.map((a) => `http://${a}${suffix}`);
      urls.push(`http://127.0.0.1${suffix}`);
      return urls;
    }
    return [`http://${urlAuthority(host)}${suffix}`];
  }

  private loadAssets(): void {
    const dir = this.deps.assetsDir;
    this.terminalHtml = readIfExists(path.join(dir, 'terminal.html'));
    this.manifest = readIfExists(path.join(dir, 'manifest.webmanifest'));
    this.serviceWorker = readIfExists(path.join(dir, 'sw.js'));
    this.icon = readIfExists(path.join(dir, 'icon-512.png'));
    // Derived from the page we just loaded, once per start rather than per
    // request: hashing 583 KB on the way out of every response would be a real
    // cost for a header that cannot change while the process runs.
    //
    // This supersedes #612's buildHtmlCsp, which computed the same policy but
    // hashed the file's raw bytes. The HTML parser rewrites CRLF to LF before
    // the tokenizer runs, so a page built from a Windows checkout — where the
    // frontend sources carry CRLF — produced hashes matching nothing the
    // browser would compute, and every inline block was refused: a blank
    // terminal. Verified in a real browser both ways; buildWebCsp normalizes
    // first.
    this.csp = buildWebCsp(this.terminalHtml ? this.terminalHtml.toString('utf8') : null);
    if (!this.terminalHtml) {
      this.deps.log('warn', `[web] terminal.html missing under ${dir} — run \`npm run build:daemon-web\``);
    }
  }
}

// === module helpers =========================================================


/**
 * One SSE frame. `id` is optional and emitted only on the attention stream —
 * the browser echoes the last one back as `Last-Event-ID` when it reconnects,
 * which is the entire replay mechanism. Pane streams stay id-less: their resume
 * story is the ring-buffer snapshot, not an id cursor.
 */
function writeSse(res: http.ServerResponse, event: string, data: string, id?: string): void {
  res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${data}\n\n`);
}

/**
 * Which workspace a pane belongs to, for the browser's session labels.
 *
 * `DaemonSession` has no workspace field — workspaces are a renderer/main
 * concept — but main stamps the identity into every pane's child env at spawn
 * (resolveSpawnEnv) and the daemon persists that env verbatim, so the answer is
 * already here. We read EXACTLY the two identity keys: the session env is the
 * pane's full resolved environment (credentials, account config dirs) and must
 * never reach a browser wholesale.
 *
 * ONLY the name is surfaced. The workspace id is deliberately NOT a fallback:
 * it is a UUID (`ws-192b59b5-…`), which tells a human nothing and is strictly
 * worse than the cwd label the frontend already falls back to.
 *
 * HONEST LIMITATION: the name is a spawn-time snapshot of the env, so panes
 * created before WMUX_WORKSPACE_NAME existed have none (the frontend shows the
 * cwd, exactly as before), and a workspace renamed after a pane spawned keeps
 * showing the old name here. We never invent a label.
 */
/**
 * A short, human name for the program a pane is running, taken from the
 * recorded command. Without it, a pane with no detected agent had nothing to be
 * called but its own cwd, which the row already prints underneath — so every
 * such row read as the same string twice and panes were indistinguishable.
 * Only the basename is surfaced: the full command line can carry arguments, and
 * arguments can carry secrets.
 */
function shellLabelOf(cmd: string | undefined): { shell?: string } {
  if (typeof cmd !== 'string' || !cmd.trim()) return {};
  // Windows program paths contain spaces as a matter of course
  // (C:\Program Files\...\pwsh.exe) and are NOT quoted when they carry no
  // arguments, so neither splitting on whitespace nor trusting quotes is enough
  // on its own: the real shells this sees arrive bare. Take the quoted span
  // when there is one, else everything up to an executable-extension boundary,
  // else the first whitespace-delimited token (the POSIX case, which has no
  // extension to anchor on).
  const trimmed = cmd.trim();
  const quoted = /^"([^"]+)"/.exec(trimmed);
  const exe = /^(.*?\.(?:exe|cmd|bat|com))(?:\s|$)/i.exec(trimmed);
  const first = quoted ? quoted[1] : exe ? exe[1] : trimmed.split(/\s+/)[0];
  const base = first.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.(exe|cmd|bat|com)$/i, '');
  return name ? { shell: name } : {};
}

function workspaceLabelOf(env: Record<string, string> | undefined): { workspace?: string } {
  const value = env?.[ENV_KEYS.WORKSPACE_NAME];
  const workspace = typeof value === 'string' ? value.trim() : '';
  return workspace ? { workspace } : {};
}

/**
 * The projection of an approval record that reaches a browser.
 *
 * Field-by-field on purpose, exactly like `workspaceLabelOf`: the registry is
 * daemon-internal and free to grow fields (resolved keystrokes, pane env, the
 * hook envelope it was built from), and none of those should reach the network
 * because someone added them upstream. What is here is what a human needs to
 * decide: which pane, which agent, what was asked, what was on screen, and how
 * it ended.
 *
 * `question` / `options` are AGENT-AUTHORED TEXT (extracted from the
 * AskUserQuestion tool_input), the same trust class as `screenTail`: safe to
 * transport, never safe to render unescaped, and `options` is not a closed set
 * anything security-relevant may key on — the keystroke map, not this list,
 * decides what a decision sends.
 */
function approvalWire(r: ApprovalRequest): Record<string, unknown> {
  return {
    id: r.id,
    sessionId: r.sessionId,
    agent: r.agent,
    kind: r.kind,
    state: r.state,
    createdAt: r.createdAt,
    ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
    // Presence-checked, not truthiness-checked: an empty question or an empty
    // options list is a fact the registry recorded, not a missing field.
    ...(typeof r.question === 'string' ? { question: r.question } : {}),
    ...(Array.isArray(r.options) ? { options: r.options } : {}),
    ...(r.screenTail ? { screenTail: r.screenTail } : {}),
    ...(r.decision ? { decision: r.decision } : {}),
    ...(r.resolvedBy ? { resolvedBy: r.resolvedBy } : {}),
    ...(typeof r.resolvedAt === 'number' ? { resolvedAt: r.resolvedAt } : {}),
  };
}

/**
 * Compare two secrets without leaking WHERE they differ. The length check is a
 * timingSafeEqual precondition (it throws on a mismatch), so credential length
 * remains observable — as it was before M3, and as it is for every bearer
 * scheme that does not pad.
 */
function timingSafeEquals(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Addresses/names that never leave the machine. */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.');
}

function readIfExists(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A host as it may appear in a URL authority: IPv6 literals must be bracketed
 * (`http://::1:7681` is rejected by browsers and `new URL()` alike).
 */
function urlAuthority(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Non-internal IPv4 addresses, tailnet-first. Tailscale hands out CGNAT-range
 * addresses (100.64.0.0/10), which are the ones a phone actually reaches, so
 * surface them ahead of ordinary LAN addresses.
 */
function collectIpv4(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        out.push(info.address);
      }
    }
  }
  const isTailnet = (ip: string): boolean => {
    const m = ip.match(/^100\.(\d+)\./);
    if (!m) return false;
    const second = Number(m[1]);
    return second >= 64 && second <= 127;
  };
  return out.sort((a, b) => Number(isTailnet(b)) - Number(isTailnet(a)));
}
