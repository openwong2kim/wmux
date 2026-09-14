import type { DaemonEvent, DaemonSupervisionPolicy, SupervisionRuntime } from '../shared/rpc';

/**
 * X8 pane supervision — the daemon-side "init system" for agent panes.
 *
 * Scope (the "house for the loop, not the loop" principle): this class only
 * decides WHEN a dead exec unit is re-launched and when to give up. It owns
 * no goals, no prompts, no stopping conditions — those belong to the agent
 * CLI running inside the pane.
 *
 * Topology contract (what makes user intent safe for free):
 *  - `session:died`  → the PTY exited on its own → feed `onSessionDied`.
 *  - `session:destroyed` → the USER closed the pane (destroySession disposes
 *    the exit listener before killing, so died never fires) → feed `disarm`.
 *    A supervisor that only ever restarts on `died` is structurally unable
 *    to resurrect a pane the user closed.
 *  - Supervisor-initiated restarts go through deps.restartSession, which
 *    must use DaemonSessionManager.removeTombstone (silent) — never
 *    destroySession — so a restart can't masquerade as a user close.
 *
 * Runaway guard (#54 DaemonRespawnController's proven model, not a sliding
 * window): count consecutive SHORT-LIVED runs — a run that died before
 * `healthyUptimeSec` counts regardless of exit code, because a 0-exit
 * instant-exit loop under `restart: always` burns tokens just as fast as a
 * crashing one. A healthy run resets the counter. At `burst` consecutive
 * short runs supervision stops (sticky, persisted) and only a manual rearm
 * resumes it.
 *
 * Pure Node (no Electron); all side effects via injected deps → unit-testable
 * with fake timers and a fake clock.
 */

export interface PaneSupervisorDeps {
  /**
   * Re-create the SAME session id with a fresh PTY (tombstone removal +
   * createSession replay of meta incl. exec + processMonitor re-watch +
   * persist). Owned by daemon/index.ts. May throw (or return a promise that
   * rejects) on spawn failure — the supervisor treats either as a failed
   * (short) start and backs off.
   */
  restartSession(id: string): void | Promise<void>;
  /** True when the session currently holds no live PTY (dead tombstone or gone). */
  isSessionDead(id: string): boolean;
  /** pipeServer.broadcast — supervision events for main/renderer surfaces. */
  broadcast(event: DaemonEvent): void;
  /** Persist meta.supervision.status (sticky across daemon restarts). */
  persistStatus(id: string, status: 'armed' | 'stopped'): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Test clock injection; defaults to Date.now. */
  now?(): number;
}

/** Backoff: min(1000ms · 2^n, 30000ms) — same curve as DaemonRespawnController. */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

interface SupervisedEntry {
  policy: DaemonSupervisionPolicy;
  status: 'armed' | 'stopped';
  restartCount: number;
  consecutiveFailures: number;
  lastExit?: { exitCode: number | null; signal?: number; at: string };
  /** Timestamp of the current run's start — healthy-uptime evaluation. */
  startedAt: number;
  timer?: NodeJS.Timeout;
  nextRestartAt?: number;
}

export class PaneSupervisor {
  private entries = new Map<string, SupervisedEntry>();

  constructor(private deps: PaneSupervisorDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Start supervising a session. Called on createSession (status 'armed')
   * and on recovery re-arm, where the persisted status is replayed — a
   * runaway-guard 'stopped' arrives stopped and stays stopped (badge +
   * rearm entry point only; silently re-arming across a reboot would be a
   * trust violation).
   */
  arm(id: string, policy: DaemonSupervisionPolicy, initialStatus: 'armed' | 'stopped' = 'armed'): void {
    const existing = this.entries.get(id);
    if (existing?.timer) clearTimeout(existing.timer);
    this.entries.set(id, {
      policy: { restart: policy.restart, limit: { ...policy.limit } },
      status: initialStatus,
      restartCount: 0,
      consecutiveFailures: 0,
      startedAt: this.now(),
    });
  }

  /**
   * The user closed the pane (`session:destroyed`) — forget everything,
   * including a restart pending in its backoff window. Restart-internal
   * tombstone removal never emits destroyed, so this can't misfire on a
   * supervisor-initiated restart.
   */
  disarm(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
  }

  /**
   * Manual "Stop supervision" (the Ctrl+C escape hatch: exit 130 restarts
   * like systemd would, so the pane menu offers an explicit off switch).
   * Cancels any pending restart; the entry stays for the badge + rearm.
   */
  stop(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.status === 'stopped') return false;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.nextRestartAt = undefined;
    }
    this.setStopped(id, entry, 'manual-stop');
    return true;
  }

  /**
   * Manual recovery after a guard trip (renderer-only RPC): reset counters,
   * re-arm, and — when the unit is currently dead — launch one immediate
   * restart. Returns false when there is nothing to rearm.
   */
  rearm(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'stopped') return false;
    entry.status = 'armed';
    entry.restartCount = 0;
    entry.consecutiveFailures = 0;
    this.deps.persistStatus(id, 'armed');
    this.broadcastChanged(id, entry, 'rearm');
    this.deps.log('info', `[supervisor] ${id} re-armed`);
    if (this.deps.isSessionDead(id)) {
      this.fireRestart(id, entry);
    }
    return true;
  }

  /**
   * Feed of `session:died` (PTY exited on its own). Decides restart per
   * policy, maintains the runaway counter, schedules the backoff timer.
   */
  onSessionDied(payload: { id: string; exitCode: number | null; signal?: number }): void {
    const entry = this.entries.get(payload.id);
    if (!entry) return;
    // A pending backoff restart means this death was already accounted for
    // (double-delivery via the ProcessMonitor safety net would otherwise
    // double-increment the guard counter).
    if (entry.timer) return;

    const at = new Date(this.now()).toISOString();
    entry.lastExit = { exitCode: payload.exitCode, signal: payload.signal, at };

    if (entry.status === 'stopped') return;

    const uptimeMs = this.now() - entry.startedAt;
    const healthy = uptimeMs >= entry.policy.limit.healthyUptimeSec * 1_000;
    if (healthy) entry.consecutiveFailures = 0;

    // Success = clean exit AND no signal. Everything else — non-zero code,
    // a signal, or exitCode null (ProcessMonitor saw the PID vanish: an
    // external kill) — is failure, systemd-style. No per-code whitelist:
    // Ctrl+C is 130 on POSIX but 0xC000013A on Windows, so code-based
    // user-intent detection is platform-fragile by construction. User
    // intent is expressed by closing the pane (destroyed → disarm) or the
    // explicit stop action, never inferred from an exit code.
    const success = payload.exitCode === 0 && payload.signal == null;
    const wantRestart = entry.policy.restart === 'always' || !success;
    if (!wantRestart) {
      this.deps.log('info', `[supervisor] ${payload.id} exited cleanly (on-failure) — not restarting`);
      return;
    }

    if (!healthy) entry.consecutiveFailures++;
    if (entry.consecutiveFailures >= entry.policy.limit.burst) {
      this.deps.log(
        'warn',
        `[supervisor] ${payload.id} hit the runaway guard (${entry.consecutiveFailures} consecutive short runs) — stopping supervision`,
      );
      this.setStopped(payload.id, entry, 'guard-trip');
      return;
    }

    const backoffMs = Math.min(
      BASE_BACKOFF_MS * 2 ** Math.max(0, entry.consecutiveFailures - 1),
      MAX_BACKOFF_MS,
    );
    entry.nextRestartAt = this.now() + backoffMs;
    this.deps.log(
      'info',
      `[supervisor] ${payload.id} died (exit ${payload.exitCode ?? 'null'}) — restart in ${backoffMs}ms` +
        ` (consecutive short runs: ${entry.consecutiveFailures}/${entry.policy.limit.burst})`,
    );
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.nextRestartAt = undefined;
      this.fireRestart(payload.id, entry);
    }, backoffMs);
    entry.timer.unref?.();
  }

  getRuntime(id: string): SupervisionRuntime | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return {
      status: entry.status,
      restartCount: entry.restartCount,
      consecutiveFailures: entry.consecutiveFailures,
      ...(entry.lastExit ? { lastExit: { ...entry.lastExit } } : {}),
      ...(entry.nextRestartAt !== undefined ? { nextRestartAt: entry.nextRestartAt } : {}),
    };
  }

  /** Shutdown: cancel every pending restart timer. Entries stay readable. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.nextRestartAt = undefined;
      }
    }
  }

  private fireRestart(id: string, entry: SupervisedEntry): void {
    entry.restartCount++;
    entry.startedAt = this.now();
    const fail = (err: unknown): void => {
      // Spawn failure (e.g. transient ConPTY error 87) — a failed start in
      // the start-limit sense. Re-enter the death path with a synthetic
      // failure so the same backoff/guard machinery applies.
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log('error', `[supervisor] restart of ${id} failed: ${msg}`);
      // An async restart can settle after the pane was closed or re-armed;
      // its failure must not be charged to a different (or no) entry.
      if (this.entries.get(id) !== entry) return;
      // startedAt was just stamped → uptime 0 → counts as a short run.
      this.onSessionDied({ id, exitCode: null });
    };
    let pending: void | Promise<void>;
    try {
      pending = this.deps.restartSession(id);
    } catch (err) {
      fail(err);
      return;
    }
    if (pending instanceof Promise) {
      pending.then(() => this.restartSucceeded(id, entry), fail);
      return;
    }
    this.restartSucceeded(id, entry);
  }

  private restartSucceeded(id: string, entry: SupervisedEntry): void {
    // Closed (disarm) or re-armed while an async restart was in flight: the
    // id is no longer supervised by this entry, so announce nothing.
    if (this.entries.get(id) !== entry) return;
    this.deps.broadcast({
      type: 'session.restarted',
      sessionId: id,
      data: {
        restartCount: entry.restartCount,
        consecutiveFailures: entry.consecutiveFailures,
        exitCode: entry.lastExit?.exitCode ?? null,
      },
    });
    this.deps.log('info', `[supervisor] ${id} restarted (#${entry.restartCount})`);
  }

  private setStopped(id: string, entry: SupervisedEntry, reason: 'guard-trip' | 'manual-stop'): void {
    entry.status = 'stopped';
    this.deps.persistStatus(id, 'stopped');
    this.broadcastChanged(id, entry, reason);
  }

  private broadcastChanged(
    id: string,
    entry: SupervisedEntry,
    reason: 'guard-trip' | 'rearm' | 'manual-stop',
  ): void {
    this.deps.broadcast({
      type: 'supervision.changed',
      sessionId: id,
      data: {
        status: entry.status,
        reason,
        restartCount: entry.restartCount,
        consecutiveFailures: entry.consecutiveFailures,
      },
    });
  }
}
