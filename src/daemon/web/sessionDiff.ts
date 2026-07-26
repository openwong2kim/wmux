import { execFile } from 'node:child_process';

/**
 * "What did this agent change?" — the working-tree diff of a pane's repository,
 * for the phone to read BEFORE it answers an approval.
 *
 * An approval prompt on a phone is a decision made with almost no context: the
 * screen tail says `Edit file? (y/n)` and nothing about what the edit is. The
 * pane's cwd is usually a git working tree, and git already holds the exact
 * answer, so this module reads it.
 *
 * Security posture (the whole reason this is a separate module):
 *   - READ-ONLY git only. Fixed argv: `rev-parse --is-inside-work-tree
 *     --show-toplevel`, `diff`, `diff --cached`, `status --porcelain`, and one
 *     `diff --no-index` per untracked file. Nothing here writes, fetches,
 *     checks out, or runs a hook.
 *   - NO REF ARGUMENTS FROM THE CLIENT. There is no `?ref=`, no `?base=`, no
 *     pathspec. `git diff <ref>` accepts things that are not refs (`--output=`,
 *     `--ext-diff` with a configured driver), so the argv is a constant and the
 *     only variable is the cwd.
 *   - "READ-ONLY" IS NOT THE SAME AS "HARMLESS". git reads configuration out of
 *     the repository being inspected, and a repository an agent cloned is
 *     attacker-controlled input. `diff.external`, a `.gitattributes` textconv
 *     or diff driver, and `core.fsmonitor` are all *commands git will execute*
 *     that live inside the checkout. Every invocation is therefore neutered
 *     twice over — by `GIT_HARDENING_CONFIG` on the argv and by
 *     `buildGitEnv()` on the environment. See both for the details.
 *   - THE CWD IS THE DAEMON'S, NOT THE CALLER'S. It comes from the session
 *     record the daemon itself wrote at spawn time (`ManagedSession.meta
 *     .spawnCwd` — deliberately NOT `meta.cwd`, which the daemon updates at
 *     runtime from OSC 7 sequences the pane's own process emits), looked up by
 *     session id. A request cannot name a directory, so this cannot be turned
 *     into "read any repo on the machine".
 *   - `execFile`, never a shell, so a path with a space/quote/`;` in it is an
 *     argument and not syntax.
 *   - Bounded: every command gets a timeout and a maxBuffer, and the assembled
 *     patch is capped before it reaches the socket.
 *
 * A cwd that is not inside a git repo is a NORMAL answer, not an error — panes
 * run in `~`, in `/tmp`, in scratch directories. The caller turns that into a
 * 409 with `not-a-git-repo` so the phone can say so plainly.
 */

/**
 * Cap on the assembled patch. Sized like the SSE snapshot window
 * (snapshotWindow.ts): a phone on a train should not pull a multi-megabyte body
 * to answer one y/n, and a generated-file commit can produce tens of megabytes
 * of diff. Same philosophy, opposite end — the snapshot keeps the TAIL of a
 * terminal ring because the recent screen is what matters, and a patch keeps
 * the HEAD because a unified diff reads from the top.
 */
export const DEFAULT_DIFF_CAP_BYTES = 512 * 1024;

/** Per-command wall clock. A repo on a stalled network mount must not pin a request. */
export const GIT_TIMEOUT_MS = 5_000;

/**
 * Hard ceiling on what we will buffer from git before giving up, independent of
 * the display cap: the cap trims what we SEND, this bounds what we HOLD. Four
 * times the cap, so the truncation path is exercised by real repos rather than
 * only by a killed process.
 */
export const GIT_MAX_BUFFER_BYTES = DEFAULT_DIFF_CAP_BYTES * 4;

/**
 * How many untracked files get their contents rendered into the patch.
 *
 * Untracked files are in `files[]` but contribute nothing to `git diff`, so
 * without this the phone shows "notes.md — ??" and an empty patch, and a human
 * approves against a diff that does not contain the new file. Each one costs a
 * separate git invocation, so it is bounded: twenty is well past the size of an
 * agent edit worth reading on a phone, and anything beyond it sets
 * `patchIncomplete` rather than silently stopping.
 */
export const UNTRACKED_DIFF_LIMIT = 20;

/**
 * `-c` overrides prepended to EVERY git invocation.
 *
 * Each one disables a mechanism by which the repository under inspection could
 * make a "read-only" git command execute something, or lie about what it read:
 *
 *   - `core.fsmonitor=false` — the value is a command git spawns on almost
 *     every operation, including `status`. Repo-local config sets it.
 *   - `diff.external=` — the value is a command that REPLACES git's own diff
 *     engine. Empty means "there is none".
 *   - `diff.noprefix=false` — a repo that sets `noprefix` produces a patch
 *     without the `a/`…`b/` prefixes, i.e. a differently-shaped document than
 *     the client was promised.
 *   - `diff.relative=false` — from a subdirectory, a repo-set `diff.relative`
 *     would hide every change outside that subdirectory from the patch while
 *     `status --porcelain` (always repo-root relative) still listed them.
 *
 * These are belt to the braces of `--no-ext-diff --no-textconv` on the diff
 * commands themselves: the flags cover the `.gitattributes` drivers, the `-c`s
 * cover the config keys.
 */
export const GIT_HARDENING_CONFIG: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.relative=false',
];

/** Prefix `GIT_HARDENING_CONFIG` onto a command's own arguments. */
export function gitArgv(...args: string[]): string[] {
  return [...GIT_HARDENING_CONFIG, ...args];
}

/**
 * The environment every git subprocess gets. An ALLOWLIST, not a filter.
 *
 * WHY: the diff runs against a working tree an agent may have `git clone`d from
 * anywhere, so the repository's own contents are attacker-controlled input. The
 * `-c` overrides above close the repo-CONFIG routes to code execution; this
 * closes the ENVIRONMENT routes, which are the ones an operator's own shell can
 * open by accident and which config overrides cannot reach:
 *
 *   - Inheriting `GIT_EXTERNAL_DIFF` from the daemon's environment would run
 *     that program on every hunk — the exact thing `diff.external=` blocks on
 *     the config side.
 *   - `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` would silently redirect
 *     the whole operation away from the cwd we carefully pinned, which would
 *     defeat the "the caller cannot name a directory" property.
 *   - `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT` are a second, invisible `-c`
 *     channel that could put `core.fsmonitor` straight back.
 *
 * Building the allowlist forward rather than deleting known-bad names means a
 * `GIT_*` variable invented in a future git release is excluded by default
 * instead of by whoever remembers to update a denylist. The system-level config
 * and attributes files are switched off for the same reason the repo-level ones
 * are neutered — this command should behave identically wherever it runs.
 *
 * NOTE ON SCOPE: `GIT_ATTR_NOSYSTEM` disables the SYSTEM gitattributes only.
 * The repository's own `.gitattributes` is still read (git offers no way to
 * ignore it), which is fine: the drivers it can name are disarmed by
 * `--no-ext-diff --no-textconv` on the diff commands.
 */
export function buildGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Enough to find and run the git binary and let it write a temp file; nothing
  // that changes what it reads. Windows names included — git-for-windows needs
  // SystemRoot/COMSPEC/PATHEXT to spawn at all.
  const KEEP = [
    'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'COMSPEC', 'ComSpec',
    'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of KEEP) {
    const v = base[k];
    if (typeof v === 'string') env[k] = v;
  }
  // No GIT_* survived the allowlist; these are the ones we WANT set.
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_ATTR_NOSYSTEM = '1';
  // #7: never take `.git/index.lock`. A read that blocks the agent's own commit
  // (or fails because the agent is mid-commit) is a worse answer than a slightly
  // stale one.
  env.GIT_OPTIONAL_LOCKS = '0';
  // A pager or a credential prompt would hang until the timeout; neither has
  // anywhere to draw on a daemon's stdio.
  env.GIT_PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** One changed path, with its raw porcelain status code. */
export interface DiffFile {
  /** Repo-relative path. For a rename, the NEW path. */
  path: string;
  /**
   * The two-character porcelain v1 code, verbatim (`' M'`, `'M '`, `'MM'`,
   * `'??'`, `'R '`, `'UU'`, …). Deliberately not translated into words here:
   * the index/worktree split is two independent columns and any single-word
   * summary loses one of them. The client renders it.
   */
  status: string;
  /** The old path, present only for a rename/copy entry. */
  from?: string;
}

export interface SessionDiff {
  files: DiffFile[];
  /** Staged patch followed by working-tree patch, capped. */
  patch: string;
  /** True when the patch was cut short by the cap. */
  truncated: boolean;
  /** How many bytes were dropped off the END of the patch. */
  omittedBytes: number;
  /**
   * True when `files[]` is trustworthy but `patch` is NOT the whole story for a
   * reason that is not the cap: a diff command timed out, blew the buffer, or
   * failed inside a driver, or there were more untracked files than
   * `UNTRACKED_DIFF_LIMIT`.
   *
   * WHY THIS EXISTS, stated bluntly: without it a failed `git diff` degraded to
   * `patch: ''` with `truncated: false`, which on a phone is indistinguishable
   * from a clean tree. A human then approves an edit against a screen that says
   * "no changes". A partial answer is fine; a partial answer that presents
   * itself as complete is not. `truncated` stays for the cap case alone so a
   * client can still say "512 KB shown" separately from "something failed".
   */
  patchIncomplete: boolean;
}

export type SessionDiffResult =
  | { ok: true; diff: SessionDiff }
  | { ok: false; reason: 'not-a-git-repo' | 'git-failed'; detail?: string };

/** Result of one git invocation. Never throws — a failure is data. */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /**
   * Did git actually execute and exit on its own?
   *
   * `ok: false` conflates two very different things: git ran and said no
   * (exit 1 — "not a repository", "no differences"), versus git never got to
   * answer (no binary on PATH, killed by our timeout, output over maxBuffer).
   * Only the FIRST may be reported to a client as "this pane is not a git
   * repository"; the second is a server-side failure and must not be dressed up
   * as a fact about the user's directory.
   *
   * Optional, defaulting to true, so a test double stays three fields.
   */
  ran?: boolean;
}

/**
 * How this module talks to git. A seam, for the same reason `now` is one on the
 * web server: the route's status-code mapping and the cap behaviour are worth
 * testing without a real repository on the test machine's disk.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunResult>;

/** The real runner: `execFile('git', …)` with a timeout and a buffer ceiling. */
export function createGitRunner(): GitRunner {
  // Built once: the allowlist is a function of the daemon's own environment,
  // which does not change under it.
  const env = buildGitEnv();
  return (args, cwd) =>
    new Promise<GitRunResult>((resolve) => {
      execFile(
        'git',
        [...args],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true, env },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            // `err.code` is a NUMBER when git ran and exited nonzero, and a
            // string ('ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') when the
            // spawn or the plumbing failed. `killed` covers our own timeout.
            ran: !err || (typeof err.code === 'number' && err.killed !== true),
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : err ? String(err.message) : '',
          });
        },
      );
    });
}

/**
 * Parse `git status --porcelain -z --untracked-files=all`.
 *
 * `-z` rather than the default line format on purpose: without it git quotes
 * and C-escapes any path with a space, a non-ASCII byte or a quote in it
 * (`core.quotepath`), so a plain split would hand the client a path that does
 * not exist. With `-z` the records are NUL-separated and the bytes are literal,
 * so there is nothing to unescape and nothing to get wrong.
 *
 * Record shape: `XY<space><path>` and, for rename/copy entries (`R`/`C` in
 * either column), a SECOND NUL-terminated field holding the original path.
 */
export function parsePorcelainZ(out: string): DiffFile[] {
  const fields = out.split('\0');
  const files: DiffFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    // Trailing empty field after the final NUL, and any stray blank.
    if (!rec || rec.length < 4) continue;
    const status = rec.slice(0, 2);
    // Byte 2 is the separator space; the path is everything after it.
    const path = rec.slice(3);
    if (!path) continue;
    if (status.includes('R') || status.includes('C')) {
      // The original path is the NEXT field, consumed here so it is not read
      // as a record of its own.
      const from = fields[++i];
      files.push(from ? { path, status, from } : { path, status });
    } else {
      files.push({ path, status });
    }
  }
  return files;
}

export interface CappedPatch {
  patch: string;
  truncated: boolean;
  omittedBytes: number;
}

/**
 * Trim a patch to `maxBytes`, keeping the FRONT.
 *
 * Measured and cut in BYTES, not characters: the cap exists to bound what goes
 * on the socket, and a patch full of non-ASCII would otherwise be several times
 * the number the cap claims. The cut is walked backwards off any UTF-8
 * continuation byte, so the result never ends mid-character — the same
 * guarantee `capSnapshot` gives at the other edge, and for the same reason
 * (a half character renders as U+FFFD and looks like corruption in the diff).
 */
export function capPatch(patch: string, maxBytes: number = DEFAULT_DIFF_CAP_BYTES): CappedPatch {
  const buf = Buffer.from(patch, 'utf8');
  const limit =
    Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_DIFF_CAP_BYTES;
  if (buf.length <= limit) return { patch, truncated: false, omittedBytes: 0 };

  let cut = limit;
  // At most 3 steps: a UTF-8 sequence is at most 4 bytes, so the encoding is
  // the bound and no constant is needed.
  let steps = 0;
  while (cut > 0 && steps < 3 && (buf[cut] & 0xc0) === 0x80) {
    cut--;
    steps++;
  }
  return {
    patch: buf.subarray(0, cut).toString('utf8'),
    truncated: true,
    omittedBytes: buf.length - cut,
  };
}

export interface CollectDiffOptions {
  maxBytes?: number;
}

/**
 * Collect the diff for one working tree.
 *
 * Fixed-argv commands: is-this-a-repo (+ where its root is), staged patch,
 * unstaged patch, status, then one `--no-index` patch per untracked file. The
 * patches are concatenated staged-first — a unified diff stream is just a
 * sequence of file hunks, so the concatenation is itself a valid patch, and
 * "what is already staged" reads first because that is the part an agent has
 * decided on.
 */
export async function collectSessionDiff(
  cwd: string,
  run: GitRunner,
  opts: CollectDiffOptions = {},
): Promise<SessionDiffResult> {
  // `--show-toplevel` in the same invocation, because the untracked patches
  // below need it: `status --porcelain` always reports paths relative to the
  // repository ROOT, while `cwd` may be any subdirectory of it.
  const inside = await run(gitArgv('rev-parse', '--is-inside-work-tree', '--show-toplevel'), cwd);
  // #8: only a git that RAN may be quoted as saying "this is not a repository".
  // A missing binary or a timeout is our problem, not a fact about the pane's
  // directory, and reporting it as 409 would tell the human to go look at a
  // directory that is perfectly fine.
  if (inside.ran === false) {
    return { ok: false, reason: 'git-failed', detail: firstLine(inside.stderr) };
  }
  const lines = inside.stdout.split('\n');
  // A missing cwd, a bare repo and "not a repo at all" all land here. They are
  // one answer to the caller: there is no working tree to diff.
  if (!inside.ok || lines[0]?.trim() !== 'true') {
    return { ok: false, reason: 'not-a-git-repo' };
  }
  const root = lines[1]?.trim() || cwd;

  const [staged, unstaged, status] = await Promise.all([
    run(gitArgv('diff', '--cached', '--no-ext-diff', '--no-textconv'), cwd),
    run(gitArgv('diff', '--no-ext-diff', '--no-textconv'), cwd),
    run(gitArgv('status', '--porcelain', '-z', '--untracked-files=all'), cwd),
  ]);

  // A repo with no commits yet makes `diff --cached` fail (no HEAD to compare
  // against) while `status` still answers — so a failed patch command is not
  // fatal on its own; it is reported through `patchIncomplete` below. Only
  // losing `status` means we cannot describe the tree at all.
  if (!status.ok) {
    return { ok: false, reason: 'git-failed', detail: firstLine(status.stderr) };
  }

  const files = parsePorcelainZ(status.stdout);
  const parts = [staged.ok ? staged.stdout : '', unstaged.ok ? unstaged.stdout : ''];
  let incomplete = !staged.ok || !unstaged.ok;

  const untracked = await collectUntrackedPatches(files, root, run);
  parts.push(untracked.patch);
  if (untracked.incomplete) incomplete = true;

  const capped = capPatch(parts.join(''), opts.maxBytes ?? DEFAULT_DIFF_CAP_BYTES);
  return {
    ok: true,
    diff: {
      files,
      patch: capped.patch,
      truncated: capped.truncated,
      omittedBytes: capped.omittedBytes,
      patchIncomplete: incomplete,
    },
  };
}

/**
 * Render untracked files into the patch with `git diff --no-index`.
 *
 * `git diff` only knows about tracked content, so a brand-new file an agent
 * just wrote appears in `files[]` as `??` and nowhere in the patch — precisely
 * the change a reviewer most needs to see. `--no-index /dev/null <path>`
 * produces a normal add-hunk for it.
 *
 * Still fixed argv: the only variable is a path git itself just told us about,
 * it goes after a literal `--` so it can never be read as an option, and it
 * runs under the same hardening and the same sanitized environment as
 * everything else. `--no-index` exits 1 whenever there IS a difference, which
 * is every time here, so `ok` is meaningless and `ran` is what we check.
 */
async function collectUntrackedPatches(
  files: readonly DiffFile[],
  root: string,
  run: GitRunner,
): Promise<{ patch: string; incomplete: boolean }> {
  // Trailing '/' means git gave up and named a whole directory (unreadable, or
  // a nested repo); there is no single file to render.
  const paths = files.filter((f) => f.status === '??' && !f.path.endsWith('/')).map((f) => f.path);
  const shown = paths.slice(0, UNTRACKED_DIFF_LIMIT);
  let incomplete = paths.length > shown.length;
  const out: string[] = [];
  for (const p of shown) {
    const r = await run(
      gitArgv('diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', p),
      root,
    );
    // A timeout, an oversized file, or a git that does not accept /dev/null
    // (Windows): say the patch is partial rather than silently dropping a file
    // the reviewer can see in `files[]`. Empty stdout is NOT a failure — an
    // empty new file genuinely has no hunk.
    if (r.ran === false) incomplete = true;
    else out.push(r.stdout);
  }
  return { patch: out.join(''), incomplete };
}

/** git's stderr can be several lines; one is enough to say what went wrong. */
function firstLine(s: string): string {
  return s.split('\n')[0]?.trim().slice(0, 200) ?? '';
}
