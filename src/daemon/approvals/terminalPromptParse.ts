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
//     command line and every option key and label, untruncated, whitespace
//     runs collapsed to one space — that does not change when the selection
//     cursor moves or when the TUI re-wraps a row at a space. A row broken
//     INSIDE a word (a long path) reads as a space there, so a resize that
//     moves such a break changes the hash and the record is refreshed once.
//     Whitespace is never dropped: `rm -rf /tmp/x` and `rm -rf / tmp/x` differ.
//     A remote answer is fenced on it: pressing a key is only honest if the
//     dialog on screen is the one the phone was shown.
//   - whether the dialog is ACTIVE: exactly one option carries the cursor, the
//     `Esc to cancel…` footer sits right under the options, and nothing but
//     blank rows follows it. A dialog someone `cat`-ed into the scrollback, or
//     one the agent has moved on from, fails this.
//   - whether it was read WHOLE: the dialog's top rule is on screen and no row
//     was cut by the TUI. A dialog whose top scrolled off is still parsed from
//     what is visible (`topRuleFound: false`); only a binding to the agent's
//     own pending call can make that one answerable (see the registry).
//
// Newer Claude Code builds draw the command with a `│` gutter and wrap it —
// and a long option label — over several rows; both are read here. A row the
// TUI broke inside a word (a long path) is matched against the call's command
// by `dialogMatchesToolCall`, never by joining rows with spaces.
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
  /**
   * The command's own rows, untruncated and whitespace-normalized: the `│`
   * gutter rows when the TUI draws one, else every indented body row.
   */
  commandRows: string[];
  /** Indented rows under a gutter-drawn command (its description). Untruncated. */
  descriptionRows: string[];
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
  /** A display field was capped here. Display only — the hash and the binding take the full text. */
  truncated: boolean;
  /** The TUI itself cut a row (it ends in an ellipsis): what is on screen is not the whole text. */
  cut: boolean;
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
/** The gutter a newer Claude Code draws left of each command row. */
const GUTTER = /^[│┃]\s?/;
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

  let cut = false;
  // Option rows directly under the question, numbered 1..n in order. A label
  // the TUI wrapped continues on rows indented past its option's digit.
  const fullOptions: Array<{ key: string; label: string; selected: boolean }> = [];
  let after = q + 1;
  let digitColumn = -1;
  for (; after < lines.length; after++) {
    const line = lines[after]!;
    const match = OPTION_ROW.exec(line.trim());
    if (!match) {
      const last = fullOptions[fullOptions.length - 1];
      if (last && line.trim() && indentOf(line) > digitColumn) {
        if (CUT_ROW.test(line)) cut = true;
        last.label = normalizePromptText(`${last.label} ${line}`);
        continue;
      }
      break;
    }
    const key = match[2]!;
    if (Number(key) !== fullOptions.length + 1) return null;
    if (CUT_ROW.test(line)) cut = true;
    digitColumn = line.indexOf(key, indentOf(line));
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
  if (body.some((line) => CUT_ROW.test(line))) cut = true;
  // The prose indent. With the top rule on screen it is the body's own
  // minimum; with the top cut off, the visible rows may all be command rows,
  // so the question row (prose, like the title and the reason) sets it.
  const minIndent = topRuleFound
    ? (body.length > 0 ? Math.min(...body.map(indentOf)) : 0)
    : indentOf(lines[q]!);

  // Rows at the body's own indent are its prose: the first is the title, the
  // ones after the indented command block are the reason (the TUI may wrap it
  // over several rows). Indented rows are the command and its description.
  // With the top rule cut off, a visible "<Tool> command" row is still the title.
  let fullTitle: string | undefined;
  const fullCommand: string[] = [];
  const gutterRows: string[] = [];
  const indentedPlain: string[] = [];
  const reasonParts: string[] = [];
  for (const line of body) {
    if (indentOf(line) > minIndent) {
      const text = line.trim();
      if (GUTTER.test(text)) gutterRows.push(normalizePromptText(text.replace(GUTTER, '')));
      else indentedPlain.push(normalizePromptText(text));
      fullCommand.push(normalizePromptText(text.replace(GUTTER, '')));
    } else if (
      fullTitle === undefined && fullCommand.length === 0 && reasonParts.length === 0
      // With the top rule cut off, the first prose row is still the title
      // when it reads like one ("Bash command"): never folded into the reason.
      && (topRuleFound || toolFromDialogTitle(normalizePromptText(line)) !== undefined)
    ) {
      fullTitle = normalizePromptText(line);
    } else {
      reasonParts.push(normalizePromptText(line));
    }
  }
  const gutterDrawn = gutterRows.length > 0;
  const fullReason = reasonParts.length > 0 ? reasonParts.join(' ') : undefined;
  const fullQuestion = normalizePromptText(lines[q]!);

  // The hash takes the FULL text. Caps below are for display only; hashing a
  // capped field would let two dialogs that differ past the cap collide.
  // Whitespace runs collapse to ONE space, never to nothing: deleting them
  // would hash `rm -rf /tmp/x` and `rm -rf / tmp/x` alike. The command is one
  // string, not the row list, so a re-wrap at a space does not change it.
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify([
      normalizePromptText(fullTitle ?? ''),
      normalizePromptText(fullQuestion),
      normalizePromptText(fullReason ?? ''),
      normalizePromptText(fullCommand.join(' ')),
      fullOptions.map((o) => [o.key, normalizePromptText(o.label)]),
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
    commandRows: gutterDrawn ? gutterRows : fullCommand,
    descriptionRows: gutterDrawn ? indentedPlain : [],
    commandText: fullCommand.join(' · '),
    commandFull: normalizePromptText(fullCommand.join(' ')),
    ...(reason ? { reason } : {}),
    question,
    options,
    fingerprint,
    topRuleFound,
    truncated,
    cut,
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
 * commands", "always", "for this session" — stays display-only. No plain Yes,
 * or a row the TUI cut: not answerable. How long the command is does not
 * matter — the record's summary is capped for display, the binding and the
 * fingerprint take the whole command. Whether the dialog's top may be off
 * screen is the binding's call (`dialogMatchesToolCall` with `topCut`), not
 * this one's.
 */
export function terminalPromptAnswerability(
  parsed: ParsedTerminalPrompt,
): { answerable: boolean; choices: Array<{ key: string; label: string }> } {
  const choices = parsed.options
    .filter((o) => decisionForChoiceLabel(o.label) !== null)
    .map((o) => ({ key: o.key, label: o.label.trim() }));
  const hasYes = choices.some((c) => decisionForChoiceLabel(c.label) === 'approve');
  const answerable = hasYes && !parsed.cut;
  return { answerable, choices: answerable ? choices : [] };
}

/** "Bash command" → "Bash": the tool a permission dialog's title names. */
export function toolFromDialogTitle(title: string | undefined): string | undefined {
  const m = title ? /^(\w[\w-]*) command$/i.exec(title) : null;
  return m ? m[1] : undefined;
}

/**
 * Do these screen rows spell `target` from `start` to its end? Each row must
 * match the target where the previous one stopped; between two rows the
 * target may carry ONE space the TUI consumed at the wrap. Nothing else is
 * skipped, so a row the TUI broke inside a word (a long path) matches, and a
 * row that differs anywhere does not. Both sides whitespace-normalized.
 */
function rowsSpell(rows: readonly string[], target: string, start: number): boolean {
  let pos = start;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row) return false;
    if (i > 0 && target[pos] === ' ') pos++;
    if (!target.startsWith(row, pos)) return false;
    pos += row.length;
  }
  return pos === target.length;
}

/**
 * Where the rows start spelling the target through to its end: 0 for the
 * whole target, or (`suffix`, the top cut off) the earliest start that works.
 * -1 when they do not.
 */
function rowsMatchAt(rows: readonly string[], target: string, suffix: boolean): number {
  if (rows.length === 0 || !target) return -1;
  if (!suffix) return rowsSpell(rows, target, 0) ? 0 : -1;
  const first = rows[0]!;
  for (let at = target.indexOf(first); at >= 0; at = target.indexOf(first, at + 1)) {
    if (rowsSpell(rows, target, at)) return at;
  }
  return -1;
}

/**
 * Is this dialog the one for this tool call? The dialog's title must name the
 * call's tool, and its command rows must be exactly the call's full command —
 * optionally followed by the call's own description, which Claude prints
 * under it. Whitespace-normalized on both sides, so where the TUI broke a line
 * does not matter (even inside a word); nothing else may be left over, so a
 * dialog whose rows hide part of the command (or show a different one) does
 * not bind.
 *
 * `topCut`: the dialog's top rule and title scrolled off. Then the visible
 * command rows must be a TAIL of the call's command (at least one such row on
 * screen), and the caller must have bound the call by its exact `tool_use` id
 * — the screen alone cannot say which call a headless dialog is for.
 */
export function dialogMatchesToolCall(
  parsed: ParsedTerminalPrompt,
  call: { name: string; command: string; description?: string },
  opts: { topCut?: boolean } = {},
): boolean {
  const topCut = opts.topCut === true;
  if (topCut) {
    if (parsed.topRuleFound) return false;
    if (parsed.title !== undefined && toolFromDialogTitle(parsed.title) !== call.name) return false;
  } else if (!parsed.topRuleFound || toolFromDialogTitle(parsed.title) !== call.name) {
    return false;
  }
  const command = normalizePromptText(call.command);
  if (!command) return false;
  const description = call.description ? normalizePromptText(call.description) : '';
  if (parsed.descriptionRows.length > 0) {
    // Gutter-drawn: the gutter rows are the command, the rows under them its
    // description — the call's own when it has one. A call without one gets
    // Claude's own label there ("Run shell command"): prose the gutter keeps
    // apart from the command, so it binds nothing and is not compared.
    if (description && rowsMatchAt(parsed.descriptionRows, description, false) !== 0) return false;
    return rowsMatchAt(parsed.commandRows, command, topCut) >= 0;
  }
  // One block of indented rows: the command, optionally its description after
  // it. With the top cut off, at least part of the COMMAND must be on screen —
  // a visible description alone says nothing about which command it is under.
  if (rowsMatchAt(parsed.commandRows, command, topCut) >= 0) return true;
  if (!description) return false;
  const at = rowsMatchAt(parsed.commandRows, `${command} ${description}`, topCut);
  return at >= 0 && at < command.length;
}
