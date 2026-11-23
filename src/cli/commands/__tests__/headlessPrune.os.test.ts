// `wmux daemon headless prune`: on real git repositories, which ended starts' worktrees go and which stay.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Git } from '../../../main/a2aRemote/spawnWorktree';
import { HeadlessStartStore, type HeadlessStartRecordV1 } from '../../../daemon/a2aRemote/headlessStartStore';
import { pruneHeadless } from '../headlessPrune';

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
let wmuxDir: string;
let store: HeadlessStartStore;
let n = 0;

/** An ended start with its own worktree on branch wmux/remote/<tree>, one commit past main. */
function endedStart(over: Partial<HeadlessStartRecordV1> = {}): HeadlessStartRecordV1 {
  n += 1;
  const hex = n.toString(16).padStart(12, '0');
  const spawnId = `sp-0123abcd-4567-89ab-cdef-${hex}`;
  const branch = `wmux/remote/${spawnId}`;
  const wt = path.join(root, `remote-${spawnId}`);
  sh(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  fs.writeFileSync(path.join(wt, `work-${n}.txt`), 'done\n');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-m', `work ${n}`);
  const rec: HeadlessStartRecordV1 = {
    v: 1, hostId: HOST as HeadlessStartRecordV1['hostId'], spawnId, agent: 'claude', repoPath: repo, treeId: spawnId,
    sessionId: `hl-00000000-0000-4000-8000-${hex}`, workspaceId: `hl-${hex}`, agentSessionId: '33333333-3333-4333-8333-333333333333',
    lineage: `remote-spawn:${HOST}`, runId: 'run-1', phase: 'ended', worktreePath: wt, cwd: wt,
    baseCommit: sh(repo, 'rev-parse', 'main'), branch, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), ...over,
  };
  store.add(rec);
  return rec;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hl-prune-')));
  repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  sh(root, 'init', '-q', '--bare', remote);
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

const reload = (): HeadlessStartRecordV1[] => new HeadlessStartStore({ dir: path.join(wmuxDir, 'a2a'), scheduleHarden: () => undefined }).list();

describe('headless prune', () => {
  it('removes a clean, pushed worktree and its branch; keeps a dirty or unpushed one, with the reason', async () => {
    const pushed = endedStart();
    sh(repo, 'push', '-q', 'origin', pushed.branch!);
    const dirty = endedStart();
    sh(repo, 'push', '-q', 'origin', dirty.branch!);
    fs.writeFileSync(path.join(dirty.worktreePath!, 'scratch.txt'), 'not committed\n');
    const unpushed = endedStart();

    const res = await pruneHeadless(wmuxDir, { dryRun: false, daemonRunning: false }, { git });
    expect(res.removed.map((e) => e.spawnId)).toEqual([pushed.spawnId]);
    expect(res.removed[0].reason).toMatch(/clean, pushed/);
    const kept = Object.fromEntries(res.kept.map((e) => [e.spawnId, e.reason]));
    expect(kept[dirty.spawnId]).toMatch(/uncommitted or untracked/);
    expect(kept[unpushed.spawnId]).toMatch(/not pushed and was not fetched back/);
    expect(fs.existsSync(pushed.worktreePath!)).toBe(false);
    expect(sh(repo, 'branch', '--list', pushed.branch!)).toBe('');
    // Kept as they were: the uncommitted file is still there, and the unpushed branch.
    expect(fs.readFileSync(path.join(dirty.worktreePath!, 'scratch.txt'), 'utf8')).toBe('not committed\n');
    expect(sh(repo, 'branch', '--list', unpushed.branch!)).not.toBe('');
    // No daemon answered: the removed start's record went here.
    expect(res.recordsDropped).toBe(1);
    expect(reload().map((r) => r.spawnId).sort()).toEqual([dirty.spawnId, unpushed.spawnId].sort());
  });

  it('a worktree whose commit the asking PC fetched back goes; one that moved on since does not', async () => {
    const fetched = endedStart();
    store.update(HOST, fetched.spawnId, { fetchedHead: sh(fetched.worktreePath!, 'rev-parse', 'HEAD') });
    const movedOn = endedStart();
    store.update(HOST, movedOn.spawnId, { fetchedHead: sh(movedOn.worktreePath!, 'rev-parse', 'HEAD') });
    fs.writeFileSync(path.join(movedOn.worktreePath!, 'more.txt'), 'more\n');
    sh(movedOn.worktreePath!, 'add', '.');
    sh(movedOn.worktreePath!, 'commit', '-qm', 'more');

    const res = await pruneHeadless(wmuxDir, { dryRun: false, daemonRunning: true }, { git });
    expect(res.removed.map((e) => [e.spawnId, e.reason])).toEqual([[fetched.spawnId, 'clean, fetched back']]);
    expect(res.kept.map((e) => e.spawnId)).toEqual([movedOn.spawnId]);
    // A running daemon owns the file: it drops the record itself (the folder is gone).
    expect(res.recordsDropped).toBe(0);
    expect(reload()).toHaveLength(2);
  });

  it('--dry-run lists what would go and changes nothing; held and running starts are not touched', async () => {
    const pushed = endedStart();
    sh(repo, 'push', '-q', 'origin', pushed.branch!);
    const held = endedStart({ survivors: [{ pid: 4242, reason: 'did not exit' }] });
    sh(repo, 'push', '-q', 'origin', held.branch!);
    const running = endedStart({ phase: 'started' });
    sh(repo, 'push', '-q', 'origin', running.branch!);

    const res = await pruneHeadless(wmuxDir, { dryRun: true, daemonRunning: false }, { git });
    expect(res.removed.map((e) => e.spawnId)).toEqual([pushed.spawnId]);
    expect(res.kept.map((e) => [e.spawnId, e.reason])).toEqual([[held.spawnId, expect.stringMatching(/may still run/)]]);
    for (const r of [pushed, held, running]) expect(fs.existsSync(r.worktreePath!)).toBe(true);
    expect(reload()).toHaveLength(3);
  });
});
