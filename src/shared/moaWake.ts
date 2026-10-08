// ─── Wake Moa from the phone — the daemon ↔ main contract ────────────────────
//
// `/api/config` names the Moa pane only once its brain TUI runs, and main
// starts that brain lazily on the first turn. A phone that wants to talk to
// Moa before anyone typed on the desktop sends its first message through the
// desktop bridge as `moa.wake`; main runs it as an ordinary human turn.
//
// Main answers on ACCEPT, never on turn end: a cold start takes longer than
// the bridge's 15 s request timeout. Refusals are results, never throws, so
// the daemon can tell "main said no" from "nothing came back".

/** The optional desktop-bridge command main announces at register. */
export const MOA_WAKE_COMMAND = 'moa.wake';

export type MoaWakeRefusalCode =
  | 'moa_off' | 'mode_off' | 'not_hq' | 'hq_missing' | 'hq_unknown'
  | 'unsupported_vendor' | 'busy' | 'duplicate';

export type MoaWakeResult =
  | { ok: true; accepted: true }
  | { ok: false; code: MoaWakeRefusalCode };

/** Failures main learns only after it accepted, reported over `daemon.moa.wakeResult`. */
export type MoaWakeFailure = 'tui-dialog' | 'spawn-failed';

/** What the daemon sends with `moa.wake`. `actor` is the daemon's chat owner for the caller. */
export interface MoaWakePayload {
  clientMessageId: string;
  text: string;
  actor: string;
  /** Display only; the daemon already authenticated the caller. */
  deviceId?: string;
}

const REFUSAL_CODES: ReadonlySet<string> = new Set<MoaWakeRefusalCode>([
  'moa_off', 'mode_off', 'not_hq', 'hq_missing', 'hq_unknown', 'unsupported_vendor', 'busy', 'duplicate',
]);

/** Main's answer, or null for any shape outside the contract (the daemon reads that as uncertain). */
export function parseMoaWakeResult(raw: unknown): MoaWakeResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.ok === true && r.accepted === true) return { ok: true, accepted: true };
  if (r.ok === false && typeof r.code === 'string' && REFUSAL_CODES.has(r.code)) {
    return { ok: false, code: r.code as MoaWakeRefusalCode };
  }
  return null;
}

export function isMoaWakeFailure(value: unknown): value is MoaWakeFailure {
  return value === 'tui-dialog' || value === 'spawn-failed';
}
