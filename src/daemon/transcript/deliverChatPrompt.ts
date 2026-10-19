import { deliverScheduledPrompt, type ScheduledPromptDeliveryDeps } from '../sessionPromptDelivery';
import type { ChatSendResult } from '../../shared/transcript/turnEvents';
import { screenBlocksChatSend, titleShowsRunningTurn } from './chatScreenGate';
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
  /** Why a `blocked` answer came from the screen: a dialog on it, or no composer at all. */
  onScreenHold?: (why: 'dialog' | 'no-composer') => void;
  /** The pane's latest window title and when it was set (`at` 0 = never). */
  readTitle?: () => { title: string; at: number } | null;
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
  if (screenBlocksChatSend(rows)) { deps.onScreenHold?.('dialog'); return 'blocked'; }
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
    if (initial.slug === 'claude' ? claudeComposerVisible(rows) : codexComposerVisible(rows)) return 'unconfirmed';
    deps.onScreenHold?.('no-composer');
    return 'blocked';
  }
  if (initial.slug === 'claude' && initial.status === 'idle' && !claudeEmpty) return 'unconfirmed';
  // Image paths become attachments only in Claude's composer, and only an
  // empty one: a failed earlier send may have left paths behind to duplicate.
  if (attachments.length && initial.slug !== 'claude') return 'unavailable';
  if (attachments.length && !claudeEmpty) return 'unconfirmed';
  // Codex's empty composer is a known placeholder. A draft, menu, picker or
  // unknown CLI layout cannot inherit permission from an idle status.
  if (initial.slug === 'codex') {
    if (!codexComposerEmpty(rows)) return 'unconfirmed';
    // A hook's idle can arrive while Codex keeps working (compaction, a follow-up
    // step), and a transcript scrolled back hides the `esc to interrupt` row. The
    // spinner Codex keeps in the window title is the evidence that survives both:
    // Enter now would land in the running turn, not start the next one.
    let title: { title: string; at: number } | null = null;
    try { title = deps.readTitle?.() ?? null; } catch { /* no title = no title evidence */ }
    if (titleShowsRunningTurn(title, initial.slug, Date.now())) return 'busy';
  }
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

/** The rule under Claude's prompt row (and over it, unlabeled). */
const claudeRule = (row: string | undefined): boolean => !!row && /^─{8,}$/.test(row);
/**
 * The rule over Claude's prompt row (`rows` raw, `at` the prompt row, `below`
 * the rule under it). Once a session is named (`/rename`, or a title Claude
 * gives it), Claude draws the name into this rule near its right end:
 * `───…─── workspace-identity-card-plan ─` (captured 2026-10-11, Claude Code
 * 2.1, fullscreen renderer). A labeled rule counts only as Claude draws it:
 * from column 0 with the prompt row, the label set off by spaces between dash
 * runs, and as wide as the plain rule under the prompt. So neither a text row
 * nor a rule-like block indented inside a draft or the output passes for it.
 */
function claudeTopRule(rows: readonly string[], at: number, below: number): boolean {
  const row = rows[at - 1];
  if (row === undefined) return false;
  if (claudeRule(row.trim())) return true;
  const top = row.trimEnd();
  return /^─{8,} \S(?:.*\S)? ─+$/.test(top) && /^❯/.test(rows[at]) && top.length === rows[below]?.trim().length;
}

/** Claude Code 2.1 TUI: the prompt row between the two rules, with nothing typed.
 *  After a turn Claude dims a suggested next prompt into the empty composer;
 *  with `undimmed` rows that suggestion reads as empty, typed text never does. */
export function claudeComposerEmpty(rows: ChatScreenRows | null): boolean {
  if (!rows || screenBlocksChatSend(rows)) return false;
  const tail = rows.map(row => row.trim());
  let at = -1;
  tail.forEach((row, index) => { if (/^❯(?:\s|$)/.test(row)) at = index; });
  // A fresh session dims a suggestion into the empty prompt: `❯ Try "…"`.
  const empty = /^❯(?: Try "[^"]*")?$/.test(tail[at] ?? '') || /^❯$/.test(rows.undimmed?.[at]?.trim() ?? '');
  return at > 0 && empty && claudeTopRule(rows, at, at + 1) && claudeRule(tail[at + 1]);
}

/** The Claude composer is on screen (prompt row between two rules), empty or not. */
export function claudeComposerVisible(rows: ChatScreenRows | null): boolean {
  if (!rows || screenBlocksChatSend(rows)) return false;
  const tail = rows.map(row => row.trim());
  let at = -1;
  tail.forEach((row, index) => { if (/^❯(?:\s|$)/.test(row)) at = index; });
  return at > 0 && claudeTopRule(rows, at, at + 1) && claudeRule(tail[at + 1]);
}

/**
 * Claude's composer as drawn: its rows (the `❯ ` / two-space indent removed,
 * trailing blanks trimmed; none when empty) and the screen width (the rule
 * rows span it). Null when no composer is on screen or a dialog owns it.
 */
export function claudeComposerRows(rows: ChatScreenRows | null): { rows: string[]; width: number } | null {
  if (!rows || screenBlocksChatSend(rows)) return null;
  const tail = rows.map(row => row.trim());
  let at = -1;
  tail.forEach((row, index) => { if (/^❯(?:\s|$)/.test(row)) at = index; });
  if (at <= 0) return null;
  const end = tail.findIndex((row, index) => index > at && claudeRule(row));
  // Continuation rows are indented under the `❯`; anything else is not the composer.
  if (end < 0 || !claudeTopRule(rows, at, end) || rows.slice(at + 1, end).some(row => !/^\s{2}/.test(row) && row.trim())) return null;
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

/** The Codex composer is on screen (a `›` row over its model/cwd footer or
 *  its shortcut hint), empty or not. */
export function codexComposerVisible(rows: ChatScreenRows | null): boolean {
  if (!rows || codexScreenBlocked(rows)) return false;
  const tail = rows.map(row => row.trimEnd());
  const prompts = tail.flatMap((row, index) => /^\s*› /.test(row) || /^\s*›$/.test(row) ? [index] : []);
  const at = prompts.at(-1);
  if (at === undefined) return false;
  return tail.slice(at + 1).some(row => CODEX_FOOTER.test(row) || CODEX_SHORTCUT_HINT.test(row) || CODEX_SCROLLED_HINT.test(row));
}

/** Codex's model/cwd footer under the composer: `GPT-6.1-Sol low · ~/work`. */
const CODEX_FOOTER = /^\s*\S.+ · (?:[A-Za-z]:[\\/]|\/|~)/;
/** The shortcut hint Codex draws under its footer: `? for shortcuts` (0.157),
 * then `← for agents · ? for shortcuts` (0.158; `--no-daemon` drops the
 * agents part), which a narrow pane cuts (`? for shortcut` beside a
 * right-aligned `⚠ N warning(s) · f2 to view` badge, `? for shortcu` at 30
 * columns on 0.163). */
const CODEX_SHORTCUT_HINT = /^\s*(?:← for agents · )?\? for shortcu(?:ts?)?(?:\s+⚠\s*\d+ warnings? · f2 to view)?$/;
/** The hint Codex 0.162 draws in place of CODEX_SHORTCUT_HINT while its
 * transcript is scrolled back and new output arrived: `New activity · enter/esc
 * latest`, with ` · ? shortcuts` when the pane is wide enough. The `enter/`
 * form is drawn only over an empty composer (a draft turns it into `esc
 * latest`), and Enter then still submits a pasted prompt (captured live on
 * 0.162.1 at 40x27, 2026-10-13). */
const CODEX_SCROLLED_HINT = /^\s*New activity · enter\/esc latest(?: · \? shortcuts?)?(?:\s+⚠\s*\d+ warnings? · f2 to view)?$/;

/** Codex 0.156–0.163 TUI; positive evidence, not an absence-of-errors heuristic.
 * Match only the bottom composer with its own model/cwd footer. 0.157 adds a
 * shortcut hint under the footer (CODEX_SHORTCUT_HINT, or CODEX_SCROLLED_HINT
 * while the transcript is scrolled back). 0.163 can leave the footer row
 * blank (a long-running `--no-daemon` session, 80x54, 2026-10-19), and then
 * the hint alone marks the bottom composer. With `undimmed` rows a prompt row
 * holding only dim text (placeholder or suggestion) is empty, typed text is
 * not. */
export function codexComposerEmpty(rows: ChatScreenRows | null): boolean {
  if (!rows || codexScreenBlocked(rows)) return false;
  const tail = rows.map(row => row.trimEnd());
  const prompts = tail.flatMap((row, index) => /^\s*› /.test(row) ? [index] : []);
  const at = prompts.at(-1);
  if (at === undefined) return false;
  // The placeholder's words prove nothing on their own (a draft can hold
  // them); with the dim-blanked copy, only a bare `›` there is empty.
  const empty = rows.undimmed
    ? /^\s*›$/.test(rows.undimmed[at]?.trimEnd() ?? '')
    : /^\s*› Ask Codex to do anything\s*$/.test(tail[at]);
  if (!empty) return false;
  const after = tail.slice(at + 1).filter(row => row.trim());
  const isHint = (row: string) => CODEX_SHORTCUT_HINT.test(row) || CODEX_SCROLLED_HINT.test(row);
  const below = after.filter(row => !isHint(row));
  if (below.length === 0) return after.length > 0;
  return below.length === 1 && CODEX_FOOTER.test(below[0]);
}

function codexScreenBlocked(rows: readonly string[] | null): boolean {
  return screenBlocksChatSend(rows) || !!rows?.some(row => /\besc(?:ape)? (?:to )?(?:cancel|quit|close|dismiss|go back)\b/i.test(row));
}
