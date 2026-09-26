// A pure parser for Claude Code's own permission dialog, read off the pane's
// visible grid:
//
//    Bash command
//
//      rm -rf build/cache
//      Remove the build cache
//
//    Permission rule Bash(rm -rf *) requires confirmation for this command.
//
//    Do you want to proceed?
//    ❯ 1. Yes
//      2. No
//
//    Esc to cancel · Tab to amend
//
// It extracts the reason line, the command/summary lines and the numbered
// option rows (any number of them; footer actions such as "Tab to amend" are
// not options), plus a fingerprint of those three that does not change when the
// selection cursor moves. The fingerprint is what a future remote answer would
// be fenced on: pressing a key is only honest if the dialog on screen is the
// one the phone was shown.
//
// Biased to refuse, like every screen check that could lead to a keystroke: a
// grid that does not have the question row followed by option rows numbered
// 1..n in order parses to null.

import crypto from 'node:crypto';

/** One grid row: plain text, or a text snapshot row with its soft-wrap flag. */
export type PromptRow = string | { text: string; wrapped?: boolean };

export interface TerminalPromptOption {
  /** The digit that selects the option ('1', '2', …). */
  key: string;
  label: string;
  /** The selection cursor is on this row. Not part of the fingerprint. */
  selected: boolean;
}

export interface ParsedTerminalPrompt {
  /** The dialog's title row ("Bash command"), when there is one. */
  title?: string;
  /** Command / summary rows between the title and the reason, in order. */
  commandLines: string[];
  /** The "Permission rule … requires confirmation …" line(s), joined. */
  reason?: string;
  /** "Do you want to proceed?" */
  question: string;
  options: TerminalPromptOption[];
  /** Hash of (reason, commandLines, option keys and labels). Cursor-free. */
  fingerprint: string;
}

/** Caps, so a huge dialog cannot put an unbounded record on the wire. */
export const PROMPT_MAX_COMMAND_LINES = 12;
export const PROMPT_MAX_LINE_CHARS = 200;
export const PROMPT_MAX_OPTIONS = 9;

const QUESTION_ROW = /\bDo you want to (?:proceed|make this edit|create|allow)\b.*\?\s*$/i;
const OPTION_ROW = /^([❯>›»])?\s*(\d{1,2})[.)]\s+(\S.*)$/;
const RULE_ROW = /^[╭╰┌└]?[─━═╌╍┄┅-]{8,}[╮╯┐┘]?$/;
const BOX_EDGE = /^[│║┃]\s?|\s?[│║┃]$/g;

function rowText(row: PromptRow): { text: string; wrapped: boolean } {
  return typeof row === 'string' ? { text: row, wrapped: false } : { text: row.text, wrapped: row.wrapped === true };
}

/** Join soft-wrapped continuation rows onto the row they continue. */
function logicalRows(rows: readonly PromptRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const { text, wrapped } = rowText(row);
    const clean = text.replace(BOX_EDGE, '').replace(/\s+$/, '');
    if (wrapped && out.length > 0) out[out.length - 1] += clean;
    else out.push(clean);
  }
  return out;
}

const indentOf = (row: string): number => row.length - row.trimStart().length;
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cap = (text: string): string =>
  text.length > PROMPT_MAX_LINE_CHARS ? `${text.slice(0, PROMPT_MAX_LINE_CHARS)}…` : text;

export function parseTerminalPrompt(rows: readonly PromptRow[]): ParsedTerminalPrompt | null {
  const lines = logicalRows(rows);

  // The LAST question row on screen is the live dialog.
  let q = -1;
  lines.forEach((line, i) => { if (QUESTION_ROW.test(line.trim())) q = i; });
  if (q < 0) return null;

  // Option rows directly under the question, numbered 1..n in order.
  const options: TerminalPromptOption[] = [];
  for (let i = q + 1; i < lines.length; i++) {
    const match = OPTION_ROW.exec(lines[i]!.trim());
    if (!match) break;
    const key = match[2]!;
    if (Number(key) !== options.length + 1) return null;
    options.push({ key, label: cap(flat(match[3]!)), selected: match[1] !== undefined });
  }
  if (options.length === 0 || options.length > PROMPT_MAX_OPTIONS) return null;
  if (options.filter((o) => o.selected).length > 1) return null;

  // The dialog body: up from the question to a horizontal rule or the top.
  let top = 0;
  for (let i = q - 1; i >= 0; i--) {
    if (RULE_ROW.test(lines[i]!.trim())) { top = i + 1; break; }
  }
  const body = lines.slice(top, q).filter((line) => line.trim().length > 0);
  const minIndent = body.length > 0 ? Math.min(...body.map(indentOf)) : 0;

  // Rows at the body's own indent are its prose: the first is the title, the
  // ones after the indented command block are the reason (possibly wrapped by
  // the TUI over several rows). Indented rows are the command and its summary.
  let title: string | undefined;
  const commandLines: string[] = [];
  const reasonParts: string[] = [];
  for (const line of body) {
    if (indentOf(line) > minIndent) {
      if (commandLines.length < PROMPT_MAX_COMMAND_LINES) commandLines.push(cap(flat(line)));
    } else if (title === undefined && commandLines.length === 0 && reasonParts.length === 0) {
      title = cap(flat(line));
    } else {
      reasonParts.push(flat(line));
    }
  }
  // A body with no indented block: the title row is all there is to name it.
  const reason = reasonParts.length > 0 ? cap(reasonParts.join(' ')) : undefined;

  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify([reason ?? '', commandLines, options.map((o) => [o.key, o.label])]))
    .digest('hex')
    .slice(0, 32);

  return {
    ...(title ? { title } : {}),
    commandLines,
    ...(reason ? { reason } : {}),
    question: cap(flat(lines[q]!)),
    options,
    fingerprint,
  };
}
