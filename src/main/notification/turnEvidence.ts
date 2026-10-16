// Affirmative turn evidence per PTY, for the idle stops of bot workers
// (factory/workerReclaim.ts workerPanesIdle), which must never act on a
// guess: when the PTY's last HOOK turn start went out (a 'running' carrying
// its hookKind; a byte-rate 'running' does not count), and when its last turn
// END did (a reported 'complete' / 'waiting' / 'error', or the daemon's
// pre-turn boot settle). The latch-expiry and silence 'idle' settles are no
// end. Fed by the status funnel (metadata.handler broadcastMetadataUpdate).

const lastHookTurnStartAt = new Map<string, number>();
const lastTurnEndAt = new Map<string, number>();
const TURN_END_STATUSES: ReadonlySet<string> = new Set(['complete', 'waiting', 'error']);

/** One broadcast status (the funnel calls this for every status it records). */
export function noteBroadcastStatus(ptyId: string, status: string, hookKind: unknown, now: number = Date.now()): void {
  if (!ptyId) return;
  if (status === 'running' && hookKind) lastHookTurnStartAt.set(ptyId, now);
  else if (TURN_END_STATUSES.has(status)) lastTurnEndAt.set(ptyId, now);
}

/** The daemon saw the agent settle at its prompt with no turn since its
 *  SessionStart (a boot, a resume, a `/clear`): a turn end too. */
export function noteBootSettled(ptyId: string, now: number = Date.now()): void {
  if (ptyId) lastTurnEndAt.set(ptyId, now);
}

/** When the PTY's last hook turn start / turn end went out, or undefined
 *  (none since main started). */
export function lastHookTurnStart(ptyId: string): number | undefined {
  return lastHookTurnStartAt.get(ptyId);
}
export function lastTurnEnd(ptyId: string): number | undefined {
  return lastTurnEndAt.get(ptyId);
}

export function clearTurnEvidence(ptyId?: string): void {
  if (ptyId === undefined) {
    lastHookTurnStartAt.clear();
    lastTurnEndAt.clear();
    return;
  }
  lastHookTurnStartAt.delete(ptyId);
  lastTurnEndAt.delete(ptyId);
}
