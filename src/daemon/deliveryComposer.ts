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
/** Claude's prompt row in a mode: the mode glyph where `❯` stands, then a no-break space. */
const CLAUDE_MODE_PROMPT = /^[!#](?:\u00a0|$)/;
/** The hint Claude draws under the composer in a mode (`  ! for shell mode`). */
const CLAUDE_MODE_HINT = /^\s*(?:! for (?:shell|bash) mode|# to memorize)\b/;

function lastIndex(rows: readonly string[], test: (row: string) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i])) return i;
  return -1;
}

function readClaude(rows: ChatScreenRows, phase: DeliveryPhase): ComposerRead {
  // A mode prompt directly under a rule, or a mode's hint row: named refusals.
  const modeAt = lastIndex(rows, (row) => CLAUDE_MODE_PROMPT.test(row.replace(/^ +/, '')));
  if (modeAt > 0 && CLAUDE_RULE.test(rows[modeAt - 1].trim())) return { verdict: 'mode' };
  if (rows.some((row) => CLAUDE_MODE_HINT.test(row))) return { verdict: 'mode' };
  if (rows.every((row) => !row.trim())) return { verdict: 'unknown' };
  if (screenBlocksChatSend(rows)) return { verdict: 'mode' };
  const shown = claudeComposerRows(rows);
  if (!shown) return { verdict: 'unknown' };
  const from = lastIndex(rows, (row) => /^❯(?:\s|$)/.test(row.trim()));
  const to = rows.findIndex((row, i) => i > from && CLAUDE_RULE.test(row.trim()));
  const span = { from, to };
  if (phase === 'enter') return { verdict: 'plain', span };
  return { verdict: claudeComposerEmpty(rows) ? 'plain' : 'busy', span };
}

const isCodexChrome = (row: string): boolean => CODEX_FOOTER.test(row) || CODEX_SHORTCUT_HINT.test(row) || CODEX_SCROLLED_HINT.test(row);

function readCodex(rows: ChatScreenRows, phase: DeliveryPhase): ComposerRead {
  if (rows.every((row) => !row.trim())) return { verdict: 'unknown' };
  if (codexScreenBlocked(rows)) return { verdict: 'mode' };
  const tail = rows.map((row) => row.trimEnd());
  const from = lastIndex(tail, (row) => /^\s*›(?: |$)/.test(row));
  if (from < 0) return { verdict: 'unknown' };
  // The composer ends at its own footer or hint; rows under that (a tmux
  // status line) are not the composer's.
  const after = tail.slice(from + 1);
  const firstChrome = after.findIndex(isCodexChrome);
  if (firstChrome < 0) return { verdict: 'unknown' };
  const span = { from, to: from + 1 + firstChrome };
  if (phase === 'enter') return { verdict: 'plain', span };
  // Anything between the prompt row and the chrome is a draft's rows or a popup.
  const between = after.slice(0, firstChrome).filter((row) => row.trim());
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

/**
 * Does the frame still show what this delivery pasted? `probe` is the start of
 * its first non-blank line; Claude shows a long paste as `[Pasted text #N …]`.
 */
export function frameShowsPaste(frame: DeliveryFrame | null, probe: string): boolean {
  if (!frame || !probe) return false;
  return frame.rows.some((row) => row.includes(probe) || /\[Pasted text #\d+/.test(row));
}
