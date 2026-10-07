/**
 * The one place a classified turn failure becomes the failure every phone
 * surface serves (contract v-next item 1): stamped with the pane's `t1:` turn
 * id, held on the pane's bridge until the next turn starts, and pushed once.
 *
 * Callers pass the returned object, unchanged, to every other surface (the
 * `agent.liveness` frame, the history entry), so `turnId` and `at` are
 * identical everywhere and a client's `turnFailureKey` dedup holds.
 */
import type { TurnFailure } from '../../shared/phoneTurnFailure';

/** The slice of `DaemonPTYBridge` this reads and writes. */
export interface TurnFailureHolder {
  getTurnId(): string | undefined;
  noteTurnFailure(failure: TurnFailure, agentSessionId?: string): { failure: TurnFailure; fresh: boolean };
}

export function serveTurnFailure(
  holder: TurnFailureHolder,
  classified: TurnFailure,
  opts: { agentSessionId?: string; push?: (failure: TurnFailure) => void } = {},
): TurnFailure {
  // The episode the pane is in (or just closed) is the failed turn. Before the
  // first episode there is no id the phone ever saw, so none is sent.
  const turnId = holder.getTurnId();
  const { failure, fresh } = holder.noteTurnFailure(turnId ? { ...classified, turnId } : classified, opts.agentSessionId);
  // Once per failed turn: a repeat delivery of the same failure is not news.
  if (fresh) opts.push?.(failure);
  return failure;
}
