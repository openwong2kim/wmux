// ─── Fan-out account pool: the settings and the pick (pure) ─────────────────
//
// With the pool on, each Claude fan-out worker launches on one account of a
// pool (registered Claude accounts of one group, plus the default login when
// the settings include it) instead of every worker sharing the default login.
// The pick ranks the usable accounts by quota band first (the share left,
// bucketed by `quotaBandPct`), then by how few open workers already run on
// each, then by id, so a fan-out spreads over the accounts with the most
// left. Off by default; main never reads anything for it while it is off
// (main/worktask/fanoutAccountPool.ts).

import type { QuotaVerdict } from './accountQuota';

/** The default login's key in the pool, in launch records and in the usage
 *  reserve (the key usageReserve.ts holdFor reads). */
export const POOL_DEFAULT_ACCOUNT = 'default';

export const FANOUT_ACCOUNT_POOL_FILENAME = 'fanout-account-pool.json';

export interface FanoutAccountPoolSettings {
  enabled: boolean;
  /** The default login (no CLAUDE_CONFIG_DIR) is one of the pool's accounts. */
  includeDefaultLogin: boolean;
  /** The group an unbound caller's workers pick from; null = the ungrouped
   *  accounts. A caller bound to an account always picks in that one's group. */
  group: string | null;
  /** Width of a quota band, in percent of the window left (1..100). */
  quotaBandPct: number;
  /** Open workers one account takes at most; 0 = no limit. */
  maxWorkersPerAccount: number;
}

export const DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS: Readonly<FanoutAccountPoolSettings> = Object.freeze({
  enabled: false,
  includeDefaultLogin: true,
  group: null,
  quotaBandPct: 10,
  maxWorkersPerAccount: 0,
});

const MAX_WORKERS_PER_ACCOUNT = 100;

function intIn(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

/** The settings a file (or a Settings write) holds, each field checked on its
 *  own: a bad field takes its default, never the others'. Pure. */
export function normalizeFanoutAccountPoolSettings(raw: unknown): FanoutAccountPoolSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const d = DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS;
  const group = typeof o.group === 'string' && o.group.trim().length > 0 && o.group.length <= 40 ? o.group.trim() : null;
  return {
    enabled: o.enabled === true,
    includeDefaultLogin: typeof o.includeDefaultLogin === 'boolean' ? o.includeDefaultLogin : d.includeDefaultLogin,
    group,
    quotaBandPct: intIn(o.quotaBandPct, 1, 100, d.quotaBandPct),
    maxWorkersPerAccount: intIn(o.maxWorkersPerAccount, 0, MAX_WORKERS_PER_ACCOUNT, d.maxWorkersPerAccount),
  };
}

/** The group the pool picks in: the caller's bound account's, else the
 *  setting's ('' = the ungrouped accounts). Groups are never crossed. Pure. */
export function poolGroupFor(boundGroup: string | null, settings: Pick<FanoutAccountPoolSettings, 'group'>): string {
  return boundGroup ?? settings.group ?? '';
}

/** Whether the default login is one of the pool's accounts for a pick in
 *  `group`: it belongs to no named group, so only the ungrouped pool takes it. Pure. */
export function poolIncludesDefaultLogin(group: string, settings: Pick<FanoutAccountPoolSettings, 'includeDefaultLogin'>): boolean {
  return settings.includeDefaultLogin && group === '';
}

export interface PoolCandidate {
  /** An account id, or POOL_DEFAULT_ACCOUNT. */
  id: string;
  /** Its quota now; `remaining: null` = not measured. */
  verdict: QuotaVerdict;
  /** The usage reserve holds it until then (ms), or null. */
  heldUntilMs: number | null;
  /** Open workers already on it. */
  open: number;
}

export type PoolPick =
  | { kind: 'pick'; accountId: string }
  /** Nothing usable: `availableAtMs` is the earliest time one frees up (a
   *  reserve hold or a spent window ending), null when unknown. */
  | { kind: 'none'; reason: 'empty' | 'held' | 'quota' | 'full'; availableAtMs: number | null };

/** A candidate's band: floor(percent left / band width). Not measured ranks
 *  below the lowest measured usable band. */
export function quotaBand(verdict: QuotaVerdict, bandPct: number): number {
  if (verdict.remaining === null) return -1;
  return Math.floor((Math.max(0, Math.min(1, verdict.remaining)) * 100) / Math.max(1, bandPct));
}

/**
 * The account a worker launches on: of the candidates that are usable, not
 * held by the reserve and under the per-account limit, the highest quota
 * band, then the fewest open workers, then the lowest id. Pure.
 */
export function pickPoolAccount(candidates: readonly PoolCandidate[], settings: Pick<FanoutAccountPoolSettings, 'quotaBandPct' | 'maxWorkersPerAccount'>): PoolPick {
  if (candidates.length === 0) return { kind: 'none', reason: 'empty', availableAtMs: null };
  const usable = candidates.filter((c) => c.verdict.usable);
  const free = usable.filter((c) => c.heldUntilMs === null);
  const room = free.filter((c) => settings.maxWorkersPerAccount <= 0 || c.open < settings.maxWorkersPerAccount);
  if (room.length === 0) {
    // Each account is free once every one of its blockers ends: its spent
    // window and its reserve hold, whichever ends later.
    const times = candidates
      .map((c) => {
        const blockers = [c.verdict.usable ? null : c.verdict.availableAtMs, c.heldUntilMs].filter((t): t is number => t !== null);
        return blockers.length > 0 ? Math.max(...blockers) : null;
      })
      .filter((t): t is number => t !== null);
    const availableAtMs = times.length > 0 ? Math.min(...times) : null;
    const reason = free.length > 0 ? 'full' : usable.length > 0 ? 'held' : 'quota';
    return { kind: 'none', reason, availableAtMs: reason === 'full' ? null : availableAtMs };
  }
  const best = [...room].sort((a, b) =>
    quotaBand(b.verdict, settings.quotaBandPct) - quotaBand(a.verdict, settings.quotaBandPct)
    || a.open - b.open
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return { kind: 'pick', accountId: best.id };
}

/** Why a worker did not launch on the pool, for the calling agent to relay. Pure. */
export function poolRefusalText(pick: Extract<PoolPick, { kind: 'none' }>, nowMs: number): string {
  const when = pick.availableAtMs !== null && pick.availableAtMs > nowMs ? ` The first one frees up at ${new Date(pick.availableAtMs).toISOString()}.` : '';
  switch (pick.reason) {
    case 'empty': return 'fan-out account pool: no account of the pool can run a worker (none is signed in in its own folder, or its hooks are out of date).';
    case 'held': return `fan-out account pool: every account of the pool is in the usage reserve the person keeps.${when}`;
    case 'quota': return `fan-out account pool: every account of the pool is out of quota.${when}`;
    case 'full': return 'fan-out account pool: every account of the pool already runs its most workers.';
    default: return 'fan-out account pool: no account was picked.';
  }
}
