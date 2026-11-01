// Usage reserve: when the owner turns it on, unattended work keeps the last
// RESERVE_PCT of a Claude account's 5-hour window for the person. Scheduled
// runs, fan-out workers and bot workers do not START while the account's 5h
// usage is at or above the threshold; they wait for the window to reset.
// Nothing a person types is gated.
//
// Main decides, because the usage readings live here (the statusline push and
// the usage services, the same feed as the usage trail). The daemon only gets
// the resulting holds (account key → until when) for the scheduled runs it
// launches. Usage that is not known never holds anything.

import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import type { UsageSnapshot } from '../claude/UsageApi';
import { formatResetDuration } from '../../shared/usageLimit';
import { SAME_WINDOW_SLACK_SEC } from '../claude/usageMerge';

/** Share of the 5h window kept for the person. Fixed in v1. */
export const RESERVE_PCT = 15;
/** 5h usage at or above this holds unattended starts. */
export const RESERVE_THRESHOLD_PCT = 100 - RESERVE_PCT;

export const USAGE_RESERVE_FILENAME = 'usage-reserve.json';
/** A push the daemon did not take is sent again after this, at most PUSH_RETRY_MAX times in a row. */
export const PUSH_RETRY_MS = 30 * 1000;
export const PUSH_RETRY_MAX = 10;
/** Two resets this close are one window (the usage sources round differently). */
const SAME_RESET_MS = SAME_WINDOW_SLACK_SEC * 1000;

/** One account's hold: its usage key ('default' or an account id) and when its 5h window resets (ms). */
export interface UsageReserveHold {
  account: string;
  untilMs: number;
}

/** When unattended starts on this reading may resume (the 5h reset, ms), or
 *  null when the reading does not hold them: no reading, no 5h window, an
 *  unknown or passed reset, or usage under the threshold. */
export function reserveUntilMs(snapshot: UsageSnapshot | null, nowMs: number): number | null {
  const resetSec = snapshot?.sessionResetEpochSec ?? 0;
  if (snapshot?.sessionPct === undefined || resetSec <= 0) return null;
  const resetMs = resetSec * 1000;
  if (resetMs <= nowMs) return null;
  return snapshot.sessionPct >= RESERVE_THRESHOLD_PCT ? resetMs : null;
}

export interface UsageReserveDeps {
  wmuxDir: string;
  /** Every usage reading main holds, keyed 'default' or by account id. */
  snapshots: () => Array<[string, UsageSnapshot | null]>;
  /** The usage key a workspace's Claude launches run on. */
  accountOfWorkspace: (workspaceId: string) => string;
  /** Hand the current holds to the daemon (its scheduled runs). Resolves
   *  false when they were not delivered: they are sent again. */
  push?: (holds: UsageReserveHold[]) => Promise<boolean> | void;
  /** Tell the owner once per hold. */
  notify?: (account: string, untilMs: number) => void;
  /** The setting changed (on or off). */
  onSettingChange?: (on: boolean) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export class UsageReserve {
  private readonly filePath: string;
  private readonly now: () => number;
  private on: boolean | null = null;
  /**
   * The last hold seen per account, kept on disk. An account with no reading
   * yet (main just started; readings live in memory) keeps it until its
   * reset, so a relaunch never clears a hold the daemon holds.
   */
  private readonly known = new Map<string, number>();
  private savedKnown = '[]';
  /** The holds last pushed, as JSON: none until a connect pushes them. */
  private lastPushed = '[]';
  /** The reset each account's owner was last told about. */
  private readonly told = new Map<string, number>();
  private writes: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failedPushes = 0;

  constructor(private readonly deps: UsageReserveDeps) {
    this.filePath = path.join(deps.wmuxDir, USAGE_RESERVE_FILENAME);
    this.now = deps.now ?? Date.now;
  }

  enabled(): boolean {
    if (this.on === null) {
      this.on = false;
      try {
        const file = atomicReadJSONSync<{ enabled?: unknown; holds?: unknown }>(this.filePath);
        this.on = file?.enabled === true;
        for (const h of Array.isArray(file?.holds) ? file.holds : []) {
          const { account, untilMs } = (h ?? {}) as Record<string, unknown>;
          if (typeof account === 'string' && account && typeof untilMs === 'number' && Number.isFinite(untilMs)) this.known.set(account, untilMs);
        }
        this.savedKnown = this.knownJson();
      } catch {
        /* off, nothing known */
      }
    }
    return this.on;
  }

  setEnabled(on: boolean): Promise<void> {
    this.enabled();
    const write = this.writes.then(async () => {
      await atomicWriteJSON(this.filePath, { enabled: on, holds: this.knownList() });
      this.on = on;
      this.deps.onSettingChange?.(on);
      this.refresh();
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  /** The hold on one usage key, or null. */
  holdFor(account: string): UsageReserveHold | null {
    if (!this.enabled()) return null;
    const now = this.now();
    const snapshot = this.deps.snapshots().find(([key]) => key === account)?.[1] ?? null;
    const untilMs = snapshot ? reserveUntilMs(snapshot, now) : this.carried(account, now);
    return untilMs === null ? null : { account, untilMs };
  }

  /** A hold seen before for an account with no reading now, while its reset is ahead. */
  private carried(account: string, now: number): number | null {
    const until = this.known.get(account);
    return until !== undefined && until > now ? until : null;
  }

  private knownList(): UsageReserveHold[] {
    return [...this.known].map(([account, untilMs]) => ({ account, untilMs })).sort((a, b) => a.account.localeCompare(b.account));
  }

  private knownJson(): string {
    return JSON.stringify(this.knownList());
  }

  /** The hold on the account a workspace's launches run on, or null. */
  holdForWorkspace(workspaceId: string): UsageReserveHold | null {
    return this.holdFor(this.deps.accountOfWorkspace(workspaceId));
  }

  holds(): UsageReserveHold[] {
    if (!this.enabled()) return [];
    const now = this.now();
    const out: UsageReserveHold[] = [];
    const read = new Set<string>();
    for (const [account, snapshot] of this.deps.snapshots()) {
      if (!snapshot) continue;
      read.add(account);
      const untilMs = reserveUntilMs(snapshot, now);
      if (untilMs !== null) {
        out.push({ account, untilMs });
        this.known.set(account, untilMs);
      } else {
        this.known.delete(account);
      }
    }
    for (const [account, untilMs] of this.known) {
      if (untilMs <= now) this.known.delete(account);
      else if (!read.has(account)) out.push({ account, untilMs });
    }
    return out.sort((a, b) => a.account.localeCompare(b.account));
  }

  /** Re-read the holds after a usage or setting change; push them when they changed. */
  refresh(): void {
    const holds = this.holds();
    this.saveKnown();
    const key = JSON.stringify(holds);
    if (key === this.lastPushed) return;
    this.lastPushed = key;
    void this.send(holds, key);
  }

  private async send(holds: UsageReserveHold[], key: string): Promise<void> {
    let delivered = false;
    try {
      delivered = (await this.deps.push?.(holds)) !== false;
    } catch {
      delivered = false;
    }
    if (delivered) this.failedPushes = 0;
    if (delivered || this.lastPushed !== key) return;
    // Not taken (no daemon, or it refused): forget it so it is sent again,
    // a bounded number of times (an older daemon never takes it).
    this.lastPushed = '';
    if (++this.failedPushes >= PUSH_RETRY_MAX) {
      if (this.failedPushes === PUSH_RETRY_MAX) this.deps.log?.('[usageReserve] the daemon is not taking the holds; trying again on the next change or connect');
      return;
    }
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.refresh();
    }, PUSH_RETRY_MS);
    this.retryTimer.unref?.();
  }

  /** Push the holds whatever was pushed before (the daemon (re)connected). */
  pushNow(): void {
    this.lastPushed = '';
    this.failedPushes = 0;
    this.refresh();
  }

  /** Keep the last holds on disk when they changed (rare: a hold starts or ends). */
  private saveKnown(): void {
    const json = this.knownJson();
    if (json === this.savedKnown) return;
    this.savedKnown = json;
    const holds = this.knownList();
    const write = this.writes.then(() => atomicWriteJSON(this.filePath, { enabled: this.on === true, holds }));
    this.writes = write.catch((err) => {
      // Not on disk: the next refresh writes it again (unless a newer one is queued).
      if (this.savedKnown === json) this.savedKnown = '';
      this.deps.log?.(`[usageReserve] holds not saved: ${String(err)}`);
    });
  }

  /** Something unattended was held: tell the owner, once per hold. */
  noteHeld(account: string, untilMs: number): void {
    const told = this.told.get(account);
    // The same window, as another source rounds its reset: already told.
    if (told !== undefined && Math.abs(told - untilMs) <= SAME_RESET_MS) return;
    this.told.set(account, untilMs);
    try {
      this.deps.notify?.(account, untilMs);
    } catch (err) {
      this.deps.log?.(`[usageReserve] notice failed: ${String(err)}`);
    }
  }
}

let instance: UsageReserve | null = null;

export function setUsageReserve(next: UsageReserve | null): void {
  instance = next;
}

/** The running reserve's hold for a workspace's launches, or null (no reserve, or not held). */
export function usageReserveHoldForWorkspace(workspaceId: string): UsageReserveHold | null {
  try {
    return instance?.holdForWorkspace(workspaceId) ?? null;
  } catch {
    return null;
  }
}

export function noteUsageReserveHeld(hold: UsageReserveHold): void {
  instance?.noteHeld(hold.account, hold.untilMs);
}

/** Why a fan-out did not start, for the calling agent to relay. `held`: a
 *  bot's request kept for after the reset. */
export function usageReserveRefusalText(untilMs: number, nowMs: number, held: boolean): string {
  const resets = `${new Date(untilMs).toISOString()} (in ${formatResetDuration(untilMs - nowMs)})`;
  const outcome = held
    ? `the request is held and this bot is woken with it after the window resets at ${resets}`
    : `start them after the window resets at ${resets}`;
  return `usage reserve: this account's 5-hour usage is in its last ${RESERVE_PCT}%, which the person keeps for their own work, `
    + `and fan-out workers run unattended, so none were started; ${outcome}. `
    + 'The person can turn the reserve off in Settings > Claude integration > Usage reserve.';
}
