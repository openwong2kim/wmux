import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// The plugin is plain .js (OpenCode loads it directly); it exports the pure
// envelope builder alongside the plugin so this test can validate the shape
// without a live opencode process.
import { buildOpencodeStopEnvelope, buildOpencodeEnvelope, isChildSession, WmuxBridge } from '../plugins/wmux.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// The bridge's daemon pipe, faked: no socket, so no platform or timing
// dependence. Every written request is recorded and answered after `hold`.
const net = vi.hoisted(() => ({ signals: [] as Array<{ kind: string; payload: Record<string, unknown> }>, hold: Promise.resolve() }));
vi.mock('node:net', () => ({
  createConnection: () => {
    const sock = new EventEmitter() as EventEmitter & { write(data: string): boolean; destroy(): void };
    sock.write = (data: string) => {
      const request = JSON.parse(data);
      net.signals.push(request.params);
      void net.hold.then(() => sock.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + '\n')));
      return true;
    };
    sock.destroy = () => undefined;
    void Promise.resolve().then(() => sock.emit('connect'));
    return sock;
  },
}));
import { isAgentSignal } from '../../shared/signal-types';

describe('buildOpencodeStopEnvelope', () => {
  const baseEnv = {
    WMUX_PTY_ID: 'pty-123',
    WMUX_WORKSPACE_ID: 'ws-abc',
    WMUX_SURFACE_ID: 'surf-9',
  } as NodeJS.ProcessEnv;

  it('builds a canonical agent.stop / opencode envelope from the pane env', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/proj', now: 42 });
    expect(env).toMatchObject({
      kind: 'agent.stop',
      agent: 'opencode',
      ptyId: 'pty-123',
      workspaceId: 'ws-abc',
      surfaceId: 'surf-9',
      cwd: '/proj',
      payload: {},
      ts: 42,
    });
  });

  it('produces an envelope the wmux daemon accepts (isAgentSignal)', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/proj', sessionId: 's1', now: 1 });
    expect(isAgentSignal(env)).toBe(true);
  });

  it('carries agentSessionId only when a session id is given', () => {
    expect(buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/p', now: 1 }).agentSessionId).toBeUndefined();
    expect(
      buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/p', sessionId: 'sess-7', now: 1 }).agentSessionId,
    ).toBe('sess-7');
  });

  it('omits routing fields absent from the env (never sends empty strings)', () => {
    const env = buildOpencodeStopEnvelope({ env: {} as NodeJS.ProcessEnv, cwd: '/p', now: 1 });
    expect(env.ptyId).toBeUndefined();
    expect(env.workspaceId).toBeUndefined();
    expect(env.surfaceId).toBeUndefined();
    // Still a valid envelope — cwd + ts + payload carry it (cwd-fallback routing).
    expect(isAgentSignal(env)).toBe(true);
  });

  it('falls back to process.cwd() when no cwd is supplied', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, now: 1 });
    expect(env.cwd).toBe(process.cwd());
    expect(env.cwd.length).toBeGreaterThan(0);
  });
});

describe('buildOpencodeEnvelope — awaiting_input (permission approval)', () => {
  const baseEnv = { WMUX_PTY_ID: 'pty-1', WMUX_WORKSPACE_ID: 'ws-1' } as NodeJS.ProcessEnv;

  it('builds a valid agent.awaiting_input envelope carrying the approval title', () => {
    const env = buildOpencodeEnvelope('agent.awaiting_input', {
      env: baseEnv,
      cwd: '/p',
      sessionId: 's1',
      payload: { title: 'Run `rm -rf build`?' },
      now: 5,
    });
    expect(env.kind).toBe('agent.awaiting_input');
    expect(env.agent).toBe('opencode');
    expect(env.ptyId).toBe('pty-1');
    expect(env.payload).toEqual({ title: 'Run `rm -rf build`?' });
    expect(isAgentSignal(env)).toBe(true);
  });

  it('coerces a non-object payload to {}', () => {
    const env = buildOpencodeEnvelope('agent.stop', { env: baseEnv, cwd: '/p', payload: 'nope' as unknown as object, now: 1 });
    expect(env.payload).toEqual({});
    expect(isAgentSignal(env)).toBe(true);
  });
});

describe('isChildSession — sub-agent suppression', () => {
  const clientReturning = (session: unknown) => ({
    session: { get: async () => ({ data: session }) },
  });

  it('treats a session with a parentID as a child (suppress)', async () => {
    const client = clientReturning({ id: 's1', parentID: 'root-0' });
    expect(await isChildSession(client, 's1')).toBe(true);
  });

  it('treats a session with no parentID as root (emit)', async () => {
    const client = clientReturning({ id: 's1' });
    expect(await isChildSession(client, 's1')).toBe(false);
  });

  it('accepts a client that returns the session directly (no {data} wrapper)', async () => {
    const client = { session: { get: async () => ({ id: 's1', parentID: 'r' }) } };
    expect(await isChildSession(client, 's1')).toBe(true);
  });

  it('fails OPEN (root/emit) when the lookup throws', async () => {
    const client = { session: { get: async () => { throw new Error('offline'); } } };
    expect(await isChildSession(client, 's1')).toBe(false);
  });

  it('fails OPEN when no client or no session id is available', async () => {
    expect(await isChildSession(undefined, 's1')).toBe(false);
    expect(await isChildSession({ session: { get: async () => ({}) } }, undefined)).toBe(false);
  });
});

describe('WmuxBridge 0.3.0 — decision signals', () => {
  // The daemon pipe is a fake socket (no real IPC, fake timers): each signal
  // is recorded when written and answered once `net.hold` releases.
  async function bridgeRig(parents: Record<string, string | undefined | Error> = { ses_root: undefined, ses_kid: 'ses_root', ses_deep: 'ses_kid' }) {
    const home = mkdtempSync(join(tmpdir(), 'oc-bridge-'));
    const dir = join(home, '.wmux-octest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon-auth-token'), 'tok');
    writeFileSync(join(dir, 'daemon-pipe'), join(dir, 'd.sock'));
    const keys = ['HOME', 'USERPROFILE', 'WMUX_DATA_SUFFIX', 'WMUX_PTY_ID', 'WMUX_PIPE_NAME', 'WMUX_HOOKS_TO_MAIN'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.HOME = home; process.env.USERPROFILE = home; process.env.WMUX_DATA_SUFFIX = '-octest'; process.env.WMUX_PTY_ID = 'pty-1';
    net.signals.length = 0; net.hold = Promise.resolve();
    const lookups: Record<string, Promise<void>> = {};
    const client = { session: { get: async ({ path }: { path: { id: string } }) => {
      await lookups[path.id];
      const parent = parents[path.id];
      if (parent instanceof Error) throw parent;
      return { data: { id: path.id, parentID: parent } };
    } } };
    const plugin = await WmuxBridge({ directory: '/p', client });
    const emit = (type: string, properties: Record<string, unknown>) => plugin.event({ event: { type, properties } });
    const settle = () => vi.advanceTimersByTimeAsync(600);
    const close = () => {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      rmSync(home, { recursive: true, force: true });
    };
    return { emit, settle, close, lookups, kinds: () => net.signals.map((x) => [x.kind, x.payload]) };
  }
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a question and a direct child's permission signal with permId; their reply sends input_answered", async () => {
    const r = await bridgeRig();
    try {
      await r.emit('question.asked', { id: 'que_1', sessionID: 'ses_root' });
      await r.emit('permission.asked', { id: 'per_kid', sessionID: 'ses_kid' });
      await r.emit('permission.asked', { id: 'per_deep', sessionID: 'ses_deep' });
      await r.settle();
      expect(r.kinds().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
        ['agent.awaiting_input', { permId: 'per_kid' }],
        ['agent.awaiting_input', { permId: 'que_1' }],
      ]);
      await r.emit('question.replied', { requestID: 'que_1', sessionID: 'ses_root', answers: [['Red']] });
      // A grandchild's request was never signalled, so its reply stays silent.
      await r.emit('permission.replied', { requestID: 'per_deep', sessionID: 'ses_deep', reply: 'once' });
      await r.settle();
      expect(r.kinds().slice(2)).toEqual([['agent.input_answered', { permId: 'que_1' }]]);
    } finally { r.close(); }
  });

  it('an auto-approved permission (replied inside the settle window) sends nothing at all', async () => {
    const r = await bridgeRig();
    try {
      await r.emit('permission.asked', { id: 'per_auto', sessionID: 'ses_root' });
      await r.emit('permission.replied', { requestID: 'per_auto', sessionID: 'ses_root', reply: 'once' });
      await r.settle();
      expect(r.kinds()).toEqual([]);
    } finally { r.close(); }
  });

  it('input_answered never overtakes its own awaiting_input', async () => {
    const r = await bridgeRig();
    try {
      let release!: () => void;
      net.hold = new Promise<void>((done) => { release = done; });
      await r.emit('permission.asked', { id: 'per_1', sessionID: 'ses_root' });
      await r.settle();
      // The awaiting_input is on the wire, unanswered; the reply lands now.
      await r.emit('permission.replied', { requestID: 'per_1', sessionID: 'ses_root', reply: 'once' });
      await r.settle();
      expect(r.kinds()).toEqual([['agent.awaiting_input', { permId: 'per_1' }]]);
      release();
      await r.settle();
      expect(r.kinds()).toEqual([['agent.awaiting_input', { permId: 'per_1' }], ['agent.input_answered', { permId: 'per_1' }]]);
    } finally { r.close(); }
  });

  it('a reply that lands while the session is looked up stops the signal instead of being lost', async () => {
    const r = await bridgeRig();
    try {
      let release!: () => void;
      r.lookups.ses_root = new Promise<void>((done) => { release = done; });
      await r.emit('permission.asked', { id: 'per_1', sessionID: 'ses_root' });
      await r.settle();
      await r.emit('permission.replied', { requestID: 'per_1', sessionID: 'ses_root', reply: 'once' });
      release();
      await r.settle();
      expect(r.kinds()).toEqual([]);
    } finally { r.close(); }
  });

  it('a failed session lookup raises nothing (not treated as a root)', async () => {
    const r = await bridgeRig({ ses_x: new Error('server down') });
    try {
      await r.emit('permission.asked', { id: 'per_1', sessionID: 'ses_x' });
      await r.settle();
      expect(r.kinds()).toEqual([]);
    } finally { r.close(); }
  });
});
