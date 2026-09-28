import type { AgentStatus } from '../../shared/types';
import type { TurnEvent } from '../../shared/transcript/turnEvents';

/**
 * The transcript's own record that the current turn ended, or undefined: an
 * end_turn reply or `turn_complete` reads as `complete`, an interrupt
 * (`turn_aborted`, which fires no Stop hook) as `idle`. Only an end recorded
 * at or after `turnStartedAt` counts.
 */
export function transcriptTurnEnd(last: TurnEvent | undefined, turnStartedAt: number): { status: AgentStatus; at: number } | undefined {
  if (last?.ts === undefined || last.ts < turnStartedAt) return undefined;
  if ((last.kind === 'assistant_text' && last.turnComplete) || (last.kind === 'meta' && last.subtype === 'turn_complete')) {
    return { status: 'complete', at: last.ts };
  }
  if (last.kind === 'meta' && last.subtype === 'turn_aborted') return { status: 'idle', at: last.ts };
  return undefined;
}

/** A saved end_turn or interrupt can rebut byte-only activity, never newer work or a gate. */
export function chatAgentStatus(status: AgentStatus, last: TurnEvent | undefined, turnStartedAt: number): AgentStatus {
  if (status === 'awaiting_input' || status === 'error') return status;
  return transcriptTurnEnd(last, turnStartedAt)?.status ?? status;
}
