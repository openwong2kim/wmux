// ─── Quota-aware account choice, shared by every provider ───────────────────
//
// One model for "which account should this launch run on": each account
// reports quota windows (fraction left, reset time); an account whose window
// is spent is skipped until it resets; the launch keeps its current account
// while that one has quota and otherwise moves to the account with the most
// left. When none has quota the launch is held, never retried in a loop.
//
// Providers feed it from their own source — Claude from the per-account
// usage API, Codex from the limits it records in each account's session
// files. Pure: no I/O, the caller passes the clock.

export type QuotaProvider = 'claude' | 'codex' | 'agy';

export interface QuotaWindowReading {
  /** Fraction of the window still available, 0..1. */
  remaining: number;
  /** Epoch ms when the window resets; null when unknown. */
  resetAtMs: number | null;
}

export interface AccountQuotaReading {
  windows: QuotaWindowReading[];
  /** When the reading was taken (epoch ms). */
  capturedAtMs: number;
}

export interface QuotaVerdict {
  usable: boolean;
  /** Lowest remaining fraction across the windows; null when unknown. */
  remaining: number | null;
  /** Epoch ms the account is usable again; null when usable or unknown. */
  availableAtMs: number | null;
}

/** At or below this the window counts as spent (a hair above zero so a
 *  launch does not land on the last request of a window). */
export const QUOTA_FLOOR = 0.02;
/** How long a spent window with no reset time blocks, from the reading. */
export const UNKNOWN_RESET_BLOCK_MS = 5 * 60 * 60 * 1000;

export function evaluateQuota(reading: AccountQuotaReading | null, now: number, floor = QUOTA_FLOOR): QuotaVerdict {
  if (!reading || reading.windows.length === 0) return { usable: true, remaining: null, availableAtMs: null };
  let remaining: number | null = null;
  let blockedUntil: number | null = null;
  for (const w of reading.windows) {
    if (!Number.isFinite(w.remaining)) continue;
    const refilled = w.resetAtMs !== null && w.resetAtMs <= now;
    const left = refilled ? 1 : Math.max(0, Math.min(1, w.remaining));
    remaining = remaining === null ? left : Math.min(remaining, left);
    if (!refilled && left <= floor) {
      const until = w.resetAtMs ?? reading.capturedAtMs + UNKNOWN_RESET_BLOCK_MS;
      blockedUntil = blockedUntil === null ? until : Math.max(blockedUntil, until);
    }
  }
  if (blockedUntil !== null && blockedUntil > now) return { usable: false, remaining, availableAtMs: blockedUntil };
  return { usable: true, remaining, availableAtMs: null };
}

export interface QuotaCandidate {
  id: string;
  verdict: QuotaVerdict;
  /** The account this launch would use without rotation. */
  current: boolean;
}

export type QuotaChoice =
  | { kind: 'keep'; id: string | null }
  | { kind: 'switch'; id: string }
  | { kind: 'hold'; availableAtMs: number | null };

/**
 * Keep the current account while it has quota; else the usable account with
 * the most left (unknown ranks below any measured value); else hold with the
 * earliest time one frees up. No candidates → keep (nothing to rotate).
 */
export function chooseByQuota(candidates: readonly QuotaCandidate[]): QuotaChoice {
  if (candidates.length === 0) return { kind: 'keep', id: null };
  const current = candidates.find((c) => c.current);
  if (current?.verdict.usable) return { kind: 'keep', id: current.id };
  const usable = candidates.filter((c) => c.verdict.usable);
  if (usable.length === 0) {
    const times = candidates.map((c) => c.verdict.availableAtMs).filter((t): t is number => t !== null);
    return { kind: 'hold', availableAtMs: times.length > 0 ? Math.min(...times) : null };
  }
  const best = [...usable].sort((a, b) => (b.verdict.remaining ?? -1) - (a.verdict.remaining ?? -1))[0];
  return { kind: 'switch', id: best.id };
}

/** First token of a typed launch line, as a lower-case stem (`claude`, `codex`, `agy`). */
export function launchStem(command: string | undefined): string {
  if (!command) return '';
  const first = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const token = first ? (first[1] ?? first[2] ?? first[3] ?? '') : '';
  return token.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '') ?? '';
}

/** Text a held launch prints instead of starting the agent. Shell-neutral. */
export function heldLaunchNotice(provider: QuotaProvider, availableAtMs: number | null): string {
  const when = availableAtMs ? ` The first one frees up at ${new Date(availableAtMs).toLocaleString()}.` : '';
  return `echo "wmux: ${provider} was not started - every registered ${provider} account is out of quota.${when}"`;
}
