import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type {
  ApprovalEvent,
  ApprovalRegistryApi,
  ApprovalRequest,
  ApprovalResolveResult,
} from '../../approvals/types';
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
  return { sessionManager, bridge, write, ...makeApprovals(), ...makeDevices() };
}

/**
 * A stand-in for Worker A's DeviceStore (M3). The real one owns the KDF and its
 * parameters, the per-device salt, `devices.json`, the derived-key cache and the
 * audit log — none of which the HTTP surface may know about, which is why the
 * fake is two functions: the web layer only ever asks "whose credential is
 * this?" and "mint one for the device I just named".
 *
 * `roster` is mutable so a test can revoke a device out from under a live
 * stream; `box.mintThrows` covers a roster the daemon cannot persist.
 */
function makeDevices() {
  const roster = new Map<string, { secret: string; name?: string; revoked: boolean }>();
  const resolveCalls: Array<{ deviceId: string; secret: string }> = [];
  const mintCalls: Array<{ name?: string }> = [];
  const touchCalls: string[] = [];
  const box = { mintThrows: false };
  let seq = 0;
  const devices: WebDeviceResolver = {
    async mint(params) {
      mintCalls.push({ ...params });
      if (box.mintThrows) throw new Error('roster write failed');
      seq += 1;
      const deviceId = `dev-${seq}`;
      const deviceSecret = `s3cr3t-${seq}`;
      roster.set(deviceId, { secret: deviceSecret, name: params.name, revoked: false });
      return { deviceId, deviceSecret };
    },
    async resolve(deviceId, secret) {
      resolveCalls.push({ deviceId, secret });
      const rec = roster.get(deviceId);
      // Unknown and revoked are separate answers on purpose — the phone shows
      // different copy for "never heard of you" and "the operator threw you out".
      if (!rec) return { ok: false, reason: 'unknown' };
      if (rec.revoked) return { ok: false, reason: 'revoked' };
      if (rec.secret !== secret) return { ok: false, reason: 'unknown' };
      return { ok: true, deviceId, ...(rec.name ? { name: rec.name } : {}) };
    },
    touch(deviceId) {
      touchCalls.push(deviceId);
    },
  };
  return {
    devices,
    deviceRoster: roster,
    deviceResolveCalls: resolveCalls,
    deviceMintCalls: mintCalls,
    deviceTouchCalls: touchCalls,
    deviceBox: box,
  };
}

/**
 * A stand-in for the daemon's ApprovalRegistry (Worker A). The real one owns
 * CAS, persistence, the prompt re-verify and the keystroke map — none of which
 * the HTTP surface is allowed to know about, which is exactly why the fake can
 * be this small: the web layer only lists, resolves, and republishes.
 *
 * `records` is mutable so a test can script what is pending; `resolveResult` is
 * what the next resolve() answers, which is how every status-code mapping gets
 * exercised without a real pane to refuse.
 */
function makeApprovals() {
  // The registry hands back an unsubscribe closure rather than taking off(), so
  // the fake keeps the listener set itself — and the leak test can count it.
  const listeners = new Set<(e: ApprovalEvent) => void>();
  const records: ApprovalRequest[] = [];
  const resolveCalls: Array<{ id: string; decision: string; resolvedBy: string }> = [];
  const box: { result: ApprovalResolveResult; listThrows: boolean } = {
    result: { ok: true, request: mkApproval({ state: 'resolved', decision: 'approve', resolvedBy: 'web' }) },
    listThrows: false,
  };
  const approvals: ApprovalRegistryApi = {
    list: () => {
      if (box.listThrows) throw new Error('registry exploded');
      return {
        pending: records.filter((r) => r.state === 'pending'),
        recentlyResolved: records.filter((r) => r.state !== 'pending'),
      };
    },
    resolve: async (params) => {
      resolveCalls.push({ ...params });
      return box.result;
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emitApproval = (type: ApprovalEvent['type'], request: ApprovalRequest) => {
    for (const l of listeners) l({ type, request });
  };
  return { approvals, approvalRecords: records, resolveCalls, emitApproval, approvalListeners: listeners, approvalBox: box };
}

/** A pending request, with just enough shape to be recognisable on the wire. */
function mkApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap-1',
    sessionId: 's1',
    agent: 'claude',
    kind: 'awaiting_input',
    createdAt: 1_700_000_000_000,
    state: 'pending',
    ...over,
  };
}

describe('WebTerminalServer', () => {
  let server: WebTerminalServer;
  let bridge: EventEmitter;
  let write: ReturnType<typeof vi.fn>;
  let sessionManager: DaemonSessionManager;
  let approvalRecords: ApprovalRequest[];
  let resolveCalls: Array<{ id: string; decision: string; resolvedBy: string }>;
  let emitApproval: (type: ApprovalEvent['type'], request: ApprovalRequest) => void;
  let approvalListeners: Set<(e: ApprovalEvent) => void>;
  let approvalBox: { result: ApprovalResolveResult; listThrows: boolean };
  let deviceRoster: Map<string, { secret: string; name?: string; revoked: boolean }>;
  let deviceMintCalls: Array<{ name?: string }>;
  let deviceTouchCalls: string[];
  let deviceBox: { mintThrows: boolean };

  beforeEach(() => {
    const deps = makeDeps();
    bridge = deps.bridge;
    write = deps.write;
    sessionManager = deps.sessionManager;
    approvalRecords = deps.approvalRecords;
    resolveCalls = deps.resolveCalls;
    emitApproval = deps.emitApproval;
    approvalListeners = deps.approvalListeners;
    approvalBox = deps.approvalBox;
    deviceRoster = deps.deviceRoster;
    deviceMintCalls = deps.deviceMintCalls;
    deviceTouchCalls = deps.deviceTouchCalls;
    deviceBox = deps.deviceBox;
    server = new WebTerminalServer({
      sessionManager: deps.sessionManager,
      approvals: deps.approvals,
      devices: deps.devices,
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

  it('/api/pair with the right code returns a credential once, then 403 (single use)', async () => {
    const info = await startRO();
    const code = info.pairCode as string;
    const token = info.token as string;

    // No auth header needed — pairing is the only unauthenticated /api route.
    const ok = await fetch(`${base()}/api/pair?code=${code}`);
    expect(ok.status).toBe(200);
    // M3: what the phone gets is ITS OWN credential, never the shared operator
    // token — that is the whole point of making the token durable revocable.
    expect(await ok.json()).toEqual({
      deviceId: 'dev-1',
      deviceSecret: 's3cr3t-1',
      token: 'dev-1.s3cr3t-1',
    });
    expect(token).not.toBe('dev-1.s3cr3t-1');

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

  // W4 (#608): the HTML page carries the FULL policy — per-build inline-script
  // hashes instead of 'unsafe-inline', and connect-src 'self' so a future XSS
  // regression could execute but never exfiltrate the token.
  it('serves GET / with a full CSP: script hashes + connect-src self', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-csp-'));
    fs.writeFileSync(
      path.join(dir, 'terminal.html'),
      '<html><head><script>var a=1;</script></head><body><script>var b=2;</script></body></html>',
    );
    const deps = makeDeps();
    const csps = new WebTerminalServer({
      sessionManager: deps.sessionManager,
      log: () => { /* silent */ },
      assetsDir: dir,
    });
    try {
      const info = await csps.start({ port: 0, host: '127.0.0.1', allowInput: false });
      const res = await fetch(`http://127.0.0.1:${info.port}/`);
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // One hash per inline <script> block, no 'unsafe-inline' for scripts.
      expect(csp.match(/'sha256-[A-Za-z0-9+/=]+'/g)).toHaveLength(2);
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      // JSON/API responses keep the minimal baseline policy (no hashes needed).
      const api = await fetch(`http://127.0.0.1:${info.port}/api/config`, {
        headers: { Authorization: `Bearer ${info.token}` },
      });
      expect(api.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    } finally {
      if (csps.isRunning) await csps.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  // ── approvals (M2) ─────────────────────────────────────────────────────────
  const postApproval = (token: string, id: string, body: unknown) =>
    fetch(`${base()}/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('gates the approval routes on the Bearer token — a query token is not enough', async () => {
    const info = await startRO();
    const token = info.token as string;
    approvalRecords.push(mkApproval());

    expect((await fetch(`${base()}/api/approvals`)).status).toBe(401);
    expect((await fetch(`${base()}/api/approvals?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/approvals`, { headers: bearer(token) })).status).toBe(200);

    // The resolve route is a write; an unauthenticated one must not reach the
    // registry at all, not merely fail late.
    const unauth = await fetch(`${base()}/api/approvals/ap-1`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(unauth.status).toBe(401);
    expect(resolveCalls).toEqual([]);
  });

  it('lists pending requests and the settled tail, projecting only browser-safe fields', async () => {
    const info = await startRO();
    const token = info.token as string;
    // A record carrying registry-internal extras the projection must drop —
    // the registry is free to grow fields, the wire is not.
    approvalRecords.push({
      ...mkApproval({
        id: 'ap-pending',
        sessionId: 's2',
        screenTail: 'Allow edit to src/index.ts?',
        question: 'Which database should I use?',
        options: ['Postgres', 'SQLite'],
      }),
      keystrokes: 'y\r',
      paneEnv: { ANTHROPIC_API_KEY: 'sk-secret' },
      // The rest of the AskUserQuestion tool_input. Only question/options were
      // asked for; everything else stays daemon-side.
      toolInput: { header: 'Database', multiSelect: false, prompt: 'sk-tool-secret' },
    } as ApprovalRequest);
    approvalRecords.push(
      mkApproval({
        id: 'ap-done',
        state: 'resolved',
        decision: 'approve',
        resolvedBy: 'deck',
        resolvedAt: 1_700_000_000_900,
      }),
    );

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: Array<Record<string, unknown>>;
      recentlyResolved: Array<Record<string, unknown>>;
    };

    expect(body.pending.map((r) => r.id)).toEqual(['ap-pending']);
    expect(body.pending[0]).toMatchObject({
      sessionId: 's2',
      agent: 'claude',
      kind: 'awaiting_input',
      state: 'pending',
      // The tail is the whole point of the list route: it is what the human
      // reads before answering from a phone.
      screenTail: 'Allow edit to src/index.ts?',
      // …and when the agent asked a structured question, the phone should not
      // have to reverse-engineer it out of a screen tail.
      question: 'Which database should I use?',
      options: ['Postgres', 'SQLite'],
    });
    // Settled requests ride along so a 409 can be explained, not just reported.
    // Bounding and ordering that half is the REGISTRY's job (it is the record of
    // what happened); this surface passes its answer through unreordered.
    expect(body.recentlyResolved.map((r) => r.id)).toEqual(['ap-done']);
    expect(body.recentlyResolved[0]).toMatchObject({
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'deck',
    });

    const wire = JSON.stringify(body);
    expect(wire).not.toContain('sk-secret');
    expect(wire).not.toContain('keystrokes');
    // question/options are the ONLY things extracted from the tool_input. The
    // rest of it — and any field a later registry change adds — must not ride
    // along just because it sits on the same record.
    expect(wire).not.toContain('toolInput');
    expect(wire).not.toContain('sk-tool-secret');
    expect(wire).not.toContain('multiSelect');
    expect(wire).not.toContain('"header"');
  });

  it('omits question/options entirely when the request has none', async () => {
    const info = await startRO();
    const token = info.token as string;
    // A plain permission prompt: no AskUserQuestion, so no structured question.
    approvalRecords.push(mkApproval({ id: 'ap-plain' }));
    approvalRecords.push(mkApproval({ id: 'ap-plain-done', state: 'resolved', resolvedBy: 'web' }));

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    const body = (await res.json()) as {
      pending: Array<Record<string, unknown>>;
      recentlyResolved: Array<Record<string, unknown>>;
    };
    // Absent, not null and not an empty string — the frontend renders on
    // presence, so a fabricated empty value would draw an empty question card.
    expect('question' in body.pending[0]).toBe(false);
    expect('options' in body.pending[0]).toBe(false);
    expect('question' in body.recentlyResolved[0]).toBe(false);
    expect('options' in body.recentlyResolved[0]).toBe(false);
  });

  it('projects question/options on the settled half too, empty list included', async () => {
    const info = await startRO();
    const token = info.token as string;
    // Both halves go through the same projection — a 409 explanation should be
    // able to say what was asked, not just that someone answered.
    approvalRecords.push(
      mkApproval({
        id: 'ap-answered',
        state: 'resolved',
        decision: 'approve',
        resolvedBy: 'deck',
        question: 'Ship it?',
        // An empty list is a recorded fact, not a missing field: presence, not
        // truthiness, decides whether it is projected.
        options: [],
      }),
    );

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    const body = (await res.json()) as { recentlyResolved: Array<Record<string, unknown>> };
    expect(body.recentlyResolved[0]).toMatchObject({
      id: 'ap-answered',
      question: 'Ship it?',
      options: [],
      resolvedBy: 'deck',
    });
  });

  it('★ resolves an approval on a READ-ONLY server, while /api/input on that same server stays 403', async () => {
    // The carve-out that makes M2 worth having: answering a prompt the daemon
    // raised is a narrower grant than --allow-input, so it must not require it.
    const info = await startRO();
    const token = info.token as string;
    approvalRecords.push(mkApproval({ id: 'ap-ro' }));

    const ok = await postApproval(token, 'ap-ro', { decision: 'approve' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ state: 'resolved' });
    // The caller supplied a DECISION, never bytes; the registry picks those.
    // `resolvedBy` names WHO answered — here the operator token, not the
    // surface. It used to be the constant 'web' for every caller alike.
    expect(resolveCalls).toEqual([{ id: 'ap-ro', decision: 'approve', resolvedBy: 'operator' }]);

    // …and the carve-out is exactly one route wide. Free-form input is still
    // refused on this very same server.
    const input = await fetch(`${base()}/api/input?session=s1`, {
      method: 'POST',
      headers: bearer(token),
      body: 'rm -rf /\r',
    });
    expect(input.status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });

  it('passes a deny through unchanged', async () => {
    const info = await startRO();
    approvalRecords.push(mkApproval({ id: 'ap-deny' }));
    const res = await postApproval(info.token as string, 'ap-deny', { decision: 'deny' });
    expect(res.status).toBe(200);
    expect(resolveCalls[0].decision).toBe('deny');
  });

  it('maps every registry refusal onto its own status code', async () => {
    const cases: Array<{ result: ApprovalResolveResult; status: number; body: Record<string, unknown> }> = [
      // Someone else answered first — and the loser is told who.
      {
        result: { ok: false, reason: 'already-resolved', resolvedBy: 'deck' },
        status: 409,
        body: { error: 'already-resolved', resolvedBy: 'deck' },
      },
      // Gone. 410, not 404: it existed, stop showing it.
      { result: { ok: false, reason: 'expired' }, status: 410, body: { error: 'expired' } },
      { result: { ok: false, reason: 'prompt-gone' }, status: 410, body: { error: 'prompt-gone' } },
      // A supersede reports reason 'expired' with the precise state on the
      // record — same status, different sentence for the human.
      {
        result: { ok: false, reason: 'expired', request: mkApproval({ state: 'superseded' }) },
        status: 410,
        body: { error: 'expired', state: 'superseded' },
      },
      // No keystroke map for this agent — the daemon refuses to guess bytes.
      { result: { ok: false, reason: 'unsupported-agent' }, status: 501, body: { error: 'unsupported-agent' } },
      { result: { ok: false, reason: 'not-found' }, status: 404, body: { error: 'not-found' } },
    ];

    const info = await startRO();
    const token = info.token as string;
    for (const c of cases) {
      approvalBox.result = c.result;
      const res = await postApproval(token, 'ap-1', { decision: 'approve' });
      expect(res.status, `reason ${'reason' in c.result ? c.result.reason : 'ok'}`).toBe(c.status);
      expect(await res.json()).toEqual(c.body);
    }
  });

  it('refuses a body that is not an approve/deny decision, without touching the registry', async () => {
    const info = await startRO();
    const token = info.token as string;

    for (const body of [{ decision: 'maybe' }, { decision: true }, {}, '', 'not json']) {
      const res = await postApproval(token, 'ap-1', body);
      expect(res.status, `body ${JSON.stringify(body)}`).toBe(400);
    }
    // A decision the surface cannot understand must never reach a PTY.
    expect(resolveCalls).toEqual([]);
  });

  it('404s a resolve with no id at all', async () => {
    const info = await startRO();
    const res = await fetch(`${base()}/api/approvals/`, {
      method: 'POST',
      headers: bearer(info.token as string),
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(404);
    expect(resolveCalls).toEqual([]);
  });

  it('answers 503 on a daemon that wired no registry (rather than pretending)', async () => {
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false });
    const url = `http://127.0.0.1:${info.port}/api/approvals`;
    try {
      const list = await fetch(url, { headers: bearer(info.token as string) });
      expect(list.status).toBe(503);
      const resolve = await fetch(`${url}/ap-1`, {
        method: 'POST',
        headers: bearer(info.token as string),
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(resolve.status).toBe(503);
    } finally {
      await bare.stop();
    }
  });

  it('★ publishes the approval lifecycle on /api/events, in the one shared id space', async () => {
    const info = await startRO();
    const token = info.token as string;
    const rec = mkApproval({ id: 'ap-9', sessionId: 's2', screenTail: 'Allow edit to src/index.ts?' });

    emitApproval('create', rec);
    emitNotify('s3', 'unrelated'); // interleaved: one cursor covers both kinds
    emitApproval('resolve', {
      ...rec,
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'web',
      resolvedAt: 1_700_000_000_500,
    });

    const data = await backlog(token);
    expect(data.events.map((e) => e.kind)).toEqual(['approval', 'notify', 'approval']);
    expect(data.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(data.events[0]).toMatchObject({
      approvalId: 'ap-9',
      phase: 'create',
      state: 'pending',
      sessionId: 's2',
      agent: 'claude',
    });
    expect(data.events[2]).toMatchObject({
      approvalId: 'ap-9',
      phase: 'resolve',
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'web',
    });
    // The record's id is `approvalId` on the wire: `id` belongs to the replay
    // cursor, and a payload must never be able to shadow it.
    expect(data.events[0].id).toBe(1);
  });

  it('★ replays a missed approval from Last-Event-ID, like any other event', async () => {
    const info = await startRO();
    const token = info.token as string;
    const rec = mkApproval({ id: 'ap-9', sessionId: 's2' });
    emitApproval('create', rec);
    emitApproval('expire', { ...rec, state: 'expired' });
    const epoch = (await backlog(token)).epoch;

    // A phone that saw the creation and then lost signal gets ONLY the expiry.
    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"phase":"expire"/,
      { 'Last-Event-ID': `${epoch}:1` },
    );
    expect(out.status).toBe(200);
    expect(out.text).toContain('event: approval');
    expect(out.text).not.toContain('event: reset');
    expect(out.text).not.toContain('"phase":"create"');
    expect(out.text).toMatch(/id: [0-9a-f-]+:2\n/);
  });

  it('delivers an approval live to an already-connected /api/events stream', async () => {
    const info = await startRO();
    const token = info.token as string;
    // Emit AFTER the stream is open, so this covers the live path rather than
    // the replay one.
    setTimeout(() => emitApproval('create', mkApproval({ id: 'ap-live', sessionId: 's3' })), 20);

    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"approvalId":"ap-live"/,
    );
    expect(out.status).toBe(200);
    expect(out.text).toContain('event: approval');
    expect(out.text).toContain('"phase":"create"');
  });

  it('keeps the tail AND the question off the event wire — the event is a nudge, the route is the truth', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitApproval(
      'create',
      mkApproval({
        id: 'ap-tail',
        screenTail: 'SECRET-TAIL-CONTENT',
        question: 'QUESTION-BODY-TEXT',
        options: ['OPTION-ALPHA', 'OPTION-BETA'],
      }),
    );

    const data = await backlog(token);
    expect(data.events[0]).toMatchObject({ approvalId: 'ap-tail' });
    // None of the content fields ride the channel: they are fanned out to every
    // client and held in the replay window for the whole TTL. The event says
    // "something needs you", `GET /api/approvals` says what.
    const wire = JSON.stringify(data.events);
    expect(wire).not.toContain('SECRET-TAIL-CONTENT');
    expect(wire).not.toContain('QUESTION-BODY-TEXT');
    expect(wire).not.toContain('OPTION-ALPHA');
    expect(wire).not.toContain('OPTION-BETA');
  });

  it('does not tee approvals onto the pane streams (no old-frontend noise)', async () => {
    const info = await startRO();
    const token = info.token as string;
    const ac = new AbortController();
    const sse = await fetch(`${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
    });
    expect(sse.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    emitApproval('create', mkApproval({ id: 'ap-pane' }));
    // A `critical` still rides the pane stream (back-compat), so waiting for it
    // proves the approval had its chance to appear and did not.
    (sessionManager as unknown as EventEmitter).emit('session:critical', {
      sessionId: 's2',
      event: { action: 'delete files' },
    });

    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !text.includes('event: critical')) {
      const chunk = await readWithin(reader, deadline);
      if (!chunk || chunk.done) break;
      if (chunk.value) text += Buffer.from(chunk.value).toString('utf8');
    }
    ac.abort();
    expect(text).toContain('event: critical');
    expect(text).not.toContain('event: approval');
    expect(text).not.toContain('ap-pane');
  });

  it('removes the registry listener on stop (no double-publish across restarts)', async () => {
    await startRO();
    expect(approvalListeners.size).toBe(1);
    await server.stop();
    expect(approvalListeners.size).toBe(0);
    // Restart: still exactly one, so an event is published once, not twice.
    await startRO();
    expect(approvalListeners.size).toBe(1);
  });

  it('survives a registry whose list() throws', async () => {
    const info = await startRO();
    approvalBox.listThrows = true;
    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(info.token as string) });
    expect(res.status).toBe(500);
    // The server is still up and every other route still answers.
    expect((await fetch(`${base()}/api/config`, { headers: bearer(info.token as string) })).status).toBe(200);
  });

  // ── per-device credentials (M3) ────────────────────────────────────────────

  /** Name a device, redeem its code, and return what the phone would store. */
  const pairDevice = async (name?: string) => {
    const started = server.startPairing({ name });
    if (!started.ok) throw new Error(`startPairing refused: ${started.error}`);
    const res = await fetch(`${base()}/api/pair?code=${started.code}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { deviceId: string; deviceSecret: string; token: string };
  };

  /** Open a pane SSE stream with a credential in the Authorization header. */
  const openStream = async (cred: string) => {
    const ac = new AbortController();
    const res = await fetch(`${base()}/api/stream?session=s1`, { signal: ac.signal, headers: bearer(cred) });
    const reader = res.body ? (res.body as ReadableStream<Uint8Array>).getReader() : null;
    return { ac, res, reader };
  };

  /** Open the attention SSE stream with a credential in the Authorization header. */
  const openEvents = async (cred: string) => {
    const ac = new AbortController();
    const res = await fetch(`${base()}/api/events`, {
      signal: ac.signal,
      headers: { ...bearer(cred), Accept: 'text/event-stream' },
    });
    const reader = res.body ? (res.body as ReadableStream<Uint8Array>).getReader() : null;
    return { ac, res, reader };
  };

  /** True once the SERVER ends the stream; false if it is still open at the deadline. */
  const closedWithin = async (reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const chunk = await readWithin(reader, deadline);
      if (!chunk) return false; // deadline hit with the stream still alive
      if (chunk.done) return true;
    }
    return false;
  };

  it('★ pairs a NAMED device and hands it its own credential, not the shared token', async () => {
    const info = await startRO();
    const paired = await pairDevice('Wife phone');

    expect(paired.deviceId).toBe('dev-1');
    // The composed `deviceId.secret` is what the client presents as its Bearer;
    // the operator token is a different secret and stays with the operator.
    expect(paired.token).toBe(`${paired.deviceId}.${paired.deviceSecret}`);
    expect(paired.token).not.toBe(info.token);
    // The operator named the device BEFORE the code existed (§3): a roster of
    // UUIDs cannot be operated, so the name has to reach the store.
    expect(deviceMintCalls).toEqual([{ name: 'Wife phone' }]);

    // A second pairing is a DIFFERENT device — that is the whole point.
    const second = await pairDevice('Tablet');
    expect(second.deviceId).not.toBe(paired.deviceId);
    expect(second.deviceSecret).not.toBe(paired.deviceSecret);
  });

  it('★ authenticates the routes a phone actually uses with a device credential', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    approvalRecords.push(mkApproval({ id: 'ap-dev' }));

    expect((await fetch(`${base()}/api/config`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/sessions`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/approvals`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/events`, { headers: bearer(token) })).status).toBe(200);

    // Answering a prompt is the reason the phone exists; a device must be able
    // to do it on a read-only server exactly as the operator can.
    const resolved = await postApproval(token, 'ap-dev', { decision: 'approve' });
    expect(resolved.status).toBe(200);
    // ★ The record names the DEVICE that pressed the key. This is the one
    // action in the whole surface that writes bytes into somebody's terminal,
    // and it used to be attributed to the constant 'web' — so after the fact
    // the roster could not say which paired phone did it.
    expect(resolveCalls).toEqual([
      { id: 'ap-dev', decision: 'approve', resolvedBy: 'device Phone (dev-1)' },
    ]);

    // Every authenticated device request is reported to the roster, so
    // `lastSeenAt` reflects use rather than only the pairing moment.
    expect(deviceTouchCalls.length).toBeGreaterThan(0);
    expect(new Set(deviceTouchCalls)).toEqual(new Set(['dev-1']));

    // Both SSE routes, credential in the header.
    const pane = await openStream(token);
    expect(pane.res.status).toBe(200);
    pane.ac.abort();
    const attn = await openEvents(token);
    expect(attn.res.status).toBe(200);
    attn.ac.abort();
  });

  it('★ leaves the operator token authenticating every route, device store or not', async () => {
    const info = await startRW();
    const token = info.token as string;
    approvalRecords.push(mkApproval({ id: 'ap-op' }));

    expect((await fetch(`${base()}/api/config`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/sessions`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/approvals`, { headers: bearer(token) })).status).toBe(200);
    expect((await postApproval(token, 'ap-op', { decision: 'deny' })).status).toBe(200);
    expect(
      (await fetch(`${base()}/api/input?session=s1`, { method: 'POST', headers: bearer(token), body: 'hi' })).status,
    ).toBe(204);

    // Including the `?token=` SSE exception, which is what the CLI's advertised
    // `http://…/?token=…` URLs rely on.
    const ac = new AbortController();
    const pane = await fetch(`${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
    });
    expect(pane.status).toBe(200);
    ac.abort();
    const attn = await readEventStream(`${base()}/api/events?token=${encodeURIComponent(token)}`, /event: reset/);
    expect(attn.status).toBe(200);

    // …and the daemon-side control surface is untouched by M3.
    expect(server.status().token).toBe(token);
    expect(server.refreshPairCode().pairCode).toMatch(/^[A-Z2-9]{6}$/);
  });

  it('★ 401s a revoked device with reason `revoked` AND kills its live streams at once', async () => {
    await startRO();
    const victim = await pairDevice('Old phone');
    const bystander = await pairDevice('Keeps working');

    const victimPane = await openStream(victim.token);
    const victimAttn = await openEvents(victim.token);
    const bystanderPane = await openStream(bystander.token);
    expect(victimPane.res.status).toBe(200);
    expect(victimAttn.res.status).toBe(200);
    expect(bystanderPane.res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    // The store's half of a revoke (Worker A persists first); then the seam the
    // daemon calls to make it immediate rather than eventual.
    deviceRoster.get(victim.deviceId)!.revoked = true;
    expect(server.disconnectDevice(victim.deviceId)).toBe(2);

    // The revoked device's streams are gone NOW, not on its next reconnect.
    expect(await closedWithin(victimPane.reader!, 1000)).toBe(true);
    expect(await closedWithin(victimAttn.reader!, 1000)).toBe(true);
    // …and nobody else's are.
    expect(await closedWithin(bystanderPane.reader!, 150)).toBe(false);

    // The next request says WHY, so the phone can show honest copy instead of
    // guessing between "server restarted" and "you were thrown out".
    const after = await fetch(`${base()}/api/sessions`, { headers: bearer(victim.token) });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: 'unauthorized', reason: 'revoked' });

    // The bystander is unaffected by its neighbour's revocation.
    expect((await fetch(`${base()}/api/sessions`, { headers: bearer(bystander.token) })).status).toBe(200);

    victimPane.ac.abort();
    victimAttn.ac.abort();
    bystanderPane.ac.abort();
  });

  it('distinguishes an unknown credential from a revoked one', async () => {
    const info = await startRO();
    await pairDevice('Phone');

    // A credential from another daemon / a wiped roster.
    const unknown = await fetch(`${base()}/api/sessions`, { headers: bearer('dev-404.whatever') });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'unauthorized', reason: 'unknown' });

    // The right device id with the wrong secret is 'unknown' too — never
    // 'revoked', which would confirm the id exists.
    const wrongSecret = await fetch(`${base()}/api/sessions`, { headers: bearer('dev-1.not-the-secret') });
    expect(wrongSecret.status).toBe(401);
    expect((await wrongSecret.json()).reason).toBe('unknown');

    // A bad operator token reads the same way.
    const badToken = await fetch(`${base()}/api/sessions`, { headers: bearer(`${info.token}x`) });
    expect(badToken.status).toBe(401);
    expect((await badToken.json()).reason).toBe('unknown');
  });

  it('★ refuses a device credential in ?token= — the SSE query exception is operator-only', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const q = encodeURIComponent(token);

    // A device secret is durable and never expires; a query string is the one
    // place a credential is guaranteed to be written down.
    const pane = await fetch(`${base()}/api/stream?session=s1&token=${q}`);
    expect(pane.status).toBe(401);
    expect((await pane.json()).reason).toBe('unknown');
    const attn = await readEventStream(`${base()}/api/events?token=${q}`, /never/);
    expect(attn.status).toBe(401);

    // The same credential in the header opens both.
    const okPane = await openStream(token);
    expect(okPane.res.status).toBe(200);
    okPane.ac.abort();
  });

  it('★ refuses to mint over a plaintext bind, and --allow-host does NOT buy an exception', async () => {
    // A real non-loopback bind: the gate reads the BIND, because that is the
    // only thing about the transport the daemon actually knows.
    const info = await server.start({ port: 0, host: '0.0.0.0', allowInput: false });
    const port = info.port as number;

    const refusedUpFront = server.startPairing({ name: 'Phone' });
    expect(refusedUpFront.ok).toBe(false);
    if (!refusedUpFront.ok) {
      // Actionable: it names BOTH ways out, not just the refusal — HTTPS in
      // one command, or pair before exposing.
      expect(refusedUpFront.error).toContain('wmux web --tailscale');
      expect(refusedUpFront.error).toContain('pair over loopback');
      // …and does not oversell the second one: on a plaintext bind the
      // credential still crosses the wire on every request afterwards.
      expect(refusedUpFront.error).toContain('every later request');
    }

    // And redemption refuses too, since the operator may have re-exposed the
    // server after minting a code. The code is NOT burned by the refusal.
    const code = server.status().pairCode as string;
    const denied = await getWithHost(port, `/api/pair?code=${code}`, `127.0.0.1:${port}`);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('insecure-transport');
    expect(deviceMintCalls).toEqual([]);
    expect(server.status().pairCode).toBe(code);
  });

  it('★ a forged Host cannot talk a plaintext bind into minting a credential', async () => {
    // This used to work. `--allow-host` named the TLS front, and a request whose
    // Host matched was allowed to mint — but Host is written by the caller, so
    // anyone who could reach the plaintext port (and had the pair code) sent
    // `Host: machine.tail-net.ts.net` straight to the LAN address, skipped the
    // TLS front, and walked off with a credential that never expires.
    const fronted = await server.start({
      port: 0,
      host: '0.0.0.0',
      allowInput: false,
      allowedHosts: ['machine.tail-net.ts.net'],
    });

    // Refused up front now: --allow-host is a DNS-rebinding allowlist, not
    // evidence that this particular connection was encrypted.
    const started = server.startPairing({ name: 'Phone' });
    expect(started.ok).toBe(false);

    // …and the same is true at redemption, sending the exact header an attacker
    // would forge. Nothing is minted.
    const code = server.status().pairCode as string;
    const forged = await getWithHost(
      fronted.port as number,
      `/api/pair?code=${code}`,
      'machine.tail-net.ts.net',
    );
    expect(forged.status).toBe(403);
    expect(JSON.parse(forged.body).error).toBe('insecure-transport');
    expect(deviceMintCalls).toEqual([]);
  });

  it('mints on a loopback bind without an allow-host front', async () => {
    await startRO();
    const started = server.startPairing({ name: 'Desk browser' });
    expect(started.ok).toBe(true);
  });

  it('does not burn the pairing code when the roster cannot be persisted', async () => {
    await startRO();
    const started = server.startPairing({ name: 'Phone' });
    if (!started.ok) throw new Error(started.error);
    deviceBox.mintThrows = true;

    const failed = await fetch(`${base()}/api/pair?code=${started.code}`);
    expect(failed.status).toBe(500);
    // A credential the daemon cannot remember is one the operator can never
    // revoke, so it must not be handed out — and the operator must not be left
    // re-reading a code that has already been consumed.
    expect(server.status().pairCode).toBe(started.code);

    deviceBox.mintThrows = false;
    const retried = await fetch(`${base()}/api/pair?code=${started.code}`);
    expect(retried.status).toBe(200);
  });

  it('★ status() says out loud whether per-device revocation is actually armed', async () => {
    // Armed: a store is wired, so the operator can cut off one phone.
    const armed = await startRO();
    expect(armed.deviceCredentials).toBe(true);
    expect(server.status().deviceCredentials).toBe(true);

    // NOT armed: pairing still works, but it hands out the shared token and
    // there is nothing to revoke device-by-device. An operator who believed
    // otherwise would leave a lost phone's access alive thinking they cut it,
    // so this must reach `wmux web --status` and the GUI — not just a log line.
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    try {
      const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false });
      expect(info.deviceCredentials).toBe(false);
      // Explicitly false, never absent: a missing field reads as "old daemon"
      // on the GUI side and would be rendered as unknown rather than as off.
      expect('deviceCredentials' in info).toBe(true);
    } finally {
      await bare.stop();
    }

    // A stopped server has no posture to report.
    expect(await bare.stop()).toEqual({ stopped: false });
    expect(bare.status()).toEqual({ running: false });
  });

  it('falls back to the shared token on a daemon that wired no device store', async () => {
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false });
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/pair?code=${info.pairCode}`);
      expect(res.status).toBe(200);
      // Degraded, not broken: pairing still works, but there is no per-device
      // identity to revoke on this server.
      expect(await res.json()).toEqual({ token: info.token });
      // And a device-shaped credential authenticates nothing here.
      const dev = await fetch(`http://127.0.0.1:${info.port}/api/sessions`, { headers: bearer('dev-1.s3cr3t-1') });
      expect(dev.status).toBe(401);
    } finally {
      await bare.stop();
    }
  });

  it('keeps the pairing name across a burned code, and drops it once redeemed', async () => {
    await startRO();
    const started = server.startPairing({ name: 'Named phone' });
    if (!started.ok) throw new Error(started.error);

    // Burn the attempt budget, wait out the cooldown, and let the server mint a
    // replacement code: the operator is still pairing the SAME device.
    for (let i = 0; i < 5; i++) await fetch(`${base()}/api/pair?code=ZZZZZZ`);
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
    let replacement: string;
    try {
      await fetch(`${base()}/api/pair?code=ZZZZZZ`);
      replacement = server.status().pairCode as string;
    } finally {
      nowSpy.mockRestore();
    }
    expect(replacement).toHaveLength(6);
    expect(replacement).not.toBe(started.code);

    const paired = await fetch(`${base()}/api/pair?code=${replacement}`);
    expect(paired.status).toBe(200);
    expect(deviceMintCalls).toEqual([{ name: 'Named phone' }]);

    // Redeeming consumes the name: the next device must not inherit it.
    server.refreshPairCode();
    const next = server.status().pairCode as string;
    expect((await fetch(`${base()}/api/pair?code=${next}`)).status).toBe(200);
    expect(deviceMintCalls[1]).toEqual({ name: undefined });
  });

  // ── stream tickets (B3) ────────────────────────────────────────────────────

  /** Ask for the `?ticket=` capability the way a browser device would. */
  const getTicket = (cred: string) =>
    fetch(`${base()}/api/stream-ticket`, { method: 'POST', headers: bearer(cred) });

  const ticketFor = async (cred: string): Promise<string> => {
    const res = await getTicket(cred);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expiresAt: number };
    expect(typeof body.ticket).toBe('string');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    return body.ticket;
  };

  it('★ issues a stream ticket to a device, and it opens BOTH SSE routes', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const ticket = await ticketFor(token);

    // The whole point: a URL a browser EventSource can actually be given.
    const ac = new AbortController();
    const pane = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`, {
      signal: ac.signal,
    });
    expect(pane.status).toBe(200);
    ac.abort();

    const attn = await readEventStream(
      `${base()}/api/events?ticket=${encodeURIComponent(ticket)}`,
      /event: reset/,
    );
    expect(attn.status).toBe(200);

    // NOT single-use — EventSource retries the same URL, so burning it on first
    // use would make the first ordinary reconnect a permanent failure.
    const again = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`);
    expect(again.status).toBe(200);
  });

  it('issues tickets ONLY to devices — the operator is told to use ?token=', async () => {
    const info = await startRO();
    const refused = await getTicket(info.token as string);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe('tickets-are-for-devices');

    // And an unauthenticated / unknown caller never reaches the issuer at all.
    expect((await fetch(`${base()}/api/stream-ticket`, { method: 'POST' })).status).toBe(401);
    expect((await getTicket('dev-404.nope')).status).toBe(401);
  });

  it('a ticket is a capability, not a credential — it opens streams and nothing else', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const ticket = await ticketFor(token);
    const q = encodeURIComponent(ticket);

    // Non-SSE routes never consult it, whatever it is presented as.
    expect((await fetch(`${base()}/api/sessions?ticket=${q}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/approvals?ticket=${q}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/sessions`, { headers: bearer(ticket) })).status).toBe(401);
    // Including the issuer itself: a ticket cannot mint another ticket.
    expect((await getTicket(ticket)).status).toBe(401);
  });

  it('★ rejects an expired ticket (injected clock, no two-minute sleep)', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const ticket = await ticketFor(token);

    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 121_000);
    try {
      const stale = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`);
      expect(stale.status).toBe(401);
      expect((await stale.json()).reason).toBe('unknown');
    } finally {
      nowSpy.mockRestore();
    }

    // The device's own credential is untouched by its ticket expiring — it just
    // asks for another one.
    const fresh = await ticketFor(token);
    expect(fresh).not.toBe(ticket);
    const ok = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(fresh)}`);
    expect(ok.status).toBe(200);
  });

  it('★ revoke invalidates outstanding tickets AND open streams, leaving others alone', async () => {
    await startRO();
    const victim = await pairDevice('Old phone');
    const bystander = await pairDevice('Keeps working');
    const victimTicket = await ticketFor(victim.token);
    const bystanderTicket = await ticketFor(bystander.token);

    // A stream opened WITH the ticket must be torn down like any other: the
    // ticket path tags the client with the device, which is what makes it
    // reachable by disconnectDevice at all.
    const ac = new AbortController();
    const pane = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(victimTicket)}`, {
      signal: ac.signal,
    });
    expect(pane.status).toBe(200);
    const reader = (pane.body as ReadableStream<Uint8Array>).getReader();
    await new Promise((r) => setTimeout(r, 30));

    deviceRoster.get(victim.deviceId)!.revoked = true;
    expect(server.disconnectDevice(victim.deviceId)).toBe(1);

    expect(await closedWithin(reader, 1000)).toBe(true);
    // The outstanding ticket is destroyed too — otherwise revocation would have
    // a two-minute hole in it during which the phone could reopen a stream.
    const reopened = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(victimTicket)}`);
    expect(reopened.status).toBe(401);
    // …and it cannot get a replacement, because its credential is dead.
    expect((await getTicket(victim.token)).status).toBe(401);
    expect((await getTicket(victim.token)).status).toBe(401);

    // The neighbour's ticket still opens a stream.
    const survivor = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(bystanderTicket)}`);
    expect(survivor.status).toBe(200);
    ac.abort();
  });

  it('keeps the operator ?token= path working untouched alongside tickets', async () => {
    const info = await startRO();
    const token = info.token as string;
    await pairDevice('Phone');

    const ac = new AbortController();
    const pane = await fetch(`${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
    });
    expect(pane.status).toBe(200);
    ac.abort();
    const attn = await readEventStream(`${base()}/api/events?token=${encodeURIComponent(token)}`, /event: reset/);
    expect(attn.status).toBe(200);
    // A bogus ticket does not become valid just because tickets exist.
    expect((await fetch(`${base()}/api/stream?session=s1&ticket=not-a-ticket`)).status).toBe(401);
  });

  it('drops outstanding tickets on stop(), so none survives into the next server', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const ticket = await ticketFor(token);
    await server.stop();

    await startRO();
    const stale = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`);
    expect(stale.status).toBe(401);
  });

  it('drops every device stream on stop(), so a revoke after a restart finds nothing', async () => {
    await startRO();
    const device = await pairDevice('Phone');
    const pane = await openStream(device.token);
    expect(pane.res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    await server.stop();
    expect(await closedWithin(pane.reader!, 1000)).toBe(true);
    expect(server.disconnectDevice(device.deviceId)).toBe(0);
    pane.ac.abort();
  });
});
