// ─── Message Templates ────────────────────────────────────────────────────────
// Structured message formatting for inter-member IPC communication.

import { sanitizePtyText } from '../../shared/types';

export type MessagePriority = 'low' | 'normal' | 'high';

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
    .replace(/\n/g, '\u2424');
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
 *   ━━━ WMUX MESSAGE [Priority: HIGH] ━━━
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
    `━━━ WMUX MESSAGE${priLine} ━━━`,
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
 *   ━━━ WMUX BROADCAST [Priority: HIGH] ━━━
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
    `━━━ WMUX BROADCAST${priLine} ━━━`,
    `From: ${safeName(from)}`,
    '',
    safeBody(message).trimEnd(),
    `━━━ END ━━━`,
    '',
  ].join('\n');
}
