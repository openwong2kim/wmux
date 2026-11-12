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
 *
 * Claude Code draws its dialogs in place of its input box, so an input box
 * still drawn near the bottom means no dialog is open above it: only the rows
 * under that box are looked at. The transcript echoes each sent prompt after
 * the same `❯` as a selection cursor, and the box shows the draft after it,
 * so a prompt that starts with "1." reads as an option row otherwise.
 */
export function approvalOnScreen(screenText: string): boolean {
  const all = screenText.split('\n').slice(-60);
  const rows = all.slice(composerBottom(all) + 1);
  if (rows.length === 0) return false;
  const open = showsOpenScreenReaderKeyRow(rows);
  let lastKeyRow = -1;
  if (!open) rows.forEach((row, i) => { if (showsScreenReaderKeyRow([row])) lastKeyRow = i; });
  return looksLikeApprovalPrompt(rows) || parseTerminalPrompt(rows.slice(lastKeyRow + 1)) !== null || open;
}

/** A full-width rule of Claude Code's input box. */
const BOX_RULE = /^─{8,}$/;
/** The input box's first row: the prompt glyph, then the draft (or nothing). */
const BOX_PROMPT = /^[❯>](?:\s|$)/;

/** A numbered choice row (the question tool draws one under its own rule). */
const CHOICE_ROW = /^\s*\d{1,2}[.)]\s+\S/;

/**
 * The index of the bottom rule of Claude Code's input box when the box is the
 * last one drawn (a rule, the prompt row, the draft's continuation rows
 * indented by two, a rule, and no numbered choice under it), or -1. A dialog
 * drawn with rules of its own (the question tool's) has a header row under
 * its top rule, and a choice under its bottom one.
 */
function composerBottom(rows: readonly string[]): number {
  const rules: number[] = [];
  rows.forEach((row, i) => { if (BOX_RULE.test(row.trim())) rules.push(i); });
  if (rules.length < 2) return -1;
  const bottom = rules[rules.length - 1];
  const top = rules[rules.length - 2];
  if (bottom - top < 2 || !BOX_PROMPT.test(rows[top + 1])) return -1;
  for (let i = top + 2; i < bottom; i++) {
    if (rows[i].trim() !== '' && !rows[i].startsWith('  ')) return -1;
  }
  return rows.slice(bottom + 1).some((row) => CHOICE_ROW.test(row)) ? -1 : bottom;
}
