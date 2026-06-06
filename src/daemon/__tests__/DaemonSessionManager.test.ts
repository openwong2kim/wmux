import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// --- Mock node-pty -----------------------------------------------------------

class MockPty extends EventEmitter {
  pid = 12345;
  private _cols: number;
  private _rows: number;
  /** Captured spawn env, so tests can assert the resolved child environment. */
  readonly spawnEnv: Record<string, string> | undefined;
  private dataCallbacks: ((data: string) => void)[] = [];
  private exitCallbacks: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  killed = false;

  constructor(_cmd: string, _args: string[], opts: { cols: number; rows: number; env?: Record<string, string> }) {
    super();
    this._cols = opts.cols;
    this._rows = opts.rows;
    this.spawnEnv = opts.env;
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

  resize(cols: number, rows: number): void {
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
});
