import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type http from 'node:http';
import type net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { PinnedClientError, PinnedTlsClient, type PinnedClientOptions, type PinnedSseEvent } from '../pinnedClient';

// Test-only, not a secret: two throwaway self-signed EC P-256 certificates
// committed under fixtures/ (see fixtures/README.md) so no test shells out to openssl.
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const CERT_A = fixture('cert-a.pem');
const KEY_A = fixture('key-a.pem');
const CERT_B = fixture('cert-b.pem');
const FP_A = new crypto.X509Certificate(CERT_A).fingerprint256;
const FP_B = new crypto.X509Certificate(CERT_B).fingerprint256;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (let close = closers.pop(); close; close = closers.pop()) await close();
});

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

function track(server: net.Server, sockets: Set<net.Socket>): void {
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
}

/**
 * Raw TLS server on certificate A that counts the APPLICATION bytes it receives
 * after the handshake, answers any complete HTTP request with a fixed JSON
 * reply, and reports each underlying TCP connection's close.
 */
async function rawCountingServer() {
  const state = { appBytes: 0, connections: 0, closed: [] as Promise<void>[] };
  const server = tls.createServer({ cert: CERT_A, key: KEY_A }, (sock) => {
    let seen = '';
    sock.on('data', (chunk: Buffer) => {
      state.appBytes += chunk.length;
      seen += chunk.toString('latin1');
      if (seen.includes('\r\n\r\n')) {
        const body = '{"ok":true}';
        sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      }
    });
    sock.on('error', () => { /* client hang-ups are expected */ });
  });
  server.on('tlsClientError', () => { /* a client that drops mid-handshake is expected */ });
  const sockets = new Set<net.Socket>();
  server.on('connection', (raw: net.Socket) => {
    state.connections += 1;
    state.closed.push(new Promise((resolve) => raw.on('close', () => resolve())));
  });
  track(server, sockets);
  const port = await listen(server);
  return { port, state };
}

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };

/** HTTPS server on certificate A with a small route table. */
async function httpsServer(routes: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const seen: Seen[] = [];
  const server = https.createServer({ cert: CERT_A, key: KEY_A }, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      routes(req, res, body);
    });
  });
  track(server, new Set());
  const port = await listen(server);
  return { port, seen };
}

const client = (over: Partial<PinnedClientOptions> & { port: number }) =>
  new PinnedTlsClient({
    addresses: ['127.0.0.1'],
    fingerprint256: FP_A,
    connectTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    ...over,
  });

async function collect(it: AsyncIterable<PinnedSseEvent>): Promise<PinnedSseEvent[]> {
  const out: PinnedSseEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('PinnedTlsClient — the pin', () => {
  it('talks to a server presenting the pinned certificate', async () => {
    const { port, seen } = await httpsServer((_req, res, body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ echo: JSON.parse(body) }));
    });
    // Lower-case, colon-less pin: normalized like the invite parser does.
    const c = client({ port, fingerprint256: FP_A.replace(/:/g, '').toLowerCase(), credential: 'wmuxpeer~id~secret' });
    const out = await c.requestJson('POST', '/api/a2a/messages', { hi: 1 });
    expect(out).toEqual({ status: 200, json: { echo: { hi: 1 } } });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/a2a/messages');
    expect(seen[0].headers.authorization).toBe('Bearer wmuxpeer~id~secret');
    expect(seen[0].headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('sends no Authorization at all without a credential (the /api/pair exchange)', async () => {
    const { port, seen } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"paired":true}');
    });
    const out = await client({ port }).requestJson('GET', '/api/pair?code=K7PXM4QA');
    expect(out).toEqual({ status: 200, json: { paired: true } });
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('refuses a mismatched certificate before writing a single application byte', async () => {
    const { port, state } = await rawCountingServer();
    const c = client({ port, fingerprint256: FP_B, credential: 'wmuxpeer~id~secret' });
    const err = await c.requestJson('GET', '/api/a2a/hello').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PinnedClientError);
    expect((err as PinnedClientError).code).toBe('fingerprint-mismatch');
    expect((err as PinnedClientError).sent).toBe(false);
    await Promise.all(state.closed);
    expect(state.appBytes).toBe(0);
  });

  it('control: the same raw server does receive bytes when the pin matches', async () => {
    const { port, state } = await rawCountingServer();
    const out = await client({ port }).requestJson('GET', '/api/a2a/hello');
    expect(out).toEqual({ status: 200, json: { ok: true } });
    expect(state.appBytes).toBeGreaterThan(0);
  });

  it('does not fall through to the next address after a mismatch', async () => {
    const { port, state } = await rawCountingServer();
    const c = client({ port, fingerprint256: FP_B, addresses: ['127.0.0.1', '127.0.0.1'] });
    const err = await c.requestJson('GET', '/api/a2a/hello').catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('fingerprint-mismatch');
    await Promise.all(state.closed);
    expect(state.connections).toBe(1);
  });

  it('streams refuse a mismatched certificate the same way', async () => {
    const { port, state } = await rawCountingServer();
    const ac = new AbortController();
    const err = await collect(client({ port, fingerprint256: FP_B }).openStream('/api/a2a/stream', { signal: ac.signal })).catch(
      (e: unknown) => e,
    );
    expect((err as PinnedClientError).code).toBe('fingerprint-mismatch');
    await Promise.all(state.closed);
    expect(state.appBytes).toBe(0);
  });
});

describe('PinnedTlsClient — socket lifecycle', () => {
  /** TLS server on certificate A that drops every connection right after the handshake. */
  async function dropAfterHandshake() {
    const state = { closed: [] as Promise<void>[] };
    const server = tls.createServer({ cert: CERT_A, key: KEY_A }, (sock) => {
      sock.on('error', () => { /* expected */ });
      sock.destroy();
    });
    server.on('tlsClientError', () => { /* expected */ });
    server.on('connection', (raw: net.Socket) => {
      state.closed.push(new Promise((resolve) => raw.on('close', () => resolve())));
    });
    track(server, new Set());
    return { port: await listen(server), state };
  }

  it('fails a request at once when the socket dies right after the handshake', async () => {
    const { port } = await dropAfterHandshake();
    const t0 = Date.now();
    const err = await client({ port, requestTimeoutMs: 10_000 }).requestJson('GET', '/x').catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('network');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('fails a stream at once when the socket dies right after the handshake', async () => {
    const { port } = await dropAfterHandshake();
    const t0 = Date.now();
    const ac = new AbortController();
    const err = await collect(client({ port, requestTimeoutMs: 10_000 }).openStream('/s', { signal: ac.signal })).catch(
      (e: unknown) => e,
    );
    expect((err as PinnedClientError).code).toBe('network');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('closes the pinned socket when building the request throws (invalid header)', async () => {
    const { port, state } = await rawCountingServer();
    const c = client({ port, credential: 'bad\r\nX-Injected: 1' });
    await expect(c.requestJson('GET', '/x')).rejects.toThrow();
    const ac = new AbortController();
    await expect(collect(c.openStream('/s', { signal: ac.signal }))).rejects.toThrow();
    await Promise.all(state.closed);
    expect(state.connections).toBe(2);
    expect(state.appBytes).toBe(0);
  });
});

describe('PinnedTlsClient — addresses and proxies', () => {
  it('moves on to the next address when the first refuses the connection', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    // Nothing listens on IPv6 loopback at this port (the server bound 127.0.0.1 only),
    // so the first address fails at connect — refused, or unavailable without IPv6.
    const out = await client({ port, addresses: ['::1', '127.0.0.1'] }).requestJson('GET', '/api/a2a/hello');
    expect(out.status).toBe(200);
  }, 15_000);

  it('reports the address that got through, and only after its certificate matched the pin', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const reached: string[] = [];
    await client({ port, addresses: ['::1', '127.0.0.1'], onConnected: (a) => reached.push(a) }).requestJson('GET', '/x');
    expect(reached).toEqual(['127.0.0.1']);
    // A wrong certificate is never reported as reached (an impostor must not be promoted).
    const wrong: string[] = [];
    const err = await client({ port, fingerprint256: FP_B, addresses: ['127.0.0.1'], onConnected: (a) => wrong.push(a) })
      .requestJson('GET', '/x')
      .catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('fingerprint-mismatch');
    expect(wrong).toEqual([]);
    // A throwing callback does not break the connection.
    const out = await client({ port, addresses: ['127.0.0.1'], onConnected: () => { throw new Error('boom'); } }).requestJson('GET', '/x');
    expect(out.status).toBe(200);
  }, 15_000);

  it('one client instance dials the address that last got through first (a stream\'s acks never re-wait a dead one)', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const dial = vi.spyOn(tls, 'connect');
    try {
      const c = client({ port, addresses: ['::1', '127.0.0.1'] });
      for (let i = 0; i < 3; i++) expect((await c.requestJson('GET', '/x')).status).toBe(200);
      const hosts = dial.mock.calls.map((args) => (args[0] as tls.ConnectionOptions).host);
      expect(hosts).toEqual(['::1', '127.0.0.1', '127.0.0.1', '127.0.0.1']);
    } finally {
      dial.mockRestore();
    }
  }, 15_000);

  it('reports connect-failed, with nothing sent, when no address answers', async () => {
    const { port } = await httpsServer(() => { /* unreachable */ });
    const err = await client({ port, addresses: ['::1'] }).requestJson('GET', '/x').catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('connect-failed');
    expect((err as PinnedClientError).sent).toBe(false);
  }, 15_000);

  it('dials directly even when proxy variables are set', async () => {
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.NO_PROXY = '';
    try {
      const { port, seen } = await httpsServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      const out = await client({ port }).requestJson('GET', '/api/a2a/hello');
      expect(out.status).toBe(200);
      // Origin-form, not the absolute-form a proxy request would carry.
      expect(seen[0].url).toBe('/api/a2a/hello');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('times out a request the server never answers', async () => {
    const { port } = await httpsServer(() => { /* never answers */ });
    const err = await client({ port, requestTimeoutMs: 200 }).requestJson('GET', '/slow').catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('timeout');
    expect((err as PinnedClientError).sent).toBe(true);
  });

  it('returns non-JSON and error answers as status + null/parsed json', async () => {
    const { port } = await httpsServer((req, res) => {
      if (req.url === '/html') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>nope</h1>');
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"unauthorized"}');
      }
    });
    const c = client({ port });
    expect(await c.requestJson('GET', '/html')).toEqual({ status: 404, json: null });
    expect(await c.requestJson('GET', '/api/a2a/hello')).toEqual({ status: 401, json: { ok: false, error: 'unauthorized' } });
  });
});

describe('PinnedTlsClient — event stream', () => {
  it('parses data lines as JSON, carries ids, and ends when the server ends', async () => {
    const { port, seen } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Split mid-line and across a CRLF to exercise the incremental parser.
      res.write(': heartbeat\n\nid: 1\ndata: {"n"');
      res.write(':1}\r');
      res.write('\n\r\nevent: link\ndata: {"n":\ndata: 2}\n\n');
      res.end('data: {"partial":true}');
    });
    const ac = new AbortController();
    const events = await collect(
      client({ port, credential: 'wmuxpeer~id~secret' }).openStream('/api/a2a/stream', { signal: ac.signal, lastEventId: 'e1:7' }),
    );
    expect(events).toEqual([
      { id: '1', event: 'message', data: { n: 1 } },
      { id: '1', event: 'link', data: { n: 2 } },
    ]);
    expect(seen[0].headers.accept).toBe('text/event-stream');
    expect(seen[0].headers['last-event-id']).toBe('e1:7');
    expect(seen[0].headers.authorization).toBe('Bearer wmuxpeer~id~secret');
    expect(seen[0].url).toBe('/api/a2a/stream');
  });

  it('ends quietly on abort while the stream is open', async () => {
    let resolveServerRes: (res: http.ServerResponse) => void = () => undefined;
    const serverRes = new Promise<http.ServerResponse>((resolve) => { resolveServerRes = resolve; });
    const { port } = await httpsServer((_req, res) => {
      resolveServerRes(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"first":true}\n\n');
    });
    const ac = new AbortController();
    const got: PinnedSseEvent[] = [];
    for await (const ev of client({ port }).openStream('/s', { signal: ac.signal })) {
      got.push(ev);
      ac.abort();
    }
    expect(got).toEqual([{ event: 'message', data: { first: true } }]);
    // The server sees the connection go away.
    const res = await serverRes;
    await new Promise<void>((resolve) => {
      if (res.closed) resolve();
      else res.on('close', () => resolve());
    });
  });

  it('ends quietly on abort before the response headers arrive', async () => {
    const { port } = await httpsServer(() => { /* holds the request */ });
    const ac = new AbortController();
    const done = collect(client({ port, requestTimeoutMs: 10_000 }).openStream('/s', { signal: ac.signal }));
    setTimeout(() => ac.abort(), 100);
    expect(await done).toEqual([]);
  });

  it('yields nothing for a signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await collect(client({ port: 1 }).openStream('/s', { signal: ac.signal }))).toEqual([]);
  });

  it('throws http with the status and JSON body when the stream is refused', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"unauthorized","reason":"revoked"}');
    });
    const ac = new AbortController();
    const err = await collect(client({ port }).openStream('/s', { signal: ac.signal })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PinnedClientError);
    expect((err as PinnedClientError).code).toBe('http');
    expect((err as PinnedClientError).status).toBe(401);
    expect((err as PinnedClientError).json).toEqual({ ok: false, error: 'unauthorized', reason: 'revoked' });
  });

  it('times out a refused stream whose error body never ends', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.write('{"ok":false');
    });
    const ac = new AbortController();
    const t0 = Date.now();
    const err = await collect(client({ port, requestTimeoutMs: 300 }).openStream('/s', { signal: ac.signal })).catch(
      (e: unknown) => e,
    );
    expect((err as PinnedClientError).code).toBe('http');
    expect((err as PinnedClientError).status).toBe(401);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('ends at once, closing the socket, when aborted during the handshake', async () => {
    const { port, state } = await rawCountingServer();
    const ac = new AbortController();
    const c = client({ port, requestTimeoutMs: 10_000 });
    const it = c.openStream('/s', { signal: ac.signal });
    const first = it.next();
    // Abort while the TLS handshake is in flight.
    setImmediate(() => ac.abort());
    expect(await first).toEqual({ done: true, value: undefined });
    await Promise.all(state.closed);
    expect(state.appBytes).toBe(0);
  });

  it('refuses a body that cannot be serialized before dialling', async () => {
    const { port, state } = await rawCountingServer();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(client({ port }).requestJson('POST', '/x', cyclic)).rejects.toThrow();
    expect(state.connections).toBe(0);
  });

  it('throws protocol when data lines pile up without ever dispatching', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const line = `data: ${'x'.repeat(64 * 1024)}\n`;
      const pump = (): void => {
        while (!res.destroyed && res.write(line)) { /* fill until backpressure */ }
        if (!res.destroyed) res.once('drain', pump);
      };
      res.on('error', () => { /* client hang-up is the expected end */ });
      pump();
    });
    const ac = new AbortController();
    const err = await collect(client({ port }).openStream('/s', { signal: ac.signal })).catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('protocol');
  });

  it('throws protocol on one oversized line, measured in UTF-8 bytes', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.on('error', () => { /* client hang-up is the expected end */ });
      // 1.5M chars is under the cap in UTF-16 units but 4.5 MB in UTF-8.
      res.end(`event: ${'한'.repeat(1_500_000)}\n\n`);
    });
    const ac = new AbortController();
    const err = await collect(client({ port }).openStream('/s', { signal: ac.signal })).catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('protocol');
  });

  it('throws protocol on an event id that cannot travel back as a header', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('id: a\u0007b\ndata: {}\n\n');
    });
    const ac = new AbortController();
    const err = await collect(client({ port }).openStream('/s', { signal: ac.signal })).catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('protocol');
  });

  it('refuses an invalid lastEventId before connecting', async () => {
    const ac = new AbortController();
    for (const bad of ['a\r\nX-Injected: 1', 'x'.repeat(1025), 'tab\there']) {
      const err = await collect(client({ port: 1 }).openStream('/s', { signal: ac.signal, lastEventId: bad })).catch(
        (e: unknown) => e,
      );
      expect((err as PinnedClientError).code).toBe('bad-options');
    }
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const bytes = Buffer.from('data: {"t":"한"}\n\n', 'utf8');
      const cut = bytes.indexOf(Buffer.from('한', 'utf8')) + 1;
      res.write(bytes.subarray(0, cut));
      setTimeout(() => res.end(bytes.subarray(cut)), 20);
    });
    const ac = new AbortController();
    expect(await collect(client({ port }).openStream('/s', { signal: ac.signal }))).toEqual([
      { event: 'message', data: { t: '한' } },
    ]);
  });

  it('throws protocol on an event whose data is not JSON', async () => {
    const { port } = await httpsServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: not json\n\n');
    });
    const ac = new AbortController();
    const err = await collect(client({ port }).openStream('/s', { signal: ac.signal })).catch((e: unknown) => e);
    expect((err as PinnedClientError).code).toBe('protocol');
  });
});
