import { terminalRegistry } from '../hooks/useTerminal';
import { deliverChatInsert, focusChatComposer } from '../components/Chat/chatAttachments';
import { pastePtyChunked } from './clipboardChunk';
import type { MentionSource } from './agentMention';
import { useStore } from '../stores';
import { t } from '../i18n';

/** Opens the agent mention picker (AgentMentionPicker listens). */
export const OPEN_MENTION_PICKER_EVENT = 'wmux:open-mention-picker';

/**
 * Why nothing was inserted:
 * - `noComposer` — the pane shows Chat view but no composer is mounted to take
 *   the text (still loading). The hidden terminal is never the fallback: the
 *   user is looking at the composer, and bytes in a PTY they cannot see are a
 *   prompt they did not write.
 * - `full` — the composer has no room left under its length limit.
 * - `gone` — the pane closed while the picker was open.
 */
export type MentionInsertResult = 'inserted' | 'noComposer' | 'full' | 'gone';

/**
 * Put a mention reference into the focused agent's input. Chat view: the
 * composer, at its caret. Terminal: the same bracketed paste a workspace or
 * pane drag drops in (Terminal.tsx handleTerminalDrop), so the agent's
 * prompt takes it as pasted text — never submitted, never typed key by key.
 */
export function insertMention(source: MentionSource, text: string): MentionInsertResult {
  if (source.chat) {
    const delivered = deliverChatInsert(source.ptyId, text);
    return delivered === null ? 'noComposer' : delivered ? 'inserted' : 'full';
  }
  const term = terminalRegistry.get(source.ptyId);
  if (!term) return 'gone';
  const modes = (term as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes;
  void pastePtyChunked(
    (d) => window.electronAPI.pty.write(source.ptyId, d),
    text,
    modes ?? null,
  ).catch((err) => {
    console.error('[wmux:mention] paste failed:', err);
    toastMentionInsert('gone');
  });
  term.focus();
  return 'inserted';
}

/** Tell the user why a mention was not inserted; silent on success. */
export function toastMentionInsert(result: MentionInsertResult): void {
  if (result === 'inserted') return;
  const key = result === 'noComposer' ? 'mention.noComposer' : result === 'full' ? 'mention.composerFull' : 'mention.paneGone';
  useStore.getState().pushToast({ message: t(key), level: 'warn' });
}

/** Give the keyboard back to the pane the picker was opened from — never to a hidden terminal. */
export function focusMentionSource(source: MentionSource): void {
  if (source.chat) {
    focusChatComposer(source.ptyId);
    return;
  }
  terminalRegistry.get(source.ptyId)?.focus();
}
