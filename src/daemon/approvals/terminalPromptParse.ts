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
// Two dialogs are titled by something other than "<Tool> command" (measured on
// Claude Code 2.1.292): "Fetch" (WebFetch) boxes `url: …` and `prompt: …`
// rows, asks "Do you want to allow Claude to fetch this content?" — wrapped
// over two rows in a narrow pane — and draws no footer; "Read file" boxes
// `Read(<path>)` and asks "Do you want to proceed?" like a Bash dialog.
// WebSearch (measured on 2.1.296) draws Claude's generic title "Tool use" and
// boxes `Web Search("<query>")`: the title alone names no tool, the box's
// first row does (`toolOfDialog`).
//
// Claude Code 2.1.296 adds a countdown to a dialog that will deny itself when
// nobody answers (a `dangerousRemoval` safety check in bypass or auto mode,
// or auto mode's fallback after repeated classifier denials). It is the LAST
// row(s) of the reason, at the prose indent, with no gutter, wrapped like any
// prose row, and it is redrawn every second:
//
//    ⚠ Claude Code will automatically deny this request in 1:58, to avoid blocking progress on an
//    unattended session
//
// It is read off (`autoDenyRemainingMs`) and kept out of the reason and the
// fingerprint: a hash that took it would change every second, so an answer
// to the card a phone was shown could never match the screen. Only that exact
// sentence, as the reason's trailing rows, is dropped (see AUTO_DENY_LINE).
//
// Claude Code's screen-reader layout (2.1.316) draws the same dialog as plain
// rows with no cursor, ended by a key row (`screenReaderKeyRow`). A grid that
// ends in one is read only by `parseScreenReaderPrompt`, never as above, and
// its record is never answerable: a digit there only fills the key row.
//
// Biased to refuse, like every screen check that could lead to a keystroke: a
// grid without the question row followed by option rows numbered 1..n in
// order parses to null.

import crypto from 'node:crypto';
import { screenReaderKeyRow, type ScreenReaderKeyRow } from './screenReaderKeyRow';

/** One grid row: plain text, or a text snapshot row with its soft-wrap flag. */
export type PromptRow = string | { text: string; wrapped?: boolean };

export interface TerminalPromptOption {
  /** The digit that selects the option ('1', '2', …). */
  key: string;
  /** Display label, capped. */
  label: string;
  /** The selection cursor is on this row. Not part of the fingerprint. */
  selected: boolean;
  /** The TUI cut this option's row, or a row its label wrapped onto (it ends in an ellipsis). */
  cut?: true;
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
  /**
   * What Claude's auto-deny countdown read (`in 1:58` → 118000) when the
   * dialog draws one. Not part of the reason or the fingerprint. Absent with no
   * countdown, or with its worded form (`about 2 minutes`: not precise enough to show).
   */
  autoDenyRemainingMs?: number;
  options: TerminalPromptOption[];
  /** Hash of the whole dialog (see the header). Cursor- and wrap-free. */
  fingerprint: string;
  /** The dialog's top rule was found above it (it fits the viewport). */
  topRuleFound: boolean;
  /** A display field was capped here. Display only — the hash and the binding take the full text. */
  truncated: boolean;
  /** The TUI itself cut a row (it ends in an ellipsis): what is on screen is not the whole text. */
  cut: boolean;
  /**
   * A row other than an option row was cut (title, description, command,
   * reason). `cut` is this OR any option's `cut`.
   */
  bodyCut: boolean;
  /** One cursor, the footer right under the options, blank rows after it. */
  active: boolean;
  /**
   * The command was read between the box's two dashed edges, so it is all
   * there even when the dialog's top is cut: it binds whole, never as a tail.
   */
  commandBoxed?: true;
  /** Set only by `parsePlanPrompt`: the ExitPlanMode dialog's own rows. */
  plan?: PlanDialogRows;
  /**
   * Read from Claude Code's screen-reader layout (`screenReaderKeyRow`): a
   * digit there only fills the key row, and Enter submits it.
   */
  screenReader?: true;
}

/** What `parsePlanPrompt` read off the ExitPlanMode dialog ("Would you like to proceed?"). */
export interface PlanDialogRows {
  /** The "Yes, manually approve edits" row. Absent when no such row is drawn. */
  approve?: { key: string; label: string };
  /**
   * The row whose inline text field carries the feedback (the option drawn
   * right above the "shift+tab to approve with this feedback" hint). Its
   * label is the field's text once something is typed there.
   */
  feedback?: { key: string; label: string };
  /** An option would switch the session to bypass permissions. */
  bypass: boolean;
  /**
   * Hash of the dialog with the feedback row's text left out: stays the same
   * while only the feedback field changes (a stepwise answer typing into it).
   */
  frameFingerprint: string;
}

/** Display caps, so a huge dialog cannot put an unbounded record on the wire. */
export const PROMPT_MAX_COMMAND_LINES = 12;
export const PROMPT_MAX_LINE_CHARS = 200;
export const PROMPT_MAX_OPTIONS = 9;
/** Hex characters of the fingerprint. */
export const PROMPT_FINGERPRINT_HEX = 32;

const QUESTION_ROW = /\bDo you want to (?:proceed|make this edit|create|allow)\b.*\?\s*$/i;
/** Rows the question may take once a narrow pane wraps it. */
const QUESTION_MAX_ROWS = 3;
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
/**
 * Claude's auto-deny countdown (2.1.296), its rows joined with one space:
 * `M:SS`, or `about N minute(s)` / `about N second(s)` in Claude's
 * accessibility rendering. The fixed wording on both sides of the time, so a
 * reason row that merely mentions it stays in the hash.
 */
const AUTO_DENY_LINE = /^\u26A0\uFE0F? Claude Code will automatically deny this request in (?:(\d{1,4}):([0-5]\d)|about \d{1,4} (?:minute|second)s?), to avoid blocking progress on an unattended session$/;
/** Rows the countdown may take once a narrow pane wraps it (four at 40 columns). */
const AUTO_DENY_MAX_ROWS = 12;

/**
 * The auto-deny countdown, when it is the trailing non-blank rows of
 * `grid.lines[from..to)` (the reason's last rows): every one of them at the
 * prose indent, drawn without a box edge or gutter, and together exactly
 * AUTO_DENY_LINE. How many non-blank rows it takes, and the time it shows.
 * Null when there is none.
 */
function trailingAutoDeny(
  grid: LogicalRows,
  from: number,
  to: number,
  proseIndent: number,
): { rows: number; remainingMs?: number } | null {
  const tail: string[] = [];
  for (let i = to - 1; i >= from && tail.length < AUTO_DENY_MAX_ROWS; i--) {
    const line = grid.lines[i]!;
    if (!line.trim()) continue;
    // A row whose column-0 box edge was stripped is not a bare prose row.
    if (grid.edged.has(i) || indentOf(line) !== proseIndent) return null;
    tail.unshift(line);
    const m = AUTO_DENY_LINE.exec(normalizePromptText(tail.join(' ')));
    if (m) return { rows: tail.length, ...(m[1] !== undefined ? { remainingMs: (Number(m[1]) * 60 + Number(m[2])) * 1000 } : {}) };
  }
  return null;
}

function rowText(row: PromptRow): { text: string; wrapped: boolean } {
  return typeof row === 'string' ? { text: row, wrapped: false } : { text: row.text, wrapped: row.wrapped === true };
}

/** The grid as logical rows, and which of them had a box edge stripped. */
interface LogicalRows { lines: string[]; edged: Set<number> }

/** Join soft-wrapped continuation rows onto the row they continue. */
function logicalRows(rows: readonly PromptRow[]): string[] {
  return logicalGrid(rows).lines;
}

function logicalGrid(rows: readonly PromptRow[]): LogicalRows {
  const lines: string[] = [];
  const edged = new Set<number>();
  for (const row of rows) {
    const { text, wrapped } = rowText(row);
    const unedged = text.replace(BOX_EDGE, '');
    const clean = unedged.replace(/\s+$/, '');
    if (wrapped && lines.length > 0) lines[lines.length - 1] += clean;
    else lines.push(clean);
    if (unedged !== text) edged.add(lines.length - 1);
  }
  return { lines, edged };
}

const indentOf = (row: string): number => row.length - row.trimStart().length;
/** Whitespace runs collapsed to one space, trimmed: the unit both the display and the hash use. */
export const normalizePromptText = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function parseTerminalPrompt(
  rows: readonly PromptRow[],
  opts: { cols?: number } = {},
): ParsedTerminalPrompt | null {
  // The screen-reader layout is read as nothing else. Its y/n key row is the
  // folder-trust question, not a permission dialog.
  const key = screenReaderKeyRow(rows);
  if (key) return key.keys === 'numbers' ? parseScreenReaderPrompt(key) : null;
  const grid = logicalGrid(rows);
  const { lines } = grid;
  const minRule = opts.cols && opts.cols > 0 ? opts.cols - 1 : RULE_MIN_CHARS_WITHOUT_COLS;
  const isTopRule = (line: string): boolean =>
    RULE_ROW.test(line) && line.trimEnd().length >= minRule;
  let truncated = false;
  const cap = (text: string): string => {
    if (text.length <= PROMPT_MAX_LINE_CHARS) return text;
    truncated = true;
    return `${text.slice(0, PROMPT_MAX_LINE_CHARS)}…`;
  };

  // The LAST question on screen is the live dialog. `q` is its last row; a
  // question a narrow pane wrapped starts at `questionStart`, on the rows at
  // its indent right above (a one-row question is always read as one row).
  let q = -1;
  let questionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/\?\s*$/.test(lines[i]!)) continue;
    for (let start = i; start >= 0 && start > i - QUESTION_MAX_ROWS; start--) {
      if (start < i && (!lines[start]!.trim() || indentOf(lines[start]!) !== indentOf(lines[i]!))) break;
      if (QUESTION_ROW.test(normalizePromptText(lines.slice(start, i + 1).join(' ')))) {
        q = i;
        questionStart = start;
        break;
      }
    }
  }
  if (q < 0) return null;
  const fullQuestion = normalizePromptText(lines.slice(questionStart, q + 1).join(' '));

  // Option rows directly under the question, numbered 1..n in order. A label
  // the TUI wrapped continues on rows indented past its option's digit; a cut
  // on such a row is that option's cut.
  const fullOptions: ParsedOption[] = [];
  let after = q + 1;
  let digitColumn = -1;
  for (; after < lines.length; after++) {
    const line = lines[after]!;
    const match = OPTION_ROW.exec(line.trim());
    if (!match) {
      const last = fullOptions[fullOptions.length - 1];
      if (last && line.trim() && indentOf(line) > digitColumn) {
        if (CUT_ROW.test(line)) last.cut = true;
        last.label = normalizePromptText(`${last.label} ${line}`);
        continue;
      }
      break;
    }
    const key = match[2]!;
    if (Number(key) !== fullOptions.length + 1) return null;
    digitColumn = line.indexOf(key, indentOf(line));
    fullOptions.push({
      key,
      label: normalizePromptText(match[3]!),
      selected: match[1] !== undefined,
      ...(CUT_ROW.test(line) ? { cut: true as const } : {}),
    });
  }
  if (fullOptions.length === 0 || fullOptions.length > PROMPT_MAX_OPTIONS) return null;
  const selectedCount = fullOptions.filter((o) => o.selected).length;
  if (selectedCount > 1) return null;

  // ACTIVE: the footer right under the options (one blank row allowed), then
  // nothing but blank rows to the bottom of the grid. A dialog Claude draws
  // with no footer (FOOTERLESS_TOOLS) is active once its title says it is
  // one and nothing but blank rows follows its options.
  let f = after;
  if (f < lines.length && !lines[f]!.trim()) f++;
  const footerBelow = f < lines.length && FOOTER_ROW.test(lines[f]!.trim());
  const blankAfterFooter = footerBelow && lines.slice(f + 1).every((line) => !line.trim());
  const activity: Activity = {
    withFooter: selectedCount === 1 && footerBelow && blankAfterFooter,
    footerless: selectedCount === 1 && lines.slice(after).every((line) => !line.trim()),
  };

  // The dialog body: up from the question to its top rule, or the grid top.
  let top = -1;
  for (let i = questionStart - 1; i >= 0; i--) {
    if (isTopRule(lines[i]!)) { top = i + 1; break; }
  }
  const topRuleFound = top >= 0;
  // Claude Code 2.1.289 boxes the command: a dashed rule, gutter rows, a
  // dashed rule, then the reason, all at the prose indent. The rule found
  // above is then the box's LOWER edge, not the dialog's top.
  const boxed = topRuleFound ? boxedCommand(lines, top - 1, questionStart, isTopRule) : null;
  if (boxed) return parseBoxedPrompt(grid, boxed, questionStart, fullQuestion, fullOptions, activity);
  const drawn = lines.slice(topRuleFound ? top : 0, questionStart).filter((line) => line.trim().length > 0);
  const autoDeny = trailingAutoDeny(grid, topRuleFound ? top : 0, questionStart, indentOf(lines[questionStart]!));
  const body = autoDeny ? drawn.slice(0, drawn.length - autoDeny.rows) : drawn;
  const bodyCut = body.some((line) => CUT_ROW.test(line));
  const cut = bodyCut || fullOptions.some((o) => o.cut);
  // The prose indent. With the top rule on screen it is the body's own
  // minimum; with the top cut off, the visible rows may all be command rows,
  // so the question row (prose, like the title and the reason) sets it.
  const minIndent = topRuleFound
    ? (body.length > 0 ? Math.min(...body.map(indentOf)) : 0)
    : indentOf(lines[questionStart]!);

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

  // The hash takes the FULL text. Caps below are for display only; hashing a
  // capped field would let two dialogs that differ past the cap collide.
  // Whitespace runs collapse to ONE space, never to nothing: deleting them
  // would hash `rm -rf /tmp/x` and `rm -rf / tmp/x` alike. The command is one
  // string, not the row list, so a re-wrap at a space does not change it.
  const fingerprint = promptFingerprint(fullTitle, fullQuestion, fullReason, fullCommand, fullOptions);

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
    ...(autoDeny?.remainingMs !== undefined ? { autoDenyRemainingMs: autoDeny.remainingMs } : {}),
    options,
    fingerprint,
    topRuleFound,
    truncated,
    cut,
    bodyCut,
    active: isActive(activity, fullTitle),
  };
}

/** An option row as read, before the display caps. */
type ParsedOption = { key: string; label: string; selected: boolean; cut?: true };

/** The permission dialog's fingerprint (see the header), from its full, uncapped parts. */
function promptFingerprint(
  title: string | undefined,
  question: string,
  reason: string | undefined,
  command: readonly string[],
  options: readonly ParsedOption[],
): string {
  return hashParts([
    normalizePromptText(title ?? ''),
    normalizePromptText(question),
    normalizePromptText(reason ?? ''),
    normalizePromptText(command.join(' ')),
    options.map((o) => [o.key, normalizePromptText(o.label)]),
  ]);
}

/** The two ways a dialog can read as active (see parseTerminalPrompt). */
interface Activity {
  /** One cursor, the footer right under the options, blank rows after it. */
  withFooter: boolean;
  /** One cursor and nothing but blank rows after the options. */
  footerless: boolean;
}

/**
 * Tools whose dialog Claude Code draws with no `Esc to …` footer (2.1.292:
 * the Fetch dialog ends at its last option, `3. No, … (esc)`). Only a dialog
 * whose title names one of these may read as active without the footer.
 */
const FOOTERLESS_TOOLS: ReadonlySet<string> = new Set(['WebFetch']);

function isActive(activity: Activity, title: string | undefined): boolean {
  if (activity.withFooter) return true;
  const tool = toolFromDialogTitle(title);
  return activity.footerless && tool !== undefined && FOOTERLESS_TOOLS.has(tool);
}

const DASHED_RULE = /^[╌╍┄┅]+$/;

/** Where a boxed command sits: the dialog's solid top rule (-1 when it has
 *  scrolled off), the box's upper and lower dashed edges. */
interface BoxedCommand { top: number; upper: number; lower: number }

/**
 * The boxed-command layout (Claude Code 2.1.289), found from the rule just
 * above the question: that rule is dashed, the rows between it and the next
 * dashed rule up are all gutter rows (at least one), and a solid full-width
 * rule sits above that, or nothing does (the dialog's top scrolled off: the
 * record then binds only by the pane's own call, as any top-cut dialog).
 * Anything else (an Edit dialog's dashed diff edges, a dashed rule with no
 * gutter rows inside) is not this layout: null.
 */
function boxedCommand(
  lines: readonly string[],
  lower: number,
  q: number,
  isTopRule: (line: string) => boolean,
): BoxedCommand | null {
  if (lower < 0 || lower >= q || !DASHED_RULE.test(lines[lower]!.trim())) return null;
  let upper = lower - 1;
  let rows = 0;
  let gutter = 0;
  for (; upper >= 0; upper--) {
    const text = lines[upper]!.trim();
    if (DASHED_RULE.test(text)) break;
    if (!text) continue;
    rows++;
    if (GUTTER.test(text)) gutter++;
  }
  if (upper < 0 || rows === 0) return null;
  // Gutter rows are the command whatever surrounds them. A short command is
  // drawn without the gutter: then only the "<Tool> command" title says the
  // box holds a command (an Edit dialog's dashed edges hold its diff).
  const allGutter = gutter === rows;
  for (let i = upper - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!isTopRule(line)) continue;
    if (DASHED_RULE.test(line.trim())) return null;
    if (allGutter) return { top: i, upper, lower };
    const title = lines.slice(i + 1, upper).find((l) => l.trim().length > 0);
    return gutter === 0 && title !== undefined && titleBoxesCommand(normalizePromptText(title))
      ? { top: i, upper, lower }
      : null;
  }
  if (allGutter) return { top: -1, upper, lower };
  // The top scrolled off over a short, gutterless command (a warning
  // paragraph under the box makes the dialog taller): a "<Tool> command"
  // title still on screen above the box says it holds a command.
  // The dialog then starts at the screen's top, so that title is its first row.
  const first = lines.slice(0, upper).find((l) => l.trim().length > 0);
  return gutter === 0 && first !== undefined && toolFromDialogTitle(normalizePromptText(first)) !== undefined
    ? { top: -1, upper, lower }
    : null;
}

/** The boxed layout read as the usual record: the first prose row is the
 *  title, the prose rows above the box are the call's description, the gutter
 *  rows the command, and the prose under the box the reason. */
function parseBoxedPrompt(
  grid: LogicalRows,
  box: BoxedCommand,
  questionStart: number,
  fullQuestion: string,
  fullOptions: ParsedOption[],
  activity: Activity,
): ParsedTerminalPrompt {
  const { lines } = grid;
  const nonBlank = (from: number, to: number): string[] =>
    lines.slice(from, to).filter((line) => line.trim().length > 0);
  const topRuleFound = box.top >= 0;
  // With the top cut off, rows above the box may be anything the screen still
  // shows: only a "<Tool> command" row there reads as the title, and only the
  // rows after it as the description.
  let head = nonBlank(box.top + 1, box.upper);
  if (!topRuleFound) {
    const t = head.findIndex((line) => toolFromDialogTitle(normalizePromptText(line)) !== undefined);
    head = t >= 0 ? head.slice(t) : [];
  }
  const commandRows = nonBlank(box.upper + 1, box.lower).map((line) => normalizePromptText(line.trim().replace(GUTTER, '')));
  // A warning paragraph Claude draws under the box (2.1.296: "This command
  // changes directory before running a version-control command, …") has a
  // gutter of its own: it is reason prose, read without the glyph.
  const underBox = nonBlank(box.lower + 1, questionStart);
  const autoDeny = trailingAutoDeny(grid, box.lower + 1, questionStart, indentOf(lines[questionStart]!));
  const reasonRows = underBox.slice(0, underBox.length - (autoDeny?.rows ?? 0))
    .map((line) => normalizePromptText(line.trim().replace(GUTTER, '')));
  const bodyCut = [...head, ...nonBlank(box.upper + 1, questionStart)].some((line) => CUT_ROW.test(line));
  const cut = bodyCut || fullOptions.some((o) => o.cut);
  let truncated = false;
  const cap = (text: string): string => {
    if (text.length <= PROMPT_MAX_LINE_CHARS) return text;
    truncated = true;
    return `${text.slice(0, PROMPT_MAX_LINE_CHARS)}…`;
  };
  const fullTitle = head.length > 0 ? normalizePromptText(head[0]!) : undefined;
  const descriptionRows = head.slice(1).map(normalizePromptText);
  const fullReason = reasonRows.length > 0 ? reasonRows.join(' ') : undefined;
  // Same hash parts as the unboxed layout: the command is the gutter rows.
  const fingerprint = hashParts([
    fullTitle ?? '',
    fullQuestion,
    fullReason ?? '',
    normalizePromptText(commandRows.join(' ')),
    fullOptions.map((o) => [o.key, normalizePromptText(o.label)]),
  ]);
  if (commandRows.length > PROMPT_MAX_COMMAND_LINES) truncated = true;
  const title = fullTitle !== undefined ? cap(fullTitle) : undefined;
  const reason = fullReason !== undefined ? cap(fullReason) : undefined;
  return {
    ...(title ? { title } : {}),
    commandLines: commandRows.slice(0, PROMPT_MAX_COMMAND_LINES).map(cap),
    commandRows,
    descriptionRows,
    commandText: commandRows.join(' · '),
    commandFull: normalizePromptText(commandRows.join(' ')),
    ...(reason ? { reason } : {}),
    question: cap(fullQuestion),
    ...(autoDeny?.remainingMs !== undefined ? { autoDenyRemainingMs: autoDeny.remainingMs } : {}),
    options: fullOptions.map((o) => ({ ...o, label: cap(o.label) })),
    fingerprint,
    topRuleFound,
    truncated,
    cut,
    bodyCut,
    active: isActive(activity, fullTitle),
    commandBoxed: true,
  };
}

/** A screen-reader dialog's title row. */
const SR_TITLE_ROW = /^Permission Required: (\S.*)$/;
/** A screen-reader Bash dialog's description, command and reason rows. */
const SR_BODY_ROW = /^> /;
/** A screen-reader option row: no cursor, no indent. */
const SR_OPTION_ROW = /^(\d{1,2})\.\s+(\S.*)$/;
const SR_QUESTION_START = /^Do you want to /;

/**
 * A permission dialog in Claude Code's screen-reader layout, read up from its
 * `numbers` key row:
 *
 *    Permission Required: Bash command
 *    Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 *    > Remove the build output
 *    > npm run clean
 *    > This command requires approval
 *    Do you want to proceed?
 *    1. Yes
 *    2. Yes, and don’t ask again for
 *    3. Yes, and switch to auto mode — · auto mode handles these prompts for you
 *    4. No
 *    Select with numbers [1-4]. Then Enter to submit or Escape to cancel:
 *    Esc to cancel
 *
 * Options `1.` to `<max>.` right above the key row; Ink breaks a long label
 * onto rows of its own, which continue it. The question is the 1-3 rows above
 * option 1, the title the nearest `Permission Required:` row above that, and
 * the rows between them the body: its `> ` rows when it has any (Bash), else
 * every row but Claude's tip (Write and Edit: the file and its numbered rows).
 * Null when the options are not 1..max in order, or the question is not a
 * permission question (an AskUserQuestion asks `> Which …?`).
 */
function parseScreenReaderPrompt(key: ScreenReaderKeyRow): ParsedTerminalPrompt | null {
  const { lines } = key;
  // Up from the key row to option 1. Rows that start no option continue the
  // label of the option above them.
  const fullOptions: ParsedOption[] = [];
  let continued: string[] = [];
  let first = key.at - 1;
  for (; first >= 0; first--) {
    const line = lines[first]!;
    if (!line.trim()) return null;
    const match = SR_OPTION_ROW.exec(line);
    if (!match) {
      continued.unshift(line);
      continue;
    }
    fullOptions.unshift({
      key: match[1]!,
      label: normalizePromptText([match[2]!, ...continued].join(' ')),
      selected: false,
      ...([line, ...continued].some((row) => CUT_ROW.test(row)) ? { cut: true as const } : {}),
    });
    continued = [];
    if (fullOptions.length > PROMPT_MAX_OPTIONS) return null;
    if (match[1] === '1') break;
  }
  if (first < 0 || fullOptions.length !== key.max) return null;
  if (fullOptions.some((o, i) => o.key !== String(i + 1))) return null;

  let questionStart = -1;
  for (let start = first - 1; start >= 0 && start >= first - QUESTION_MAX_ROWS; start--) {
    if (!lines[start]!.trim()) break;
    const text = normalizePromptText(lines.slice(start, first).join(' '));
    if (SR_QUESTION_START.test(text) && QUESTION_ROW.test(text)) {
      questionStart = start;
      break;
    }
  }
  if (questionStart < 0) return null;
  const fullQuestion = normalizePromptText(lines.slice(questionStart, first).join(' '));

  let titleAt = -1;
  for (let i = questionStart - 1; i >= 0 && titleAt < 0; i--) {
    if (SR_TITLE_ROW.test(lines[i]!)) titleAt = i;
  }
  const fullTitle = titleAt >= 0 ? normalizePromptText(SR_TITLE_ROW.exec(lines[titleAt]!)![1]!) : undefined;
  // With no title row on screen, the body runs from the grid top, as in a
  // cursor-drawn dialog whose top rule scrolled off.
  const body = lines.slice(titleAt + 1, questionStart).filter((line) => line.trim().length > 0);
  const marked = body.filter((line) => SR_BODY_ROW.test(line));
  const fullCommand = (marked.length > 0
    ? marked.map((line) => line.replace(SR_BODY_ROW, ''))
    : body.filter((line) => !TIP_ROW.test(line))
  ).map(normalizePromptText);
  const bodyCut = body.some((line) => CUT_ROW.test(line));

  let truncated = false;
  const cap = (text: string): string => {
    if (text.length <= PROMPT_MAX_LINE_CHARS) return text;
    truncated = true;
    return `${text.slice(0, PROMPT_MAX_LINE_CHARS)}…`;
  };
  if (fullCommand.length > PROMPT_MAX_COMMAND_LINES) truncated = true;
  const title = fullTitle !== undefined ? cap(fullTitle) : undefined;
  return {
    ...(title ? { title } : {}),
    commandLines: fullCommand.slice(0, PROMPT_MAX_COMMAND_LINES).map(cap),
    commandRows: fullCommand,
    descriptionRows: [],
    commandText: fullCommand.join(' · '),
    commandFull: normalizePromptText(fullCommand.join(' ')),
    question: cap(fullQuestion),
    options: fullOptions.map((o) => ({ ...o, label: cap(o.label) })),
    fingerprint: promptFingerprint(fullTitle, fullQuestion, undefined, fullCommand, fullOptions),
    topRuleFound: titleAt >= 0,
    truncated,
    cut: bodyCut || fullOptions.some((o) => o.cut),
    bodyCut,
    active: true,
    screenReader: true,
  };
}

// ── ExitPlanMode ────────────────────────────────────────────────────────────
//
// Claude Code 2.1.283 draws the plan approval unboxed, below the plan itself:
//
//      ────────────────────────────────────────────
//       Claude has written up a plan and is ready to execute. Would you like to proceed?
//
//       ❯ 1. Yes, and use auto mode
//         2. Yes, manually approve edits
//         3. Tell Claude what to change
//            shift+tab to approve with this feedback
//
//       ctrl+g to edit in Vim · ~/.claude/plans/plan-….md
//
// It has no "Esc to cancel" footer and its rule is indented, so the permission
// parser above never reads it. Option 3 is an inline text field: its label is
// the typed feedback once there is some, which is why the feedback row is found
// by the hint drawn under it, not by its label. Keys and labels are whatever
// the screen says (see KEYS.md); nothing is assumed about their numbers.

const PLAN_QUESTION = /\bWould you like to proceed\?$/i;
const PLAN_FEEDBACK_HINT = /^shift\+tab to approve with this feedback$/i;
const PLAN_FOOTER = /^ctrl\+g to edit\b/i;
const PLAN_APPROVE = /\bmanually approve\b/i;
const PLAN_BYPASS = /\bbypass permissions\b/i;
/** Options that change the session's permission mode: display only. */
const PLAN_MODE_SWITCH = /\bauto mode\b|\bbypass permissions\b|\baccept edits\b/i;
const PLAN_RULE = /^[─━═╌╍┄┅▔]+$/;
/** Rows the question may take once the TUI wraps it. */
const PLAN_QUESTION_MAX_ROWS = 3;
/** The end of the footer's plan path. */
const PLAN_FOOTER_END = /\.md\s*$/;

const hashParts = (parts: unknown): string => crypto
  .createHash('sha256')
  .update(JSON.stringify(parts))
  .digest('hex')
  .slice(0, PROMPT_FINGERPRINT_HEX);

/**
 * The ExitPlanMode dialog on this grid, or null. Same bias as the permission
 * parser: numbered rows 1..n right under the question, at most one cursor, or
 * nothing. ACTIVE when exactly one row carries the cursor and nothing but the
 * `ctrl+g to edit` footer and blank rows follows the options.
 */
export function parsePlanPrompt(
  rows: readonly PromptRow[],
  _opts: { cols?: number } = {},
): ParsedTerminalPrompt | null {
  const lines = logicalRows(rows);
  // The LAST row ending the question is the live dialog. The TUI may wrap the
  // sentence, so the question is read from the rows above it too.
  let q = -1;
  let questionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/proceed\?\s*$/i.test(lines[i]!)) continue;
    // The sentence's rows: this one and the prose rows at its indent above it.
    let start = i;
    while (start > 0 && start > i - PLAN_QUESTION_MAX_ROWS + 1) {
      const prev = lines[start - 1]!;
      if (!prev.trim() || PLAN_RULE.test(prev.trim()) || indentOf(prev) !== indentOf(lines[i]!)) break;
      start--;
    }
    if (PLAN_QUESTION.test(normalizePromptText(lines.slice(start, i + 1).join(' ')))) {
      q = i;
      questionStart = start;
    }
  }
  if (q < 0) return null;
  const fullQuestion = normalizePromptText(lines.slice(questionStart, q + 1).join(' '));

  let cut = false;
  const fullOptions: Array<{ key: string; label: string; selected: boolean }> = [];
  let feedbackIndex = -1;
  let after = q + 1;
  // One blank row separates the question from its options.
  if (after < lines.length && !lines[after]!.trim()) after++;
  let digitColumn = -1;
  for (; after < lines.length; after++) {
    const line = lines[after]!;
    const text = line.trim();
    const match = OPTION_ROW.exec(text);
    if (match) {
      if (Number(match[2]) !== fullOptions.length + 1) return null;
      if (CUT_ROW.test(line)) cut = true;
      digitColumn = line.indexOf(match[2]!, indentOf(line));
      fullOptions.push({ key: match[2]!, label: normalizePromptText(match[3]!), selected: match[1] !== undefined });
      continue;
    }
    const last = fullOptions[fullOptions.length - 1];
    if (!last || !text) break;
    if (PLAN_FEEDBACK_HINT.test(text)) {
      if (feedbackIndex >= 0) return null;
      feedbackIndex = fullOptions.length - 1;
      continue;
    }
    if (indentOf(line) <= digitColumn) break;
    // A label (or the typed feedback) the TUI wrapped onto the next row.
    if (CUT_ROW.test(line)) cut = true;
    last.label = normalizePromptText(`${last.label} ${text}`);
  }
  if (fullOptions.length === 0 || fullOptions.length > PROMPT_MAX_OPTIONS) return null;
  const selectedCount = fullOptions.filter((o) => o.selected).length;
  if (selectedCount > 1) return null;

  // ACTIVE: after the options, blank rows, at most the footer (which a long
  // plan path may wrap), and blank rows to the bottom.
  const tail = lines.slice(after).filter((line) => line.trim());
  // A footer the TUI wrapped ends its plan path on the next row.
  const tailClean = tail.length === 0
    || (PLAN_FOOTER.test(tail[0]!.trim()) && (tail.length === 1
      || (tail.length === 2 && !PLAN_FOOTER_END.test(tail[0]!) && PLAN_FOOTER_END.test(tail[1]!))));
  const active = selectedCount === 1 && tailClean;

  // The dialog's own rule (indented, unlike a permission dialog's) above it.
  let topRuleFound = false;
  for (let i = questionStart - 1; i >= 0; i--) {
    const text = lines[i]!.trim();
    if (!text) continue;
    topRuleFound = PLAN_RULE.test(text);
    break;
  }

  const labels = fullOptions.map((o) => [o.key, o.label]);
  const fingerprint = hashParts(['plan', fullQuestion, labels]);
  const frameFingerprint = hashParts([
    'plan-frame',
    fullQuestion,
    labels.map(([key, label], i) => [key, i === feedbackIndex ? '' : label]),
    feedbackIndex,
  ]);

  let truncated = false;
  const cap = (text: string): string => {
    if (text.length <= PROMPT_MAX_LINE_CHARS) return text;
    truncated = true;
    return `${text.slice(0, PROMPT_MAX_LINE_CHARS)}…`;
  };
  const feedbackRow = feedbackIndex >= 0 ? fullOptions[feedbackIndex] : undefined;
  const approveRow = fullOptions.find((o, i) => i !== feedbackIndex
    && PLAN_APPROVE.test(o.label) && !PLAN_MODE_SWITCH.test(o.label) && !LASTING_RULE.test(o.label));
  const plan: PlanDialogRows = {
    ...(approveRow ? { approve: { key: approveRow.key, label: approveRow.label } } : {}),
    ...(feedbackRow ? { feedback: { key: feedbackRow.key, label: feedbackRow.label } } : {}),
    bypass: fullOptions.some((o) => PLAN_BYPASS.test(o.label)),
    frameFingerprint,
  };
  const question = cap(fullQuestion);
  const options = fullOptions.map((o) => ({ ...o, label: cap(o.label) }));
  return {
    commandLines: [],
    commandRows: [],
    descriptionRows: [],
    commandText: '',
    commandFull: '',
    question,
    options,
    fingerprint,
    topRuleFound,
    truncated,
    cut,
    // The plan dialog has its own answer path; its cut is never split.
    bodyCut: cut,
    active,
    plan,
  };
}

/** The plain Yes: exactly `Yes` (case-insensitive, trimmed). */
const PLAIN_YES = /^yes$/i;
/** A plain No: `No`, or `No, …` ("No, and tell Claude what to do differently"). */
const PLAIN_NO = /^no(?:,|$)/i;
/** Never answerable, whatever else the label says: these write a lasting rule. */
const LASTING_RULE = /don'?t ask again|\balways\b|for this session/i;
/** The label as drawn already says it is display-only (a lasting rule or a mode switch). */
const saysLastingOrModeSwitch = (label: string): boolean => LASTING_RULE.test(label) || PLAN_MODE_SWITCH.test(label);

/** The decision an answerable choice label stands for. */
export function decisionForChoiceLabel(label: string): 'approve' | 'deny' | null {
  const text = label.trim();
  // Never a phone answer either: an option that switches the session's
  // permission mode ("Yes, and switch to auto mode", 2.1.293's third Bash
  // option) changes every later prompt, not just this one. It stays in the
  // terminal; the phone is offered the plain Yes and No.
  if (LASTING_RULE.test(text) || PLAN_MODE_SWITCH.test(text)) return null;
  if (PLAIN_YES.test(text)) return 'approve';
  if (PLAIN_NO.test(text)) return 'deny';
  return null;
}

/**
 * Which options a phone may answer with, and whether it may answer at all.
 *
 * Only the plain Yes and a plain No (`No`, or `No, …`) are ever answerable.
 * Anything that writes a lasting rule — "Yes, and don't ask again for …
 * commands", "always", "for this session" — or switches the permission mode
 * ("Yes, and switch to auto mode") stays display-only. No plain Yes, or a row
 * the TUI cut: not answerable. One cut is let through: an option whose
 * VISIBLE text already says it writes a lasting rule or switches the mode
 * (WebSearch's `2. Yes, and don't ask again for Web Search commands in
 * <cwd>…`). It is never offered and its key never pressed, and its cut label
 * stays in the fingerprint. A cut option that does not say so on screen
 * (`Yes, and don't a…`, `Yes…`, `No, and tell…`) still refuses the dialog.
 *
 * WebSearch offers its Yes only. Its option 2 is `No` in a 50-column pane and
 * the standing grant in a wider one, and a resize moves no fence the key
 * write checks, so its deny is the Esc decline, never a digit.
 *
 * How long the command is does not
 * matter — the record's summary is capped for display, the binding and the
 * fingerprint take the whole command. Whether the dialog's top may be off
 * screen is the binding's call (`dialogMatchesToolCall` with `topCut`), not
 * this one's.
 *
 * A dialog read from the screen-reader layout (`screenReader`) is never
 * answerable: a remote answer presses one digit, which there only fills the
 * key row.
 */
export function terminalPromptAnswerability(
  parsed: ParsedTerminalPrompt,
): { answerable: boolean; choices: Array<{ key: string; label: string }> } {
  if (parsed.screenReader) return { answerable: false, choices: [] };
  const yesOnly = toolOfDialog(parsed) === 'WebSearch';
  const choices = parsed.options
    .filter((o) => {
      const decision = decisionForChoiceLabel(o.label);
      return decision === 'approve' || (decision === 'deny' && !yesOnly);
    })
    .map((o) => ({ key: o.key, label: o.label.trim() }));
  const hasYes = choices.some((c) => decisionForChoiceLabel(c.label) === 'approve');
  const blockingCut = parsed.bodyCut || parsed.options.some((o) => o.cut && !saysLastingOrModeSwitch(o.label));
  const answerable = hasYes && !blockingCut;
  return { answerable, choices: answerable ? choices : [] };
}

/**
 * Dialog titles that name their tool some other way, exactly as Claude Code
 * 2.1.292 draws them. Exact strings on purpose: the Edit and Write dialogs'
 * titles ("Edit file", "Create file") must keep naming no tool, because the
 * screen does not spell their call for `dialogMatchesToolCall`.
 */
const TITLED_TOOLS: ReadonlyMap<string, string> = new Map([
  ['Fetch', 'WebFetch'],
  ['Read file', 'Read'],
]);

/**
 * A shell dialog's title: "Bash command", or (measured on 2.1.296, with
 * `sandbox.enabled` and a call that sets `dangerouslyDisableSandbox`) "Bash
 * command (unsandboxed)". Claude also draws "… command (runs on <machine>)";
 * that one is not measured and names no tool here.
 */
const COMMAND_TITLE = /^(\w[\w-]*) command( \(unsandboxed\))?$/i;

/**
 * What Claude Code (measured on 2.1.306) appends to the title of a dialog that
 * a subagent's call raised: "Bash command · from the general-purpose agent".
 * It says who asked, not which tool, so it is read off before the title is
 * matched. It stays in the parsed title and in the fingerprint.
 */
const SUBAGENT_SUFFIX = / · from the \S.* agent$/;

/** The title as it names the tool: without a subagent's suffix. */
const toolTitle = (title: string): string => title.replace(SUBAGENT_SUFFIX, '');

/** A subagent's call raised the dialog (its title carries the suffix). */
export function titleFromSubagent(title: string | undefined): boolean {
  return !!title && SUBAGENT_SUFFIX.test(title);
}

/** "Bash command" → "Bash", "Fetch" → "WebFetch": the tool a permission dialog's title names. */
export function toolFromDialogTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const m = COMMAND_TITLE.exec(toolTitle(title));
  return m ? m[1] : TITLED_TOOLS.get(toolTitle(title));
}

/** The title says Claude runs this call outside its sandbox ("Bash command (unsandboxed)"). */
export function titleSaysUnsandboxed(title: string | undefined): boolean {
  return !!title && COMMAND_TITLE.exec(toolTitle(title))?.[2] !== undefined;
}

/**
 * Claude's generic dialog title (2.1.296), drawn for WebSearch and possibly
 * for other tools (MCP). It names no tool by itself: only the box's first row
 * does (BOX_TOOLS).
 */
const GENERIC_TITLE = 'Tool use';

/** Under the generic title, the box row that names the tool, exactly as Claude draws it. */
const BOX_TOOLS: ReadonlyArray<{ firstRow: RegExp; tool: string }> = [
  { firstRow: /^Web Search\(/, tool: 'WebSearch' },
];

/** A title whose dialog may box its call without a gutter (see boxedCommand). */
function titleBoxesCommand(title: string): boolean {
  return toolTitle(title) === GENERIC_TITLE || toolFromDialogTitle(title) !== undefined;
}

/**
 * The tool a parsed dialog is for: its title's (`toolFromDialogTitle`), or,
 * under the exact generic title `Tool use`, the tool its box's first row
 * names (`Web Search(` → WebSearch). Anything else: undefined.
 */
export function toolOfDialog(parsed: Pick<ParsedTerminalPrompt, 'title' | 'commandRows'>): string | undefined {
  const byTitle = toolFromDialogTitle(parsed.title);
  if (byTitle !== undefined || parsed.title === undefined || toolTitle(parsed.title) !== GENERIC_TITLE) return byTitle;
  const first = parsed.commandRows[0] ?? '';
  return BOX_TOOLS.find((b) => b.firstRow.test(first))?.tool;
}

/** A domain as WebSearch's box draws it, measured: letters, digits, dots, hyphens. */
const WEB_SEARCH_DOMAIN = /^[A-Za-z0-9.-]+$/;

/**
 * What a WebSearch call's box draws after its query, or null when the call
 * has a shape not measured yet (it then stays informational). Measured on
 * 2.1.296: `{query, mode: 'standard'}` draws nothing more (`''`), and one
 * `allowed_domains` entry draws `, only allowing domains: <d>`. Two or more
 * domains, `blocked_domains`, an empty list, another `mode` or any other key:
 * null.
 */
export function webSearchDetail(input: Record<string, unknown>): string | null {
  const keys = Object.keys(input);
  if (typeof input.query !== 'string') return null;
  if (keys.some((k) => k !== 'query' && k !== 'mode' && k !== 'allowed_domains')) return null;
  if ('mode' in input && input.mode !== 'standard') return null;
  if (!('allowed_domains' in input)) return '';
  const domains = input.allowed_domains;
  if (!Array.isArray(domains) || domains.length !== 1) return null;
  const domain = domains[0];
  return typeof domain === 'string' && WEB_SEARCH_DOMAIN.test(domain) ? `only allowing domains: ${domain}` : null;
}

/**
 * What the box of a titled dialog (TITLED_TOOLS) spells for a call, or null
 * when the call cannot be drawn there. `command` is the call's subject
 * (`commandOfToolInput`: the path, the URL), `detail` the second field the
 * box shows (WebFetch's `prompt`, WebSearch's `webSearchDetail`). The URL is compared as Claude draws it,
 * parsed and re-serialized (`https://example.com` → `https://example.com/`).
 */
const TITLED_BOX: Readonly<Record<string, (command: string, detail: string | undefined) => string | null>> = {
  Read: (command) => `Read(${command})`,
  // The query verbatim (Claude does not escape a quote in it), then
  // `webSearchDetail`. A query with an ellipsis in it is refused: on screen it
  // cannot be told from a row the TUI cut.
  WebSearch: (command, detail) => (command.includes('…') ? null : `Web Search("${command}"${detail ? `, ${detail}` : ''})`),
  WebFetch: (command, detail) => {
    if (!detail) return null;
    let href: string;
    try {
      href = new URL(command.trim()).href;
    } catch {
      return null;
    }
    return `url: ${href} prompt: ${detail}`;
  },
};

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

/** The first row of Claude's own tip, drawn above a call's description (2.1.293). */
const TIP_ROW = /^Tip:\s/;

/**
 * Do the description rows spell the call's description? Exactly, or (Claude
 * Code 2.1.293) after a tip Claude draws between the title and the
 * description: `Tip: auto mode handles these prompts for you — choose "switch
 * to auto mode" below`. The tip's text is Claude's, and a narrow pane wraps it
 * onto rows at the same indent as the description, so it is not matched by its
 * words: the first row must open with `Tip:`, and the rows after the tip must
 * spell the whole description, to its end. The tip itself binds nothing.
 */
function descriptionRowsSpell(rows: readonly string[], description: string): boolean {
  if (rowsMatchAt(rows, description, false) === 0) return true;
  if (!TIP_ROW.test(rows[0] ?? '')) return false;
  for (let k = 1; k < rows.length; k++) {
    if (rowsMatchAt(rows.slice(k), description, false) === 0) return true;
  }
  return false;
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
 * — the screen alone cannot say which call a headless dialog is for. A command
 * boxed between dashed edges (`commandBoxed`) is on screen whole, so it must
 * still be the call's whole command.
 *
 * A titled dialog (Read, WebFetch, WebSearch) binds only whole, title on
 * screen: its box rows must spell exactly what TITLED_BOX draws for the call
 * (`description` carries WebFetch's `prompt`, WebSearch's `webSearchDetail`). The prose above its box ("Claude wants to
 * fetch content from …") is Claude's own and is not compared.
 *
 * A title that says `(unsandboxed)` binds only a call that asked to run
 * outside the sandbox (`unsandboxed`: its `dangerouslyDisableSandbox` is
 * true). A plain title binds either: with no sandbox configured, Claude draws
 * it for such a call too (measured on 2.1.296).
 */
export function dialogMatchesToolCall(
  parsed: ParsedTerminalPrompt,
  call: { name: string; command: string; description?: string; unsandboxed?: boolean },
  opts: { topCut?: boolean } = {},
): boolean {
  const topCut = opts.topCut === true;
  if (titleSaysUnsandboxed(parsed.title) && call.unsandboxed !== true) return false;
  const titledBox = Object.prototype.hasOwnProperty.call(TITLED_BOX, call.name) ? TITLED_BOX[call.name] : undefined;
  if (titledBox) {
    if (topCut || !parsed.topRuleFound || toolOfDialog(parsed) !== call.name) return false;
    const target = titledBox(call.command, call.description ? normalizePromptText(call.description) : undefined);
    return target !== null && rowsMatchAt(parsed.commandRows, normalizePromptText(target), false) === 0;
  }
  if (topCut) {
    if (parsed.topRuleFound) return false;
    if (parsed.title !== undefined && toolFromDialogTitle(parsed.title) !== call.name) return false;
  } else if (!parsed.topRuleFound || toolFromDialogTitle(parsed.title) !== call.name) {
    return false;
  }
  const command = normalizePromptText(call.command);
  if (!command) return false;
  // A tail only when the top cut may have taken the command's first rows.
  const tail = topCut && parsed.commandBoxed !== true;
  const description = call.description ? normalizePromptText(call.description) : '';
  if (parsed.descriptionRows.length > 0) {
    // Gutter-drawn: the gutter rows are the command, the rows under them its
    // description — the call's own when it has one. A call without one gets
    // Claude's own label there ("Run shell command"): prose the gutter keeps
    // apart from the command, so it binds nothing and is not compared.
    if (description && !descriptionRowsSpell(parsed.descriptionRows, description)) return false;
    return rowsMatchAt(parsed.commandRows, command, tail) >= 0;
  }
  // One block of indented rows: the command, optionally its description after
  // it. With the top cut off, at least part of the COMMAND must be on screen —
  // a visible description alone says nothing about which command it is under.
  if (rowsMatchAt(parsed.commandRows, command, tail) >= 0) return true;
  if (!description) return false;
  const at = rowsMatchAt(parsed.commandRows, `${command} ${description}`, tail);
  return at >= 0 && at < command.length;
}
