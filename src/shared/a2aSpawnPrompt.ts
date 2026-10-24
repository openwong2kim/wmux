// The exact text a remote spawn's first prompt is sent as. The "Start an
// agent…" dialog shows it before sending, and main runs it again and refuses
// a prompt it would change, so the person always saw the bytes that leave:
//   - format characters that reorder or hide text (bidi controls) go;
//   - sanitizeRemoteMessage, as the request gets it anyway (controls, CRLF,
//     a line that reads like wmux's own `[wmux] …` is quoted);
//   - credentials are masked (redactSecretsCounted, readableNames: a long run
//     is masked only when a part of it looks random, so branch names and
//     paths stay readable).
// It is a fixed point: running it on its own result changes nothing.
//
// Pure module: no node:* imports (the renderer imports it).

import { sanitizeRemoteMessage } from './a2aRemoteDelivery';
import { redactSecretsCounted } from './redactSecrets';

/** Bidi embeddings, overrides and isolates, and the marks that steer them. */
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;

export function stripBidi(s: string): string {
  return s.replace(BIDI_RE, '');
}

/** `text` as a spawn request sends it, and how many values were masked on the way. */
export function finalizeSpawnPrompt(text: string): { text: string; masked: number } {
  return redactSecretsCounted(sanitizeRemoteMessage(stripBidi(text)), { readableNames: true });
}
