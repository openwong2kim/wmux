/**
 * Plain input mode, read from a pane's current frame: whether a line typed now
 * reaches the agent's model input and nothing else. Positive evidence only:
 * an agent's plain prompt drawn as that agent draws it. A mode that runs or
 * reinterprets the line (Claude's `!` shell mode or `#` mode, a dialog) is a
 * named refusal on top, never the only test.
 *
 * Only the agents whose plain prompt is known here get a typed body; every
 * other agent gets wmux's own one-line pointer (deliveryPointer.ts).
 */

import type { AgentSlug } from '../shared/events';
import {
  claudeComposerEmpty,
  claudeComposerRows,
  CODEX_FOOTER,
  CODEX_SCROLLED_HINT,
  CODEX_SHORTCUT_HINT,
  chatScreenRowsOf,
  codexScreenBlocked,
  unseenFrom,
  type ChatScreenRows,
} from './transcript/deliverChatPrompt';
import { screenBlocksChatSend } from './transcript/chatScreenGate';

export type DeliveryPhase = 'paste' | 'enter';

/**
 * - `plain`: the agent's plain prompt, empty at the paste (at the Enter it
 *   holds what this delivery pasted);
 * - `mode`: a mode that runs or reinterprets the line, or a dialog;
 * - `busy`: the plain prompt holds someone's draft (paste only);
 * - `unknown`: no positive evidence either way.
 */
export type ComposerVerdict = 'plain' | 'mode' | 'busy' | 'unknown';

export interface DeliveryFrame {
  /** The visible grid (with undimmed copies where dim text is blanked). */
  rows: ChatScreenRows;
  /** Index into `rows` of the cursor's row, or -1 when unknown. */
  cursorRow: number;
}

export interface ComposerRead {
  verdict: ComposerVerdict;
  /** The composer's own rows: its prompt row up to (not including) its closing chrome. */
  span?: { from: number; to: number };
}

const CLAUDE_RULE = /^─{8,}$/;
/** A labelled top rule (`──── ide ─────`), as deliverChatPrompt's reader accepts. */
const CLAUDE_LABELLED_RULE = /^─{8,} \S(?:.*\S)? ─+$/;
/** Claude's prompt row: `❯` (plain), or the mode glyph where `❯` stands, then a no-break space. */
const CLAUDE_PROMPT = /^([❯!#])(?:[ \u00a0]|$)/;
/** The hint Claude draws under the composer in a mode (`  ! for shell mode`). */
const CLAUDE_MODE_HINT = /^\s*(?:! for (?:shell|bash) mode|# to memorize)\b/;
/** The session survey's choices (`1: Bad    2: Fine   3: Good   0: Dismiss`): it takes a digit typed at an empty prompt. */
const CLAUDE_SURVEY_CHOICES = /\b1: Bad\s+2: Fine\s+3: Good\s+0: Dismiss\b/;
/** How far above the composer's top rule the survey is looked for (its choices, a blank row, a notice row). */
const CLAUDE_SURVEY_ROWS = 4;

function lastIndex(rows: readonly string[], test: (row: string) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i])) return i;
  return -1;
}

/** Dialog evidence in some rows only (screenBlocksChatSend reads an all-blank grid as blocked). */
const blocks = (rows: readonly string[]): boolean => rows.some((row) => row.trim()) && screenBlocksChatSend(rows);

/** Rows `from`..`to` (exclusive) of a frame, with their undimmed copies. */
function slice(rows: ChatScreenRows, from: number, to: number): ChatScreenRows {
  return Object.assign(rows.slice(from, to), rows.undimmed ? { undimmed: rows.undimmed.slice(from, to) } : {});
}

/**
 * Claude's composer: the last prompt row (any glyph) under a rule, its
 * indented continuation rows, and the closing rule, the prompt row and both
 * rules at column 0 (every captured Claude frame draws them there; Claude
 * indents the transcript, so text it prints cannot forge them). Only the
 * composer and the rows under it decide: a transcript above that quotes a
 * dialog's footer or a mode's hint is not the pane's state, and neither is
 * the text this delivery pasted into the composer. The one exception is the
 * session survey, drawn right over the top rule: it refuses, never admits.
 *
 * The frame is the ring's replay, so a row Claude drew before the ring's
 * oldest byte and never redrew reads blank (outputModeTracker's preamble). A
 * missing closing rule is then no composer, never an empty one: a draft's
 * cells can be missing the same way.
 */
function readClaude(rows: ChatScreenRows, phase: DeliveryPhase): ComposerRead {
  const read = readClaudeRows(rows, phase);
  // A blank the read could not see may be a draft's text or a dialog's row: no
  // evidence of a plain prompt, from the composer's top rule down.
  if (read.verdict !== 'mode' && read.span && unseenFrom(rows, read.span.from - 1)) return { verdict: 'unknown' };
  return read;
}

function readClaudeRows(rows: ChatScreenRows, phase: DeliveryPhase): ComposerRead {
  if (rows.every((row) => !row.trim())) return { verdict: 'unknown' };
  const isRule = (row: string): boolean => CLAUDE_RULE.test(row.trimEnd());
  const isTopRule = (row: string | undefined): boolean => row !== undefined && (isRule(row) || CLAUDE_LABELLED_RULE.test(row.trimEnd()));
  /** The closing rule of a prompt row at `at`, past its indented continuation rows; -1 if none. */
  const closing = (at: number): number => {
    const end = rows.findIndex((row, i) => i > at && isRule(row));
    return end > at && rows.slice(at + 1, end).every((row) => !row.trim() || /^\s{2}/.test(row)) ? end : -1;
  };
  let from = -1;
  let to = -1;
  for (let i = rows.length - 1; i > 0 && from < 0; i--) {
    if (!CLAUDE_PROMPT.test(rows[i]) || !isTopRule(rows[i - 1])) continue;
    const end = closing(i);
    if (end > 0) [from, to] = [i, end];
  }
  // No composer on screen: a dialog owns it, or nothing that is Claude's.
  if (from < 0) return { verdict: blocks(rows) ? 'mode' : 'unknown' };
  const span = { from, to };
  const glyph = CLAUDE_PROMPT.exec(rows[from])?.[1];
  const below = rows.slice(to + 1);
  // The survey draws over the composer's top rule, so the rows right above it
  // decide too. It takes a digit at an empty prompt only: at the Enter the
  // prompt holds this delivery's paste, and the Enter submits it.
  const survey = phase === 'paste' && rows.slice(Math.max(0, from - 1 - CLAUDE_SURVEY_ROWS), from - 1).some((row) => CLAUDE_SURVEY_CHOICES.test(row));
  if (glyph !== '❯' || survey || below.some((row) => CLAUDE_MODE_HINT.test(row)) || blocks(below)) return { verdict: 'mode', span };
  if (phase === 'enter') return { verdict: 'plain', span };
  // The composer alone, from its top rule to its closing rule.
  const own = slice(rows, from - 1, to + 1);
  if (!claudeComposerRows(own)) return { verdict: 'unknown' };
  return { verdict: claudeComposerEmpty(own) ? 'plain' : 'busy', span };
}

const isCodexChrome = (row: string): boolean => CODEX_FOOTER.test(row) || CODEX_SHORTCUT_HINT.test(row) || CODEX_SCROLLED_HINT.test(row);

/** Codex's composer: the last `›` row down to its own footer or hint; rows
 *  under that (a tmux status line) are not the composer's. */
function readCodex(rows: ChatScreenRows, phase: DeliveryPhase): ComposerRead {
  if (rows.every((row) => !row.trim())) return { verdict: 'unknown' };
  const tail = rows.map((row) => row.trimEnd());
  const from = lastIndex(tail, (row) => /^\s*›(?: |$)/.test(row));
  const firstChrome = from < 0 ? -1 : tail.slice(from + 1).findIndex(isCodexChrome);
  if (firstChrome < 0) return { verdict: codexScreenBlocked(rows) ? 'mode' : 'unknown' };
  const span = { from, to: from + 1 + firstChrome };
  // An overlay that waits for esc draws under the composer, never in the transcript.
  if (codexScreenBlocked(slice(rows, span.to, rows.length))) return { verdict: 'mode', span };
  // A blank the read could not see, from the prompt row down: no evidence either way.
  if (unseenFrom(rows, span.from)) return { verdict: 'unknown' };
  if (phase === 'enter') return { verdict: 'plain', span };
  // Anything between the prompt row and the chrome is a draft's rows or a popup.
  const between = tail.slice(from + 1, span.to).filter((row) => row.trim());
  const prompt = rows.undimmed?.[from]?.trimEnd() ?? tail[from];
  const empty = rows.undimmed ? /^\s*›$/.test(prompt) : /^\s*›(?: Ask Codex to do anything)?\s*$/.test(prompt);
  return { verdict: empty && between.length === 0 ? 'plain' : 'busy', span };
}

const PLAIN_PROMPT = { claude: readClaude, codex: readCodex } satisfies Partial<Record<AgentSlug, (rows: ChatScreenRows, phase: DeliveryPhase) => ComposerRead>>;

/** An agent whose plain prompt wmux can recognise: it gets the full text. */
export type PlainPromptAgent = keyof typeof PLAIN_PROMPT;

export function hasPlainPrompt(slug: AgentSlug): slug is PlainPromptAgent {
  return Object.hasOwn(PLAIN_PROMPT, slug);
}

export function readComposer(frame: DeliveryFrame | null, slug: PlainPromptAgent, phase: DeliveryPhase): ComposerRead {
  if (!frame) return { verdict: 'unknown' };
  return PLAIN_PROMPT[slug](frame.rows, phase);
}

/** A delivery frame from a screen read whose unknown cells carry UNKNOWN_CELL (chatScreenRowsOf). */
export function deliveryFrameOf(read: readonly { text: string; undimmed?: string }[], rowsBelowCursor: number): DeliveryFrame {
  const rows = chatScreenRowsOf(read);
  return { rows, cursorRow: rows.length - 1 - rowsBelowCursor };
}

/** The cursor sits on the composer's own rows: a frame being drawn now, not a leftover. */
export function cursorInComposer(frame: DeliveryFrame, read: ComposerRead): boolean {
  return !!read.span && frame.cursorRow >= read.span.from && frame.cursorRow < read.span.to;
}


/** What a delivery pasted: the start of its first non-blank line, its line
 *  breaks and its characters, and the whole text when the caller sent it. */
export interface PastedText {
  probe: string;
  lines?: number;
  chars?: number;
  text?: string;
}

/** Text without its whitespace: the composer wraps long lines and indents its
 *  continuation rows, so only the other characters can be compared. */
const squash = (text: string): string => text.replace(/\s+/g, '');

/** How each agent shows a long paste in its composer: Claude
 *  `[Pasted text #1 +40 lines]` (the rows it takes) or `[Pasted text #2]` (one
 *  long line), Codex `[Pasted Content 4096 chars]`. Matched with whitespace
 *  removed (see `squash`): the composer may wrap one over rows. */
const SQUASHED_PLACEHOLDER = /\[Pasted(?:text#\d+(?:\+\d+lines)?\]|Content\d+chars\])/g;

/** The narrowest input box a count is allowed for: a text of `chars` characters takes no more rows than that. */
const NARROWEST_BOX_COLS = 8;

/**
 * Is `placeholder` (squashed) the collapsed form of `pasted`? Only the agent's own count of it says so. Claude's
 * `+N lines` counts the rows the text takes in its box, so a narrow box counts more than the text's line breaks,
 * never fewer, and no more than its characters can fill at `NARROWEST_BOX_COLS`, each counted as two columns (a
 * double-width character takes two). Without the character count, the line breaks alone. Codex counts characters.
 */
function collapsedFormOf(placeholder: string, pasted: PastedText): boolean {
  const claude = /^\[Pastedtext#\d+(?:\+(\d+)lines)?\]$/.exec(placeholder);
  if (claude) {
    if (pasted.lines === undefined) return false;
    const rows = Number(claude[1] ?? 0);
    if (pasted.chars === undefined) return rows === pasted.lines;
    return rows >= pasted.lines && rows <= pasted.lines + Math.ceil((2 * pasted.chars) / NARROWEST_BOX_COLS);
  }
  const codex = /^\[PastedContent(\d+)chars\]$/.exec(placeholder);
  return !!codex && pasted.chars !== undefined && Number(codex[1]) === pasted.chars;
}

/** The fewest characters (spaces aside) a scrolled composer must show of a text's end to count as showing it. */
const SCROLLED_TAIL_MIN = 24;

/** Claude's placeholder with its start scrolled out of a narrow box: the end of `[Pasted text #<n>`, then `+<m>lines]`. */
const SCROLLED_CLAUDE_PLACEHOLDER = /^(\D*)(\d*)\+(\d+)lines\]$/;

/**
 * Is `shown` (squashed) the end of Claude's `[Pasted text #<n> +<m> lines]`, at least its `+<m>lines]`, with `m`
 * this paste's count? A narrow box that also draws a hint under itself shrinks and scrolls the placeholder's start
 * out of view.
 */
function scrolledPlaceholderOf(shown: string, pasted: PastedText): boolean {
  const tail = SCROLLED_CLAUDE_PLACEHOLDER.exec(shown);
  if (!tail) return false;
  const [, head, digits, rows] = tail;
  // Either digits of `<n>` alone (or nothing), or a cut of `[Pastedtext#` followed by all of `<n>`.
  if (head && (!'[Pastedtext#'.endsWith(head) || !digits)) return false;
  return collapsedFormOf(`[Pastedtext#${digits || '1'}+${rows}lines]`, pasted);
}

/**
 * Does the pane still show what this delivery pasted, where it would sit, and
 * only that? In a recognised composer, on its own rows: the text's start, or
 * the agent's collapsed form of it carrying this paste's own count, and no
 * other collapsed paste (someone else's). With no composer (a shell took
 * over), on the cursor's row. Anywhere else (the transcript above) proves
 * nothing, and "no" leaves the text where it is rather than clearing or
 * submitting someone's input.
 */
export function frameShowsPaste(frame: DeliveryFrame | null, pasted: PastedText): boolean {
  if (!frame || !pasted.probe) return false;
  const span = (Object.keys(PLAIN_PROMPT) as PlainPromptAgent[])
    .map((slug) => PLAIN_PROMPT[slug](frame.rows, 'enter').span)
    .find((found) => found !== undefined);
  if (!span) return frame.cursorRow >= 0 && (frame.rows[frame.cursorRow] ?? '').includes(pasted.probe);
  const rows = frame.rows.slice(span.from, span.to);
  // The input without the prompt glyph, its rows joined as the composer wraps them.
  const content = rows.map((row, i) => (i === 0 ? row.replace(/^\s*[❯›][ \u00a0]*/, '') : row).trim()).filter(Boolean);
  const shown = squash(content.join(''));
  const placeholders = shown.match(SQUASHED_PLACEHOLDER) ?? [];
  if (placeholders.length > 1) return false;
  // The collapsed paste is the whole input: the prompt glyph, it (on one row or wrapped), and blank rows.
  if (placeholders.length === 1) return shown === placeholders[0] && collapsedFormOf(placeholders[0], pasted);
  if (scrolledPlaceholderOf(shown, pasted)) return true;
  // Uncollapsed, the whole input is this text and nothing else. A narrow box
  // scrolls a long text: then it shows the text's end, and only that, enough
  // of it to be this text's. Without the text, its start on some row.
  if (pasted.text !== undefined) {
    const whole = squash(pasted.text);
    return shown === whole || (shown.length >= Math.min(whole.length, SCROLLED_TAIL_MIN) && whole.endsWith(shown));
  }
  return rows.some((row) => row.includes(pasted.probe));
}
