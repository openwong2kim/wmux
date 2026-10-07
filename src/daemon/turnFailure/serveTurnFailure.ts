/**
 * The one place a classified turn failure becomes the failure every phone
 * surface serves (contract v-next item 1): stamped with the `t1:` id of the
 * turn it ended, held on the pane's bridge until the next turn starts, and
 * pushed once.
 *
 * Callers pass the returned object, unchanged, to every other surface (the
 * `agent.liveness` frame, the history entry), so `turnId` and `at` are
 * identical everywhere and a client's `turnFailureKey` dedup holds.
 */
import type { TurnFailure } from '../../shared/phoneTurnFailure';

/** The slice of `DaemonPTYBridge` this reads and writes. */
export interface TurnFailureHolder {
  turnAt(ts: number): { turnId?: string; current: boolean } | null;
  noteTurnFailure(failure: TurnFailure, agentSessionId?: string): { failure: TurnFailure; fresh: boolean };
}

/**
 * `ts` is when the failure happened (the hook's own timestamp): delivery can
 * lag, and a failure that predates the episode now open belongs to the turn
 * before it. `current: false` then: the failure is stamped with that turn's
 * id for the record (history), but it is not held, not pushed and must not
 * ride a liveness frame: the running turn did not fail. Undefined when it
 * predates even that turn.
 */
export function serveTurnFailure(
  holder: TurnFailureHolder,
  classified: TurnFailure,
  opts: { ts: number; agentSessionId?: string; push?: (failure: TurnFailure) => void },
): { failure: TurnFailure; current: boolean } | undefined {
  const turn = holder.turnAt(opts.ts);
  if (!turn) return undefined;
  const stamped = turn.turnId ? { ...classified, turnId: turn.turnId } : classified;
  if (!turn.current) return { failure: stamped, current: false };
  const { failure, fresh } = holder.noteTurnFailure(stamped, opts.agentSessionId);
  // Once per failed turn: a repeat delivery of the same failure is not news.
  if (fresh) opts.push?.(failure);
  return { failure, current: true };
}
