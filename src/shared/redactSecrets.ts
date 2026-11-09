// Masks credentials inside free text before it is written to a log or shown
// in a report: the inline URL credentials the IPC log already masks
// (main/ipc/wrapHandler.ts), and key-shaped values — OpenAI/Anthropic `sk-…`,
// GitHub `ghp_…`/`github_pat_…`, AWS `AKIA…`/`ASIA…`, Slack `xox?-…`, private
// key headers, a value after a key/secret/token/password name (in English,
// Chinese, Japanese or Korean), an Authorization or Cookie header's value, a
// password on a command line, a Slack webhook's path, and any other long
// random-looking token — plus every key shape the outbound
// secret guard blocks (shared/secretGuard.ts KEY_RULES), so a key that cannot
// be committed is not logged either. Pure, no Node imports, so main, the
// daemon and the CLI share it.
//
// This runs on terminal and message text and JS regexes backtrack, so every
// pattern starts at a literal or a single checked position, and a quantifier
// that must be followed by a required literal is bounded: the cost of a pass
// stays linear in the length of the text, whatever the text is.

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
 * a path, so it is not read as part of a password. The scheme is read back
 * from `://`, so a long run of scheme characters costs nothing.
 */
const URL_PASSWORD = /(?<=\b[a-z][a-z0-9+.-]{0,63})(:\/\/[^\s/?#@:"'<>[\]{}(),;]*:)(?!\[redacted\]@)[^\s/?#"'<>[\]{}]+(?=@[^\s/?#@"'<>[\]{}(),;]*(?:[\s/?#"'<>[\]{}(),;]|$))/gi;
/** A userinfo with no password (`https://<token>@host`): masked when it looks like a key, so `git@` stays. */
const URL_USER_TOKEN = /(?<=\b[a-z][a-z0-9+.-]{0,63})(:\/\/)(?!\[redacted\]@)([^\s/?#@:"'<>[\]{}(),;]{16,})(?=@)/gi;

export function maskInlineCredentials(s: string): string {
  return s
    .replace(INLINE_CREDENTIAL, '$1[redacted]')
    .replace(URL_PASSWORD, '$1[redacted]')
    .replace(URL_USER_TOKEN, (m, keep: string, user: string) => (looksRandom(user) ? `${keep}${REDACTED}` : m));
}

const KEY_SHAPES: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  // wmux's own bearer credentials: a guest bot's and an A2A peer's
  // (`wmuxguest~<id>~<secret>`, `wmuxpeer~<id>~<secret>`).
  /\bwmux(?:guest|peer)~[A-Za-z0-9_-]+~[A-Za-z0-9_-]+/g,
  // Adapted from yetone/magpie@c7ebb6f8d (internal/redact/redact.go), MIT
  // Each stops short of a longer run, which is LONG_TOKEN's to take whole.
  /\b(?:hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9+/_\-=.])/g,
  /(?<![A-Za-z0-9_-])[a-z]{2,4}_sk_(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9+/_\-=.])/g,
  /(?<![A-Za-z0-9_-])ark-[A-Za-z0-9][A-Za-z0-9_-]{15,}(?![A-Za-z0-9+/_\-=.])/g,
];

/** Applied after everything above, so they only ever mask more: the guard's
 *  key shapes, Google API keys and JWTs. */
const MORE_SHAPES: readonly RegExp[] = [
  ...KEY_RULES.map(([, re]) => new RegExp(re.source, 'g')),
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // One start per run of token characters, or `eyJ-eyJ-…` rescans the run from
  // each `eyJ`. A JWT glued to a longer run is LONG_TOKEN's.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/**
 * Words in lower case joined by hyphens, as a page's address or a project's
 * name has them (`sk-hynix-third-quarter-profit`). A key has a capital, a run
 * of 16 or more with no hyphen, or hex digits alone.
 * Adapted from yetone/magpie@c7ebb6f8d (internal/redact/redact.go), MIT
 */
function isSlug(v: string): boolean {
  if (/[A-Z]/.test(v) || !/[g-z]/.test(v.replace(/^(?:sk|ark)-/, ''))) return false;
  return v.split(/[-_]/).every((word) => word.length < 16);
}

/** A key shape's mask, but for a prefix that a slug can also start with. A word
 *  of letters and digits both (`api03`) is a key's, not a slug's. */
const maskShape = (m: string): string => (/^(?:sk|ark)-/.test(m) && isSlug(m) && !/[a-z][0-9]|[0-9][a-z]/.test(m) ? m : REDACTED);

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

const hasDigit = (v: string): boolean => /[0-9]/.test(v);
const hasLetter = (v: string): boolean => /[A-Za-z]/.test(v);
/** Letters of both cases with too many capitals for a name (`dXNlcjpwYXNz`, not `accessToken`). */
const mixedRandom = (v: string): boolean => /[a-z]/.test(v) && /[A-Z]/.test(v) && !wordlike(v);

/** What stands in for a value instead of being one: `${PASS}`, `<password>`, `****`, `your-key`. */
const PLACEHOLDER = /^(?:\$\{?\w+\}?(?:[/:.-].*)?|\$\(.*|%\w+%?|%\(.*|[:@]\w+|\{.*\}|<.*>|\[.*\]|[*xX.]+|your[_-].*|changeme|change[_-]me|example.*|placeholder.*|dummy.*)$/i;
/** Code reading a value from somewhere, calling for it or comparing with it. */
const CODE_VALUE = /^(?:process\.env|import\.meta|os\.|env\.|this\.|self\.|[A-Za-z_$][\w$.]*(?:<[^>]*>)?\([^)]*\)?[;,)]*$|\(|\[\]|map\[|[A-Z]\w*[<[]|[=>]|\/\/|[a-z][a-z0-9+.-]*:\/\/)/i;
/** A value built from code in a template string: `Bearer ${token}`, `{{ secrets.X }}`, `#{key}`. */
const TEMPLATE = /\$\{|\{\{|#\{/;
/** Words a field called password or token is set to in code and prose: not values. */
const NOT_A_VALUE = new Set([
  'undefined', 'function', 'required', 'optional', 'enabled', 'disabled', 'boolean', 'provided', 'missing', 'expired', 'invalid', 'incorrect', 'rejected',
  'password', 'passwd', 'pass', 'pwd', 'username', 'nullable', 'readonly', 'inherit', 'inherited', 'notfound', 'same-origin',
  'string', 'str', 'number', 'int', 'integer', 'bool', 'any', 'none', 'null', 'nil', 'true', 'false', 'void', 'object', 'text', 'unknown', 'never', 'value', 'input', 'secret', 'secrets', 'token', 'key', 'hidden', 'empty', 'blank', 'yes',
  'new', 'await', 'async', 'yield', 'typeof', 'lambda', 'require', 'import', 'const', 'let', 'var', 'this', 'self',
]);

// Adapted from yetone/magpie@c7ebb6f8d (internal/redact/fieldvalue.go), MIT
/** A release's version as a manifest pins it: `^4.0.0-beta.1`. */
const VERSION_VALUE = /^(?:[~^]|[<>=!~]=?|==)?[vV]?\d+(?:\.\d+)+(?:[-+._]?(?:(?:alpha|beta|rc|pre|preview|post|dev|canary|next|nightly|snapshot|release|final|ga|stable|build|incubating)\d*|[abcm]\d+|\d+))*$/i;
/** A moment as RFC 3339 writes it: `"token_expires": "2026-08-30T11:44:31Z"`. */
const TIME_VALUE = /^\d{4}-\d{1,2}-\d{1,2}[Tt]\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?$/;
/** A line or a range of lines: `token.go:L643-669.` */
const LINE_REF = /^(?:L\d+(?:[-–:]L?\d+)*|\d+(?:[-–:]L?\d+)+)[.,;:]?$/;
/** Where a secret is kept, not the secret: `~/.ssh/id_ed25519`. No `+` or `=`, as base64 has. */
const PATH_VALUE = /^(?:~\/|\.\.?\/|\/(?:Users|home|tmp|private|var|etc|run|opt|usr|mnt|Volumes|root|srv|data|workspaces?|app|Applications|Library|System|proc|dev|sys|nix)\/)[^+=]+$/;
/** Files named with a line after them: `src/secret_store.ts:12`. Not `.env`, `.txt`, `.key`, which hold secrets. */
const SOURCE_FILE = /\.(?:go|tsx?|mts|cts|jsx?|mjs|cjs|pyi?|rb|rs|java|kts?|swift|c|h|cc|cpp|cxx|hpp|hh|mm?|cs|fs|php|scala|dart|lua|zig|nim|exs?|erl|hs|ml|clj|r|jl|sh|bash|zsh|fish|ps1|vue|svelte|astro|mdx?|rst|sql|proto|graphql|gradle|html|s?css|less|jsonc?|ya?ml|toml|xml|tf|ipynb)$/i;
const LOWER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
/** Punctuation after a value that is not part of it; never the marker's own bracket. */
const TRAILING_STOP = /(?<!\[redacted)[,;)\]}\\]+$/;
/** The next field, when the one named was set to nothing: `UI_PASSWORD= UI_ADDR=127.0.0.1`. */
const NEXT_FIELD = /^(?:[A-Z_][A-Z0-9_]*|[a-z_][a-z0-9_-]*|--?[A-Za-z][A-Za-z0-9_-]*)=[^=]/;

/** The words of a name: split at `_`, `.`, `-`, and where a capital follows a small letter. */
function nameWords(name: string): string[] {
  return name.split(/[_.-]+/).flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/)).filter(Boolean);
}

/**
 * A name in code for a secret, not one: two words or more, one of them saying
 * secret, written as code writes a name (`refreshToken2`, `generate_token_v2`,
 * `env.SECRET_V2`). `Passw0rd123` is one word; `SuperSecret2024` starts with a
 * capital and has no separator, so it reads as a password.
 */
function namesASecret(v: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(v)) return false;
  if (!/^[a-z]/.test(v) && !/[_.]/.test(v)) return false;
  const words = nameWords(v).filter(hasLetter).map((w) => w.replace(/\d.*$/, '').toLowerCase());
  return words.length >= 2 && words.some((w) => /^(?:tokens?|secrets?|passwords?|passwd|pwd|keys?|apikey|credentials?)$/.test(w));
}

/** Not a secret in any field: stands in for one, reads one, or is a version, a time, a path or a name. */
function neverAValue(v: string, quoted = false): boolean {
  return PLACEHOLDER.test(v) || TEMPLATE.test(v) || CODE_VALUE.test(v) || VERSION_VALUE.test(v) || TIME_VALUE.test(v) || LINE_REF.test(v) || PATH_VALUE.test(v) || (namesASecret(v) && !(quoted && v.includes('.'))) || NOT_A_VALUE.has(v.toLowerCase());
}

/**
 * How strongly a field's name says its value is a secret: 'password' takes
 * almost anything, 'token' a value that does not read as a word or a number,
 * 'bare' (a field called `key` and nothing more, as code calls anything) only
 * a long one of letters and digits. null: the name says nothing, as in
 * `keyboard`, `tokenCount`, `max_tokens`, `sort_key`, `next_page_token`,
 * `token.go`, or the working directory `PWD`.
 */
type FieldClass = 'password' | 'token' | 'bare' | null;

/** A word in a name that makes it about something other than a credential. */
const OTHER_THING = new Set([
  'page', 'next', 'cursor', 'pagination', 'continuation', 'csrf', 'xsrf', 'trace', 'request', 'idempotency', 'sync', 'nonce',
  'cache', 'commit', 'object', 'blob', 'content', 'revision', 'rev', 'partition', 'shard', 'bucket', 'dedup', 'dedupe', 'lookup',
  'sort', 'public', 'publishable', 'anon', 'primary', 'foreign', 'vapid',
]);
/** A word after the secret's that says the field holds a fact about the secret. */
const ABOUT_IT = new Set([
  'count', 'counts', 'limit', 'limits', 'usage', 'used', 'remaining', 'total', 'type', 'types', 'kind', 'name', 'names', 'label',
  'id', 'ids', 'uuid', 'guid', 'url', 'uri', 'endpoint', 'host', 'path', 'paths', 'file', 'files', 'dir', 'directory', 'location',
  'len', 'length', 'size', 'budget', 'price', 'cost', 'rate', 'max', 'min', 'num', 'number', 'version', 'header', 'headers',
  'prefix', 'suffix', 'field', 'fields', 'env', 'var', 'variable', 'param', 'ttl', 'expiry', 'expires', 'expiration', 'expired', 'exp',
  'lifetime', 'at', 'time', 'timeout', 'age', 'date', 'created', 'updated', 'rotated', 'hash', 'hashed', 'digest', 'checksum', 'sha',
  'fingerprint', 'policy', 'required', 'enabled', 'disabled', 'description', 'desc', 'placeholder', 'hint', 'error', 'message', 'msg',
  'manager', 'store', 'provider', 'service', 'helper', 'input', 'regex', 'pattern', 'format', 'arn',
]);
const KEY_QUALIFIER = new Set(['api', 'access', 'secret', 'private', 'auth', 'signing', 'encryption', 'master', 'license', 'licence', 'ssh', 'token', 'client', 'consumer', 'shared', 'app']);

// Adapted from yetone/magpie@c7ebb6f8d (internal/redact/redact.go, ids.go), MIT
function fieldClass(name: string, before: string): FieldClass {
  if (/^(?:OLD)?PWD$/.test(name) || SOURCE_FILE.test(name)) return null;
  const words = nameWords(name);
  const lower = words.map((w) => w.replace(/\d+$/, '').toLowerCase());
  if (lower.some((w) => OTHER_THING.has(w))) return null;
  for (let i = words.length - 1; i >= 0; i--) {
    const w = lower[i];
    let found: FieldClass = null;
    if (/(?:passw(?:or)?d|passphrase|pwd|secrets?)$/.test(w) || (words[i] === 'PASS' && i > 0)) found = 'password';
    else if (/(?:token|credentials?)$/.test(w) || /(?:api|access|secret|private|auth|signing|encryption|master|license|licence|ssh)key$/.test(w)) found = 'token';
    else if (w === 'key') {
      // `key` alone is code's unless a word says whose: an upper-case env name
      // (SERVICE_X_KEY), a qualifier (api_key), or a phrase (`API Key: …`).
      if (i > 0 && (KEY_QUALIFIER.has(lower[i - 1]) || words[i] === 'KEY')) found = 'token';
      else if (i === 0) found = words.length === 1 && /(?:api|access|secret|private|signing|licen[cs]e) $/i.test(before) ? 'token' : 'bare';
      else return null;
    }
    if (found) return lower.slice(i + 1).some((w2) => ABOUT_IT.has(w2)) ? null : found;
  }
  return null;
}

/**
 * A value of letters, `-`, `_` and `.` and no digit: under a name that says
 * secret, a word, a hyphenated phrase or a quoted string is one, and an unquoted
 * camelCase, snake_case or dotted name mostly is code's.
 */
function lettersOnlySecret(cls: 'password' | 'token', v: string, sep: string, quoted: boolean): boolean {
  if (quoted || mixedRandom(v) || v.includes('-') || /^[a-z]+$|^[A-Z]+$/.test(v)) return true;
  // After `=`: a config's value when glued to it (`TOKEN=some_value`); a statement's otherwise.
  return !sep.includes(':') && (cls === 'password' || !/\s/.test(sep));
}

/** Names whose value may be a phrase, spaces and all. */
const PHRASE_NAME = /passw|pwd|_pass|passphrase|private[_-]?key/i;
/** The first word of a name for a state or an action, not a stored password: showPassword, resetPassword. */
const STATE_WORD = /^(?:is|has|show|hide|no|use|needs?|requires?|with|without|set|get|handle|toggle|reset|forgot|change|update|validate|verify|check|confirm)$/i;

/**
 * How short a value can be and still be one. A password is whatever someone
 * chose, so a name that ends in one takes 3 characters (`secret` and `pwd`, also
 * everyday words in code, take 6); a token or a key is generated, and a shorter
 * value under its name is rarely one, so those take 8.
 */
function minValueLength(cls: Exclude<FieldClass, null>, name: string): number {
  if (cls !== 'password' || STATE_WORD.test(nameWords(name)[0] ?? '')) return 8;
  if (/(?:passw(?:or)?d|_pass|passphrase)\d*$/i.test(name)) return 3;
  return /(?:secrets?|pwd)\d*$/i.test(name) ? 6 : 8;
}

/**
 * A value under 8 characters needs more to go on: plain ASCII (a label in a
 * locale file is not one), not naming a secret itself (`secret: SECRET2`), not a
 * dotted or snake_case name, and not a word glued on with `:` (`secret:delete`
 * is a channel's name).
 */
function shortValueOk(v: string, sep: string, quoted: boolean): boolean {
  if (!/^[\x21-\x7e]+$/.test(v) || !/[A-Za-z0-9]/.test(v) || v.startsWith('-') || /secret|token|key/i.test(v)) return false;
  if (quoted) return true;
  return !/^[A-Za-z]+[._][A-Za-z._]*$/.test(v) && !(/^(?:\\?["'])?:$/.test(sep) && /^[A-Za-z]+$/.test(v));
}

/** Is this value of this field a secret? `v` has no trailing punctuation. */
function fieldValueIsSecret(cls: Exclude<FieldClass, null>, v: string, name: string, sep: string, quoted: boolean): boolean {
  if (TEMPLATE.test(v)) return false;
  if (/\s/.test(v)) {
    if (PHRASE_NAME.test(name)) return v.trim().length >= 3;
    if (v.length < 8) return false;
    // A sentence in a string is a message about the field, not its value.
    const words = v.split(/\s+/).filter(Boolean);
    if (words.length >= 3 && words.filter((w) => /^[^\d]*$/.test(w)).length >= words.length - 1) return false;
    return cls === 'password' || words.some((w) => w.length >= 8 && hasDigit(w) && hasLetter(w));
  }
  if (v.length < minValueLength(cls, name) || neverAValue(v, quoted)) return false;
  if (v.length < 8 && !shortValueOk(v, sep, quoted)) return false;
  if (cls === 'bare') return v.length >= 16 && hasDigit(v) && hasLetter(v) && !/^[0-9a-fA-F]{16,31}$/.test(v);
  if (!hasLetter(v)) {
    if (cls === 'token') return false;
    return /^\d+$/.test(v) || !/^[\d.,:_-]+$/.test(v);
  }
  if (!hasDigit(v) && /^[A-Za-z._-]+$/.test(v)) return lettersOnlySecret(cls, v, sep, quoted);
  return true;
}

/**
 * `name = value` where the name says secret. A quoted value is taken to its
 * closing quote, spaces and all, so it is never cut in two; the separator is
 * on one line, so a YAML mapping's next key is no value. The name's start is
 * read back from the secret word, so a long run of name characters costs a
 * bounded amount per word.
 */
const ASSIGNED = /(?<word>key|secret|token|passw(?:or)?d|passphrase|pwd|credential|_pass)(?<tail>[A-Za-z0-9_.-]{0,64})(?<sep>(?:\\?["'])?[ \t]*[:=][ \t]*)(?:(?<open>\\?["'`])(?<quoted>(?:(?!\k<open>)(?:\\.|[^\\\r\n])){1,512})\k<open>|(?<lead>\\?["'`])?(?<bare>[^\s"'`]+))/gi;

interface AssignedGroups { word: string; tail: string; sep: string; open?: string; quoted?: string; lead?: string; bare?: string }

function maskAssigned(s: string): string {
  return s.replace(ASSIGNED, (...args: unknown[]) => {
    const g = args[args.length - 1] as unknown as AssignedGroups;
    const whole = args[args.length - 2] as string;
    const at = args[args.length - 3] as number;
    const m = args[0] as string;
    const value = g.quoted ?? g.bare ?? '';
    const head = `${g.word}${g.tail}${g.sep}`;
    if (value === REDACTED || value.length < 3) return m;
    // A separator with a space after it and a whole assignment after that: the
    // field before is empty, and this one is read on its own.
    if (g.bare !== undefined && !g.lead && /[ \t]$/.test(g.sep) && NEXT_FIELD.test(g.bare)) return `${head}${maskAssigned(g.bare)}`;
    let start = at;
    while (start > 0 && at - start < 64 && /[A-Za-z0-9_.-]/.test(whole[start - 1])) start--;
    let name = whole.slice(start, at) + g.word + g.tail;
    let prev = start > 0 ? whole[start - 1] : '';
    // An escaped line break in a logged string, not a Windows path's separator.
    if (prev === '\\' && /^[nrt]/.test(name)) { name = name.slice(1); prev = ''; }
    const close = g.open ?? '';
    const masked = g.bare !== undefined ? `${head}${g.lead ?? ''}${REDACTED}` : `${head}${close}${REDACTED}${close}`;
    // A path's last part and a line, or a plugin's skill: `skills/secret-scanner:x7k2`.
    if ((prev === '/' || prev === '\\') && g.sep === ':') return m;
    const cls = fieldClass(name, whole.slice(Math.max(0, start - 8), start));
    if (!cls) return m;
    // One word that is partly masked already goes whole.
    if (value.includes(REDACTED) && !/\s/.test(value)) return masked;
    const quoted = g.quoted !== undefined || !!g.lead;
    const colon = g.sep.includes(':');
    const v = value.replace(TRAILING_STOP, '');
    if (!quoted && colon) {
      // Code naming a value, not a value: a type or a read that code goes on from
      // (`secretKey: Uint8Array;`), or `plugin-name:skill-name`.
      if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(v) && (v !== value || /[,;)}\]|?&<>(]/.test(whole[at + m.length] ?? ''))) return m;
      if (g.sep === ':' && LOWER_SLUG.test(name) && LOWER_SLUG.test(v) && isSlug(v)) return m;
    }
    // Words in a string are a message about the field, unless it is a password.
    if (/\s/.test(v) && !PHRASE_NAME.test(name) && !/\d/.test(v)) return m;
    // A marker in a string counts as the word it replaced, so the verdict on a
    // second pass is the verdict on the first.
    // A short name after `=` that a statement ends on is a variable: `password = value;`.
    if (!quoted && v !== value && v.length < 8 && /^[A-Za-z_$][\w$.]*$/.test(v)) return m;
    return fieldValueIsSecret(cls, v.split(REDACTED).join('x9x9x9x9'), name, g.sep, quoted) ? masked : m;
  });
}

// Adapted from yetone/magpie@c7ebb6f8d (internal/redact/redact.go), MIT
/**
 * Authorization and Cookie headers: the value is secret whatever it looks like,
 * so it needs no key-like name or shape. Read on a line of its own (also as
 * `curl -v` prints it, after `> `), quoted (`-H 'Cookie: …'`,
 * `"Authorization": "…"`), or after an escaped line break in a logged request;
 * an escaped line break also ends it. Prose that begins with the word, and a value that
 * reads as code or a placeholder, stay.
 */
const HEADER_NAME = '(?:proxy-)?authorization|(?:set-)?cookie';
const HEADER_VALUE_CHAR = '(?:\\\\[^rn\\r\\n]|[^\\\\\\r\\n])';
const HEADER_LINE = new RegExp(`^(?<head>[ \\t]*(?:[<>][ \\t]+)?(?<name>${HEADER_NAME})[ \\t]*:[ \\t]*)(?<value>${HEADER_VALUE_CHAR}+)`, 'gim');
const HEADER_QUOTED = new RegExp(`(?<head>(?<q>["'\`]|\\\\[rn])(?<name>${HEADER_NAME})\\k<q>?[ \\t]*:[ \\t]*)(?<inner>["'\`]?)(?<value>(?:(?!\\k<q>)${HEADER_VALUE_CHAR})+)`, 'gi');
const AUTH_SCHEME = /^(?:bearer|basic|token|digest|negotiate|ntlm|apikey|api-key|oauth|jwt|hawk|aws4-hmac-sha256)$/i;

/** One word that reads as a credential, with or without a scheme word before it. */
function credentialWord(word: string): boolean {
  if (word.includes(REDACTED)) return word !== REDACTED;
  if (word.length < 8 || (LOWER_SLUG.test(word) && isSlug(word))) return false;
  return credentialShaped(word);
}

/** Reads as generated or chosen rather than as a word or a name. */
function credentialShaped(word: string): boolean {
  if (/\s/.test(word) || neverAValue(word)) return false;
  return hasDigit(word) || mixedRandom(word) || /[^A-Za-z0-9_.-]/.test(word);
}

function maskAuthorization(value: string): string {
  const v = value.trim();
  if (PLACEHOLDER.test(v)) return value;
  const words = v.split(/\s+/);
  // A scheme with parameters (Digest, AWS4): every parameter is part of it.
  if (words.length > 1 && /^[A-Za-z][A-Za-z0-9-]*$/.test(words[0]) && /^[A-Za-z0-9_-]+=/.test(words[1])) {
    return value.replace(v, `${words[0]} ${REDACTED}`);
  }
  const hasScheme = words.length >= 2 && /^[A-Za-z][A-Za-z0-9-]*$/.test(words[0]);
  if (words.length > 2 && !AUTH_SCHEME.test(words[0])) return value;
  if (!hasScheme && words.length > 1) return value;
  const word = words[hasScheme ? 1 : 0].replace(/[,;]+$/, '');
  return credentialWord(word) ? value.replace(word, REDACTED) : value;
}

function maskCookie(value: string): string {
  const v = value.trim();
  if (v === REDACTED || PLACEHOLDER.test(v)) return value;
  const parts = v.split(';').map((p) => p.trim()).filter(Boolean);
  if (!v.includes('=')) return parts.length === 1 && credentialWord(parts[0].replace(/,$/, '')) ? value.replace(v, REDACTED) : value;
  const pairs = parts[0].includes('=') && parts.every((p) => /^[^\s=]+(?:=|$)/.test(p));
  return pairs && v.length >= 8 ? value.replace(v, REDACTED) : value;
}

/** The part of `value` a quote opened by `q` holds, and what follows it. */
function untilQuote(value: string, q: string): [string, string] {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') i++;
    else if (value[i] === q) return [value.slice(0, i), value.slice(i)];
  }
  return [value, ''];
}

function maskHeaderValue(name: string, value: string, q: string): string {
  const [inner, rest] = q ? untilQuote(value, q) : [value, ''];
  return (/cookie$/i.test(name) ? maskCookie(inner) : maskAuthorization(inner)) + rest;
}

function maskHeaders(s: string): string {
  const line = s.replace(HEADER_LINE, (...args: unknown[]) => {
    const g = args[args.length - 1] as unknown as { head: string; name: string; value: string };
    const open = /^["'`]/.test(g.value) ? g.value[0] : '';
    return `${g.head}${open}${maskHeaderValue(g.name, g.value.slice(open.length), open)}`;
  });
  return line.replace(HEADER_QUOTED, (...args: unknown[]) => {
    const g = args[args.length - 1] as unknown as { head: string; name: string; inner: string; value: string };
    return `${g.head}${g.inner}${maskHeaderValue(g.name, g.value, g.inner)}`;
  });
}

// Adapted from yetone/magpie@c7ebb6f8d (internal/redact/redact.go), MIT
/**
 * A password or a key after its name in Chinese, Japanese or Korean, as people
 * write one into a message: `비밀번호: …`, `密码是 …`, `パスワードは …`. A value
 * ends at the next CJK character or a space, and a sentence's closing stop is
 * no part of it. With only a space after the name it has to read as a
 * credential (`비밀번호 reset` is prose), and a number followed by what it counts
 * is a size (`密钥为 2048 位`).
 */
const CJK_PASSWORD_NAMES = ['密码', '密碼', '口令', 'PIN码', 'PIN碼', 'PIN 码', '安全码', '安全碼', 'パスワード', '暗証番号', '비밀번호', '패스워드', '암호', '비번'];
const CJK_KEY_NAMES = ['密钥', '密鑰', '秘钥', '秘鑰', '私钥', '私鑰', '金钥', '金鑰', '令牌', '权杖', '權杖', '授权码', '授權碼', '秘密鍵', 'トークン', 'シークレット', 'APIキー', 'アクセスキー', '토큰', '비밀키', '시크릿', 'API 키', 'API키'];
const CJK_OPEN_VALUE = `(?:(?<open>\\\\?["'“「])(?<quoted>[^"'”」\\r\\n]{1,512})["'”」]|(?<bare>[^\\s"'\`“”「」‘’，。、；！？）】》\\u3000-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af\\uff00-\\uffef]{4,}))`;
const CJK_SEP = '(?<sep>[ \\t]*(?:[:：=][ \\t]*|[为為是][ \\t]*[:：]?[ \\t]*|[は는은][ \\t]*)?)';
const cjkNamed = (names: readonly string[]): RegExp => new RegExp(`(?:${names.join('|')})${CJK_SEP}${CJK_OPEN_VALUE}`, 'gi');
const CJK_PASSWORD = cjkNamed(CJK_PASSWORD_NAMES);
const CJK_KEY = cjkNamed(CJK_KEY_NAMES);
/** An English name before 为, 為, 是 or a full-width colon, as a Chinese message has it. */
const NAME_THEN_COPULA = new RegExp(`(?<![A-Za-z])(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|pwd|api key|access key|secret key|key|pin(?: ?code)?)(?<sep>(?:\\\\?["'])?[ \\t]*(?:[为為是][ \\t]*[:：]?|：)[ \\t]*)${CJK_OPEN_VALUE}`, 'gi');
/** The only characters these rules can start from, so ordinary English text skips them. */
const CJK_RULE_TEXT = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff1a]/;
const QUANTITY_AFTER = /^[ \t]*(?:位|比特|字节|字節|个|個|次|秒|毫秒|分钟|分鐘|小时|小時|天|年|bit|byte|ms|sec|min|ビット|バイト|비트|바이트|개|초|분)/i;

function maskCjk(s: string, re: RegExp, isSecret: (v: string, sep: boolean, after: string) => boolean): string {
  return s.replace(re, (...args: unknown[]) => {
    const g = args[args.length - 1] as unknown as { sep: string; open?: string; quoted?: string; bare?: string };
    const whole = args[args.length - 2] as string;
    const at = args[args.length - 3] as number;
    const m = args[0] as string;
    const value = g.quoted ?? g.bare ?? '';
    if (value === REDACTED) return m;
    const v = g.quoted !== undefined ? value : value.replace(/(?<!\[redacted)[.,;:!?)\]}]+$/, '');
    if (v === REDACTED) return m;
    const after = whole.slice(at + m.length, at + m.length + 8);
    if (!v.includes(REDACTED) && !isSecret(v, /[^ \t]/.test(g.sep), after)) return m;
    // The value's own text is the last thing in the match; a quote's close and a
    // sentence's stop are kept.
    const end = g.quoted !== undefined ? m.lastIndexOf(value) : m.length - value.length;
    return `${m.slice(0, end)}${REDACTED}${g.quoted !== undefined ? m.slice(end + value.length) : value.slice(v.length)}`;
  });
}

function cjkPasswordSecret(v: string, sep: boolean, after: string): boolean {
  if (v.length < 4 || neverAValue(v)) return false;
  if (/^\d+$/.test(v)) return (sep || v.length >= 6) && !QUANTITY_AFTER.test(after);
  return sep || credentialWord(v);
}

function cjkKeySecret(v: string, sep: boolean, after: string): boolean {
  if (v.length < 4 || neverAValue(v)) return false;
  if (/^\d+$/.test(v)) return sep && v.length >= 6 && !QUANTITY_AFTER.test(after);
  if (!hasLetter(v) || !(hasDigit(v) || v.length >= 16)) return false;
  return sep || (v.length >= 8 && !(LOWER_SLUG.test(v) && isSlug(v)));
}

function maskCjkNamed(s: string): string {
  if (!CJK_RULE_TEXT.test(s)) return s;
  return maskCjk(maskCjk(maskCjk(s, CJK_PASSWORD, cjkPasswordSecret), CJK_KEY, cjkKeySecret), NAME_THEN_COPULA, cjkKeySecret);
}

/**
 * A password or a token on a command line: `--password <value>`, `curl -u
 * user:<value>`, `sshpass -p <value>`, `mysql -p<value>`. A flag's bare value
 * has to read as a credential, as docs write `--password flag`. `-u` and `-p`
 * mean other things elsewhere, so those two only count after their command,
 * read back from the flag on the same command.
 */
const CLI_VALUE = `(?:(?<open>["'])(?<quoted>[^"'\\r\\n]{1,512})["']|(?<bare>[^\\s"'\`]+))`;
const CLI_FLAG = new RegExp(`(?<![\\w-])(?<flag>--(?:[a-z0-9]+-){0,4}(?:password|passwd|pass|passphrase|secret|token|api-?key|access-key|secret-key|private-key))[ \\t]+${CLI_VALUE}`, 'gi');
const SSHPASS = new RegExp(`\\bsshpass[ \\t]+(?:-[a-oq-zA-Z][ \\t]+){0,4}-p[ \\t]*${CLI_VALUE}`, 'g');
const CURL_USER = /(?<![\w-])(?:-u|--user)(?:[ \t]+|=)?(?:(?<open>["'])[^\s:"']{1,64}:(?<quoted>[^"'\r\n]{1,512})["']|[^\s:"'`]{1,64}:(?<bare>[^\s"'`]+))/g;
const MYSQL_PASSWORD = new RegExp(`(?<=[ \\t])-p${CLI_VALUE}`, 'g');
const CURL_COMMAND = /(?:^|[\s/"'(=])curl(?:\.exe)?\s/;
const MYSQL_COMMAND = /(?:^|[\s/"'(=])(?:mysql|mariadb|mysqldump|mysqladmin|mariadb-dump)(?:\.exe)?\s/;

function commandBefore(whole: string, at: number, command: RegExp): boolean {
  const before = whole.slice(Math.max(0, at - 200), at);
  return command.test(before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf('|'), before.lastIndexOf(';'), before.lastIndexOf('&')) + 1));
}

function maskCli(s: string, re: RegExp, isSecret: (v: string, quoted: boolean, at: number, whole: string, flag: string) => boolean): string {
  return s.replace(re, (...args: unknown[]) => {
    const g = args[args.length - 1] as unknown as { open?: string; quoted?: string; bare?: string; flag?: string };
    const whole = args[args.length - 2] as string;
    const at = args[args.length - 3] as number;
    const m = args[0] as string;
    const value = g.quoted ?? g.bare ?? '';
    if (value === REDACTED || value.length < 3) return m;
    if (!value.includes(REDACTED) && !isSecret(value, g.quoted !== undefined, at, whole, g.flag ?? '')) return m;
    const end = m.lastIndexOf(value);
    return `${m.slice(0, end)}${REDACTED}${m.slice(end + value.length)}`;
  });
}

const plainCliValue = (v: string, quoted: boolean): boolean => (quoted || !/^(?:-|[A-Za-z_-]+=[^=])/.test(v)) && !neverAValue(v);

function maskCommandLines(s: string): string {
  let out = maskCli(s, CLI_FLAG, (v, quoted, _at, _whole, flag) => {
    if (/^--no-/i.test(flag) || SOURCE_FILE.test(v) || !plainCliValue(v, quoted) || v.startsWith('-')) return false;
    if (/pass/i.test(flag)) return quoted || credentialShaped(v);
    return v.length >= 8 && credentialShaped(v);
  });
  if (out.includes('sshpass')) out = maskCli(out, SSHPASS, plainCliValue);
  if (out.includes('curl')) out = maskCli(out, CURL_USER, (v, quoted, at, whole) => plainCliValue(v, quoted) && commandBefore(whole, at, CURL_COMMAND));
  if (out.includes('mysql') || out.includes('mariadb')) out = maskCli(out, MYSQL_PASSWORD, (v, quoted, at, whole) => plainCliValue(v, quoted) && commandBefore(whole, at, MYSQL_COMMAND));
  return out;
}

/** A Slack incoming webhook's path is its credential; the host stays. */
const SLACK_WEBHOOK = /(hooks\.slack\.com\/(?:services|workflows)\/)[A-Za-z0-9_/-]{8,}/g;

// Adapted from yetone/magpie@c7ebb6f8d (internal/redact/model.go), MIT
/**
 * A digest with its algorithm's name is an id anyone can read: a hex run of the
 * length that algorithm gives after `sha256:`, a whole `sha256-…` run, a
 * package's Subresource Integrity (`sha512-…`) or a Go sum (`h1:…=`).
 */
const DIGEST_DIGITS: Readonly<Record<string, readonly [number, number]>> = { md5: [32, 32], sha1: [40, 40], sha224: [56, 56], sha256: [64, 64], sha384: [96, 96], sha512: [128, 128], blake2: [32, 128], blake2b: [32, 128], blake2s: [32, 64], blake3: [32, 128] };
const DIGEST_LABEL = /(?<![A-Za-z0-9_])(md5|sha-?(?:1|224|256|384|512)|blake2[bs]?|blake3)[ :=-]{1,2}$/i;
const DIGEST_RUN = /^(md5|sha-?(?:1|224|256|384|512)|blake2[bs]?|blake3)[-=]([0-9a-fA-F]{32,128})$/i;
const SRI_RUN = /^sha(?:256|384|512)-[A-Za-z0-9+/]{43,86}={0,2}$/;

function digestLength(algorithm: string, digits: string): boolean {
  const [min, max] = DIGEST_DIGITS[algorithm.replace('-', '').toLowerCase()];
  return digits.length >= min && digits.length <= max;
}

/** The run `m` at `at` is a named digest. */
function namedDigest(m: string, at: number, whole: string): boolean {
  const run = DIGEST_RUN.exec(m);
  if (run) return digestLength(run[1], run[2]);
  if (SRI_RUN.test(m)) return true;
  const before = whole.slice(Math.max(0, at - 12), at);
  if (/^[A-Za-z0-9+/]{43}=$/.test(m) && /(?<![A-Za-z0-9_])h1:$/.test(before)) return true;
  const label = DIGEST_LABEL.exec(before);
  return !!label && /^[0-9a-fA-F]+$/.test(m) && digestLength(label[1], m);
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
  // Headers first: a value that takes a whole line goes as one, not with holes.
  let out = maskInlineCredentials(maskHeaders(s));
  for (const re of KEY_SHAPES) out = out.replace(re, maskShape);
  out = out.replace(SLACK_WEBHOOK, `$1${REDACTED}`);
  out = maskCommandLines(maskAssigned(maskCjkNamed(out)));
  const named = out;
  out = out.replace(HEX_RUN, (m: string, at: number, whole: string) => {
    if (!/[0-9]/.test(m) || !/[a-fA-F]/.test(m) || namedDigest(m, at, whole)) return m;
    // A commit SHA stays readable unless a key word sits right before it.
    if (m.length === 40 && !KEY_WORD_BEFORE.test(whole.slice(Math.max(0, at - 16), at))) return m;
    return REDACTED;
  });
  out = out.replace(LONG_TOKEN, (m: string, at: number, whole: string) => (m.includes(REDACTED) || !longRandom(m) || namedDigest(m, at, whole) ? m : REDACTED));
  for (const re of MORE_SHAPES) out = out.replace(re, maskShape);
  // A named value a later rule took part of goes whole now, not on the next call.
  if (out !== named) out = maskCommandLines(maskAssigned(maskCjkNamed(out)));
  return { text: out, masked: Math.max(0, markers(out) - markers(s)) };
}
