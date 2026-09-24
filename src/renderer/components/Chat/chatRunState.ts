import type { AgentStatus } from '../../../shared/types';
import type { TurnEvent } from '../../../shared/transcript/turnEvents';

export type ChatRunState = 'connecting' | 'disconnected' | 'unavailable' | 'ended' | 'sending' | 'blocked' | 'working' | 'waiting' | 'complete' | 'ready' | 'unconfirmed';

/** Silence and an assistant text row are not proof that a turn completed. */
export function chatRunState(args: {
  loading: boolean; error: boolean; available: boolean; agentAlive?: boolean;
  sending: boolean; sent: boolean; blocked: boolean; turnOpen: boolean;
  status?: AgentStatus; events: readonly TurnEvent[];
}): ChatRunState {
  if (args.error) return 'disconnected';
  if (args.loading) return 'connecting';
  if (!args.available) return 'unavailable';
  if (args.agentAlive === false) return 'ended';
  if (args.sending) return 'sending';
  if (args.blocked || args.status === 'awaiting_input') return 'blocked';
  if (args.turnOpen) return 'working';
  if (args.sent) return 'waiting';
  // A recorded end_turn rebuts byte-only `running` (a dialog repaint, a resize)
  // once no submitted or hook-signaled turn is open — both were ruled out above.
  const last = args.events.at(-1);
  if (last?.kind === 'meta' && last.subtype === 'turn_complete') return 'complete';
  if (last?.kind === 'meta' && last.subtype === 'turn_aborted') return 'unconfirmed';
  if (last?.kind === 'assistant_text' && last.turnComplete) return 'complete';
  if (args.status === 'running') return 'working';
  if (!args.events.length) return 'ready';
  const lastUser = args.events.map((e) => e.kind).lastIndexOf('user_text');
  const hasReply = args.events.slice(lastUser + 1).some((e) => e.kind === 'assistant_text' && !e.thinking);
  if (args.status === 'complete' && hasReply) return 'complete';
  return 'unconfirmed';
}
