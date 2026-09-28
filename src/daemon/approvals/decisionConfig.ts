// Kill switch for the phone decision channels (daemon config `phoneDecisions`).
//
// Both default ON. Turning one off sends the records it would have carried to
// the `none` channel instead: an informational card and the existing decline
// path, which is exactly what a daemon without the channel serves.

export interface PhoneDecisionsConfig {
  /** Answers through the agent's own server (OpenCode plugin, Codex relay). */
  native: boolean;
  /** Multi-key answers typed behind the screen and revision fences. */
  stepwise: boolean;
}

/**
 * Per-field backfill, same discipline as `coerceGate`: only an explicit
 * `false` turns a channel off; absent or malformed reads as the default.
 */
export function coercePhoneDecisions(raw: unknown): PhoneDecisionsConfig {
  const slice = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return { native: slice['native'] !== false, stepwise: slice['stepwise'] !== false };
}
