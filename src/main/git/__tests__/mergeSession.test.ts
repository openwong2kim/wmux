// mergeSession helper tests — round-trip verification against a real temp git repo
// (worktree.handler.test style). Covers the conflict-detection parser
// (diff-filter=U / NUL), precondition checks, base-resolution fallback, the verify
// exit-code verdict, and the clean-merge→Land / conflict→Discard round-trips.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseNulList,
  detectConflicts,
  checkTargetPreconditions,
  resolveBaseFromGit,
  runVerify,
  createIntegrationWorktree,
  removeIntegrationWorktree,
  runMergeNoCommit,
  landMerge,
  abortIntegrationMerge,
  readMergeState,
  isIntegrationPath,
  linkNodeModules,
} from '../mergeSession';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Temp repo with a main branch and a single base commit.
function makeRepo(): { base: string; repo: string; cleanup: () => void } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-ms-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  return { base, repo, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// One commit on a feat branch (then back to main). content controls clean/conflict.
function addFeat(repo: string, content: string): string {
  g(repo, ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(repo, 'f.txt'), content);
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'feat']);
  const oid = g(repo, ['rev-parse', 'feat']).trim();
  g(repo, ['checkout', '-q', 'main']);
  return oid;
}

describe('parseNulList — NUL(-z)-separated parser', () => {
  it('splits NUL-separated items and drops empty items / trailing NULs', () => {
    expect(parseNulList('a.txt\0b/c.txt\0')).toEqual(['a.txt', 'b/c.txt']);
    expect(parseNulList('')).toEqual([]);
    expect(parseNulList('only.txt')).toEqual(['only.txt']);
  });
});

describe('isIntegrationPath — prefix recognition', () => {
  it('recognizes only a .fmux-merge- prefixed leaf as an integration path', () => {
    expect(isIntegrationPath('/x/repo-worktrees/.fmux-merge-feat')).toBe(true);
    expect(isIntegrationPath('/x/repo-worktrees/feat')).toBe(false);
    expect(isIntegrationPath('/x/repo-worktrees/.fmux-merge-feat/')).toBe(true); // trailing slash
  });
});

describe('detectConflicts — conflict detection (not exit code)', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('a conflicting merge returns the unmerged file list, a clean merge returns an empty list', async () => {
    // Set up a main2 vs feat conflict.
    const featOid = addFeat(scn.repo, 'FEAT\n');
    writeFileSync(join(scn.repo, 'f.txt'), 'MAIN\n');
    g(scn.repo, ['add', '-A']);
    g(scn.repo, ['commit', '-q', '-m', 'main2']);
    const baseOid = g(scn.repo, ['rev-parse', 'HEAD']).trim();

    const created = await createIntegrationWorktree(scn.repo, baseOid, 'feat');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const merged = await runMergeNoCommit(created.path, featOid);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.outcome.phase).toBe('conflicted');
    expect(merged.outcome.conflicts).toEqual(['f.txt']);

    // Calling detectConflicts directly gives the same result.
    expect(await detectConflicts(created.path)).toEqual(['f.txt']);

    // Cleanup: abort + remove.
    await abortIntegrationMerge(created.path);
    const rm = await removeIntegrationWorktree(scn.repo, created.path);
    expect(rm.ok).toBe(true);
    expect(existsSync(created.path)).toBe(false);
  });
});

describe('checkTargetPreconditions — target (base) preconditions', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('clean · HEAD==base · no MERGE_HEAD → ok', async () => {
    const r = await checkTargetPreconditions(scn.repo, 'main');
    expect(r.ok).toBe(true);
  });

  it('rejects when there are uncommitted changes', async () => {
    writeFileSync(join(scn.repo, 'f.txt'), 'dirty\n');
    const r = await checkTargetPreconditions(scn.repo, 'main');
    expect(r.ok).toBe(false);
  });

  it('rejects when on a non-base branch (HEAD mismatch)', async () => {
    // main is clean, but requiring base 'master' is a mismatch.
    const r = await checkTargetPreconditions(scn.repo, 'master');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('base(master)');
  });

  it('rejects when an in-progress merge (MERGE_HEAD) is present', async () => {
    const featOid = addFeat(scn.repo, 'FEAT\n');
    writeFileSync(join(scn.repo, 'f.txt'), 'MAIN\n');
    g(scn.repo, ['add', '-A']);
    g(scn.repo, ['commit', '-q', '-m', 'main2']);
    // Trigger a conflicting merge in the main worktree itself to leave a MERGE_HEAD.
    try {
      g(scn.repo, ['merge', '--no-commit', '--no-ff', featOid]);
    } catch {
      /* non-zero exit from the conflict — MERGE_HEAD remains */
    }
    const r = await checkTargetPreconditions(scn.repo, 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('MERGE_HEAD');
  });
});

describe('resolveBaseFromGit — fallback chain (no gh)', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('uses the branch name when origin/HEAD symbolic-ref exists', async () => {
    // Mimic an origin remote with a bare repo and set origin/HEAD.
    const remoteBare = join(scn.base, 'remote.git');
    g(scn.base, ['clone', '-q', '--bare', scn.repo, remoteBare]);
    g(scn.repo, ['remote', 'add', 'origin', remoteBare]);
    g(scn.repo, ['fetch', '-q', 'origin']);
    g(scn.repo, ['remote', 'set-head', 'origin', 'main']);
    expect(await resolveBaseFromGit(scn.repo)).toBe('main');
  });

  it('falls back to main/master when there is no origin', async () => {
    // no remote → symbolic-ref fails → refs/heads/main exists → 'main'.
    expect(await resolveBaseFromGit(scn.repo)).toBe('main');
  });

  it('uses master when only master exists (no main)', async () => {
    g(scn.repo, ['branch', '-m', 'main', 'master']);
    expect(await resolveBaseFromGit(scn.repo)).toBe('master');
  });
});

describe('linkNodeModules — dep link into the integration worktree', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-nm-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('symlinks node_modules from the base dir when the integration worktree lacks it', () => {
    const base = join(dir, 'base');
    const integ = join(dir, 'integ');
    mkdirSync(join(base, 'node_modules'), { recursive: true });
    writeFileSync(join(base, 'node_modules', 'marker.txt'), 'dep\n');
    mkdirSync(integ);

    linkNodeModules(integ, [base]);

    const dest = join(integ, 'node_modules');
    expect(existsSync(dest)).toBe(true);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    // Resolves through to the real dependency file.
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('dep\n');
  });

  it('uses the first candidate base dir that actually has node_modules', () => {
    const empty = join(dir, 'empty');
    const real = join(dir, 'real');
    const integ = join(dir, 'integ');
    mkdirSync(empty);
    mkdirSync(join(real, 'node_modules'), { recursive: true });
    mkdirSync(integ);

    linkNodeModules(integ, [empty, real]);
    expect(lstatSync(join(integ, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('skips when the integration worktree already has node_modules', () => {
    const base = join(dir, 'base');
    const integ = join(dir, 'integ');
    mkdirSync(join(base, 'node_modules'), { recursive: true });
    mkdirSync(join(integ, 'node_modules'), { recursive: true }); // pre-existing real dir

    linkNodeModules(integ, [base]);
    // Left as a real dir (not replaced by a link).
    expect(lstatSync(join(integ, 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('is a no-op (no throw, no link) when no base dir has node_modules', () => {
    const base = join(dir, 'base');
    const integ = join(dir, 'integ');
    mkdirSync(base);
    mkdirSync(integ);

    expect(() => linkNodeModules(integ, [base])).not.toThrow();
    expect(existsSync(join(integ, 'node_modules'))).toBe(false);
  });
});

describe('runVerify — exit-code verdict (injected commands)', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('all steps exit 0 → ok:true', async () => {
    const res = await runVerify(scn.repo, {
      steps: [
        { step: 'test', cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
        { step: 'lint', cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
      ],
    });
    expect(res.ok).toBe(true);
  });

  it('any step exiting non-zero → ok:false + records the failed step', async () => {
    const res = await runVerify(scn.repo, {
      steps: [
        { step: 'test', cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
        { step: 'lint', cmd: process.execPath, args: ['-e', 'process.exit(3)'] },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe('lint');
  });
});

describe('clean merge → Land round-trip', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('fast-forwards base to the result after merging in the isolated worktree', async () => {
    const featOid = addFeat(scn.repo, 'a\nfeat\n'); // A change that does not conflict with main.
    const baseOid = g(scn.repo, ['rev-parse', 'HEAD']).trim();

    const created = await createIntegrationWorktree(scn.repo, baseOid, 'feat');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(isIntegrationPath(created.path)).toBe(true);

    const merged = await runMergeNoCommit(created.path, featOid);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.outcome.phase).toBe('clean');
    expect(merged.outcome.changedFiles).toBe(1);

    // integration must be in the MERGING state (readMergeState).
    expect(await readMergeState(created.path)).toEqual({ merging: true, conflicts: 0 });

    const landed = await landMerge({
      integrationPath: created.path,
      baseCheckoutPath: scn.repo,
      baseOid,
      base: 'main',
      sourceOid: featOid,
    });
    expect(landed.ok).toBe(true);

    // base (main) advanced, and the feat change is reflected in the working tree.
    const newHead = g(scn.repo, ['rev-parse', 'HEAD']).trim();
    expect(newHead).not.toBe(baseOid);
    expect(g(scn.repo, ['show', 'HEAD:f.txt'])).toBe('a\nfeat\n');
    // It's a merge commit (--no-ff), so it has two parents.
    expect(g(scn.repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length).toBe(3);

    await removeIntegrationWorktree(scn.repo, created.path);
    expect(existsSync(created.path)).toBe(false);
  });

  it('rejects Land when base moved since the start', async () => {
    const featOid = addFeat(scn.repo, 'a\nfeat\n');
    const baseOid = g(scn.repo, ['rev-parse', 'HEAD']).trim();
    const created = await createIntegrationWorktree(scn.repo, baseOid, 'feat');
    if (!created.ok) return;
    await runMergeNoCommit(created.path, featOid);

    // base moves (a new commit on main).
    writeFileSync(join(scn.repo, 'g.txt'), 'x\n');
    g(scn.repo, ['add', '-A']);
    g(scn.repo, ['commit', '-q', '-m', 'moved']);

    const landed = await landMerge({
      integrationPath: created.path,
      baseCheckoutPath: scn.repo,
      baseOid, // stale OID
      base: 'main',
      sourceOid: featOid,
    });
    expect(landed.ok).toBe(false);
    if (!landed.ok) expect(landed.error).toContain('moved');

    await abortIntegrationMerge(created.path);
    await removeIntegrationWorktree(scn.repo, created.path);
  });
});
