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
 * whose attach replaces the pipe, and main's single per-session listener slot.
 * The create below mirrors pty.handler's daemon create path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconnectSessionPipe, type ReconnectPipeClient } from '../reconnectSessionPipe';
import { scheduleInitialCommand } from '../scheduleInitialCommand';

const ID = 'daemon-test-session';
/** How long a written byte takes to reach the daemon over the session pipe. */
const TRANSPORT_MS = 5;

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
  /** main's per-session data listener slot (sessionDataDispatcher). */
  listener: ((p: DataEvent) => void) | null = null;
  attaches = 0;
  resyncs = 0;
  disarms = 0;
  resyncError: string | null = null;

  private emit(data: string, replay: boolean): void {
    this.listener?.({ sessionId: ID, data: Buffer.from(data), replay });
  }

  /** The daemon's flush (attach-time, or a re-flush) reaching main's socket. */
  private flushTo(socket: FakeSocket): void {
    this.scanner = 'accumulating';
    setTimeout(() => {
      if (this.socket !== socket || !socket.alive) return;
      this.emit(this.ring, true);
      this.scanner = 'live';
      socket.server.flushed = true;
      socket.server.reflushing = false;
    }, 1);
  }

  readonly client: ReconnectPipeClient & {
    writeToSession(id: string, data: string): boolean;
    armSessionResync(id: string): boolean;
    disarmSessionResync(id: string): void;
    sessionPipeFlushPending(id: string): boolean;
  } = {
    rpc: async (method: string, params: Record<string, unknown> = {}) => {
      expect(params.id).toBe(ID);
      if (method === 'daemon.attachSession') {
        this.attaches++;
        // daemon.attachSession stops the session's existing pipe.
        if (this.server) {
          const old = this.server;
          old.alive = false;
          // main sees the close a tick later (until then writeToSession says true).
          setTimeout(() => { if (this.socket?.server === old) { this.socket.alive = false; this.socket = null; } }, 1);
        }
        this.server = { alive: true, flushed: false, reflushing: false };
        return { ok: true };
      }
      if (method === 'daemon.resyncSession') {
        this.resyncs++;
        if (this.resyncError) throw new Error(this.resyncError);
        const socket = this.socket;
        if (!socket || !socket.server.alive || !socket.server.flushed) throw new Error('RESYNC_UNAVAILABLE: no flushed client on session pipe');
        socket.server.reflushing = true;
        this.armed = false;
        this.flushTo(socket);
        return { mode: 'raw' };
      }
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
    disarmSessionResync: () => { this.disarms++; this.armed = false; },
    sessionPipeFlushPending: () => !!this.socket && this.scanner === 'accumulating',
  };
}

/** pty.handler's daemon create: attach, connect, schedule the line, listen. */
async function create(world: World, line: string): Promise<{ painted: string[] }> {
  const painted: string[] = [];
  await world.client.rpc('daemon.attachSession', { id: ID });
  await world.client.connectSessionPipe(ID);
  const initialCmd = scheduleInitialCommand(line, {
    write: (cmd) => world.client.writeToSession(ID, cmd + '\r'),
    settleMs: 10,
  });
  world.listener = (p) => {
    initialCmd.onFirstData();
    painted.push(p.data.toString());
  };
  return { painted };
}

/** The Terminal that mounts on the created session: pty:reconnect's pipe step. */
async function mountReattach(world: World, ownsCreatePipe = true): Promise<{ painted: string[]; kind: string }> {
  const painted: string[] = [];
  const outcome = await reconnectSessionPipe(world.client, ID, {
    promote: true,
    ownsCreatePipe,
    installListener: () => { world.listener = (p) => painted.push(p.data.toString()); },
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
    await mountReattach(world); // the Terminal mounts on the session
    await vi.advanceTimersByTimeAsync(50);
    expect(world.ptyInput).toBe('claude\r');
  });

  it('a keystroke typed as the Terminal mounts reaches the shell', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    expect(world.client.writeToSession(ID, 'x')).toBe(true);
    await mountReattach(world);
    await vi.advanceTimersByTimeAsync(50);
    expect(world.ptyInput).toBe('x');
  });

  it('the shell output still tells the launch line it spoke when the Terminal mounts first', async () => {
    // The mount lands before the attach flush: the create-time listener is the
    // one that must hear the shell's first output, or the line waits for the
    // 3 s no-output fallback.
    await create(world, 'claude');
    await mountReattach(world);
    await vi.advanceTimersByTimeAsync(100);
    expect(world.ptyInput).toBe('claude\r');
  });

  it('the mounting Terminal still gets the screen, replayed over the same pipe', async () => {
    const created = await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    const socketBefore = world.socket;
    await mountReattach(world);
    await vi.advanceTimersByTimeAsync(5);
    expect(world.attaches).toBe(1);
    expect(world.socket).toBe(socketBefore);
    expect(world.resyncs).toBe(1);
    // main's one listener forwards to the renderer; the re-flush rode it.
    expect(created.painted).toEqual(['PS> ', 'PS> ']);
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
    expect(world.resyncs).toBe(0);
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

  it('keeps the pipe when a re-flush is already on its way (busy), and leaves its watch armed', async () => {
    await create(world, '');
    await vi.advanceTimersByTimeAsync(5);
    world.resyncError = 'RESYNC_BUSY: a re-flush is already in progress';
    const re = await mountReattach(world);
    expect(re.kind).toBe('kept');
    expect(world.disarms).toBe(0);
    expect(world.attaches).toBe(1);
  });
});
