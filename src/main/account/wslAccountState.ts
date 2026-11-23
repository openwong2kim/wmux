// ─── A WSL account home's sign-in and usage, per distro and Linux user ───────
//
// A registered account runs in a WSL pane on its own home in the distro
// (shared/wslAccountHome.ts). That home is signed in inside the distro, maybe
// to another login than the account's Windows folder, so nothing measured on
// the Windows side says anything about it, and nothing measured there is
// mixed into the Windows entry (AccountUsageService).
//
// This store is the one source of truth for such a home: keyed (account,
// distro, user), since the home is /home/<user>/.wmux<suffix>/accounts/…
// It is written only by:
//   - a usage sample from a live WSL pane whose own env and user give that
//     home (usage.rpc.ts): the READING, stamped when it arrived;
//   - a hook from a WSL claude whose transcript lies under that home's
//     projects/ (a turn that failed on its sign-in, or one that worked): the
//     SIGN-IN evidence.
// It never asks the distro anything, never reads its files, and so never
// boots a stopped one. Readings are mirrored into the usage trail under the
// same key, which seeds them after a restart.
//
// Accepted: a local process holding main's pipe token could forge a sample
// (as for any pane); the boundary against another OS user is a separate design.

import { createHash } from 'node:crypto';
import type { UsageSnapshot } from '../claude/UsageApi';
import { mergeLive, type UsageUpdate } from '../claude/usageMerge';
import type { AccountQuotaReading } from '../../shared/accountQuota';

/** Where a WSL launch or pane runs: its distro and Linux user. */
export interface WslPlace {
  distribution: string;
  user: string;
}

/** The usage trail's and the reserve's key cap (usageReserveHolds.ts, usage.rpc.ts). */
export const MAX_WSL_STATE_KEY_LEN = 128;

/** A candidate's reading must be this fresh to be switched to (AccountRotationService's age). */
export const WSL_CANDIDATE_MAX_AGE_MS = 10 * 60 * 1000;

const KEY_MARK = '@wsl:';

/** Distro names compare as the daemon's target.distribution does: any case. */
function placeHash(place: WslPlace): string {
  return createHash('sha256').update(`${place.distribution.toLowerCase()}\0${place.user}`).digest('hex').slice(0, 16);
}

/** `<accountId>@wsl:<16 hex of distro and user>`, or null when it would pass the key cap. */
export function wslStateKey(accountId: string, place: WslPlace): string | null {
  const key = `${accountId}${KEY_MARK}${placeHash(place)}`;
  return key.length <= MAX_WSL_STATE_KEY_LEN ? key : null;
}

/** Whether a usage-trail key is one of this store's. */
export function isWslStateKey(key: string): boolean {
  return /@wsl:[0-9a-f]{16}$/.test(key);
}

export interface WslAccountEntry {
  snapshot: UsageSnapshot | null;
  /** When the last sample ARRIVED (not the window it describes). */
  sampleAtMs: number | null;
  /** Last sign-in evidence: true after a turn worked, false after one failed on its sign-in. */
  signedIn: boolean | null;
}

export class WslAccountState {
  private readonly entries = new Map<string, WslAccountEntry>();
  /** Where a plain WSL pane last started, by the distro it asked for
   *  (lowercased; '' for wsl.exe's default distro). */
  private readonly defaultPlaces = new Map<string, WslPlace>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* a listener never breaks a write */ }
    }
  }

  private entry(key: string): WslAccountEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { snapshot: null, sampleAtMs: null, signedIn: null };
      this.entries.set(key, e);
    }
    return e;
  }

  /** A usage sample from a live pane on this home. Returns the merged snapshot to mirror, or null. */
  noteSample(accountId: string, place: WslPlace, update: UsageUpdate): UsageSnapshot | null {
    const key = wslStateKey(accountId, place);
    if (!key) return null;
    const e = this.entry(key);
    const merged = mergeLive(e.snapshot, update, this.now());
    // Arrival is what makes a reading fresh, even when the numbers did not move.
    e.sampleAtMs = this.now();
    if (merged) e.snapshot = merged;
    this.changed();
    return merged ?? e.snapshot;
  }

  /** Sign-in evidence from a hook whose transcript lies under this home. */
  noteAuth(accountId: string, place: WslPlace, signedIn: boolean): void {
    const key = wslStateKey(accountId, place);
    if (!key) return;
    this.entry(key).signedIn = signedIn;
    this.changed();
  }

  /** After a restart: the last mirrored reading of a key, when nothing newer is held. */
  seed(key: string, snapshot: UsageSnapshot, atMs: number): void {
    if (!isWslStateKey(key) || key.length > MAX_WSL_STATE_KEY_LEN) return;
    const e = this.entry(key);
    if (e.sampleAtMs !== null && e.sampleAtMs >= atMs) return;
    e.snapshot = snapshot;
    e.sampleAtMs = atMs;
    this.changed();
  }

  get(accountId: string, place: WslPlace): WslAccountEntry | undefined {
    const key = wslStateKey(accountId, place);
    return key ? this.entries.get(key) : undefined;
  }

  /** Every held entry by key, for the usage reserve and the trail. */
  all(): Array<[string, WslAccountEntry]> {
    return [...this.entries];
  }

  /** A plain WSL pane (no target of its own) that asked for `requested` started at `place`. */
  noteDefaultPlace(requested: string | null, place: WslPlace): void {
    this.defaultPlaces.set((requested ?? '').toLowerCase(), place);
  }

  /** Where a plain pane asking for `requested` starts, when one was seen since main started. */
  defaultPlace(requested: string | null): WslPlace | undefined {
    return this.defaultPlaces.get((requested ?? '').toLowerCase());
  }

  /**
   * The quota reading of this home for a launch decision. The BOUND account's
   * is used at any age: once its reset passes, evaluateQuota counts the
   * window as refilled, and samples stop when claude is closed. A switch
   * CANDIDATE needs one that arrived within WSL_CANDIDATE_MAX_AGE_MS.
   */
  reading(accountId: string, place: WslPlace, role: 'bound' | 'candidate'): AccountQuotaReading | null {
    const e = this.get(accountId, place);
    const s = e?.snapshot;
    if (!e || !s || e.sampleAtMs === null) return null;
    if (role === 'candidate' && this.now() - e.sampleAtMs > WSL_CANDIDATE_MAX_AGE_MS) return null;
    const win = (pct: number | undefined, resetSec = 0) => (pct === undefined ? [] : [{
      remaining: 1 - Math.max(0, Math.min(100, pct)) / 100,
      resetAtMs: resetSec > 0 ? resetSec * 1000 : null,
    }]);
    return { windows: [...win(s.sessionPct, s.sessionResetEpochSec), ...win(s.weeklyPct, s.weeklyResetEpochSec)], capturedAtMs: e.sampleAtMs };
  }
}

let instance: WslAccountState | null = null;

export function getWslAccountState(): WslAccountState {
  if (!instance) instance = new WslAccountState();
  return instance;
}
