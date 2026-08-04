/**
 * Phone liveness — the pane-state projection of an `agent.event`.
 *
 * The phone turn view carries a persistent activity header ("thinking", "Bash
 * running · 12s", "waiting for you"). That header is deliberately NOT derived
 * from the turn snapshot: an agent that stalls mid-turn writes nothing, so a
 * snapshot-derived header would look identical to a healthy pause and the phone
 * would show a frozen turn as a working one. So it rides its own channel, and
 * this module is the projection that channel carries.
 *
 * Kept out of `WebTerminalServer` on purpose: the web server is a consumer of
 * already-shaped payloads and must not learn hook envelope shapes (the same
 * reasoning as the approval registry and the transcript projector, which it
 * also takes as types only).
 */
import type { HookAgentEventData } from './HookIngest';

/**
 * What the header says the pane is doing.
 *
 * ADDITIVE union, same rule as `TurnEventKind`: a client that meets an unknown
 * state must fall back to a neutral "working" rendering rather than dropping
 * the event, so a later daemon can add a state without a phone update.
 *
 * `awaiting_permission` overlaps the approval event the phone already gets, and
 * is carried anyway: approvals ride the recorded attention log for the badge,
 * while this is the header's own view of the same moment. A phone that has not
 * opened the pane never sees this one.
 */
export type AgentLivenessState =
  | 'busy'
  | 'tool'
  | 'awaiting_permission'
  | 'awaiting_input'
  | 'idle';

/** The `agent.liveness` SSE payload. */
export interface AgentLivenessBody {
  sessionId: string;
  state: AgentLivenessState;
  /** Tool name, for `tool` / `awaiting_permission`. Absent when unknown. */
  tool?: string;
  /** Agent DISPLAY name ("Claude Code"), matching `agent.event`. */
  agent: string;
  /** ms epoch the state was entered. The phone renders elapsed from this. */
  at: number;
}

/**
 * States that must reach the phone NOW rather than at the end of a coalescing
 * window. All three mean "the pane stopped on its own" — a header that says
 * "Bash running" for another second after the agent started waiting for a human
 * is a worse lie than a tool name that lags, because it is the exact state the
 * user is watching the header to catch.
 */
export function isTerminalLiveness(state: AgentLivenessState): boolean {
  return state === 'idle' || state === 'awaiting_input' || state === 'awaiting_permission';
}

/**
 * Project one `agent.event` payload onto the header state.
 *
 * `status` wins over `hookKind`: the stop kinds settle the pane regardless of
 * which hook produced them, and the metadata kinds all carry `status:'running'`
 * so they only ever refine the busy case.
 */
export function deriveAgentLiveness(
  sessionId: string,
  data: HookAgentEventData,
  at: number,
): AgentLivenessBody {
  const tool = typeof data.signal?.payload?.['tool_name'] === 'string'
    ? (data.signal.payload['tool_name'] as string)
    : undefined;
  let state: AgentLivenessState = 'busy';
  if (data.status === 'complete') state = 'idle';
  else if (data.status === 'awaiting_input') state = 'awaiting_input';
  else if (data.hookKind === 'agent.awaiting_permission') state = 'awaiting_permission';
  else if (data.hookKind === 'agent.tool_started') state = 'tool';
  return {
    sessionId,
    state,
    ...(tool && (state === 'tool' || state === 'awaiting_permission') ? { tool } : {}),
    agent: data.agent,
    at,
  };
}
