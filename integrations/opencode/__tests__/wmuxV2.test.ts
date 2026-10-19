import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// OpenCode 2.x front end of the lifecycle plugin: `setup(ctx)` with
// `ctx.event.subscribe()`, session.execution.* / permission.* / form.* events,
// and routing that survives OpenCode's shared background service.
import plugin, { WmuxBridge, isPrivateServer, isV2Host, routingEnv, setupV2 } from '../plugins/wmux.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// The bridge's pipe, faked: every written request is recorded and answered.
const net = vi.hoisted(() => ({ signals: [] as Array<Record<string, unknown>> }));
vi.mock('node:net', () => ({
  createConnection: () => {
    const sock = new EventEmitter() as EventEmitter & { write(data: string): boolean; destroy(): void };
    sock.write = (data: string) => {
      const request = JSON.parse(data);
      net.signals.push(request.params);
      void Promise.resolve().then(() => sock.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + '\n')));
      return true;
    };
    sock.destroy = () => undefined;
    void Promise.resolve().then(() => sock.emit('connect'));
    return sock;
  },
}));

type Session = { parentID?: string; directory?: string } | Error;

/** One OpenCode 2.x server process: a shared event bus and a session table. */
function serverRig(sessions: Record<string, Session>, argv: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'oc2-bridge-'));
  const dir = join(home, '.wmux-oc2test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'daemon-auth-token'), 'tok');
  writeFileSync(join(dir, 'daemon-pipe'), join(dir, 'd.sock'));
  const keys = ['HOME', 'USERPROFILE', 'WMUX_DATA_SUFFIX', 'WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_PIPE_NAME', 'WMUX_HOOKS_TO_MAIN'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, WMUX_DATA_SUFFIX: '-oc2test',
    // The pane that STARTED the server, not the one whose session runs.
    WMUX_PTY_ID: 'pty-starter', WMUX_WORKSPACE_ID: 'ws-starter', WMUX_SURFACE_ID: 'surf-starter',
  });
  const savedArgv = process.argv;
  process.argv = ['bun', 'opencode', ...argv];
  net.signals.length = 0;

  const listeners = new Set<(event: unknown) => void>();
  const cleanups: Array<() => void> = [];
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      const s = sessions[sessionID];
      if (s instanceof Error) throw s;
      if (!s) throw new Error('not found');
      return { id: sessionID, parentID: s.parentID, location: { directory: s.directory ?? '/unknown' } };
    },
  };
  /** One plugin instance, as OpenCode loads one per directory. */
  const instance = (directory: string) => {
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    const push = (event: unknown) => { queue.push(event); wake?.(); };
    listeners.add(push);
    const subscribe = ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          if (queue.length === 0) await new Promise<void>((r) => { wake = r; signal.addEventListener('abort', () => r(), { once: true }); });
          while (queue.length > 0) yield queue.shift();
        }
      },
    });
    cleanups.push(setupV2({ app: { name: 'cli', version: '2.0.29', channel: 'latest' }, location: { directory }, session, event: { subscribe } }));
  };
  // Event ids are claimed process-wide, so each rig gets its own id space.
  const rig = Math.random().toString(36).slice(2);
  let n = 0;
  const emit = async (type: string, data: Record<string, unknown>) => {
    const event = { id: `evt_${rig}_${++n}`, created: Date.now(), type, data };
    for (const l of listeners) l(event);
    await vi.advanceTimersByTimeAsync(0);
  };
  const settle = () => vi.advanceTimersByTimeAsync(600);
  /** Unload every instance, as OpenCode does when the plugin file changes. */
  const unload = () => { for (const c of cleanups.splice(0)) c(); };
  const close = () => {
    unload();
    process.argv = savedArgv;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(home, { recursive: true, force: true });
  };
  const log = () => readFileSync(join(dir, 'opencode-bridge.log'), 'utf8');
  const sent = () => net.signals.map((s) => ({ kind: s.kind, cwd: s.cwd, ptyId: s.ptyId, workspaceId: s.workspaceId, surfaceId: s.surfaceId, payload: s.payload }));
  return { instance, emit, settle, close, unload, sent, log };
}

const SESSIONS: Record<string, Session> = {
  ses_a: { directory: '/proj/a' },
  ses_b: { directory: '/proj/b' },
  ses_kid: { parentID: 'ses_a', directory: '/proj/a' },
  ses_deep: { parentID: 'ses_kid', directory: '/proj/a' },
  ses_gone: new Error('server down'),
};

describe('OpenCode 2.x host detection', () => {
  it('runs only in a 2.x host, not in the partial context OpenCode 1.19 also passes to setup', () => {
    const full = { event: { subscribe: () => undefined }, session: { get: () => undefined } };
    expect(isV2Host({ ...full, app: { version: '2.0.29' } })).toBe(true);
    expect(isV2Host({ ...full, app: { version: '0.0.0-beta-19507' } })).toBe(true);
    expect(isV2Host({ ...full, app: { version: '1.19.0' } })).toBe(false);
    // What OpenCode 1.19 passes: options, agent, plugin, … but no event/session.
    expect(isV2Host({ options: {}, agent: {}, plugin: {} })).toBe(false);
    expect(isV2Host(undefined)).toBe(false);
  });

  it('one default export carries both front ends', () => {
    expect(plugin).toMatchObject({ id: 'wmux-opencode-lifecycle', server: WmuxBridge, setup: setupV2 });
  });

  it('trusts the pane env only in a private `serve --stdio` server', () => {
    const env = { WMUX_PTY_ID: 'p', WMUX_WORKSPACE_ID: 'w', WMUX_SURFACE_ID: 's', WMUX_DATA_SUFFIX: '-x' } as NodeJS.ProcessEnv;
    expect(isPrivateServer(['bun', 'opencode', 'serve', '--stdio', '--port', '0'])).toBe(true);
    expect(isPrivateServer(['bun', 'opencode', 'serve', '--service'])).toBe(false);
    expect(routingEnv(env, ['serve', '--stdio'])).toBe(env);
    expect(routingEnv(env, ['serve', '--service'])).toEqual({ WMUX_DATA_SUFFIX: '-x' });
  });
});

describe('OpenCode 2.x lifecycle signals', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a shared service sends one stop per turn, routed by the session directory with no pane ids', async () => {
    const r = serverRig(SESSIONS, ['serve', '--service']);
    try {
      // Two instances (two directories) both see every event.
      r.instance('/proj/a');
      r.instance('/proj/b');
      await r.emit('session.execution.succeeded', { sessionID: 'ses_b' });
      await r.emit('session.execution.failed', { sessionID: 'ses_a', error: { type: 'x' } });
      await r.settle();
      expect(r.sent()).toEqual([
        { kind: 'agent.stop', cwd: '/proj/b', ptyId: undefined, workspaceId: undefined, surfaceId: undefined, payload: {} },
        { kind: 'agent.stop', cwd: '/proj/a', ptyId: undefined, workspaceId: undefined, surfaceId: undefined, payload: {} },
      ]);
    } finally { r.close(); }
  });

  it('a private --stdio server keeps the pane ids', async () => {
    const r = serverRig(SESSIONS, ['serve', '--stdio', '--port', '0']);
    try {
      r.instance('/proj/a');
      await r.emit('session.execution.succeeded', { sessionID: 'ses_a' });
      await r.settle();
      expect(r.sent()).toEqual([
        { kind: 'agent.stop', cwd: '/proj/a', ptyId: 'pty-starter', workspaceId: 'ws-starter', surfaceId: 'surf-starter', payload: {} },
      ]);
    } finally { r.close(); }
  });

  it('a user or inactivity interrupt ends the turn; superseded and shutdown do not; a child never stops', async () => {
    const r = serverRig(SESSIONS, ['serve', '--service']);
    try {
      r.instance('/proj/a');
      await r.emit('session.execution.interrupted', { sessionID: 'ses_a', reason: 'superseded' });
      await r.emit('session.execution.interrupted', { sessionID: 'ses_a', reason: 'shutdown' });
      await r.emit('session.execution.succeeded', { sessionID: 'ses_kid' });
      await r.settle();
      expect(r.sent()).toEqual([]);
      await r.emit('session.execution.interrupted', { sessionID: 'ses_a', reason: 'user' });
      await r.emit('session.execution.interrupted', { sessionID: 'ses_a', reason: 'inactivity' });
      await r.settle();
      expect(r.sent().map((s) => s.kind)).toEqual(['agent.stop', 'agent.stop']);
    } finally { r.close(); }
  });

  it('a shared service drops a stop whose session lookup failed rather than guess a pane', async () => {
    const r = serverRig(SESSIONS, ['serve', '--service']);
    try {
      r.instance('/proj/a');
      await r.emit('session.execution.succeeded', { sessionID: 'ses_gone' });
      await r.settle();
      expect(r.sent()).toEqual([]);
      expect(r.log()).toContain('skip-no-session-cwd');
    } finally { r.close(); }
  });

  it('a held permission and a form signal once with permId; their replies send input_answered', async () => {
    const r = serverRig(SESSIONS, ['serve', '--service']);
    try {
      r.instance('/proj/a');
      r.instance('/proj/b');
      await r.emit('permission.asked', { id: 'per_1', sessionID: 'ses_kid', action: 'shell', resources: ['ls'] });
      await r.emit('form.created', { form: { id: 'frm_1', sessionID: 'ses_b', title: 'Questions', fields: [] } });
      // A grandchild's request is nobody's to answer from here.
      await r.emit('permission.asked', { id: 'per_deep', sessionID: 'ses_deep', action: 'shell', resources: ['ls'] });
      await r.settle();
      expect(r.sent()).toEqual([
        { kind: 'agent.awaiting_input', cwd: '/proj/a', ptyId: undefined, workspaceId: undefined, surfaceId: undefined, payload: { title: 'shell', permId: 'per_1' } },
        { kind: 'agent.awaiting_input', cwd: '/proj/b', ptyId: undefined, workspaceId: undefined, surfaceId: undefined, payload: { title: 'Questions', permId: 'frm_1' } },
      ]);
      await r.emit('permission.replied', { sessionID: 'ses_kid', requestID: 'per_1', reply: 'once' });
      await r.emit('form.cancelled', { id: 'frm_1', sessionID: 'ses_b' });
      await r.emit('permission.replied', { sessionID: 'ses_deep', requestID: 'per_deep', reply: 'once' });
      await r.settle();
      expect(r.sent().slice(2).map((s) => [s.kind, s.cwd, s.payload])).toEqual([
        ['agent.input_answered', '/proj/a', { permId: 'per_1' }],
        ['agent.input_answered', '/proj/b', { permId: 'frm_1' }],
      ]);
    } finally { r.close(); }
  });

  it('an unload inside the settle window cancels the pending awaiting_input', async () => {
    const r = serverRig(SESSIONS, ['serve', '--service']);
    try {
      r.instance('/proj/a');
      await r.emit('permission.asked', { id: 'per_reload', sessionID: 'ses_a', action: 'shell', resources: ['ls'] });
      r.unload();
      await r.settle();
      expect(r.sent()).toEqual([]);
    } finally { r.close(); }
  });

  it('an auto-approved permission (replied inside the settle window) sends nothing', async () => {
    const r = serverRig(SESSIONS, ['serve', '--service']);
    try {
      r.instance('/proj/a');
      await r.emit('permission.asked', { id: 'per_auto', sessionID: 'ses_a', action: 'shell', resources: ['ls'] });
      await r.emit('permission.replied', { sessionID: 'ses_a', requestID: 'per_auto', reply: 'reject' });
      await r.settle();
      expect(r.sent()).toEqual([]);
    } finally { r.close(); }
  });
});
