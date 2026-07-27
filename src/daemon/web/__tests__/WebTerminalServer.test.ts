import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import { GIT_HARDENING_CONFIG, type GitRunner } from '../sessionDiff';
import { MIN_PHONE_PROTOCOL_VERSION, PHONE_PROTOCOL_VERSION } from '../protocolVersion';

/** Drop the fixed `-c key=value` hardening prefix, leaving the command itself. */
const gitBody = (args: readonly string[]): string[] => args.slice(GIT_HARDENING_CONFIG.length);
/** The git subcommand — `rev-parse`, `diff`, `status`. */
const gitVerb = (args: readonly string[]): string => gitBody(args)[0] ?? '';
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
    // `cwd` and `spawnCwd` DIFFER on purpose: `cwd` is what the pane's own
    // process last claimed via OSC 7 (i.e. attacker-controlled), `spawnCwd` is
    // where the daemon actually spawned it. Every diff assertion below expects
    // '/x', which is the whole point.
    meta: { id: 's1', cols: 80, rows: 24, state: 'detached', cwd: '/tmp/osc7-said-so', spawnCwd: '/x' },
    ringBuffer: { readAll: () => Buffer.from('screen-bytes') },
    bridge,
    ptyProcess: { write },
  };
  // Three panes covering the workspace-label matrix: named workspace, a legacy
  // pane spawned before WMUX_WORKSPACE_NAME existed (id present, name absent),
  // and no wmux identity at all.
  type LiveRow = {
    id: string; cwd: string; cols: number; rows: number; state: string;
    agent: undefined; lastDetectedAgent: undefined; lastActivity: string;
    env: Record<string, string>; cmd: string;
  };
  const live: LiveRow[] = [
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
    // Every live pane is gettable, each with its own spawn cwd, so the
    // concurrency bound can be exercised across more than one session.
    getSession: (id: string) => {
      if (id === 's1') return managed;
      const row = live.find((l) => l.id === id);
      return row
        ? { ...managed, meta: { ...managed.meta, id, cwd: '/tmp/osc7-said-so', spawnCwd: row.cwd } }
        : undefined;
    },
    listLiveSessions: () => live,
  }) as unknown as DaemonSessionManager;
  // Lifecycle stand-in for the daemon's own daemon.createSession /
  // daemon.destroySession handlers (src/daemon/index.ts). The real ones spawn a
  // PTY, arm the supervisor, start the process monitor and flush state — none
  // of which the HTTP surface may know about, which is why the fake is two
  // functions. It mutates `live` so the route's "describe the new pane with the
  // SAME projection /api/sessions uses" claim is actually exercised.
  const lifecycleCalls: Array<{ op: 'create' | 'destroy'; arg: unknown }> = [];
  const lifecycleBox = { createThrows: '', destroyThrows: '', createGoesMissing: false };
  let created = 0;
  const lifecycle = {
    async create(params: { workspaceId?: string; cwd?: string }) {
      lifecycleCalls.push({ op: 'create', arg: { ...params } });
      if (lifecycleBox.createThrows) throw new Error(lifecycleBox.createThrows);
      created += 1;
      const id = `web-${created}`;
      if (!lifecycleBox.createGoesMissing) {
        live.push({
          id, cwd: params.cwd ?? '/home', cols: 120, rows: 30, state: 'detached',
          agent: undefined, lastDetectedAgent: undefined,
          lastActivity: '2020-01-02T00:00:00.000Z',
          env: params.workspaceId ? { WMUX_WORKSPACE_ID: params.workspaceId, WMUX_WORKSPACE_NAME: 'Workspace 1' } : {},
          cmd: '/bin/zsh',
        });
      }
      return { id };
    },
    async destroy(id: string) {
      lifecycleCalls.push({ op: 'destroy', arg: id });
      if (lifecycleBox.destroyThrows) throw new Error(lifecycleBox.destroyThrows);
    },
  };

  // Scripted git for /api/sessions/:id/diff. Records every argv so the
  // "fixed-argv, cwd-from-the-daemon" claim can be asserted from the route side
  // too, not just in sessionDiff.test.ts.
  const gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  const gitScript: Record<
    string,
    { ok: boolean; stdout: string; stderr: string; ran?: boolean }
  > = {
    'rev-parse': { ok: true, stdout: 'true\n/x\n', stderr: '' },
    diff: { ok: true, stdout: 'PATCH\n', stderr: '' },
    status: { ok: true, stdout: ' M src/a.ts\0?? notes.md\0', stderr: '' },
  };
  // Lets a test hold a collection open, which is the only way to observe the
  // concurrency bound and the per-session coalescing.
  const gitGate: { hold: Promise<void> | null } = { hold: null };
  const git: GitRunner = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    if (gitGate.hold) await gitGate.hold;
    return gitScript[gitVerb(args)] ?? { ok: true, stdout: '', stderr: '' };
  };

  // Where POST /api/upload writes. A real directory rather than a mock: the
  // route's whole job is the file it leaves behind, and the filename pattern,
  // the 0600 mode and the TTL sweep are only observable on disk.
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-uploads-'));

  return {
    sessionManager, bridge, write, live, managed,
    lifecycle, lifecycleCalls, lifecycleBox,
    git, gitCalls, gitScript, gitGate, uploadsDir,
    ...makeApprovals(), ...makeDevices(),
  };
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
  const pushRegistrations: Array<{ deviceId: string; apnsToken: string; publicKey: string }> = [];
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
    registerPush(deviceId, input) {
      pushRegistrations.push({ deviceId, ...input });
      const rec = roster.get(deviceId);
      if (!rec) return { ok: false, reason: 'not-found' };
      if (rec.revoked) return { ok: false, reason: 'revoked' };
      if (!/^[0-9a-f]{64,200}$/.test(input.apnsToken)) return { ok: false, reason: 'bad-token' };
      if (Buffer.from(input.publicKey, 'base64').length !== 32) return { ok: false, reason: 'bad-key' };
      return { ok: true };
    },
  };
  return {
    devices,
    deviceRoster: roster,
    deviceResolveCalls: resolveCalls,
    deviceMintCalls: mintCalls,
    pushRegistrations,
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
    result: { ok: true, durable: true, request: mkApproval({ state: 'resolved', decision: 'approve', resolvedBy: 'web' }) },
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
    pendingCount: () => records.filter((r) => r.state === 'pending').length,
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
  let pushRegistrations: Array<{ deviceId: string; apnsToken: string; publicKey: string }>;
  let deviceTouchCalls: string[];
  let deviceBox: { mintThrows: boolean };
  let lifecycleCalls: Array<{ op: 'create' | 'destroy'; arg: unknown }>;
  let lifecycleBox: { createThrows: string; destroyThrows: string; createGoesMissing: boolean };
  let gitCalls: Array<{ args: readonly string[]; cwd: string }>;
  let gitScript: Record<string, { ok: boolean; stdout: string; stderr: string; ran?: boolean }>;
  let gitGate: { hold: Promise<void> | null };
  let managed: { meta: Record<string, unknown> };
  let live: ReturnType<typeof makeDeps>['live'];
  let uploadsDir: string;

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
    pushRegistrations = deps.pushRegistrations;
    deviceTouchCalls = deps.deviceTouchCalls;
    deviceBox = deps.deviceBox;
    lifecycleCalls = deps.lifecycleCalls;
    lifecycleBox = deps.lifecycleBox;
    gitCalls = deps.gitCalls;
    gitScript = deps.gitScript;
    gitGate = deps.gitGate;
    managed = deps.managed;
    live = deps.live;
    uploadsDir = deps.uploadsDir;
    server = new WebTerminalServer({
      sessionManager: deps.sessionManager,
      approvals: deps.approvals,
      devices: deps.devices,
      lifecycle: deps.lifecycle,
      git: deps.git,
      uploadsDir: deps.uploadsDir,
      log: () => { /* silent in tests */ },
      assetsDir: os.tmpdir(), // no terminal.html needed for the /api/* tests
    });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  });

  // Port 0 → ephemeral bind; status() reports the actual port.
  const startRO = () => server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
  const startRW = () => server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false });
  /** Uploads on, input OFF — the combination that proves the two grants are separate. */
  const startUpload = () =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const pairCodePattern = /^[A-HJ-NP-Z2-9]{8}$/;

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
    expect(await ok.json()).toMatchObject({ allowInput: false, allowUpload: false });
  });

  it('★ /api/config carries the phone protocol handshake', async () => {
    // A shipped native client cannot be updated by the daemon, so the daemon
    // has to say which contract it is speaking. This is the route the client
    // already calls at connect time, and a daemon predating the handshake
    // answers the same body with these three keys absent — which is how a
    // client reads "protocol 0".
    const info = await startRO();
    const res = await fetch(`${base()}/api/config`, { headers: bearer(info.token as string) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocolVersion).toBe(PHONE_PROTOCOL_VERSION);
    expect(body.minProtocolVersion).toBe(MIN_PHONE_PROTOCOL_VERSION);
    // The floor can never exceed what the server itself speaks — that would
    // lock out every client including a freshly built one.
    expect(body.minProtocolVersion).toBeLessThanOrEqual(body.protocolVersion);
    // Present and non-empty. The value is the launcher-injected release or the
    // 'unknown' sentinel; tests run without the launcher, so both are valid and
    // only the field's existence is contractual.
    expect(typeof body.serverVersion).toBe('string');
    expect(body.serverVersion.length).toBeGreaterThan(0);
  });

  it('★ the handshake survives a bind that refuses to pair', async () => {
    // A plaintext non-loopback bind refuses to mint credentials, which is the
    // one state where the server answers operator surfaces differently. An
    // already-paired phone still reaches /api/config there, so the version
    // fields must not be a property of the happy path only — a client that
    // could not read them would report "update required" for a transport
    // problem.
    const info = await server.start({ port: 0, host: '0.0.0.0', allowInput: false, allowUpload: false });
    expect(server.status().pairRefusal?.reason).toBe('insecure-transport');

    const res = await fetch(`http://127.0.0.1:${info.port}/api/config`, {
      headers: bearer(info.token as string),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      protocolVersion: PHONE_PROTOCOL_VERSION,
      minProtocolVersion: MIN_PHONE_PROTOCOL_VERSION,
    });
  });

  it('never lists the orchestrator brain as a pane', async () => {
    // The brain's TUI is a daemon session like any other, but it is the
    // orchestrator itself — not a worker pane. It must not be listed (nor
    // attachable/approvable) from the phone, exactly as the fleet pane listing
    // already excludes it. Both markers are checked: the env stamp is
    // authoritative, the id prefix is the fallback for a session whose env the
    // daemon no longer holds.
    live.push(
      {
        id: 'brain-abc', cwd: '/b', cols: 80, rows: 24, state: 'attached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: { WMUX_BRAIN_PTY: '1' }, cmd: '/usr/local/bin/claude',
      },
      {
        id: 'brain-noenv', cwd: '/b2', cols: 80, rows: 24, state: 'attached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: {}, cmd: '/usr/local/bin/claude',
      },
    );
    try {
      const info = await startRO();
      const res = await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) });
      const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };
      expect(sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    } finally {
      live.length = 3;
    }
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

    const b = (await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, token: a }))
      .token as string;
    expect(b).toBe(a);

    // The token the phone already has still opens the door.
    const carried = await fetch(`${base()}/api/config`, { headers: bearer(a) });
    expect(carried.status).toBe(200);
  });

  it('mints a fresh token when the supplied one is empty (no accidental blank-token server)', async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, token: '' });
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

    const second = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, token });
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
  it('exposes an 8-character pairing code + expiry in status()', async () => {
    const info = await startRO();
    expect(info.pairCode).toMatch(pairCodePattern);
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
    const wrong = code[0] === 'A' ? 'BBBBBBBB' : 'AAAAAAAA';

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
    expect(b).toMatch(pairCodePattern);
    expect(a).toMatch(pairCodePattern);
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
      const info = await csps.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
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
    expect(first).toHaveLength(8);
    // Burn the attempt budget with wrong guesses.
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZZZ`);
    }
    // Burned, and inside the regeneration cooldown: deliberately still gone.
    await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZZZ`);
    expect(server.status().pairCode).toBeUndefined();

    // Past the cooldown, the next attempt mints a replacement so a burned code
    // costs a short wait instead of a server restart.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
    try {
      await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZZZ`);
    } finally {
      nowSpy.mockRestore();
    }
    const after = server.status().pairCode;
    expect(after).toHaveLength(8);
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
    const evil = await fetch(`${base()}/api/pair?code=ZZZZZZZZ`, {
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
      expect(status.pairCode).toHaveLength(8);
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
      allowInput: false, allowUpload: false,
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
      info = await server.start({ port: 0, host: '::1', allowInput: false, allowUpload: false });
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
      second.start({ port: blockerInfo.port as number, host: '127.0.0.1', allowInput: false, allowUpload: false }),
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

  it('★ a cursor below the retained window is a RESET, not a silent gap', async () => {
    const info = await startRO();
    const token = info.token as string;

    // The phone saw event 1, then slept. 300 events happened; the log keeps the
    // newest 100, so 2..200 are gone forever.
    emitNotify('s9', 'seen');
    const first = await backlog(token);
    const cursor = `${first.epoch}:1`;
    for (let i = 0; i < 300; i++) emitNotify('s9', `burst-${i}`);

    const out = await backlog(token, cursor);
    // Same epoch, so this used to answer reset:false and hand back the tail —
    // and the client would treat that tail as contiguous with event 1, never
    // learning that 2..200 existed at all.
    expect(out.reset).toBe(true);
    expect(out.events.length).toBeLessThanOrEqual(100);
    expect(out.headId).toBe(301);

    // A cursor still INSIDE the window is unaffected: no false resyncs.
    const oldestHeld = out.events[0].id as number;
    const inside = await backlog(token, `${first.epoch}:${oldestHeld}`);
    expect(inside.reset).toBe(false);

    // The exact boundary — the cursor sits one below the oldest held entry, so
    // the very next event it needs is one we still have. Continuity holds.
    const boundary = await backlog(token, `${first.epoch}:${oldestHeld - 1}`);
    expect(boundary.reset).toBe(false);
    expect(boundary.events[0].id).toBe(oldestHeld);
  });

  it('an empty window is quiet, not lost, until something was actually missed', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s10', 'one');
    const seen = await backlog(token);

    // Caught up with an empty tail: nothing was missed, so no resync.
    const quiet = await backlog(token, `${seen.epoch}:1`);
    expect(quiet.reset).toBe(false);
    expect(quiet.events).toEqual([]);

    // A cursor that cannot have come from us in this epoch.
    const future = await backlog(token, `${seen.epoch}:999`);
    expect(future.reset).toBe(true);
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
    const info = await aged.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
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

  it('carries the risk hint onto /api/approvals and the approval event, and omits it otherwise', async () => {
    const info = await startRO();
    const token = info.token as string;
    approvalRecords.push(mkApproval({ id: 'ap-risky', risk: 'critical' }));
    approvalRecords.push(mkApproval({ id: 'ap-calm' }));

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    const body = (await res.json()) as { pending: Array<Record<string, unknown>> };
    expect(body.pending[0]).toMatchObject({ id: 'ap-risky', risk: 'critical' });
    // Absent, not null: a client reads presence, and "no match" is not "safe".
    expect('risk' in body.pending[1]).toBe(false);

    emitApproval('create', mkApproval({ id: 'ap-risky', risk: 'critical' }));
    const data = await backlog(token);
    expect(data.events[0]).toMatchObject({ approvalId: 'ap-risky', risk: 'critical' });
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
    // `durable` rides along so a client can say the answer landed but will not
    // be remembered, instead of that staying inside the daemon's log.
    expect(await ok.json()).toEqual({ state: 'resolved', durable: true });
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
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
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

  it('★ stamps a server-authoritative tier on every event kind', async () => {
    const info = await startRO();
    const token = info.token as string;
    const rec = mkApproval({ id: 'ap-t', sessionId: 's2' });

    emitApproval('create', rec); // someone is blocked → act
    emitApproval('resolve', { ...rec, state: 'resolved', decision: 'approve' }); // echo → info
    emitApproval('expire', { ...rec, state: 'expired' }); // echo → info
    emitNotify('s3', 'build done'); // FYI → info
    (sessionManager as unknown as EventEmitter).emit('session:critical', {
      sessionId: 's4',
      event: { action: 'rm -rf', riskLevel: 'critical' },
    });

    const data = await backlog(token);
    expect(data.events.map((e) => [e.kind, e.tier])).toEqual([
      ['approval', 'act'],
      ['approval', 'info'],
      ['approval', 'info'],
      ['notify', 'info'],
      ['critical', 'act'],
    ]);
  });

  it('★ a review-level critical signal is info, not act', async () => {
    // The `critical` KIND names the channel, not the severity: CRITICAL_PATTERNS
    // carries two risk levels and the daemon puts both on it, so `DELETE FROM`
    // and `kubectl delete` arrive beside `rm -rf`. Waking a phone for the first
    // pair at the urgency of the second is how a person learns to ignore the
    // channel — and `hasCriticalRisk` already excludes review-level from "the
    // dangerous class", so mapping both to `act` contradicts it.
    const info = await startRO();
    const token = info.token as string;
    const em = sessionManager as unknown as EventEmitter;
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'DELETE FROM', riskLevel: 'review' },
    });
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'kubectl delete', riskLevel: 'review' },
    });
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'terraform destroy', riskLevel: 'critical' },
    });

    const data = await backlog(token);
    expect(data.events.map((e) => [e.action, e.tier])).toEqual([
      ['DELETE FROM', 'info'],
      ['kubectl delete', 'info'],
      ['terraform destroy', 'act'],
    ]);
  });

  it('★ an unrecognised or missing riskLevel stays act', async () => {
    // Fail dangerous. The failure that matters is a destructive action
    // delivered quietly, not an FYI delivered loudly — so only the exact
    // literal 'review' softens the tier.
    const info = await startRO();
    const token = info.token as string;
    const em = sessionManager as unknown as EventEmitter;
    em.emit('session:critical', { sessionId: 's4', event: { action: 'no level' } });
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'bogus', riskLevel: 'REVIEW' },
    });
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'object', riskLevel: { toString: 'review' } },
    });

    const data = await backlog(token);
    expect(data.events.map((e) => e.tier)).toEqual(['act', 'act', 'act']);
  });

  it('★ never lets a pane declare its own event non-urgent', async () => {
    const info = await startRO();
    const token = info.token as string;
    // A critical signal whose payload claims it is only FYI. The tier is the
    // server's judgement and is stamped after the payload spread.
    (sessionManager as unknown as EventEmitter).emit('session:critical', {
      sessionId: 's4',
      event: { action: 'rm -rf', riskLevel: 'critical', tier: 'info' },
    });

    const data = await backlog(token);
    expect(data.events[0].tier).toBe('act');

    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"tier"/,
      {},
    );
    expect(out.text).toContain('"tier":"act"');
    expect(out.text).not.toContain('"tier":"info"');
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

  it('★ a device registers where to push to it; the operator token cannot', async () => {
    const info = await startRO();
    const { token } = await pairDevice('Phone');
    const apnsToken = 'a'.repeat(64);
    const publicKey = Buffer.alloc(32, 3).toString('base64');
    const post = (auth: string, body: unknown) =>
      fetch(`${base()}/api/push-registration`, {
        method: 'POST',
        headers: { ...bearer(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const ok = await post(token, { apnsToken, publicKey });
    expect(ok.status).toBe(200);
    expect(pushRegistrations.at(-1)).toEqual({ deviceId: 'dev-1', apnsToken, publicKey });

    // The operator token names no device, so there is nothing to register it
    // against — 403 beats inventing an association.
    const asOperator = await post(info.token as string, { apnsToken, publicKey });
    expect(asOperator.status).toBe(403);
    expect((await asOperator.json()).error).toBe('push-is-for-devices');
  });

  it('rejects a malformed token or key with 400', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const post = (body: unknown) =>
      fetch(`${base()}/api/push-registration`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const badToken = await post({ apnsToken: 'nope', publicKey: Buffer.alloc(32).toString('base64') });
    expect(badToken.status).toBe(400);
    expect((await badToken.json()).error).toBe('bad-token');

    const badKey = await post({ apnsToken: 'a'.repeat(64), publicKey: 'nope' });
    expect(badKey.status).toBe(400);
    expect((await badKey.json()).error).toBe('bad-key');
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
    expect(server.refreshPairCode().pairCode).toMatch(pairCodePattern);
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

  /**
   * The pairing code as the WIRE sees it.
   *
   * `start()` always mints one (:481), but `status()` withholds it whenever
   * `mintRefusal()` fires, so the operator is never handed a code that is
   * guaranteed to 403. Tests that exercise the refusal at redemption still need
   * the real value, and reaching past the operator surface is the honest way to
   * say "this is not what a human would see."
   */
  function livePairCode(s: WebTerminalServer): string {
    return (s as unknown as { pairCode: string }).pairCode;
  }

  it('★ status withholds the pairing code on a bind that can never redeem it', async () => {
    // The bug this closes: status() regenerates a code lazily and used to do it
    // without asking whether the server could mint a credential at all. On an
    // exposed bind the GUI showed a fresh 8-character code every poll, the operator
    // read one onto a phone, and only the redemption said 403.
    const info = await server.start({ port: 0, host: '0.0.0.0', allowInput: false, allowUpload: false });
    expect(info.running).toBe(true);

    const status = server.status();
    expect(status.pairRefusal?.reason).toBe('insecure-transport');
    // The detail is operator prose for logs and tooltips — it must still name
    // both ways out, because it is what a support question gets answered with.
    expect(status.pairRefusal?.detail).toContain('wmux web --tailscale');
    // No code, and no expiry for a code that does not exist.
    expect(status.pairCode).toBeUndefined();
    expect(status.pairExpiresAt).toBeUndefined();
  });

  it('★ status advertises a pairing code normally on loopback', async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    expect(info.running).toBe(true);

    const status = server.status();
    // The refusal is absent, not merely falsy-but-present: the renderer keys
    // its whole pairing block on this field being undefined.
    expect(status.pairRefusal).toBeUndefined();
    expect(status.pairCode).toMatch(pairCodePattern);
    expect(typeof status.pairExpiresAt).toBe('number');
  });

  it('★ refuses to mint over a plaintext bind, and --allow-host does NOT buy an exception', async () => {
    // A real non-loopback bind: the gate reads the BIND, because that is the
    // only thing about the transport the daemon actually knows.
    const info = await server.start({ port: 0, host: '0.0.0.0', allowInput: false, allowUpload: false });
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
    //
    // Read straight off the instance rather than through status(): a code is
    // still minted on start(), but status() deliberately withholds it on a bind
    // that could never redeem it. This test is about the WIRE refusal, so it
    // needs the live code the wire would see, not the operator-facing view.
    const code = livePairCode(server);
    const denied = await getWithHost(port, `/api/pair?code=${code}`, `127.0.0.1:${port}`);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('insecure-transport');
    expect(deviceMintCalls).toEqual([]);
    expect(livePairCode(server)).toBe(code);
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
      allowInput: false, allowUpload: false,
      allowedHosts: ['machine.tail-net.ts.net'],
    });

    // Refused up front now: --allow-host is a DNS-rebinding allowlist, not
    // evidence that this particular connection was encrypted.
    const started = server.startPairing({ name: 'Phone' });
    expect(started.ok).toBe(false);

    // …and the same is true at redemption, sending the exact header an attacker
    // would forge. Nothing is minted. (See livePairCode — status() withholds the
    // code here, but the wire still has one to refuse.)
    const code = livePairCode(server);
    const forged = await getWithHost(
      fronted.port as number,
      `/api/pair?code=${code}`,
      'machine.tail-net.ts.net',
    );
    expect(forged.status).toBe(403);
    expect(JSON.parse(forged.body).error).toBe('insecure-transport');
    expect(deviceMintCalls).toEqual([]);
  });

  it('★ status names the TLS front, which is the only address a phone can use', async () => {
    // The supported phone setup binds LOOPBACK and lets `tailscale serve`
    // terminate HTTPS, so reporting the bind alone was correct and useless.
    const info = await server.start({
      port: 0,
      host: '127.0.0.1',
      allowInput: false, allowUpload: false,
      allowedHosts: ['Machine.tail-net.ts.net'],
    });
    const status = server.status();

    expect(status.allowedHosts).toEqual(['machine.tail-net.ts.net']);
    // The front comes first, and carries no port: it terminates TLS on 443.
    expect((status.urls ?? [])[0]).toBe(
      `https://machine.tail-net.ts.net/?token=${info.token as string}`,
    );
    // The loopback URL is still there for someone sitting at the desktop.
    expect((status.urls ?? []).some((u) => u.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('reports no fronts when none were named', async () => {
    await startRO();
    const status = server.status();
    expect(status.allowedHosts).toEqual([]);
    expect((status.urls ?? []).every((u) => u.startsWith('http://'))).toBe(true);
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
      const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
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
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
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
    for (let i = 0; i < 5; i++) await fetch(`${base()}/api/pair?code=ZZZZZZZZ`);
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
    let replacement: string;
    try {
      await fetch(`${base()}/api/pair?code=ZZZZZZZZ`);
      replacement = server.status().pairCode as string;
    } finally {
      nowSpy.mockRestore();
    }
    expect(replacement).toHaveLength(8);
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
  // ── pane diff (read-only git) ──────────────────────────────────────────────

  const getDiff = (id: string, cred: string) =>
    fetch(`${base()}/api/sessions/${encodeURIComponent(id)}/diff`, { headers: bearer(cred) });

  it('gates the diff route on the Bearer token — a query token is not enough', async () => {
    const info = await startRO();
    const token = info.token as string;
    expect((await fetch(`${base()}/api/sessions/s1/diff`)).status).toBe(401);
    expect((await fetch(`${base()}/api/sessions/s1/diff?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await getDiff('s1', token)).status).toBe(200);
  });

  it('★ the diff payload is never cacheable', async () => {
    // A 200 GET with no Cache-Control and no validator is heuristically
    // cacheable, and this is the one payload an approval decision is made
    // against: a phone — or an intermediary — replaying yesterday's patch
    // under today's prompt is the exact failure this route exists to prevent.
    const info = await startRO();
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('★ answers the diff on a READ-ONLY server, and only ever runs fixed-argv read-only git', async () => {
    const info = await startRO();
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      files: [
        { path: 'src/a.ts', status: ' M' },
        { path: 'notes.md', status: '??' },
      ],
      // Staged, working tree, then the untracked add-hunk — three runs of the
      // same scripted stdout.
      patch: 'PATCH\nPATCH\nPATCH\n',
      truncated: false,
      omittedBytes: 0,
      patchIncomplete: false,
    });
    expect(gitCalls.map((c) => gitBody(c.args))).toEqual([
      ['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
      // Names the repo's content filters so they can be blanked before
      // anything below converts working-tree content.
      ['config', '--list', '--name-only', '-z'],
      ['diff', '--cached', '--no-ext-diff', '--no-textconv'],
      ['diff', '--no-ext-diff', '--no-textconv'],
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      // #6: an untracked file is in files[] and would otherwise contribute
      // nothing to the patch. The path goes after a literal `--`.
      ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', 'notes.md'],
      // Closing re-read: did the tree change while all of that ran?
      ['status', '--porcelain', '-z', '--untracked-files=all'],
    ]);
    // Every one of them carried the hardening prefix.
    for (const c of gitCalls) {
      expect(c.args.slice(0, GIT_HARDENING_CONFIG.length)).toEqual([...GIT_HARDENING_CONFIG]);
    }
  });

  it("★ takes the cwd from the daemon's session record, never from the request", async () => {
    const info = await startRO();
    // Every shape a caller could try to smuggle a directory or a ref through.
    await fetch(`${base()}/api/sessions/s1/diff?cwd=/etc&ref=HEAD~5&base=main`, {
      headers: bearer(info.token as string),
    });
    // s1's recorded spawn cwd is /x — see makeDeps.
    expect(new Set(gitCalls.map((c) => c.cwd))).toEqual(new Set(['/x']));
    const flat = gitCalls.flatMap((c) => c.args);
    expect(flat).not.toContain('/etc');
    expect(flat).not.toContain('HEAD~5');
    expect(flat).not.toContain('main');
  });

  it('★ diffs the SPAWN cwd, never the OSC 7 cwd the pane itself last claimed', async () => {
    // The pane's process emitted an OSC 7 pointing at /tmp/osc7-said-so, which
    // the daemon dutifully recorded in meta.cwd. If the route read that, any
    // process inside any pane could aim this read-only route at any directory
    // on the machine and get the patch back over HTTP.
    const info = await startRO();
    await getDiff('s1', info.token as string);
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const c of gitCalls) expect(c.cwd).toBe('/x');
    expect(gitCalls.map((c) => c.cwd)).not.toContain('/tmp/osc7-said-so');
  });

  it('409s a session record with no spawn cwd rather than falling back to the live one', async () => {
    const info = await startRO();
    // A pre-spawnCwd record. Falling back to meta.cwd here would reopen the
    // hole above for exactly the sessions whose provenance is unknown.
    const meta = (managed as unknown as { meta: Record<string, unknown> }).meta;
    const saved = meta.spawnCwd;
    meta.spawnCwd = undefined;
    try {
      expect((await getDiff('s1', info.token as string)).status).toBe(409);
      expect(gitCalls).toHaveLength(0);
    } finally {
      meta.spawnCwd = saved;
    }
  });

  it('★ 409s a cwd that is not a git repo — a scratch pane is normal, not an error', async () => {
    const info = await startRO();
    gitScript['rev-parse'] = { ok: false, stdout: '', stderr: 'fatal: not a git repository' };
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not-a-git-repo' });
  });

  it('★ 500s, not 409s, when git never ran — "no repo here" must be gits word', async () => {
    // ENOENT on the git binary, or our own timeout. The old code collapsed
    // every failure into 409, telling the human their perfectly good repo was
    // not a repo.
    const info = await startRO();
    gitScript['rev-parse'] = { ok: false, ran: false, stdout: '', stderr: 'spawn git ENOENT' };
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'git-failed' });
  });

  it('500s when git itself fails, and leaks no detail on the wire', async () => {
    const info = await startRO();
    gitScript['status'] = {
      ok: false,
      stdout: '',
      stderr: 'fatal: index file /home/someone/secret-project/.git/index corrupt',
    };
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(500);
    // The whole body, not a subset: git stderr names paths, remotes and config
    // keys, and none of it helps a phone decide what to do next.
    expect(await res.json()).toEqual({ error: 'git-failed' });
  });

  it('★ reports patchIncomplete when a diff command fails, instead of "no changes"', async () => {
    // The reason this flag exists: an empty patch with truncated:false renders
    // on a phone as a clean tree, and a human approves an edit against it.
    const info = await startRO();
    gitScript['diff'] = { ok: false, ran: false, stdout: '', stderr: 'killed' };
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      patch: '',
      truncated: false,
      patchIncomplete: true,
      files: [
        { path: 'src/a.ts', status: ' M' },
        { path: 'notes.md', status: '??' },
      ],
    });
  });

  it('★ bounds concurrent collections and coalesces per session', async () => {
    const info = await startRO();
    const token = info.token as string;
    // Hold every collection open so all of them are genuinely in flight.
    let release = (): void => { /* replaced below */ };
    gitGate.hold = new Promise<void>((r) => { release = r; });

    // s1 twice (coalesced into one collection) + s2 = two slots used.
    const a = getDiff('s1', token);
    const b = getDiff('s1', token);
    const c = getDiff('s2', token);
    // Let the three requests reach the handler before the fourth.
    await new Promise((r) => setTimeout(r, 30));
    const d = getDiff('s3', token);
    const dRes = await d;
    expect(dRes.status).toBe(429);
    expect(await dRes.json()).toEqual({ error: 'busy' });

    gitGate.hold = null;
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect([ra.status, rb.status, rc.status]).toEqual([200, 200, 200]);
    // Coalescing: the two s1 requests got the same answer from one collection.
    expect(await ra.json()).toEqual(await rb.json());
    // s3 never shelled out at all — the refusal is before git, which is the
    // point of the bound.
    expect(gitCalls.map((x) => x.cwd)).not.toContain('/z');

    // And the bound is released: a later request succeeds normally.
    expect((await getDiff('s1', token)).status).toBe(200);
  });

  it('404s an unknown session id, and never shells out for one', async () => {
    const info = await startRO();
    expect((await getDiff('nope', info.token as string)).status).toBe(404);
    expect((await getDiff('a/b', info.token as string)).status).toBe(404);
    expect(gitCalls).toHaveLength(0);
  });

  it('serves the diff to a paired device exactly as to the operator', async () => {
    await startRO();
    const device = await pairDevice('Phone');
    const res = await getDiff('s1', device.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { files: unknown[] }).files).toHaveLength(2);
  });

  // ── pane lifecycle (POST / DELETE /api/sessions) ───────────────────────────

  const postSession = (cred: string, body?: unknown) =>
    fetch(`${base()}/api/sessions`, {
      method: 'POST',
      headers: { ...bearer(cred), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const deleteSession = (id: string, cred: string) =>
    fetch(`${base()}/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: bearer(cred),
    });

  it('★ refuses BOTH lifecycle routes on a read-only server — this is not an approval-style carve-out', async () => {
    const info = await startRO();
    const token = info.token as string;
    const created = await postSession(token, {});
    expect(created.status).toBe(403);
    expect(((await created.json()) as { error: string }).error).toMatch(/read-only/);
    const deleted = await deleteSession('s1', token);
    expect(deleted.status).toBe(403);
    // The point of the gate: nothing reached the daemon.
    expect(lifecycleCalls).toEqual([]);
  });

  it('gates the lifecycle routes on the Bearer token — a query token is not enough', async () => {
    const info = await startRW();
    const token = info.token as string;
    expect((await fetch(`${base()}/api/sessions`, { method: 'POST' })).status).toBe(401);
    expect(
      (await fetch(`${base()}/api/sessions?token=${encodeURIComponent(token)}`, { method: 'POST' })).status,
    ).toBe(401);
    expect((await fetch(`${base()}/api/sessions/s1`, { method: 'DELETE' })).status).toBe(401);
  });

  it('★ spawns a pane and describes it with the SAME projection /api/sessions uses', async () => {
    const info = await startRW();
    const token = info.token as string;
    const res = await postSession(token, { workspaceId: 'ws-1', cwd: '/repo' });
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row).toMatchObject({
      id: 'web-1', cwd: '/repo', cols: 120, rows: 30,
      state: 'detached', agent: null, workspace: 'Workspace 1', shell: 'zsh',
    });
    expect(lifecycleCalls).toEqual([{ op: 'create', arg: { workspaceId: 'ws-1', cwd: '/repo' } }]);

    // Byte-identical to the row the list route serves for the same pane.
    const listed = (
      (await (await fetch(`${base()}/api/sessions`, { headers: bearer(token) })).json()) as {
        sessions: Array<{ id: string }>;
      }
    ).sessions.find((sx) => sx.id === 'web-1');
    expect(listed).toEqual(row);
  });

  it('forwards neither field when the body is empty, absent, or the wrong type', async () => {
    const info = await startRW();
    const token = info.token as string;
    expect((await postSession(token)).status).toBe(201);
    expect((await postSession(token, {})).status).toBe(201);
    expect((await postSession(token, { workspaceId: 7, cwd: ['/x'] })).status).toBe(201);
    expect(lifecycleCalls.map((c) => c.arg)).toEqual([{}, {}, {}]);
  });

  it('★ 400s a workspaceId that is not the right SHAPE, before anything is spawned', async () => {
    const info = await startRW();
    const token = info.token as string;
    // The value is stamped into WMUX_WORKSPACE_ID and persisted into
    // sessions.json, so a control character or a newline is not a cosmetic
    // problem — it is a value that renders as something else downstream.
    for (const bad of [
      'ws 1',
      'ws/../other',
      'ws-1\nWMUX_AUTH_TOKEN=x',
      // A literal NUL, written as an escape: as a raw byte it makes this
      // file unsearchable and reads as a duplicate of the space case above.
      'ws\u00001',
      'ws-\u001b[31m1',
      'w'.repeat(65),
      '../../etc/passwd',
    ]) {
      const res = await postSession(token, { workspaceId: bad });
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid-workspace-id' });
    }
    expect(lifecycleCalls).toEqual([]);
  });

  it('★ 400s a well-shaped workspaceId that no live pane is running in', async () => {
    // The daemon owns no workspace registry, so "some live session already
    // carries this id" is the only evidence it has that the workspace exists.
    // Accepting an unverifiable id would be workspace impersonation.
    const info = await startRW();
    const res = await postSession(info.token as string, { workspaceId: 'ws-invented' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown-workspace-id' });
    expect(lifecycleCalls).toEqual([]);
  });

  it('accepts a workspaceId a live pane vouches for, and always accepts none at all', async () => {
    const info = await startRW();
    const token = info.token as string;
    // ws-1 is s1's workspace; ws-legacy is s2's (id present, name absent).
    expect((await postSession(token, { workspaceId: 'ws-1' })).status).toBe(201);
    expect((await postSession(token, { workspaceId: 'ws-legacy' })).status).toBe(201);
    // The documented escape hatch from the trade-off above.
    expect((await postSession(token, {})).status).toBe(201);
    expect(lifecycleCalls.map((c) => c.arg)).toEqual([
      { workspaceId: 'ws-1' },
      { workspaceId: 'ws-legacy' },
      {},
    ]);
  });

  it('400s a malformed JSON body rather than spawning anything', async () => {
    const info = await startRW();
    const res = await fetch(`${base()}/api/sessions`, {
      method: 'POST',
      headers: { ...bearer(info.token as string), 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(lifecycleCalls).toEqual([]);
  });

  it("409s with the daemon's own wording when the create is refused", async () => {
    const info = await startRW();
    lifecycleBox.createThrows = 'Cannot create new terminal: 200 active sessions already running.';
    const res = await postSession(info.token as string, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'create-failed',
      detail: expect.stringContaining('200 active sessions'),
    });
  });

  it('500s rather than faking a row when the created session is not live', async () => {
    const info = await startRW();
    lifecycleBox.createGoesMissing = true;
    expect((await postSession(info.token as string, {})).status).toBe(500);
  });

  it('★ closes a pane through the daemon and answers 204', async () => {
    const info = await startRW();
    const res = await deleteSession('s1', info.token as string);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(lifecycleCalls).toEqual([{ op: 'destroy', arg: 's1' }]);
  });

  it('404s an unknown or malformed id on DELETE, without calling the daemon', async () => {
    const info = await startRW();
    const token = info.token as string;
    expect((await deleteSession('nope', token)).status).toBe(404);
    expect((await deleteSession('a/b', token)).status).toBe(404);
    expect((await fetch(`${base()}/api/sessions/`, { method: 'DELETE', headers: bearer(token) })).status).toBe(404);
    expect(lifecycleCalls).toEqual([]);
  });

  it('500s when the daemon fails to reap the pane', async () => {
    const info = await startRW();
    lifecycleBox.destroyThrows = 'pty already gone';
    const res = await deleteSession('s1', info.token as string);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'destroy-failed' });
  });

  it('★ works from a paired device, not just the operator token', async () => {
    await startRW();
    const device = await pairDevice('Phone');
    const created = await postSession(device.token, { cwd: '/repo' });
    expect(created.status).toBe(201);
    expect((await deleteSession('s1', device.token)).status).toBe(204);
    expect(lifecycleCalls.map((c) => c.op)).toEqual(['create', 'destroy']);
  });

  it('answers 503 on both lifecycle routes when the daemon wired no lifecycle', async () => {
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false });
    try {
      const url = `http://127.0.0.1:${info.port}/api/sessions`;
      const hdrs = bearer(info.token as string);
      expect((await fetch(url, { method: 'POST', headers: hdrs })).status).toBe(503);
      expect((await fetch(`${url}/s1`, { method: 'DELETE', headers: hdrs })).status).toBe(503);
    } finally {
      await bare.stop();
    }
  });

  it('leaves unmatched methods on the sessions namespace as 404, not 405 guesswork', async () => {
    const info = await startRW();
    const hdrs = bearer(info.token as string);
    expect((await fetch(`${base()}/api/sessions/s1`, { method: 'GET', headers: hdrs })).status).toBe(404);
    expect((await fetch(`${base()}/api/sessions/s1/diff`, { method: 'DELETE', headers: hdrs })).status).toBe(404);
  });
  // --- POST /api/upload ---------------------------------------------------
  //
  // The route exists because a phone has a camera and a desktop does not. What
  // the tests below pin down is everything a client cannot be trusted to get
  // right: the grant, the format, and the name on disk.

  /** A minimal JPEG: the SOI + APP0 marker is all the sniff looks at. */
  const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('body-jpeg')]);
  /** A minimal PNG: the eight-byte signature plus filler. */
  const pngBytes = () =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('body-png'),
    ]);
  const upload = (token: string, body: Buffer, contentType = 'application/octet-stream') =>
    fetch(`${base()}/api/upload`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': contentType },
      body: new Uint8Array(body),
    });

  it('refuses an unauthenticated upload before it looks at anything else', async () => {
    await startUpload();
    const res = await fetch(`${base()}/api/upload`, {
      method: 'POST',
      body: new Uint8Array(jpegBytes()),
    });
    expect(res.status).toBe(401);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('403s an upload on a server started with --allow-input but not --allow-upload', async () => {
    // The point of the pairing: input is a grant to type into a pane the
    // operator is watching, upload is a grant to write files into their home
    // directory. One must never imply the other.
    const info = await startRW();
    const res = await upload(info.token as string, jpegBytes());
    expect(res.status).toBe(403);
    // The exact string, not just the code: the phone client prefix-matches it
    // to say "ask your Mac to enable uploads" instead of showing an HTTP code.
    expect(await res.json()).toEqual({
      error: 'uploads-disabled: server started without --allow-upload',
    });
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('413s a body over the 10 MB cap and writes nothing', async () => {
    const info = await startUpload();
    const oversized = Buffer.concat([jpegBytes(), Buffer.alloc(10 * 1024 * 1024)]);
    // The server destroys the socket on the cap, so the fetch itself may reject
    // rather than resolve with the 413 — the same trade-off /api/input makes.
    // What matters either way is that no file appeared.
    const res = await upload(info.token as string, oversized).catch(() => undefined);
    if (res) expect(res.status).toBe(413);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('415s anything that is not JPEG or PNG by its leading bytes, including an empty body', async () => {
    const info = await startUpload();
    const token = info.token as string;

    const text = await upload(token, Buffer.from('this is not an image at all'));
    expect(text.status).toBe(415);
    expect(await text.json()).toEqual({
      error: 'unsupported-format: only JPEG and PNG are accepted',
    });

    // Empty, and shorter-than-a-signature, are the same answer: we could not
    // identify it, so we will not store it.
    expect((await upload(token, Buffer.alloc(0))).status).toBe(415);
    expect((await upload(token, Buffer.from([0xff, 0xd8]))).status).toBe(415);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('stores a JPEG under a server-chosen name and answers 201 with the absolute path', async () => {
    const info = await startUpload();
    const bytes = jpegBytes();
    const before = Date.now();
    const res = await upload(info.token as string, bytes);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; expiresAt: number };

    expect(path.isAbsolute(body.path)).toBe(true);
    expect(path.dirname(body.path)).toBe(uploadsDir);
    // The client never names the file — a client-supplied name is a traversal
    // primitive and nothing reads these by name anyway.
    expect(path.basename(body.path)).toMatch(
      /^photo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.jpg$/,
    );
    expect(fs.readFileSync(body.path).equals(bytes)).toBe(true);
    // A day out, measured from the same clock the route used.
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('trusts the magic bytes over the Content-Type the client claimed', async () => {
    const info = await startUpload();
    const bytes = pngBytes();
    // A PNG announced as a JPEG. Believing the header would put .jpg on a PNG
    // and hand the agent a file whose extension lies about its contents.
    const res = await upload(info.token as string, bytes, 'image/jpeg');
    expect(res.status).toBe(201);
    const { path: stored } = (await res.json()) as { path: string };
    expect(stored.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(stored).equals(bytes)).toBe(true);
  });

  it('sweeps photos past the TTL before a write, and leaves everything else alone', async () => {
    // A dedicated server so the clock seam is under this test's control.
    let clock = Date.parse('2030-01-01T00:00:00.000Z');
    const swept = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      now: () => clock,
    });
    const info = await swept.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      const token = info.token as string;
      const url = `http://127.0.0.1:${info.port}/api/upload`;
      const post = (body: Buffer) =>
        fetch(url, { method: 'POST', headers: bearer(token), body: new Uint8Array(body) });

      const first = (await (await post(jpegBytes())).json()) as { path: string };
      // Not ours. `~/.wmux/uploads` is also where an operator drops files for
      // browser_file_upload, and those are not the sweep's to delete.
      const keep = path.join(uploadsDir, 'keep.txt');
      fs.writeFileSync(keep, 'operator file');

      clock += 25 * 60 * 60 * 1000;
      const second = (await (await post(pngBytes())).json()) as { path: string };

      expect(fs.existsSync(first.path)).toBe(false);
      expect(fs.existsSync(keep)).toBe(true);
      expect(fs.existsSync(second.path)).toBe(true);
    } finally {
      await swept.stop();
    }
  });

  it('reports allowUpload on /api/config so the phone can hide the button', async () => {
    const info = await startUpload();
    const res = await fetch(`${base()}/api/config`, { headers: bearer(info.token as string) });
    expect(await res.json()).toMatchObject({ allowInput: false, allowUpload: true });
    // status() carries it too — that is what `wmux web --status` prints.
    expect(server.status().allowUpload).toBe(true);
  });

  it('answers 503 when the daemon wired no uploads directory', async () => {
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/upload`, {
        method: 'POST',
        headers: bearer(info.token as string),
        body: new Uint8Array(jpegBytes()),
      });
      // 503, not 403: the operator DID grant the permission, the server simply
      // has nowhere to put the bytes. Saying "disabled" would send them off to
      // re-add a flag that is already there.
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'uploads-unavailable' });
    } finally {
      await bare.stop();
    }
  });
  /** A name the sweep and the quota both recognise as ours. */
  const generatedName = (isoMs: number, hex: string, ext: 'jpg' | 'png' = 'jpg') =>
    `photo-${new Date(isoMs).toISOString().replace(/[:.]/g, '-')}-${hex}.${ext}`;

  it('507s once the directory quota is full, and counts only its own files', async () => {
    // Limits are injected rather than honoured at their production values: the
    // only honest way to test a 200 MB ceiling is to fill it, and that is not a
    // test. The pass/fail logic under test is the same either way.
    const quota = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      uploadLimits: { maxFiles: 2 },
    });
    const info = await quota.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      const url = `http://127.0.0.1:${info.port}/api/upload`;
      const post = () =>
        fetch(url, {
          method: 'POST',
          headers: bearer(info.token as string),
          body: new Uint8Array(jpegBytes()),
        });

      expect((await post()).status).toBe(201);
      expect((await post()).status).toBe(201);

      const full = await post();
      // 507, not 403: the operator granted the permission and the request is
      // well formed — the server has no room, and the TTL will make some.
      expect(full.status).toBe(507);
      expect(await full.json()).toEqual({ error: 'uploads-full: quota exceeded, try again later' });
    } finally {
      await quota.stop();
    }
  });

  it('does not charge the quota for files it did not write', async () => {
    const quota = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      uploadLimits: { maxFiles: 1 },
    });
    // An operator's own staged files are not ours to delete, so they are not
    // ours to count against a limit either.
    fs.writeFileSync(path.join(uploadsDir, 'photo-vacation.jpg'), 'operator file');
    fs.writeFileSync(path.join(uploadsDir, 'notes.txt'), 'operator file');
    const info = await quota.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/upload`, {
        method: 'POST',
        headers: bearer(info.token as string),
        body: new Uint8Array(jpegBytes()),
      });
      expect(res.status).toBe(201);
    } finally {
      await quota.stop();
    }
  });

  it('429s a fifth concurrent upload rather than buffering it', async () => {
    // Each in-flight upload holds its whole body in memory, so the disk quota
    // does nothing for RAM. maxConcurrent: 1 makes the bound observable with
    // one held-open request instead of five.
    const busy = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      uploadLimits: { maxConcurrent: 1 },
    });
    const info = await busy.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    const token = info.token as string;
    const port = info.port as number;
    try {
      const bytes = jpegBytes();
      // A request whose body arrives in two pieces, so the handler is provably
      // inside the buffering window while the second request is made.
      const held = httpReq({
        host: '127.0.0.1', port, path: '/api/upload', method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(bytes.length) },
      });
      const heldStatus = new Promise<number>((resolve, reject) => {
        held.on('response', (r) => { r.resume(); resolve(r.statusCode ?? 0); });
        held.on('error', reject);
      });
      await new Promise<void>((resolve) => held.write(bytes.subarray(0, 4), () => resolve()));

      const refused = await fetch(`http://127.0.0.1:${port}/api/upload`, {
        method: 'POST',
        headers: bearer(token),
        body: new Uint8Array(bytes),
      });
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: 'too-many-uploads: try again in a moment' });

      // The slot comes back when the held request finishes, so the next caller
      // is served rather than being locked out by a leaked counter.
      held.end(bytes.subarray(4));
      expect(await heldStatus).toBe(201);
      const after = await fetch(`http://127.0.0.1:${port}/api/upload`, {
        method: 'POST',
        headers: bearer(token),
        body: new Uint8Array(bytes),
      });
      expect(after.status).toBe(201);
    } finally {
      await busy.stop();
    }
  });

  it('sweeps only the names it generated — an operator photo-*.jpg survives', async () => {
    let clock = Date.parse('2030-01-01T00:00:00.000Z');
    const swept = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      now: () => clock,
    });
    const info = await swept.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      // Ours, and expired: the exact shape handleUpload writes.
      const mine = path.join(uploadsDir, generatedName(clock, '0123abcd'));
      fs.writeFileSync(mine, 'old photo');
      // Theirs, and just as old. `photo-*.jpg` would have matched it, which is
      // why the pattern anchors the timestamp and the hex suffix instead.
      // (The uppercase-hex name below must not collide with `mine` — a
      // case-insensitive filesystem would make them the same file.)
      const theirs = path.join(uploadsDir, 'photo-vacation.jpg');
      fs.writeFileSync(theirs, 'operator file');
      const alsoTheirs = path.join(uploadsDir, 'photo-2030-01-01T00-00-00-000Z-DEADBEEF.jpg');
      fs.writeFileSync(alsoTheirs, 'uppercase hex is not ours');

      clock += 25 * 60 * 60 * 1000;
      const res = await fetch(`http://127.0.0.1:${info.port}/api/upload`, {
        method: 'POST',
        headers: bearer(info.token as string),
        body: new Uint8Array(jpegBytes()),
      });
      expect(res.status).toBe(201);

      expect(fs.existsSync(mine)).toBe(false);
      expect(fs.existsSync(theirs)).toBe(true);
      expect(fs.existsSync(alsoTheirs)).toBe(true);
    } finally {
      await swept.stop();
    }
  });
});
