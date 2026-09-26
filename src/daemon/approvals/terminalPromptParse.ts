// A pure parser for Claude Code's own permission dialog, read off the pane's
// visible grid:
//
//    ────────────────────────────────────────────
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
// It extracts the title, the command/summary lines, the reason line and the
// numbered option rows (any number of them; footer actions such as "Tab to
// amend" are not options), plus:
//
//   - a FINGERPRINT of the whole dialog — title, question, reason, every
//     command line and every option key and label, untruncated, whitespace runs
//     collapsed — that does not change when the selection cursor moves or when
//     the TUI re-wraps a row. A remote answer is fenced on it: pressing a key is
//     only honest if the dialog on screen is the one the phone was shown.
//   - whether the dialog is ACTIVE: exactly one option carries the cursor, the
//     `Esc to cancel…` footer sits right under the options, and nothing but
//     blank rows follows it. A dialog someone `cat`-ed into the scrollback, or
//     one the agent has moved on from, fails this.
//   - whether it was read WHOLE: the dialog's top rule is on screen and no row
//     or field was cut. Only a whole dialog may be answered remotely.
//
// Biased to refuse, like every screen check that could lead to a keystroke: a
// grid without the question row followed by option rows numbered 1..n in
// order parses to null.

import crypto from 'node:crypto';

/** One grid row: plain text, or a text snapshot row with its soft-wrap flag. */
export type PromptRow = string | { text: string; wrapped?: boolean };

export interface TerminalPromptOption {
  /** The digit that selects the option ('1', '2', …). */
  key: string;
  /** Display label, capped. */
  label: string;
  /** The selection cursor is on this row. Not part of the fingerprint. */
  selected: boolean;
}

export interface ParsedTerminalPrompt {
  /** The dialog's title row ("Bash command"), when there is one. Capped. */
  title?: string;
  /** Command / summary rows between the title and the reason. Capped. */
  commandLines: string[];
  /** Every command row, joined with ` · `, untruncated. Display. */
  commandText: string;
  /** Every command row joined with one space, whitespace-normalized, untruncated. */
  commandFull: string;
  /** The "Permission rule … requires confirmation …" line(s), joined. Capped. */
  reason?: string;
  /** "Do you want to proceed?" Capped. */
  question: string;
  options: TerminalPromptOption[];
  /** Hash of the whole dialog (see the header). Cursor- and wrap-free. */
  fingerprint: string;
  /** The dialog's top rule was found above it (it fits the viewport). */
  topRuleFound: boolean;
  /** A row or a display field was cut, by the TUI or by a cap here. */
  truncated: boolean;
  /** One cursor, the footer right under the options, blank rows after it. */
  active: boolean;
}

/** Display caps, so a huge dialog cannot put an unbounded record on the wire. */
export const PROMPT_MAX_COMMAND_LINES = 12;
export const PROMPT_MAX_LINE_CHARS = 200;
export const PROMPT_MAX_OPTIONS = 9;
/** Hex characters of the fingerprint. */
export const PROMPT_FINGERPRINT_HEX = 32;

const QUESTION_ROW = /\bDo you want to (?:proceed|make this edit|create|allow)\b.*\?\s*$/i;
const OPTION_ROW = /^([❯>›»])?\s*(\d{1,2})[.)]\s+(\S.*)$/;
/**
 * The dialog's top rule: a row of rule glyphs that starts at COLUMN 0 and
 * spans the width. An indented dash row (a heredoc line, a Markdown rule, a
 * separator inside the command) is part of the body, not its frame.
 */
const RULE_ROW = /^[╭╰┌└]?[─━═╌╍┄┅]+[╮╯┐┘]?$/;
/** Without the grid's width, how long a column-0 rule row must be. */
const RULE_MIN_CHARS_WITHOUT_COLS = 40;
const FOOTER_ROW = /^Esc to (?:cancel|exit|close|go back|dismiss)\b/i;
const BOX_EDGE = /^[│║┃]\s?|\s?[│║┃]$/g;
/** Ink marks a row it had to cut with an ellipsis at the end. */
const CUT_ROW = /…\s*$/;

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
/** Whitespace runs collapsed to one space, trimmed: the unit both the display and the hash use. */
export const normalizePromptText = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function parseTerminalPrompt(
  rows: readonly PromptRow[],
  opts: { cols?: number } = {},
): ParsedTerminalPrompt | null {
  const lines = logicalRows(rows);
  const minRule = opts.cols && opts.cols > 0 ? opts.cols - 1 : RULE_MIN_CHARS_WITHOUT_COLS;
  const isTopRule = (line: string): boolean =>
    RULE_ROW.test(line) && line.trimEnd().length >= minRule;
  let truncated = false;
  const cap = (text: string): string => {
    if (text.length <= PROMPT_MAX_LINE_CHARS) return text;
    truncated = true;
    return `${text.slice(0, PROMPT_MAX_LINE_CHARS)}…`;
  };

  // The LAST question row on screen is the live dialog.
  let q = -1;
  lines.forEach((line, i) => { if (QUESTION_ROW.test(line.trim())) q = i; });
  if (q < 0) return null;

  // Option rows directly under the question, numbered 1..n in order.
  const fullOptions: Array<{ key: string; label: string; selected: boolean }> = [];
  let after = q + 1;
  for (; after < lines.length; after++) {
    const match = OPTION_ROW.exec(lines[after]!.trim());
    if (!match) break;
    const key = match[2]!;
    if (Number(key) !== fullOptions.length + 1) return null;
    if (CUT_ROW.test(lines[after]!)) truncated = true;
    fullOptions.push({ key, label: normalizePromptText(match[3]!), selected: match[1] !== undefined });
  }
  if (fullOptions.length === 0 || fullOptions.length > PROMPT_MAX_OPTIONS) return null;
  const selectedCount = fullOptions.filter((o) => o.selected).length;
  if (selectedCount > 1) return null;

  // ACTIVE: the footer right under the options (one blank row allowed), then
  // nothing but blank rows to the bottom of the grid.
  let f = after;
  if (f < lines.length && !lines[f]!.trim()) f++;
  const footerBelow = f < lines.length && FOOTER_ROW.test(lines[f]!.trim());
  const blankAfterFooter = footerBelow && lines.slice(f + 1).every((line) => !line.trim());
  const active = selectedCount === 1 && footerBelow && blankAfterFooter;

  // The dialog body: up from the question to its top rule, or the grid top.
  let top = -1;
  for (let i = q - 1; i >= 0; i--) {
    if (isTopRule(lines[i]!)) { top = i + 1; break; }
  }
  const topRuleFound = top >= 0;
  const body = lines.slice(topRuleFound ? top : 0, q).filter((line) => line.trim().length > 0);
  if (body.some((line) => CUT_ROW.test(line))) truncated = true;
  const minIndent = body.length > 0 ? Math.min(...body.map(indentOf)) : 0;

  // Rows at the body's own indent are its prose: the first is the title, the
  // ones after the indented command block are the reason (the TUI may wrap it
  // over several rows). Indented rows are the command and its description.
  let fullTitle: string | undefined;
  const fullCommand: string[] = [];
  const reasonParts: string[] = [];
  for (const line of body) {
    if (indentOf(line) > minIndent) {
      fullCommand.push(normalizePromptText(line));
    } else if (fullTitle === undefined && fullCommand.length === 0 && reasonParts.length === 0) {
      fullTitle = normalizePromptText(line);
    } else {
      reasonParts.push(normalizePromptText(line));
    }
  }
  const fullReason = reasonParts.length > 0 ? reasonParts.join(' ') : undefined;
  const fullQuestion = normalizePromptText(lines[q]!);

  // The hash takes the FULL text. Caps below are for display only; hashing a
  // capped field would let two dialogs that differ past the cap collide.
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify([
      fullTitle ?? '',
      fullQuestion,
      fullReason ?? '',
      // One string, not the row list: where the TUI broke the command into
      // rows depends on the width, and a resize must not change the hash.
      normalizePromptText(fullCommand.join(' ')),
      fullOptions.map((o) => [o.key, o.label]),
    ]))
    .digest('hex')
    .slice(0, PROMPT_FINGERPRINT_HEX);

  if (fullCommand.length > PROMPT_MAX_COMMAND_LINES) truncated = true;
  const title = fullTitle !== undefined ? cap(fullTitle) : undefined;
  const commandLines = fullCommand.slice(0, PROMPT_MAX_COMMAND_LINES).map(cap);
  const reason = fullReason !== undefined ? cap(fullReason) : undefined;
  const question = cap(fullQuestion);
  const options = fullOptions.map((o) => ({ ...o, label: cap(o.label) }));

  return {
    ...(title ? { title } : {}),
    commandLines,
    commandText: fullCommand.join(' · '),
    commandFull: normalizePromptText(fullCommand.join(' ')),
    ...(reason ? { reason } : {}),
    question,
    options,
    fingerprint,
    topRuleFound,
    truncated,
    active,
  };
}

/** The plain Yes: exactly `Yes` (case-insensitive, trimmed). */
const PLAIN_YES = /^yes$/i;
/** A plain No: `No`, or `No, …` ("No, and tell Claude what to do differently"). */
const PLAIN_NO = /^no(?:,|$)/i;
/** Never answerable, whatever else the label says: these write a lasting rule. */
const LASTING_RULE = /don'?t ask again|\balways\b|for this session/i;

/** The decision an answerable choice label stands for. */
export function decisionForChoiceLabel(label: string): 'approve' | 'deny' | null {
  const text = label.trim();
  if (LASTING_RULE.test(text)) return null;
  if (PLAIN_YES.test(text)) return 'approve';
  if (PLAIN_NO.test(text)) return 'deny';
  return null;
}

/**
 * Which options a phone may answer with, and whether it may answer at all.
 *
 * Only the plain Yes and a plain No (`No`, or `No, …`) are ever answerable.
 * Anything that writes a lasting rule — "Yes, and don't ask again for …
 * commands", "always", "for this session" — stays display-only. No plain Yes, a dialog taller than the viewport,
 * a cut row or field, or a command the 200-character summary cannot carry
 * whole: not answerable.
 */
export function terminalPromptAnswerability(
  parsed: ParsedTerminalPrompt,
  summaryMax: number,
): { answerable: boolean; choices: Array<{ key: string; label: string }> } {
  const choices = parsed.options
    .filter((o) => decisionForChoiceLabel(o.label) !== null)
    .map((o) => ({ key: o.key, label: o.label.trim() }));
  const hasYes = choices.some((c) => decisionForChoiceLabel(c.label) === 'approve');
  const answerable = hasYes
    && parsed.topRuleFound
    && !parsed.truncated
    && parsed.commandText.length <= summaryMax;
  return { answerable, choices: answerable ? choices : [] };
}

/** "Bash command" → "Bash": the tool a permission dialog's title names. */
export function toolFromDialogTitle(title: string | undefined): string | undefined {
  const m = title ? /^(\w[\w-]*) command$/i.exec(title) : null;
  return m ? m[1] : undefined;
}

/**
 * Is this dialog the one for this tool call? The dialog's title must name the
 * call's tool, and its full command rows must be exactly the call's command —
 * optionally followed by the call's own description, which Claude prints
 * under it. Whitespace-normalized on both sides, so where the TUI broke a line
 * does not matter; nothing else may be left over, so a dialog whose rows hide
 * part of the command (or show a different one) does not bind.
 */
export function dialogMatchesToolCall(
  parsed: ParsedTerminalPrompt,
  call: { name: string; command: string; description?: string },
): boolean {
  if (toolFromDialogTitle(parsed.title) !== call.name) return false;
  const command = normalizePromptText(call.command);
  if (!command) return false;
  const shown = parsed.commandFull;
  if (shown === command) return true;
  const description = call.description ? normalizePromptText(call.description) : '';
  return description.length > 0 && shown === `${command} ${description}`;
}
