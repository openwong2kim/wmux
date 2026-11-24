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
 * - Main's next acquire on a pane its own connection still holds ends that
 *   hold: main's in-process chain (freshContext.ts withPaneDeliveryLock) lets
 *   one delivery per pane reach this lock at a time, so such a hold is one
 *   whose release was lost.
 * - Writers with no span of their own (chatV2's per-write callback, the chat
 *   bridges' keys outside a send) hold it stickily: each write takes or
 *   renews a short hold.
 */

import { randomUUID } from 'node:crypto';
import { HELD_WRITE_CHUNK_MAX } from '../shared/heldWrite';

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
  /** A per-write hold (holdSticky): it ends PANE_LOCK_STICKY_MS after its last write. */
  sticky: boolean;
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
  leaseMs?: number;
  log?: (line: string) => void;
}

export class PaneDeliveryLocks {
  private readonly panes = new Map<string, PaneEntry>();
  /** #3393 — told of every held write that landed (writeUnderLock), in the tick it was counted. */
  onHeldWrite: ((sessionId: string) => void) | undefined;
  private readonly leaseMs: number;
  private readonly log: (line: string) => void;

  constructor(opts: PaneDeliveryLocksOptions = {}) {
    this.leaseMs = opts.leaseMs ?? PANE_LOCK_LEASE_MS;
    this.log = opts.log ?? (() => undefined);
  }

  /** The pane's lock for `holder`, waiting at most `waitMs`: its token, or null (busy). */
  acquire(sessionId: string, holder: PaneLockHolder, waitMs: number): Promise<string | null> {
    const pane = this.entry(sessionId);
    if (!pane.grant && pane.waiters.length === 0) return Promise.resolve(this.grant(sessionId, pane, holder));
    // Held by this same connection: its release was lost (see the header).
    // That hold ends, and this acquire takes its turn behind any waiter.
    if (holder.clientId !== undefined && pane.grant?.holder.clientId === holder.clientId) {
      this.log(`[pane-lock] session=${sessionId} hold by ${pane.grant.holder.key} ended by the same connection's next acquire`);
      this.handOn(sessionId, pane);
      return this.acquire(sessionId, holder, waitMs);
    }
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

  /**
   * Whether `token` holds the pane now (and, for main, from `clientId`).
   * `renew`: a write under it renews its lease; a check alone does not.
   */
  holds(sessionId: string, token: string, clientId?: string, renew = true): boolean {
    const grant = this.panes.get(sessionId)?.grant;
    if (!grant || grant.token !== token) return false;
    if (clientId !== undefined && grant.holder.clientId !== clientId) return false;
    if (renew) this.arm(sessionId, grant, this.leaseMs);
    return true;
  }

  /**
   * A writer with no span of its own: take the pane for a short hold, or
   * renew the one it has. Inside the same writer's span (runLocked with the
   * same key) it writes under that hold, which it leaves as it is. False
   * when another writer holds it: nothing may be written.
   */
  holdSticky(sessionId: string, key: string): boolean {
    const pane = this.entry(sessionId);
    if (pane.grant) {
      if (pane.grant.holder.key !== key) return false;
      if (pane.grant.sticky) this.arm(sessionId, pane.grant, PANE_LOCK_STICKY_MS);
      return true;
    }
    if (pane.waiters.length > 0) return false;
    this.grant(sessionId, pane, { key }, true);
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

  private grant(sessionId: string, pane: PaneEntry, holder: PaneLockHolder, sticky = false): string {
    if (pane.grant?.timer) clearTimeout(pane.grant.timer);
    const grant: Grant = { token: randomUUID(), holder, sticky, timer: null };
    pane.grant = grant;
    this.arm(sessionId, grant, sticky ? PANE_LOCK_STICKY_MS : this.leaseMs);
    return grant.token;
  }

  /** (Re)start the grant's lease: it is reclaimed once `ms` pass with no renewal. */
  private arm(sessionId: string, grant: Grant, ms: number): void {
    if (grant.timer) clearTimeout(grant.timer);
    grant.timer = setTimeout(() => {
      const pane = this.panes.get(sessionId);
      if (pane?.grant !== grant) return;
      if (!grant.sticky) this.log(`[pane-lock] session=${sessionId} hold by ${grant.holder.key} reclaimed after ${ms} ms with no write`);
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

/** The session pipe's input high-water mark: past it a pane takes no more input. */
export const PANE_INPUT_HIGH_WATER = 6 * 1024 * 1024;

/**
 * One write into a pane's PTY adapter, as the session pipe's input makes it:
 * refused, with nothing written, past the high-water mark or on the adapter's
 * backpressure.
 */
export function admitPaneInput(pendingInputBytes: number | undefined, write: () => void): boolean {
  if ((pendingInputBytes ?? 0) >= PANE_INPUT_HIGH_WATER) return false;
  try {
    write();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PTY_BACKPRESSURE')) return false;
    throw error;
  }
  return true;
}

/**
 * main's write under the pane's lock (`daemon.session.writeHeldV1`): the
 * hold is checked and the bytes written in one synchronous step, and noted
 * exactly as the session pipe's input is. Nothing is written past the
 * high-water mark, on the adapter's backpressure, or for a write longer than
 * one held-write chunk (main splits a long paste).
 */
export function writeUnderLock(
  locks: PaneDeliveryLocks,
  sessionId: string,
  token: string,
  clientId: string,
  target: HeldWriteTarget | undefined,
  data: string,
): { ok: true } | { ok: false; error: 'no session' | 'not held' | 'backpressure' | 'too large' } {
  if (!target) return { ok: false, error: 'no session' };
  // Nothing to write renews nothing: only a write keeps a hold alive.
  if (!locks.holds(sessionId, token, clientId, data.length > 0)) return { ok: false, error: 'not held' };
  if (!data) return { ok: true };
  if (data.length > HELD_WRITE_CHUNK_MAX) return { ok: false, error: 'too large' };
  if (!admitPaneInput(target.pendingInputBytes, () => target.write(data))) return { ok: false, error: 'backpressure' };
  target.noteInput(data);
  locks.onHeldWrite?.(sessionId);
  return { ok: true };
}
