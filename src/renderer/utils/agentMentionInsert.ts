import { terminalRegistry } from '../hooks/useTerminal';
import { deliverChatInsert, focusChatComposer } from '../components/Chat/chatAttachments';
import { pastePtyChunked } from './clipboardChunk';
import type { MentionSource } from './agentMention';

/** Opens the agent mention picker (AgentMentionPicker listens). */
export const OPEN_MENTION_PICKER_EVENT = 'wmux:open-mention-picker';

/**
 * Put a mention reference into the focused agent's input. Chat view: the
 * composer, at its caret. Terminal: the same bracketed paste a workspace or
 * pane drag drops in (Terminal.tsx handleTerminalDrop), so the agent's
 * prompt takes it as pasted text — never submitted, never typed key by key.
 */
export function insertMention(source: MentionSource, text: string): void {
  if (source.chat && deliverChatInsert(source.ptyId, text)) return;
  const term = terminalRegistry.get(source.ptyId);
  const modes = (term as unknown as { modes?: { bracketedPasteMode?: boolean } } | undefined)?.modes;
  void pastePtyChunked(
    (d) => window.electronAPI.pty.write(source.ptyId, d),
    text,
    modes ?? null,
  ).catch((err) => console.error('[wmux:mention] paste failed:', err));
  term?.focus();
}

/** Give the keyboard back to the pane the picker was opened from. */
export function focusMentionSource(source: MentionSource): void {
  if (source.chat && focusChatComposer(source.ptyId)) return;
  terminalRegistry.get(source.ptyId)?.focus();
}
