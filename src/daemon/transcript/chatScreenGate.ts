import { looksLikeApprovalPrompt } from '../approvals/approvalKeystrokes';
import { parseTerminalPrompt } from '../approvals/terminalPromptParse';

/**
 * Footer hint of a Claude Code dialog that owns the keyboard: `/model`, the
 * post-turn "Teach auto mode…" wizard, trust prompts. They all close with an
 * `Esc to cancel`-style row, including steps that have no numbered options.
 */
const DIALOG_FOOTER_ROW = /\bEsc to (?:cancel|exit|close|go back|dismiss)\b/i;

/**
 * Does the visible screen show something other than the composer taking keys?
 *
 * Agent status cannot answer this: Claude opens select dialogs on its own
 * after `end_turn`, while the pane still reads `complete` and no approval is
 * registered. A paste + Enter then confirms the dialog's highlighted option
 * and the message is lost (dogfood 2026-09-22, PR #1440).
 *
 * Biased to refuse, like the approval press check: an unreadable screen is no
 * evidence of a free composer, and a false positive costs one trip to
 * Terminal, while a false negative presses Enter in a dialog nobody saw.
 */
export function screenBlocksChatSend(rows: readonly string[] | null): boolean {
  if (!rows || rows.every((row) => !row.trim())) return true;
  return looksLikeApprovalPrompt(rows) || rows.some((row) => DIALOG_FOOTER_ROW.test(row));
}

/**
 * Claude Code's live spinner row: a spinner glyph, a gerund ending in `…`, and
 * a parenthesised counter carrying elapsed time or tokens, e.g.
 * `✻ Embellishing… (1s · ↓ 25 tokens · thinking with medium effort)`,
 * `✢ Ruminating… (8s · ↓ 238 tokens)`,
 * `✢ Onioning… (running UserPromptSubmit hook · 0s)`.
 * The finished-turn summary (`✻ Worked for 12s`) has no `…(` and never matches.
 * Claude Code does not draw `esc to interrupt` (#935).
 */
const CLAUDE_RUNNING_ROW = /^[✻✶✳✢✽] ?\S[^(]*… ?\((?:[^)]*[\s(·])?(?:\d+[hms]\b|[\d.]+k? tokens\b)/;
/** Codex's status row, e.g. `• Working (1s • esc to interrupt)`. */
const CODEX_RUNNING_ROW = /^•\s.*\besc to interrupt\)\s*$/i;

/**
 * Positive evidence, on the grid itself, that the agent's turn is running
 * right now: the status row the agent draws only while it works. The status
 * a hook reported can outlive the turn by the hook's delivery lag; this row
 * cannot. Both agents hide the row while answer text streams (captured on
 * Claude Code 2.1.283 and Codex 0.157.1), so its absence refuses a Stop that
 * may well have been safe; its presence is never stale.
 */
export function screenShowsRunningTurn(rows: readonly string[] | null, slug: string): boolean {
  if (!rows) return false;
  const row = slug === 'claude' ? CLAUDE_RUNNING_ROW : slug === 'codex' ? CODEX_RUNNING_ROW : null;
  return !!row && rows.some((line) => row.test(line.trim()));
}

/** The question line of Claude Code's permission dialog. */
const PROCEED_QUESTION_ROW = /\bDo you want to proceed\b/i;

/**
 * Does a READABLE, non-blank grid still show a Claude Code permission or select
 * dialog: the `Do you want to proceed?` line, a `❯ <n>.` cursor option row, or
 * the `Esc to cancel…` footer?
 *
 * The awaiting-state verifier clears a pane only when this is false on two
 * reads in a row. It is deliberately the same row tests as
 * `screenBlocksChatSend`, minus that gate's "blank means blocked": a blank or
 * unreadable grid is no evidence either way, and the caller keeps the pane
 * awaiting on its own rule rather than through this answer.
 */
export function screenShowsAgentDialog(rows: readonly string[]): boolean {
  return looksLikeApprovalPrompt(rows)
    || rows.some((row) => DIALOG_FOOTER_ROW.test(row) || PROCEED_QUESTION_ROW.test(row));
}

/**
 * Is a dialog still UP — owning the bottom of the screen — rather than merely
 * mentioned somewhere on it? The awaiting-state verifier decides on this, so a
 * dialog's text left in the output above (or any other row that happens to
 * look like one) cannot keep a pane "needs you" after the dialog closed.
 *
 * Up when Claude's permission dialog parses as ACTIVE (one cursor, the footer
 * right under the options, nothing below it), or, for the other select
 * dialogs (AskUserQuestion, `/model`), when the last non-blank row is an
 * `Esc to …` footer or a cursor option row sits among the last few non-blank
 * rows.
 */
export function screenShowsActiveDialog(rows: readonly string[]): boolean {
  if (parseTerminalPrompt(rows)?.active) return true;
  const tail = rows.filter((row) => row.trim().length > 0).slice(-ACTIVE_DIALOG_TAIL_ROWS);
  const last = tail[tail.length - 1];
  if (last !== undefined && DIALOG_FOOTER_ROW.test(last)) return true;
  return looksLikeApprovalPrompt(tail.slice(-ACTIVE_OPTION_TAIL_ROWS));
}

/**
 * Is Claude Code's permission dialog still up near the bottom of the grid: a
 * cursor option row among the last few non-blank rows, with no agent output
 * after it?
 *
 * Looser than `screenShowsActiveDialog`, which wants the footer to close the
 * screen: a live dialog can fail that (its footer wrapped onto a second row at
 * a narrow width, a status row drawn under it). Tighter than "anywhere on the
 * grid": an answered dialog left above the agent's next output (`⏺ …`, `⎿ …`,
 * `✻ …`) does not count, so it cannot hold a pane "needs you" indefinitely.
 * The verifier uses this only while wmux holds a `terminal_prompt` record for
 * the pane.
 */
export function screenShowsPermissionDialog(rows: readonly string[]): boolean {
  const tail = rows.filter((row) => row.trim().length > 0).slice(-PERMISSION_TAIL_ROWS);
  let cursor = -1;
  tail.forEach((row, i) => { if (looksLikeApprovalPrompt([row])) cursor = i; });
  if (cursor < 0) return false;
  return !tail.slice(cursor + 1).some((row) => AGENT_OUTPUT_ROW.test(row.trim()));
}

/** Non-blank bottom rows a held dialog's cursor row must sit in. */
const PERMISSION_TAIL_ROWS = 10;
/** A row the agent draws once it has moved on: tool call, tool result, spinner. */
const AGENT_OUTPUT_ROW = /^(?:[⏺●✻✶✳✢✽]|⎿)/;

/** Non-blank rows at the bottom the structural check looks at. */
const ACTIVE_DIALOG_TAIL_ROWS = 6;
/** How close to the bottom a cursor option row must sit. */
const ACTIVE_OPTION_TAIL_ROWS = 4;
