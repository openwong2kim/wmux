import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import {
  WebTerminalServer,
  type WebA2aRoutes,
  type WebDeviceResolver,
  type WebPeerResolver,
} from '../WebTerminalServer';
import { formatPeerCredential } from '../../../shared/a2aRemote';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { deliberateSleep } from '../../../test-utils/waitFor';

/**
 * The cross-host A2A peer gate: `/api/a2a/*` accepts a peer credential and
 * nothing else, and a peer credential is refused everywhere else — without
 * ever reaching `authenticate()` or the route table.
 */

const PEER_ID = '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const HOST_ID = '9e8d7c6b-5a49-4382-a716-151413121110';
const SECRET = 'A'.repeat(43);
const PEER = formatPeerCredential({ peerId: PEER_ID, secret: SECRET });
const DEVICE = 'dev-1.devicesecret';

type Res = { status: number; body: Record<string, unknown> | null };

describe('A2A peer gate', () => {
  let servers: WebTerminalServer[];
  let peers: { resolve: Mock<WebPeerResolver['resolve']>; touch: Mock<(peerId: string) => void> };
  let a2a: { handle: Mock<WebA2aRoutes['handle']> };
  let devices: { resolve: Mock<WebDeviceResolver['resolve']>; mint: Mock<WebDeviceResolver['mint']> };
  let listLiveSessions: Mock<() => never[]>;

  const makeServer = (deps: { peers?: WebPeerResolver; a2a?: WebA2aRoutes } = { peers, a2a }) => {
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions,
    }) as unknown as DaemonSessionManager;
    const s = new WebTerminalServer({
      sessionManager,
      devices,
      ...deps,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    servers.push(s);
    return s;
  };
  const start = async (s: WebTerminalServer) => {
    await s.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    return s;
  };

  /** node:http, not fetch: the gate keys on `Origin`, so the client must not add one on its own. */
  const call = (
    s: WebTerminalServer,
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Res> =>
    new Promise((resolve, reject) => {
      const req = httpReq(
        { host: '127.0.0.1', port: s.status().port, path, method: opts.method ?? 'GET', headers: opts.headers },
        (res) => {
          let text = '';
          const status = res.statusCode ?? 0;
          const isSse = String(res.headers['content-type'] ?? '').includes('text/event-stream');
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            text += c;
          });
          // An SSE route that answered 200 would never end; settle on headers then.
          if (isSse) {
            resolve({ status, body: null });
            res.destroy();
            return;
          }
          res.on('end', () => {
            let body: Record<string, unknown> | null = null;
            try {
              body = JSON.parse(text) as Record<string, unknown>;
            } catch { /* non-JSON */ }
            resolve({ status, body });
          });
        },
      );
      req.on('error', reject);
      req.end(opts.body);
    });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeEach(() => {
    servers = [];
    listLiveSessions = vi.fn<() => never[]>(() => []);
    peers = {
      resolve: vi.fn<WebPeerResolver['resolve']>(async (peerId, secret) =>
        peerId === PEER_ID && secret === SECRET
          ? { ok: true, peerId, hostId: HOST_ID, name: 'Office PC' }
          : { ok: false, reason: 'unknown' },
      ),
      touch: vi.fn<(peerId: string) => void>(),
    };
    a2a = {
      handle: vi.fn<WebA2aRoutes['handle']>(async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"handled":true}');
      }),
    };
    devices = {
      resolve: vi.fn<WebDeviceResolver['resolve']>(async () => ({ ok: true, deviceId: 'dev-1', allowInput: true })),
      mint: vi.fn<WebDeviceResolver['mint']>(async () => ({ deviceId: 'dev-1', deviceSecret: 'devicesecret' })),
    };
  });

  afterEach(async () => {
    for (const s of servers) if (s.isRunning) await s.stop();
  });

  describe('a peer credential outside /api/a2a/*', () => {
    const routes: Array<[string, { method?: string; headers?: Record<string, string>; body?: string }]> = [
      ['/api/sessions', {}],
      ['/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"session":"x","data":"ls\\n"}' }],
      ['/api/events', {}],
      ['/api/events', { headers: { Accept: 'text/event-stream' } }],
      ['/api/workspaces', {}],
      ['/api/stream?session=x', {}],
      ['/api/approvals', {}],
      ['/api/config', {}],
    ];
    for (const [path, opts] of routes) {
      const label = `${opts.method ?? 'GET'} ${path}${opts.headers?.Accept ? ' (SSE)' : ''}`;
      it(`is forbidden on ${label} without being authenticated`, async () => {
        const s = await start(makeServer());
        const out = await call(s, path, { ...opts, headers: { ...opts.headers, ...bearer(PEER) } });
        expect(out).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
        expect(peers.resolve).not.toHaveBeenCalled();
        expect(devices.resolve).not.toHaveBeenCalled();
      });
    }

    it('is forbidden even when it is malformed (anything that claims the prefix)', async () => {
      const s = await start(makeServer());
      const out = await call(s, '/api/sessions', { headers: bearer('wmuxpeer~not-a-uuid~x') });
      expect(out).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
    });

    describe('cannot be smuggled past the gate', () => {
      const attempts: Array<[string, string]> = [
        ['OPTIONS', '/api/sessions'],
        ['HEAD', '/api/sessions'],
        ['GET', '/api//sessions'],
        ['GET', '/API/a2a/hello'],
        ['GET', '/api//a2a/hello'],
        ['GET', '/api/a2a/../sessions'],
        ['GET', '/api/%61%32%61/hello'],
        ['GET', '/api/pair?code=K7PXM4QA'],
        ['GET', '/'],
        ['GET', '/manifest.webmanifest'],
      ];
      for (const [method, path] of attempts) {
        it(`${method} ${path} is refused and reaches no route`, async () => {
          const s = await start(makeServer());
          const out = await call(s, path, { method, headers: bearer(PEER) });
          expect([403, 404]).toContain(out.status);
          if (method !== 'HEAD') expect(out.body).toEqual({ ok: false, error: 'forbidden' });
          expect(peers.resolve).not.toHaveBeenCalled();
          expect(devices.resolve).not.toHaveBeenCalled();
          expect(a2a.handle).not.toHaveBeenCalled();
          expect(listLiveSessions).not.toHaveBeenCalled();
        });
      }
    });

    it('a lower-case "bearer" scheme authenticates nothing on either side of the gate', async () => {
      const s = await start(makeServer());
      const out = await call(s, '/api/sessions', { headers: { Authorization: `bearer ${PEER}` } });
      expect([401, 403]).toContain(out.status);
      expect(peers.resolve).not.toHaveBeenCalled();
      expect(listLiveSessions).not.toHaveBeenCalled();
      const a2aOut = await call(s, '/api/a2a/hello', { headers: { Authorization: `bearer ${PEER}` } });
      expect(a2aOut.status).toBe(401);
      expect(a2a.handle).not.toHaveBeenCalled();
    });

    it('leaves the operator path untouched', async () => {
      const s = await start(makeServer());
      const out = await call(s, '/api/sessions', { headers: bearer(s.status().token as string) });
      expect(out.status).toBe(200);
    });
  });

  describe('other credentials on /api/a2a/*', () => {
    it('refuses the operator token', async () => {
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/hello', { headers: bearer(s.status().token as string) });
      expect(out).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
      expect(a2a.handle).not.toHaveBeenCalled();
    });

    it('refuses a device credential without resolving it', async () => {
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/hello', { headers: bearer(DEVICE) });
      expect(out).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
      expect(devices.resolve).not.toHaveBeenCalled();
      expect(a2a.handle).not.toHaveBeenCalled();
    });

    it('refuses ?token= and ?ticket= in the query', async () => {
      const s = await start(makeServer());
      const token = s.status().token as string;
      for (const q of [`token=${token}`, 'ticket=abc', 'token=whatever']) {
        const out = await call(s, `/api/a2a/stream?${q}`, { headers: { Accept: 'text/event-stream' } });
        expect(out).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
      }
      expect(a2a.handle).not.toHaveBeenCalled();
    });

    it('answers 401 with no credential or an unrecognized one', async () => {
      const s = await start(makeServer());
      expect(await call(s, '/api/a2a/hello')).toEqual({ status: 401, body: { ok: false, error: 'unauthorized' } });
      expect(await call(s, '/api/a2a/hello', { headers: bearer('nonsense') })).toEqual({
        status: 401,
        body: { ok: false, error: 'unauthorized' },
      });
    });
  });

  describe('peer credentials on /api/a2a/*', () => {
    it('answers 401 for a malformed peer credential without consulting the store', async () => {
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/hello', { headers: bearer(`wmuxpeer~${PEER_ID}~short`) });
      expect(out).toEqual({ status: 401, body: { ok: false, error: 'unauthorized' } });
      expect(peers.resolve).not.toHaveBeenCalled();
    });

    it('answers 401 for a wrong secret', async () => {
      const s = await start(makeServer());
      const wrong = formatPeerCredential({ peerId: PEER_ID, secret: 'B'.repeat(43) });
      const out = await call(s, '/api/a2a/hello', { headers: bearer(wrong) });
      expect(out).toEqual({ status: 401, body: { ok: false, error: 'unauthorized', reason: 'unknown' } });
      expect(a2a.handle).not.toHaveBeenCalled();
    });

    it('answers 401 reason revoked for a revoked peer', async () => {
      peers.resolve.mockResolvedValueOnce({ ok: false, reason: 'revoked' });
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/hello', { headers: bearer(PEER) });
      expect(out).toEqual({ status: 401, body: { ok: false, error: 'unauthorized', reason: 'revoked' } });
      expect(peers.touch).not.toHaveBeenCalled();
    });

    it('fails closed (401) when the store throws', async () => {
      peers.resolve.mockRejectedValueOnce(new Error('disk gone'));
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/hello', { headers: bearer(PEER) });
      expect(out).toEqual({ status: 401, body: { ok: false, error: 'unauthorized', reason: 'unknown' } });
    });

    it('answers 503 with no peer resolver', async () => {
      const s = await start(makeServer({ a2a }));
      const out = await call(s, '/api/a2a/hello', { headers: bearer(PEER) });
      expect(out).toEqual({ status: 503, body: { ok: false, error: 'unavailable' } });
    });

    it('answers 503 with no a2a handler', async () => {
      const s = await start(makeServer({ peers }));
      const out = await call(s, '/api/a2a/hello', { headers: bearer(PEER) });
      expect(out).toEqual({ status: 503, body: { ok: false, error: 'unavailable' } });
      expect(peers.resolve).toHaveBeenCalledTimes(1);
    });

    it('refuses any request carrying Origin, before the store is consulted', async () => {
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/hello', { headers: { ...bearer(PEER), Origin: 'https://evil.example' } });
      expect(out).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
      expect(peers.resolve).not.toHaveBeenCalled();
      expect(a2a.handle).not.toHaveBeenCalled();
    });

    it('hands the handler exactly the resolved peer', async () => {
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/messages?x=1', { method: 'POST', headers: bearer(PEER), body: '{}' });
      expect(out).toEqual({ status: 200, body: { ok: true, handled: true } });
      expect(peers.resolve).toHaveBeenCalledWith(PEER_ID, SECRET);
      expect(peers.touch).toHaveBeenCalledWith(PEER_ID);
      expect(a2a.handle).toHaveBeenCalledTimes(1);
      const [, , url, pathname, peer] = a2a.handle.mock.calls[0];
      expect(url.searchParams.get('x')).toBe('1');
      expect(pathname).toBe('/api/a2a/messages');
      expect(peer).toEqual({ peerId: PEER_ID, hostId: HOST_ID, name: 'Office PC' });
    });

    it('answers 500 unavailable when the handler throws before responding', async () => {
      a2a.handle.mockRejectedValueOnce(new Error('boom'));
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/hello', { headers: bearer(PEER) });
      expect(out).toEqual({ status: 500, body: { ok: false, error: 'unavailable' } });
      // The server is still serving.
      expect((await call(s, '/api/a2a/hello', { headers: bearer(PEER) })).status).toBe(200);
    });

    it('drops the connection when the handler throws mid-response', async () => {
      a2a.handle.mockImplementationOnce(async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
        res.write('{"partial":');
        throw new Error('boom');
      });
      const s = await start(makeServer());
      await expect(call(s, '/api/a2a/hello', { headers: bearer(PEER) })).rejects.toThrow();
      expect((await call(s, '/api/a2a/hello', { headers: bearer(PEER) })).status).toBe(200);
    });

    it('accepts a synchronous resolver', async () => {
      const sync: WebPeerResolver = {
        resolve: (peerId) => ({ ok: true, peerId, hostId: HOST_ID, name: 'Sync' }),
      };
      const s = await start(makeServer({ peers: sync, a2a }));
      const out = await call(s, '/api/a2a/hello', { headers: bearer(PEER) });
      expect(out.status).toBe(200);
      expect(a2a.handle.mock.calls[0][4]).toEqual({ peerId: PEER_ID, hostId: HOST_ID, name: 'Sync' });
    });

    it('a touch that returns a rejecting promise is logged, not unhandled', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        peers.touch.mockImplementation(() => Promise.reject(new Error('async bookkeeping')) as unknown as void);
        const s = await start(makeServer());
        const out = await call(s, '/api/a2a/hello', { headers: bearer(PEER) });
        expect(out.status).toBe(200);
        await deliberateSleep(20, 'negative: async bookkeeping leaves no unhandled rejection');
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('a touch that throws does not fail the request', async () => {
      peers.touch.mockImplementation(() => {
        throw new Error('bookkeeping');
      });
      const s = await start(makeServer());
      const out = await call(s, '/api/a2a/hello', { headers: bearer(PEER) });
      expect(out.status).toBe(200);
    });
  });
});
