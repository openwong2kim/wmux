import type { AgentStatus } from '../../shared/types';
import type { TurnEvent } from '../../shared/transcript/turnEvents';

/** A saved end_turn can rebut byte-only activity, never newer work or a gate. */
export function chatAgentStatus(status: AgentStatus, last: TurnEvent | undefined, turnStartedAt: number): AgentStatus {
  if (status === 'awaiting_input' || status === 'error') return status;
  return last?.kind === 'assistant_text' && last.turnComplete && last.ts !== undefined && last.ts >= turnStartedAt
    ? 'complete' : status;
}
