// One judgment of "a dialog is on this screen", shared by main's typing gate
// and the daemon's automated prompt delivery.

import { looksLikeApprovalPrompt } from './approvalKeystrokes';
import { parseTerminalPrompt } from './terminalPromptParse';
import { showsOpenScreenReaderKeyRow, showsScreenReaderKeyRow } from './screenReaderKeyRow';

/**
 * Is an approval dialog on this screen right now? Any of these counts: an
 * option row under a selection cursor (a select, or the permission dialog's
 * "❯ 1. Yes"), a whole permission dialog the parser recognises, or a
 * screen-reader layout key row. Only the tail is looked at — the live dialog
 * is at the bottom of the grid. The screen-reader layout can leave an answered
 * dialog above newer output (a resize redraws it without clearing the old
 * copy): its key row has a transcript row under it, and only the rows under
 * that key row may then hold a dialog the parser reads.
 */
export function approvalOnScreen(screenText: string): boolean {
  const rows = screenText.split('\n').slice(-60);
  if (rows.length === 0) return false;
  const open = showsOpenScreenReaderKeyRow(rows);
  let lastKeyRow = -1;
  if (!open) rows.forEach((row, i) => { if (showsScreenReaderKeyRow([row])) lastKeyRow = i; });
  return looksLikeApprovalPrompt(rows) || parseTerminalPrompt(rows.slice(lastKeyRow + 1)) !== null || open;
}
