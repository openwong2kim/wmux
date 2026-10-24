// Masks credentials inside free text before it is written to a log or shown
// in a report: the inline URL credentials the IPC log already masks
// (main/ipc/wrapHandler.ts), and key-shaped values — OpenAI/Anthropic `sk-…`,
// GitHub `ghp_…`/`github_pat_…`, AWS `AKIA…`/`ASIA…`, Slack `xox?-…`, private
// key headers, a long random string after a key/secret/token/password name,
// and any other long random-looking token — plus every key shape the outbound
// secret guard blocks (shared/secretGuard.ts KEY_RULES), so a key that cannot
// be committed is not logged either. Pure, no Node imports, so main, the
// daemon and the CLI share it.

import { KEY_RULES } from './secretGuard';

export const REDACTED = '[redacted]';

/**
 * Credentials that ride INSIDE a string — a query `token=`/`code=` or the
 * computer pairing link's `#wmux-desktop-code=` fragment.
 */
const INLINE_CREDENTIAL = /([?&#](?:token|code|wmux-desktop-code)=)(?!%5Bredacted%5D|\[redacted\])[^&#\s"'\\]+/gi;
/**
 * The password of a URL's userinfo (`scheme://user:password@host`); the user
 * name stays. The userinfo ends at the LAST `@` before the host, so a raw `@`
 * inside the password is masked with the rest of it.
 */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)(?!\[redacted\]@)[^\s/?#]+(?=@[^\s/?#@]*(?:[\s/?#]|$))/gi;

export function maskInlineCredentials(s: string): string {
  return s.replace(INLINE_CREDENTIAL, '$1[redacted]').replace(URL_PASSWORD, '$1[redacted]');
}

const KEY_SHAPES: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  // wmux's own bearer credentials: a guest bot's and an A2A peer's
  // (`wmuxguest~<id>~<secret>`, `wmuxpeer~<id>~<secret>`).
  /\bwmux(?:guest|peer)~[A-Za-z0-9_-]+~[A-Za-z0-9_-]+/g,
];

/** Applied after everything above, so they only ever mask more: the guard's
 *  key shapes, Google API keys and JWTs. */
const MORE_SHAPES: readonly RegExp[] = [
  ...KEY_RULES.map(([, re]) => new RegExp(re.source, 'g')),
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** `name = value` where the name says secret; the value is masked. */
const ASSIGNED = /((?:key|secret|token|passw(?:or)?d|pwd|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*["'`]?)([^\s"'`]{8,})/gi;

/** A long run of token characters; masked when it looks random. */
const LONG_TOKEN = /[A-Za-z0-9+/_\-=.]{24,}/g;

function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

function looksRandom(s: string): boolean {
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s) && entropy(s) >= 3.5;
}

/** `s` with every credential it carries replaced by [redacted]. */
export function redactSecrets(s: string): string {
  return redactSecretsCounted(s).text;
}

/**
 * `redactSecrets`, also saying how many values it masked. `keyShapesOnly`
 * leaves out the long-random-token rule, which also takes branch names and
 * paths with digits in them (`feat/p1-7-remote-handoff-v2`): for text whose
 * long runs are names, not prose that may hide a bare key.
 */
export function redactSecretsCounted(s: string, opts: { keyShapesOnly?: boolean } = {}): { text: string; masked: number } {
  let masked = 0;
  const mask = (m: string, keep = ''): string => {
    masked++;
    return `${keep}${REDACTED}`;
  };
  let out = s
    .replace(INLINE_CREDENTIAL, (_m, keep: string) => mask(_m, keep))
    .replace(URL_PASSWORD, (_m, keep: string) => mask(_m, keep));
  for (const re of KEY_SHAPES) out = out.replace(re, (m) => mask(m));
  out = out.replace(ASSIGNED, (m, name: string, value: string) => (value === REDACTED ? m : mask(m, name)));
  if (!opts.keyShapesOnly) out = out.replace(LONG_TOKEN, (m) => (m.includes(REDACTED) || !looksRandom(m) ? m : mask(m)));
  for (const re of MORE_SHAPES) out = out.replace(re, (m) => mask(m));
  return { text: out, masked };
}
