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
//   - https:       `https://<host>:<port>/<path>`   (no user; default 443)
//   - ssh URL:     `ssh://[<user>@]<host>:<port>/<path>`   (default 22)
//   - scp-style:   `<user>@<host>:<path>`   (relative to the server's home)
// trimmed, one trailing `/` and a trailing `.git` dropped, the host
// lowercased, the default port written out; the path keeps its case, the ssh
// user and the scp-style vs `ssh://` form are kept as written. The accepted
// addresses are exactly those originUrlRepoKey (main/worktask/workerGit.ts)
// accepts. An ssh Host alias (`git@github-work:org/repo`) is a host name
// like any other: kept as written, never resolved through ssh's config.
//
// The compare (originPinMatches):
//   - the host and the port are compared exactly;
//   - the path is compared ignoring case (GitHub, GitHub Enterprise and
//     GitLab name a repository case-insensitively);
//   - two ssh addresses must use the same user and the same form;
//   - the transport-switch rule: an https address and an ssh address (either
//     form) name the same repository when the host and the path match and
//     each is on its transport's default port (443, 22).

/** Path segments after the host (GitLab nests groups up to 20 deep). */
const MAX_PATH_SEGMENTS = 21;
const ORIGIN_PIN_MAX = 2048;
const DEFAULT_PORT = { https: 443, ssh: 22 } as const;

export interface OriginAddress {
  form: 'https' | 'ssh' | 'scp';
  /** The ssh user (null: an https address, or `ssh://` with none). */
  user: string | null;
  /** Lowercased. */
  host: string;
  port: number;
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

function addressPort(raw: string | undefined, form: 'https' | 'ssh'): number | null {
  if (raw === undefined) return DEFAULT_PORT[form];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function validHost(host: string): boolean {
  return host !== '.' && host !== '..' && !host.startsWith('-');
}

/** A plain https or ssh address (or a pin) → its parts, or null for any
 *  other form. Pure. */
export function parseOriginAddress(url: unknown): OriginAddress | null {
  if (typeof url !== 'string' || url.length > ORIGIN_PIN_MAX) return null;
  const s = url.trim().replace(/\/$/, '');
  let m = HTTPS_RE.exec(s);
  if (m) {
    const port = addressPort(m[2], 'https');
    const p = addressPath(m[3]);
    const host = m[1].toLowerCase();
    return port !== null && p !== null && validHost(host) ? { form: 'https', user: null, host, port, path: p } : null;
  }
  m = SSH_RE.exec(s);
  if (m) {
    const port = addressPort(m[3], 'ssh');
    const p = addressPath(m[4]);
    const host = m[2].toLowerCase();
    const user = m[1] ?? null;
    return port !== null && p !== null && validHost(host) && !user?.startsWith('-') ? { form: 'ssh', user, host, port, path: p } : null;
  }
  m = SCP_RE.exec(s);
  if (m) {
    const p = addressPath(m[3]);
    const host = m[2].toLowerCase();
    return p !== null && validHost(host) && !m[1].startsWith('-') ? { form: 'scp', user: m[1], host, port: DEFAULT_PORT.ssh, path: p } : null;
  }
  return null;
}

/** An origin URL → its pin, or null when it is not a plain https or ssh
 *  address. Pure; a pin normalizes to itself. */
export function normalizeOriginPin(url: unknown): string | null {
  const a = parseOriginAddress(url);
  if (!a) return null;
  if (a.form === 'https') return `https://${a.host}:${a.port}/${a.path}`;
  if (a.form === 'ssh') return `ssh://${a.user ? `${a.user}@` : ''}${a.host}:${a.port}/${a.path}`;
  return `${a.user}@${a.host}:${a.path}`;
}

/** Whether `v` is a pin in its canonical form. Pure. */
export function isOriginPin(v: unknown): v is string {
  return typeof v === 'string' && normalizeOriginPin(v) === v;
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
  if (aSsh === bSsh) {
    if (a.port !== b.port) return false;
    return !aSsh || (a.form === b.form && a.user === b.user);
  }
  // The transport-switch rule: both on their transport's default port.
  return a.port === DEFAULT_PORT[aSsh ? 'ssh' : 'https'] && b.port === DEFAULT_PORT[bSsh ? 'ssh' : 'https'];
}
