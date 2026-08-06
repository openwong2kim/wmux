import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ssh2 before importing the module under test. The SshChannelSession only
// uses `.connect`, `.shell`, `.exec`, `.end`, and the event-emitter surface —
// we stand up a minimal EventEmitter-backed Client so the test controls every
// transition the real network would normally drive.
const mockClient = vi.hoisted(() => {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instances: [] as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EventEmitter: null as any,
  };
});

vi.mock('ssh2', () => {
  // Lazy-require node:events inside the factory so the mock is self-contained.
  // eslint-disable-next-line @typescript-eslint/no-require-requires
  const { EventEmitter } = require('node:events');
  mockClient.EventEmitter = EventEmitter;
  class FakeClient extends EventEmitter {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lastConnect: any = null;
    shellOpts: unknown = null;
    execCmd: string | null = null;
    ended = false;
    connect(opts: unknown) {
      this.lastConnect = opts;
      // Tests emit 'ready'/'error' themselves to drive the state machine.
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shell(opts: unknown, cb: any) {
      this.shellOpts = opts;
      // Defer so the test can supply a stream; emit 'shell-request' synchronously
      // is awkward, so we stash the cb and the test fires `this.runShell(stream)`.
      this._shellCb = cb;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exec(cmd: string, opts: unknown, cb: any) {
      this.execCmd = cmd;
      this.shellOpts = opts;
      this._shellCb = cb;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runShell(stream: any, err?: Error) {
      this._shellCb(err, stream);
    }
    end() {
      this.ended = true;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _shellCb: any = null;
  }
  return { Client: FakeClient };
});

import { SshChannelSession } from '../SshChannelSession';

/** Build a fake ssh2 stream: a tiny EventEmitter with stdout/stderr + methods. */
function fakeStream() {
  const EE = mockClient.EventEmitter;
  const stream = new EE();
  const stderr = new EE();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).stderr = stderr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).written = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).resized = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).closed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).write = (data: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).written += data;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).setWindow = (rows: number, cols: number, h: number, w: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).resized = { rows, cols, h, w };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).close = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).closed = true;
  };
  return { stream, stderr };
}

function currentClient() {
  return mockClient.instances[mockClient.instances.length - 1];
}

// Re-patch the mock to record instances, since the factory's class is what `new`
// calls. We do this by intercepting the constructor via the same hoisted array.
beforeEach(() => {
  mockClient.instances.length = 0;
});

describe('SshChannelSession — SessionProcess surface', () => {
  it('exposes a synthetic negative pid distinct from OS pids', () => {
    const a = new SshChannelSession({ host: 'h', username: 'u', cols: 80, rows: 24 });
    const b = new SshChannelSession({ host: 'h', username: 'u', cols: 80, rows: 24 });
    expect(a.pid).toBeLessThan(0);
    expect(b.pid).toBeLessThan(0);
    expect(a.pid).not.toBe(b.pid);
    a.kill();
    b.kill();
  });

  it('forwards shell stdout bytes to onData after ready → shell', () => {
    const session = new SshChannelSession({ host: 'h', username: 'u', cols: 100, rows: 30 }) as unknown as {
      client: { emit: (ev: string) => void; runShell: (s: unknown) => void };
      onData: (cb: (d: string) => void) => { dispose: () => void };
      kill: () => void;
    };
    const seen: string[] = [];
    session.onData((d) => seen.push(d));
    const { stream } = fakeStream();
    session.client.emit('ready');
    session.client.runShell(stream);
    stream.emit('data', Buffer.from('remote-output', 'utf8'));
    expect(seen.join('')).toBe('remote-output');
    session.kill();
  });

  it('fires onExit immediately for a late subscriber after a sync fail (no zombie)', () => {
    // The sync fail path (e.g. an unreadable key file) calls fireExit BEFORE
    // the bridge attaches onExit. Without the immediate-replay fix the session
    // would sit "alive" forever (SSH skips processMonitor.watch). Drive a fail
    // by pointing at a private key path that does not exist, then attach onExit
    // AFTER construction and assert it still observes the exit.
    const session = new SshChannelSession({
      host: 'h',
      username: 'u',
      cols: 80,
      rows: 24,
      auth: { privateKeyPath: '/definitely/not/a/real/key/path__' },
    }) as unknown as { onExit: (cb: (e: { exitCode: number; signal?: string }) => void) => { dispose: () => void } };
    const exits: { exitCode: number; signal?: string }[] = [];
    // Attach AFTER construction — the readFileSync fail already ran sync.
    session.onExit((e) => exits.push(e));
    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(255);
  });

  it('routes stdout + stderr through onData and exit through onExit (end-to-end mock)', async () => {
    // This time, instrument the mock via a fresh module so we can grab the client.
    // The mock factory above does not record instances; do it inline by emitting
    // on the ready event the SshChannelSession itself listens to. We get the
    // client by reading the private field through a cast.
    const session = new SshChannelSession({ host: 'h', username: 'u', cols: 80, rows: 24 }) as unknown as {
      client: { emit: (ev: string) => void; runShell: (s: unknown, err?: Error) => void; end: () => void };
      onExit: (cb: (e: { exitCode: number; signal?: string }) => void) => { dispose: () => void };
      onData: (cb: (d: string) => void) => { dispose: () => void };
    };
    const data: string[] = [];
    session.onData((d) => data.push(d));
    const exits: { exitCode: number; signal?: string }[] = [];
    session.onExit((e) => exits.push(e));

    const { stream, stderr } = fakeStream();
    session.client.emit('ready');
    session.client.runShell(stream);
    // Stream stdout + stderr
    stream.emit('data', Buffer.from('hello ', 'utf8'));
    stderr.emit('data', Buffer.from('err\n', 'utf8'));
    expect(data.join('')).toBe('hello err\n');
    // Exit with code 2, then close
    stream.emit('exit', 2, null);
    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(2);
  });

  it('fires onExit (255) when the channel closes without an exit code (network drop)', async () => {
    const session = new SshChannelSession({ host: 'h', username: 'u', cols: 80, rows: 24 }) as unknown as {
      client: { emit: (ev: string) => void; runShell: (s: unknown) => void };
      onExit: (cb: (e: { exitCode: number; signal?: string }) => void) => { dispose: () => void };
    };
    const exits: { exitCode: number; signal?: string }[] = [];
    session.onExit((e) => exits.push(e));
    const { stream } = fakeStream();
    session.client.emit('ready');
    session.client.runShell(stream);
    stream.emit('close'); // no prior 'exit' — simulates a dropped connection
    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(255);
    expect(exits[0].signal).toBe('REMOTE_CLOSE');
  });

  it('fails closed (onExit 255) on a connect error before ready', () => {
    const session = new SshChannelSession({ host: 'h', username: 'u', cols: 80, rows: 24 }) as unknown as {
      client: { emit: (ev: string, arg?: unknown) => void };
      onExit: (cb: (e: { exitCode: number; signal?: string }) => void) => { dispose: () => void };
    };
    const exits: { exitCode: number; signal?: string }[] = [];
    session.onExit((e) => exits.push(e));
    session.client.emit('error', new Error('connection refused'));
    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(255);
    expect(exits[0].signal).toMatch(/connection refused/);
  });

  it('kills by ending the client and closes the stream exactly once', () => {
    const session = new SshChannelSession({ host: 'h', username: 'u', cols: 80, rows: 24 }) as unknown as {
      client: { emit: (ev: string) => void; runShell: (s: unknown) => void; end: () => void; ended: boolean };
      onExit: (cb: (e: { exitCode: number; signal?: string }) => void) => { dispose: () => void };
      kill: () => void;
    };
    const exits: { exitCode: number; signal?: string }[] = [];
    session.onExit((e) => exits.push(e));
    const { stream } = fakeStream();
    const streamRef = stream as unknown as { closed: boolean };
    session.client.emit('ready');
    session.client.runShell(stream);
    session.kill();
    expect(session.client.ended).toBe(true);
    expect(streamRef.closed).toBe(true);
    expect(exits).toHaveLength(1);
    // A second kill must not re-fire exit (idempotent)
    session.kill();
    expect(exits).toHaveLength(1);
  });

  it('applies resize as a window-change via setWindow once the stream is up', () => {
    const session = new SshChannelSession({ host: 'h', username: 'u', cols: 80, rows: 24 }) as unknown as {
      client: { emit: (ev: string) => void; runShell: (s: unknown) => void };
      resize: (c: number, r: number) => void;
    };
    const { stream } = fakeStream();
    const streamRef = stream as unknown as { resized: { rows: number; cols: number; h: number; w: number } | null };
    session.client.emit('ready');
    session.client.runShell(stream);
    session.resize(120, 40);
    expect(streamRef.resized).toEqual({ rows: 40, cols: 120, h: 0, w: 0 });
  });
});
