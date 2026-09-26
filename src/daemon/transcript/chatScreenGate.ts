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

/** Non-blank rows at the bottom the structural check looks at. */
const ACTIVE_DIALOG_TAIL_ROWS = 6;
/** How close to the bottom a cursor option row must sit. */
const ACTIVE_OPTION_TAIL_ROWS = 4;
