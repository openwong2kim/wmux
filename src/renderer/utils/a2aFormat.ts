import { sanitizePtyText } from '../../shared/types';

export type A2aPriority = 'low' | 'normal' | 'high';

function safeName(name: string): string {
  return sanitizePtyText(name).slice(0, 100);
}

function safeBody(message: string): string {
  return sanitizePtyText(message);
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
