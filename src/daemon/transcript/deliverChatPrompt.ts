import { deliverScheduledPrompt, type ScheduledPromptDeliveryDeps } from '../sessionPromptDelivery';
import type { ChatSendResult } from '../../shared/transcript/turnEvents';
import { screenBlocksChatSend } from './chatScreenGate';
import { quoteImagePathForPty } from '../../shared/imagePaste';

/** Screen rows, optionally with a dim-blanked copy of each row (same indexes). */
export type ChatScreenRows = readonly string[] & { readonly undimmed?: readonly string[] };

export interface ChatDeliveryDeps extends ScheduledPromptDeliveryDeps {
  getTranscriptSessionId: () => string | undefined;
  hasOpenApproval: () => boolean;
  /** The pane's visible grid, parsed; null when it cannot be read. */
  readScreen: () => Promise<ChatScreenRows | null>;
  /** Never type into a running turn (the daemon queue delivers after the turn ends). */
  idleOnly?: boolean;
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
  let rows: ChatScreenRows | null = null;
  try { rows = await deps.readScreen(); } catch { /* unreadable = refuse */ }
  if (screenBlocksChatSend(rows)) return 'blocked';
  // Claude restores the submitted draft after an interrupted turn. Idle alone
  // cannot prove its input is empty; pasting here could concatenate two tasks.
  // Mid-turn, a draft typed in Terminal would be joined the same way. Only the
  // empty composer on screen is permission for either (running stays 'busy').
  const claudeEmpty = initial.slug === 'claude' && claudeComposerEmpty(rows);
  // A delayed (queued) message is typed with nobody watching: whatever the
  // status reads, only an empty composer on screen is permission. A draft in
  // a visible composer is `unconfirmed`; no composer at all (a usage screen,
  // a picker the screen gate does not know) is a dialog to wait out.
  if (deps.idleOnly && (initial.slug === 'claude' ? !claudeEmpty : !codexComposerEmpty(rows))) {
    return (initial.slug === 'claude' ? claudeComposerVisible(rows) : codexComposerVisible(rows)) ? 'unconfirmed' : 'blocked';
  }
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
    ...(claudeEmpty && !deps.idleOnly ? { acceptRunning: true } : {}),
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

/** Claude Code 2.1 TUI: the prompt row between the two rules, with nothing typed.
 *  After a turn Claude dims a suggested next prompt into the empty composer;
 *  with `undimmed` rows that suggestion reads as empty, typed text never does. */
export function claudeComposerEmpty(rows: ChatScreenRows | null): boolean {
  if (!rows || screenBlocksChatSend(rows)) return false;
  const tail = rows.map(row => row.trim());
  const rule = (row: string | undefined) => !!row && /^─{8,}$/.test(row);
  let at = -1;
  tail.forEach((row, index) => { if (/^❯(?:\s|$)/.test(row)) at = index; });
  // A fresh session dims a suggestion into the empty prompt: `❯ Try "…"`.
  const empty = /^❯(?: Try "[^"]*")?$/.test(tail[at] ?? '') || /^❯$/.test(rows.undimmed?.[at]?.trim() ?? '');
  return at > 0 && empty && rule(tail[at - 1]) && rule(tail[at + 1]);
}

/** The Claude composer is on screen (prompt row between two rules), empty or not. */
export function claudeComposerVisible(rows: ChatScreenRows | null): boolean {
  if (!rows || screenBlocksChatSend(rows)) return false;
  const tail = rows.map(row => row.trim());
  const rule = (row: string | undefined) => !!row && /^─{8,}$/.test(row);
  let at = -1;
  tail.forEach((row, index) => { if (/^❯(?:\s|$)/.test(row)) at = index; });
  return at > 0 && rule(tail[at - 1]) && rule(tail[at + 1]);
}

/**
 * Claude's composer as drawn: its rows (the `❯ ` / two-space indent removed,
 * trailing blanks trimmed; none when empty) and the screen width (the rule
 * rows span it). Null when no composer is on screen or a dialog owns it.
 */
export function claudeComposerRows(rows: ChatScreenRows | null): { rows: string[]; width: number } | null {
  if (!rows || screenBlocksChatSend(rows)) return null;
  const tail = rows.map(row => row.trim());
  const rule = (row: string | undefined) => !!row && /^─{8,}$/.test(row);
  let at = -1;
  tail.forEach((row, index) => { if (/^❯(?:\s|$)/.test(row)) at = index; });
  if (at <= 0 || !rule(tail[at - 1])) return null;
  const end = tail.findIndex((row, index) => index > at && rule(row));
  // Continuation rows are indented under the `❯`; anything else is not the composer.
  if (end < 0 || rows.slice(at + 1, end).some(row => !/^\s{2}/.test(row) && row.trim())) return null;
  const width = tail[at - 1].length;
  if (claudeComposerEmpty(rows)) return { rows: [], width };
  // Claude draws a no-break space after the `❯` (Claude Code 2.1, captured live).
  const first = rows[at].slice(rows[at].indexOf('❯') + 1).replace(/^[ \u00a0]/, '');
  return { rows: [first, ...rows.slice(at + 1, end).map(row => row.replace(/^[ \u00a0]{2}/, ''))].map(row => row.trimEnd()), width };
}

/**
 * Do the composer's rows show exactly `text` (`prefix`: the start of it)?
 * Spaces and line breaks count; the only thing undone is soft wrapping, and a
 * row break counts as one only where the next word could not have fit on the
 * row (Claude wraps at a space, which it drops, or mid-word).
 */
export function claudeComposerShows(shown: { rows: readonly string[]; width: number }, text: string, prefix = false): boolean {
  let pos = 0;
  // Blanks the screen trims: at the end of a line, before a break or the end.
  const skipTrailing = () => { const m = /^ +(?=\n|$)/.exec(text.slice(pos)); if (m) pos += m[0].length; };
  for (let i = 0; i < shown.rows.length; i++) {
    const row = shown.rows[i];
    if (!text.startsWith(row, pos)) return false;
    pos += row.length;
    if (i === shown.rows.length - 1) break;
    skipTrailing();
    if (text[pos] === '\n') { pos++; continue; }
    const spaces = /^ */.exec(text.slice(pos))![0].length;
    const word = /^\S*/.exec(text.slice(pos + spaces))![0].length;
    // `❯ ` / indent (2) + the row + a space + the next word would overflow it.
    if (2 + row.length + 1 + word <= shown.width - 2) return false;
    pos += spaces;
  }
  if (prefix) return true;
  skipTrailing();
  return pos === text.length;
}

/** The Codex composer is on screen (a `›` row over its model/cwd footer), empty or not. */
export function codexComposerVisible(rows: ChatScreenRows | null): boolean {
  if (!rows || codexScreenBlocked(rows)) return false;
  const tail = rows.map(row => row.trimEnd());
  const prompts = tail.flatMap((row, index) => /^\s*› /.test(row) || /^\s*›$/.test(row) ? [index] : []);
  const at = prompts.at(-1);
  if (at === undefined) return false;
  return tail.slice(at + 1).some(row => /^\s*\S.+ · (?:[A-Za-z]:[\\/]|\/|~)/.test(row));
}

/** The shortcut hint Codex draws under its footer: `? for shortcuts` (0.157),
 * then `← for agents · ? for shortcuts` (0.158), which a narrow pane cuts to
 * `? for shortcut` when a right-aligned `⚠ N warning(s) · f2 to view` badge
 * shares the row. */
const CODEX_SHORTCUT_HINT = /^\s*(?:← for agents · )?\? for shortcuts?(?:\s+⚠\s*\d+ warnings? · f2 to view)?$/;

/** Codex 0.156–0.158 TUI; positive evidence, not an absence-of-errors heuristic.
 * Match only the bottom composer with its own model/cwd footer. 0.157 adds a
 * shortcut hint under the footer (CODEX_SHORTCUT_HINT); with `undimmed` rows a
 * prompt row holding only dim text (placeholder or suggestion) is empty, typed
 * text is not. */
export function codexComposerEmpty(rows: ChatScreenRows | null): boolean {
  if (!rows || codexScreenBlocked(rows)) return false;
  const tail = rows.map(row => row.trimEnd());
  const prompts = tail.flatMap((row, index) => /^\s*› /.test(row) ? [index] : []);
  const at = prompts.at(-1);
  if (at === undefined) return false;
  const empty = /^\s*› Ask Codex to do anything\s*$/.test(tail[at]) || /^\s*›$/.test(rows.undimmed?.[at]?.trimEnd() ?? '');
  if (!empty) return false;
  const below = tail.slice(at + 1).filter(row => row.trim() && !CODEX_SHORTCUT_HINT.test(row));
  return below.length === 1 && /^\s*\S.+ · (?:[A-Za-z]:[\\/]|\/|~)/.test(below[0]);
}

function codexScreenBlocked(rows: readonly string[] | null): boolean {
  return screenBlocksChatSend(rows) || !!rows?.some(row => /\besc(?:ape)? (?:to )?(?:cancel|quit|close|dismiss|go back)\b/i.test(row));
}
