import { deliverScheduledPrompt, type ScheduledPromptDeliveryDeps } from '../sessionPromptDelivery';
import type { ChatSendResult } from '../../shared/transcript/turnEvents';
import { screenBlocksChatSend } from './chatScreenGate';

export interface ChatDeliveryDeps extends ScheduledPromptDeliveryDeps {
  getTranscriptSessionId: () => string | undefined;
  hasOpenApproval: () => boolean;
  /** The pane's visible grid, parsed; null when it cannot be read. */
  readScreen: () => Promise<readonly string[] | null>;
}

/** Keep transcript identity and approval checks inside the daemon, including
 * the second write after paste. A renderer's last status is never authority. */
export async function deliverChatPrompt(
  agentSessionId: string,
  text: string,
  deps: ChatDeliveryDeps,
): Promise<ChatSendResult> {
  if (!agentSessionId || !text.trim() || text.length > 16_000) return 'error';
  if (deps.getTranscriptSessionId() !== agentSessionId) return 'session_changed';
  if (deps.hasOpenApproval()) return 'blocked';
  const initial = deps.getAgentState();
  if (!initial || initial.slug !== 'claude' || !initial.incarnationId) return 'unavailable';
  // Status and the approval registry are blind to Claude's own select dialogs
  // (`/model`, the post-turn auto-mode wizard): Enter would confirm one.
  // Ahead of the idle refusal so the user is told about the prompt, not a draft.
  let rows: readonly string[] | null = null;
  try { rows = await deps.readScreen(); } catch { /* unreadable = refuse */ }
  if (screenBlocksChatSend(rows)) return 'blocked';
  // Claude restores the submitted draft after an interrupted turn. Idle alone
  // cannot prove its input is empty; pasting here could concatenate two tasks.
  if (initial.status === 'idle') return 'unconfirmed';
  return deliverScheduledPrompt('claude', initial.incarnationId, text, {
    ...deps,
    getAgentState: () => {
      if (deps.getTranscriptSessionId() !== agentSessionId || deps.hasOpenApproval()) return null;
      return deps.getAgentState();
    },
    write: (data) => {
      if (deps.getTranscriptSessionId() !== agentSessionId || deps.hasOpenApproval()) return false;
      return deps.write(data);
    },
  });
}
