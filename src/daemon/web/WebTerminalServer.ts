import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonSessionManager } from '../DaemonSessionManager';
import { ENV_KEYS } from '../../shared/constants';

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
 *   - A FRESH random web token is minted per start; the daemon master token
 *     never touches the network. Every `/api/*` call is checked timing-safe.
 *   - Input is impossible unless the server was started with `allowInput`
 *     (execute-impossible stays the default — the operator opts in explicitly).
 */

export interface WebTerminalStartOptions {
  port: number;
  host: string;
  allowInput: boolean;
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
}

interface WebTerminalServerDeps {
  sessionManager: DaemonSessionManager;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Directory holding the built frontend assets (terminal.html, manifest,
   * sw.js, icons). Resolved by the caller relative to the daemon bundle so it
   * works in both dev (`dist/daemon-web`) and packaged
   * (`resources/daemon-web`) layouts.
   */
  assetsDir: string;
}

/** Cap a single input POST body so a hostile client cannot exhaust memory. */
const MAX_INPUT_BYTES = 64 * 1024;
/** SSE heartbeat — keeps the connection alive through idle proxies. */
const HEARTBEAT_MS = 25_000;
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

interface SseClient {
  res: http.ServerResponse;
  sessionId: string;
  detach: () => void;
}

export class WebTerminalServer {
  private server: http.Server | null = null;
  private token = '';
  private opts: WebTerminalStartOptions | null = null;
  private readonly clients = new Set<SseClient>();

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

  // Bound so on()/off() reference the SAME listener across start()/stop().
  private readonly onSessionCritical = (payload: { sessionId: string; event?: unknown }): void =>
    this.broadcastEvent('critical', payload);
  private readonly onSessionNotification = (payload: { sessionId: string; event?: unknown }): void =>
    this.broadcastEvent('notify', payload);

  // Static assets, loaded once on start and cached in memory (all small).
  private terminalHtml: Buffer | null = null;
  private manifest: Buffer | null = null;
  private serviceWorker: Buffer | null = null;
  private icon: Buffer | null = null;

  constructor(private readonly deps: WebTerminalServerDeps) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Start (or restart) the web server. A running server is stopped first so a
   * second `wmux web --allow-input` cleanly re-applies options; the web token
   * rotates on every start.
   */
  async start(options: WebTerminalStartOptions): Promise<WebTerminalInfo> {
    if (this.server) {
      await this.stop();
    }
    this.loadAssets();
    this.token = crypto.randomUUID();
    this.opts = options;
    this.generatePairCode();

    // Tee fleet-wide attention signals into EVERY connected SSE client — a
    // viewer watching pane A must still hear that pane B needs an answer. These
    // are attached once here and removed in stop() so restarts rotate cleanly.
    this.deps.sessionManager.on('session:critical', this.onSessionCritical);
    this.deps.sessionManager.on('session:notification', this.onSessionNotification);

    const server = http.createServer((req, res) => {
      // Never let a handler error escape into the daemon event loop.
      try {
        this.handle(req, res);
      } catch (err) {
        this.deps.log('warn', `[web] request handler threw: ${errMsg(err)}`);
        try {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        } catch {
          /* socket already gone */
        }
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
    this.pairCode = '';
    this.pairExpiresAt = 0;
    this.pairAttempts = 0;

    for (const client of this.clients) {
      try {
        client.detach();
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();

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

  status(): WebTerminalInfo {
    if (!this.server || !this.opts) return { running: false };
    return {
      running: true,
      port: this.opts.port,
      host: this.opts.host,
      allowInput: this.opts.allowInput,
      token: this.token,
      urls: this.buildUrls(),
      clients: this.clients.size,
      pairCode: this.pairCode || undefined,
      pairExpiresAt: this.pairCode ? this.pairExpiresAt : undefined,
    };
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
      return this.serveStatic(res, this.terminalHtml, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      return this.serveStatic(res, this.manifest, 'application/manifest+json; charset=utf-8');
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
      return this.handlePair(res, url);
    }

    // Everything under /api/* is token-gated. Only the SSE stream may carry the
    // token in the query string (EventSource cannot set headers); every other
    // endpoint requires an Authorization: Bearer header, keeping the token out
    // of query strings and URL/proxy logs.
    if (p.startsWith('/api/')) {
      const isStream = req.method === 'GET' && p === '/api/stream';
      if (!this.isAuthed(req, url, isStream)) {
        return this.json(res, 401, { error: 'unauthorized' });
      }
      if (req.method === 'GET' && p === '/api/config') {
        return this.json(res, 200, { allowInput: this.opts?.allowInput === true });
      }
      if (req.method === 'GET' && p === '/api/sessions') {
        return this.json(res, 200, { sessions: this.listSessions() });
      }
      if (req.method === 'GET' && p === '/api/stream') {
        return this.handleStream(req, res, url);
      }
      if (req.method === 'POST' && p === '/api/input') {
        return this.handleInput(req, res, url);
      }
      return this.json(res, 404, { error: 'not found' });
    }

    res.writeHead(404);
    res.end();
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

  private handleStream(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
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
    });

    // Initial paint: the exact bytes SessionPipe flushes to the GUI on attach.
    const meta = { cols: managed.meta.cols, rows: managed.meta.rows };
    writeSse(res, 'meta', JSON.stringify(meta));
    const snapshot = managed.ringBuffer.readAll();
    writeSse(res, 'snapshot', snapshot.toString('base64'));

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

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    const detach = (): void => {
      clearInterval(heartbeat);
      bridge.removeListener('data', onData);
      bridge.removeListener('exit', onExit);
    };
    const client: SseClient = { res, sessionId, detach };
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

  // --- fleet-wide event tee -----------------------------------------------

  /**
   * Fan a session-manager attention event out to EVERY connected SSE client,
   * regardless of which session that client's stream watches. The wire payload
   * flattens the event so the frontend sees `{sessionId, ...event}`.
   */
  private broadcastEvent(kind: 'critical' | 'notify', payload: { sessionId: string; event?: unknown }): void {
    if (!payload || typeof payload !== 'object') return;
    const event = payload.event && typeof payload.event === 'object' ? (payload.event as Record<string, unknown>) : {};
    const body = JSON.stringify({ sessionId: payload.sessionId, ...event });
    for (const client of this.clients) {
      try {
        writeSse(client.res, kind, body);
      } catch {
        /* client stream broken — its own 'close' handler cleans up */
      }
    }
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
   * Exchange a pairing code for the web token. Correct code → `{token}` and the
   * code is immediately invalidated (single use). Wrong/expired → 403; a wrong
   * code decrements the attempt budget and burns the code when it hits zero.
   */
  private handlePair(res: http.ServerResponse, url: URL): void {
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

    const a = Buffer.from(supplied);
    const b = Buffer.from(this.pairCode);
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!match) {
      this.pairAttempts -= 1;
      if (this.pairAttempts <= 0) this.pairCode = '';
      return this.json(res, 403, {
        error: 'invalid code',
        attemptsLeft: Math.max(0, this.pairAttempts),
      });
    }

    // Success: hand over the token exactly once, then burn the code.
    const token = this.token;
    this.pairCode = '';
    this.pairExpiresAt = 0;
    this.pairAttempts = 0;
    return this.json(res, 200, { token });
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Authenticate an /api/* request against the per-start web token (timing-safe).
   * `allowQuery` is true ONLY for the SSE stream, which must accept `?token=`
   * because EventSource cannot set headers; every other endpoint is Bearer-only.
   */
  private isAuthed(req: http.IncomingMessage, url: URL, allowQuery: boolean): boolean {
    if (!this.token) return false;
    const header = req.headers['authorization'];
    const fromHeader = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : null;
    const fromQuery = allowQuery ? url.searchParams.get('token') : null;
    const supplied = fromHeader ?? fromQuery ?? '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Baseline headers every response carries — the hardening a local HTTP server
   * owes the browser (the same controls Docker / VS Code / Electron apply):
   *   - frame protection, so a page on evil.com cannot iframe this authenticated
   *     terminal and redress clicks into a pane (worse with `--allow-input`);
   *   - `nosniff`, so nothing is re-interpreted as an executable type;
   *   - `no-referrer`, which also keeps the SSE URL's `?token=` (the one route
   *     that must carry it) out of any outbound Referer.
   */
  private securityHeaders(): Record<string, string> {
    return {
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
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
    return [`http://${host}${suffix}`];
  }

  private loadAssets(): void {
    const dir = this.deps.assetsDir;
    this.terminalHtml = readIfExists(path.join(dir, 'terminal.html'));
    this.manifest = readIfExists(path.join(dir, 'manifest.webmanifest'));
    this.serviceWorker = readIfExists(path.join(dir, 'sw.js'));
    this.icon = readIfExists(path.join(dir, 'icon-512.png'));
    if (!this.terminalHtml) {
      this.deps.log('warn', `[web] terminal.html missing under ${dir} — run \`npm run build:daemon-web\``);
    }
  }
}

// === module helpers =========================================================

function writeSse(res: http.ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
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
