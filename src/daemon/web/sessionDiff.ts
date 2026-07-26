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
 *   - READ-ONLY git only. Three commands, all fixed argv: `rev-parse
 *     --is-inside-work-tree`, `diff`, `diff --cached`, `status --porcelain`.
 *     Nothing here writes, fetches, checks out, or runs a hook.
 *   - NO REF ARGUMENTS FROM THE CLIENT. There is no `?ref=`, no `?base=`, no
 *     pathspec. `git diff <ref>` accepts things that are not refs (`--output=`,
 *     `--ext-diff` with a configured driver), so the argv is a constant and the
 *     only variable is the cwd.
 *   - THE CWD IS THE DAEMON'S, NOT THE CALLER'S. It comes from the session
 *     record the daemon itself wrote at spawn time (`ManagedSession.meta.cwd`),
 *     looked up by session id. A request cannot name a directory, so this
 *     cannot be turned into "read any repo on the machine".
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
}

export type SessionDiffResult =
  | { ok: true; diff: SessionDiff }
  | { ok: false; reason: 'not-a-git-repo' | 'git-failed'; detail?: string };

/** Result of one git invocation. Never throws — a failure is data. */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * How this module talks to git. A seam, for the same reason `now` is one on the
 * web server: the route's status-code mapping and the cap behaviour are worth
 * testing without a real repository on the test machine's disk.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunResult>;

/** The real runner: `execFile('git', …)` with a timeout and a buffer ceiling. */
export function createGitRunner(): GitRunner {
  return (args, cwd) =>
    new Promise<GitRunResult>((resolve) => {
      execFile(
        'git',
        [...args],
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          windowsHide: true,
          // A pager or a credential prompt would hang until the timeout;
          // neither has anywhere to draw on a daemon's stdio.
          env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
        },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
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
 * Four fixed-argv commands: is-this-a-repo, staged patch, unstaged patch,
 * status. The two patches are concatenated staged-first — a unified diff stream
 * is just a sequence of file hunks, so the concatenation is itself a valid
 * patch, and "what is already staged" reads first because that is the part an
 * agent has decided on.
 */
export async function collectSessionDiff(
  cwd: string,
  run: GitRunner,
  opts: CollectDiffOptions = {},
): Promise<SessionDiffResult> {
  const inside = await run(['rev-parse', '--is-inside-work-tree'], cwd);
  // A missing cwd, a bare repo and "not a repo at all" all land here. They are
  // one answer to the caller: there is no working tree to diff.
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, reason: 'not-a-git-repo' };
  }

  const [staged, unstaged, status] = await Promise.all([
    run(['diff', '--cached'], cwd),
    run(['diff'], cwd),
    run(['status', '--porcelain', '-z', '--untracked-files=all'], cwd),
  ]);

  // A repo with no commits yet makes `diff --cached` fail (no HEAD to compare
  // against) while `status` still answers — so a failed patch command is not
  // fatal on its own. Only losing `status` means we cannot describe the tree.
  if (!status.ok) {
    return { ok: false, reason: 'git-failed', detail: firstLine(status.stderr) };
  }

  const capped = capPatch(
    (staged.ok ? staged.stdout : '') + (unstaged.ok ? unstaged.stdout : ''),
    opts.maxBytes ?? DEFAULT_DIFF_CAP_BYTES,
  );
  return {
    ok: true,
    diff: {
      files: parsePorcelainZ(status.stdout),
      patch: capped.patch,
      truncated: capped.truncated,
      omittedBytes: capped.omittedBytes,
    },
  };
}

/** git's stderr can be several lines; one is enough to say what went wrong. */
function firstLine(s: string): string {
  return s.split('\n')[0]?.trim().slice(0, 200) ?? '';
}
