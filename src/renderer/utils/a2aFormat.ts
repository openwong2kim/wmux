import { sanitizePtyText } from '../../shared/types';

export type A2aPriority = 'low' | 'normal' | 'high';

/**
 * Strip control characters from names/message content that will be
 * embedded into PTY-bound text to prevent injection of extra commands.
 *
 * `sanitizePtyText` preserves CR/LF/TAB/ESC for ordinary terminal writes.
 * Inter-agent envelopes are different: sender-controlled CR/LF can split the
 * envelope into extra PTY input lines, and raw ESC can forge terminal control
 * sequences or bracketed-paste boundaries. The envelope's own separators are
 * added after these helpers run, so message structure remains intact.
 */
// eslint-disable-next-line no-control-regex
const ESC_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESC_OTHER_RE = /\x1b[@-_]/g;

// Repeat until nothing changes: removing one sequence can join the bytes
// around it into a new one (`\x1b\x1b@[201~` → `\x1b[201~`).
function stripEscapes(input: string): string {
  let out = input;
  for (;;) {
    const next = out.replace(ESC_CSI_RE, '').replace(ESC_OTHER_RE, '');
    if (next === out) return out;
    out = next;
  }
}

/**
 * Sanitize a sender/receiver name for embedding into PTY-bound text: strip
 * escapes, collapse CR/LF/TAB to spaces (so it can never break out of a single
 * line), and cap length. Exported so the single-line A2A nudge path
 * (buildA2aNudge) enforces the same one-line invariant as the full envelope.
 */
export function sanitizeA2aName(name: string): string {
  return stripEscapes(sanitizePtyText(name))
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 100);
}

function safeName(name: string): string {
  return sanitizeA2aName(name);
}

// CR is dropped BEFORE escapes are stripped: dropped after, `\x1b\r[201~`
// would pass the scan and then close up into `\x1b[201~`.
function safeBody(message: string): string {
  return stripEscapes(sanitizePtyText(message).replace(/\r/g, ''))
    .replace(/\n/g, '\u2424');
}

/**
 * Prefix carried by every body line when real newlines are kept. With the
 * body spread over several lines, a sender could otherwise write its own
 * `━━━ END ━━━` line followed by a fresh `━━━ WMUX A2A ━━━` / `From:` / `To:`
 * block and forge a second envelope from someone else. A line that starts
 * with this prefix can never be read as a delimiter or header line, so the
 * guard needs no list of patterns to keep in sync with the envelope.
 */
export const A2A_BODY_LINE_PREFIX = '│ ';

function safeMultilineBody(message: string): string {
  return stripEscapes(sanitizePtyText(message).replace(/\r/g, ''))
    .trimEnd()
    .split('\n')
    .map((line) => `${A2A_BODY_LINE_PREFIX}${line}`)
    .join('\n');
}

export interface A2aFormatOptions {
  /**
   * Keep the body's line breaks as real newlines (each line prefixed with
   * {@link A2A_BODY_LINE_PREFIX}) instead of folding them into `␤`. Only for a
   * receiver that is a detected agent TUI: a shell would run each body line as
   * its own command once the paste is submitted. Default: fold.
   */
  multiline?: boolean;
}

function formatBody(message: string, opts: A2aFormatOptions): string {
  return opts.multiline ? safeMultilineBody(message) : safeBody(message).trimEnd();
}

/**
 * Wraps an A2A message in a structured envelope with Unicode box-drawing
 * delimiters (━) so the receiving agent can clearly identify it.
 *
 *   ━━━ WMUX A2A [Priority: HIGH] ━━━
 *   From: Workspace 1
 *   To: Workspace 2
 *
 *   Please check the build output.
 *   ━━━ END ━━━
 */
export function formatA2aMessage(
  from: string,
  to: string,
  message: string,
  priority?: A2aPriority,
  opts: A2aFormatOptions = {},
): string {
  const priLine = priority && priority !== 'normal' ? ` [Priority: ${priority.toUpperCase()}]` : '';
  return [
    '',
    `━━━ WMUX A2A${priLine} ━━━`,
    `From: ${safeName(from)}`,
    `To: ${safeName(to)}`,
    '',
    formatBody(message, opts),
    `━━━ END ━━━`,
    '',
  ].join('\n');
}

/**
 * Broadcast variant — delivered to all workspaces.
 *
 *   ━━━ WMUX A2A BROADCAST [Priority: HIGH] ━━━
 *   From: Workspace 1
 *
 *   All workspaces: please pull latest.
 *   ━━━ END ━━━
 */
export function formatA2aBroadcast(
  from: string,
  message: string,
  priority?: A2aPriority,
  opts: A2aFormatOptions = {},
): string {
  const priLine = priority && priority !== 'normal' ? ` [Priority: ${priority.toUpperCase()}]` : '';
  return [
    '',
    `━━━ WMUX A2A BROADCAST${priLine} ━━━`,
    `From: ${safeName(from)}`,
    '',
    formatBody(message, opts),
    `━━━ END ━━━`,
    '',
  ].join('\n');
}
