// ─── Message Templates ────────────────────────────────────────────────────────
// Structured message formatting for inter-member IPC communication.

import { sanitizePtyText } from '../../shared/types';

export type MessagePriority = 'low' | 'normal' | 'high';

/**
 * Strip control characters from names/message content that will be
 * embedded into PTY-bound text to prevent injection of extra commands.
 *
 * `sanitizePtyText` alone only removes NULL and C1 control bytes; it
 * deliberately keeps `\r`, `\n`, `\t`, and ESC so that legitimate PTY
 * output can round-trip. For the A2A envelope that is written into a
 * peer's PTY those characters are the attack surface — a `\n` in the
 * body submits an extra line to the peer's shell/Claude stdin, a `\r`
 * can forge `From:`/`To:` envelope lines over the real header, and a
 * raw CSI sequence (`\x1b[...`) can rewrite the receiver's screen.
 * Scrub them here before the envelope assembly. The outer `\n`
 * delimiters in `formatMessage` are added after this sanitiser runs,
 * so envelope structure is preserved.
 */
// eslint-disable-next-line no-control-regex
const ESC_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESC_OTHER_RE = /\x1b[@-_]/g;

function stripEscapes(input: string): string {
  return input.replace(ESC_CSI_RE, '').replace(ESC_OTHER_RE, '');
}

function safeName(name: string): string {
  return stripEscapes(sanitizePtyText(name))
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 100);
}

function safeBody(message: string): string {
  return stripEscapes(sanitizePtyText(message))
    .replace(/\r/g, '')
    .replace(/\n/g, '\u2424'); // U+2424 SYMBOL FOR NEWLINE — visible, non-submitting
}

/**
 * Wraps a raw message in a structured WMUX envelope so the receiving agent
 * can clearly identify the sender, recipient, and priority without the text
 * bleeding into whatever the agent is currently typing.
 *
 * Uses Unicode box-drawing characters (━) as delimiters — these never appear
 * in normal agent output or system prompts, making it impossible to
 * accidentally trigger routing pattern matching.
 *
 * Example output:
 *   ━━━ FMUX MESSAGE [Priority: HIGH] ━━━
 *   From: CEO
 *   To: FE Dev
 *
 *   Please review the auth module.
 *   ━━━ END ━━━
 */
export function formatMessage(
  from: string,
  to: string,
  message: string,
  priority?: MessagePriority,
): string {
  const priLine = priority && priority !== 'normal' ? ` [Priority: ${priority.toUpperCase()}]` : '';
  return [
    '',
    `━━━ FMUX MESSAGE${priLine} ━━━`,
    `From: ${safeName(from)}`,
    `To: ${safeName(to)}`,
    '',
    safeBody(message).trimEnd(),
    `━━━ END ━━━`,
    '',
  ].join('\n');
}

/**
 * Broadcast variant — no specific recipient; delivered to all agents in the
 * workspace. Uses the same Unicode box-drawing delimiter scheme as
 * `formatMessage` to prevent routing pattern collisions.
 *
 * Example output:
 *   ━━━ FMUX BROADCAST [Priority: HIGH] ━━━
 *   From: CEO
 *
 *   All hands on deck.
 *   ━━━ END ━━━
 */
export function formatBroadcast(
  from: string,
  message: string,
  priority?: MessagePriority,
): string {
  const priLine = priority && priority !== 'normal' ? ` [Priority: ${priority.toUpperCase()}]` : '';
  return [
    '',
    `━━━ FMUX BROADCAST${priLine} ━━━`,
    `From: ${safeName(from)}`,
    '',
    safeBody(message).trimEnd(),
    `━━━ END ━━━`,
    '',
  ].join('\n');
}
