import { looksLikeApprovalPrompt } from '../approvals/approvalKeystrokes';

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
