// ─── Origin pins — the exact origin address main recorded for a task ───────
//
// A repo key (shared/repoKey.ts) is the factory's lowercase identity of a
// repository: it drops the port, the ssh user and the path's case, so thread
// ids, verdicts and the merge lane read one key however the address was
// spelled. task_push and task_fetch also need the address itself: an origin
// pin is origin's URL as the repository config holds it (never rewritten by
// `url.*.insteadOf`), recorded by main and compared on every network call.
//
// The pin form (normalizeOriginPin):
//   - https:       `https://<host>:<port>/<path>`   (no user; 443 written out)
//   - ssh URL:     `ssh://[<user>@]<host>[:<port>]/<path>`
//   - scp-style:   `<user>@<host>:<path>`   (relative to the server's home)
// one trailing `/` and a trailing `.git` dropped, the scheme and host
// lowercased; the path keeps its case, the ssh user and the scp-style vs
// `ssh://` form are kept as written. An ssh address keeps its port only when
// it names one: with none, ssh's own config picks it, so "none" and ":22" are
// different addresses. A URL with surrounding whitespace is not an address
// (git keeps a quoted space in the path it asks for). The accepted addresses
// are those originUrlRepoKey (main/worktask/workerGit.ts) accepts. An ssh
// Host alias (`git@github-work:org/repo`) is a host name like any other:
// kept as written, never resolved through ssh's config.
//
// The compare (originPinMatches):
//   - the host and the port are compared exactly;
//   - the path is compared ignoring case (GitHub, GitHub Enterprise and
//     GitLab name a repository case-insensitively);
//   - two ssh addresses must use the same user and the same form;
//   - the transport-switch rule: an https address and an ssh address (either
//     form) name the same repository when the host and the path match and
//     each is on its transport's default port (443; 22 or none).
// And, since the owner's `url.<base>.insteadOf` / `pushInsteadOf` match
// URLs by their literal prefix, two spellings of one pin can be rewritten
// to different servers: originRewriteRefusal checks that the rewrite git
// applies to origin's URL lands where it lands for the pin's own spelling.

/** Path segments after the host (GitLab nests groups up to 20 deep). */
const MAX_PATH_SEGMENTS = 21;
const ORIGIN_PIN_MAX = 2048;
const HTTPS_PORT = 443;
const SSH_PORT = 22;

export interface OriginAddress {
  form: 'https' | 'ssh' | 'scp';
  /** The ssh user (null: an https address, or `ssh://` with none). */
  user: string | null;
  /** Lowercased. */
  host: string;
  /** https: always a number (443 when not written). ssh: null when the
   *  address names no port (scp-style never does). */
  port: number | null;
  /** Segments joined by `/`, no leading `/`, the trailing `.git` dropped. */
  path: string;
}

const SEG = '[A-Za-z0-9_.-]+';
const REPO_PATH = `(${SEG}(?:/${SEG})+)`;
const HTTPS_RE = new RegExp(`^https://(?:${SEG}@)?(${SEG})(?::(\\d{1,5}))?/${REPO_PATH}$`, 'i');
const SSH_RE = new RegExp(`^ssh://(?:(${SEG})@)?(${SEG})(?::(\\d{1,5}))?/${REPO_PATH}$`, 'i');
const SCP_RE = new RegExp(`^(${SEG})@(${SEG}):${REPO_PATH}$`);

function addressPath(raw: string): string | null {
  const parts = raw.split('/');
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, '');
  if (parts.length > MAX_PATH_SEGMENTS) return null;
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('-'))) return null;
  return parts.join('/');
}

/** A written port, or undefined when it is not one. */
function addressPort(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

function validName(name: string): boolean {
  return name !== '.' && name !== '..' && !name.startsWith('-');
}

/** A plain https or ssh address (or a pin) → its parts, or null for any
 *  other form. Pure. */
export function parseOriginAddress(url: unknown): OriginAddress | null {
  if (typeof url !== 'string' || url.length > ORIGIN_PIN_MAX || url !== url.trim()) return null;
  const s = url.replace(/\/$/, '');
  let m = HTTPS_RE.exec(s);
  if (m) {
    const port = m[2] === undefined ? HTTPS_PORT : addressPort(m[2]);
    const p = addressPath(m[3]);
    const host = m[1].toLowerCase();
    return port !== undefined && p !== null && validName(host) ? { form: 'https', user: null, host, port, path: p } : null;
  }
  m = SSH_RE.exec(s);
  if (m) {
    const port = m[3] === undefined ? null : addressPort(m[3]);
    const p = addressPath(m[4]);
    const host = m[2].toLowerCase();
    const user = m[1] ?? null;
    return port !== undefined && p !== null && validName(host) && (user === null || validName(user)) ? { form: 'ssh', user, host, port, path: p } : null;
  }
  m = SCP_RE.exec(s);
  if (m) {
    const p = addressPath(m[3]);
    const host = m[2].toLowerCase();
    return p !== null && validName(host) && validName(m[1]) ? { form: 'scp', user: m[1], host, port: null, path: p } : null;
  }
  return null;
}

function pinOf(a: OriginAddress): string {
  if (a.form === 'https') return `https://${a.host}:${a.port}/${a.path}`;
  if (a.form === 'ssh') return `ssh://${a.user ? `${a.user}@` : ''}${a.host}${a.port === null ? '' : `:${a.port}`}/${a.path}`;
  return `${a.user}@${a.host}:${a.path}`;
}

/** An origin URL → its pin, or null when it is not a plain https or ssh
 *  address. Pure; a pin normalizes to itself. */
export function normalizeOriginPin(url: unknown): string | null {
  const a = parseOriginAddress(url);
  return a ? pinOf(a) : null;
}

/** Whether `v` is a pin in its canonical form. Pure. */
export function isOriginPin(v: unknown): v is string {
  return typeof v === 'string' && normalizeOriginPin(v) === v;
}

function sameEndpoint(a: OriginAddress, b: OriginAddress): boolean {
  return a.form === b.form && a.user === b.user && a.host === b.host && a.port === b.port && a.path.toLowerCase() === b.path.toLowerCase();
}

function onDefaultPort(a: OriginAddress): boolean {
  return a.form === 'https' ? a.port === HTTPS_PORT : a.port === null || a.port === SSH_PORT;
}

/** Whether the origin URL `url` names the repository `pin` recorded, under
 *  the rules above. Pure. */
export function originPinMatches(pin: string, url: string): boolean {
  const a = parseOriginAddress(pin);
  const b = parseOriginAddress(url);
  if (!a || !b) return false;
  if (a.host !== b.host || a.path.toLowerCase() !== b.path.toLowerCase()) return false;
  const aSsh = a.form !== 'https';
  const bSsh = b.form !== 'https';
  if (aSsh === bSsh) return aSsh ? sameEndpoint(a, b) : a.port === b.port;
  // The transport-switch rule.
  return onDefaultPort(a) && onDefaultPort(b);
}

/** One `url.<base>.insteadOf` (or `pushInsteadOf`) value. */
export interface OriginUrlRewrite { base: string; prefix: string; push: boolean }

/** The URL rewrites in `git config --list` entries whose keys keep their
 *  case (the `<base>` is a URL). Pure. */
export function originUrlRewrites(entries: ReadonlyArray<{ key: string; value: string }>): OriginUrlRewrite[] {
  const out: OriginUrlRewrite[] = [];
  for (const e of entries) {
    const m = /^url\.(.+)\.(insteadof|pushinsteadof)$/i.exec(e.key);
    if (m && e.value) out.push({ base: m[1], prefix: e.value, push: m[2].toLowerCase() === 'pushinsteadof' });
  }
  return out;
}

/** git's rewrite of `url`: the longest matching prefix, a push rewrite before
 *  a fetch one for a push. Pure. */
export function rewriteOriginUrl(url: string, rules: readonly OriginUrlRewrite[], push: boolean): string {
  const pick = (list: readonly OriginUrlRewrite[]) => list.reduce<OriginUrlRewrite | null>((best, r) => (url.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length) ? r : best), null);
  const p = push ? pick(rules.filter((r) => r.push)) : null;
  const r = p ?? pick(rules.filter((x) => !x.push));
  return r ? r.base + url.slice(r.prefix.length) : url;
}

/** The pin's own spellings: as written, without and with `.git`. */
function pinSpellings(a: OriginAddress): string[] {
  const head = a.form === 'https'
    ? `https://${a.host}${a.port === HTTPS_PORT ? '' : `:${a.port}`}/`
    : a.form === 'ssh' ? `ssh://${a.user ? `${a.user}@` : ''}${a.host}${a.port === null ? '' : `:${a.port}`}/` : `${a.user}@${a.host}:`;
  return [`${head}${a.path}`, `${head}${a.path}.git`];
}

/** Why the owner's URL rewrites send origin's URL `url` somewhere other than
 *  they send the pin's own spelling, or null. Checked for a fetch and for a
 *  push. Pure. */
export function originRewriteRefusal(pin: string, url: string, rules: readonly OriginUrlRewrite[]): string | null {
  if (rules.length === 0) return null;
  const a = parseOriginAddress(pin);
  if (!a) return 'the recorded origin address cannot be read';
  const spellings = pinSpellings(a);
  for (const push of [false, true]) {
    const at = rewriteOriginUrl(url, rules, push);
    const pinned = spellings.map((s) => rewriteOriginUrl(s, rules, push));
    if (at === url && pinned.every((r, i) => r === spellings[i])) continue;
    const there = parseOriginAddress(at);
    if (!there || !pinned.some((r) => {
      const p = parseOriginAddress(r);
      return p !== null && sameEndpoint(p, there);
    })) return 'origin is rewritten by a URL rule to an address other than the one wmux recorded for this task';
  }
  return null;
}
