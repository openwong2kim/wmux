// Chat View composer gate — the METADATA_UPDATE half (plan PR-6, A1/A2/A8).
//
// Pure on purpose: this is the single most safety-relevant rule in the feature
// (a wrong unlock means injected bytes select an option in an arrow-key
// permission menu), and a rule buried inside a 900-line subscription effect
// cannot be tested. `useNotificationListener` owns the only call site.
//
// The AUTHORITATIVE gate is the daemon ApprovalRegistry, relayed on IPC.CHAT_GATE.
// What this function adds is the regex-sourced defense-in-depth half: allowed to
// LOCK, never trusted to unlock on its own evidence.

/** What one METADATA_UPDATE payload should do to `surfaceNeedsInput`. */
export type ComposerGateAction = 'lock' | 'unlock' | null;

export interface ComposerGateSignal {
  /** METADATA_UPDATE.agentStatus, unnarrowed. */
  agentStatus?: unknown;
  /** METADATA_UPDATE.activity — hook-derived (PostToolUse) tool label. */
  activity?: unknown;
  /** METADATA_UPDATE.pendingQuestion — written on every turn boundary. */
  pendingQuestion?: unknown;
}

/**
 * Decide the gate transition for one metadata payload.
 *
 * LOCK on `agentStatus === 'awaiting_input'` — a permission prompt. That status
 * is screen-scraped (AgentDetector's regexes), which is why it may lock but is
 * never allowed to unlock.
 *
 * UNLOCK only when the payload carries `activity` or `pendingQuestion`. Both
 * fields are written exclusively behind an arbitrated HOOK signal — `agent.stop`
 * / `agent.session_start` via `buildTurnBoundaryMetadata`, `agent.activity` via
 * the router's `ev.signal &&` branch — so their presence is a real turn boundary
 * rather than an inference.
 *
 * Everything else returns null. In particular:
 *   - `'idle'` is BYTE SILENCE (ActivityMonitor, 5s). A pane parked on a menu is
 *     byte-silent, so unlocking on idle re-opens the exact hazard on a timer.
 *   - `'waiting'` is Claude Code's idle footer ("Ready for input"), not a prompt.
 *   - `'running'` / `'complete'` carry no hook evidence by themselves.
 *   - pane focus is not an input here at all.
 */
export function composerGateFromMetadata(payload: ComposerGateSignal): ComposerGateAction {
  // Lock wins: if a payload ever carried both, the safe answer is locked.
  if (payload.agentStatus === 'awaiting_input') return 'lock';
  if (typeof payload.activity === 'string' || typeof payload.pendingQuestion === 'string') {
    return 'unlock';
  }
  return null;
}
