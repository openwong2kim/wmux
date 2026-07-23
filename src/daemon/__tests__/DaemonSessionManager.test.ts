import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

// --- Mock node-pty -----------------------------------------------------------

class MockPty extends EventEmitter {
  pid = 12345;
  private _cols: number;
  private _rows: number;
  /** Captured spawn env, so tests can assert the resolved child environment. */
  readonly spawnEnv: Record<string, string> | undefined;
  /** Captured spawn argv (X8 exec wrapper assertions). */
  readonly spawnArgs: string[];
  private dataCallbacks: ((data: string) => void)[] = [];
  private exitCallbacks: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  killed = false;

  constructor(_cmd: string, args: string[], opts: { cols: number; rows: number; env?: Record<string, string> }) {
    super();
    this._cols = opts.cols;
    this._rows = opts.rows;
    this.spawnEnv = opts.env;
    this.spawnArgs = args;
  }

  onData(cb: (data: string) => void) {
    this.dataCallbacks.push(cb);
    return { dispose: () => { /* noop */ } };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCallbacks.push(cb);
    return { dispose: () => { /* noop */ } };
  }

  write(_data: string): void { /* noop */ }

  /** Count of resize() calls = SIGWINCH emissions, for startup-grace assertions. */
  resizeCalls = 0;

  resize(cols: number, rows: number): void {
    this.resizeCalls += 1;
    this._cols = cols;
    this._rows = rows;
  }

  kill(): void {
    this.killed = true;
  }

  // Test helpers
  simulateData(data: string): void {
    for (const cb of this.dataCallbacks) cb(data);
  }

  simulateExit(exitCode: number): void {
    for (const cb of this.exitCallbacks) cb({ exitCode });
  }

  get cols() { return this._cols; }
  get rows() { return this._rows; }
}

let lastMockPty: MockPty | null = null;

vi.mock('node-pty', () => ({
  default: {
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      const mock = new MockPty(cmd, args as string[], opts as { cols: number; rows: number });
      lastMockPty = mock;
      return mock;
    },
  },
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const mock = new MockPty(cmd, args as string[], opts as { cols: number; rows: number });
    lastMockPty = mock;
    return mock;
  },
}));

// Import after mock is set up
import { DaemonSessionManager } from '../DaemonSessionManager';
import { createDefaultConfig } from '../config';
import { PWSH_EXIT_TAIL } from '../execWrapper';

describe('DaemonSessionManager', () => {
  let manager: DaemonSessionManager;

  beforeEach(() => {
    manager = new DaemonSessionManager();
    lastMockPty = null;
  });

  afterEach(() => {
    manager.disposeAll();
  });

  // 1. createSession → session created with state = detached
  it('creates a session in detached state', () => {
    const session = manager.createSession({
      id: 'test-1',
      cmd: 'cmd.exe',
      cwd: 'C:\\Users',
    });

    expect(session).toBeDefined();
    expect(session.id).toBe('test-1');
    expect(session.state).toBe('detached');
    expect(session.cmd).toContain('cmd.exe');
    expect(session.cwd).toBe('C:\\Users');
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);
    expect(session.pid).toBe(12345);
    expect(session.createdAt).toBeTruthy();
  });

  // Env resolution: the daemon trusts a supplied (main-resolved) env verbatim
  // except its own auth token, but for the process.env FALLBACK it drops the
  // whole reserved WMUX_* namespace so a daemon launched from a wmux pane can't
  // leak a stale identity. See resolveSpawnEnv (main) for the symmetric strip.
  it('drops the whole reserved WMUX_* namespace from the process.env fallback', () => {
    const prevWs = process.env.WMUX_WORKSPACE_ID;
    const prevSock = process.env.WMUX_SOCKET_PATH;
    process.env.WMUX_WORKSPACE_ID = 'stale-ws';
    process.env.WMUX_SOCKET_PATH = '\\\\.\\pipe\\stale';
    try {
      manager.createSession({ id: 'fallback-env', cmd: 'cmd.exe', cwd: '.' }); // no env supplied
      expect(lastMockPty?.spawnEnv?.WMUX_WORKSPACE_ID).toBeUndefined();
      expect(lastMockPty?.spawnEnv?.WMUX_SOCKET_PATH).toBeUndefined();
    } finally {
      if (prevWs === undefined) delete process.env.WMUX_WORKSPACE_ID; else process.env.WMUX_WORKSPACE_ID = prevWs;
      if (prevSock === undefined) delete process.env.WMUX_SOCKET_PATH; else process.env.WMUX_SOCKET_PATH = prevSock;
    }
  });

  it('trusts a supplied env verbatim except the auth token (forced identity preserved)', () => {
    manager.createSession({
      id: 'supplied-env',
      cmd: 'cmd.exe',
      cwd: '.',
      env: { WMUX_WORKSPACE_ID: 'real-ws', WMUX_AUTH_TOKEN: 'secret', FOO: 'bar' },
    });
    // main already forced identity into the supplied env — keep it.
    expect(lastMockPty?.spawnEnv?.WMUX_WORKSPACE_ID).toBe('real-ws');
    expect(lastMockPty?.spawnEnv?.FOO).toBe('bar');
    // the daemon's own RPC token is always stripped, even from a supplied env.
    expect(lastMockPty?.spawnEnv?.WMUX_AUTH_TOKEN).toBeUndefined();
  });

  // Instance-isolation suffix (WMUX_DATA_SUFFIX) must always reflect THIS
  // daemon's own instance, never a value carried in a replayed/persisted env
  // blob — otherwise a recovered pane could be pointed at a DIFFERENT instance's
  // control pipe. stripReservedAuth keeps non-auth WMUX_* from a supplied env, so
  // the daemon forces its own inherited suffix over the blob (and scrubs it when
  // the daemon itself has none).
  it("forces the daemon's own WMUX_DATA_SUFFIX over a replayed env blob", () => {
    const prev = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = '-rc35';
    try {
      manager.createSession({
        id: 'suffix-override',
        cmd: 'cmd.exe',
        cwd: '.',
        env: { WMUX_DATA_SUFFIX: '-attacker', FOO: 'bar' },
      });
      expect(lastMockPty?.spawnEnv?.WMUX_DATA_SUFFIX).toBe('-rc35'); // blob value overwritten
      expect(lastMockPty?.spawnEnv?.FOO).toBe('bar');
    } finally {
      if (prev === undefined) delete process.env.WMUX_DATA_SUFFIX; else process.env.WMUX_DATA_SUFFIX = prev;
    }
  });

  it('scrubs a stale WMUX_DATA_SUFFIX from a replayed blob when the daemon has none (prod)', () => {
    const prev = process.env.WMUX_DATA_SUFFIX;
    delete process.env.WMUX_DATA_SUFFIX; // production daemon: no suffix
    try {
      manager.createSession({
        id: 'suffix-scrub',
        cmd: 'cmd.exe',
        cwd: '.',
        env: { WMUX_DATA_SUFFIX: '-dev', FOO: 'bar' },
      });
      expect(lastMockPty?.spawnEnv?.WMUX_DATA_SUFFIX).toBeUndefined(); // not left on the '-dev' pipe
      expect(lastMockPty?.spawnEnv?.FOO).toBe('bar');
    } finally {
      if (prev === undefined) delete process.env.WMUX_DATA_SUFFIX; else process.env.WMUX_DATA_SUFFIX = prev;
    }
  });

  it('scrubs a CASE-VARIANT WMUX_DATA_SUFFIX from a replayed blob (Windows env is case-insensitive)', () => {
    const prev = process.env.WMUX_DATA_SUFFIX;
    delete process.env.WMUX_DATA_SUFFIX; // production daemon: no suffix
    try {
      manager.createSession({
        id: 'suffix-case',
        cmd: 'cmd.exe',
        cwd: '.',
        env: { wmux_data_suffix: '-stale', FOO: 'bar' }, // lowercase variant survives stripReservedAuth
      });
      const spawned = lastMockPty?.spawnEnv ?? {};
      const anyVariant = Object.keys(spawned).some((k) => k.toUpperCase() === 'WMUX_DATA_SUFFIX');
      expect(anyVariant).toBe(false); // no case-variant reaches the child
      expect(spawned.FOO).toBe('bar');
    } finally {
      if (prev === undefined) delete process.env.WMUX_DATA_SUFFIX; else process.env.WMUX_DATA_SUFFIX = prev;
    }
  });

  it("propagates the daemon's own suffix in the process.env fallback (no supplied env)", () => {
    const prev = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = '-rc35';
    try {
      manager.createSession({ id: 'suffix-fallback', cmd: 'cmd.exe', cwd: '.' }); // no env
      expect(lastMockPty?.spawnEnv?.WMUX_DATA_SUFFIX).toBe('-rc35');
    } finally {
      if (prev === undefined) delete process.env.WMUX_DATA_SUFFIX; else process.env.WMUX_DATA_SUFFIX = prev;
    }
  });

  it('emits session:created event', () => {
    const handler = vi.fn();
    manager.on('session:created', handler);

    manager.createSession({ id: 'test-ev', cmd: 'cmd.exe', cwd: '.' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].session.id).toBe('test-ev');
  });

  it('throws when creating a session with duplicate id', () => {
    manager.createSession({ id: 'dup', cmd: 'cmd.exe', cwd: '.' });
    expect(() => manager.createSession({ id: 'dup', cmd: 'cmd.exe', cwd: '.' }))
      .toThrow("Session 'dup' already exists");
  });

  // 2. listSessions → returns created sessions
  it('returns all sessions via listSessions', () => {
    manager.createSession({ id: 's1', cmd: 'cmd.exe', cwd: '.' });
    manager.createSession({ id: 's2', cmd: 'cmd.exe', cwd: '.' });

    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  // 2b. listLiveSessions → filters out dead + suspended
  it('listLiveSessions excludes dead and suspended sessions', () => {
    // Seed four sessions covering every state. createSession defaults
    // to 'detached'; attachSession flips one to 'attached'; the
    // simulateExit hook on the mocked PTY drives one to 'dead'; the
    // last one we drop into 'suspended' by reaching into the managed
    // record directly because that transition normally happens inside
    // recovery paths the manager does not expose publicly.
    manager.createSession({ id: 'attached-one', cmd: 'cmd.exe', cwd: '.' });
    manager.attachSession('attached-one');

    manager.createSession({ id: 'detached-one', cmd: 'cmd.exe', cwd: '.' });
    // Already in 'detached' on creation — no transition needed.

    manager.createSession({ id: 'dead-one', cmd: 'cmd.exe', cwd: '.' });
    lastMockPty?.simulateExit(0);

    manager.createSession({ id: 'suspended-one', cmd: 'cmd.exe', cwd: '.' });
    const susp = manager.getSession('suspended-one');
    if (!susp) throw new Error('test setup: suspended-one not found');
    susp.meta.state = 'suspended';

    const live = manager.listLiveSessions();
    expect(live.map((s) => s.id).sort()).toEqual(['attached-one', 'detached-one']);
    // listSessions still returns all four — listLiveSessions is the
    // filtered view, not a replacement.
    expect(manager.listSessions()).toHaveLength(4);
  });

  it('listLiveSessions returns an empty array when only tombstones exist', () => {
    // Worst-case shape for the idle-shutdown predicate: the daemon
    // accepts a wmux disconnect, every remaining session is dead or
    // suspended, and the reap TTL is still 24h away. listLiveSessions
    // must report 0 so Watchdog can self-terminate without waiting.
    manager.createSession({ id: 'd1', cmd: 'cmd.exe', cwd: '.' });
    lastMockPty?.simulateExit(0);
    manager.createSession({ id: 'd2', cmd: 'cmd.exe', cwd: '.' });
    lastMockPty?.simulateExit(0);
    const s = manager.createSession({ id: 'sp', cmd: 'cmd.exe', cwd: '.' });
    void s;
    const sp = manager.getSession('sp')!;
    sp.meta.state = 'suspended';

    expect(manager.listLiveSessions()).toEqual([]);
    expect(manager.listSessions()).toHaveLength(3);
  });

  // 3. attachSession → state changes to attached
  it('changes state to attached via attachSession', () => {
    manager.createSession({ id: 'att', cmd: 'cmd.exe', cwd: '.' });
    const stateHandler = vi.fn();
    manager.on('session:stateChanged', stateHandler);

    manager.attachSession('att');

    expect(stateHandler).toHaveBeenCalledWith({ id: 'att', state: 'attached' });
    const sessions = manager.listSessions();
    expect(sessions[0].state).toBe('attached');
  });

  it('throws when attaching non-existent session', () => {
    expect(() => manager.attachSession('nope')).toThrow("Session 'nope' not found");
  });

  // 4. detachSession → state changes to detached
  it('changes state to detached via detachSession', () => {
    manager.createSession({ id: 'det', cmd: 'cmd.exe', cwd: '.' });
    manager.attachSession('det');

    const stateHandler = vi.fn();
    manager.on('session:stateChanged', stateHandler);

    manager.detachSession('det');

    expect(stateHandler).toHaveBeenCalledWith({ id: 'det', state: 'detached' });
    const sessions = manager.listSessions();
    expect(sessions[0].state).toBe('detached');
  });

  // 5. destroySession → session removed
  it('destroys a session and removes it from the list', () => {
    manager.createSession({ id: 'kill', cmd: 'cmd.exe', cwd: '.' });
    const destroyHandler = vi.fn();
    manager.on('session:destroyed', destroyHandler);

    manager.destroySession('kill');

    expect(destroyHandler).toHaveBeenCalledWith({ id: 'kill' });
    expect(manager.listSessions()).toHaveLength(0);
    expect(manager.getSession('kill')).toBeUndefined();
  });

  it('destroySession on non-existent id is a no-op', () => {
    expect(() => manager.destroySession('ghost')).not.toThrow();
  });

  // 6. disposeAll → all sessions destroyed
  it('disposes all sessions', () => {
    manager.createSession({ id: 'a', cmd: 'cmd.exe', cwd: '.' });
    manager.createSession({ id: 'b', cmd: 'cmd.exe', cwd: '.' });
    manager.createSession({ id: 'c', cmd: 'cmd.exe', cwd: '.' });

    const destroyHandler = vi.fn();
    manager.on('session:destroyed', destroyHandler);

    manager.disposeAll();

    expect(manager.listSessions()).toHaveLength(0);
    expect(destroyHandler).toHaveBeenCalledTimes(3);
  });

  // resizeSession
  it('resizes a session', () => {
    manager.createSession({ id: 'rsz', cmd: 'cmd.exe', cwd: '.', cols: 80, rows: 24 });
    manager.resizeSession('rsz', 120, 40);

    const session = manager.getSession('rsz');
    expect(session?.meta.cols).toBe(120);
    expect(session?.meta.rows).toBe(40);
  });

  it('throws when resizing non-existent session', () => {
    expect(() => manager.resizeSession('nope', 80, 24)).toThrow("Session 'nope' not found");
  });

  it('codex review catch: an actual geometry change stamps the bridge resize-guard timestamp (noteResize)', () => {
    // DaemonPTYBridge.noteResize() feeds the resize-redraw guard that
    // defers (not skips) the AgentDetector emission-dedup reset — without
    // this wiring, the daemon-mode guard would never engage at all and
    // every workspace switch would risk a stale re-notification (the local-
    // mode PTYBridge equivalent is covered end-to-end in
    // PTYBridge.lifecycle.test.ts; DaemonPTYBridge has no dedicated harness,
    // so this pins the SessionManager→bridge wiring specifically).
    manager.createSession({ id: 'rsz-note', cmd: 'cmd.exe', cwd: '.', cols: 80, rows: 24 });
    const session = manager.getSession('rsz-note');
    const noteResizeSpy = vi.spyOn(session!.bridge, 'noteResize');

    manager.resizeSession('rsz-note', 120, 40);
    expect(noteResizeSpy).toHaveBeenCalledTimes(1);

    // Same geometry again → the early-return-on-unchanged-size path (SIGWINCH
    // avoidance) must also skip noting a resize — nothing actually changed.
    manager.resizeSession('rsz-note', 120, 40);
    expect(noteResizeSpy).toHaveBeenCalledTimes(1);

    // A genuine further change notes again.
    manager.resizeSession('rsz-note', 100, 30);
    expect(noteResizeSpy).toHaveBeenCalledTimes(2);
  });

  // getSession
  it('returns managed session by id', () => {
    manager.createSession({ id: 'get-me', cmd: 'cmd.exe', cwd: '.' });
    const managed = manager.getSession('get-me');
    expect(managed).toBeDefined();
    expect(managed?.meta.id).toBe('get-me');
    expect(managed?.ringBuffer).toBeDefined();
    expect(managed?.bridge).toBeDefined();
  });

  // PTY exit → session:died
  it('emits session:died when PTY process exits', () => {
    manager.createSession({ id: 'die', cmd: 'cmd.exe', cwd: '.' });
    const diedHandler = vi.fn();
    manager.on('session:died', diedHandler);

    // Simulate exit on the mock PTY
    lastMockPty?.simulateExit(1);

    // Payload also carries forensic fields (signal/cmd/lastActivityMsAgo) used
    // by the daemon's death logging; assert the contract fields, tolerate extras.
    expect(diedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 'die', exitCode: 1 }));
    const session = manager.getSession('die');
    expect(session?.meta.state).toBe('dead');
  });

  // Dead session cannot be attached/detached
  it('throws when attaching or detaching a dead session', () => {
    manager.createSession({ id: 'dead', cmd: 'cmd.exe', cwd: '.' });
    lastMockPty?.simulateExit(0);

    expect(() => manager.attachSession('dead')).toThrow("Session 'dead' is dead");
    expect(() => manager.detachSession('dead')).toThrow("Session 'dead' is dead");
  });

  // PTY data → ring buffer
  it('writes PTY data to the ring buffer', () => {
    manager.createSession({ id: 'buf', cmd: 'cmd.exe', cwd: '.' });
    const managed = manager.getSession('buf');

    lastMockPty?.simulateData('hello world');

    const stored = managed?.ringBuffer.readAll().toString();
    expect(stored).toBe('hello world');
  });

  // Agent metadata on session
  it('stores agent metadata when provided', () => {
    const session = manager.createSession({
      id: 'agent-s',
      cmd: 'cmd.exe',
      cwd: '.',
      agent: { role: 'coder', teamId: 'team-1', displayName: 'Claude' },
    });

    expect(session.agent).toEqual({ role: 'coder', teamId: 'team-1', displayName: 'Claude' });
  });

  // Session recovery: scrollbackData pre-fills ring buffer
  it('pre-fills ring buffer with scrollbackData when provided', () => {
    const scrollback = Buffer.from('previous terminal output\r\n$ ls\r\nfile.txt');
    const session = manager.createSession({
      id: 'recover-1',
      cmd: 'cmd.exe',
      cwd: '.',
      scrollbackData: scrollback,
    });

    const managed = manager.getSession('recover-1');
    const stored = managed?.ringBuffer.readAll().toString();
    expect(stored).toBe('previous terminal output\r\n$ ls\r\nfile.txt');
    expect(session.id).toBe('recover-1');
  });

  // Session recovery: preserves original createdAt
  it('preserves original createdAt when provided', () => {
    const originalDate = '2025-01-15T10:30:00.000Z';
    const session = manager.createSession({
      id: 'recover-2',
      cmd: 'cmd.exe',
      cwd: '.',
      createdAt: originalDate,
    });

    expect(session.createdAt).toBe(originalDate);
  });

  // listManagedSessions returns ManagedSession objects
  it('listManagedSessions returns internal managed sessions', () => {
    manager.createSession({ id: 'm1', cmd: 'cmd.exe', cwd: '.' });
    manager.createSession({ id: 'm2', cmd: 'cmd.exe', cwd: '.' });

    const managed = manager.listManagedSessions();
    expect(managed).toHaveLength(2);
    expect(managed[0].ringBuffer).toBeDefined();
    expect(managed[0].bridge).toBeDefined();
    expect(managed[0].ptyProcess).toBeDefined();
  });

  // v2.8.1 hotfix: actionable error at MAX_SESSIONS (Bug 1)
  it('throws an actionable error when the session cap is reached', () => {
    for (let i = 0; i < 200; i++) {
      manager.createSession({ id: `cap-${i}`, cmd: 'cmd.exe', cwd: '.' });
    }
    // The 201st must fail with a message the UI can show verbatim. The
    // pre-v2.8.1 message was "Maximum session limit (50) reached" which
    // surfaced as a generic "unknown error" toast in the renderer.
    expect(() =>
      manager.createSession({ id: 'cap-201', cmd: 'cmd.exe', cwd: '.' }),
    ).toThrow(/Cannot create new terminal: 200 active sessions already running/);
  });

  // substrate 3.0: the session cap is configurable (was a 200 literal)
  it('honours a custom session.maxSessions from setConfig', () => {
    const cfg = createDefaultConfig();
    cfg.session.maxSessions = 3;
    manager.setConfig(cfg);
    for (let i = 0; i < 3; i++) {
      manager.createSession({ id: `cm-${i}`, cmd: 'cmd.exe', cwd: '.' });
    }
    // The cap is now 3, not the default 200 — and the message echoes it.
    expect(() =>
      manager.createSession({ id: 'cm-overflow', cmd: 'cmd.exe', cwd: '.' }),
    ).toThrow(/Cannot create new terminal: 3 active sessions already running/);
  });

  // codex P2: DEAD tombstones must not occupy a cap slot
  it('does not count DEAD tombstones against maxSessions', () => {
    const cfg = createDefaultConfig();
    cfg.session.maxSessions = 2;
    manager.setConfig(cfg);
    manager.createSession({ id: 'd1', cmd: 'cmd.exe', cwd: '.' });
    const d1Pty = lastMockPty; // capture before d2 overwrites lastMockPty
    manager.createSession({ id: 'd2', cmd: 'cmd.exe', cwd: '.' });
    // d1's PTY exits → it becomes a DEAD tombstone still held in the map.
    d1Pty?.simulateExit(0);
    expect(manager.getSession('d1')?.meta.state).toBe('dead');
    // 1 live (d2) + 1 dead (d1). Under cap=2 a new session must be allowed —
    // the dead tombstone must not occupy a live slot.
    expect(() =>
      manager.createSession({ id: 'd3', cmd: 'cmd.exe', cwd: '.' }),
    ).not.toThrow();
  });

  // substrate 3.0: dead-TTL is stamped per session from config (codex #5)
  it('stamps new sessions with deadSessionTtlHours from config', () => {
    const cfg = createDefaultConfig();
    cfg.session.deadSessionTtlHours = 48;
    manager.setConfig(cfg);
    const s = manager.createSession({ id: 'ttl-cfg', cmd: 'cmd.exe', cwd: '.' });
    expect(s.deadTtlHours).toBe(48);
  });

  it('defaults deadTtlHours to 24 when no config is set (createDefaultConfig SSOT)', () => {
    const s = manager.createSession({ id: 'ttl-def', cmd: 'cmd.exe', cwd: '.' });
    expect(s.deadTtlHours).toBe(24);
  });

  // codex P2: recovery passes the saved per-session value, which must win
  // over the current config so a recovered session keeps its create-time
  // retention instead of being silently restamped.
  it('preserves a passed deadTtlHours over the config default (recovery path)', () => {
    const cfg = createDefaultConfig();
    cfg.session.deadSessionTtlHours = 48; // current config
    manager.setConfig(cfg);
    // Recovery hands back the value the session was created with (e.g. 12h
    // from an older config), not the current 48h.
    const s = manager.createSession({ id: 'rec-ttl', cmd: 'cmd.exe', cwd: '.', deadTtlHours: 12 });
    expect(s.deadTtlHours).toBe(12);
  });

  // #557: recovery must thread the persisted lastActivity through so the
  // detached TTL reaper can age out stale orphan shells. Without this,
  // createSession stamped `now` on every boot, immortalising resurrected
  // detached sessions (the orphan-leak the issue reports).
  it('preserves a passed lastActivity over the default `now` (recovery path)', () => {
    const persisted = '2026-01-01T00:00:00.000Z';
    const s = manager.createSession({
      id: 'rec-activity',
      cmd: 'cmd.exe',
      cwd: '.',
      lastActivity: persisted,
    });
    expect(s.lastActivity).toBe(persisted);
  });

  it('stamps lastActivity to ~now for brand-new sessions (no lastActivity passed)', () => {
    const before = Date.now();
    const s = manager.createSession({ id: 'new-activity', cmd: 'cmd.exe', cwd: '.' });
    const stamped = new Date(s.lastActivity).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  // v2.8.1 hotfix: deferred output mode for recovered sessions (Bug 2)
  describe('deferOutput (recovery mode)', () => {
    it('drops PTY data while deferred and the ring buffer stays clean', () => {
      manager.createSession({
        id: 'rec-1',
        cmd: 'cmd.exe',
        cwd: '.',
        deferOutput: true,
      });
      const managed = manager.getSession('rec-1');
      expect(managed?.deferred).toBe(true);
      expect(managed?.bridge.isMuted).toBe(true);

      // ConPTY-style early output (saved geometry) gets dropped.
      lastMockPty?.simulateData('\x1b[?25l$ \x1b[K');
      expect(managed?.ringBuffer.readAll().toString()).toBe('');
    });

    it('preserves pre-filled scrollback while muted', () => {
      // Saved buffer dump is written directly into the ring buffer
      // before `setupDataForwarding`, so it must survive muting.
      manager.createSession({
        id: 'rec-2',
        cmd: 'cmd.exe',
        cwd: '.',
        scrollbackData: Buffer.from('history-before-restart'),
        deferOutput: true,
      });
      const managed = manager.getSession('rec-2');
      // Replay buffer was pre-filled.
      expect(managed?.ringBuffer.readAll().toString()).toBe(
        'history-before-restart',
      );
    });

    it('unmutes after first resize plus the drain delay', () => {
      vi.useFakeTimers();
      try {
        manager.createSession({
          id: 'rec-3',
          cmd: 'cmd.exe',
          cwd: '.',
          deferOutput: true,
        });
        const managed = manager.getSession('rec-3');
        expect(managed?.deferred).toBe(true);

        // Resize flips deferred → false synchronously but schedules
        // the actual unmute so any output ConPTY emits at the prior
        // geometry can drain first.
        manager.resizeSession('rec-3', 120, 30);
        expect(managed?.deferred).toBe(false);
        expect(managed?.bridge.isMuted).toBe(true);

        // Output that fires DURING the drain window is still muted.
        lastMockPty?.simulateData('stale-geometry-bytes');
        expect(managed?.ringBuffer.readAll().toString()).toBe('');

        vi.advanceTimersByTime(100);
        expect(managed?.bridge.isMuted).toBe(false);

        // Output produced AFTER the drain reaches the ring buffer.
        lastMockPty?.simulateData('post-resize prompt $ ');
        expect(managed?.ringBuffer.readAll().toString()).toBe(
          'post-resize prompt $ ',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('default (non-deferred) sessions capture data immediately', () => {
      // Regression guard: Bug 2 fix must not change normal create flow.
      manager.createSession({ id: 'live-1', cmd: 'cmd.exe', cwd: '.' });
      const managed = manager.getSession('live-1');
      expect(managed?.deferred).toBe(false);
      expect(managed?.bridge.isMuted).toBe(false);

      lastMockPty?.simulateData('immediate output');
      expect(managed?.ringBuffer.readAll().toString()).toBe('immediate output');
    });

    it('deferred session that exits before resize still emits session:died', () => {
      // Exit notification path must work even while muted — otherwise
      // a recovered shell that crashes before its first resize would
      // never tell the daemon, and the slot would leak.
      manager.createSession({
        id: 'rec-exit',
        cmd: 'cmd.exe',
        cwd: '.',
        deferOutput: true,
      });
      const diedHandler = vi.fn();
      manager.on('session:died', diedHandler);

      lastMockPty?.simulateExit(2);

      expect(diedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 'rec-exit', exitCode: 2 }));
      expect(manager.getSession('rec-exit')?.meta.state).toBe('dead');
    });
  });

  // The daemon's own default-shell fallback (getDefaultShell), used when a
  // session is created with no explicit cmd, listed Windows PowerShell 5.1
  // before PowerShell 7 — the same ordering bug #176/#178 fixed in the main
  // process but left unfixed on the daemon path. Since 5.1 ships on every
  // Windows box, a 5.1-first order masks an installed pwsh 7 forever.
  describe('default shell fallback (Windows)', () => {
    let origPlatform: PropertyDescriptor | undefined;
    let origSystemRoot: string | undefined;
    let origProgramFiles: string | undefined;
    let origLocalAppData: string | undefined;
    let existsSpy: ReturnType<typeof vi.spyOn>;
    let lstatSpy: ReturnType<typeof vi.spyOn>;
    let readlinkSpy: ReturnType<typeof vi.spyOn>;

    // The shared candidate table (shared/shellResolution.ts, #183) composes
    // paths from these env vars via template literals, so pin them to fixed
    // values: the test must match the source's exact string on any CI OS
    // (where these vars are normally unset).
    const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const PS5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const ALIAS = 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
    const ALIAS_TARGET = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.5.0.0_x64__8wekyb3d8bbwe\\pwsh.exe';

    beforeEach(() => {
      origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      origSystemRoot = process.env.SystemRoot;
      origProgramFiles = process.env.ProgramFiles;
      origLocalAppData = process.env.LOCALAPPDATA;
      process.env.SystemRoot = 'C:\\Windows';
      process.env.ProgramFiles = 'C:\\Program Files';
      process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
      existsSpy = vi.spyOn(fs, 'existsSync');
      // Default: the WindowsApps alias slot is empty (lstat throws), so tests
      // that don't opt into the alias scenario never touch the real fs.
      lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      readlinkSpy = vi.spyOn(fs, 'readlinkSync').mockImplementation(() => {
        throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      });
    });

    afterEach(() => {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (origSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = origSystemRoot;
      if (origProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = origProgramFiles;
      if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = origLocalAppData;
      existsSpy.mockRestore();
      lstatSpy.mockRestore();
      readlinkSpy.mockRestore();
    });

    it('prefers PowerShell 7 over Windows PowerShell 5.1 when both exist', () => {
      existsSpy.mockImplementation((p: fs.PathLike) => p === PWSH7 || p === PS5);
      // Empty cmd is falsy → resolveShellPath returns null → getDefaultShell runs.
      const session = manager.createSession({ id: 'def-pwsh7', cmd: '', cwd: '.' });
      expect(session.cmd).toBe(PWSH7);
    });

    it('falls back to Windows PowerShell 5.1 when pwsh 7 is absent', () => {
      existsSpy.mockImplementation((p: fs.PathLike) => p === PS5);
      const session = manager.createSession({ id: 'def-ps5', cmd: '', cwd: '.' });
      expect(session.cmd).toBe(PS5);
    });

    // Issue #183: on a machine where pwsh 7 exists ONLY as the Microsoft
    // Store App Execution Alias (no traditional install), the daemon must
    // resolve the alias to its spawnable package target instead of dropping
    // to 5.1 — the same behavior #179/#180 gave the main process.
    it('picks Store-installed pwsh 7 (WindowsApps alias) when it is the only pwsh 7 present', () => {
      existsSpy.mockImplementation((p: fs.PathLike) => p === ALIAS_TARGET || p === PS5);
      lstatSpy.mockImplementation((p: fs.PathLike) => {
        if (p === ALIAS) return { isSymbolicLink: () => true } as fs.Stats;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      readlinkSpy.mockImplementation((p: fs.PathLike) => {
        if (p === ALIAS) return ALIAS_TARGET;
        throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      });
      const session = manager.createSession({ id: 'def-alias', cmd: '', cwd: '.' });
      // The resolved package target, NOT the alias stub (node-pty cannot
      // spawn the stub — it silently falls back to 5.1).
      expect(session.cmd).toBe(ALIAS_TARGET);
    });

    // X8: an exec unit whose resolved shell has no known wrapper-argv shape
    // must swap to the platform default (a PowerShell family on Windows)
    // instead of guessing argv for an unknown binary.
    it('falls back to the default shell for an unknown exec wrapper family', () => {
      existsSpy.mockImplementation((p: fs.PathLike) => p === PWSH7 || p === PS5);
      const session = manager.createSession({
        id: 'exec-fallback',
        cmd: 'nu', // unknown family — buildExecArgs returns null for it
        cwd: '.',
        exec: { command: 'claude /loop' },
      });
      expect(session.cmd).toBe(PWSH7);
      expect(lastMockPty?.spawnArgs).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `claude /loop${PWSH_EXIT_TAIL}`,
      ]);
    });

    it('resolves a bare "pwsh.exe" cmd through the Store alias when no traditional install exists', () => {
      existsSpy.mockImplementation((p: fs.PathLike) => p === ALIAS_TARGET || p === PS5);
      lstatSpy.mockImplementation((p: fs.PathLike) => {
        if (p === ALIAS) return { isSymbolicLink: () => true } as fs.Stats;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      readlinkSpy.mockImplementation((p: fs.PathLike) => {
        if (p === ALIAS) return ALIAS_TARGET;
        throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      });
      const session = manager.createSession({ id: 'bare-pwsh', cmd: 'pwsh.exe', cwd: '.' });
      expect(session.cmd).toBe(ALIAS_TARGET);
    });
  });

  // === X8 pane supervision: exec-style units + supervision meta + tombstone removal ===
  describe('X8 exec sessions and supervision', () => {
    it('spawns an exec unit with wrapper argv instead of OSC 133 injection', () => {
      // Bare 'pwsh.exe' deterministically resolves to itself when no
      // well-known install is present (resolveShellPath PATH fallback), so
      // this test is independent of the host machine's PowerShell layout.
      const session = manager.createSession({
        id: 'exec-1',
        cmd: 'pwsh.exe',
        cwd: '.',
        exec: { command: 'claude /loop' },
      });
      expect(lastMockPty?.spawnArgs).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `claude /loop${PWSH_EXIT_TAIL}`,
      ]);
      // No interactive-integration markers: -NoExit (pwsh injection) must
      // not leak into a unit that has no prompt to keep alive.
      expect(lastMockPty?.spawnArgs).not.toContain('-NoExit');
      // The unit command is persisted on meta so recovery/restart replays
      // the loop itself, not an empty shell.
      expect(session.exec).toEqual({ command: 'claude /loop' });
    });

    // X6: a non-persisted execLaunchCommand spawns the resume-rewritten command
    // (used by recovery/restart replays) while meta.exec.command stays original.
    it('spawns execLaunchCommand but persists the ORIGINAL exec.command (X6 resume replay)', () => {
      const session = manager.createSession({
        id: 'x6-replay',
        cmd: 'pwsh.exe',
        cwd: '.',
        exec: { command: 'claude' },
        execLaunchCommand: 'claude --continue',
      });
      // Spawned argv carries the resume form...
      expect(lastMockPty?.spawnArgs).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `claude --continue${PWSH_EXIT_TAIL}`,
      ]);
      // ...but the persisted unit command is the ORIGINAL (badge / future
      // first-launch semantics / no drift across repeated replays).
      expect(session.exec).toEqual({ command: 'claude' });
    });

    it('without execLaunchCommand, spawns the original exec.command (first launch unchanged)', () => {
      manager.createSession({
        id: 'x6-fresh',
        cmd: 'pwsh.exe',
        cwd: '.',
        exec: { command: 'claude' },
      });
      expect(lastMockPty?.spawnArgs).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `claude${PWSH_EXIT_TAIL}`,
      ]);
    });

    it('stores supervision meta as an owned copy (no caller aliasing)', () => {
      const limit = { burst: 5, healthyUptimeSec: 300 };
      const session = manager.createSession({
        id: 'sup-copy',
        cmd: 'pwsh.exe',
        cwd: '.',
        exec: { command: 'claude /loop' },
        supervision: { restart: 'on-failure', limit, status: 'armed' },
      });
      expect(session.supervision).toEqual({
        restart: 'on-failure',
        limit: { burst: 5, healthyUptimeSec: 300 },
        status: 'armed',
      });
      // meta is persisted via buildState — a later caller-side mutation
      // must not bleed into the persisted blob.
      limit.burst = 99;
      expect(manager.getSession('sup-copy')?.meta.supervision?.limit.burst).toBe(5);
    });

    it('recovery replay preserves a sticky stopped status', () => {
      const session = manager.createSession({
        id: 'sup-stopped',
        cmd: 'pwsh.exe',
        cwd: '.',
        exec: { command: 'claude /loop' },
        supervision: { restart: 'always', limit: { burst: 5, healthyUptimeSec: 300 }, status: 'stopped' },
      });
      // A runaway-guard 'stopped' must survive the persist→recover replay
      // verbatim — silently re-arming across a reboot is a trust violation.
      expect(session.supervision?.status).toBe('stopped');
    });

    it('persists supervision.restorePermissionMode through the owned copy (U-PERM)', () => {
      const session = manager.createSession({
        id: 'sup-restore',
        cmd: 'pwsh.exe',
        cwd: '.',
        exec: { command: 'claude' },
        supervision: { restart: 'on-failure', limit: { burst: 5, healthyUptimeSec: 300 }, status: 'armed', restorePermissionMode: true },
      });
      // The consent-gated bit must survive the field-by-field own-copy — a plain
      // {restart,limit,status} rebuild silently dropped it (tsc-invisible: the
      // field is optional on the target). Covers the persist half; the create RPC
      // handler + recovery replay halves are covered by scripts/u-perm-restore-probe.mjs.
      expect(session.supervision?.restorePermissionMode).toBe(true);
      expect(manager.getSession('sup-restore')?.meta.supervision?.restorePermissionMode).toBe(true);
    });

    it('omits restorePermissionMode when consent is off', () => {
      const session = manager.createSession({
        id: 'sup-norestore',
        cmd: 'pwsh.exe',
        cwd: '.',
        exec: { command: 'claude' },
        supervision: { restart: 'on-failure', limit: { burst: 5, healthyUptimeSec: 300 }, status: 'armed', restorePermissionMode: false },
      });
      expect(session.supervision?.restorePermissionMode).toBeUndefined();
    });

    describe('removeTombstone', () => {
      it('removes a dead tombstone silently so the same id can be re-created', () => {
        manager.createSession({ id: 'tomb', cmd: 'pwsh.exe', cwd: '.', exec: { command: 'claude /loop' } });
        lastMockPty?.simulateExit(1);
        expect(manager.getSession('tomb')?.meta.state).toBe('dead');

        const destroyHandler = vi.fn();
        manager.on('session:destroyed', destroyHandler);

        expect(manager.removeTombstone('tomb')).toBe(true);
        expect(manager.getSession('tomb')).toBeUndefined();
        // The whole point: a restart must look like died → (silence) →
        // created. 'session:destroyed' means "user closed the pane" to the
        // supervisor and "pane teardown" to main — neither may fire here.
        expect(destroyHandler).not.toHaveBeenCalled();

        // The supervised-restart invariant: same id is creatable again.
        expect(() =>
          manager.createSession({ id: 'tomb', cmd: 'pwsh.exe', cwd: '.', exec: { command: 'claude /loop' } }),
        ).not.toThrow();
      });

      it('throws on a live session and returns false for a missing id', () => {
        manager.createSession({ id: 'alive', cmd: 'pwsh.exe', cwd: '.' });
        expect(() => manager.removeTombstone('alive')).toThrow(/is 'detached', not 'dead'/);
        expect(manager.removeTombstone('ghost')).toBe(false);
      });

      it('reinsertSession restores the tombstone after a failed restart spawn', () => {
        manager.createSession({ id: 'undo', cmd: 'pwsh.exe', cwd: '.', exec: { command: 'claude /loop' } });
        lastMockPty?.simulateExit(1);
        const managed = manager.getSession('undo')!;
        manager.removeTombstone('undo');
        expect(manager.getSession('undo')).toBeUndefined();

        // createSession failed (cap / transient ConPTY) → put the dead
        // record back so sessions.json, the badge, and rearm keep a target.
        manager.reinsertSession(managed);
        expect(manager.getSession('undo')?.meta.state).toBe('dead');
        expect(manager.getSession('undo')?.meta.exec).toEqual({ command: 'claude /loop' });

        // Guards: only dead records, only into a free slot.
        expect(() => manager.reinsertSession(managed)).toThrow(/id already present/);
        manager.createSession({ id: 'live-guard', cmd: 'pwsh.exe', cwd: '.' });
        const live = manager.getSession('live-guard')!;
        expect(() => manager.reinsertSession(live)).toThrow(/not 'dead'/);
      });
    });
  });

  // Shutdown-kill classification (reboot-reattach RCA 2026-07-02): an exit the
  // injected classifier marks involuntary must SUSPEND the session (recovery
  // replays it under the same id) instead of marking it dead (recovery purges
  // it — which is how every in-use session vanished across an OS reboot).
  describe('involuntary exit classification (shutdown-kill)', () => {
    it('default classifier: exits keep the pre-fix died flow', () => {
      manager.createSession({ id: 'default-die', cmd: 'cmd.exe', cwd: '.' });
      const died = vi.fn();
      const interrupted = vi.fn();
      manager.on('session:died', died);
      manager.on('session:interrupted', interrupted);

      lastMockPty?.simulateExit(1073807364); // even the shutdown code — unwired = unchanged

      expect(died).toHaveBeenCalledTimes(1);
      expect(interrupted).not.toHaveBeenCalled();
      expect(manager.getSession('default-die')?.meta.state).toBe('dead');
    });

    it('classified exit → suspended + session:interrupted, NO session:died', () => {
      manager.setInvoluntaryExitClassifier((exitCode) => exitCode === 1073807364);
      manager.createSession({ id: 'shutdown-kill', cmd: 'cmd.exe', cwd: '.' });
      const died = vi.fn();
      const interrupted = vi.fn();
      const stateChanged = vi.fn();
      manager.on('session:died', died);
      manager.on('session:interrupted', interrupted);
      manager.on('session:stateChanged', stateChanged);

      lastMockPty?.simulateExit(1073807364);

      expect(died).not.toHaveBeenCalled();
      // Same forensics contract as session:died — daemon logging depends on it.
      expect(interrupted).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'shutdown-kill', exitCode: 1073807364 }),
      );
      expect(stateChanged).toHaveBeenCalledWith({ id: 'shutdown-kill', state: 'suspended' });
      const managed = manager.getSession('shutdown-kill');
      expect(managed?.meta.state).toBe('suspended');
      // exitCode still recorded for forensics even on the suspend path.
      expect(managed?.meta.exitCode).toBe(1073807364);
    });

    it('classifier false → normal death even when wired', () => {
      manager.setInvoluntaryExitClassifier((exitCode) => exitCode === 1073807364);
      manager.createSession({ id: 'user-exit', cmd: 'cmd.exe', cwd: '.' });
      const died = vi.fn();
      const interrupted = vi.fn();
      manager.on('session:died', died);
      manager.on('session:interrupted', interrupted);

      lastMockPty?.simulateExit(0); // user typed `exit`

      expect(died).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-exit', exitCode: 0 }));
      expect(interrupted).not.toHaveBeenCalled();
      expect(manager.getSession('user-exit')?.meta.state).toBe('dead');
    });

    it('interrupted-suspended session survives in listSessions but is not live', () => {
      manager.setInvoluntaryExitClassifier(() => true);
      manager.createSession({ id: 'susp-list', cmd: 'cmd.exe', cwd: '.' });
      lastMockPty?.simulateExit(1073807364);

      // Persisted via listSessions (buildState) — this is the recovery payload.
      expect(manager.listSessions().find((s) => s.id === 'susp-list')?.state).toBe('suspended');
      // Not a live PTY holder — Watchdog idle-shutdown must not be held by it.
      expect(manager.listLiveSessions().find((s) => s.id === 'susp-list')).toBeUndefined();
    });

    // Adversarial review (2026-07-02): attachSession/resizeSession only
    // guarded 'dead', so an RPC against a 'suspended' session (renderer
    // reconnect during the misclassification window) would flip it to
    // 'attached' or resize a destroyed ptyProcess — a real crash risk, since
    // the caller (daemon/index.ts) then wires a fresh SessionPipe straight
    // into a socket that no longer has a live process behind it.
    it('attachSession rejects a suspended session (no live ptyProcess to wire)', () => {
      manager.setInvoluntaryExitClassifier(() => true);
      manager.createSession({ id: 'susp-attach', cmd: 'cmd.exe', cwd: '.' });
      lastMockPty?.simulateExit(1073807364);
      expect(manager.getSession('susp-attach')?.meta.state).toBe('suspended');

      expect(() => manager.attachSession('susp-attach')).toThrow(/suspended/i);
      // Rejection must not have side-effected the state.
      expect(manager.getSession('susp-attach')?.meta.state).toBe('suspended');
    });

    it('resizeSession rejects a suspended session (no live ptyProcess to resize)', () => {
      manager.setInvoluntaryExitClassifier(() => true);
      manager.createSession({ id: 'susp-resize', cmd: 'cmd.exe', cwd: '.' });
      lastMockPty?.simulateExit(1073807364);

      expect(() => manager.resizeSession('susp-resize', 100, 40)).toThrow(/suspended/i);
    });
  });
});

// Root cause 2026-07-04 (deterministic repro): resizing an interactive zsh to
// cols <= 6 crashes it with SIGBUS inside zle.so resetvideo/zrefresh — 6/6 at
// cols 2-6, 0/6 at cols >= 7, rows irrelevant. Split/layout transitions
// transiently compute 2-5-col geometries, which is when panes died "randomly".
// The daemon floors every geometry at MIN_SAFE_COLS(10)/MIN_SAFE_ROWS(2) and
// skips same-size SIGWINCHes entirely.
describe('DaemonSessionManager — degenerate-geometry SIGBUS guard', () => {
  let mgr: DaemonSessionManager;

  beforeEach(() => {
    mgr = new DaemonSessionManager();
    lastMockPty = null;
  });

  afterEach(() => {
    mgr.disposeAll();
  });

  function spawn(id = 's1', cols = 80, rows = 24): MockPty {
    mgr.createSession({ id, cmd: 'zsh', cwd: '.', cols, rows });
    return lastMockPty!;
  }

  it('skips the SIGWINCH when the geometry is unchanged (no-op resize)', () => {
    const pty = spawn('s1', 80, 24);
    mgr.resizeSession('s1', 80, 24);
    expect(pty.resizeCalls).toBe(0);
  });

  it('floors a crash-narrow resize at the safe minimum (zsh dies at cols <= 6)', () => {
    const pty = spawn('s1', 80, 24);
    mgr.resizeSession('s1', 2, 24); // what a mid-split layout transient sends
    expect(pty.resizeCalls).toBe(1);
    expect(pty.cols).toBe(10); // floored, never 2
    expect(mgr.getSession('s1')?.meta.cols).toBe(10);
  });

  it('floors degenerate rows too', () => {
    const pty = spawn('s1', 80, 24);
    mgr.resizeSession('s1', 120, 1);
    expect(pty.rows).toBe(2);
    expect(pty.cols).toBe(120);
  });

  it('treats repeated degenerate resizes as no-ops after the first (same clamped geometry)', () => {
    const pty = spawn('s1', 80, 24);
    mgr.resizeSession('s1', 2, 24);
    mgr.resizeSession('s1', 4, 24); // clamps to the same 10x24
    mgr.resizeSession('s1', 6, 24);
    expect(pty.resizeCalls).toBe(1); // one SIGWINCH total
  });

  it('leaves a normal resize untouched', () => {
    const pty = spawn('s1', 80, 24);
    mgr.resizeSession('s1', 120, 30);
    expect(pty.cols).toBe(120);
    expect(pty.rows).toBe(30);
  });

  it('clamps the spawn geometry as well (spawning INTO a 2-col PTY crashes the same way)', () => {
    const pty = spawn('s1', 2, 1);
    expect(pty.cols).toBe(10);
    expect(pty.rows).toBe(2);
    expect(mgr.getSession('s1')?.meta.cols).toBe(10);
  });
});
