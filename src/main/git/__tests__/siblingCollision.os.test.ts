// Sibling collision watch against a real temp repo: two worktrees editing the
// same lines are marked as a conflict, two editing different files are not,
// and nothing in the repo (refs, index, objects) changes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disableGitMaintenance } from '../../../test-utils/gitFixture';
import { SiblingCollisionWatcher } from '../siblingCollision';
import type { SiblingCollisionSnapshot } from '../../../shared/siblingCollision';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Every file under the repo's object store and refs, with its size: a fingerprint of what git holds. */
function storeFingerprint(gitDir: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${p}:${st.size}`);
    }
  };
  for (const sub of ['objects', 'refs']) walk(join(gitDir, sub));
  return out.sort().join('\n');
}

let base = '';
let repo = '';
let wtA = '';
let wtB = '';
let wtC = '';

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-sib-')));
  repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  disableGitMaintenance(repo);
  appendFileSync(join(repo, '.git', 'config'), '[user]\n\temail = t@t\n\tname = t\n');
  writeFileSync(join(repo, 'shared.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(repo, 'a-only.txt'), 'a\n');
  writeFileSync(join(repo, 'c-only.txt'), 'c\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  wtA = join(base, 'wt-a');
  wtB = join(base, 'wt-b');
  wtC = join(base, 'wt-c');
  for (const [wt, br] of [[wtA, 'a'], [wtB, 'b'], [wtC, 'c']]) g(repo, ['worktree', 'add', '-q', '-b', br, wt]);
  // a and b both rewrite the same line of shared.txt; c changes only its own file.
  writeFileSync(join(wtA, 'shared.txt'), 'ONE-A\ntwo\nthree\n');
  writeFileSync(join(wtA, 'a-only.txt'), 'a2\n');
  g(wtA, ['commit', '-q', '-am', 'a']);
  writeFileSync(join(wtB, 'shared.txt'), 'ONE-B\ntwo\nthree\n');
  g(wtB, ['commit', '-q', '-am', 'b']);
  writeFileSync(join(wtC, 'c-only.txt'), 'c2\n');
  g(wtC, ['commit', '-q', '-am', 'c']);
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

/** One round with the real git and timers that fire at once. */
async function oneRound(cwds: string[]): Promise<SiblingCollisionSnapshot | undefined> {
  const emitted: SiblingCollisionSnapshot[] = [];
  let pending: (() => void) | null = null;
  const watcher = new SiblingCollisionWatcher({
    emit: (s) => emitted.push(s),
    setTimer: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  watcher.configure({ enabled: true, intervalMs: 120_000, cwds });
  const fire = pending as (() => void) | null;
  pending = null;
  fire?.();
  await watcher.idle();
  watcher.dispose();
  return emitted.at(-1);
}

describe('SiblingCollisionWatcher (real git)', () => {
  it('two branches editing the same lines: a conflict on both panes; different files: no marker', async () => {
    const before = storeFingerprint(join(repo, '.git'));
    const indexBefore = statSync(join(repo, '.git', 'worktrees', 'wt-a', 'index')).mtimeMs;
    const snap = await oneRound([wtA, wtB, wtC]);
    expect(snap).toBeDefined();
    expect(snap!.byCwd[wtA].peers).toEqual([{ worktreePath: wtB, conflicts: ['shared.txt'], overlaps: [] }]);
    expect(snap!.byCwd[wtB].peers).toEqual([{ worktreePath: wtA, conflicts: ['shared.txt'], overlaps: [] }]);
    // c touched only its own file: no marker, and a/b list no c.
    expect(snap!.byCwd[wtC]).toBeUndefined();
    // Read-only: no object, ref or index written.
    expect(storeFingerprint(join(repo, '.git'))).toBe(before);
    expect(statSync(join(repo, '.git', 'worktrees', 'wt-a', 'index')).mtimeMs).toBe(indexBefore);
  });

  it('an uncommitted edit of a file the sibling changed is an overlap', async () => {
    writeFileSync(join(wtC, 'a-only.txt'), 'c touches it too\n');
    try {
      const snap = await oneRound([wtA, wtC]);
      expect(snap!.byCwd[wtC].peers).toEqual([{ worktreePath: wtA, conflicts: [], overlaps: ['a-only.txt'] }]);
    } finally {
      g(wtC, ['checkout', '--', 'a-only.txt']);
    }
  });
}, 30_000);
