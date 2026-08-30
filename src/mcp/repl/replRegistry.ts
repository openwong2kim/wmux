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

  /** Live sessions, oldest first. Dead ones are swept as they are noticed. */
  list(): ReplSession[] {
    this.sweep();
    return [...this.sessions.values()];
  }

  get(name: string): ReplSession | undefined {
    this.sweep();
    return this.sessions.get(name);
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

    if (this.sessions.size >= MAX_SESSIONS_PER_CONNECTION) {
      throw new Error(
        `this connection already holds ${MAX_SESSIONS_PER_CONNECTION} REPL sessions ` +
          `(${[...this.sessions.keys()].join(', ')}). Call repl_reset on one before starting another.`,
      );
    }
    if (processLiveSessions() >= MAX_SESSIONS_PER_PROCESS) {
      throw new Error(
        `this wmux MCP server is already running ${MAX_SESSIONS_PER_PROCESS} REPL runtimes across all ` +
          'connected agents, which is its host-wide limit. Call repl_reset on a session you are done with.',
      );
    }

    const session = new ReplSession({ name, cwd, idleMs: IDLE_TIMEOUT_MS });
    this.sessions.set(name, session);
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
  }

  /** Forget sessions whose child is already gone (idle reap, crash, kill). */
  private sweep(): void {
    for (const [name, session] of this.sessions) {
      if (session.dead) this.sessions.delete(name);
    }
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
