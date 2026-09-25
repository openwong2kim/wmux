import { deliverScheduledPrompt, type ScheduledPromptDeliveryDeps } from '../sessionPromptDelivery';
import type { ChatSendResult } from '../../shared/transcript/turnEvents';
import { screenBlocksChatSend } from './chatScreenGate';
import { quoteImagePathForPty } from '../../shared/imagePaste';

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
  attachments: readonly string[] = [],
): Promise<ChatSendResult> {
  if (!agentSessionId || !text.trim() || text.length > 16_000 || attachments.length > 5) return 'error';
  if (deps.getTranscriptSessionId() !== agentSessionId) return 'session_changed';
  if (deps.hasOpenApproval()) return 'blocked';
  const initial = deps.getAgentState();
  if (!initial || !['claude', 'codex'].includes(initial.slug) || !initial.incarnationId) return 'unavailable';
  // Status and the approval registry are blind to Claude's own select dialogs
  // (`/model`, the post-turn auto-mode wizard): Enter would confirm one.
  // Ahead of the idle refusal so the user is told about the prompt, not a draft.
  let rows: readonly string[] | null = null;
  try { rows = await deps.readScreen(); } catch { /* unreadable = refuse */ }
  if (screenBlocksChatSend(rows)) return 'blocked';
  // Claude restores the submitted draft after an interrupted turn. Idle alone
  // cannot prove its input is empty; pasting here could concatenate two tasks.
  // Mid-turn, a draft typed in Terminal would be joined the same way. Only the
  // empty composer on screen is permission for either (running stays 'busy').
  const claudeEmpty = initial.slug === 'claude' && claudeComposerEmpty(rows);
  if (initial.slug === 'claude' && initial.status === 'idle' && !claudeEmpty) return 'unconfirmed';
  // Image paths become attachments only in Claude's composer, and only an
  // empty one: a failed earlier send may have left paths behind to duplicate.
  if (attachments.length && initial.slug !== 'claude') return 'unavailable';
  if (attachments.length && !claudeEmpty) return 'unconfirmed';
  // Codex's empty composer is a known placeholder. A draft, menu, picker or
  // unknown CLI layout cannot inherit permission from an idle status.
  if (initial.slug === 'codex' && !codexComposerEmpty(rows)) return 'unconfirmed';
  let keyboardOwned = true;
  return deliverScheduledPrompt(initial.slug, initial.incarnationId, text, {
    ...deps,
    // Codex submits bracketed multiline paste with one Enter. Claude's existing
    // double-Enter behavior is retained by the scheduler's default.
    ...(initial.slug === 'codex' ? { submitKeys: '\r' } : {}),
    // Claude queues a prompt submitted mid-turn, exactly as typed in Terminal.
    ...(claudeEmpty ? { acceptRunning: true } : {}),
    ...(attachments.length ? { leadingPastes: attachments.map(quoteImagePathForPty) } : {}),
    delay: async (ms) => {
      await (deps.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(ms);
      if (initial.slug === 'codex') {
        try { keyboardOwned = !codexScreenBlocked(await deps.readScreen()); }
        catch { keyboardOwned = false; }
      }
    },
    getAgentState: () => {
      if (!keyboardOwned || deps.getTranscriptSessionId() !== agentSessionId || deps.hasOpenApproval()) return null;
      return deps.getAgentState();
    },
    write: (data) => {
      if (deps.getTranscriptSessionId() !== agentSessionId || deps.hasOpenApproval()) return false;
      return deps.write(data);
    },
  });
}

/** Claude Code 2.1 TUI: the prompt row between the two rules, with nothing typed. */
export function claudeComposerEmpty(rows: readonly string[] | null): boolean {
  if (!rows || screenBlocksChatSend(rows)) return false;
  const tail = rows.map(row => row.trim());
  const rule = (row: string | undefined) => !!row && /^─{8,}$/.test(row);
  let at = -1;
  tail.forEach((row, index) => { if (/^❯(?:\s|$)/.test(row)) at = index; });
  // A fresh session dims a suggestion into the empty prompt: `❯ Try "…"`.
  return at > 0 && /^❯(?: Try "[^"]*")?$/.test(tail[at]) && rule(tail[at - 1]) && rule(tail[at + 1]);
}

/** Codex 0.156 TUI; positive evidence, not an absence-of-errors heuristic.
 * Match only the bottom composer with its own model/cwd footer. */
export function codexComposerEmpty(rows: readonly string[] | null): boolean {
  if (!rows || codexScreenBlocked(rows)) return false;
  const tail = rows.map(row => row.trimEnd());
  const prompts = tail.flatMap((row, index) => /^\s*› /.test(row) ? [index] : []);
  const at = prompts.at(-1);
  if (at === undefined || !/^\s*› Ask Codex to do anything\s*$/.test(tail[at])) return false;
  const below = tail.slice(at + 1).filter(row => row.trim());
  return below.length === 1 && /^\s*\S.+ · (?:[A-Za-z]:[\\/]|\/|~)/.test(below[0]);
}

function codexScreenBlocked(rows: readonly string[] | null): boolean {
  return screenBlocksChatSend(rows) || !!rows?.some(row => /\besc(?:ape)? (?:to )?(?:cancel|quit|close|dismiss|go back)\b/i.test(row));
}
