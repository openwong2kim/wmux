import { describe, it, expect } from 'vitest';
import {
  capPatch,
  collectSessionDiff,
  parsePorcelainZ,
  DEFAULT_DIFF_CAP_BYTES,
  type GitRunner,
} from '../sessionDiff';

const NUL = '\0';
const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' });
const fail = (stderr: string) => ({ ok: false, stdout: '', stderr });

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
    return script[args[0]] ?? ok('');
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
    const git = fakeGit({ 'rev-parse': ok('true\n') });
    await collectSessionDiff('/repo', git.run);
    expect(git.calls.map((c) => c.args)).toEqual([
      ['rev-parse', '--is-inside-work-tree'],
      ['diff', '--cached'],
      ['diff'],
      ['status', '--porcelain', '-z', '--untracked-files=all'],
    ]);
    expect(new Set(git.calls.map((c) => c.cwd))).toEqual(new Set(['/repo']));
    // Nothing that writes, fetches or takes a caller-chosen ref.
    const flat = git.calls.flatMap((c) => c.args);
    for (const verb of ['fetch', 'checkout', 'apply', 'commit', 'clean', 'reset']) {
      expect(flat).not.toContain(verb);
    }
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
    const git = fakeGit({ 'rev-parse': ok('false\n') });
    await expect(collectSessionDiff('/bare.git', git.run)).resolves.toMatchObject({
      ok: false,
      reason: 'not-a-git-repo',
    });
  });

  it('concatenates the staged patch before the working-tree patch', async () => {
    const run: GitRunner = async (args) => {
      if (args[0] === 'rev-parse') return ok('true\n');
      if (args[0] === 'status') return ok(`M  staged.ts${NUL} M dirty.ts${NUL}`);
      return args[1] === '--cached' ? ok('STAGED\n') : ok('WORKTREE\n');
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
      if (args[0] === 'rev-parse') return ok('true\n');
      if (args[0] === 'status') return ok(`?? first.ts${NUL}`);
      if (args[1] === '--cached') return fail("fatal: ambiguous argument 'HEAD'");
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
      if (args[0] === 'rev-parse') return ok('true\n');
      if (args[0] === 'status') return fail('fatal: index file corrupt\nsecond line');
      return ok('');
    };
    await expect(collectSessionDiff('/repo', run)).resolves.toEqual({
      ok: false,
      reason: 'git-failed',
      detail: 'fatal: index file corrupt',
    });
  });

  it('caps a huge patch and reports the omission', async () => {
    const run: GitRunner = async (args) => {
      if (args[0] === 'rev-parse') return ok('true\n');
      if (args[0] === 'status') return ok('');
      return args[1] === '--cached' ? ok('') : ok('z'.repeat(50));
    };
    const res = await collectSessionDiff('/repo', run, { maxBytes: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.patch).toHaveLength(20);
    expect(res.diff).toMatchObject({ truncated: true, omittedBytes: 30 });
  });
});
