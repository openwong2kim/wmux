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

import type { BrainAdapter, BrainEvent, BrainStartOptions } from './BrainAdapter';

export type CommanderStatus = 'idle' | 'busy' | 'disposed';

/** Sink for normalized events (the IPC push). Called in stream order; the
 *  manager never awaits it. */
export type BrainEventSink = (event: BrainEvent) => void;

export interface CommanderSendResult {
  /** Whether the turn was accepted and started streaming. */
  ok: boolean;
  /** Present on rejection: `busy` (a turn is running), `disposed`, `empty`,
   *  or `invalid_workspace` (handler-level, M1.5 — the send carried no valid
   *  workspaceId to route to an orchestrator). Additionally `errored` rides an
   *  ok:true result when the turn RAN but the adapter threw mid-stream —
   *  callers that must distinguish "completed" from "died mid-turn" (the
   *  re-examine consume) check it; everyone else keys off `ok` alone. */
  code?: 'busy' | 'disposed' | 'empty' | 'invalid_workspace' | 'errored';
}

export interface CommanderStatusSnapshot {
  status: CommanderStatus;
  sessionId: string | null;
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
  onSessionId?: (sessionId: string) => void;
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
  private readonly onSessionId?: (sessionId: string) => void;
  private readonly onIdle?: () => void;
  private readonly deferIdle: (fn: () => void) => void;
  private _status: CommanderStatus = 'idle';
  private _started = false;
  private _lastReportedSessionId: string | null = null;

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

  getStatus(): CommanderStatusSnapshot {
    return { status: this._status, sessionId: this.adapter.sessionId };
  }

  /**
   * Run one turn: drain the adapter's event stream into the sink. Rejects
   * (without touching the adapter) when a turn is already running or the manager
   * is disposed. Resolves after the turn's stream completes; the caller (IPC
   * handler) returns the accept/reject result immediately and lets the events
   * flow over the push channel.
   */
  async send(text: string): Promise<CommanderSendResult> {
    if (this._status === 'disposed') {
      this.sink({ type: 'error', message: 'commander session is closed' });
      return { ok: false, code: 'disposed' };
    }
    if (this._status === 'busy') {
      this.sink({ type: 'error', message: 'a command is already running — wait for it to finish' });
      return { ok: false, code: 'busy' };
    }
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, code: 'empty' };

    if (!this._started) {
      this.adapter.start(this.startOptions);
      this._started = true;
    }

    this._status = 'busy';
    // Round-5 review P1: production adapters (ClaudeSdkAdapter, AcpBrainAdapter)
    // report failures by YIELDING a BrainEvent{type:'error'} — or by ending the
    // stream without a turn-end — rather than throwing, so an exception-only
    // 'errored' tag misses them. Completion is judged by OBSERVATION: a turn is
    // complete only when a turn-end was seen and no error event streamed.
    let sawTurnEnd = false;
    let sawErrorEvent = false;
    try {
      for await (const ev of this.adapter.send(trimmed)) {
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
            this.onSessionId?.(ev.sessionId);
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
        // Wake the coalescer on a LATER tick — never synchronously here, or the
        // callback could re-enter send() while this turn is still unwinding.
        if (this.onIdle) {
          const cb = this.onIdle;
          this.deferIdle(() => {
            // A dispose() between the flip and this tick must cancel the wake.
            if (this._status === 'disposed') return;
            try {
              cb();
            } catch {
              /* the coalescer flush is best-effort — never surface here */
            }
          });
        }
      }
    }
  }

  /** Abort the in-flight turn (best-effort). No-op when idle/disposed. */
  interrupt(): void {
    if (this._status === 'busy') this.adapter.interrupt();
  }

  /** Tear down the session — called on app quit. Interrupts any live turn and
   *  releases the adapter. Idempotent. */
  dispose(): void {
    if (this._status === 'disposed') return;
    this._status = 'disposed';
    this.adapter.dispose();
  }
}
