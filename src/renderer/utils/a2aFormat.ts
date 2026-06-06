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
): string {
  const priLine = priority && priority !== 'normal' ? ` [Priority: ${priority.toUpperCase()}]` : '';
  return [
    '',
    `━━━ WMUX A2A${priLine} ━━━`,
    `From: ${safeName(from)}`,
    `To: ${safeName(to)}`,
    '',
    safeBody(message).trimEnd(),
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
): string {
  const priLine = priority && priority !== 'normal' ? ` [Priority: ${priority.toUpperCase()}]` : '';
  return [
    '',
    `━━━ WMUX A2A BROADCAST${priLine} ━━━`,
    `From: ${safeName(from)}`,
    '',
    safeBody(message).trimEnd(),
    `━━━ END ━━━`,
    '',
  ].join('\n');
}
