// worktree:list / add / remove handler tests — round-trip with real temp git repo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

import { registerWorktreeHandlers } from '../worktree.handler';
import { IPC } from '../../../../shared/constants';
import type { WorktreeEntry } from '../../../../shared/worktreeParse';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): { base: string; repo: string; cleanup: () => void } {
  // Normalize 8.3 short form (CI Windows RUNNER~1) to long form via realpathSync.native —
  // handler derives/compares on git canonical paths, so fixture must match.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-wth-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  return { base, repo, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

type ListRes = { ok: boolean; repoPath?: string; worktrees?: WorktreeEntry[]; error?: string };
type MutRes = { ok: boolean; worktreePath?: string; error?: string };

describe('worktree.handler — list/add/remove round-trip', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    captured.clear();
    registerWorktreeHandlers();
    scn = makeRepo();
  });
  afterEach(() => scn.cleanup());

  it('add (new branch) → appears in list → remove → disappears from list', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;

    const a = (await add({}, scn.repo, 'feat/x')) as MutRes;
    expect(a.ok).toBe(true);
    // Conventional location: <repo-parent>/<repo-name>-worktrees/<branch-dir>.
    expect(dirname(a.worktreePath!)).toBe(join(dirname(scn.repo), `${basename(scn.repo)}-worktrees`));
    expect(existsSync(a.worktreePath!)).toBe(true);

    const l = (await list({}, scn.repo)) as ListRes;
    expect(l.ok).toBe(true);
    expect(l.worktrees!.map((w) => w.branch)).toContain('feat/x');

    const r = (await remove({}, scn.repo, a.worktreePath!)) as MutRes;
    expect(r.ok).toBe(true);
    const l2 = (await list({}, scn.repo)) as ListRes;
    expect(l2.worktrees!.map((w) => w.branch)).not.toContain('feat/x');
  });

  it('add — existing branch checked out without -b', async () => {
    g(scn.repo, ['branch', 'existing']);
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const a = (await add({}, scn.repo, 'existing')) as MutRes;
    expect(a.ok).toBe(true);
    const head = g(a.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    expect(head).toBe('existing');
  });

  it('add — dangerous branch names (-flag·traversal) fail-soft rejected', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    for (const bad of ['--force', 'a..b', 'a b']) {
      const r = (await add({}, scn.repo, bad)) as MutRes;
      expect(r.ok).toBe(false);
    }
  });

  it('remove — dirty worktree surfaces git rejection as-is (no --force)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const a = (await add({}, scn.repo, 'feat/dirty')) as MutRes;
    writeFileSync(join(a.worktreePath!, 'junk.txt'), 'x\n');
    const r = (await remove({}, scn.repo, a.worktreePath!)) as MutRes;
    expect(r.ok).toBe(false);
    expect(existsSync(a.worktreePath!)).toBe(true); // worktree preserved.
  });

  it('remove — rejects unlisted arbitrary path and main worktree', async () => {
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const arb = (await remove({}, scn.repo, join(scn.base, 'not-a-worktree'))) as MutRes;
    expect(arb.ok).toBe(false);
    expect(arb.error).toContain('not a listed worktree');
    const main = (await remove({}, scn.repo, scn.repo)) as MutRes;
    expect(main.ok).toBe(false);
    expect(main.error).toContain('main worktree');
  });

  it('list — mainPath is main repo even from linked worktree context (dogfood regression)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const a = (await add({}, scn.repo, 'feat/ctx')) as MutRes;
    expect(a.ok).toBe(true);
    // List opened "inside" linked worktree: repoPath=self, mainPath=main repo.
    const r = (await list({}, a.worktreePath!)) as ListRes & { mainPath?: string };
    expect(r.ok).toBe(true);
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    expect(norm(r.repoPath!)).toBe(norm(a.worktreePath!));
    expect(norm(r.mainPath!)).toBe(norm(scn.repo));
    // main worktree remove rejected in any context.
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const m = (await remove({}, a.worktreePath!, scn.repo)) as MutRes;
    expect(m.ok).toBe(false);
    expect(m.error).toContain('main worktree');
  });

  it('remove — rejects active (call-context) worktree even when clean (Codex P2)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const a = (await add({}, scn.repo, 'feat/active')) as MutRes;
    // Reject removing self from inside that worktree (repoPath=self).
    const r = (await remove({}, a.worktreePath!, a.worktreePath!)) as MutRes;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('currently in');
    expect(existsSync(a.worktreePath!)).toBe(true);
  });

  it('add — paths derived from main repo even from linked worktree context (Codex P2)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const a = (await add({}, scn.repo, 'feat/first')) as MutRes;
    // Create second from inside first worktree — path must be sibling <repo>-worktrees,
    // not <linked>-worktrees.
    const b = (await add({}, a.worktreePath!, 'feat/second')) as MutRes;
    expect(b.ok).toBe(true);
    expect(dirname(b.worktreePath!)).toBe(join(dirname(scn.repo), `${basename(scn.repo)}-worktrees`));
  });

  it('add — remote-only branch checked out as origin-tracking local branch (Codex P2)', async () => {
    // bare repo mimicking origin remote + feat/remote branch.
    const remoteBare = join(scn.base, 'remote.git');
    g(scn.base, ['clone', '-q', '--bare', scn.repo, remoteBare]);
    g(scn.repo, ['remote', 'add', 'origin', remoteBare]);
    g(scn.repo, ['branch', 'feat/remote']);
    g(scn.repo, ['push', '-q', 'origin', 'feat/remote']);
    g(scn.repo, ['branch', '-D', 'feat/remote']); // remove locally → remote-only.
    g(scn.repo, ['fetch', '-q', 'origin']);
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const a = (await add({}, scn.repo, 'feat/remote')) as MutRes;
    expect(a.ok).toBe(true);
    // new local branch must track origin/feat/remote as upstream.
    const upstream = g(a.worktreePath!, ['rev-parse', '--abbrev-ref', 'feat/remote@{upstream}']).trim();
    expect(upstream).toBe('origin/feat/remote');
  });

  it('list — non-git path fail-soft', async () => {
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const plain = join(scn.base, 'plain');
    mkdirSync(plain);
    const r = (await list({}, plain)) as ListRes;
    expect(r.ok).toBe(false);
  });

  it('list — subdirectory path normalized to toplevel succeeds', async () => {
    mkdirSync(join(scn.repo, 'sub'));
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const r = (await list({}, join(scn.repo, 'sub'))) as ListRes;
    expect(r.ok).toBe(true);
    expect(r.worktrees!.length).toBeGreaterThanOrEqual(1);
  });
});
