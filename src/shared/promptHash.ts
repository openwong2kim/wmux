// The hash a delivered prompt is recognized by in an agent's transcript, shared
// by the daemon (headless delivery, the linked-pane turn tracker) and main (the
// submit proof of a gated delivery).
//
// Node-only (node:crypto): the renderer never imports this module.

import crypto from 'node:crypto';
import { sanitizeBracketedPastePayload } from './ptyMessageDelivery';
import { normalizeForPromptMatch } from './promptMatch';

/**
 * The hash a delivered prompt is recognized by in the transcript. Both sides
 * are compared in the shared normal form (shared/promptMatch.ts): Claude Code
 * stores a long or multi-line prompt inside paste markers with line breaks
 * around them.
 */
export function promptHash(prompt: string): string {
  return hashOf(normalizeForPromptMatch(sanitizeBracketedPastePayload(prompt)));
}

/** The hash of a transcript user entry, in the same form as promptHash. */
export function userEntryHash(text: string): string {
  return hashOf(normalizeForPromptMatch(text));
}

function hashOf(text: string): string {
  return crypto.createHash('sha256').update(text.replace(/\r\n?/g, '\n').trim()).digest('hex');
}
