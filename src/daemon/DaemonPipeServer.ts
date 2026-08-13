import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { RpcRequest, RpcResponse } from '../shared/rpc';
import { secureWriteTokenFile, scheduleTokenFileReHarden } from '../shared/security';
import { getDaemonAuthTokenPath } from '../shared/constants';

const MAX_LINE_BUFFER = 1024 * 1024; // 1 MB — prevent OOM from malicious clients

/**
 * Maximum pushed-event data retained while a fresh socket identifies as the
 * first-party app and decides whether to call `daemon.events.subscribe`.
 *
 * Events can still be generated while the daemon dispatches those two requests.
 * Retaining the bounded window closes the loss gap without making
 * ordinary RPC clients event subscribers. Byte overflow disconnects so the app
 * reconnects and rehydrates; time expiry discards the queue so an incomplete
 * handshake cannot eventually flap an otherwise usable RPC-only socket.
 */
export const PRE_SUBSCRIBE_BACKLOG_BYTES = 1024 * 1024;
export const PRE_SUBSCRIBE_HANDSHAKE_TTL_MS = 15_000;

interface PreSubscribeBacklog {
  frames: string[];
  bytes: number;
  /** Only subscribe declares intent; identity-first remains live-only. */
  intentDeclared: boolean;
  /** The accept window is time-bounded even if the client sends no RPC. */
  expiresAt: number;
}

/**
 * Unflushed bytes on one socket past which that client is treated as STALLED.
 *
 * `socket.write` returning false is advisory in Node: the data is queued anyway
 * and the writable buffer has no ceiling. A subscriber that stops reading (a
 * hung renderer, a paused process, a phone on a dead link) would therefore grow
 * the daemon's heap by one full payload per append, indefinitely. Above this cap
 * per-subscriber events are REFUSED — `sendTo` returns false, and `broadcast`
 * drops the stalled event subscription rather than keep buffering.
 */
export const SUBSCRIBER_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/**
 * Which connected client an RPC arrived on. Handlers that fan data back out to
 * ONE subscriber (rather than to every client) need this: `broadcast` writes to
 * all sockets, and full conversation content must reach only the client that
 * asked for it.
 */
export interface RpcClientContext {
  /** Opaque, stable for the life of the socket. See `sendTo` / `onClientClose`. */
  clientId: string;
}

type RpcHandler = (
  params: Record<string, unknown>,
  ctx: RpcClientContext,
) => Promise<unknown>;

/** Action a reclaim probe implies, distinguishing a live owner from a zombie. */
export type ReclaimOutcome = 'live-owner' | 'reclaimed' | 'unreclaimable';

/**
 * Classify a reclaim-probe result into the action the pipe server should take.
 * Pure, so the live-owner-vs-zombie decision is unit-testable without a real
 * socket.
 *   - connect succeeded         → 'live-owner'    (a live process owns the pipe)
 *   - ECONNREFUSED/RESET/EPIPE   → 'reclaimed'     (zombie; probe released it)
 *   - timeout / any other error  → 'unreclaimable' (ambiguous; do NOT claim live)
 *
 * The 'live-owner' vs 'unreclaimable' split is the split-brain fix (Defect 3):
 * the OLD code folded both into "false" and then fell back to a `-N` suffix,
 * spawning a second LIVE daemon on the canonical pipe. Only a confirmed live
 * owner must make `start()` yield; an ambiguous probe keeps the legacy retry.
 */
export function classifyReclaimProbe(
  event: 'connect' | 'error' | 'timeout',
  errCode?: string,
): ReclaimOutcome {
  if (event === 'connect') return 'live-owner';
  if (event === 'timeout') return 'unreclaimable';
  if (errCode === 'ECONNREFUSED' || errCode === 'ECONNRESET' || errCode === 'EPIPE') {
    return 'reclaimed';
  }
  return 'unreclaimable';
}

/**
 * Daemon Control Pipe server.
 * Listens on a Named Pipe (Windows) or Unix domain socket for JSON-RPC requests.
 * Each request must include a valid auth token.
 */
export class DaemonPipeServer {
  private server: net.Server | null = null;
  private authToken = '';
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly connectedSockets = new Set<net.Socket>();
  // Clients that asked for pushed events via `daemon.events.subscribe`. Empty
  // by default — see `broadcast`. Dies with the socket, so a reconnecting
  // client must re-subscribe.
  private readonly eventSubscribers = new Set<net.Socket>();
  // Fresh sockets get one bounded chance to identify as the first-party app
  // and subscribe without losing events generated during that handshake. An
  // unrelated first authenticated RPC discards this queue and preserves the
  // opt-in default; once a handshake starts, its retries retain the queue.
  private readonly preSubscribeBacklogs = new Map<net.Socket, PreSubscribeBacklog>();
  // Per-client identity for unicast delivery. Both directions are kept because
  // `sendTo` resolves an id → socket while the RPC path needs socket → id.
  private readonly clientIds = new Map<net.Socket, string>();
  private readonly socketsByClientId = new Map<string, net.Socket>();
  // Clients that claimed the first-party role (see `markFirstParty`). Dies with
  // the socket, so a reconnecting app must re-identify.
  private readonly firstPartyClients = new Set<string>();
  private nextClientId = 1;
  private readonly clientCloseHandlers: ((clientId: string) => void)[] = [];
  private readonly rateLimits = new Map<net.Socket, { count: number; resetAt: number }>();
  private globalRate = { count: 0, resetAt: 0 };
  private connectionRate = { count: 0, resetAt: 0 };

  private static readonly MAX_CONNECTIONS = 20;
  private static readonly GLOBAL_RATE_LIMIT = 200;
  // Per-socket RPC rate limit. The Electron main process holds ONE authenticated
  // socket to the daemon and multiplexes EVERY pane's RPCs through it, so a
  // per-socket cap below the global one just rate-limits the app against itself:
  // a 30-pane boot or workspace-switch storm (resize + reconnect + initial reads
  // per pane in one tick) trivially blew past 50/s, and rejected pty:reconnect
  // calls could leave panes unattached. Raised 50 → 200 to align with
  // GLOBAL_RATE_LIMIT, which still bounds totals; the per-socket cap is redundant
  // DoS protection for a single trusted local client.
  private static readonly PER_SOCKET_RATE_LIMIT = 200;
  private static readonly MAX_NEW_CONNECTIONS_PER_SEC = 20;

  private activePipeName: string;
  private tokenPathOverride: string | null = null;

  // Idle-shutdown bookkeeping. `lastDisconnectAt` is updated whenever the
  // last connected socket closes, i.e. only when `connectedSockets.size`
  // drops to 0. While at least one client is connected the value is left
  // alone — Watchdog reads it together with `getConnectionCount()` so a
  // long-lived main process keeps the daemon alive on its own.
  private lastDisconnectAt: number | null = null;

  constructor(private readonly pipeName: string) {
    this.activePipeName = pipeName;
  }

  /** For testing: redirect the on-disk token file to a temp path. */
  setTokenPathForTest(tokenPath: string): void {
    this.tokenPathOverride = tokenPath;
  }

  /** Get the actual pipe name being used (may differ from requested if fallback occurred). */
  getActivePipeName(): string {
    return this.activePipeName;
  }

  /** Number of currently connected RPC clients. */
  getConnectionCount(): number {
    return this.connectedSockets.size;
  }

  /**
   * Timestamp (ms) of the moment the last connection dropped to zero, or
   * `null` if a client has never connected during this daemon's lifetime.
   * Watchdog uses this together with the daemon's `startTime` to compute
   * an idle window — see `src/daemon/index.ts` idle-shutdown logic.
   */
  getLastDisconnectAt(): number | null {
    return this.lastDisconnectAt;
  }

  /** Load existing auth token from disk, or generate a new one. */
  async loadOrCreateToken(): Promise<string> {
    const tokenPath = this.getTokenPath();
    try {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) {
        this.authToken = existing;
        // RCA A12 — re-harden the ACL on the EXISTING token file. Tokens created
        // by older versions (or carrying broad inherited ACLs) would otherwise
        // remain readable by Administrators/SYSTEM/other local accounts, letting
        // any local process steal the token and drive the daemon RPC surface.
        // Deferred to background (S-A): the sync harden's whoami+PowerShell
        // shell-outs cost 3.5-3.8s here — directly on the launcher-blocked
        // critical path, since loadOrCreateToken runs inside start() before
        // tryListen and before the daemon-pipe file the launcher polls for.
        // The token VALUE is unchanged, so deferring the tightening adds no
        // material exposure (the file sat under the same ACL its whole prior
        // lifetime); the RPC surface is protected by the token value itself.
        // The scheduler is fully async (never *Sync), so the harden cannot
        // stall the freshly-opened control pipe's event loop either.
        scheduleTokenFileReHarden(tokenPath);
        console.log('[lifecycle] daemon auth token loaded from disk — ACL re-harden scheduled (deferred)');
        return this.authToken;
      }
    } catch {
      // file doesn't exist yet
    }

    this.authToken = crypto.randomUUID();
    // Ensure directory exists
    secureWriteTokenFile(tokenPath, this.authToken);
    return this.authToken;
  }

  /** Start listening on the control pipe. */
  async start(): Promise<void> {
    if (this.server) return;

    if (!this.authToken) {
      await this.loadOrCreateToken();
    }

    // On Windows, named pipes can linger as zombie handles after process death.
    // Strategy: try to connect to the existing pipe first. If the connection
    // succeeds, a live process owns it — fall back to a suffixed name.
    // If the connection is refused / reset, the pipe is a zombie — force-
    // release it by briefly connecting+destroying, then retry listen.
    const maxAttempts = process.platform === 'win32' ? 4 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidateName = attempt === 0
        ? this.pipeName
        : `${this.pipeName}-${attempt}`;

      try {
        await this.tryListen(candidateName);
        this.activePipeName = candidateName;
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') {
          throw err;
        }

        // Attempt to reclaim the pipe before falling back. Distinguish a LIVE
        // owner from a genuine zombie: a live owner on the CANONICAL pipe
        // (attempt 0) means we are a redundant second daemon — the split-brain
        // trigger (Defect 3). We must NOT fall back to the `-N` suffix (that
        // produces two live daemons racing for the session pipes); fail fast so
        // the entrypoint exits cleanly and the launcher reconnects to the
        // existing daemon. The `-N` suffix stays only for the genuine-zombie
        // and ambiguous cases.
        if (process.platform === 'win32' && code === 'EADDRINUSE') {
          const outcome = await this.tryReclaimPipe(candidateName);
          if (outcome === 'reclaimed') {
            try {
              await this.tryListen(candidateName);
              this.activePipeName = candidateName;
              return;
            } catch {
              // Reclaim succeeded but listen still failed — fall through
            }
          } else if (outcome === 'live-owner' && attempt === 0) {
            const e = new Error(
              `[daemon] canonical control pipe ${candidateName} is owned by a live daemon — refusing to start a redundant second daemon`,
            ) as NodeJS.ErrnoException;
            e.code = 'EDAEMON_ALREADY_RUNNING';
            throw e;
          }
          // 'unreclaimable', or a live-owner on a `-N` attempt: fall through to
          // the next suffix (legacy behavior for the genuinely ambiguous or
          // multi-daemon-cleanup case).
        }

        if (attempt === maxAttempts - 1) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /**
   * Probe a Windows named pipe to decide whether it can be reclaimed. Returns
   * a three-state outcome (see `classifyReclaimProbe`):
   *   - 'live-owner': connect succeeded → a live process owns it. start() must
   *     yield rather than fall back to a `-N` suffix (the split-brain fix).
   *   - 'reclaimed': connect refused/reset → zombie; the probe released the
   *     last handle, the name is free to retry.
   *   - 'unreclaimable': timeout / unexpected error → ambiguous; neither claim
   *     a live owner nor assume the name is free.
   */
  private tryReclaimPipe(name: string): Promise<ReclaimOutcome> {
    return new Promise((resolve) => {
      const probe = net.connect(name);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(classifyReclaimProbe('timeout'));
      }, 2000);
      timer.unref();

      probe.on('connect', () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(classifyReclaimProbe('connect'));
      });

      probe.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        probe.destroy();
        const outcome = classifyReclaimProbe('error', err.code);
        if (outcome === 'reclaimed') {
          // The connect attempt released the zombie handle — wait briefly for
          // Windows to clean up the pipe name before the caller retries listen.
          setTimeout(() => resolve('reclaimed'), 200);
        } else {
          resolve(outcome);
        }
      });
    });
  }

  /** Try to listen on a specific pipe name. */
  private tryListen(name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Pre-auth connection rate limit: mitigates brute-force on auth token
        // when the pipe DACL itself cannot be restricted (libuv limitation).
        const now = Date.now();
        if (now > this.connectionRate.resetAt) {
          this.connectionRate = { count: 0, resetAt: now + 1000 };
        }
        this.connectionRate.count++;
        if (this.connectionRate.count > DaemonPipeServer.MAX_NEW_CONNECTIONS_PER_SEC) {
          socket.destroy();
          return;
        }

        if (this.connectedSockets.size >= DaemonPipeServer.MAX_CONNECTIONS) {
          socket.destroy();
          return;
        }
        this.connectedSockets.add(socket);
        this.preSubscribeBacklogs.set(socket, {
          frames: [],
          bytes: 0,
          intentDeclared: false,
          expiresAt: Date.now() + PRE_SUBSCRIBE_HANDSHAKE_TTL_MS,
        });
        const clientId = `c${this.nextClientId++}`;
        this.clientIds.set(socket, clientId);
        this.socketsByClientId.set(clientId, socket);
        socket.on('close', () => {
          this.connectedSockets.delete(socket);
          this.eventSubscribers.delete(socket);
          this.preSubscribeBacklogs.delete(socket);
          this.rateLimits.delete(socket);
          this.clientIds.delete(socket);
          this.socketsByClientId.delete(clientId);
          this.firstPartyClients.delete(clientId);
          // Per-client subscriptions must die with the socket; a refcount that
          // outlives a renderer reload leaks whatever the subscription holds.
          for (const handler of this.clientCloseHandlers) {
            try {
              handler(clientId);
            } catch {
              // A subscriber's cleanup must never break the close path.
            }
          }
          // Record the moment we dropped to zero clients so the Watchdog
          // idle-shutdown timer has an anchor. We re-stamp on every drop
          // to zero (not just the first), so a flapping reconnect cycle
          // pushes the deadline forward instead of accumulating idle time.
          if (this.connectedSockets.size === 0) {
            this.lastDisconnectAt = Date.now();
          }
        });
        this.handleConnection(socket);
      });

      server.maxConnections = DaemonPipeServer.MAX_CONNECTIONS;

      server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err);
      });

      // On Unix, remove stale socket file before listening
      if (process.platform !== 'win32') {
        try {
          const stat = fs.lstatSync(name);
          if (stat.isSocket()) {
            fs.unlinkSync(name);
          }
        } catch {
          // File doesn't exist — fine
        }
      }

      server.listen(name, () => {
        this.server = server;
        resolve();
      });
    });
  }

  /** Stop the server and destroy all connections. */
  async stop(): Promise<void> {
    if (!this.server) return;

    for (const socket of this.connectedSockets) {
      socket.destroy();
    }
    this.connectedSockets.clear();
    this.eventSubscribers.clear();
    this.preSubscribeBacklogs.clear();
    this.clientIds.clear();
    this.socketsByClientId.clear();
    this.firstPartyClients.clear();

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        // Clean up Unix socket file
        if (process.platform !== 'win32') {
          try {
            const stat = fs.lstatSync(this.pipeName);
            if (stat.isSocket()) {
              fs.unlinkSync(this.pipeName);
            }
          } catch {
            // File doesn't exist — fine
          }
        }
        resolve();
      });
      this.server = null;
    });
  }

  /** Register a handler for an RPC method. */
  onRpc(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  /** Return the current auth token. */
  getAuthToken(): string {
    return this.authToken;
  }

  /** For testing: set token directly without file I/O. */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Rotate the daemon auth token. Drops all currently connected clients and
   * rewrites the token file. Used to respond to suspected token leakage —
   * any attacker holding the old token is immediately locked out.
   */
  rotateToken(): string {
    const newToken = crypto.randomUUID();
    secureWriteTokenFile(this.getTokenPath(), newToken);
    this.authToken = newToken;
    for (const socket of this.connectedSockets) {
      socket.destroy();
    }
    this.connectedSockets.clear();
    this.eventSubscribers.clear();
    this.preSubscribeBacklogs.clear();
    this.clientIds.clear();
    this.socketsByClientId.clear();
    this.firstPartyClients.clear();
    this.rateLimits.clear();
    // Forced drop-to-zero — keep idle-window accounting consistent.
    this.lastDisconnectAt = Date.now();
    return newToken;
  }

  /**
   * Push an event to every client that subscribed, as a newline-delimited JSON
   * message.
   *
   * Events are OPT-IN (`daemon.events.subscribe`). They used to go to every
   * connected socket the moment it connected, which made the obvious client —
   * write a request, read one line back — intermittently read a pushed event
   * instead of its reply. An event frame carries no `ok`/`error`, so such a
   * client reported a failure with an EMPTY error message and then discarded
   * the real reply when it arrived: a fabricated failure that looks like the
   * daemon misbehaving rather than a client bug (issue #659). Correlating on
   * `id` is still required of subscribers (docs/PROTOCOL.md §2.9) — but a
   * client that never asks for events can no longer be hit by this at all,
   * which is the safer default.
   */
  broadcast(event: unknown): void {
    const msg = JSON.stringify(event) + '\n';

    // A newly accepted app socket subscribes and identifies. Queue only through
    // that bounded handshake; ordinary RPC clients discard the queue with their
    // first non-handshake request and never receive these frames.
    if (this.preSubscribeBacklogs.size > 0) {
      const msgBytes = Buffer.byteLength(msg);
      this.preSubscribeBacklogs.forEach((backlog, socket) => {
        if (socket.destroyed) return;
        if (Date.now() >= backlog.expiresAt) {
          // An incomplete handshake must not retain events for the lifetime of
          // an otherwise usable RPC socket. Expiry degrades to live-only
          // delivery if the client eventually subscribes; it does not flap the
          // connection merely because an old app never completed the handshake.
          this.preSubscribeBacklogs.delete(socket);
          return;
        }
        if (backlog.bytes + msgBytes > PRE_SUBSCRIBE_BACKLOG_BYTES) {
          this.preSubscribeBacklogs.delete(socket);
          // Before subscribe declares intent this is only an opportunistic
          // accept-window buffer. Drop it without disrupting an idle RPC client.
          // Once intent is declared, however, continuing would let a later
          // retry report success after silently losing retained events.
          if (!backlog.intentDeclared) return;
          const clientId = this.clientIds.get(socket) ?? 'unknown';
          console.warn(
            `[DaemonPipeServer] closing event subscriber handshake ${clientId}: `
            + `pre-subscribe backlog exceeds ${PRE_SUBSCRIBE_BACKLOG_BYTES} bytes`,
          );
          socket.destroy();
          return;
        }
        backlog.frames.push(msg);
        backlog.bytes += msgBytes;
      });
    }

    this.eventSubscribers.forEach((socket) => {
      if (!socket.destroyed) {
        if (socket.writableLength > SUBSCRIBER_BACKPRESSURE_BYTES) {
          this.eventSubscribers.delete(socket);
          const clientId = this.clientIds.get(socket) ?? 'unknown';
          console.warn(
            `[DaemonPipeServer] dropping stalled event subscriber ${clientId}: `
            + `${socket.writableLength} buffered bytes exceeds ${SUBSCRIBER_BACKPRESSURE_BYTES}`,
          );
          return;
        }
        try {
          socket.write(msg);
        } catch {
          // ignore write errors on individual sockets
        }
      }
    });
  }

  // Suffix-aware daemon token path (single source of truth in shared/constants).
  // The daemon WRITER deliberately never falls back to the legacy unsuffixed
  // path — a suffixed ('-dev'/dogfood) instance must mint its OWN token instead
  // of adopting production's, which is the whole point of the isolation.
  private getTokenPath(): string {
    if (this.tokenPathOverride) return this.tokenPathOverride;
    return getDaemonAuthTokenPath();
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      // Security: prevent OOM from clients that never send newlines
      if (buffer.length > MAX_LINE_BUFFER) {
        socket.destroy();
        return;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.processLine(socket, trimmed);
      }
    });

    socket.on('end', () => {
      const trimmed = buffer.trim();
      if (trimmed) {
        this.processLine(socket, trimmed);
      }
      buffer = '';
    });

    socket.on('error', () => {
      socket.destroy();
    });
  }

  private processLine(socket: net.Socket, line: string): void {
    let request: RpcRequest;

    try {
      request = JSON.parse(line, (key, value) => {
        // Proto pollution prevention
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      }) as RpcRequest;
    } catch {
      const errorResponse = JSON.stringify({ id: null, ok: false, error: 'Invalid JSON' });
      socket.write(errorResponse + '\n');
      return;
    }

    // Authenticate before rate limit check (prevents DoS via rate exhaustion)
    // Use timing-safe comparison to prevent timing attacks
    const tokenBuf = Buffer.from(request.token || '');
    const authBuf = Buffer.from(this.authToken);
    if (tokenBuf.length !== authBuf.length || !crypto.timingSafeEqual(tokenBuf, authBuf)) {
      const res = JSON.stringify({ id: request.id, ok: false, error: 'unauthorized' });
      socket.write(res + '\n');
      // Close the socket so brute-force must pay the per-second connection cap
      // for every new token attempt instead of spamming a single long-lived socket.
      socket.destroy();
      return;
    }

    // The backlog exists only to close the app's subscribe/identify handshake.
    // Subscribe commits this socket to completing that flow for a bounded time:
    // keep retained events through a refusal, identity, retries, and intervening
    // ordinary RPCs. This is required for old apps, which send subscribe first
    // but identify later from installation code. A socket whose first request
    // is unrelated remains an ordinary reply-only client and discards the queue.
    const now = Date.now();
    const method = String(request.method);
    const startsEventHandshake = method === 'daemon.events.subscribe';
    const backlog = this.preSubscribeBacklogs.get(socket);
    if (backlog) {
      if (now >= backlog.expiresAt) {
        this.preSubscribeBacklogs.delete(socket);
      } else if (startsEventHandshake) {
        backlog.intentDeclared = true;
      } else if (!backlog.intentDeclared) {
        // Identity-first callers are compatible but do not preserve the accept
        // window: only subscribe declares event-delivery intent. Subscribe-first
        // clients retain the backlog across their later identify and any RPCs
        // installed between those two calls.
        this.preSubscribeBacklogs.delete(socket);
      }
    }

    // Global rate limit
    if (now > this.globalRate.resetAt) {
      this.globalRate = { count: 0, resetAt: now + 1000 };
    }
    this.globalRate.count++;
    if (this.globalRate.count > DaemonPipeServer.GLOBAL_RATE_LIMIT) {
      const res = JSON.stringify({ id: request.id, ok: false, error: 'rate limited (global)' });
      socket.write(res + '\n');
      return;
    }

    // Per-socket rate limit
    let limit = this.rateLimits.get(socket);
    if (!limit || now > limit.resetAt) {
      limit = { count: 0, resetAt: now + 1000 };
      this.rateLimits.set(socket, limit);
    }
    limit.count++;
    if (limit.count > DaemonPipeServer.PER_SOCKET_RATE_LIMIT) {
      const res = JSON.stringify({ id: request.id, ok: false, error: 'rate limited' });
      socket.write(res + '\n');
      return;
    }

    // Dispatch to handler
    this.dispatch(request, this.clientIds.get(socket) ?? '')
      .then((response) => {
        if (!socket.destroyed) {
          socket.write(JSON.stringify(response) + '\n');
        }
      })
      .catch(() => {
        if (!socket.destroyed) {
          const res = JSON.stringify({ id: request.id, ok: false, error: 'Internal server error' });
          socket.write(res + '\n');
        }
      });
  }

  /**
   * Deliver an event to ONE client. Returns false when that client is gone.
   *
   * The counterpart to `broadcast` for per-subscriber payloads: a transcript
   * append carries the pane's full conversation content, which must not reach
   * clients that never subscribed to it — and keeping it off those sockets also
   * keeps one oversized payload from pushing an unrelated client's control
   * buffer past its cap.
   */
  sendTo(clientId: string, event: unknown): boolean {
    const socket = this.socketsByClientId.get(clientId);
    if (!socket || socket.destroyed) return false;
    // Refuse rather than queue once this client is behind. See
    // SUBSCRIBER_BACKPRESSURE_BYTES: the caller drops the subscription on false,
    // which is the only bound Node's writable buffer gives us.
    if (socket.writableLength > SUBSCRIBER_BACKPRESSURE_BYTES) return false;
    try {
      socket.write(JSON.stringify(event) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mark this client as the first-party app process (the Electron main process).
   *
   * The control pipe has exactly one credential — the daemon auth token — and
   * every client that can read the token file presents the same one, so this is
   * a CLASSIFICATION, not an authentication: it separates the app's own socket
   * from the CLI/MCP sockets that never claim the role. That is enough for the
   * transcript RPCs, whose threat model is "an MCP tool wired into some other
   * agent should not be able to read a pane's whole conversation by accident or
   * by prompt injection" — not "a local attacker who already stole the token".
   * A token holder that lies here gains exactly what a token holder already had
   * before this method existed.
   */
  markFirstParty(clientId: string): void {
    if (clientId) this.firstPartyClients.add(clientId);
  }

  /** Did this client claim the first-party role? See `markFirstParty`. */
  isFirstParty(clientId: string): boolean {
    return this.firstPartyClients.has(clientId);
  }

  /**
   * Start delivering pushed events to an identified first-party client.
   * Returns false when the client is unclassified or already gone.
   *
   * `markFirstParty` is a classification over the shared control-pipe token,
   * not a second authentication boundary. Requiring it still removes the
   * accidental and prompt-injection path where the CLI or MCP server could
   * subscribe to workspace-bearing events simply because they hold the token.
   */
  subscribeEvents(clientId: string): boolean {
    if (!this.isFirstParty(clientId)) return false;
    const socket = this.socketsByClientId.get(clientId);
    if (!socket || socket.destroyed) return false;
    let backlog = this.preSubscribeBacklogs.get(socket);
    if (backlog && Date.now() >= backlog.expiresAt) {
      this.preSubscribeBacklogs.delete(socket);
      backlog = undefined;
    }
    // Flush before the subscribe reply is written by processLine. Subscribers
    // already have to correlate RPC ids with interleaved id-less event frames;
    // preserving this order makes every accepted-window event observable once.
    for (const frame of backlog?.frames ?? []) {
      if (socket.destroyed || socket.writableLength > SUBSCRIBER_BACKPRESSURE_BYTES) {
        // Returning false and retrying on this socket would delete the retained
        // tail and later report success. Close instead so the app reconnects and
        // rehydrates after a complete, explicit loss boundary.
        this.preSubscribeBacklogs.delete(socket);
        console.warn(
          `[DaemonPipeServer] closing stalled event subscriber handshake ${clientId}: `
          + `${socket.writableLength} buffered bytes exceeds ${SUBSCRIBER_BACKPRESSURE_BYTES}`,
        );
        socket.destroy();
        return false;
      }
      try {
        socket.write(frame);
      } catch {
        this.preSubscribeBacklogs.delete(socket);
        console.warn(
          `[DaemonPipeServer] closing event subscriber handshake ${clientId}: `
          + 'failed while flushing retained events',
        );
        socket.destroy();
        return false;
      }
    }
    this.preSubscribeBacklogs.delete(socket);
    this.eventSubscribers.add(socket);
    return true;
  }

  /**
   * Stop delivering pushed events and cancel any pending subscribe handshake.
   * Idempotent: an explicit unsubscribe also discards accept-window events
   * retained before the client completed its first-party classification.
   */
  unsubscribeEvents(clientId: string): void {
    const socket = this.socketsByClientId.get(clientId);
    if (socket) {
      this.eventSubscribers.delete(socket);
      this.preSubscribeBacklogs.delete(socket);
    }
  }

  /** Is this client receiving pushed events? */
  isEventSubscriber(clientId: string): boolean {
    const socket = this.socketsByClientId.get(clientId);
    return socket !== undefined && this.eventSubscribers.has(socket);
  }

  /**
   * Register a callback for "this client's socket closed". Used to drop
   * per-client state (subscriptions) that a bare refcount would leak.
   */
  onClientClose(handler: (clientId: string) => void): void {
    this.clientCloseHandlers.push(handler);
  }

  private async dispatch(request: RpcRequest, clientId: string): Promise<RpcResponse> {
    if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
      return { id: request?.id || '', ok: false, error: 'Invalid RPC request: missing id or method' };
    }
    if (request.params !== undefined && (typeof request.params !== 'object' || request.params === null)) {
      return { id: request.id, ok: false, error: 'Invalid RPC request: params must be an object' };
    }

    const handler = this.handlers.get(request.method);
    if (!handler) {
      return { id: request.id, ok: false, error: `Unknown method: ${request.method}` };
    }

    try {
      const result = await handler(request.params ?? {}, { clientId });
      return { id: request.id, ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: request.id, ok: false, error: message };
    }
  }
}
