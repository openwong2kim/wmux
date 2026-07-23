import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonSessionManager } from '../DaemonSessionManager';

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
    this.deps.log(
      'info',
      `[web] listening on ${options.host}:${options.port} (input ${options.allowInput ? 'ENABLED' : 'read-only'})`,
    );
    return this.status();
  }

  /** Stop the server, end every SSE stream, and drop all bridge listeners. */
  async stop(): Promise<{ stopped: boolean }> {
    if (!this.server) return { stopped: false };

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
    };
  }

  // --- request routing ---------------------------------------------------

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    // Static, unauthenticated app shell (no secrets live in these).
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
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

    // Everything under /api/* is token-gated.
    if (p.startsWith('/api/')) {
      if (!this.isAuthed(req, url)) {
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
  }> {
    return this.deps.sessionManager.listLiveSessions().map((s) => ({
      id: s.id,
      cwd: s.cwd,
      cols: s.cols,
      rows: s.rows,
      state: s.state,
      agent: s.agent?.displayName ?? s.lastDetectedAgent ?? null,
      lastActivity: s.lastActivity,
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

  // --- helpers ------------------------------------------------------------

  private isAuthed(req: http.IncomingMessage, url: URL): boolean {
    if (!this.token) return false;
    const fromQuery = url.searchParams.get('token');
    const header = req.headers['authorization'];
    const fromHeader = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : null;
    const supplied = fromQuery ?? fromHeader ?? '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private serveStatic(
    res: http.ServerResponse,
    body: Buffer | null,
    contentType: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    if (!body) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('wmux web assets not built — run `npm run build:daemon-web`.');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, ...extraHeaders });
    res.end(body);
  }

  private json(res: http.ServerResponse, status: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
