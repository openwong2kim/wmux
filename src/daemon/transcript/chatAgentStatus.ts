import type { AgentStatus } from '../../shared/types';
import type { TurnEvent } from '../../shared/transcript/turnEvents';

/** How far back from the tail a turn end is looked for. */
const END_SCAN_LIMIT = 50;

function turnEndStatus(event: TurnEvent): AgentStatus | undefined {
  if ((event.kind === 'assistant_text' && event.turnComplete) || (event.kind === 'meta' && event.subtype === 'turn_complete')) return 'complete';
  if (event.kind === 'meta' && event.subtype === 'turn_aborted') return 'idle';
  return undefined;
}

/** Rows that mean the agent worked after whatever end came before them. */
function isNewerWork(event: TurnEvent): boolean {
  return event.kind === 'tool_use' || event.kind === 'tool_result'
    || (event.kind === 'assistant_text' && !event.turnComplete)
    || (event.kind === 'meta' && event.subtype === 'turn_started');
}

/**
 * The transcript's latest record that a turn ended, or undefined: an end_turn
 * reply or `turn_complete` reads as `complete`, an interrupt (`turn_aborted`,
 * which fires no Stop hook) as `idle`. Trailing rows that are not work (a
 * queued prompt, a status note) do not hide it; work recorded after it does.
 * Only an end recorded at or after `turnStartedAt` counts.
 */
export function transcriptTurnEnd(
  events: readonly TurnEvent[] | undefined,
  turnStartedAt: number,
): { status: AgentStatus; at: number; turnId?: string } | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= Math.max(0, events.length - END_SCAN_LIMIT); i--) {
    const event = events[i];
    const status = turnEndStatus(event);
    if (status) {
      if (event.ts === undefined || event.ts < turnStartedAt) return undefined;
      return { status, at: event.ts, ...(event.turnId ? { turnId: event.turnId } : {}) };
    }
    if (isNewerWork(event)) return undefined;
  }
  return undefined;
}

/**
 * The first turn end recorded at or after `since`, whatever follows it: a
 * turn that ended and was followed by the next prompt still ended. `idle` is
 * an interrupt, `complete` an end_turn reply. Undefined when none is in the
 * scanned tail.
 */
export function firstTurnEndSince(
  events: readonly TurnEvent[] | undefined,
  since: number,
): { status: AgentStatus; at: number } | undefined {
  if (!events) return undefined;
  let found: { status: AgentStatus; at: number } | undefined;
  for (let i = events.length - 1; i >= Math.max(0, events.length - END_SCAN_LIMIT * 4); i--) {
    const event = events[i];
    if (event.ts !== undefined && event.ts < since) break;
    const status = turnEndStatus(event);
    if (status && event.ts !== undefined) found = { status, at: event.ts };
  }
  return found;
}

/**
 * When the transcript confirms the turn a stop hook reports as ended: the
 * latest recorded end, and — when both name a turn — the same turn. Undefined
 * when nothing confirms it (no transcript yet, no end yet, another turn).
 */
export function confirmedStopAt(events: readonly TurnEvent[] | undefined, hookTurnId: unknown): number | undefined {
  const ended = transcriptTurnEnd(events, 0);
  if (!ended) return undefined;
  if (typeof hookTurnId === 'string' && ended.turnId && ended.turnId !== hookTurnId) return undefined;
  return ended.at;
}

/** A saved end_turn or interrupt can rebut byte-only activity, never newer work or a gate. */
export function chatAgentStatus(status: AgentStatus, events: readonly TurnEvent[] | undefined, turnStartedAt: number): AgentStatus {
  if (status === 'awaiting_input' || status === 'error') return status;
  return transcriptTurnEnd(events, turnStartedAt)?.status ?? status;
}
