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
 *     --show-toplevel`, `config --list --name-only`, `diff`, `diff --cached`,
 *     `status --porcelain`, and one `diff --no-index` per untracked file.
 *     Nothing here writes, fetches, checks out, or runs a hook.
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
 * commands themselves: the flags cover the `.gitattributes` DIFF drivers, the
 * `-c`s cover the config keys.
 *
 * NOT sufficient on their own — see `filterOverrides`. `--no-ext-diff` and
 * `--no-textconv` disable the diff-side drivers only; a `.gitattributes`
 * `filter=` selects a CONTENT filter, and `filter.<name>.clean` runs while git
 * converts working-tree content, which `git diff` and `git status` both do.
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
 * The config keys whose VALUE is a command git will spawn to convert content.
 * `smudge` never runs on a read path, but a repo that only sets `smudge` and
 * `required` still has a filter git may complain about, and blanking all three
 * is one rule instead of a case analysis.
 */
const FILTER_SUBKEYS = ['clean', 'smudge', 'process'] as const;

/**
 * Extract the filter names a config listing defines, from
 * `git config --list --name-only -z` output.
 *
 * A key is `filter.<name>.<subkey>` and `<name>` MAY CONTAIN DOTS
 * (`filter.my.weird.name.clean` is one filter called `my.weird.name`), so the
 * name is everything between the first and last dot — not `split('.')[1]`.
 * Exported for the test that pins that.
 */
export function parseFilterNames(configList: string): string[] {
  const names = new Set<string>();
  for (const key of configList.split('\0')) {
    const k = key.trim();
    if (!k.startsWith('filter.')) continue;
    const lastDot = k.lastIndexOf('.');
    if (lastDot <= 'filter.'.length - 1) continue;
    const sub = k.slice(lastDot + 1);
    if (sub !== 'required' && !(FILTER_SUBKEYS as readonly string[]).includes(sub)) continue;
    const name = k.slice('filter.'.length, lastDot);
    if (name) names.add(name);
  }
  return [...names];
}

/** `-c` overrides that disarm every named filter. */
export function filterOverrideArgs(names: readonly string[]): string[] {
  const args: string[] = [];
  for (const n of names) {
    for (const sub of FILTER_SUBKEYS) args.push('-c', `filter.${n}.${sub}=`);
    // An empty command means "no filter". `required=true` would otherwise turn
    // that into a hard error on every file the filter is attached to.
    args.push('-c', `filter.${n}.required=false`);
  }
  return args;
}

/**
 * Discover and disarm the repository's content filters, BEFORE anything reads
 * working-tree content.
 *
 * WHY THIS IS NOT COVERED BY THE `-c`s ABOVE: a `.gitattributes` line
 * `*.txt filter=pwn` plus a `filter.pwn.clean = <command>` in the repository's
 * own `.git/config` makes `git diff` — the hardened one, with `--no-ext-diff
 * --no-textconv` — execute that command while it converts the working-tree
 * file for comparison. Verified on git 2.50: the marker file gets created.
 * `--no-textconv` covers the `diff=` attribute; nothing on the argv covers
 * `filter=`, and git offers no way to ignore the repository's own
 * `.gitattributes`. So the only closure is to blank the config keys the
 * attribute resolves to — which requires knowing their names, which means
 * asking git for them first.
 *
 * `git config --list --name-only` reads config and prints KEY NAMES only; it
 * converts no content and spawns nothing, so it is safe to run first. This
 * FAILS CLOSED: if we cannot enumerate the filters we cannot claim to have
 * disarmed them, so the request errors instead of running a diff we have not
 * hardened.
 */
export async function resolveFilterOverrides(
  cwd: string,
  run: GitRunner,
): Promise<{ ok: true; args: string[] } | { ok: false; detail: string }> {
  const listed = await run(gitArgv('config', '--list', '--name-only', '-z'), cwd);
  if (!listed.ok) return { ok: false, detail: firstLine(listed.stderr) };
  return { ok: true, args: filterOverrideArgs(parseFilterNames(listed.stdout)) };
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
  /**
   * git's own exit status, when it ran and produced one. Undefined when it
   * never got to exit (spawn failure, our timeout, maxBuffer).
   *
   * Needed because `ok`/`ran` cannot express `--no-index`'s three-way answer:
   * 0 = identical, 1 = there is a difference (the normal case here), >1 = git
   * failed. Without the number, "could not access the file" reads exactly like
   * "here is your patch".
   *
   * Optional for the same reason `ran` is: a test double that does not care
   * about the distinction stays three fields, and ABSENT MEANS "no opinion",
   * never "failed". The real runner sets it whenever `ran` is true, so the
   * two are never both unknown on a real failure.
   */
  code?: number;
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
            code: !err ? 0 : typeof err.code === 'number' && err.killed !== true ? err.code : undefined,
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
  /**
   * Overall wall clock for the untracked-file pass. See
   * `UNTRACKED_TOTAL_BUDGET_MS`.
   */
  untrackedBudgetMs?: number;
  /** Injectable clock, so the budget is testable without sleeping. */
  now?: () => number;
}

/**
 * Ceiling on the WHOLE untracked pass, on top of each invocation's own
 * `GIT_TIMEOUT_MS`.
 *
 * Twenty sequential files × a five-second per-command timeout is a hundred
 * seconds of one request, and two such requests hold both diff slots for that
 * long — every other approval diff gets `busy` in the meantime, on a route
 * whose whole point is answering an approval quickly. The per-command timeout
 * bounds one stall; this bounds a repository that stalls on every file. Sized
 * so the total request stays inside the same order of magnitude as the three
 * top-level commands, and overrunning it is reported as `patchIncomplete`
 * rather than as a clean empty patch.
 */
export const UNTRACKED_TOTAL_BUDGET_MS = 15_000;

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
  //
  // BUT ONLY THOSE. `rev-parse` also exits nonzero for a repository that
  // EXISTS and is broken — `fatal: bad config line`, `detected dubious
  // ownership`, unreadable metadata — and answering those with the 409 makes
  // the phone say "this pane is not a git repository" about a directory that
  // plainly is one, sending the human to look in the wrong place. A nonzero
  // exit is therefore classified by what git said, and anything unrecognised
  // is a server-side failure with the detail kept for the log.
  if (!inside.ok) {
    if (!isNotARepoStderr(inside.stderr)) {
      return { ok: false, reason: 'git-failed', detail: firstLine(inside.stderr) };
    }
    return { ok: false, reason: 'not-a-git-repo' };
  }
  if (lines[0]?.trim() !== 'true') {
    // Exit 0 saying "false" is the bare-repo answer: a real repository with no
    // working tree, which is still "nothing to diff".
    return { ok: false, reason: 'not-a-git-repo' };
  }
  const root = lines[1]?.trim() || cwd;

  // MUST precede every command below: those read working-tree CONTENT, which
  // is when a configured clean/process filter would run. See
  // `resolveFilterOverrides`.
  const filters = await resolveFilterOverrides(cwd, run);
  if (!filters.ok) {
    return { ok: false, reason: 'git-failed', detail: filters.detail };
  }
  const argv = (...args: string[]): string[] => [
    ...GIT_HARDENING_CONFIG,
    ...filters.args,
    ...args,
  ];

  const statusArgv = argv('status', '--porcelain', '-z', '--untracked-files=all');
  const [staged, unstaged, status] = await Promise.all([
    run(argv('diff', '--cached', '--no-ext-diff', '--no-textconv'), cwd),
    run(argv('diff', '--no-ext-diff', '--no-textconv'), cwd),
    run(statusArgv, cwd),
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

  const untracked = await collectUntrackedPatches(files, root, run, argv, opts);
  parts.push(untracked.patch);
  if (untracked.incomplete) incomplete = true;

  // THE TREE MAY HAVE MOVED UNDER US. These commands are separate processes
  // over a window that includes up to twenty more of them, and the agent whose
  // work is being reviewed is still running: `git add` landing between the
  // cached and worktree reads produces a change that is in NEITHER patch while
  // `status` still lists the file — a changed file, an empty patch, and
  // `patchIncomplete: false`, which the phone contract reads as "safe to
  // approve, there is nothing to see". Re-running `status` after the whole
  // collection is one cheap command that detects exactly that: if the tree
  // reports the same state at both ends of the window, the patches in between
  // describe it; if it does not, the answer is partial and says so. (Detect,
  // not retry — a busy agent could lose a retry loop indefinitely, and a
  // truthful partial answer beats a slow one on an approval screen.)
  const recheck = await run(statusArgv, cwd);
  if (!recheck.ok || recheck.stdout !== status.stdout) incomplete = true;

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
  argv: (...args: string[]) => string[],
  opts: CollectDiffOptions,
): Promise<{ patch: string; incomplete: boolean }> {
  const untracked = files.filter((f) => f.status === '??');
  // Trailing '/' means git gave up and named a whole DIRECTORY (unreadable, or
  // a nested repository); there is no single file to render a hunk from. It is
  // still content the reviewer is not being shown while `files[]` advertises
  // it, so skipping it is exactly the "partial patch presented as complete"
  // case `patchIncomplete` exists for — even though no individual file failed.
  const paths = untracked.filter((f) => !f.path.endsWith('/')).map((f) => f.path);
  let incomplete = paths.length < untracked.length;
  const shown = paths.slice(0, UNTRACKED_DIFF_LIMIT);
  if (paths.length > shown.length) incomplete = true;

  const now = opts.now ?? Date.now;
  const budget = opts.untrackedBudgetMs ?? UNTRACKED_TOTAL_BUDGET_MS;
  const deadline = now() + budget;

  const out: string[] = [];
  for (const p of shown) {
    // Overall deadline, checked before spending another five-second timeout.
    if (now() >= deadline) {
      incomplete = true;
      break;
    }
    const r = await run(
      argv('diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', p),
      root,
    );
    // `--no-index` exits 1 whenever there IS a difference, which is every time
    // here, so `ok` is meaningless and only the exit STATUS separates the
    // answers: 0/1 are git describing the file, anything else is git failing to
    // read it ("Could not access", a vanished file, a special file it will not
    // open). Both that and never exiting at all (a timeout, an oversized file,
    // a git that does not accept /dev/null on Windows) make the patch partial —
    // say so rather than appending the empty stdout of a failure, which is
    // indistinguishable from an empty new file that genuinely has no hunk.
    if (r.ran === false || (r.code !== undefined && r.code > 1)) incomplete = true;
    else out.push(r.stdout);
  }
  return { patch: out.join(''), incomplete };
}

/**
 * Does this `rev-parse` failure mean "there is no repository here", as opposed
 * to "the repository here is broken"?
 *
 * Matched on git's message because the exit status does not distinguish them —
 * both are 128. The list is the set of messages that genuinely mean the path
 * has no usable repository; everything else (bad config, dubious ownership,
 * unreadable objects) is a failure of an existing repo and must surface as one.
 */
function isNotARepoStderr(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('not a git repository') ||
    s.includes('no such file or directory') ||
    s.includes('cannot change to') ||
    s.includes('does not exist')
  );
}

/** git's stderr can be several lines; one is enough to say what went wrong. */
function firstLine(s: string): string {
  return s.split('\n')[0]?.trim().slice(0, 200) ?? '';
}
