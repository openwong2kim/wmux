// ─── Origin pins — the exact origin address main recorded for a task ───────
//
// A repo key (shared/repoKey.ts) is the factory's lowercase identity of a
// repository: it drops the port, the ssh user and the path's case, so thread
// ids, verdicts and the merge lane read one key however the address was
// spelled. task_push and task_fetch also need the address itself: an origin
// pin is origin's URL exactly as the repository config held it (never
// rewritten by `url.*.insteadOf`), recorded by main and compared on every
// network call.
//
// A pin is a plain address (parseOriginAddress): https, `ssh://` or
// scp-style, with no surrounding whitespace (git keeps a quoted space in the
// path it asks for). The accepted addresses are those originUrlRepoKey
// (main/worktask/workerGit.ts) accepts. Read as an address: the scheme and
// host lowercased, one trailing `/` and a trailing `.git` dropped, an https
// address on 443 whether or not it writes the port; an ssh address has a port
// only when it names one (with none, ssh's own config picks it, so "none"
// and ":22" are different addresses). An ssh Host alias
// (`git@github-work:org/repo`) is a host name like any other: kept as
// written, never resolved through ssh's config.
//
// The compare (originPinMatches): the same form (https, `ssh://` or
// scp-style), user, host and port; the path ignoring case (GitHub, GitHub
// Enterprise and GitLab name a repository case-insensitively). Origin's URL
// and the pin are compared as written, and again as git rewrites them for a
// fetch and for a push (the owner's `insteadOf` / `pushInsteadOf`, resolved
// by git itself, main/worktask/taskPush.ts).

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

/** An origin URL's address in one spelling (for display and tests), or null
 *  when it is not a plain https or ssh address. Pure. */
export function normalizeOriginPin(url: unknown): string | null {
  const a = parseOriginAddress(url);
  return a ? pinOf(a) : null;
}

/** Whether `v` can be a pin: a plain https or ssh address. Pure. */
export function isOriginPin(v: unknown): v is string {
  return parseOriginAddress(v) !== null;
}

function sameEndpoint(a: OriginAddress, b: OriginAddress): boolean {
  return a.form === b.form && a.user === b.user && a.host === b.host && a.port === b.port && a.path.toLowerCase() === b.path.toLowerCase();
}

/** Whether the origin URL `url` names the repository `pin` recorded: the
 *  same form, user, host and port, the path in any case. Pure. */
export function originPinMatches(pin: string, url: string): boolean {
  const a = parseOriginAddress(pin);
  const b = parseOriginAddress(url);
  return a !== null && b !== null && sameEndpoint(a, b);
}

/** Whether two URLs git connects to (after its rewrites) are one endpoint:
 *  as originPinMatches when both are plain addresses, else the same string.
 *  Pure. */
export function sameOriginEndpoint(a: string, b: string): boolean {
  const x = parseOriginAddress(a);
  const y = parseOriginAddress(b);
  return x && y ? sameEndpoint(x, y) : a === b;
}

/** Whether the address names a port other than its transport's default
 *  (https 443, ssh 22). Pure. */
export function namesNonDefaultPort(a: OriginAddress): boolean {
  return a.form === 'https' ? a.port !== HTTPS_PORT : a.port !== null && a.port !== SSH_PORT;
}
