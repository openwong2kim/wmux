// Claude Code's screen-reader key row, read with no node import: the folder-
// trust reader that uses it is reachable from the renderer bundle.

import type { PromptRow } from './terminalPromptParse';

/**
 * Claude Code's screen-reader layout (`--ax-screen-reader`, measured on
 * 2.1.316) draws a dialog as plain rows: no selection cursor, no rules, no
 * indent. It ends every dialog with a key row that asks for the answer:
 *
 *    Select with numbers [1-4]. Then Enter to submit or Escape to cancel:
 *    Esc to cancel
 *
 * for a numbered list (a multi-select AskUserQuestion adds "(comma- or
 * space-separated for several)"), and `Enter y/n:` for the folder-trust
 * question. A typed key shows after the colon until Enter. The permission and
 * trust dialogs draw a key hint under the key row; AskUserQuestion draws none.
 * Ink breaks a long key row onto rows of its own, with no soft-wrap flag.
 */
export interface ScreenReaderKeyRow {
  /** `numbers`: `Select with numbers [1-<max>]…`; `y/n`: `Enter y/n:`. */
  keys: 'numbers' | 'y/n';
  /** The highest number the row offers (`numbers` only). */
  max?: number;
  /** Several numbers may be given (a multi-select). */
  multi: boolean;
  /** The grid's rows, a soft-wrapped row joined onto the one it continues. */
  lines: string[];
  /** Index in `lines` of the key row's first row. */
  at: number;
}

/** How a key row starts, on its first row (a pane under 26 columns breaks it before `[1-n]`). */
const SR_KEY_START = /^(?:Select with numbers\b|Enter y\/n:)/;
/**
 * The whole key row, its rows joined with every space dropped: a pane may
 * break it at a space with or without the soft-wrap flag, and the space is
 * then on either row or on none. What was typed may follow the colon: numbers
 * (commas between several), or one key for y/n. Anything longer is not a key
 * row read whole.
 */
const SR_NUMBERS_ROW = /^Selectwithnumbers\[1-(\d{1,2})\](\(comma-orspace-separatedforseveral\))?\.ThenEntertosubmitorEscapetocancel:[\d,]*$/i;
const SR_YES_NO_ROW = /^Entery\/n:\S?$/;
/** The key hint under a permission or trust dialog's key row. */
const SR_KEY_HINT = /^(?:Enter to confirm · )?Esc to cancel$/;
/** Rows a key row may take once a narrow pane breaks it (four at 30 columns). */
const SR_KEY_ROW_MAX_ROWS = 6;

/**
 * The key row of a screen-reader dialog that owns the bottom of the grid: its
 * rows, then at most the key hint, then nothing but blank rows. Null when the
 * bottom is anything else, including a row that starts like a key row but
 * does not read as one.
 */
export function screenReaderKeyRow(rows: readonly PromptRow[]): ScreenReaderKeyRow | null {
  const lines = joinedRows(rows);
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]!.trim()) end--;
  if (end >= 0 && SR_KEY_HINT.test(lines[end]!.trim())) end--;
  for (let at = end; at >= 0 && at > end - SR_KEY_ROW_MAX_ROWS; at--) {
    if (!lines[at]!.trim()) return null;
    if (!SR_KEY_START.test(lines[at]!.trim())) continue;
    const text = lines.slice(at, end + 1).join('').replace(/\s+/g, '');
    const numbers = SR_NUMBERS_ROW.exec(text);
    if (numbers) return { keys: 'numbers', max: Number(numbers[1]), multi: numbers[2] !== undefined, lines, at };
    return SR_YES_NO_ROW.test(text) ? { keys: 'y/n', multi: false, lines, at } : null;
  }
  return null;
}

/**
 * Does any row start a screen-reader key row? Looser than screenReaderKeyRow:
 * for a check that must not read a dialog as gone, a key row anywhere on the
 * grid counts, as an `Esc to …` footer anywhere does.
 */
export function showsScreenReaderKeyRow(rows: readonly string[]): boolean {
  return rows.some((row) => SR_KEY_START.test(row.trim()));
}

/** The rows, trailing blanks cut, each soft-wrapped row joined onto the row it continues. */
function joinedRows(rows: readonly PromptRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const text = (typeof row === 'string' ? row : row.text).replace(/\s+$/, '');
    if (typeof row !== 'string' && row.wrapped === true && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}
