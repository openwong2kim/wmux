import type { AgentStatus } from '../../shared/types';
import type { ChatInterruptResult } from '../../shared/transcript/turnEvents';
import { screenBlocksChatSend } from './chatScreenGate';

export interface ChatInterruptDeps {
  getTranscriptSessionId: () => string | undefined;
  hasOpenApproval: () => boolean;
  /** The pane's visible grid, parsed; null when it cannot be read. */
  readScreen: () => Promise<readonly string[] | null>;
  getAgentState: () => { slug: string; status: AgentStatus } | null;
  write: (data: string) => boolean;
}

/**
 * Chat view's Stop: the key the agent's own TUI interrupts a turn with.
 *
 * ESC is only safe while the turn runs. At rest it clears Claude's input line
 * (and a second one opens rewind), and in a dialog it answers the dialog, so an
 * idle agent, an open approval or any keyboard-owning screen refuses instead.
 * Every check repeats after the screen read, the only await before the write.
 */
export async function interruptChatTurn(agentSessionId: string, deps: ChatInterruptDeps): Promise<ChatInterruptResult> {
  const check = (): ChatInterruptResult | null => {
    if (deps.getTranscriptSessionId() !== agentSessionId) return 'session_changed';
    if (deps.hasOpenApproval()) return 'blocked';
    const state = deps.getAgentState();
    if (!state || !['claude', 'codex'].includes(state.slug)) return 'unavailable';
    return state.status === 'running' ? null : 'not_running';
  };
  if (!agentSessionId) return 'error';
  const first = check();
  if (first) return first;
  let rows: readonly string[] | null = null;
  try { rows = await deps.readScreen(); } catch { /* unreadable = refuse */ }
  if (screenBlocksChatSend(rows)) return 'blocked';
  const second = check();
  if (second) return second;
  try { return deps.write('\x1b') ? 'sent' : 'unavailable'; } catch { return 'error'; }
}
