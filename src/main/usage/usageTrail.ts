// A bounded time series of each Claude account's 5h/7d usage, so a later view
// can draw the burn and a later reserve feature can read the rate.
//
// Fed only by readings wmux already holds (the statusline push and the usage
// services' snapshots); this module never asks for one. Keyed by 'default'
// (the default profile) or a registered account id.
//
// Sampling:
//   - a reading equal to the last sample is no change and is not written;
//   - within one window (reset inside the merge's same-window slack) usage
//     only grows, so a lower reading there is source lag: the higher value is
//     kept and nothing is appended for it;
//   - an edge (either reset moved past that slack) is always appended, so the
//     trail keeps the moment a window rolled over;
//   - otherwise, within TAIL_REPLACE_MS of the slot the tail opened, the new
//     reading replaces the tail instead of growing the list (≤12 per hour);
//   - the sample right after an edge always opens a new slot, so an edge is
//     never replaced.
// Retention is RETENTION_MS, with hard caps per key and on the number of keys.

import type { UsageSnapshot } from '../claude/UsageApi';
import { SAME_WINDOW_SLACK_SEC } from '../claude/usageMerge';

/** One reading. `t` is epoch ms; `s5`/`s7` are integer percent 0–100; `r5`/`r7`
 *  are the window resets in epoch seconds (0 = unknown, the snapshot's own
 *  convention). */
export interface UsageTrailSample {
  t: number;
  s5: number;
  r5: number;
  s7: number;
  r7: number;
}

export interface UsageTrailFile {
  v: 1;
  trails: Record<string, UsageTrailSample[]>;
}

export const TAIL_REPLACE_MS = 5 * 60 * 1000;
export const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export const MAX_SAMPLES_PER_KEY = 2400;
export const MAX_KEYS = 32;

function sameReset(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_WINDOW_SLACK_SEC;
}

function isPct(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}

function isEpoch(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function isUsageTrailSample(v: unknown): v is UsageTrailSample {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return isEpoch(s.t) && isPct(s.s5) && isEpoch(s.r5) && isPct(s.s7) && isEpoch(s.r7);
}

export function isUsageTrailFile(v: unknown): v is UsageTrailFile {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  return f.v === 1 && typeof f.trails === 'object' && f.trails !== null && !Array.isArray(f.trails);
}

export class UsageTrail {
  private readonly trails = new Map<string, UsageTrailSample[]>();
  /** When the tail's replace slot opened, per key. -Infinity means the next
   *  change appends (after an edge, and for every key loaded from disk). */
  private readonly slotAt = new Map<string, number>();

  /** Rebuild from a stored file, dropping malformed or future samples and
   *  anything past retention or the caps. */
  static fromFile(file: UsageTrailFile, nowMs: number): UsageTrail {
    const trail = new UsageTrail();
    for (const [key, list] of Object.entries(file.trails)) {
      if (!key || !Array.isArray(list)) continue;
      const samples = list.filter((s) => isUsageTrailSample(s) && s.t <= nowMs).sort((a, b) => a.t - b.t);
      if (samples.length > 0) trail.trails.set(key, samples);
    }
    trail.prune(nowMs);
    return trail;
  }

  /** Record a reading. Returns true when the trail changed. A null snapshot
   *  (no value yet) is not a change, nor is one without both windows: a
   *  sample holds both. */
  record(key: string, snapshot: UsageSnapshot | null, nowMs: number): boolean {
    if (!snapshot) return false;
    const { sessionPct: s5, sessionResetEpochSec: r5, weeklyPct: s7, weeklyResetEpochSec: r7 } = snapshot;
    if (s5 === undefined || r5 === undefined || s7 === undefined || r7 === undefined) return false;
    let list = this.trails.get(key);
    // Samples later than now were stamped by a clock that ran ahead and has
    // since been corrected; drop them so the trail stays in time order.
    const dropped = !!list && list.length > 0 && list[list.length - 1].t > nowMs;
    if (list && dropped) {
      while (list.length > 0 && list[list.length - 1].t > nowMs) list.pop();
      this.slotAt.delete(key);
    }
    const last = list?.[list.length - 1];
    const next: UsageTrailSample = { t: nowMs, s5, r5, s7, r7 };
    if (!isUsageTrailSample(next)) return false;
    if (last && sameReset(next.r5, last.r5)) next.s5 = Math.max(next.s5, last.s5);
    if (last && sameReset(next.r7, last.r7)) next.s7 = Math.max(next.s7, last.s7);
    const sameWindows = !!last && sameReset(next.r5, last.r5) && sameReset(next.r7, last.r7);
    if (last && sameWindows && last.s5 === next.s5 && last.s7 === next.s7) {
      if (dropped) this.pruneKey(key, list as UsageTrailSample[], nowMs);
      return dropped;
    }
    const edge = !!last && !sameWindows;
    if (!list) {
      list = [];
      this.trails.set(key, list);
    }
    const inSlot = nowMs - (this.slotAt.get(key) ?? -Infinity);
    if (last && !edge && inSlot >= 0 && inSlot < TAIL_REPLACE_MS) {
      list[list.length - 1] = next;
    } else {
      list.push(next);
      this.slotAt.set(key, edge ? -Infinity : nowMs);
    }
    this.pruneKey(key, list, nowMs);
    this.capKeys();
    return true;
  }

  /** Samples for one key with since ≤ t ≤ until, oldest first (a copy). */
  read(key: string, sinceMs = 0, untilMs = Number.MAX_SAFE_INTEGER): UsageTrailSample[] {
    const list = this.trails.get(key) ?? [];
    return list.filter((s) => s.t >= sinceMs && s.t <= untilMs).map((s) => ({ ...s }));
  }

  /** The file form, pruned first: a record() prunes only its own key. */
  toFile(nowMs: number): UsageTrailFile {
    this.prune(nowMs);
    return { v: 1, trails: Object.fromEntries(this.trails) };
  }

  private prune(nowMs: number): void {
    for (const [key, list] of this.trails) this.pruneKey(key, list, nowMs);
    this.capKeys();
  }

  private pruneKey(key: string, list: UsageTrailSample[], nowMs: number): void {
    const cutoff = nowMs - RETENTION_MS;
    let drop = 0;
    while (drop < list.length && list[drop].t < cutoff) drop++;
    drop = Math.max(drop, list.length - MAX_SAMPLES_PER_KEY);
    if (drop > 0) list.splice(0, drop);
    if (list.length === 0) this.forget(key);
  }

  private capKeys(): void {
    if (this.trails.size <= MAX_KEYS) return;
    // Over the key cap: the keys that went quiet longest go first.
    const byLastSeen = [...this.trails].sort((a, b) => a[1][a[1].length - 1].t - b[1][b[1].length - 1].t);
    for (const [key] of byLastSeen.slice(0, this.trails.size - MAX_KEYS)) this.forget(key);
  }

  private forget(key: string): void {
    this.trails.delete(key);
    this.slotAt.delete(key);
  }
}
