/**
 * One delivery at a time into a pane, across processes. Main's gated
 * deliveries and the daemon's own writers (scheduled prompts, automation runs,
 * caller nudges, chat sends) each check the pane and then write; a write by
 * the other in between leaves a paste in the input box with its Enter
 * withheld. The daemon owns the PTY, so it owns this lock, keyed by session.
 *
 * - FIFO per pane, with a bounded wait: a waiter not granted in time gets
 *   null (busy), and its place is given up.
 * - Main holds it over RPC and writes through `daemon.session.writeHeldV1`,
 *   which checks the token and writes in the same tick (index.ts), so a
 *   grant that ended can never write.
 * - A hold ends on release, on its holder's control pipe closing, on the
 *   session ending, or when its lease runs out: renewed on every held write,
 *   a lease reclaims an orphan (a holder that hung) after LEASE_MS.
 * - Writers with no span of their own (the chat writers' per-write
 *   callbacks) hold it stickily: each write takes or renews a short hold.
 */

import { randomUUID } from 'node:crypto';

/** A hold no write renewed for this long is reclaimed. */
export const PANE_LOCK_LEASE_MS = 60_000;
/** The longest any acquire may wait. */
export const PANE_LOCK_MAX_WAIT_MS = 10_000;
/** How long a daemon writer waits for the pane before it answers busy. */
export const PANE_LOCK_DAEMON_WAIT_MS = 4_000;
/** A sticky hold (a per-write writer) ends this long after its last write. */
export const PANE_LOCK_STICKY_MS = 2_000;

export interface PaneLockHolder {
  /** Who holds it, for the log and for a sticky hold's renewal. */
  key: string;
  /** Main's control-pipe client: the hold ends when that pipe closes. */
  clientId?: string;
  /** Main's own id for this acquire, so a lost reply can still be released. */
  nonce?: string;
}

interface Grant {
  token: string;
  holder: PaneLockHolder;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  holder: PaneLockHolder;
  resolve: (token: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PaneEntry {
  grant: Grant | null;
  waiters: Waiter[];
}

export interface PaneDeliveryLocksOptions {
  now?: () => number;
  leaseMs?: number;
  log?: (line: string) => void;
}

export class PaneDeliveryLocks {
  private readonly panes = new Map<string, PaneEntry>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly log: (line: string) => void;

  constructor(opts: PaneDeliveryLocksOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.leaseMs = opts.leaseMs ?? PANE_LOCK_LEASE_MS;
    this.log = opts.log ?? (() => undefined);
  }

  /** The pane's lock for `holder`, waiting at most `waitMs`: its token, or null (busy). */
  acquire(sessionId: string, holder: PaneLockHolder, waitMs: number): Promise<string | null> {
    const pane = this.entry(sessionId);
    if (!pane.grant && pane.waiters.length === 0) return Promise.resolve(this.grant(sessionId, pane, holder));
    const wait = Math.min(Math.max(0, waitMs), PANE_LOCK_MAX_WAIT_MS);
    if (wait === 0) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const waiter: Waiter = {
        holder,
        resolve,
        timer: setTimeout(() => {
          const at = pane.waiters.indexOf(waiter);
          if (at >= 0) pane.waiters.splice(at, 1);
          this.forget(sessionId, pane);
          resolve(null);
        }, wait),
      };
      pane.waiters.push(waiter);
    });
  }

  /** Whether `token` holds the pane now (and, for main, from `clientId`); renews its lease. */
  holds(sessionId: string, token: string, clientId?: string): boolean {
    const grant = this.panes.get(sessionId)?.grant;
    if (!grant || grant.token !== token) return false;
    if (clientId !== undefined && grant.holder.clientId !== clientId) return false;
    this.arm(sessionId, grant, this.leaseMs);
    return true;
  }

  /** Whether someone other than `key` holds the pane or waits for it. */
  busyFor(sessionId: string, key: string): boolean {
    const pane = this.panes.get(sessionId);
    if (!pane) return false;
    return (!!pane.grant && pane.grant.holder.key !== key) || (!pane.grant && pane.waiters.length > 0);
  }

  /**
   * A writer with no span of its own: take the pane for a short hold, or
   * renew the one it has. False when another writer holds it: nothing may be
   * written.
   */
  holdSticky(sessionId: string, key: string): boolean {
    const pane = this.entry(sessionId);
    if (pane.grant) {
      if (pane.grant.holder.key !== key) return false;
      this.arm(sessionId, pane.grant, PANE_LOCK_STICKY_MS);
      return true;
    }
    if (pane.waiters.length > 0) return false;
    this.grant(sessionId, pane, { key }, PANE_LOCK_STICKY_MS);
    return true;
  }

  release(sessionId: string, token: string): void {
    const pane = this.panes.get(sessionId);
    if (pane?.grant?.token === token) this.handOn(sessionId, pane);
  }

  /** Main's acquire whose reply was lost: its hold, or its place in the queue, by nonce. */
  releaseNonce(sessionId: string, clientId: string, nonce: string): void {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    const mine = (h: PaneLockHolder) => h.clientId === clientId && h.nonce === nonce;
    const at = pane.waiters.findIndex((w) => mine(w.holder));
    if (at >= 0) {
      const [waiter] = pane.waiters.splice(at, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    if (pane.grant && mine(pane.grant.holder)) this.handOn(sessionId, pane);
    else this.forget(sessionId, pane);
  }

  /** A control pipe closed: every hold and wait of that client ends. */
  releaseClient(clientId: string): void {
    for (const [sessionId, pane] of [...this.panes]) {
      for (const waiter of pane.waiters.filter((w) => w.holder.clientId === clientId)) {
        pane.waiters.splice(pane.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      if (pane.grant?.holder.clientId === clientId) this.handOn(sessionId, pane);
      else this.forget(sessionId, pane);
    }
  }

  /** The session ended: its hold and its queue go. */
  dropSession(sessionId: string): void {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    if (pane.grant?.timer) clearTimeout(pane.grant.timer);
    for (const waiter of pane.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.panes.delete(sessionId);
  }

  /**
   * `fn` under the pane's lock for a daemon writer, from before its first look
   * at the pane through its last write. Null when the pane was not granted in
   * time (busy).
   */
  async runLocked<T>(sessionId: string, key: string, waitMs: number, fn: () => Promise<T>): Promise<T | null> {
    const token = await this.acquire(sessionId, { key }, waitMs);
    if (!token) return null;
    try {
      return await fn();
    } finally {
      this.release(sessionId, token);
    }
  }

  /** Test/diagnostic view: the holder key of the pane, if held. */
  holderOf(sessionId: string): string | undefined {
    return this.panes.get(sessionId)?.grant?.holder.key;
  }

  private entry(sessionId: string): PaneEntry {
    let pane = this.panes.get(sessionId);
    if (!pane) {
      pane = { grant: null, waiters: [] };
      this.panes.set(sessionId, pane);
    }
    return pane;
  }

  private grant(sessionId: string, pane: PaneEntry, holder: PaneLockHolder, leaseMs = this.leaseMs): string {
    const grant: Grant = { token: randomUUID(), holder, expiresAt: 0, timer: null };
    pane.grant = grant;
    this.arm(sessionId, grant, leaseMs);
    return grant.token;
  }

  /** (Re)start the grant's lease: it is reclaimed once `ms` pass with no renewal. */
  private arm(sessionId: string, grant: Grant, ms: number): void {
    grant.expiresAt = this.now() + ms;
    if (grant.timer) clearTimeout(grant.timer);
    grant.timer = setTimeout(() => {
      const pane = this.panes.get(sessionId);
      if (pane?.grant !== grant) return;
      if (ms >= this.leaseMs) this.log(`[pane-lock] session=${sessionId} hold by ${grant.holder.key} reclaimed after ${ms} ms with no write`);
      this.handOn(sessionId, pane);
    }, ms);
    grant.timer.unref?.();
  }

  /** End the current hold and give the pane to the next waiter. */
  private handOn(sessionId: string, pane: PaneEntry): void {
    if (pane.grant?.timer) clearTimeout(pane.grant.timer);
    pane.grant = null;
    const next = pane.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(this.grant(sessionId, pane, next.holder));
      return;
    }
    this.forget(sessionId, pane);
  }

  private forget(sessionId: string, pane: PaneEntry): void {
    if (!pane.grant && pane.waiters.length === 0 && this.panes.get(sessionId) === pane) this.panes.delete(sessionId);
  }
}

/** The pane input a held write goes to (the session's PTY and its bridge). */
export interface HeldWriteTarget {
  write(data: string): void;
  /** Bytes the PTY adapter still holds; past the high-water mark nothing is written. */
  pendingInputBytes?: number;
  noteInput(data: string): void;
}

/** The session pipe's input high-water mark (index.ts pipe.onInput). */
export const HELD_WRITE_HIGH_WATER = 6 * 1024 * 1024;

/**
 * main's write under the pane's lock (`daemon.session.writeHeldV1`): the
 * hold is checked and the bytes written in one synchronous step, and noted
 * exactly as the session pipe's input is. Nothing is written past the
 * high-water mark or on the adapter's backpressure.
 */
export function writeUnderLock(
  locks: PaneDeliveryLocks,
  sessionId: string,
  token: string,
  clientId: string,
  target: HeldWriteTarget | undefined,
  data: string,
): { ok: true } | { ok: false; error: 'no session' | 'not held' | 'backpressure' } {
  if (!target) return { ok: false, error: 'no session' };
  if (!locks.holds(sessionId, token, clientId)) return { ok: false, error: 'not held' };
  if (!data) return { ok: true };
  if ((target.pendingInputBytes ?? 0) >= HELD_WRITE_HIGH_WATER) return { ok: false, error: 'backpressure' };
  try {
    target.write(data);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PTY_BACKPRESSURE')) return { ok: false, error: 'backpressure' };
    throw error;
  }
  target.noteInput(data);
  return { ok: true };
}
