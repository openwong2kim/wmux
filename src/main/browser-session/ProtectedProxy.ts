import * as http from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import type { HostMatcher } from '../../shared/browserHostPolicy';

// ---------------------------------------------------------------------------
// The site policy of a protected Chrome profile, enforced at the network.
//
// One proxy per protected profile, owned by main, listening on loopback with a
// random port. Chrome is launched with `--proxy-server=127.0.0.1:<port>` and
// `--proxy-bypass-list=<-loopback>`, so EVERY request it makes — documents,
// subresources, out-of-process iframes, dedicated / shared / service workers,
// WebSocket (Chrome tunnels ws:// and wss:// through CONNECT), prefetch and
// session-restore traffic — arrives here first, and loopback too.
//
// The decision is on the hostname only: plain HTTP is read from the absolute
// request URL, everything else from the CONNECT authority. There is no TLS
// interception. A request this proxy does not understand is refused, an
// upgrade on a plain request is refused, and if the proxy is down the profile
// cannot reach anything: fail-closed by construction.
//
// The matcher is asked per request, so a policy edit takes effect on the next
// request without restarting anything.
//
// No proxy credential: loopback + a random port is the boundary, and a
// same-user process speaking to it directly is outside the threat model
// (docs/SECURITY.md §1.3.1), as it can already drive the profile's Chrome.
// ---------------------------------------------------------------------------

export interface ProtectedProxyOptions {
  /** The policy as it is NOW (read per request). */
  matcher: () => HostMatcher;
  /** Test seam: where an allowed host:port actually connects. */
  resolve?: (host: string, port: number) => { host: string; port: number };
  /** Test seam: every decision, in order. */
  onDecision?: (decision: { host: string; port: number; allowed: boolean; kind: 'http' | 'connect' | 'upgrade' }) => void;
}

const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 };

/** `host:port` (IPv6 bracketed) → parts, or null. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s/@]+):(\d{1,5})$/.exec(authority ?? '');
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export class ProtectedProxy {
  private server: http.Server | null = null;
  private listenPort = 0;
  private readonly sockets = new Set<Duplex>();

  constructor(private readonly opts: ProtectedProxyOptions) {}

  /** The listening port, or 0 when not running. */
  port(): number {
    return this.server?.listening ? this.listenPort : 0;
  }

  isRunning(): boolean {
    return this.port() > 0;
  }

  private decide(host: string, port: number, kind: 'http' | 'connect' | 'upgrade'): boolean {
    let allowed = false;
    try {
      // The proxy itself is never a destination, whatever the policy says.
      const self = (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') && port === this.listenPort;
      allowed = !self && kind !== 'upgrade' && this.opts.matcher().allows(host, port);
    } catch {
      allowed = false;
    }
    try {
      this.opts.onDecision?.({ host, port, allowed, kind });
    } catch {
      /* observation only */
    }
    return allowed;
  }

  private target(host: string, port: number): { host: string; port: number } {
    return this.opts.resolve?.(host, port) ?? { host: unbracket(host), port };
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  async start(): Promise<number> {
    if (this.isRunning()) return this.listenPort;
    const server = http.createServer((req, res) => this.onRequest(req, res));
    server.on('connect', (req, socket, head) => this.onConnect(req, socket, head));
    server.on('upgrade', (req, socket) => {
      const url = safeUrl(req.url);
      this.decide(url?.hostname ?? '', Number(url?.port || 0), 'upgrade');
      socket.destroy();
    });
    server.on('connection', (socket) => this.track(socket));
    server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      throw new Error('ProtectedProxy: no listening port');
    }
    this.server = server;
    this.listenPort = addr.port;
    return this.listenPort;
  }

  /** Stop listening and cut every open tunnel. */
  close(): void {
    const server = this.server;
    this.server = null;
    this.listenPort = 0;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    server?.close();
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = safeUrl(req.url);
    // Only absolute-form plain HTTP is a proxy request; https goes by CONNECT.
    if (!url || url.protocol !== 'http:' || url.username || url.password) {
      res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
      res.end('Bad proxy request');
      return;
    }
    const port = url.port ? Number(url.port) : DEFAULT_PORT[url.protocol];
    if (!this.decide(url.hostname, port, 'http')) {
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end('Blocked by wmux: this site is not on the protected pane\'s allowed list.');
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'host' && v !== undefined) headers[k] = v;
    }
    // The host that was decided on is the host that is asked for: a Host
    // header naming another site must not ride an allowed connection.
    headers.host = url.host;
    const to = this.target(url.hostname, port);
    const upstream = http.request(
      { host: to.host, port: to.port, method: req.method, path: `${url.pathname}${url.search}`, headers },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
        }
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.pipe(upstream);
  }

  private onConnect(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    this.track(socket);
    socket.on('error', () => socket.destroy());
    const authority = parseAuthority(req.url ?? '');
    if (!authority || !this.decide(authority.host, authority.port, 'connect')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const to = this.target(authority.host, authority.port);
    const upstream = net.connect(to.port, to.host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    this.track(upstream);
    upstream.on('error', () => {
      if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    socket.on('close', () => upstream.destroy());
  }
}

function safeUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The Chrome flags that route a profile through `port` and leave no way around it. */
export function protectedChromeArgs(port: number): string[] {
  return [
    `--proxy-server=127.0.0.1:${port}`,
    // `<-loopback>` removes Chrome's implicit loopback bypass, so localhost
    // and 127.0.0.1 go through the proxy (and its policy) too.
    '--proxy-bypass-list=<-loopback>',
    // WebRTC may use only proxied UDP — i.e. none, with an HTTP proxy.
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // No QUIC and no DNS-over-HTTPS path that could leave outside the proxy.
    '--disable-quic',
    '--disable-features=DnsOverHttps',
  ];
}
