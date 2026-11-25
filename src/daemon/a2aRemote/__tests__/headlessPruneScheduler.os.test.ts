// The box daemon's own prune pass: on real git repositories, only clean work that is merged into origin's
// default branch (or is a merged pull request's head) goes; unpushed, unmerged and uncommitted work stays.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Git } from '../../../main/a2aRemote/spawnWorktree';
import { HeadlessStartStore, type HeadlessStartRecordV1 } from '../headlessStartStore';
import { pruneHeadless } from '../../../cli/commands/headlessPrune';
import { AUTO_PRUNE_AFTER_END_MS, HeadlessPruneScheduler, folderSize, keptSummary, mergedChecks, type GhRunner } from '../headlessPruneScheduler';

const run = promisify(execFile);
const HOST = '11111111-1111-4111-8111-111111111111';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (at: string): Git => async (args) => {
  try {
    const { stdout, stderr } = await run('git', ['-C', at, ...args], { env: ENV });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};
const sh = (at: string, ...args: string[]): string => execFileSync('git', ['-C', at, ...args], { env: ENV, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let remote: string;
let wmuxDir: string;
let store: HeadlessStartStore;
let n = 0;

function endedStart(over: Partial<HeadlessStartRecordV1> = {}): HeadlessStartRecordV1 {
  n += 1;
  const hex = n.toString(16).padStart(12, '0');
  const spawnId = `sp-0123abcd-4567-89ab-cdef-${hex}`;
  const branch = `wmux/remote/${spawnId}`;
  const wt = path.join(root, `remote-${spawnId}`);
  sh(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  fs.writeFileSync(path.join(wt, `work-${n}.txt`), 'done\n');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-qm', `work ${n}`);
  const rec: HeadlessStartRecordV1 = {
    v: 1, hostId: HOST as HeadlessStartRecordV1['hostId'], spawnId, agent: 'claude', repoPath: repo, treeId: spawnId,
    sessionId: `hl-00000000-0000-4000-8000-${hex}`, workspaceId: `hl-${hex}`, agentSessionId: '33333333-3333-4333-8333-333333333333',
    lineage: `remote-spawn:${HOST}`, runId: 'run-1', phase: 'ended', worktreePath: wt, cwd: wt,
    baseCommit: sh(repo, 'rev-parse', 'main'), branch, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), ...over,
  };
  store.add(rec);
  return rec;
}

/** Merge `branch` into origin's main from another clone (as a PR merge on the server would), leaving this clone's refs stale. */
function mergeUpstream(branch: string, how: 'merge' | 'squash'): void {
  const other = path.join(root, `other-${n}-${how}`);
  sh(root, 'clone', '-q', remote, other);
  sh(other, 'fetch', '-q', 'origin', `${branch}:${branch}`);
  if (how === 'merge') sh(other, 'merge', '-q', '--no-ff', '-m', 'merge', branch);
  else {
    sh(other, 'merge', '-q', '--squash', branch);
    sh(other, 'commit', '-qm', 'squashed');
  }
  sh(other, 'push', '-q', 'origin', 'main');
}

const auto = (gh: GhRunner = async () => '[]') =>
  pruneHeadless(wmuxDir, { dryRun: false, daemonRunning: async () => true, policy: 'merged' }, { git, store, merged: mergedChecks({ git, gh }) });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hl-autoprune-')));
  repo = path.join(root, 'repo');
  remote = path.join(root, 'remote.git');
  sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README'), 'x\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  sh(repo, 'remote', 'add', 'origin', remote);
  sh(repo, 'push', '-q', 'origin', 'main');
  wmuxDir = path.join(root, 'wmux');
  fs.mkdirSync(path.join(wmuxDir, 'a2a'), { recursive: true });
  store = new HeadlessStartStore({ dir: path.join(wmuxDir, 'a2a'), scheduleHarden: () => undefined });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("the daemon's 'merged' prune policy", () => {
  it('removes work merged into origin/main (seen after its own fetch); keeps pushed-only, fetched-back, unpushed and dirty work', async () => {
    const merged = endedStart();
    sh(repo, 'push', '-q', 'origin', merged.branch!);
    mergeUpstream(merged.branch!, 'merge');
    const pushedOnly = endedStart();
    sh(repo, 'push', '-q', 'origin', pushedOnly.branch!);
    const fetchedBack = endedStart();
    store.update(HOST, fetchedBack.spawnId, { fetchedHead: sh(fetchedBack.worktreePath!, 'rev-parse', 'HEAD') });
    const unpushed = endedStart();
    const dirty = endedStart();
    sh(repo, 'push', '-q', 'origin', dirty.branch!);
    mergeUpstream(dirty.branch!, 'merge');
    fs.writeFileSync(path.join(dirty.worktreePath!, 'scratch.txt'), 'not committed\n');

    const res = await auto();
    expect(res.removed.map((e) => [e.spawnId, e.reason])).toEqual([[merged.spawnId, 'clean, merged into origin/main']]);
    const kept = Object.fromEntries(res.kept.map((e) => [e.spawnId, e.kind]));
    expect(kept).toEqual({ [pushedOnly.spawnId]: 'unmerged', [fetchedBack.spawnId]: 'unmerged', [unpushed.spawnId]: 'unmerged', [dirty.spawnId]: 'dirty' });
    expect(fs.existsSync(merged.worktreePath!)).toBe(false);
    for (const r of [pushedOnly, fetchedBack, unpushed, dirty]) expect(fs.existsSync(r.worktreePath!)).toBe(true);
    expect(fs.readFileSync(path.join(dirty.worktreePath!, 'scratch.txt'), 'utf8')).toBe('not committed\n');
    // The daemon's reconcile drops the record of the one that went.
    expect(res.recordsDropped).toBe(0);
  });

  it("removes squash-merged work only when the merged pull request's head is the branch's commit", async () => {
    const squashed = endedStart();
    sh(repo, 'push', '-q', 'origin', squashed.branch!);
    mergeUpstream(squashed.branch!, 'squash');
    const mergedHead = sh(squashed.worktreePath!, 'rev-parse', 'HEAD');
    // Merged too, but a commit was made after the pull request's head.
    const movedOn = endedStart();
    sh(repo, 'push', '-q', 'origin', movedOn.branch!);
    mergeUpstream(movedOn.branch!, 'squash');
    const movedOnMergedHead = sh(movedOn.worktreePath!, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(movedOn.worktreePath!, 'later.txt'), 'later\n');
    sh(movedOn.worktreePath!, 'add', '.');
    sh(movedOn.worktreePath!, 'commit', '-qm', 'after the merge');
    const gh = vi.fn<GhRunner>(async (args) => {
      const branch = args[args.indexOf('--head') + 1];
      const head = branch === squashed.branch ? mergedHead : branch === movedOn.branch ? movedOnMergedHead : null;
      return JSON.stringify(head ? [{ headRefOid: head }] : []);
    });

    const res = await auto(gh);
    expect(res.removed.map((e) => [e.spawnId, e.reason])).toEqual([[squashed.spawnId, 'clean, its pull request was merged']]);
    expect(res.kept.map((e) => [e.spawnId, e.kind])).toEqual([[movedOn.spawnId, 'unmerged']]);
    expect(fs.existsSync(movedOn.worktreePath!)).toBe(true);
  });

  it('keeps squash-merged work when gh cannot answer, and keeps everything when no default branch is known', async () => {
    const squashed = endedStart();
    sh(repo, 'push', '-q', 'origin', squashed.branch!);
    mergeUpstream(squashed.branch!, 'squash');
    const unasked = await auto(async () => null);
    expect(unasked.removed).toEqual([]);
    expect(unasked.kept.map((e) => [e.kind, e.reason])).toEqual([['other', expect.stringMatching(/could not be asked \(gh\)/)]]);

    const merged = endedStart();
    sh(repo, 'push', '-q', 'origin', merged.branch!);
    mergeUpstream(merged.branch!, 'merge');
    sh(repo, 'remote', 'remove', 'origin');
    const res = await auto();
    expect(res.removed).toEqual([]);
    expect(res.kept.find((e) => e.spawnId === merged.spawnId)?.reason).toMatch(/not merged into origin's default branch/);
  });

  it('the manual policy is unchanged: pushed-only work still goes there', async () => {
    const pushedOnly = endedStart();
    sh(repo, 'push', '-q', 'origin', pushedOnly.branch!);
    const res = await pruneHeadless(wmuxDir, { dryRun: true, daemonRunning: async () => true }, { git, store });
    expect(res.removed.map((e) => [e.spawnId, e.reason])).toEqual([[pushedOnly.spawnId, 'clean, pushed']]);
  });
});

describe('HeadlessPruneScheduler', () => {
  const result = (over: Partial<Awaited<ReturnType<typeof auto>>> = {}) => ({ dryRun: false, removed: [], kept: [], recordsDropped: 0, ...over });

  it('runs one pass at a time, only while headless, and logs what it kept with its size', async () => {
    let release: () => void = () => undefined;
    const prune = vi.fn(() => new Promise<ReturnType<typeof result>>((resolve) => {
      release = () => resolve(result({
        removed: [{ spawnId: 's1', hostId: 'h', worktreePath: '/w/1', reason: 'clean, merged into origin/main' }],
        kept: [
          { spawnId: 's2', hostId: 'h', worktreePath: '/w/2', reason: 'x', kind: 'unmerged' },
          { spawnId: 's3', hostId: 'h', worktreePath: '/w/3', reason: 'y', kind: 'dirty' },
        ],
      }));
    }));
    const lines: string[] = [];
    let active = true;
    const s = new HeadlessPruneScheduler({ active: () => active, prune, log: (_l, m) => lines.push(m), sizeOf: async () => ({ bytes: 3 * 1024 * 1024, complete: true }) });
    const first = s.runOnce();
    void s.runOnce();
    expect(prune).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(lines).toEqual([
      '[headless] auto-prune: removed /w/1 (s1 from h): clean, merged into origin/main',
      expect.stringMatching(/^\[headless\] auto-prune: kept 2 worktree\(s\), 6\.0 MB: 1 with commits not merged into the default branch, 1 with uncommitted changes; .*--dry-run/),
    ]);
    active = false;
    await s.runOnce();
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('a start that ends brings a pass AUTO_PRUNE_AFTER_END_MS later, one for several ends', async () => {
    vi.useFakeTimers();
    try {
      const prune = vi.fn(async () => result());
      const s = new HeadlessPruneScheduler({ active: () => true, prune, log: () => undefined });
      s.noteStartEnded();
      await vi.advanceTimersByTimeAsync(AUTO_PRUNE_AFTER_END_MS / 2);
      s.noteStartEnded();
      await vi.advanceTimersByTimeAsync(AUTO_PRUNE_AFTER_END_MS - 1);
      expect(prune).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(prune).toHaveBeenCalledTimes(1);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sizes a folder without following links, and says when it stopped early', async () => {
    const dir = path.join(root, 'sized');
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'f'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(dir, 'g'), Buffer.alloc(24));
    fs.symlinkSync(root, path.join(dir, 'loop'));
    expect(await folderSize(dir)).toEqual({ bytes: 1024, complete: true });
    expect((await folderSize(dir, { entries: 1 })).complete).toBe(false);
    expect(keptSummary([{ spawnId: 's', hostId: 'h', worktreePath: dir, reason: 'r', kind: 'held' }], 1024, false))
      .toMatch(/kept 1 worktree\(s\), at least 1 KB: 1 with processes of their agent still running/);
  });
});
