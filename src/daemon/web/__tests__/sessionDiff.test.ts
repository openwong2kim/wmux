import { describe, it, expect } from 'vitest';
import {
  buildGitEnv,
  capPatch,
  collectSessionDiff,
  gitArgv,
  parsePorcelainZ,
  DEFAULT_DIFF_CAP_BYTES,
  GIT_HARDENING_CONFIG,
  UNTRACKED_DIFF_LIMIT,
  type GitRunner,
} from '../sessionDiff';

const NUL = '\0';
const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' });
/** git ran and exited nonzero. */
const fail = (stderr: string) => ({ ok: false, stdout: '', stderr });
/** git never got to answer: no binary, killed by the timeout, output over maxBuffer. */
const neverRan = (stderr: string) => ({ ok: false, ran: false, stdout: '', stderr });
/** The repo-check answer: yes, and here is the root. */
const INSIDE = ok('true\n/repo\n');

/** Strip the fixed hardening prefix so a test can talk about the command itself. */
const body = (args: readonly string[]): string[] => args.slice(GIT_HARDENING_CONFIG.length);

/**
 * A scripted git. Keyed on the first argument, which is enough to tell the four
 * commands apart, and it RECORDS every argv — the security claim in the module
 * header ("no ref arguments from the client") is only worth anything if a test
 * asserts the argv is a constant.
 */
function fakeGit(script: Partial<Record<string, ReturnType<typeof ok>>>) {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const run: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    return script[body(args)[0] as string] ?? ok('');
  };
  return { run, calls };
}

describe('parsePorcelainZ', () => {
  it('reads the two-character status and the literal path', () => {
    const out = ` M src/a.ts${NUL}M  src/b.ts${NUL}?? notes.md${NUL}`;
    expect(parsePorcelainZ(out)).toEqual([
      { path: 'src/a.ts', status: ' M' },
      { path: 'src/b.ts', status: 'M ' },
      { path: 'notes.md', status: '??' },
    ]);
  });

  it('★ keeps spaces and non-ASCII in a path verbatim (why -z, not the line format)', () => {
    // In the default line format git would hand these back quoted and
    // C-escaped ("\303\251..."), i.e. a path that does not exist on disk.
    const out = ` M my docs/한글 파일.md${NUL}?? "already quoted".txt${NUL}`;
    expect(parsePorcelainZ(out).map((f) => f.path)).toEqual([
      'my docs/한글 파일.md',
      '"already quoted".txt',
    ]);
  });

  it('consumes the second field of a rename as the origin, not as a record', () => {
    const out = `R  new.ts${NUL}old.ts${NUL} M other.ts${NUL}`;
    expect(parsePorcelainZ(out)).toEqual([
      { path: 'new.ts', status: 'R ', from: 'old.ts' },
      { path: 'other.ts', status: ' M' },
    ]);
  });

  it('handles a copy entry and an unmerged entry', () => {
    const out = `C  copy.ts${NUL}src.ts${NUL}UU conflict.ts${NUL}`;
    expect(parsePorcelainZ(out)).toEqual([
      { path: 'copy.ts', status: 'C ', from: 'src.ts' },
      { path: 'conflict.ts', status: 'UU' },
    ]);
  });

  it('is empty for a clean tree and tolerates a truncated record', () => {
    expect(parsePorcelainZ('')).toEqual([]);
    expect(parsePorcelainZ(NUL)).toEqual([]);
    expect(parsePorcelainZ(` M${NUL}`)).toEqual([]);
  });
});

describe('capPatch', () => {
  it('passes a small patch through untouched', () => {
    expect(capPatch('diff --git a/x b/x\n')).toEqual({
      patch: 'diff --git a/x b/x\n',
      truncated: false,
      omittedBytes: 0,
    });
  });

  it('keeps the FRONT and reports what it dropped', () => {
    const patch = 'a'.repeat(100);
    const capped = capPatch(patch, 10);
    expect(capped.patch).toBe('a'.repeat(10));
    expect(capped).toMatchObject({ truncated: true, omittedBytes: 90 });
  });

  it('★ measures in bytes, not characters, and never cuts mid-character', () => {
    // 'é' is 2 bytes. A 10-byte cap lands exactly inside the 6th one.
    const patch = 'é'.repeat(10); // 20 bytes
    const capped = capPatch(patch, 11);
    expect(Buffer.from(capped.patch, 'utf8').length).toBe(10);
    expect(capped.patch).toBe('é'.repeat(5));
    expect(capped.patch).not.toContain('�');
    expect(capped.omittedBytes).toBe(10);
  });

  it('falls back to the default cap for a nonsense limit', () => {
    const patch = 'x'.repeat(DEFAULT_DIFF_CAP_BYTES + 5);
    expect(capPatch(patch, 0).omittedBytes).toBe(5);
    expect(capPatch(patch, -1).omittedBytes).toBe(5);
  });
});

describe('collectSessionDiff', () => {
  it('★ runs only fixed-argv read-only commands, all in the given cwd', async () => {
    const git = fakeGit({ 'rev-parse': INSIDE });
    await collectSessionDiff('/repo', git.run);
    expect(git.calls.map((c) => body(c.args))).toEqual([
      ['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
      ['diff', '--cached', '--no-ext-diff', '--no-textconv'],
      ['diff', '--no-ext-diff', '--no-textconv'],
      ['status', '--porcelain', '-z', '--untracked-files=all'],
    ]);
    expect(new Set(git.calls.map((c) => c.cwd))).toEqual(new Set(['/repo']));
    // Nothing that writes, fetches or takes a caller-chosen ref.
    const flat = git.calls.flatMap((c) => c.args);
    for (const verb of ['fetch', 'checkout', 'apply', 'commit', 'clean', 'reset']) {
      expect(flat).not.toContain(verb);
    }
  });

  it('★ neuters every repo-controlled route to code execution, on every command', async () => {
    // A repository an agent cloned is attacker-controlled input, and several
    // git config keys and .gitattributes drivers are literally "a command git
    // will run". `diff.external` and `core.fsmonitor` are the config half;
    // `--no-ext-diff --no-textconv` are the attributes half.
    const git = fakeGit({ 'rev-parse': INSIDE, status: ok(`?? new.ts${NUL}`) });
    await collectSessionDiff('/repo', git.run);
    expect(git.calls.length).toBeGreaterThan(0);
    for (const c of git.calls) {
      expect(c.args.slice(0, GIT_HARDENING_CONFIG.length)).toEqual([...GIT_HARDENING_CONFIG]);
      expect(c.args).toContain('core.fsmonitor=false');
      expect(c.args).toContain('diff.external=');
      // From a subdirectory a repo-set diff.relative would hide changes the
      // porcelain status still lists.
      expect(c.args).toContain('diff.relative=false');
    }
    for (const c of git.calls.filter((x) => body(x.args)[0] === 'diff')) {
      expect(c.args).toContain('--no-ext-diff');
      expect(c.args).toContain('--no-textconv');
    }
  });

  it('★ hands git an allowlisted environment, so no GIT_* can be inherited', async () => {
    const env = buildGitEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      // Every one of these turns a "read-only" diff into something else.
      GIT_EXTERNAL_DIFF: '/tmp/pwn.sh',
      GIT_DIR: '/somewhere/else/.git',
      GIT_WORK_TREE: '/somewhere/else',
      GIT_INDEX_FILE: '/tmp/index',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/tmp/pwn.sh'",
      GIT_CONFIG_COUNT: '1',
      GIT_SSH_COMMAND: '/tmp/pwn.sh',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp',
      LD_PRELOAD: '/tmp/pwn.so',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/me');
    // An allowlist, so a GIT_* invented in a future git release is excluded by
    // default rather than by whoever remembers to extend a denylist.
    const inherited = Object.keys(env).filter((k) => k.startsWith('GIT_'));
    expect(inherited.sort()).toEqual([
      'GIT_ATTR_NOSYSTEM',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_OPTIONAL_LOCKS',
      'GIT_PAGER',
      'GIT_TERMINAL_PROMPT',
    ]);
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_ATTR_NOSYSTEM).toBe('1');
    // #7: never take .git/index.lock — a read must not block the agent's commit.
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('gitArgv puts the hardening first, so a command can never precede it', () => {
    expect(gitArgv('status')).toEqual([...GIT_HARDENING_CONFIG, 'status']);
  });

  it('answers not-a-git-repo when the cwd is not inside a work tree', async () => {
    const git = fakeGit({ 'rev-parse': fail('fatal: not a git repository') });
    await expect(collectSessionDiff('/tmp', git.run)).resolves.toEqual({
      ok: false,
      reason: 'not-a-git-repo',
    });
    // It stopped there — no diff was attempted.
    expect(git.calls).toHaveLength(1);
  });

  it('treats a bare repo (is-inside-work-tree false) as not-a-git-repo', async () => {
    const git = fakeGit({ 'rev-parse': ok('false\n/bare.git\n') });
    await expect(collectSessionDiff('/bare.git', git.run)).resolves.toMatchObject({
      ok: false,
      reason: 'not-a-git-repo',
    });
  });

  it('concatenates the staged patch before the working-tree patch', async () => {
    const run: GitRunner = async (args) => {
      if (body(args)[0] === 'rev-parse') return INSIDE;
      if (body(args)[0] === 'status') return ok(`M  staged.ts${NUL} M dirty.ts${NUL}`);
      return body(args)[1] === '--cached' ? ok('STAGED\n') : ok('WORKTREE\n');
    };
    const res = await collectSessionDiff('/repo', run);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.patch).toBe('STAGED\nWORKTREE\n');
    expect(res.diff.files).toEqual([
      { path: 'staged.ts', status: 'M ' },
      { path: 'dirty.ts', status: ' M' },
    ]);
    expect(res.diff).toMatchObject({ truncated: false, omittedBytes: 0 });
  });

  it('★ still answers in a repo with no commits, where `diff --cached` fails', async () => {
    const run: GitRunner = async (args) => {
      if (body(args)[0] === 'rev-parse') return INSIDE;
      if (body(args)[0] === 'status') return ok(`?? first.ts${NUL}`);
      if (body(args)[1] === '--cached') return fail("fatal: ambiguous argument 'HEAD'");
      return ok('');
    };
    const res = await collectSessionDiff('/fresh', run);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.files).toEqual([{ path: 'first.ts', status: '??' }]);
    expect(res.diff.patch).toBe('');
  });

  it('reports git-failed only when status itself fails', async () => {
    const run: GitRunner = async (args) => {
      if (body(args)[0] === 'rev-parse') return INSIDE;
      if (body(args)[0] === 'status') return fail('fatal: index file corrupt\nsecond line');
      return ok('');
    };
    await expect(collectSessionDiff('/repo', run)).resolves.toEqual({
      ok: false,
      reason: 'git-failed',
      detail: 'fatal: index file corrupt',
    });
  });

  it('★ 500-shaped git-failed, not not-a-git-repo, when git never ran', async () => {
    // ENOENT on the binary, or our own timeout killing it. Reporting that as
    // "this is not a git repository" tells the human to go and look at a
    // directory that is perfectly fine, and hides a broken daemon.
    const git = fakeGit({ 'rev-parse': neverRan('spawn git ENOENT') });
    await expect(collectSessionDiff('/repo', git.run)).resolves.toMatchObject({
      ok: false,
      reason: 'git-failed',
    });
    expect(git.calls).toHaveLength(1);
  });

  it('★ says patchIncomplete when a diff command fails — an empty patch reads as "clean"', async () => {
    // THE failure this flag exists for: a timeout, a blown maxBuffer or a
    // driver error used to degrade to patch:'' with truncated:false, which on a
    // phone is indistinguishable from a clean tree. A human then approves an
    // edit against a screen that says there are no changes.
    const run: GitRunner = async (args) => {
      if (body(args)[0] === 'rev-parse') return INSIDE;
      if (body(args)[0] === 'status') return ok(` M big.bin${NUL}`);
      return neverRan('stdout maxBuffer length exceeded');
    };
    const res = await collectSessionDiff('/repo', run);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff).toMatchObject({ patch: '', truncated: false, patchIncomplete: true });
    // files[] is still trustworthy — status succeeded.
    expect(res.diff.files).toEqual([{ path: 'big.bin', status: ' M' }]);
  });

  it('a complete answer says patchIncomplete: false', async () => {
    const run: GitRunner = async (args) => {
      if (body(args)[0] === 'rev-parse') return INSIDE;
      if (body(args)[0] === 'status') return ok(` M a.ts${NUL}`);
      return ok('HUNK\n');
    };
    const res = await collectSessionDiff('/repo', run);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.patchIncomplete).toBe(false);
  });

  it('★ renders untracked files into the patch, which git diff alone never does', async () => {
    // Without this an agent's brand-new file is listed as '??' and appears
    // nowhere in the patch — the single change a reviewer most needs to read.
    const run: GitRunner = async (args, cwd) => {
      const b = body(args);
      if (b[0] === 'rev-parse') return ok('true\n/repo\n');
      if (b[0] === 'status') return ok(`?? src/new.ts${NUL} M old.ts${NUL}`);
      if (b[1] === '--no-index') {
        // Fixed argv, the path after a literal `--`, run at the repo ROOT
        // because porcelain paths are root-relative and the cwd may be a
        // subdirectory of it.
        expect(b).toEqual([
          'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', 'src/new.ts',
        ]);
        expect(cwd).toBe('/repo');
        // --no-index exits 1 whenever there IS a difference, i.e. always here.
        return { ok: false, stdout: 'NEWFILE\n', stderr: '' };
      }
      return ok('');
    };
    const res = await collectSessionDiff('/repo/sub', run);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.patch).toBe('NEWFILE\n');
    expect(res.diff.patchIncomplete).toBe(false);
  });

  it('★ bounds untracked rendering and admits it when it stops', async () => {
    const many = Array.from({ length: UNTRACKED_DIFF_LIMIT + 5 }, (_, i) => `?? f${i}.txt`);
    const run: GitRunner = async (args) => {
      const b = body(args);
      if (b[0] === 'rev-parse') return INSIDE;
      if (b[0] === 'status') return ok(many.join(NUL) + NUL);
      if (b[1] === '--no-index') return { ok: false, stdout: 'H', stderr: '' };
      return ok('');
    };
    const res = await collectSessionDiff('/repo', run);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.patch).toBe('H'.repeat(UNTRACKED_DIFF_LIMIT));
    // Every file is still LISTED; only the rendering stopped, and it says so.
    expect(res.diff.files).toHaveLength(UNTRACKED_DIFF_LIMIT + 5);
    expect(res.diff.patchIncomplete).toBe(true);
  });

  it('does not try to render an untracked DIRECTORY, and tolerates one that fails', async () => {
    const run: GitRunner = async (args) => {
      const b = body(args);
      if (b[0] === 'rev-parse') return INSIDE;
      // A trailing slash means git named a whole directory (unreadable, or a
      // nested repo) — there is no single file to diff.
      if (b[0] === 'status') return ok(`?? vendor/${NUL}?? gone.ts${NUL}`);
      if (b[1] === '--no-index') return neverRan('timed out');
      return ok('');
    };
    const res = await collectSessionDiff('/repo', run);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.patchIncomplete).toBe(true);
  });

  it('★ untracked hunks are capped with everything else, not appended past the cap', async () => {
    const run: GitRunner = async (args) => {
      const b = body(args);
      if (b[0] === 'rev-parse') return INSIDE;
      if (b[0] === 'status') return ok(`?? new.ts${NUL}`);
      if (b[1] === '--no-index') return { ok: false, stdout: 'u'.repeat(50), stderr: '' };
      return ok('');
    };
    const res = await collectSessionDiff('/repo', run, { maxBytes: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.patch).toBe('u'.repeat(20));
    expect(res.diff).toMatchObject({ truncated: true, omittedBytes: 30 });
  });

  it('caps a huge patch and reports the omission', async () => {
    const run: GitRunner = async (args) => {
      if (body(args)[0] === 'rev-parse') return INSIDE;
      if (body(args)[0] === 'status') return ok('');
      return body(args)[1] === '--cached' ? ok('') : ok('z'.repeat(50));
    };
    const res = await collectSessionDiff('/repo', run, { maxBytes: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.patch).toHaveLength(20);
    expect(res.diff).toMatchObject({ truncated: true, omittedBytes: 30 });
  });
});
