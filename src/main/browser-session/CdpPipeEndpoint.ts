import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CdpPipeMux } from './CdpPipeMux';

// ---------------------------------------------------------------------------
// The browser endpoint external clients (the MCP lane's Playwright) dial for a
// Chrome on a debugging pipe: a loopback WebSocket whose connections become
// clients of the pipe's multiplexer. To be replaced by C3's relay, which adds a
// token and per-connection identity; until then it is as exposed as the
// DevTools port it stands in for, and narrower:
//  - loopback only, on an ephemeral port, at a crypto-random path;
//  - WebSocket upgrades only: no HTTP routes (no /json), every other request
//    refused;
//  - any Origin header refused (a browser page would send one);
//  - no per-message compression, a header timeout, a cap on connections, and
//    a cap on what may wait to be sent to one client: a client that stops
//    reading is disconnected rather than buffered without end.
// The URL is never logged; browser.cdp.info, behind its disclosure gate, is
// the only place it is handed out.
// ---------------------------------------------------------------------------

export const ENDPOINT_MAX_CLIENTS = 8;
/** Above the largest frame expected (a ~20 MiB full-page screenshot), with room. */
export const ENDPOINT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** A client's own frames are commands: small, but a script to evaluate can be large. */
const MAX_INBOUND_BYTES = 32 * 1024 * 1024;
const HEADER_TIMEOUT_MS = 5_000;

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function refuse(socket: Duplex, status: string): void {
  try {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* already gone */ }
  socket.destroy();
}

export class CdpPipeEndpoint {
  private readonly clients = new Set<WebSocket>();
  /** Upgrades accepted and still in their handshake: they count against the cap. */
  private handshaking = 0;
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly wss: WebSocketServer,
    private readonly path: Buffer,
    /** ws://127.0.0.1:<port>/devtools/browser/<random>. Never log it. */
    readonly url: string,
  ) {}

  /** Listen on loopback for clients of `mux`. */
  static async open(mux: CdpPipeMux, opts: { maxClients?: number; maxBufferedBytes?: number; headerTimeoutMs?: number } = {}): Promise<CdpPipeEndpoint> {
    const maxClients = opts.maxClients ?? ENDPOINT_MAX_CLIENTS;
    const maxBuffered = opts.maxBufferedBytes ?? ENDPOINT_MAX_BUFFERED_BYTES;
    const headerTimeoutMs = opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
    const path = `/devtools/browser/${randomBytes(32).toString('hex')}`;
    const server = createServer((_req, res) => {
      // No HTTP routes: only the upgrade below is served.
      res.writeHead(404, { Connection: 'close' });
      res.end();
    });
    server.headersTimeout = headerTimeoutMs;
    server.requestTimeout = headerTimeoutMs * 2;
    // A connection that never finishes its handshake is dropped (an upgraded one clears this).
    server.on('connection', (socket) => socket.setTimeout(headerTimeoutMs, () => socket.destroy()));
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_INBOUND_BYTES, clientTracking: false });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const { port } = server.address() as AddressInfo;
    const endpoint = new CdpPipeEndpoint(server, wss, Buffer.from(path), `ws://127.0.0.1:${port}${path}`);
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (endpoint.closed || !mux.isOpen()) { refuse(socket, '503 Service Unavailable'); return; }
      if (!isLoopback(req.socket.remoteAddress) || req.headers.origin !== undefined || !endpoint.pathMatches(req.url)) {
        refuse(socket, '403 Forbidden');
        return;
      }
      if (endpoint.clients.size + endpoint.handshaking >= maxClients) { refuse(socket, '503 Service Unavailable'); return; }
      endpoint.handshaking++;
      let settled = false;
      const settle = () => {
        if (!settled) endpoint.handshaking--;
        settled = true;
      };
      // A handshake that fails closes the socket without calling back.
      socket.once('close', settle);
      wss.handleUpgrade(req, socket, head, (ws) => {
        settle();
        endpoint.accept(mux, ws, maxBuffered);
      });
    });
    return endpoint;
  }

  private pathMatches(url: string | undefined): boolean {
    const asked = Buffer.from(url ?? '');
    return asked.length === this.path.length && timingSafeEqual(asked, this.path);
  }

  private accept(mux: CdpPipeMux, ws: WebSocket, maxBuffered: number): void {
    // The mux may have closed during the handshake.
    if (this.closed || !mux.isOpen()) { ws.terminate(); return; }
    this.clients.add(ws);
    const client = mux.attachExternal('external', (text) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(text);
      // A client that stopped reading: disconnect it instead of buffering on.
      if (ws.bufferedAmount > maxBuffered) ws.terminate();
    }, () => ws.close());
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // CDP is text
      client.receive(data.toString());
    });
    ws.on('close', () => {
      this.clients.delete(ws);
      client.close();
    });
    ws.on('error', () => ws.terminate());
  }

  /** Disconnect every client and stop listening. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.wss.close();
    const done = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await done;
  }
}
