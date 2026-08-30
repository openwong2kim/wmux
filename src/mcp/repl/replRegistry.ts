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

/** Session names are used in messages and as map keys; keep them boring. */
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const DEFAULT_SESSION_NAME = 'default';

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_RE.test(name);
}

export class ReplRegistry {
  private readonly sessions = new Map<string, ReplSession>();

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

/** The calling connection's registry, created on first use. */
export function getReplRegistry(): ReplRegistry {
  const scope = getConnectionScope();
  if (scope) {
    if (!scope.repl) scope.repl = new ReplRegistry();
    return scope.repl as ReplRegistry;
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
  if (scope) {
    (scope.repl as ReplRegistry | undefined)?.disposeAll();
    scope.repl = undefined;
    return;
  }
  processRegistry?.disposeAll();
  processRegistry = null;
}
