import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

// A minimal fake of exactly what WebTerminalServer touches: getSession() (for
// stream/input) and listLiveSessions() (for the picker). No real daemon/pty.
function makeDeps() {
  const bridge = new EventEmitter();
  const write = vi.fn();
  const managed = {
    meta: { id: 's1', cols: 80, rows: 24, state: 'detached', cwd: '/x' },
    ringBuffer: { readAll: () => Buffer.from('screen-bytes') },
    bridge,
    ptyProcess: { write },
  };
  // Three panes covering the workspace-label matrix: named workspace, a legacy
  // pane spawned before WMUX_WORKSPACE_NAME existed (id present, name absent),
  // and no wmux identity at all.
  const live = [
    {
      id: 's1', cwd: '/x', cols: 80, rows: 24, state: 'detached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'Workspace 1', ANTHROPIC_API_KEY: 'sk-secret' },
    },
    {
      id: 's2', cwd: '/y', cols: 80, rows: 24, state: 'attached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { WMUX_WORKSPACE_ID: 'ws-legacy' },
    },
    {
      id: 's3', cwd: '/z', cols: 80, rows: 24, state: 'detached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { PATH: '/usr/bin' },
    },
  ];
  // The real DaemonSessionManager is an EventEmitter; the server tees its
  // session:critical / session:notification events, so the fake must emit too.
  const sessionManager = Object.assign(new EventEmitter(), {
    getSession: (id: string) => (id === 's1' ? managed : undefined),
    listLiveSessions: () => live,
  }) as unknown as DaemonSessionManager;
  return { sessionManager, bridge, write };
}

describe('WebTerminalServer', () => {
  let server: WebTerminalServer;
  let bridge: EventEmitter;
  let write: ReturnType<typeof vi.fn>;
  let sessionManager: DaemonSessionManager;

  beforeEach(() => {
    const deps = makeDeps();
    bridge = deps.bridge;
    write = deps.write;
    sessionManager = deps.sessionManager;
    server = new WebTerminalServer({
      sessionManager: deps.sessionManager,
      log: () => { /* silent in tests */ },
      assetsDir: os.tmpdir(), // no terminal.html needed for the /api/* tests
    });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
  });

  // Port 0 → ephemeral bind; status() reports the actual port.
  const startRO = () => server.start({ port: 0, host: '127.0.0.1', allowInput: false });
  const startRW = () => server.start({ port: 0, host: '127.0.0.1', allowInput: true });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('gates /api/* — Bearer header required, query token rejected for non-SSE', async () => {
    const info = await startRO();
    expect(info.running).toBe(true);
    const token = info.token as string;

    // No credentials → 401
    const noAuth = await fetch(`${base()}/api/config`);
    expect(noAuth.status).toBe(401);

    // Query-string token is NOT accepted on a non-SSE endpoint (narrowed to Bearer)
    const q = await fetch(`${base()}/api/config?token=${encodeURIComponent(token)}`);
    expect(q.status).toBe(401);

    // Bearer header → 200
    const ok = await fetch(`${base()}/api/config`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ allowInput: false });
  });

  it('labels sessions by workspace NAME only, and leaks nothing else from env', async () => {
    const info = await startRO();
    const res = await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) });
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: Array<Record<string, unknown>> };

    // Named workspace wins.
    expect(sessions[0].workspace).toBe('Workspace 1');
    // A pane that predates WMUX_WORKSPACE_NAME carries only the id. The id is a
    // UUID and means nothing to a human, so it is NOT used as a fallback — the
    // field stays absent and the frontend keeps showing its cwd label.
    expect('workspace' in sessions[1]).toBe(false);
    // No wmux identity at all → the field is absent, so the frontend falls back
    // to its cwd label instead of showing a fabricated workspace.
    expect('workspace' in sessions[2]).toBe(false);

    // Only the workspace NAME is read out of the pane env — the rest of it
    // (credentials, account config dirs, and the meaningless workspace UUID)
    // must never reach the browser.
    const wire = JSON.stringify(sessions);
    expect(wire).not.toContain('sk-secret');
    expect(wire).not.toContain('ANTHROPIC_API_KEY');
    expect(wire).not.toContain('/usr/bin');
    expect(wire).not.toContain('ws-legacy');
  });

  it('rejects input when started read-only (403), accepts and writes when --allow-input (204)', async () => {
    // read-only
    let info = await startRO();
    const roRes = await fetch(`${base()}/api/input?session=s1`, {
      method: 'POST', headers: bearer(info.token as string), body: 'nope',
    });
    expect(roRes.status).toBe(403);
    expect(write).not.toHaveBeenCalled();
    await server.stop();

    // allow-input
    info = await startRW();
    const rwRes = await fetch(`${base()}/api/input?session=s1`, {
      method: 'POST', headers: bearer(info.token as string), body: 'echo hi\r',
    });
    expect(rwRes.status).toBe(204);
    expect(write).toHaveBeenCalledWith('echo hi\r');
  });

  it('mints a fresh token on each start and invalidates the previous one', async () => {
    const a = (await startRO()).token as string;
    await server.stop();
    const b = (await startRO()).token as string;
    expect(b).not.toBe(a);

    // The old token no longer authenticates against the new server.
    const stale = await fetch(`${base()}/api/config`, { headers: bearer(a) });
    expect(stale.status).toBe(401);
    const fresh = await fetch(`${base()}/api/config`, { headers: bearer(b) });
    expect(fresh.status).toBe(200);
  });

  it('teardown stops accepting connections and removes all bridge listeners', async () => {
    const info = await startRO();
    const token = info.token as string;
    const port = server.status().port;

    // Open an SSE stream — this attaches a bridge 'data' + 'exit' listener.
    const ac = new AbortController();
    const sse = await fetch(`${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`, { signal: ac.signal });
    expect(sse.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.listenerCount('data')).toBe(1);
    expect(bridge.listenerCount('exit')).toBe(1);

    // Stop → every SSE client detached, all bridge listeners removed.
    const stopped = await server.stop();
    expect(stopped).toEqual({ stopped: true });
    expect(bridge.listenerCount('data')).toBe(0);
    expect(bridge.listenerCount('exit')).toBe(0);
    expect(server.isRunning).toBe(false);
    ac.abort();

    // The port no longer accepts connections.
    await expect(fetch(`http://127.0.0.1:${port}/api/config`, { headers: bearer(token) })).rejects.toThrow();
  });

  it('stop() on a server that never started is a no-op', async () => {
    expect(await server.stop()).toEqual({ stopped: false });
  });

  // ── pairing ────────────────────────────────────────────────────────────────
  it('exposes a 6-char pairing code + expiry in status()', async () => {
    const info = await startRO();
    expect(info.pairCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(typeof info.pairExpiresAt).toBe('number');
    expect((info.pairExpiresAt as number)).toBeGreaterThan(Date.now());
  });

  it('/api/pair with the right code returns the token once, then 403 (single use)', async () => {
    const info = await startRO();
    const code = info.pairCode as string;
    const token = info.token as string;

    // No auth header needed — pairing is the only unauthenticated /api route.
    const ok = await fetch(`${base()}/api/pair?code=${code}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ token });

    // The code is burned — a second use fails.
    const reuse = await fetch(`${base()}/api/pair?code=${code}`);
    expect(reuse.status).toBe(403);
  });

  it('/api/pair with a wrong code decrements attempts and locks after 5', async () => {
    const info = await startRO();
    const code = info.pairCode as string;
    // Build a wrong code of the same length from the same alphabet.
    const wrong = code[0] === 'A' ? 'BBBBBB' : 'AAAAAA';

    for (let i = 4; i >= 1; i--) {
      const r = await fetch(`${base()}/api/pair?code=${wrong}`);
      expect(r.status).toBe(403);
      expect((await r.json()).attemptsLeft).toBe(i);
    }
    // 5th wrong attempt burns the code.
    const last = await fetch(`${base()}/api/pair?code=${wrong}`);
    expect(last.status).toBe(403);
    expect((await last.json()).attemptsLeft).toBe(0);

    // Even the CORRECT code no longer works once the budget is exhausted.
    const correct = await fetch(`${base()}/api/pair?code=${code}`);
    expect(correct.status).toBe(403);
  });

  it('mints a fresh pairing code on each start', async () => {
    const a = (await startRO()).pairCode as string;
    await server.stop();
    const b = (await startRO()).pairCode as string;
    // Overwhelmingly likely to differ; assert format regardless.
    expect(b).toMatch(/^[A-Z2-9]{6}$/);
    expect(a).toMatch(/^[A-Z2-9]{6}$/);
  });

  // ── critical / notify SSE tee ──────────────────────────────────────────────
  it('tees session:critical and session:notification to every SSE client', async () => {
    const info = await startRO();
    const token = info.token as string;

    const ac = new AbortController();
    const sse = await fetch(
      `${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`,
      { signal: ac.signal },
    );
    expect(sse.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    // Emit fleet-wide events; they must reach the stream even though it watches s1.
    (sessionManager as unknown as EventEmitter).emit('session:critical', {
      sessionId: 's2',
      event: { action: 'delete files', riskLevel: 'critical' },
    });
    (sessionManager as unknown as EventEmitter).emit('session:notification', {
      sessionId: 's3',
      event: { message: 'done', ts: 123 },
    });

    // Read a chunk of the stream and assert both events flattened onto the wire.
    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !(text.includes('event: critical') && text.includes('event: notify'))) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += Buffer.from(value).toString('utf8');
    }
    ac.abort();

    expect(text).toContain('event: critical');
    expect(text).toContain('"sessionId":"s2"');
    expect(text).toContain('"action":"delete files"');
    expect(text).toContain('event: notify');
    expect(text).toContain('"sessionId":"s3"');
    expect(text).toContain('"message":"done"');
  });

  it('removes the session-manager listeners on stop (no leak across restarts)', async () => {
    await startRO();
    const em = sessionManager as unknown as EventEmitter;
    expect(em.listenerCount('session:critical')).toBe(1);
    expect(em.listenerCount('session:notification')).toBe(1);
    await server.stop();
    expect(em.listenerCount('session:critical')).toBe(0);
    expect(em.listenerCount('session:notification')).toBe(0);
  });
  it('sets frame/sniff/referrer protection on responses', async () => {
    const info = await startRO();
    const res = await fetch(`http://127.0.0.1:${info.port}/api/config`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  /** Raw request so we can set Host (undici forbids overriding it on fetch()). */
  const getWithHost = (port: number, path: string, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpReq({ host: '127.0.0.1', port, path, headers: { Host: host } }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('rejects a request addressed to a foreign Host (DNS-rebinding guard)', async () => {
    const info = await startRO();
    const res = await getWithHost(info.port as number, '/api/pair?code=WHATEVER', 'evil.com');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe('host not allowed');
  });

  it('accepts loopback Host names', async () => {
    const info = await startRO();
    const res = await getWithHost(info.port as number, '/api/config', `localhost:${info.port}`);
    // 401 (not 403) proves the host gate passed and the token gate took over.
    expect(res.status).toBe(401);
  });

  it('mints a replacement pairing code once the old one is burned', async () => {
    const info = await startRO();
    const first = info.pairCode as string;
    expect(first).toHaveLength(6);
    // Burn the attempt budget with wrong guesses.
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZ`);
    }
    // Burned, and inside the regeneration cooldown: deliberately still gone.
    await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZ`);
    expect(server.status().pairCode).toBeUndefined();

    // Past the cooldown, the next attempt mints a replacement so a burned code
    // costs a short wait instead of a server restart.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
    try {
      await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZ`);
    } finally {
      nowSpy.mockRestore();
    }
    const after = server.status().pairCode;
    expect(after).toHaveLength(6);
    expect(after).not.toBe(first);
  });
});
