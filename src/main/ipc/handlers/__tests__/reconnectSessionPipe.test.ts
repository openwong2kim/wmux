/**
 * A pane main creates is adopted by a Terminal that mounts on it, and that
 * mount's reattach (useTerminal 'active-at-mount' → pty:reconnect) must not
 * take down the session pipe the create attached.
 *
 * The defect (remote start, also any created pane with a startup line): main
 * creates the session, attaches its pipe and schedules the launch line on it
 * (scheduleInitialCommand). The Terminal mounting on that session then called
 * pty:reconnect, which re-ran daemon.attachSession (the daemon stops the live
 * pipe, dropping input it had not read yet), opened a fresh socket with
 * forceFresh (destroying main's own, its unsent bytes with it) and replaced
 * the create-time data listener (the one that tells the launch line the shell
 * spoke). A line, or a keystroke, written around that swap was gone, while
 * writeToSession had reported it delivered.
 *
 * The fakes model only that: a socket whose bytes reach the daemon a few ms
 * after write() and are dropped if either end is torn down first, a daemon
 * whose attach replaces the pipe and whose live re-flush holds the pipe for a
 * while (RESYNC_BUSY meanwhile, its RESYNC_BEGIN read as live output unless
 * main's scanner was armed for it), and main's single per-session listener
 * slot. The create and the listeners below mirror pty.handler's daemon create
 * and reconnect paths, the first-output hook included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __pipeStepsInFlightForTests, reconnectSessionPipe, type ReconnectPipeClient } from '../reconnectSessionPipe';
import { createSessionResync, type SessionResync } from '../sessionResync';
import { scheduleInitialCommand } from '../scheduleInitialCommand';
import { deliberateSleep } from '../../../../test-utils/waitFor';

const ID = 'daemon-test-session';
/** How long a written byte takes to reach the daemon over the session pipe. */
const TRANSPORT_MS = 5;
/** How long a daemon re-flush holds the pipe before its RESYNC_BEGIN reaches main. */
const REFLUSH_BEGIN_MS = 3;

type DataEvent = { sessionId: string; data: Buffer; replay: boolean };

interface ServerPipe { alive: boolean; flushed: boolean; reflushing: boolean }

class FakeSocket {
  alive = true;
  constructor(private readonly world: World, readonly server: ServerPipe) {}
  write(data: string): void {
    setTimeout(() => {
      // Bytes still queued when either end went away never reach the PTY.
      if (this.alive && this.server.alive) this.world.ptyInput += data;
    }, TRANSPORT_MS);
  }
}

type WorldClient = ReconnectPipeClient & {
  writeToSession(id: string, data: string): boolean;
  armSessionResync(id: string): boolean;
  disarmSessionResync(id: string): void;
};

class World {
  /** What the daemon wrote into the PTY. */
  ptyInput = '';
  /** The shell's screen so far (the daemon's ring). */
  ring = 'PS> ';
  server: ServerPipe | null = null;
  /** main's DaemonClient.sessionPipes entry for ID. */
  socket: FakeSocket | null = null;
  scanner: 'accumulating' | 'live' = 'live';
  armed = false;
  armRefused = false;
  /** Re-flush markers that reached the terminal as live output. */
  leakedMarkers = 0;
  /** main's per-session data listener slot (sessionDataDispatcher). */
  listener: ((p: DataEvent) => void) | null = null;
  /** pty.handler's firstOutputHooks entry for ID. */
  firstOutputHook: (() => void) | null = null;
  attaches = 0;
  resyncCalls = 0;
  disarms = 0;
  readonly client: WorldClient;
  readonly resync: SessionResync;

  constructor() {
    this.client = this.makeClient();
    this.resync = createSessionResync(this.client);
  }

  noteFirstOutput(): void {
    const hook = this.firstOutputHook;
    this.firstOutputHook = null;
    hook?.();
  }

  /** Replays main forwarded (attach flush or re-flush), in order. */
  replays: string[] = [];

  private emit(data: string, replay: boolean): void {
    if (replay) this.replays.push(data);
    this.listener?.({ sessionId: ID, data: Buffer.from(data), replay });
  }

  /** The shell prints: live bytes into the ring and down the pipe. */
  shellSays(text: string): void {
    this.ring += text;
    if (this.socket?.alive && this.scanner === 'live') this.emit(text, false);
  }

  /** The daemon's attach flush reaching main's socket (an empty ring replays nothing). */
  private flushTo(socket: FakeSocket): void {
    this.scanner = 'accumulating';
    setTimeout(() => {
      if (this.socket !== socket || !socket.alive) return;
      if (this.ring) this.emit(this.ring, true);
      this.scanner = 'live';
      socket.server.flushed = true;
    }, 1);
  }

  private async reflush(): Promise<{ mode: 'raw' }> {
    this.resyncCalls++;
    const socket = this.socket;
    if (!socket || !socket.server.alive) throw new Error(`NO_PIPE: session ${ID} has no flushed client pipe`);
    const server = socket.server;
    if (server.reflushing) throw new Error('RESYNC_BUSY: a re-flush is already in progress');
    if (!server.flushed) throw new Error(`NO_PIPE: session ${ID} has no flushed client pipe`);
    server.reflushing = true;
    server.flushed = false;
    await deliberateSleep(REFLUSH_BEGIN_MS, 'the fake daemon holding the pipe for its re-flush (fake timers drive it)');
    // RESYNC_BEGIN reaches main's scanner: armed, it starts a replay;
    // unarmed, the marker and the replay are shown as live output.
    if (this.armed) {
      this.armed = false;
      this.scanner = 'accumulating';
    } else {
      this.leakedMarkers++;
    }
    await deliberateSleep(1, 'the fake replay on its way to main (fake timers drive it)');
    // RIS, then the screen, then FLUSH_DONE (SessionPipe.reflushInSlot); main's
    // flush-complete forwarder tells the shared re-flush.
    this.emit('\x1bc' + this.ring, true);
    this.scanner = 'live';
    server.flushed = true;
    server.reflushing = false;
    this.resync.flushCompleted(ID);
    // The RPC reply comes over the control socket, read after FLUSH_DONE.
    await deliberateSleep(2, 'the fake daemon reply trailing its FLUSH_DONE (fake timers drive it)');
    return { mode: 'raw' };
  }

  private makeClient(): WorldClient {
    return {
      rpc: async (method: string, params: Record<string, unknown> = {}) => {
        expect(params.id).toBe(ID);
        if (method === 'daemon.attachSession') {
          this.attaches++;
          // daemon.attachSession stops the session's existing pipe.
          if (this.server) {
            const old = this.server;
            old.alive = false;
            // main sees the close a tick later (until then writeToSession says true).
            setTimeout(() => {
              if (this.socket?.server === old) {
                this.socket.alive = false;
                this.socket = null;
              }
            }, 1);
          }
          this.server = { alive: true, flushed: false, reflushing: false };
          return { ok: true };
        }
        if (method === 'daemon.resyncSession') return this.reflush();
        throw new Error(`unexpected rpc ${method}`);
      },
      connectSessionPipe: async (_id: string, opts?: { forceFresh?: boolean }) => {
        const existing = this.socket;
        if (existing && existing.alive && !opts?.forceFresh) return;
        if (existing) existing.alive = false;
        if (!this.server) throw new Error('no session pipe');
        const socket = new FakeSocket(this, this.server);
        this.socket = socket;
        this.flushTo(socket);
      },
      isSessionPipeWritable: () => !!this.socket && this.socket.alive,
      writeToSession: (_id: string, data: string) => {
        if (!this.socket || !this.socket.alive) return false;
        this.socket.write(data);
        return true;
      },
      armSessionResync: () => {
        if (this.scanner !== 'live' || this.armRefused) return false;
        this.armed = true;
        return true;
      },
      disarmSessionResync: () => {
        this.disarms++;
        this.armed = false;
      },
      sessionPipeFlushPending: () => !!this.socket && this.scanner === 'accumulating',
    };
  }
}

/** pty.handler's daemon create: attach, connect, schedule the line, listen. */
async function create(world: World, line: string): Promise<void> {
  await world.client.rpc('daemon.attachSession', { id: ID });
  await world.client.connectSessionPipe(ID);
  const initialCmd = scheduleInitialCommand(line, {
    write: (cmd) => world.client.writeToSession(ID, cmd + '\r'),
    settleMs: 10,
  });
  world.firstOutputHook = initialCmd.onFirstData;
  world.listener = () => world.noteFirstOutput();
}

/** The Terminal that mounts on the created session: pty:reconnect's pipe step. */
async function mountReattach(world: World, ownsCreatePipe = true): Promise<{ painted: string[]; kind: string }> {
  const painted: string[] = [];
  const outcome = await reconnectSessionPipe(world.client, ID, {
    promote: true,
    ownsCreatePipe,
    resync: world.resync,
    installListener: () => {
      world.listener = (p) => {
        if (!p.replay) world.noteFirstOutput();
        painted.push(p.data.toString());
      };
    },
  });
  return { painted, kind: outcome.kind };
}

describe('a Terminal adopting a pane main created keeps the create-time session pipe', () => {
  let world: World;
  beforeEach(() => {
    vi.useFakeTimers();
    world = new World();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the launch line written as the Terminal mounts reaches the shell', async () => {
    await create(world, 'claude');
    await vi.advanceTimersByTimeAsync(1); // the attach flush: the shell's first output
    await vi.advanceTimersByTimeAsync(10); // settle → the line is written into the pipe
    expect(world.ptyInput).toBe(''); // still in flight
    const mount = mountReattach(world); // the Terminal mounts on the session
    await vi.advanceTimersByTimeAsync(50);
    await mount;
    expect(world.ptyInput).toBe('claude\r');
  });

  it('a keystroke typed as the Terminal mounts reaches the shell', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    expect(world.client.writeToSession(ID, 'x')).toBe(true);
    const mount = mountReattach(world);
    await vi.advanceTimersByTimeAsync(50);
    await mount;
    expect(world.ptyInput).toBe('x');
  });

  it('the startup line still hears the shell first speak when the Terminal mounts first', async () => {
    // The mount lands before the attach flush, so the reconnect's listener is
    // the one that sees the shell's first output; without the hook the line
    // would wait for the 3 s no-output fallback.
    await create(world, 'claude');
    const mount = mountReattach(world);
    await vi.advanceTimersByTimeAsync(3);
    world.shellSays('\r\nPS> ');
    await vi.advanceTimersByTimeAsync(100);
    await mount;
    expect(world.ptyInput).toBe('claude\r');
  });

  it('a re-flush replay is not the shell speaking: the line waits for real output', async () => {
    world.ring = ''; // a shell that has printed nothing yet
    await create(world, 'claude');
    await vi.advanceTimersByTimeAsync(5); // the attach flush: nothing to replay
    const mount = mountReattach(world);
    await vi.advanceTimersByTimeAsync(100);
    expect((await mount).kind).toBe('kept');
    expect(world.replays).toEqual(['\x1bc']); // the re-flush's reset
    expect(world.ptyInput).toBe('');
    world.shellSays('PS> ');
    await vi.advanceTimersByTimeAsync(50);
    expect(world.ptyInput).toBe('claude\r');
  });

  it('the mounting Terminal gets the screen, replayed over the same pipe', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const socketBefore = world.socket;
    const mount = mountReattach(world);
    await vi.advanceTimersByTimeAsync(10);
    const re = await mount;
    expect(re.kind).toBe('kept');
    expect(world.attaches).toBe(1);
    expect(world.socket).toBe(socketBefore);
    expect(world.resyncCalls).toBe(1);
    expect(re.painted).toEqual(['\x1bcPS> ']);
    expect(world.leakedMarkers).toBe(0);
  });
});

describe('the mount re-flush and a reveal re-flush of the same pane are one', () => {
  let world: World;
  beforeEach(() => {
    vi.useFakeTimers();
    world = new World();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a reveal asking while the mount re-flush runs joins it', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const mount = mountReattach(world);
    await vi.advanceTimersByTimeAsync(1);
    const reveal = world.resync(ID, 1000); // pty:resync
    await vi.advanceTimersByTimeAsync(20);
    expect((await mount).kind).toBe('kept');
    expect(await reveal).toEqual({ success: true, mode: 'raw' });
    expect(world.resyncCalls).toBe(1);
    expect(world.disarms).toBe(0);
    expect(world.leakedMarkers).toBe(0);
  });

  it('a reveal asking after the mount re-flush painted gets one of its own', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const mount = mountReattach(world);
    await vi.advanceTimersByTimeAsync(REFLUSH_BEGIN_MS + 1.5); // FLUSH_DONE in, daemon reply not yet
    expect(world.replays).toHaveLength(2); // attach flush, mount re-flush
    const reveal = world.resync(ID, 1000);
    await vi.advanceTimersByTimeAsync(30);
    expect((await mount).kind).toBe('kept');
    expect(await reveal).toEqual({ success: true, mode: 'raw' });
    expect(world.resyncCalls).toBe(2);
    expect(world.replays).toHaveLength(3); // the reveal's own flushComplete came
    expect(world.leakedMarkers).toBe(0);
  });

  it('a Terminal mounting while a reveal re-flush runs joins it, keeping the pipe', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const reveal = world.resync(ID, 1000);
    await vi.advanceTimersByTimeAsync(REFLUSH_BEGIN_MS + 0.5); // its BEGIN is in: replay accumulating
    const mount = mountReattach(world);
    await vi.advanceTimersByTimeAsync(20);
    expect((await mount).kind).toBe('kept');
    expect((await reveal).success).toBe(true);
    expect(world.resyncCalls).toBe(1);
    expect(world.attaches).toBe(1);
    expect(world.leakedMarkers).toBe(0);
  });
});

describe('a reconnect with no live create-time pipe to keep attaches afresh', () => {
  let world: World;
  beforeEach(() => {
    vi.useFakeTimers();
    world = new World();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a pipe main did not attach at create in this run', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const re = await mountReattach(world, false);
    expect(re.kind).toBe('attached');
    expect(world.attaches).toBe(2);
    expect(world.resyncCalls).toBe(0);
  });

  it('a create-time pipe that has closed', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const socket = world.socket;
    if (!socket) throw new Error('create left no socket');
    socket.alive = false;
    const re = await mountReattach(world);
    expect(re.kind).toBe('attached');
    expect(world.attaches).toBe(2);
  });

  it('a daemon that has no flushed client for it any more', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const server = world.server;
    if (!server) throw new Error('create left no daemon pipe');
    server.alive = false; // daemon-side stop, close not seen by main yet
    const re = await mountReattach(world);
    expect(re.kind).toBe('attached');
    expect(world.disarms).toBe(1);
    expect(world.armed).toBe(false);
    expect(world.attaches).toBe(2);
  });

  it('a scanner that cannot watch for a re-flush (overflowing replay)', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    world.armRefused = true;
    const re = await mountReattach(world);
    expect(re.kind).toBe('attached');
    expect(world.attaches).toBe(2);
  });
});

describe('two reconnects of one session run one after the other', () => {
  let world: World;
  beforeEach(() => {
    vi.useFakeTimers();
    world = new World();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the second attaches only after the first has connected and checked its pipe', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    // A split remounts the pane while the first mount's reconnect is in
    // flight: both mounts ask for a full attach of the same session.
    const steps: string[] = [];
    const { rpc, connectSessionPipe, isSessionPipeWritable } = world.client;
    let caller = '';
    world.client.rpc = (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'daemon.attachSession') steps.push(`${caller}:attach`);
      return rpc(method, params);
    }) as typeof world.client.rpc;
    world.client.connectSessionPipe = (async (id: string, opts?: { forceFresh?: boolean }) => {
      steps.push(`${caller}:connect`);
      return connectSessionPipe(id, opts);
    }) as typeof world.client.connectSessionPipe;
    world.client.isSessionPipeWritable = (id: string) => {
      steps.push(`${caller}:check`);
      return isSessionPipeWritable(id);
    };
    const reattach = (name: string) => reconnectSessionPipe(world.client, ID, {
      promote: true,
      ownsCreatePipe: false,
      resync: world.resync,
      installListener: () => { caller = name; },
    });
    const [first, second] = await Promise.all([reattach('first'), reattach('second')]);
    expect(steps).toEqual([
      'first:attach', 'first:connect', 'first:check',
      'second:attach', 'second:connect', 'second:check',
    ]);
    expect([first.kind, second.kind]).toEqual(['attached', 'attached']);
    expect(__pipeStepsInFlightForTests()).toBe(0);
  });

  it('a step that throws does not stall the next one, and nothing is left queued', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const { connectSessionPipe } = world.client;
    let connects = 0;
    world.client.connectSessionPipe = (async (id: string, opts?: { forceFresh?: boolean }) => {
      // The first one finds no session socket (connect ENOENT).
      if (connects++ === 0) throw new Error(`connect ENOENT session-${id}.sock`);
      return connectSessionPipe(id, opts);
    }) as typeof world.client.connectSessionPipe;
    const reattach = () => reconnectSessionPipe(world.client, ID, {
      promote: true,
      ownsCreatePipe: false,
      resync: world.resync,
      installListener: () => undefined,
    });
    const first = reattach();
    const second = reattach();
    expect(__pipeStepsInFlightForTests()).toBe(1);
    await expect(first).rejects.toThrow(/ENOENT/);
    await expect(second).resolves.toEqual({ kind: 'attached' });
    await vi.advanceTimersByTimeAsync(0);
    expect(__pipeStepsInFlightForTests()).toBe(0);
  });

  it('a third reconnect asked while the second runs waits for it as well', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const steps: string[] = [];
    const { rpc, connectSessionPipe, isSessionPipeWritable } = world.client;
    // The second attach takes a while: the first has settled, the second is
    // under way when a further split asks for a third.
    let attaches = 0;
    let releaseSecond: () => void = () => undefined;
    const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve; });
    world.client.rpc = (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'daemon.attachSession') {
        steps.push('attach');
        if (++attaches === 2) await secondHeld;
      }
      return rpc(method, params);
    }) as typeof world.client.rpc;
    world.client.connectSessionPipe = (async (id: string, opts?: { forceFresh?: boolean }) => {
      steps.push('connect');
      return connectSessionPipe(id, opts);
    }) as typeof world.client.connectSessionPipe;
    world.client.isSessionPipeWritable = (id: string) => {
      steps.push('check');
      return isSessionPipeWritable(id);
    };
    const reattach = () => reconnectSessionPipe(world.client, ID, {
      promote: true,
      ownsCreatePipe: false,
      resync: world.resync,
      installListener: () => undefined,
    });
    const first = reattach();
    const second = reattach();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(steps).toEqual(['attach', 'connect', 'check', 'attach']);
    const third = reattach();
    await vi.advanceTimersByTimeAsync(0);
    releaseSecond();
    await Promise.all([second, third]);
    expect(steps).toEqual(['attach', 'connect', 'check', 'attach', 'connect', 'check', 'attach', 'connect', 'check']);
    await vi.advanceTimersByTimeAsync(0);
    expect(__pipeStepsInFlightForTests()).toBe(0);
  });
});

describe('reconnects of different sessions do not wait for each other', () => {
  it('a session whose attach is slow does not hold up another one', async () => {
    // A daemon:connected reattaches every pane at once: one chain per
    // session, never one for all of them.
    let releaseA: () => void = () => undefined;
    const aHeld = new Promise<void>((resolve) => { releaseA = resolve; });
    const attached: string[] = [];
    const writable = new Set<string>();
    const client: ReconnectPipeClient = {
      rpc: (async (method: string, params: Record<string, unknown> = {}) => {
        const id = String(params.id);
        if (method === 'daemon.attachSession' && id === 'session-a') await aHeld;
        return { ok: true };
      }) as ReconnectPipeClient['rpc'],
      connectSessionPipe: async (id: string) => {
        writable.add(id);
        attached.push(id);
      },
      isSessionPipeWritable: (id: string) => writable.has(id),
      sessionPipeFlushPending: () => false,
    };
    const resync = { inFlight: () => false } as unknown as SessionResync;
    const reattach = (id: string) => reconnectSessionPipe(client, id, {
      promote: true,
      ownsCreatePipe: false,
      resync,
      installListener: () => undefined,
    });
    const a = reattach('session-a');
    const b = await reattach('session-b');
    expect(b).toEqual({ kind: 'attached' });
    expect(attached).toEqual(['session-b']);
    releaseA();
    await expect(a).resolves.toEqual({ kind: 'attached' });
    expect(attached).toEqual(['session-b', 'session-a']);
  });
});

describe('what main holds of a replaced pipe is dropped, never of a kept one', () => {
  let world: World;
  beforeEach(() => {
    vi.useFakeTimers();
    world = new World();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const reattach = (ownsCreatePipe: boolean, replacingPipe: () => void) => reconnectSessionPipe(world.client, ID, {
    promote: true,
    ownsCreatePipe,
    resync: world.resync,
    installListener: () => undefined,
    replacingPipe,
  });

  it('a full attach says the pipe was replaced once the new one is connected, before it delivers', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const oldSocket = world.socket;
    const replaysBefore = world.replays.length;
    const replacing = vi.fn(() => {
      expect(world.attaches).toBe(2);
      expect(world.socket).not.toBe(oldSocket);
      expect(oldSocket?.alive).toBe(false);
      expect(world.replays.length).toBe(replaysBefore);
    });
    const re = await reattach(false, replacing);
    expect(re.kind).toBe('attached');
    expect(replacing).toHaveBeenCalledTimes(1);
  });

  it('a create-time pipe that has closed is replaced like any other', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const socket = world.socket;
    if (!socket) throw new Error('create left no socket');
    socket.alive = false;
    const replacing = vi.fn(() => { expect(world.attaches).toBe(2); });
    const re = await reattach(true, replacing);
    expect(re.kind).toBe('attached');
    expect(replacing).toHaveBeenCalledTimes(1);
  });

  it('a queued reconnect drops what main holds only when its own step replaces the pipe', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const steps: string[] = [];
    const { connectSessionPipe } = world.client;
    let caller = '';
    world.client.connectSessionPipe = (async (id: string, opts?: { forceFresh?: boolean }) => {
      steps.push(`${caller}:connect`);
      return connectSessionPipe(id, opts);
    }) as typeof world.client.connectSessionPipe;
    const queued = (name: string) => reconnectSessionPipe(world.client, ID, {
      promote: true,
      ownsCreatePipe: false,
      resync: world.resync,
      installListener: () => { caller = name; },
      // The first step's pipe delivers while the second waits: what main
      // holds of it then belongs to the pipe the second has not replaced yet.
      replacingPipe: () => steps.push(`${name}:replacing`),
    });
    const both = Promise.all([queued('first'), queued('second')]);
    await vi.advanceTimersByTimeAsync(0);
    await both;
    expect(steps).toEqual(['first:connect', 'first:replacing', 'second:connect', 'second:replacing']);
  });

  it('a pending recovery replaces nothing', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const { rpc } = world.client;
    world.client.rpc = (async (method: string, params?: Record<string, unknown>) => {
      const reply = await rpc(method, params);
      return method === 'daemon.attachSession' ? { pending: true } : reply;
    }) as typeof world.client.rpc;
    const replacing = vi.fn();
    expect((await reattach(false, replacing)).kind).toBe('pending');
    expect(replacing).not.toHaveBeenCalled();
  });

  it('a kept create-time pipe is not replaced', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const replacing = vi.fn();
    const re = reattach(true, replacing);
    await vi.advanceTimersByTimeAsync(20);
    expect((await re).kind).toBe('kept');
    expect(replacing).not.toHaveBeenCalled();
  });
});
