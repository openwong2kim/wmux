// ---------------------------------------------------------------------------
// The pipe's evidence watchdog (C2c). A client's auto-attach with
// waitForDebuggerOnStart keeps every new target paused until that client
// resumes it, and a new target waits for every client attached to it: one
// client that stopped (a suspended process, a hung loop) holds every other
// client's new tabs. The watch lets such a target go for the client that
// stopped, and only on evidence that it did.
//
// A client is watched while any session of its own reports waitingForDebugger
// and the client hasn't resumed it. Each period of stallMs starts with a ping.
// A frame from the client, a pong, or the client reading down a backlog that
// was waiting for it is a sign of life: the next period starts, with a fresh
// ping. A period that passes with none is looked at again after one
// setImmediate, so what is queued behind a busy main is read first; only if
// there is still none does the watch resume the client's waiting sessions
// itself, through the mux's own command path. The client is then stalled: its
// later targets go at once, until a frame or a pong from it clears that. A
// session stops being watched when the client's own resume for it goes to the
// browser, it detaches, the client leaves or the pipe ends. Nobody is ever
// detached.
//
// So a target goes for a client only after at least stallMs with no sign of
// life from it and a ping it left unanswered for that long. A client whose own
// loop is blocked past that can't be told from one that stopped; a wrong fire
// lets a new target run before that client's init scripts and auto-attach
// setup are in place on it.
// ---------------------------------------------------------------------------

/** How long a client may show no sign of life while a target waits for it. */
export const STALL_MS = 2_000;

/** The watch's view of a client. */
export interface WatchedClient {
  /** Ask the client for a sign of life (a WebSocket ping); absent for clients that can't answer one. */
  readonly ping?: () => void;
  /**
   * What is still queued for the client, and how much has left for it in all
   * (bytes); absent for clients without a socket.
   */
  readonly drain?: () => { buffered: number; flushed: number };
}

interface Signs { frames: number; pongs: number; buffered: number; flushed: number }

interface State {
  frames: number;
  pongs: number;
  stalled: boolean;
  /** Its sessions waiting on it. */
  waiting: Set<string>;
  /** The signs when the current period began. */
  base: Signs;
  timer: ReturnType<typeof setTimeout> | null;
  /** Bumped by every new period and by the end of the watch, so a stale judgment does nothing. */
  period: number;
}

export class CdpPipeStallWatch {
  private readonly clients = new Map<WatchedClient, State>();

  constructor(private readonly opts: {
    stallMs: number;
    /** Resume a waiting session for a client that stopped (the mux's own command). */
    resume: (session: string) => void;
    /** Count by reason; never ids. */
    count: (reason: string) => void;
  }) {}

  /** A session of `client` reports waitingForDebugger. */
  waiting(client: WatchedClient, session: string): void {
    const state = this.state(client);
    if (state.stalled) {
      this.opts.count('resumed-while-stalled');
      this.opts.resume(session);
      // A pong clears stalled for the next one.
      client.ping?.();
      return;
    }
    if (state.waiting.has(session)) return;
    state.waiting.add(session);
    this.opts.count('armed');
    if (state.waiting.size === 1) this.startPeriod(client, state);
  }

  /** Any frame from `client`, malformed ones included. */
  frame(client: WatchedClient): void {
    const state = this.clients.get(client);
    if (!state) return;
    state.frames++;
    state.stalled = false;
  }

  /** A pong from `client`. */
  pong(client: WatchedClient): void {
    const state = this.clients.get(client);
    if (!state) return;
    state.pongs++;
    state.stalled = false;
  }

  /** `client`'s own resume of `session` is going to the browser. */
  resumed(client: WatchedClient, session: string): void {
    if (this.stopWatching(client, session)) this.opts.count('ended-by-client');
  }

  /** `session` of `client` is gone. */
  detached(client: WatchedClient, session: string): void {
    if (this.stopWatching(client, session)) this.opts.count('ended-by-detach');
  }

  /** Every session of `client` is gone (it left, or will attach again). */
  forget(client: WatchedClient): void {
    const state = this.clients.get(client);
    if (!state) return;
    this.stopTimer(state);
    this.clients.delete(client);
  }

  /** The pipe ended. */
  close(): void {
    for (const client of [...this.clients.keys()]) this.forget(client);
  }

  /** @internal For tests: sessions waiting under the watch, and timers running (at most one per client). */
  pending(): { sessions: number; timers: number } {
    let sessions = 0;
    let timers = 0;
    for (const state of this.clients.values()) {
      sessions += state.waiting.size;
      if (state.timer) timers++;
    }
    return { sessions, timers };
  }

  private state(client: WatchedClient): State {
    let state = this.clients.get(client);
    if (!state) {
      state = { frames: 0, pongs: 0, stalled: false, waiting: new Set(), base: { frames: 0, pongs: 0, buffered: 0, flushed: 0 }, timer: null, period: 0 };
      this.clients.set(client, state);
    }
    return state;
  }

  private signs(client: WatchedClient, state: State): Signs {
    const drain = client.drain?.() ?? { buffered: 0, flushed: 0 };
    return { frames: state.frames, pongs: state.pongs, ...drain };
  }

  private stopWatching(client: WatchedClient, session: string): boolean {
    const state = this.clients.get(client);
    if (!state?.waiting.delete(session)) return false;
    if (!state.waiting.size) this.stopTimer(state);
    return true;
  }

  private stopTimer(state: State): void {
    state.period++;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  private startPeriod(client: WatchedClient, state: State): void {
    this.stopTimer(state);
    const period = state.period;
    state.base = this.signs(client, state);
    client.ping?.();
    state.timer = setTimeout(() => {
      state.timer = null;
      if (period !== state.period || this.restarted(client, state)) return;
      // Read what is already queued (a busy main's backlog) before judging.
      setImmediate(() => {
        if (period !== state.period || this.restarted(client, state)) return;
        const sessions = [...state.waiting];
        state.waiting.clear();
        this.stopTimer(state);
        state.stalled = true;
        for (const session of sessions) {
          this.opts.count('fired');
          this.opts.resume(session);
        }
        client.ping?.();
      });
    }, this.opts.stallMs);
    state.timer.unref?.();
  }

  /** A sign of life since the period began: start the next one. */
  private restarted(client: WatchedClient, state: State): boolean {
    const now = this.signs(client, state);
    const base = state.base;
    let reason: string | null = null;
    if (now.frames !== base.frames) reason = 'restarted-by-frame';
    else if (now.pongs !== base.pongs) reason = 'restarted-by-pong';
    // A backlog was waiting for it, and it read some of it.
    else if (base.buffered > 0 && now.flushed > base.flushed) reason = 'restarted-by-drain';
    if (!reason) return false;
    this.opts.count(reason);
    this.startPeriod(client, state);
    return true;
  }
}
