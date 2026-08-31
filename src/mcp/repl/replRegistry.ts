/**
 * Per-connection REPL session registry.
 *
 * Scope is the CALLER'S MCP CONNECTION, held in ConnectionScope exactly the way
 * the PlaywrightEngine is. The broker hosts N server instances in one process,
 * so a process-global map would let one agent read and clobber another agent's
 * live runtime — variables, open handles, and all. Scoping it with the rest of
 * the per-connection state makes that unrepresentable rather than merely
 * avoided. The single-child stdio entry establishes no scope, so it falls back
 * to a module global, which in that topology is already one-agent-per-process.
 */
import { getConnectionScope } from '../connectionScope';
import { ReplSession } from './ReplSession';

/** Concurrent sessions one connection may hold. */
export const MAX_SESSIONS_PER_CONNECTION = 4;
/**
 * Idle lifetime. Deliberately shorter than a working session feels: in the
 * broker every live child is ~40 MB of resident memory multiplied by every
 * connected agent, and an abandoned REPL is indistinguishable from a busy one
 * until it is reaped.
 */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * How often the process looks for sessions to reclaim.
 *
 * ONE interval for the whole process, not one timer per session: the broker
 * hosts N connections holding up to four sessions each, and a timer per session
 * is N x 4 handles on the event loop to enforce a single coarse deadline. The
 * cost of the coarse tick is that a session can outlive its idle deadline by up
 * to one interval, which is noise against a fifteen-minute threshold.
 */
export const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
/**
 * Why a reclaimed session's state is gone. Written once here because the next
 * `repl_run` reads it back out through `previousDeath` and tells the caller —
 * a reclaimed session must never look like a silently fresh one.
 */
const IDLE_DEATH_REASON = `idle for ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes`;
/**
 * Ceiling on live children across the WHOLE process.
 *
 * The per-connection cap alone is not a limit in the broker: it hosts N agents
 * at once, so four sessions each multiplies out, and every child is tens of
 * megabytes of resident Node. Ten agents reaching their personal cap would put
 * forty runtimes on one machine long before the idle reaper noticed. This is
 * the bound that is actually about the host.
 */
export const MAX_SESSIONS_PER_PROCESS = 16;

/** Session names are used in messages and as map keys; keep them boring. */
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const DEFAULT_SESSION_NAME = 'default';

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_RE.test(name);
}

/**
 * Live children across every registry in this process. Registries are
 * per-connection by design and so cannot see each other; the host-wide bound
 * has to live outside them.
 */
const liveRegistries = new Set<ReplRegistry>();

function processLiveSessions(): number {
  let total = 0;
  for (const registry of liveRegistries) total += registry.liveCount;
  return total;
}

/** The one sweep for this process, started with the first registry. */
let sweepTimer: NodeJS.Timeout | null = null;

function startSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => reclaimIdleSessions(), IDLE_SWEEP_INTERVAL_MS);
  // An idle REPL waiting to be reaped is not work worth keeping the MCP server
  // alive for. Without this the sweep would hold the event loop open forever
  // and the process would never exit on its own.
  sweepTimer.unref?.();
}

function stopSweepTimerWhenUnused(): void {
  if (sweepTimer && liveRegistries.size === 0) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/**
 * Kill every child whose session has gone quiet for longer than the threshold.
 * Returns how many were reclaimed. `now` is injectable so a test can age
 * sessions without aging the child processes it is testing against.
 */
export function reclaimIdleSessions(now: number = Date.now()): number {
  let reclaimed = 0;
  for (const registry of liveRegistries) {
    // Per registry, because this runs on an interval callback in the broker:
    // an exception escaping here is an uncaughtException that takes down every
    // agent's connection, and it would also skip the registries after it in
    // the iteration. One connection's bad session is not the others' problem.
    try {
      reclaimed += registry.reclaimIdle(now);
    } catch {
      /* a session that will not die is not worth the whole process */
    }
  }
  return reclaimed;
}

/** The sweep handle, for the test that asserts it does not hold the loop open. */
export function idleSweepTimerForTest(): NodeJS.Timeout | null {
  return sweepTimer;
}

export class ReplRegistry {
  private readonly sessions = new Map<string, ReplSession>();

  constructor() {
    liveRegistries.add(this);
  }

  /** Sessions this registry currently holds whose child is still alive. */
  get liveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (!session.dead) count++;
    return count;
  }

  /**
   * Live sessions, oldest first.
   *
   * Dead ones are FILTERED, not deleted. Deleting here is what a tidier reading
   * suggests and it silently breaks the contract next door: `acquire` reads a
   * dead session's `diedBecause` to tell the caller why its variables are gone,
   * so a `repl_sessions` call between the reclaim and the next `repl_run` would
   * swallow the explanation and hand back a fresh runtime as if nothing had
   * happened.
   */
  list(): ReplSession[] {
    this.sweep();
    return [...this.sessions.values()].filter((session) => !session.dead);
  }

  get(name: string): ReplSession | undefined {
    this.sweep();
    const session = this.sessions.get(name);
    return session && !session.dead ? session : undefined;
  }

  /**
   * The live session for `name`, spawning one if there is none or if the
   * previous one died. Returns whether a new runtime was created so the caller
   * can tell the agent its state is gone rather than letting it assume.
   */
  acquire(name: string, cwd: string): { session: ReplSession; created: boolean; previousDeath?: string } {
    // Read the named slot BEFORE sweeping. The sweep drops dead sessions, and
    // dropping this one first would throw away the reason its state vanished —
    // which is the one thing the caller most needs to be told.
    const existing = this.sessions.get(name);
    if (existing && !existing.dead) return { session: existing, created: false };

    const previousDeath = existing?.diedBecause ?? undefined;
    if (existing) this.sessions.delete(name);
    this.sweep();

    // Live sessions, not map entries: the map also holds reclaimed corpses,
    // and letting those occupy the cap would refuse a caller a runtime on
    // behalf of sessions that no longer exist.
    const live = [...this.sessions.values()].filter((session) => !session.dead);
    if (live.length >= MAX_SESSIONS_PER_CONNECTION) {
      throw new Error(
        `this connection already holds ${MAX_SESSIONS_PER_CONNECTION} REPL sessions ` +
          `(${live.map((session) => session.name).join(', ')}). Call repl_reset on one before starting another.`,
      );
    }
    if (processLiveSessions() >= MAX_SESSIONS_PER_PROCESS) {
      throw new Error(
        `this wmux MCP server is already running ${MAX_SESSIONS_PER_PROCESS} REPL runtimes across all ` +
          'connected agents, which is its host-wide limit. Call repl_reset on a session you are done with.',
      );
    }

    const session = new ReplSession({ name, cwd });
    this.sessions.set(name, session);
    // Re-assert membership rather than relying on the constructor's: a registry
    // that was disposed and then used again would otherwise hold a child no
    // sweep can see and no host-wide count knows about. Arming the sweep here
    // and not in the constructor also keeps a connection that only ever called
    // repl_sessions from carrying a sixty-second wakeup for nothing.
    liveRegistries.add(this);
    startSweepTimer();
    return { session, created: true, previousDeath };
  }

  /** Kill and forget one session. Returns false when there was nothing to reset. */
  reset(name: string): boolean {
    const session = this.sessions.get(name);
    if (!session) return false;
    session.destroy('reset by repl_reset');
    this.sessions.delete(name);
    return true;
  }

  /** Kill every session. Called when the connection goes away. */
  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.destroy('the MCP connection closed');
    }
    this.sessions.clear();
    liveRegistries.delete(this);
    stopSweepTimerWhenUnused();
  }

  /**
   * Kill the children of sessions that have gone quiet, and leave the corpses
   * in the map.
   *
   * Deleting the entry here would be the obvious tidier move and is exactly
   * wrong: `acquire` reads the dead session's `diedBecause` to tell the next
   * caller WHY its variables are gone, and an entry deleted by the sweep would
   * make a reclaimed session indistinguishable from one that never existed. The
   * corpse is a few hundred bytes and the next `acquire`/`list` drops it; the
   * forty megabytes this is actually about died with the child.
   *
   * A busy session is spared no matter how stale `lastUsed` looks: it is mid-
   * eval, and an eval may legitimately run for the full five-minute ceiling.
   */
  reclaimIdle(now: number): number {
    let reclaimed = 0;
    for (const session of this.sessions.values()) {
      if (session.dead || session.busy) continue;
      if (now - session.lastUsed < IDLE_TIMEOUT_MS) continue;
      session.destroy(IDLE_DEATH_REASON);
      reclaimed++;
    }
    return reclaimed;
  }

  /**
   * Drop corpses the caller can no longer plausibly be told about.
   *
   * A dead session is kept ON PURPOSE — `acquire` reads its `diedBecause`. But
   * session names are the caller's to invent, so an agent that never reuses one
   * would grow this map without bound. Keep as many corpses as there are live
   * slots and drop the rest, oldest first (the Map iterates in insertion
   * order).
   */
  private sweep(): void {
    const dead = [...this.sessions.entries()].filter(([, session]) => session.dead);
    const excess = dead.length - MAX_SESSIONS_PER_CONNECTION;
    for (let i = 0; i < excess; i++) this.sessions.delete(dead[i][0]);
  }
}

/** Single-child (stdio entry) fallback — no connection scope exists there. */
let processRegistry: ReplRegistry | null = null;

/**
 * True once this process is hosting multiple connections. Set by the broker at
 * startup; the single-child stdio entry never sets it.
 */
let brokerMode = false;

/** Declare that this process hosts more than one agent's connection. */
export function setReplBrokerMode(): void {
  brokerMode = true;
}

/**
 * The calling connection's registry, created on first use.
 *
 * The module-global fallback is correct for the stdio entry, where the process
 * already belongs to exactly one agent. In the broker it would be a disaster:
 * any call that lost its AsyncLocalStorage context would land on a registry
 * SHARED with every other connection, handing one agent another agent's live
 * `default` session — its variables, its open handles, its half-finished work.
 * A silent fallback makes that failure look like success, so in broker mode the
 * missing scope is an error instead.
 */
export function getReplRegistry(): ReplRegistry {
  const scope = getConnectionScope();
  if (scope) {
    if (!scope.repl) scope.repl = new ReplRegistry();
    return scope.repl as ReplRegistry;
  }
  if (brokerMode) {
    throw new Error(
      'internal: no MCP connection scope is active, so this REPL call cannot be attributed ' +
        'to a caller. Refusing rather than risking another agent\'s session.',
    );
  }
  if (!processRegistry) processRegistry = new ReplRegistry();
  return processRegistry;
}

/**
 * Tear down whichever registry belongs to the caller. Safe to call when none
 * was ever created — a connection that never touched the REPL has nothing to
 * dispose, and creating one just to destroy it would spawn nothing anyway.
 */
export function disposeReplRegistry(): void {
  const scope = getConnectionScope();
  // Deliberately tolerant where getReplRegistry is strict: this runs on the
  // teardown path, and throwing there would abandon the rest of a connection's
  // cleanup to protect against a risk that only exists when CREATING sessions.
  if (scope) {
    (scope.repl as ReplRegistry | undefined)?.disposeAll();
    scope.repl = undefined;
    return;
  }
  processRegistry?.disposeAll();
  processRegistry = null;
}
