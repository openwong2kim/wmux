// ─── Main's network git for a task repository: a main-owned relay ───────────
//
// Main never writes under the task's recorded repository. Its network git for
// a task (push, fetch, ls-remote) runs in a bare "relay" repository main owns,
// under main's data folder, one per task. The relay borrows the recorded
// repository's objects through `objects/info/alternates` (a one-way link: the
// relay reads the recorded objects, the recorded repository never reads the
// relay's). A fetch lands its objects in the relay, not the recorded
// repository; a push reads the commit from the recorded objects through the
// alternate. The worker then updates its own `refs/remotes/origin/*` from the
// relay with the fetch line main returns.
//
// Pure, and shared: the daemon's phone path builds the same argv and env.

import { isDenyableBranchName } from './botWorkerGuard';

/** Transports a relay call may use. */
export const RELAY_GIT_DEFAULT_PROTOCOLS: readonly string[] = ['https', 'ssh'];

/** The lowest git version main runs a task's network git with. */
export const TASK_GIT_VERSION_FLOOR = '2.43.4';

/** The env every git call main makes on a task's recorded repository or its
 *  relay runs with: `extra`, and git never fetches a missing object on its
 *  own. */
export function taskGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, GIT_NO_LAZY_FETCH: '1' };
}

/** `-c` options on every relay call (after `safe`, main's own safe options):
 *  no automatic gc or maintenance, no commit-graph or multi-pack index read
 *  or written, a fetch keeps what it receives as a pack (never written out
 *  as loose objects), and only the listed transports. */
export function relayGitConfigArgs(safe: readonly string[], protocols: readonly string[] = RELAY_GIT_DEFAULT_PROTOCOLS): string[] {
  const forced = [
    'gc.auto=0',
    'maintenance.auto=false',
    'core.commitGraph=false',
    'core.multiPackIndex=false',
    'fetch.unpackLimit=1',
    'transfer.unpackLimit=1',
    'protocol.allow=never',
    ...protocols.map((p) => `protocol.${p}.allow=always`),
  ];
  return [...safe, ...forced.flatMap((kv) => ['-c', kv])];
}

export interface RawGitConfigEntry { scope: string; key: string; value: string }

/** `git config -z --list --show-scope` output → entries, keys as git printed
 *  them (a subsection keeps its case). */
export function parseRawGitConfigList(stdout: string): RawGitConfigEntry[] {
  const parts = stdout.split('\0');
  const out: RawGitConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf('\n');
    out.push({ scope: parts[i], key: nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl), value: nl < 0 ? '' : parts[i + 1].slice(nl + 1) });
  }
  return out;
}

/** Keys of how git connects and authenticates. */
const TRANSPORT_KEY_RE = /^(?:credential\.|url\.|http\.|ssh\.)|^core\.sshcommand$/i;
/** Scopes that are the owner's, not the repository's. */
const OWNER_SCOPES = new Set(['system', 'global', 'unknown']);

function ownerTransport(entries: readonly RawGitConfigEntry[]): RawGitConfigEntry[] {
  return entries.filter((e) => OWNER_SCOPES.has(e.scope) && TRANSPORT_KEY_RE.test(e.key));
}

function groupInOrder(entries: readonly RawGitConfigEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) out.set(e.key, [...(out.get(e.key) ?? []), e.value]);
  return out;
}

/** Credential keys: git gathers every `credential.helper` and
 *  `credential.<url>.helper` into one ordered list, and an empty value clears
 *  the list gathered so far. */
const isCredential = (key: string) => /^credential\./i.test(key);
/** A list key whose empty value clears it (`http.extraHeader`, also per URL). */
const isClearableList = (key: string) => /^http\.(?:.+\.)?extraheader$/i.test(key);
const isUrlRewrite = (key: string) => /^url\./i.test(key);

/**
 * The `-c key=value` settings that make the relay's owner transport config
 * match the recorded repository's (`context`: the config read with the
 * recorded git dir; `relay`: the config read in the relay). Only the owner
 * scopes count (the recorded repository's own config never carries over).
 *
 *  - Credential keys are one ordered list: when it differs, it is cleared
 *    (`credential.helper=`) and replayed in the recorded order.
 *  - `http.extraHeader` (also per URL) is cleared and replayed when it
 *    differs, and cleared when only the relay has it.
 *  - A URL rewrite is only added, never reset: an empty rewrite base matches
 *    every URL.
 *  - Every other key holds one value, the last one read: the recorded values
 *    are replayed, so the last recorded value wins.
 */
export function transportConfigReplay(context: readonly RawGitConfigEntry[], relay: readonly RawGitConfigEntry[]): string[] {
  const ctxAll = ownerTransport(context);
  const relAll = ownerTransport(relay);
  const out: string[] = [];
  const sameEntries = (a: readonly RawGitConfigEntry[], b: readonly RawGitConfigEntry[]) =>
    a.length === b.length && a.every((e, i) => e.key.toLowerCase() === b[i].key.toLowerCase() && e.value === b[i].value);
  const ctxCred = ctxAll.filter((e) => isCredential(e.key));
  const relCred = relAll.filter((e) => isCredential(e.key));
  if (!sameEntries(ctxCred, relCred)) {
    out.push('credential.helper=');
    for (const e of ctxCred) out.push(`${e.key}=${e.value}`);
  }
  const ctx = groupInOrder(ctxAll.filter((e) => !isCredential(e.key)));
  const rel = groupInOrder(relAll.filter((e) => !isCredential(e.key)));
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const [key, values] of ctx) {
    const have = rel.get(key) ?? [];
    if (same(values, have)) continue;
    if (isUrlRewrite(key)) {
      const missing = [...values];
      for (const v of have) {
        const i = missing.indexOf(v);
        if (i >= 0) missing.splice(i, 1);
      }
      for (const v of missing) out.push(`${key}=${v}`);
    } else if (isClearableList(key)) {
      out.push(`${key}=`);
      for (const v of values) out.push(`${key}=${v}`);
    } else {
      for (const v of values) out.push(`${key}=${v}`);
    }
  }
  for (const [key] of rel) {
    if (!ctx.has(key) && isClearableList(key)) out.push(`${key}=`);
  }
  return out;
}

/** Why this version is not one known to honour GIT_NO_LAZY_FETCH, or null.
 *  `stdout` is `git --version` output. Known: the releases from 2.43.4 on
 *  (2.43.4+, 2.44.1+, 2.45.1+) and 2.46 or later. Any other version runs the
 *  capability check (taskPush.ts gitLazyFetchRefusal). Pure. */
export function gitVersionRefusal(stdout: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!m) return `git's version could not be read (${stdout.trim().slice(0, 80)})`;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ok = maj > 2 || (maj === 2 && (min >= 46 || (min === 45 && pat >= 1) || (min === 44 && pat >= 1) || (min === 43 && pat >= 4)));
  return ok ? null : `git ${maj}.${min}.${pat} is not one a task's network git runs with (${TASK_GIT_VERSION_FLOOR}, 2.44.1, 2.45.1, or 2.46 and later)`;
}

/** What git prints when GIT_NO_LAZY_FETCH stops a lazy fetch: "lazy fetching
 *  disabled; some objects may not be available" (promisor-remote.c, the same
 *  text from the 2.39.4 backport through 2.46 and later). The message is
 *  translated, so the capability check runs git with LC_ALL=C. */
export const LAZY_FETCH_DISABLED_TEXT = 'lazy fetching disabled';

/** What git prints when it went on to fetch from the promisor remote. */
const LAZY_FETCH_ATTEMPT_RE = /does not appear to be a git repository|transport '[^']*' not allowed|could not read from remote/i;

/** The capability check's verdict on its last git call (a diff that needs a
 *  blob only the promisor remote has): null when git stopped the fetch for
 *  GIT_NO_LAZY_FETCH, else why main will not run a task's git with it.
 *  `versionStdout` is `git --version` output. Pure. */
export function lazyFetchProbeRefusal(versionStdout: string, out: { code: number; stderr: string; timedOut?: boolean }): string | null {
  const honoured = !out.timedOut && out.code !== 0 && out.stderr.includes(LAZY_FETCH_DISABLED_TEXT) && !LAZY_FETCH_ATTEMPT_RE.test(out.stderr);
  if (honoured) return null;
  const ver = versionStdout.trim().slice(0, 80) || 'git';
  return `${ver} does not honour GIT_NO_LAZY_FETCH${out.timedOut ? ' (its check did not finish in time)' : ''}`;
}

/** A shell word for the worker's shell, or null when it cannot be written as
 *  one safely: single-quoted on posix (a WSL distro included); on a Windows
 *  host double-quoted, and refused when it holds a character cmd or
 *  PowerShell would expand inside double quotes. Pure. */
export function shellQuote(word: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return /["%!$`]/.test(word) ? null : `"${word}"`;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/** The `git fetch` line the worker runs in its own shell to bring the fetched
 *  branches into its `refs/remotes/origin/*` from the relay, or null when a
 *  word cannot be quoted for that shell. `program` is the git it names
 *  (`git.exe` for a WSL shell on a Windows-host repository). Pure. */
export function fetchCommandFor(relayPath: string, refspecs: readonly string[], platform: NodeJS.Platform, program = 'git'): string | null {
  const words = [relayPath, ...refspecs].map((w) => shellQuote(w, platform));
  if (words.some((w) => w === null)) return null;
  // `--no-write-fetch-head`: the worker only wants its `refs/remotes/origin/*`
  // updated, and a sandboxed worker (codexWorkerGuard) can write the common
  // dir's objects, refs and logs but not a FETCH_HEAD beside them.
  return [program, 'fetch', '--no-tags', '--no-write-fetch-head', ...(words as string[])].join(' ');
}

/** A branch name main hands git as a plain ref name: git's own branch-name
 *  rules (`git check-ref-format --branch`), plus no whitespace, quote or
 *  revision-syntax character. Pure. */
export function isPlainTaskBranchName(name: string): boolean {
  return isDenyableBranchName(name) && !name.split('/').some((c) => c.endsWith('.lock'));
}

/** What a worktree's HEAD file holds, read strictly. */
export type TaskHead = { kind: 'oid'; oid: string } | { kind: 'ref'; ref: string };

/** A worktree HEAD file's text → a full commit id of the repository's object
 *  format, or `refs/heads/<name>` with a plain branch name; null for anything
 *  else. Git writes HEAD as exactly one of those and a newline. Pure. */
export function parseTaskHead(text: string, objectFormat: string): TaskHead | null {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const hex = objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : null;
  if (!hex) return null;
  if (hex.test(body)) return { kind: 'oid', oid: body };
  const prefix = 'ref: refs/heads/';
  if (!body.startsWith(prefix)) return null;
  const name = body.slice(prefix.length);
  return isPlainTaskBranchName(name) ? { kind: 'ref', ref: `refs/heads/${name}` } : null;
}
