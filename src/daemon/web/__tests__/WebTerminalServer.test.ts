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
      // Quoted because the path contains a space, plus an argument to prove
      // only the basename is surfaced.
      cmd: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo --token sk-nope',
    },
    {
      id: 's2', cwd: '/y', cols: 80, rows: 24, state: 'attached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { WMUX_WORKSPACE_ID: 'ws-legacy' },
      // The shape actually recorded on Windows: UNQUOTED, spaces in the path,
      // no arguments (ShellDetector hands the bare path through). Splitting on
      // whitespace here yields "Program" for every pane — precisely the
      // sameness this field exists to remove — so this case must stay covered.
      cmd: 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.4.0_x64__8wekyb3d8bbwe\\pwsh.exe',
    },
    {
      id: 's3', cwd: '/z', cols: 80, rows: 24, state: 'detached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { PATH: '/usr/bin' },
      cmd: '/usr/bin/bash -l',
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

  // #596 — the daemon carries the previous token across a restart so a phone
  // that already paired keeps working. The seam is caller-supplied, never RPC
  // params: the daemon reads it from its own 0600 state file.
  it('reuses a caller-supplied token so a paired device survives a restart', async () => {
    const a = (await startRO()).token as string;
    await server.stop();

    const b = (await server.start({ port: 0, host: '127.0.0.1', allowInput: false, token: a }))
      .token as string;
    expect(b).toBe(a);

    // The token the phone already has still opens the door.
    const carried = await fetch(`${base()}/api/config`, { headers: bearer(a) });
    expect(carried.status).toBe(200);
  });

  it('mints a fresh token when the supplied one is empty (no accidental blank-token server)', async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, token: '' });
    expect(info.token).toBeTruthy();
    expect((info.token as string).length).toBeGreaterThan(8);
    // An empty Bearer must not authenticate against it.
    const blank = await fetch(`${base()}/api/config`, { headers: bearer('') });
    expect(blank.status).toBe(401);
  });

  it('still rotates the pairing code across a token-carrying restart', async () => {
    const first = await startRO();
    const token = first.token as string;
    const codeA = first.pairCode as string;
    await server.stop();

    const second = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, token });
    // The token is carried, the single-use pairing code is NOT — handing back a
    // burned code would be worse than asking for a fresh one.
    expect(second.token).toBe(token);
    expect(second.pairCode).not.toBe(codeA);
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
    // The PRODUCTION notify shape (DaemonPTYBridge): {source, title, body, ts},
    // with title null because OSC 9 carries no title. The fake used to emit a
    // `{message}` object that exists nowhere in the daemon — which is exactly
    // how #597 (the frontend reading `data.message`) shipped green.
    (sessionManager as unknown as EventEmitter).emit('session:notification', {
      sessionId: 's3',
      event: { source: 'osc9', title: null, body: 'Build finished, 3 tests failed', ts: 123 },
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
    // ★ The whole parsed notification reaches the browser VERBATIM — all four
    // fields, not just whichever one the frontend happened to read. #597 was a
    // field-name mismatch, and only an end-to-end shape assertion catches that.
    expect(text).toContain('"source":"osc9"');
    expect(text).toContain('"title":null');
    expect(text).toContain('"body":"Build finished, 3 tests failed"');
    expect(text).toContain('"ts":123');
    // Every attention payload is now identified so clients can dedup/replay.
    expect(text).toMatch(/"id":\d+/);
    expect(text).toContain('"epoch":"');
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
  it('names a pane by its program so an agent-less row is not just its own cwd twice', async () => {
    const info = await startRO();
    const res = await fetch(`http://127.0.0.1:${info.port}/api/sessions`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    const { sessions } = await res.json();
    // A quoted program path containing spaces must survive intact.
    expect(sessions[0].shell).toBe('pwsh');
    // A bare Windows path, and a POSIX one.
    expect(sessions[1].shell).toBe('pwsh');
    expect(sessions[2].shell).toBe('bash');
    // Arguments can carry secrets, so only the basename is ever surfaced.
    const wire = JSON.stringify(sessions);
    expect(wire).not.toContain('--token');
    expect(wire).not.toContain('Program Files');
  });

  it('carries the baseline security headers on the SSE stream response too', async () => {
    const info = await startRO();
    const ac = new AbortController();
    const sse = await fetch(
      `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
      { signal: ac.signal },
    );
    expect(sse.status).toBe(200);
    expect(sse.headers.get('x-frame-options')).toBe('DENY');
    expect(sse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(sse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(sse.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    ac.abort();
  });

  it('refuses a cross-site /api/pair load without touching the attempt budget', async () => {
    const info = await startRO();
    const code = info.pairCode as string;
    // A hostile page embedding <img src="http://127.0.0.1:<port>/api/pair?…">
    // reaches this route with Sec-Fetch-Site: cross-site stamped by the browser.
    const evil = await fetch(`${base()}/api/pair?code=ZZZZZZ`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(evil.status).toBe(403);
    expect((await evil.json()).error).toBe('cross-site request refused');
    // The attempt budget was untouched: the legitimate code still pairs.
    const ok = await fetch(`${base()}/api/pair?code=${code}`);
    expect(ok.status).toBe(200);
  });

  it('never advertises an expired pairing code — status() replaces it past the cooldown', async () => {
    const info = await startRO();
    const first = info.pairCode as string;
    // Jump past both the 10-min TTL and the 30-s regen cooldown.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60_000);
    try {
      const status = server.status();
      expect(status.pairCode).toHaveLength(6);
      expect(status.pairCode).not.toBe(first);
      expect(status.pairExpiresAt as number).toBeGreaterThan(realNow + 11 * 60_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('accepts an operator-listed extra Host (reverse-proxy front, e.g. tailscale serve)', async () => {
    const info = await server.start({
      port: 0,
      host: '127.0.0.1',
      allowInput: false,
      allowedHosts: ['machine.tail-net.ts.net'],
    });
    // 401 (not 403) proves the host gate passed and the token gate took over.
    const ok = await getWithHost(info.port as number, '/api/config', 'machine.tail-net.ts.net');
    expect(ok.status).toBe(401);
    // Anything not listed is still rejected.
    const bad = await getWithHost(info.port as number, '/api/config', 'evil.com');
    expect(bad.status).toBe(403);
  });

  it('brackets an IPv6 bind host in the advertised URL', async () => {
    let info: Awaited<ReturnType<typeof server.start>>;
    try {
      info = await server.start({ port: 0, host: '::1', allowInput: false });
    } catch {
      return; // environment without IPv6 loopback — nothing to assert
    }
    expect(info.urls?.[0]).toBe(`http://[::1]:${info.port}/?token=${info.token}`);
  });

  it('does not leak session-manager listeners when the bind itself fails', async () => {
    // Occupy a port, then ask the web server to bind the same one.
    const blockerInfo = await startRO();
    const em = sessionManager as unknown as EventEmitter;
    const second = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    await expect(
      second.start({ port: blockerInfo.port as number, host: '127.0.0.1', allowInput: false }),
    ).rejects.toThrow();
    // Only the FIRST (running) server's listeners remain.
    expect(em.listenerCount('session:critical')).toBe(1);
    expect(em.listenerCount('session:notification')).toBe(1);
    expect(second.isRunning).toBe(false);
  });

  // ── /api/events — the durable attention channel (#598) ─────────────────────
  const emitNotify = (sessionId: string, body: string) =>
    (sessionManager as unknown as EventEmitter).emit('session:notification', {
      sessionId,
      event: { source: 'osc9', title: null, body, ts: 1 },
    });

  type Backlog = {
    epoch: string;
    headId: number;
    reset: boolean;
    events: Array<Record<string, unknown>>;
  };
  const backlog = async (token: string, since?: string): Promise<Backlog> => {
    const q = since ? `?since=${encodeURIComponent(since)}` : '';
    const res = await fetch(`${base()}/api/events${q}`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    return (await res.json()) as Backlog;
  };

  /**
   * `reader.read()` on a silent stream never settles, so polling the deadline
   * only BETWEEN reads hangs until the Vitest timeout. Race each read against
   * the remaining budget and treat `null` as "deadline hit, stop reading".
   */
  const readWithin = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    deadline: number,
  ): Promise<ReadableStreamReadResult<Uint8Array> | null> => {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([reader.read(), budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** Open the SSE variant and read until `want` appears (or the deadline). */
  const readEventStream = async (url: string, want: RegExp, headers: Record<string, string> = {}) => {
    const ac = new AbortController();
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream', ...headers },
    });
    let text = '';
    if (res.status === 200 && res.body) {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const deadline = Date.now() + 700;
      while (Date.now() < deadline && !want.test(text)) {
        const chunk = await readWithin(reader, deadline);
        if (!chunk || chunk.done) break;
        if (chunk.value) text += Buffer.from(chunk.value).toString('utf8');
      }
    }
    ac.abort();
    return { status: res.status, text };
  };

  it('★ delivers an attention event raised while NO client was connected', async () => {
    const info = await startRO();
    const token = info.token as string;

    // Nobody is watching — the pane-stream fan-out is a no-op. Before the
    // attention log this event was simply gone (#598).
    emitNotify('s3', 'Build finished, 3 tests failed');

    const data = await backlog(token);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toMatchObject({
      id: 1,
      kind: 'notify',
      sessionId: 's3',
      source: 'osc9',
      title: null,
      body: 'Build finished, 3 tests failed',
    });
    expect(data.headId).toBe(1);
  });

  it('★ never lets a pane-supplied payload shadow the server-assigned identity', async () => {
    const info = await startRO();
    const token = info.token as string;

    // A pane can put anything in the notification event — including keys that
    // collide with the fields the client dedups and resyncs on.
    (sessionManager as unknown as EventEmitter).emit('session:notification', {
      sessionId: 's3',
      event: { source: 'osc9', title: null, body: 'spoofed', id: 999999, epoch: 'evil', kind: 'critical' },
    });

    const data = await backlog(token);
    expect(data.events).toHaveLength(1);
    expect(data.events[0].id).toBe(1);
    expect(data.events[0].kind).toBe('notify');
    expect(data.events[0].body).toBe('spoofed');
    expect(data.headId).toBe(1);

    // Same on the wire: the SSE body carries the server's id/epoch, not the payload's.
    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"body":"spoofed"/,
    );
    expect(out.text).toContain('"id":1');
    expect(out.text).not.toContain('"id":999999');
    expect(out.text).toContain(`"epoch":"${data.epoch}"`);
    expect(out.text).not.toContain('"epoch":"evil"');
  });

  it('★ treats a cursor from another epoch as a full resync', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s3', 'one');
    emitNotify('s3', 'two');

    const data = await backlog(token, 'bogus-epoch:57');
    expect(data.reset).toBe(true);
    expect(data.events.map((e) => e.body)).toEqual(['one', 'two']);
    expect(data.epoch).not.toBe('bogus-epoch');
  });

  it('★ gates /api/events like every other route — Bearer for JSON, ?token= for SSE only', async () => {
    const info = await startRO();
    const token = info.token as string;

    // JSON mode: no credentials, and a query token, are both refused.
    expect((await fetch(`${base()}/api/events`)).status).toBe(401);
    expect((await fetch(`${base()}/api/events?token=${encodeURIComponent(token)}`)).status).toBe(401);

    // SSE mode: `?token=` is accepted (EventSource cannot set headers)…
    const ok = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /event: reset/,
    );
    expect(ok.status).toBe(200);
    // …but only the real token.
    const bad = await readEventStream(`${base()}/api/events?token=nope`, /never/);
    expect(bad.status).toBe(401);
  });

  it('returns only what a matching cursor has not seen, and reports the head id', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s3', 'one');
    emitNotify('s3', 'two');
    emitNotify('s3', 'three');

    const all = await backlog(token);
    expect(all.reset).toBe(true);
    expect(all.headId).toBe(3);

    const since = await backlog(token, `${all.epoch}:2`);
    expect(since.reset).toBe(false);
    expect(since.events.map((e) => e.id)).toEqual([3]);
    expect(since.headId).toBe(3);

    // Fully caught up: nothing to replay, and still not a resync.
    const caughtUp = await backlog(token, `${all.epoch}:3`);
    expect(caughtUp.reset).toBe(false);
    expect(caughtUp.events).toEqual([]);
  });

  it('evicts the oldest entries past the cap while ids stay monotonic', async () => {
    const info = await startRO();
    const token = info.token as string;
    const CAP = 100; // ATTENTION_CAP — module-private, asserted by behaviour
    for (let i = 1; i <= CAP + 10; i++) emitNotify('s3', `evt-${i}`);

    const data = await backlog(token);
    expect(data.events).toHaveLength(CAP);
    // The oldest ten are gone; the newest is kept; ids never restart.
    expect(data.events[0].id).toBe(11);
    expect(data.events[CAP - 1].id).toBe(CAP + 10);
    expect(data.events[CAP - 1].body).toBe(`evt-${CAP + 10}`);
    expect(data.headId).toBe(CAP + 10);
    const ids = data.events.map((e) => e.id as number);
    expect(ids).toEqual(ids.slice().sort((a, b) => a - b));
  });

  it('evicts entries past the TTL (injected clock, no sleeping for 30 minutes)', async () => {
    // A dedicated server so the clock seam is under this test's control.
    let clock = 1_000_000;
    const aged = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      now: () => clock,
    });
    const info = await aged.start({ port: 0, host: '127.0.0.1', allowInput: false });
    const token = info.token as string;
    const port = info.port as number;
    const em = sessionManager as unknown as EventEmitter;
    try {
      em.emit('session:notification', {
        sessionId: 's3',
        event: { source: 'osc9', title: null, body: 'stale', ts: 1 },
      });
      // Past the 30-minute TTL, then a fresh event so eviction runs.
      clock += 31 * 60 * 1000;
      em.emit('session:notification', {
        sessionId: 's3',
        event: { source: 'osc9', title: null, body: 'fresh', ts: 2 },
      });

      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: bearer(token) });
      const data = (await res.json()) as Backlog;
      expect(data.events.map((e) => e.body)).toEqual(['fresh']);
      // The id space does NOT rewind just because an entry aged out.
      expect(data.headId).toBe(2);
    } finally {
      await aged.stop();
    }
  });

  it('SSE mode: emits ids, resets a foreign cursor, then replays before live events', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s2', 'backlogged');

    const ac = new AbortController();
    const res = await fetch(`${base()}/api/events?token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const pump = async (until: RegExp) => {
      const deadline = Date.now() + 700;
      while (Date.now() < deadline && !until.test(text)) {
        const chunk = await readWithin(reader, deadline);
        if (!chunk || chunk.done) break;
        if (chunk.value) text += Buffer.from(chunk.value).toString('utf8');
      }
    };
    await pump(/"body":"backlogged"/);
    // No cursor at all → told to resync, then handed the whole window.
    expect(text).toContain('event: reset');
    expect(text).toMatch(/id: [0-9a-f-]+:1\n/);
    expect(text.indexOf('event: reset')).toBeLessThan(text.indexOf('"body":"backlogged"'));

    // Live events keep flowing on the same stream, after the replay.
    emitNotify('s2', 'live-one');
    await pump(/"body":"live-one"/);
    ac.abort();
    expect(text.indexOf('"body":"backlogged"')).toBeLessThan(text.indexOf('"body":"live-one"'));
    expect(text).toMatch(/id: [0-9a-f-]+:2\n/);
  });

  it('SSE mode: a matching cursor replays only the missed tail, with no reset', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s2', 'seen-already');
    emitNotify('s2', 'missed-it');
    const epoch = (await backlog(token)).epoch;

    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}&since=${encodeURIComponent(`${epoch}:1`)}`,
      /"body":"missed-it"/,
    );
    expect(out.status).toBe(200);
    expect(out.text).not.toContain('event: reset');
    expect(out.text).not.toContain('seen-already');
    expect(out.text).toContain('"body":"missed-it"');
  });

  it('resumes from Last-Event-ID, which the browser resends on reconnect', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s2', 'before-drop');
    emitNotify('s2', 'after-drop');
    const epoch = (await backlog(token)).epoch;

    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"body":"after-drop"/,
      { 'Last-Event-ID': `${epoch}:1` },
    );
    expect(out.text).not.toContain('event: reset');
    expect(out.text).not.toContain('before-drop');
  });

  it('drops /api/events subscribers on stop() without touching the log', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s2', 'kept');
    await readEventStream(`${base()}/api/events?token=${encodeURIComponent(token)}`, /event: reset/);
    await server.stop();

    // A web-server restart is not an event-loss boundary: the daemon kept
    // running, so the recorded window (and its epoch) survives.
    const next = await startRO();
    const data = await backlog(next.token as string);
    expect(data.events.map((e) => e.body)).toEqual(['kept']);
  });
});
