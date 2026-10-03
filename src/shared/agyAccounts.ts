// ─── Antigravity CLI (agy) accounts — shared types + quota-aware selection ───
//
// agy keeps its Google sign-in in ONE machine-wide Windows Credential Manager
// slot (`gemini:antigravity`); HOME / USERPROFILE do not partition it (verified
// 2026-10-02, agy 1.2.14: a fresh home still ran on the signed-in account). So
// wmux supports several agy accounts by keeping a vault copy of each account's
// credential and swapping the active slot before it launches agy. Only one agy
// account is ACTIVE at a time, machine-wide.
//
// Quota per account comes from the statusLine sensor: its payload carries the
// signed-in `email`, so `quota-sink.js` files each snapshot under that
// account's key. This module holds the pure part: is an account usable right
// now, and which account should the next agy launch use. No I/O here — the
// main-side service feeds it snapshots and the clock.

/** One quota bucket as the sensor stores it (agy statusLine `quota.<bucket>`). */
export interface AgyQuotaBucket {
  remaining_fraction?: number;
  reset_time?: string;
}

/** The per-account snapshot `quota-sink.js` writes. */
export interface AgyAccountQuotaSnapshot {
  quota?: Record<string, AgyQuotaBucket>;
  quotaCapturedAtMs?: number;
  plan_tier?: string;
}

/** A registered agy account. Secrets never live here — only in the vault. */
export interface AgyAccount {
  id: string;
  /** Google account email, from the id_token's `email` claim. */
  email: string;
  /** Optional label the user gave it ("Mãe", "Pessoal"). */
  label: string;
  addedAt: number;
  /** Set when agy rejected the stored credential; cleared by a fresh sign-in. */
  needsReauth?: boolean;
}

export type AgyAccountState = 'active' | 'ready' | 'exhausted' | 'needs-reauth';

export interface AgyAccountRow extends AgyAccount {
  state: AgyAccountState;
  active: boolean;
  /** Lowest remaining fraction across the buckets that gate a launch (0..1), null when unknown. */
  remaining: number | null;
  /** Epoch ms the account becomes usable again, when it is exhausted. */
  availableAtMs: number | null;
  quota: AgyAccountQuotaSnapshot | null;
}

export interface AgyAccountsSnapshot {
  supported: boolean;
  autoRotate: boolean;
  activeEmail: string | null;
  accounts: AgyAccountRow[];
}

export type AgyLaunchDecision =
  | { ok: true; account: AgyAccount | null; switched: boolean }
  | { ok: false; reason: 'all-exhausted'; availableAtMs: number | null };

/** Buckets that gate an agy launch. agy reports both a 5-hour and a weekly
 *  window per model family; the Gemini family is what agy runs by default, the
 *  `3p-*` buckets (third-party models) are checked only when reported. */
export const AGY_GATING_BUCKETS: readonly string[] = ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'];

/** At or below this remaining fraction an account counts as out of quota. A
 *  hair above zero so a launch does not land on the last request of a window
 *  and fail mid-turn. */
export const AGY_QUOTA_FLOOR = 0.02;

/** Cooldown used when exhaustion is reported without a reset time. */
export const AGY_DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;

/** Normalize an email to the key the sensor and the vault both use. */
export function normalizeAgyEmail(email: string): string {
  return email.trim().toLowerCase();
}

function resetMs(bucket: AgyQuotaBucket): number | null {
  if (typeof bucket.reset_time !== 'string') return null;
  const t = Date.parse(bucket.reset_time);
  return Number.isFinite(t) ? t : null;
}

/**
 * Quota verdict for one snapshot at `now`. A bucket at or below the floor
 * blocks until its reset time; a bucket whose reset time has passed counts as
 * refilled even though the stored fraction is stale (quota only recovers over
 * time, so a stale snapshot is conservative).
 */
export function evaluateAgyQuota(
  snapshot: AgyAccountQuotaSnapshot | null,
  now: number,
  floor: number = AGY_QUOTA_FLOOR,
): { usable: boolean; remaining: number | null; availableAtMs: number | null } {
  const quota = snapshot?.quota;
  if (!quota || typeof quota !== 'object') return { usable: true, remaining: null, availableAtMs: null };
  let remaining: number | null = null;
  let blockedUntil: number | null = null;
  for (const name of AGY_GATING_BUCKETS) {
    const bucket = quota[name];
    if (!bucket || typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)) continue;
    const reset = resetMs(bucket);
    const refilled = reset !== null && reset <= now;
    const fraction = refilled ? 1 : bucket.remaining_fraction;
    remaining = remaining === null ? fraction : Math.min(remaining, fraction);
    if (!refilled && fraction <= floor) {
      // Unknown reset: block for the default window from the capture time.
      const until = reset ?? (snapshot?.quotaCapturedAtMs ?? now) + AGY_DEFAULT_COOLDOWN_MS;
      blockedUntil = blockedUntil === null ? until : Math.max(blockedUntil, until);
    }
  }
  if (blockedUntil !== null && blockedUntil > now) return { usable: false, remaining, availableAtMs: blockedUntil };
  return { usable: true, remaining, availableAtMs: null };
}

/** Full state of one account: reauth beats cooldown beats quota. */
export function agyAccountRow(
  account: AgyAccount,
  snapshot: AgyAccountQuotaSnapshot | null,
  activeEmail: string | null,
  now: number,
): AgyAccountRow {
  // Only the sensor snapshot marks an account out of quota. Pane text is not used: output that merely
  // mentions a quota error would otherwise lock a healthy account with nothing to lift it.
  const verdict = evaluateAgyQuota(snapshot, now);
  const availableAtMs = verdict.availableAtMs;
  const active = activeEmail !== null && normalizeAgyEmail(account.email) === activeEmail;
  let state: AgyAccountState;
  if (account.needsReauth) state = 'needs-reauth';
  else if (!verdict.usable) state = 'exhausted';
  else state = active ? 'active' : 'ready';
  return { ...account, state, active, remaining: verdict.remaining, availableAtMs, quota: snapshot };
}

/**
 * Pick the account the next agy launch runs on. The active account is kept
 * while it has quota — swapping the machine-wide slot under running agy
 * sessions is avoided unless it is needed. Otherwise the usable account with
 * the most remaining quota wins (unknown quota ranks below any known value, so
 * a never-measured account is tried only after measured ones). When none is
 * usable the decision says so and carries the earliest time one frees up —
 * the caller must stop there, never retry in a loop.
 */
export function chooseAgyAccount(rows: readonly AgyAccountRow[]): AgyLaunchDecision {
  if (rows.length === 0) return { ok: true, account: null, switched: false };
  const usable = rows.filter((r) => r.state === 'active' || r.state === 'ready');
  const active = usable.find((r) => r.active);
  if (active) return { ok: true, account: active, switched: false };
  if (usable.length === 0) {
    const times = rows
      .filter((r) => r.state === 'exhausted' && r.availableAtMs !== null)
      .map((r) => r.availableAtMs as number);
    return { ok: false, reason: 'all-exhausted', availableAtMs: times.length > 0 ? Math.min(...times) : null };
  }
  const ranked = [...usable].sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1));
  return { ok: true, account: ranked[0], switched: true };
}
