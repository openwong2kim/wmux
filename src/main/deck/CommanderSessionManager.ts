// ─── Command Deck — Commander session manager (Phase 2, P2c) ─────────────────
//
// Owns the single Commander brain session (Phase 2 is single-commander) and its
// lifecycle: it starts the adapter lazily on the first send, forwards the
// normalized event stream to a sink (the IPC push to the renderer), enforces
// ONE turn at a time, and tears the adapter down on app quit.
//
// Not an Electron/IPC module on purpose — it takes a BrainAdapter and an event
// sink as constructor deps, so it unit-tests against a fake adapter with no
// SDK, no ipcMain, and no BrowserWindow. The IPC handler (deck.handler.ts) is
// the thin Electron shell that wires a real ClaudeSdkAdapter + a webContents
// sink into this manager.
//
// Concurrency: a send while a turn is in flight is REJECTED (not queued) — the
// simplest correct policy. The renderer disables the composer on `busy`, so the
// reject is a backstop for a racing double-submit, surfaced as an `error`
// event rather than silently dropped.

import type {
  BrainAdapter,
  BrainEvent,
  BrainSendOptions,
  BrainStartOptions,
} from './BrainAdapter';

export type CommanderStatus = 'idle' | 'busy' | 'disposed';

/** Sink for normalized events (the IPC push). Called in stream order; the
 *  manager never awaits it. */
export type BrainEventSink = (event: BrainEvent) => void;

export interface CommanderSendResult {
  /** Whether the turn was accepted and started streaming. */
  ok: boolean;
  /** Present on rejection: `busy` (a turn is running), `disposed`, `empty`,
   *  `invalid_workspace` (handler-level, M1.5 — the send carried no valid
   *  workspaceId to route to an orchestrator), or `mode_off` (handler-level —
   *  the workspace's agent mode is `off`, so the brain must not run at all),
   *  or `task_workspace` (handler-level — a fan-out task workspace never runs
   *  a brain of its own; the owner's brain drives it), or `not_hq` /
   *  `hq_missing` / `hq_unknown` (handler-level — an HQ is designated and this
   *  is not it, or the HQ's workspace is gone / not yet observed;
   *  deckHqStore.ts), or `moa_off` (handler-level
   *  — the main bot's master switch is off).
   *  Additionally `errored` rides an ok:true result when the turn RAN but the
   *  adapter threw mid-stream — callers that must distinguish "completed" from
   *  "died mid-turn" (the re-examine consume) check it; everyone else keys off
   *  `ok` alone. */
  code?: 'busy' | 'disposed' | 'empty' | 'invalid_workspace' | 'moa_off' | 'mode_off' | 'task_workspace' | 'not_hq' | 'hq_missing' | 'hq_unknown' | 'errored';
  /** A deterministic read-only answer handled without starting the adapter.
   *  The renderer may retain this alongside a provider-owned transcript. */
  localAnswer?: { text: string };
}

/** Optional read-only fast path inside the manager's one-turn reservation.
 *  A miss or failure falls through to the original adapter turn. Callers must
 *  observe the signal before doing anything after an asynchronous lookup. */
export type CommanderLocalFirst = (signal: AbortSignal) => Promise<
  { text: string } | { fallbackText: string | (() => string) } | null
>;

export interface CommanderStatusSnapshot {
  status: CommanderStatus;
  sessionId: string | null;
  /** Present only while a designated HQ cannot run: its workspace is gone or
   *  not yet observed, or deck-hq.json is unreadable (deckHqStore.ts). */
  hq?: 'hq-missing' | 'hq-unknown' | 'hq-store-corrupt';
}

export interface CommanderSessionManagerDeps {
  /** The brain. Injected so tests pass a fake. */
  adapter: BrainAdapter;
  /** Where normalized events go (IPC push in production). */
  sink: BrainEventSink;
  /** One-shot start options (system prompt + fleet context). Applied on the
   *  first send via adapter.start(). */
  startOptions?: BrainStartOptions;
  /** Fired whenever a completed turn reports a session id DIFFERENT from the
   *  last one observed (P3a persistence hook). Failures inside the callback are
   *  swallowed — persistence must never break a live turn. */
  onSessionId?: (sessionId: string, accountId: string | null | undefined) => void;
  /** Fired AFTER a turn flips busy→idle, on a LATER TICK (never synchronously
   *  from the unwinding `finally`) — the event-push coalescer's flush trigger.
   *  Deferring is load-bearing: a synchronous callback could re-enter `send()`
   *  on the same stack while the prior turn is still unwinding. Not fired when
   *  the turn ended because the manager was disposed. Failures are swallowed. */
  onIdle?: () => void;
  /** Schedules the onIdle callback onto a later tick. Injected so tests drive it
   *  with fake timers; defaults to `setTimeout(fn, 0)`. */
  deferIdle?: (fn: () => void) => void;
}

export class CommanderSessionManager {
  private readonly adapter: BrainAdapter;
  private readonly sink: BrainEventSink;
  private readonly startOptions: BrainStartOptions;
  private readonly onSessionId?: (sessionId: string, accountId: string | null | undefined) => void;
  private readonly onIdle?: () => void;
  private readonly deferIdle: (fn: () => void) => void;
  private _status: CommanderStatus = 'idle';
  private _started = false;
  private _lastReportedSessionId: string | null = null;
  private localAbort: AbortController | null = null;
  /** Bumped by every foreign (TUI-typed) turn start. A local lookup compares
   *  it before answering or falling back: a short foreign turn can start and
   *  end while the board read is pending, leaving `adapterBusy` false again. */
  private foreignTurnGeneration = 0;

  constructor(deps: CommanderSessionManagerDeps) {
    this.adapter = deps.adapter;
    this.sink = deps.sink;
    this.startOptions = deps.startOptions ?? {};
    this.onSessionId = deps.onSessionId;
    this.onIdle = deps.onIdle;
    this.deferIdle = deps.deferIdle ?? ((fn) => {
      const t = setTimeout(fn, 0);
      // Main-process timer must never keep Electron alive.
      (t as { unref?: () => void }).unref?.();
    });
    // The seed counts as already-reported: resuming the same id unchanged
    // should not trigger a redundant persist.
    this._lastReportedSessionId = deps.startOptions?.resumeSessionId ?? null;
  }

  /** A turn the ADAPTER is aware of but did not start — the `claude-pty` brain
   *  reports one when the human types into its embedded TUI. Adapters without
   *  the getter (every other vendor, and the test fakes) are never foreign-busy. */
  private get adapterBusy(): boolean {
    return (this.adapter as { busy?: boolean }).busy === true;
  }

  private _turnOrigin: 'human' | 'automation' | null = null;

  /** Who started the latest turn this brain ACCEPTED: 'human' (the operator at
   *  the composer, or typing into the embedded TUI) or 'automation' (any wake,
   *  the dock's Wake button included). Set at the moment a turn is accepted,
   *  never on a request that was refused or is still waiting for a slot, so a
   *  queued wake and an operator prompt cannot overwrite each other's mark.
   *  Moa's no-click hand-off reads it (moaHandoff.ts). */
  get turnOrigin(): 'human' | 'automation' | null {
    return this._turnOrigin;
  }

  private _turnRemoteMoa = false;

  /** The latest accepted turn was a wake carrying another PC's Moa's work
   *  (a2a.received). Same lifetime as turnOrigin. Under an approved goal,
   *  fan-out refuses such a turn (fanout.rpc.ts), in code, not in the prompt. */
  get turnWokenByRemoteMoa(): boolean {
    return this._turnRemoteMoa;
  }

  /** The human typed a turn into the embedded TUI (it did not go through send). */
  notifyForeignTurnStart(): void {
    if (this._status === 'disposed') return;
    this.foreignTurnGeneration++;
    this._turnOrigin = 'human';
    this._turnRemoteMoa = false;
  }

  getStatus(): CommanderStatusSnapshot {
    const status: CommanderStatus =
      this._status === 'idle' && this.adapterBusy ? 'busy' : this._status;
    return { status, sessionId: this.adapter.sessionId };
  }

  /**
   * Run one turn: drain the adapter's event stream into the sink. Rejects
   * (without touching the adapter) when a turn is already running or the manager
   * is disposed. Resolves after the turn's stream completes; the caller (IPC
   * handler) returns the accept/reject result immediately and lets the events
   * flow over the push channel.
   *
   * `opts.origin` rides through to the adapter untouched: an ambient driver
   * (heartbeat / loop / schedule) marks its turn `'automation'` so a brain that
   * can race a human's own input has a chance to re-check before it commits.
   */
  async send(text: string, opts: BrainSendOptions = {}, localFirst?: CommanderLocalFirst): Promise<CommanderSendResult> {
    if (this._status === 'disposed') {
      this.sink({ type: 'error', message: 'commander session is closed' });
      return { ok: false, code: 'disposed' };
    }
    if (this._status === 'busy' || this.adapterBusy) {
      this.sink({ type: 'error', message: 'a command is already running — wait for it to finish' });
      return { ok: false, code: 'busy' };
    }
    let trimmed = text.trim();
    if (!trimmed) return { ok: false, code: 'empty' };

    if (!localFirst && !this._started) {
      this.adapter.start(this.startOptions);
      this._started = true;
    }

    this._status = 'busy';
    // Origin grants authority to the provider's live work. A local read only
    // reserves the turn slot; it must not promote earlier autonomous work to
    // operator-authorized work while looking up or showing a status answer.
    if (!localFirst) {
      this._turnOrigin = opts.origin === 'automation' ? 'automation' : 'human';
      this._turnRemoteMoa = opts.origin === 'automation' && opts.remoteMoa === true;
    }
    // Round-5 review P1: production adapters (ClaudeSdkAdapter, AcpBrainAdapter)
    // report failures by YIELDING a BrainEvent{type:'error'} — or by ending the
    // stream without a turn-end — rather than throwing, so an exception-only
    // 'errored' tag misses them. Completion is judged by OBSERVATION: a turn is
    // complete only when a turn-end was seen and no error event streamed.
    let sawTurnEnd = false;
    let sawErrorEvent = false;
    try {
      if (localFirst) {
        const controller = new AbortController();
        this.localAbort = controller;
        const generation = this.foreignTurnGeneration;
        // Stop must finish even when a read-only transport cannot cancel its
        // underlying request. Its late answer is observed but never emitted.
        const aborted = Symbol('local-turn-aborted');
        let onAbort: () => void = () => undefined;
        const cancelled = new Promise<typeof aborted>((resolve) => {
          onAbort = () => resolve(aborted);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        let answer: Awaited<ReturnType<CommanderLocalFirst>> | typeof aborted = null;
        try {
          answer = await Promise.race([localFirst(controller.signal), cancelled]);
        } catch {
          // A local read is an optimization. An unavailable or malformed
          // source must still get the ordinary adapter path, once.
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
          if (this.localAbort === controller) this.localAbort = null;
        }
        if (controller.signal.aborted || answer === aborted) {
          if ((this._status as CommanderStatus) !== 'disposed') {
            this.sink({ type: 'error', message: 'command interrupted' });
          }
          return { ok: true, code: 'errored' };
        }
        if ((this._status as CommanderStatus) === 'disposed') return { ok: true, code: 'errored' };
        // A human can start typing directly in the TUI while the read awaits.
        // Neither a local reply nor a fallback may overlap that foreign turn.
        if (this.adapterBusy) {
          this.sink({ type: 'error', message: 'a command is already running — wait for it to finish' });
          return { ok: true, code: 'errored' };
        }
        // A foreign turn that already came and went still invalidates the
        // lookup: the answer describes a board from before that turn, and a
        // fallback would land after it. One gate covers both branches.
        if (this.foreignTurnGeneration !== generation) {
          this.sink({ type: 'error', message: 'a terminal turn ran during this lookup — ask again' });
          return { ok: true, code: 'errored' };
        }
        if (answer && 'text' in answer && answer.text.trim()) {
          this.sink({ type: 'text-delta', text: answer.text });
          this.sink({ type: 'turn-end', sessionId: this.adapter.sessionId, localAnswer: { prompt: text, text: answer.text } });
          // No provider turn ran, so neither its session nor persistence hook
          // is changed by this answer.
          return { ok: true, localAnswer: { text: answer.text } };
        }
        if (answer && 'fallbackText' in answer) {
          // Context preparation may mutate bookkeeping. Keep it after every
          // asynchronous gate, in the same synchronous step as adapter send.
          const fallback = answer.fallbackText;
          trimmed = (typeof fallback === 'function' ? fallback() : fallback).trim();
        }
        this._turnOrigin = opts.origin === 'automation' ? 'automation' : 'human';
        this._turnRemoteMoa = opts.origin === 'automation' && opts.remoteMoa === true;
        if (!this._started) {
          this.adapter.start(this.startOptions);
          this._started = true;
        }
      }
      for await (const ev of this.adapter.send(trimmed, opts)) {
        // Disposed mid-turn (app quitting): stop forwarding. The adapter's
        // interrupt() was already fired by dispose(). Read through a widening
        // cast — TS narrows the field to 'busy' here, but dispose() can flip it
        // to 'disposed' during the await.
        if ((this._status as CommanderStatus) === 'disposed') break;
        if (ev.type === 'turn-end') sawTurnEnd = true;
        else if (ev.type === 'error') sawErrorEvent = true;
        if (
          ev.type === 'turn-end' &&
          ev.sessionId &&
          ev.sessionId !== this._lastReportedSessionId
        ) {
          this._lastReportedSessionId = ev.sessionId;
          try {
            this.onSessionId?.(ev.sessionId, this.adapter.conversationAccountId);
          } catch {
            /* persistence is best-effort — never fail the live turn */
          }
        }
        this.sink(ev);
      }
      // Observation-based completion (round-5 review P1): a stream that yielded
      // an error event, or ended without a turn-end (incl. a disposed-mid-turn
      // break), did NOT complete — tag it so provenance-sensitive callers (the
      // re-examine consume) keep durable records alive. ok stays true: the turn
      // ran and must not be retried as if it never started.
      return sawTurnEnd && !sawErrorEvent ? { ok: true } : { ok: true, code: 'errored' };
    } catch (err) {
      this.sink({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      // ok:true is deliberate — the turn RAN (callers must not retry it as if it
      // never started). `code:'errored'` is ADDITIVE (round-4 review P1): callers
      // that must distinguish "ran to completion" from "died mid-turn" (the
      // re-examine consume, which would otherwise delete a self-resolution the
      // turn never acted on) can check it; everyone else keys off `ok` alone.
      return { ok: true, code: 'errored' };
    } finally {
      // Never clobber a `disposed` flip that happened during the turn.
      if (this._status === 'busy') {
        this._status = 'idle';
        this.scheduleIdleWake();
      }
    }
  }

  /** Wake the coalescer on a LATER tick — never synchronously from a caller's
   *  stack, or the callback could re-enter send() while a turn is still
   *  unwinding. A dispose() between here and the tick cancels the wake. */
  private scheduleIdleWake(): void {
    if (!this.onIdle) return;
    const cb = this.onIdle;
    this.deferIdle(() => {
      if (this._status === 'disposed') return;
      try {
        cb();
      } catch {
        /* the coalescer flush is best-effort — never surface here */
      }
    });
  }

  /**
   * The adapter closed a turn this manager never started — the human typed
   * into the terminal brain's embedded TUI and their turn just ended.
   *
   * `getStatus()` reported busy for that whole turn, so anything the coalescer
   * buffered meanwhile is holding for a flush trigger that the normal
   * turn-end path will never fire. This is that trigger. Ignored while a
   * manager-run turn is live (its own finally will wake) or once disposed.
   */
  notifyForeignTurnEnd(): void {
    if (this._status !== 'idle') return;
    this.scheduleIdleWake();
  }

  /** Persist a session id learned from a foreign (TUI-typed) turn's Stop.
   *  Same dedup + best-effort contract as the turn-end path above. */
  notifyForeignSessionId(sessionId: string): void {
    if (!sessionId || sessionId === this._lastReportedSessionId) return;
    this._lastReportedSessionId = sessionId;
    try {
      this.onSessionId?.(sessionId, this.adapter.conversationAccountId);
    } catch {
      /* persistence is best-effort — never fail the live turn */
    }
  }

  /** Abort the in-flight turn (best-effort). No-op when idle/disposed. */
  interrupt(): void {
    if (this._status !== 'busy') return;
    if (this.localAbort) this.localAbort.abort();
    else this.adapter.interrupt();
  }

  /** Tear down the session — called on app quit. Interrupts any live turn and
   *  releases the adapter. Idempotent. */
  dispose(): void {
    if (this._status === 'disposed') return;
    this._status = 'disposed';
    this.localAbort?.abort();
    this.adapter.dispose();
  }
}
