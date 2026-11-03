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
import { reconnectSessionPipe, type ReconnectPipeClient } from '../reconnectSessionPipe';
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
