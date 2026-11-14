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
  codexScreenBlocked,
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
 * the text this delivery pasted into the composer.
 */
function readClaude(rows: ChatScreenRows, phase: DeliveryPhase): ComposerRead {
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
  if (glyph !== '❯' || below.some((row) => CLAUDE_MODE_HINT.test(row)) || blocks(below)) return { verdict: 'mode', span };
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

/** The cursor sits on the composer's own rows: a frame being drawn now, not a leftover. */
export function cursorInComposer(frame: DeliveryFrame, read: ComposerRead): boolean {
  return !!read.span && frame.cursorRow >= read.span.from && frame.cursorRow < read.span.to;
}

/** How each agent shows a long paste in its composer: Claude
 *  `[Pasted text #1 +40 lines]`, Codex `[Pasted Content 4096 chars]`. */
const PASTE_PLACEHOLDER = /\[Pasted (?:text #\d+|Content \d+ chars)/;

/**
 * Does the pane still show what this delivery pasted, where it would sit? In a
 * recognised composer, on the composer's own rows; with none (a shell took
 * over), on the cursor's row. `probe` is the start of its first non-blank
 * line. Anywhere else (the transcript above) proves nothing, and "no" leaves
 * the text where it is rather than clearing someone's line.
 */
export function frameShowsPaste(frame: DeliveryFrame | null, probe: string): boolean {
  if (!frame || !probe) return false;
  const span = (Object.keys(PLAIN_PROMPT) as PlainPromptAgent[])
    .map((slug) => PLAIN_PROMPT[slug](frame.rows, 'enter').span)
    .find((found) => found !== undefined);
  const rows = span ? frame.rows.slice(span.from, span.to) : frame.rows.slice(Math.max(frame.cursorRow, 0), frame.cursorRow + 1);
  return rows.some((row) => row.includes(probe) || (span !== undefined && PASTE_PLACEHOLDER.test(row)));
}
