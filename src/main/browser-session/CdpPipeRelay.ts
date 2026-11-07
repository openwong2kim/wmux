import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CallerIdentity, CdpPipeMux } from './CdpPipeMux';
import { CdpRelayTokens } from './CdpRelayTokens';
import {
  makeRelaySocketDir,
  relaySocketIntact,
  relaySocketRoots,
  removeRelaySocketDir,
  sweepDeadRelayDirs,
  verifyRelaySocket,
  type RelaySocketDir,
  type RelaySocketId,
} from './relaySocket';

// ---------------------------------------------------------------------------
// The one endpoint external clients (the MCP lane's Playwright) dial for every
// Chrome on a debugging pipe. A client connects with a one-time token that
// browser.cdp.info minted for it over the authenticated wmux pipe; the token
// says which Chrome it reaches and who it connects as.
//  - A Unix socket in a private temp dir where one can be made (relaySocket),
//    else loopback TCP; started on the first token, not before.
//  - WebSocket upgrades at one exact path only; no HTTP routes.
//  - Each upgrade is checked in order: method and path (404), any Origin
//    (403), on TCP the Host and the peer (403), the bearer token (401), then
//    whether its Chrome is still there and has room (503). Only then is the
//    token spent, in the same tick as the upgrade, so a refusal for room
//    leaves it usable.
//  - No per-message compression, a header timeout, a cap on connections per
//    Chrome, and a cap on what may wait to be sent to one client.
//  - Before each token is handed out, a socket that is gone or was replaced is
//    bound afresh; connections already made stay.
// Neither tokens nor the endpoint are logged.
// ---------------------------------------------------------------------------

export const RELAY_PATH = '/devtools/browser/relay';
export const RELAY_MAX_CLIENTS_PER_CHROME = 8;
/** Above the largest frame expected (a ~20 MiB full-page screenshot), with room. */
export const RELAY_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** A client's own frames are commands: small, but a script to evaluate can be large. */
const MAX_INBOUND_BYTES = 32 * 1024 * 1024;
const HEADER_TIMEOUT_MS = 5_000;
/** Connections not yet upgraded the listener takes on top of every Chrome's cap. */
const PRE_AUTH_ROOM = 8;
/** Said once when a platform with Unix sockets has to serve on TCP. Names no endpoint, port, path or token. */
export const RELAY_TCP_FALLBACK_LINE = '[CdpPipeRelay] no private socket dir; serving on loopback TCP';

/** What browser.cdp.info hands a caller: where to connect, and the header that lets it. */
export interface RelayGrant {
  readonly endpoint: string;
  readonly headers: { readonly Authorization: string };
}

export interface RelayOptions {
  /** Temp roots to try for the socket, in order; none means loopback TCP. */
  roots?: string[];
  maxClientsPerChrome?: number;
  maxBufferedBytes?: number;
  headerTimeoutMs?: number;
}

interface Listener {
  readonly server: Server;
  readonly endpoint: string;
  /** TCP: the only Host header accepted. Null on a Unix socket. */
  readonly tcpHost: string | null;
  readonly socket: { readonly place: RelaySocketDir; readonly id: RelaySocketId } | null;
}

interface Binding {
  readonly route: RelayRoute;
  readonly identity: CallerIdentity;
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function refuse(socket: Duplex, status: string): void {
  // Destroyed once the answer is written out, not before it is.
  socket.once('finish', () => socket.destroy());
  socket.once('error', () => socket.destroy());
  try {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header ?? '');
  return match ? match[1] : null;
}

/** One Chrome the relay serves. */
export class RelayRoute {
  readonly clients = new Set<WebSocket>();
  /** Upgrades accepted and still in their handshake: they count against the cap. */
  handshaking = 0;
  closed = false;

  constructor(readonly mux: CdpPipeMux, private readonly relay: CdpPipeRelay) {}

  get open(): boolean {
    return !this.closed && this.mux.isOpen();
  }

  /** A token for `identity` to connect to this Chrome with. */
  grant(identity: CallerIdentity): Promise<RelayGrant> {
    return this.relay.grant(this, identity);
  }

  /** This Chrome is gone: its clients are disconnected and its unused tokens dropped. */
  close(): void {
    this.relay.drop(this);
  }
}

export class CdpPipeRelay {
  private readonly tokens = new CdpRelayTokens<Binding>();
  private readonly routes = new Set<RelayRoute>();
  private readonly wss: WebSocketServer;
  private readonly roots: string[];
  private readonly maxClients: number;
  private readonly maxBuffered: number;
  private readonly headerTimeoutMs: number;
  private listener: Listener | null = null;
  private binding: Promise<Listener> | null = null;
  private swept = false;
  /** The background sweep of dirs left by processes that are gone (tests wait on it). */
  sweeping: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: RelayOptions = {}) {
    this.roots = opts.roots ?? relaySocketRoots();
    this.maxClients = opts.maxClientsPerChrome ?? RELAY_MAX_CLIENTS_PER_CHROME;
    this.maxBuffered = opts.maxBufferedBytes ?? RELAY_MAX_BUFFERED_BYTES;
    this.headerTimeoutMs = opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_INBOUND_BYTES, clientTracking: false });
  }

  /** Serve `mux`'s Chrome; close the route when that Chrome goes. */
  serve(mux: CdpPipeMux): RelayRoute {
    if (this.closed) throw new Error('CdpPipeRelay: closed');
    const route = new RelayRoute(mux, this);
    this.routes.add(route);
    this.sizeListener();
    return route;
  }

  /** @internal RelayRoute.grant */
  async grant(route: RelayRoute, identity: CallerIdentity): Promise<RelayGrant> {
    if (this.closed || !route.open) throw new Error('CdpPipeRelay: that Chrome is gone');
    const listener = await this.live();
    if (this.closed || !route.open) throw new Error('CdpPipeRelay: that Chrome is gone');
    const token = this.tokens.mint({ route, identity });
    return { endpoint: listener.endpoint, headers: { Authorization: `Bearer ${token}` } };
  }

  /** @internal RelayRoute.close */
  drop(route: RelayRoute): void {
    if (route.closed) return;
    route.closed = true;
    this.routes.delete(route);
    this.tokens.forget((binding) => binding.route === route);
    for (const ws of route.clients) ws.terminate();
    route.clients.clear();
    this.sizeListener();
  }

  /** Disconnect every client, stop listening and remove the socket dir. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const route of [...this.routes]) this.drop(route);
    this.wss.close();
    const binding = this.binding;
    if (binding) await binding.catch(() => undefined);
    await this.sweeping;
    const listener = this.listener;
    this.listener = null;
    if (listener) await this.retire(listener, true);
  }

  /** The current listener, bound afresh when its socket is gone or was replaced. One bind at a time. */
  private live(): Promise<Listener> {
    const current = this.listener;
    if (current && this.intact(current)) return Promise.resolve(current);
    if (!this.binding) {
      const binding = this.rebind();
      this.binding = binding;
      const clear = () => { if (this.binding === binding) this.binding = null; };
      binding.then(clear, clear);
    }
    return this.binding;
  }

  private intact(listener: Listener): boolean {
    if (!listener.server.listening) return false;
    return listener.socket === null || relaySocketIntact(listener.socket.place.socketPath, listener.socket.id);
  }

  private async rebind(): Promise<Listener> {
    const stale = this.listener;
    this.listener = null;
    if (stale) void this.retire(stale, false);
    if (!this.swept) {
      // In the background: the first token does not wait on probing leftovers.
      // A dir this process makes names its own pid, so the sweep never takes it.
      this.swept = true;
      this.sweeping = Promise.all(this.roots.map((root) => sweepDeadRelayDirs(root))).then(() => undefined, () => undefined);
    }
    const listener = await this.listen();
    if (this.closed) {
      await this.retire(listener, true);
      throw new Error('CdpPipeRelay: closed');
    }
    this.listener = listener;
    this.sizeListener();
    return listener;
  }

  /** Stop accepting on `listener`; its upgraded connections stay unless `all`. */
  private async retire(listener: Listener, all: boolean): Promise<void> {
    const done = new Promise<void>((resolve) => listener.server.close(() => resolve()));
    if (all) listener.server.closeAllConnections();
    else listener.server.closeIdleConnections();
    if (listener.socket) removeRelaySocketDir(listener.socket.place.dir);
    if (all) await done;
  }

  private async listen(): Promise<Listener> {
    for (const root of this.roots) {
      const place = makeRelaySocketDir(root);
      if (!place) continue;
      const server = this.makeServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(place.socketPath, () => { server.off('error', reject); resolve(); });
        });
        // The socket is created with the process umask: close it to everyone else.
        fs.chmodSync(place.socketPath, 0o600);
        const id = verifyRelaySocket(place);
        if (!id) throw new Error('relay socket is not private');
        return this.attach(server, { endpoint: `ws+unix://${place.socketPath}:${RELAY_PATH}`, tcpHost: null, socket: { place, id } });
      } catch {
        server.close();
        removeRelaySocketDir(place.dir);
      }
    }
    // Windows serves on TCP by design; elsewhere it means no root could hold a private socket.
    if (process.platform !== 'win32') console.warn(RELAY_TCP_FALLBACK_LINE);
    const server = this.makeServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const { port } = server.address() as AddressInfo;
    return this.attach(server, { endpoint: `ws://127.0.0.1:${port}${RELAY_PATH}`, tcpHost: `127.0.0.1:${port}`, socket: null });
  }

  private makeServer(): Server {
    const server = createServer((_req, res) => {
      // No HTTP routes: only the upgrade is served.
      res.writeHead(404, { Connection: 'close' });
      res.end();
    });
    server.headersTimeout = this.headerTimeoutMs;
    server.requestTimeout = this.headerTimeoutMs * 2;
    // A connection that never finishes its handshake is dropped (an upgraded one clears this).
    server.on('connection', (socket) => socket.setTimeout(this.headerTimeoutMs, () => socket.destroy()));
    // A client that sends something that is not HTTP is dropped.
    server.on('clientError', (_err, socket) => socket.destroy());
    return server;
  }

  private attach(server: Server, fields: Omit<Listener, 'server'>): Listener {
    const listener: Listener = { server, ...fields };
    // From here on a server error is logged, never thrown at main. Never with the endpoint.
    server.on('error', (err) => console.warn('[CdpPipeRelay] server error:', err.message));
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(listener, req, socket, head));
    return listener;
  }

  private sizeListener(): void {
    const listener = this.listener;
    if (listener) listener.server.maxConnections = this.maxClients * this.routes.size + PRE_AUTH_ROOM;
  }

  private upgrade(listener: Listener, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closed) { refuse(socket, '503 Service Unavailable'); return; }
    if (req.method !== 'GET' || req.url !== RELAY_PATH) { refuse(socket, '404 Not Found'); return; }
    if (req.headers.origin !== undefined) { refuse(socket, '403 Forbidden'); return; }
    if (listener.tcpHost !== null && (req.headers.host !== listener.tcpHost || !isLoopback(req.socket.remoteAddress))) {
      refuse(socket, '403 Forbidden');
      return;
    }
    const presented = bearer(req.headers.authorization);
    const ticket = presented === null ? null : this.tokens.lookup(presented);
    if (!ticket) { refuse(socket, '401 Unauthorized'); return; }
    const { route, identity } = ticket.binding;
    if (!route.open || route.clients.size + route.handshaking >= this.maxClients) { refuse(socket, '503 Service Unavailable'); return; }
    if (!this.tokens.consume(ticket)) { refuse(socket, '401 Unauthorized'); return; }
    route.handshaking++;
    let settled = false;
    const settle = () => {
      if (!settled) route.handshaking--;
      settled = true;
    };
    // A handshake that fails closes the socket without calling back.
    socket.once('close', settle);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      settle();
      this.accept(route, identity, ws);
    });
  }

  private accept(route: RelayRoute, identity: CallerIdentity, ws: WebSocket): void {
    // The Chrome may have gone during the handshake.
    if (this.closed || !route.open) { ws.terminate(); return; }
    route.clients.add(ws);
    const maxBuffered = this.maxBuffered;
    let sent = 0;
    const client = route.mux.attachExternal('relay', (text) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(text);
      sent += Buffer.byteLength(text);
      // A client that stopped reading: disconnect it instead of buffering on.
      if (ws.bufferedAmount > maxBuffered) ws.terminate();
    }, () => ws.close(), {
      // Signs of life for the stall watch (C2c): the client's WebSocket answers
      // a ping, and reading down a backlog moves `flushed`.
      ping: () => { if (ws.readyState === ws.OPEN) ws.ping(); },
      drain: () => ({ buffered: ws.bufferedAmount, flushed: sent - ws.bufferedAmount }),
      identity,
    });
    ws.on('pong', () => client.pong());
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // CDP is text
      client.receive(data.toString());
    });
    ws.on('close', () => {
      route.clients.delete(ws);
      client.close();
    });
    ws.on('error', () => ws.terminate());
  }
}
