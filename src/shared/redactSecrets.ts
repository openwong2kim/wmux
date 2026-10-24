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
 * Credentials that ride INSIDE a string: a query or fragment parameter named
 * for one (`token=`, `code=`, `access_token=`, `api_key=`, `password=`, AWS
 * pre-signed `X-Amz-Signature=` / `-Credential=` / `-Security-Token=`, …) or
 * the computer pairing link's `#wmux-desktop-code=` fragment.
 */
const INLINE_CREDENTIAL = /([?&#](?:token|code|wmux-desktop-code|access_token|refresh_token|id_token|api[_-]?key|apikey|password|passwd|pwd|secret|client_secret|sig|signature|auth|x-amz-signature|x-amz-credential|x-amz-security-token)=)(?!%5Bredacted%5D|\[redacted\])[^&#\s"'\\]+/gi;
/**
 * The userinfo of a URL (`scheme://user:password@host`). None of the parts
 * crosses a quote or bracket, and the user and host also stop at a comma,
 * semicolon or parenthesis, so a URL inside JSON or a log line does not run
 * into the text after it. A password may hold `,` `;` `(` `)` (RFC 3986
 * sub-delims), so those never cut it short. The userinfo ends at the LAST `@`
 * before the host, so a raw `@` inside the password is masked with the rest;
 * a raw `/`, `?` or `#` ends the authority (RFC 3986) and cannot be told from
 * a path, so it is not read as part of a password.
 */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:"'<>[\]{}(),;]*:)(?!\[redacted\]@)[^\s/?#"'<>[\]{}]+(?=@[^\s/?#@"'<>[\]{}(),;]*(?:[\s/?#"'<>[\]{}(),;]|$))/gi;
/** A userinfo with no password (`https://<token>@host`): masked when it looks like a key, so `git@` stays. */
const URL_USER_TOKEN = /(\b[a-z][a-z0-9+.-]*:\/\/)(?!\[redacted\]@)([^\s/?#@:"'<>[\]{}(),;]{16,})(?=@)/gi;

export function maskInlineCredentials(s: string): string {
  return s
    .replace(INLINE_CREDENTIAL, '$1[redacted]')
    .replace(URL_PASSWORD, '$1[redacted]')
    .replace(URL_USER_TOKEN, (m, keep: string, user: string) => (looksRandom(user) ? `${keep}${REDACTED}` : m));
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

/**
 * A bare run of 32+ hex digits in one case, with both digits and letters, not
 * inside a word. Entropy alone lets some random hex through (hex tops out at
 * four bits a character), so hex has a rule of its own. A 40-digit run is a
 * git commit unless a key word sits right before it.
 */
const HEX_RUN = /(?<![A-Za-z0-9_])(?:[0-9a-f]{32,}|[0-9A-F]{32,})(?![A-Za-z0-9_])/g;
/**
 * A word that says the value right after it is a credential, with only a
 * separator between (`token: `, `Bearer `, `api_key=`). Adjacent on purpose:
 * a wider window would see a different word once earlier values are masked,
 * and the pass would stop being a fixed point.
 */
const KEY_WORD_BEFORE = /(?:token|key|secret|api|auth|passw(?:or)?d|bearer)[\s:=_"'-]{0,3}$/i;
const isHex40 = (s: string): boolean => /^[0-9a-fA-F]{40}$/.test(s);

/**
 * A part of a name: short, or mostly lower case with few digits, the way path
 * parts and branch words read (`spawnRequester`, `handoff`, `2026`). A random
 * token's parts are mixed case or digit-heavy (`tAnLEMyQw2Fw`, `0b5f6a7e`).
 */
function wordlike(part: string): boolean {
  if (part.length < 8) return true;
  const letters = (part.match(/[A-Za-z]/g) ?? []).length;
  const upper = (part.match(/[A-Z]/g) ?? []).length;
  const digits = (part.match(/[0-9]/g) ?? []).length;
  return letters > 0 && upper <= letters * 0.25 && digits <= part.length * 0.25;
}

/**
 * readableNames: a long run is masked when one part of 16+ characters looks
 * random, or when the whole run looks random and is not shaped like a name
 * (every part wordlike). A 40-hex run (a git commit) is left to HEX_RUN.
 */
function longRandomReadable(m: string): boolean {
  if (isHex40(m)) return false;
  const parts = m.split(/[/._\-+=]/);
  if (parts.some((part) => part.length >= 16 && !isHex40(part) && looksRandom(part))) return true;
  return m.length >= 24 && looksRandom(m) && !parts.every(wordlike);
}

/** `s` with every credential it carries replaced by [redacted]. */
export function redactSecrets(s: string): string {
  return redactSecretsCounted(s).text;
}

const markers = (s: string): number => s.split(REDACTED).length - 1;

/**
 * `redactSecrets`, also saying how many values it masked: the markers it added,
 * so a value two rules both take counts once. A 40-hex git commit with no key
 * word right before it stays readable in both modes; any other hex run of 32+
 * is masked (HEX_RUN). `readableNames` also keeps branch names and paths
 * readable (`feat/p1-7-remote-handoff-v2`) while a bare key, a split token or
 * a base64 line does not pass (longRandomReadable).
 */
export function redactSecretsCounted(s: string, opts: { readableNames?: boolean } = {}): { text: string; masked: number } {
  // A 40-hex run (a git commit) is left to HEX_RUN in both modes.
  const longRandom = opts.readableNames ? longRandomReadable : (m: string) => !isHex40(m) && looksRandom(m);
  let out = maskInlineCredentials(s);
  for (const re of KEY_SHAPES) out = out.replace(re, REDACTED);
  out = out.replace(ASSIGNED, (m, name: string, value: string) => (value === REDACTED ? m : `${name}${REDACTED}`));
  out = out.replace(HEX_RUN, (m: string, at: number, whole: string) => {
    if (!/[0-9]/.test(m) || !/[a-fA-F]/.test(m)) return m;
    // A commit SHA stays readable unless a key word sits right before it.
    if (m.length === 40 && !KEY_WORD_BEFORE.test(whole.slice(Math.max(0, at - 16), at))) return m;
    return REDACTED;
  });
  out = out.replace(LONG_TOKEN, (m) => (m.includes(REDACTED) || !longRandom(m) ? m : REDACTED));
  for (const re of MORE_SHAPES) out = out.replace(re, REDACTED);
  return { text: out, masked: Math.max(0, markers(out) - markers(s)) };
}
