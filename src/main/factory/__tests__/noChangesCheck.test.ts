// The no-changes check: a bot task is skipped as unchanged, and its bot's
// completion on that skip goes through, only when the worktree's HEAD,
// main's record of what task.push published and the task branch on origin
// itself are all the base recorded at dispatch or behind it. Anything that
// cannot be read is `unknown`. Real git below: a bare origin, a worktree,
// task.push, a reset.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import type { LedgerEntry } from '../../../shared/ledger';
import type { RpcContext } from '../../../shared/rpc';
import { checkNoChanges, liveNoChangesCheck, liveNoChangesPorts, type NoChangesPorts } from '../noChangesCheck';
import { recordNoChangesGate } from '../taskGate';
import { pushTaskBranch } from '../../worktask/taskPush';
import { readTaskRemoteHead } from '../../worktask/taskFetch';
import { TASK_PUSHES_FILENAME, taskPushRecordOf } from '../../worktask/taskPushRecord';
import { registerLedgerRpc } from '../../pipe/handlers/ledger.rpc';
import { fakeSshUrl, writeFakeSsh } from '../../../test-utils/fakeSsh';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const entry = (over: Partial<LedgerEntry['dispatch']> = {}): LedgerEntry => ({
  id: 't1', taskWorkspaceId: 'ws-t', ownerWorkspaceId: 'ws-o', title: 't', status: 'review_requested', rev: 3, updatedAt: 1,
  updatedBy: { kind: 'worker', workspaceId: 'ws-t' }, schemaVersion: 1,
  dispatch: { origin: { kind: 'operator' }, baseOid: B, ...over },
} as LedgerEntry);

describe('checkNoChanges', () => {
  const ports = (over: Partial<NoChangesPorts> = {}): NoChangesPorts => ({
    mission: async () => ({ worktreePath: '/wt', branch: 'wtask/one' }),
    headOf: async () => B,
    branchRef: async () => null,
    pushed: () => null,
    remoteHead: async () => ({ ok: true, sha: null }),
    ...over,
  });

  it('unchanged only when HEAD, the push record and origin\'s branch are each the recorded base (or absent)', async () => {
    expect(await checkNoChanges(ports(), entry())).toEqual({ kind: 'unchanged', base: B, head: B });
    expect(await checkNoChanges(ports({ pushed: () => B, remoteHead: async () => ({ ok: true, sha: B.toUpperCase() }) }), entry())).toEqual({ kind: 'unchanged', base: B, head: B });
  });

  it('changed: any other commit, ahead of the base or behind it, in HEAD, the push record or origin (pushed, then reset)', async () => {
    for (const other of [A, C]) {
      expect((await checkNoChanges(ports({ headOf: async () => other }), entry())).kind).toBe('changed');
      expect((await checkNoChanges(ports({ pushed: () => other }), entry())).kind).toBe('changed');
      expect(await checkNoChanges(ports({ remoteHead: async () => ({ ok: true, sha: other }) }), entry())).toMatchObject({ kind: 'changed', why: expect.stringContaining(other) });
    }
  });

  it('the task branch\'s local ref counts as much as HEAD: past the base is a change, unreadable is unknown', async () => {
    expect(await checkNoChanges(ports({ branchRef: async () => B }), entry())).toMatchObject({ kind: 'unchanged' });
    expect(await checkNoChanges(ports({ branchRef: async () => C }), entry())).toMatchObject({ kind: 'changed', why: expect.stringContaining(`wtask/one is at ${C}`) });
    expect((await checkNoChanges(ports({ branchRef: async () => 'unknown' }), entry())).kind).toBe('unknown');
  });

  it('HEAD, the branch ref and the push record are read again after origin: anything that moved meanwhile is a change', async () => {
    const moving = <T>(first: T, then: T) => { let n = 0; return () => (n++ === 0 ? first : then); };
    const head = moving<string>(B, C);
    expect(await checkNoChanges(ports({ headOf: async () => head() }), entry())).toMatchObject({ kind: 'changed', why: expect.stringContaining('after origin was read') });
    const ref = moving<string | null>(null, C);
    expect(await checkNoChanges(ports({ branchRef: async () => ref() }), entry())).toMatchObject({ kind: 'changed', why: expect.stringContaining('after origin was read') });
    // A push that began while origin answered.
    const pushed = moving<'unknown' | null>(null, 'unknown');
    expect(await checkNoChanges(ports({ pushed: () => pushed() }), entry())).toMatchObject({ kind: 'unknown', why: expect.stringContaining('after origin was read') });
  });

  it('unknown: no recorded base (or a detached checkout), no mission, no HEAD, unreadable push history, origin unreachable, a throw', async () => {
    expect((await checkNoChanges(ports(), entry({ baseOid: undefined }))).kind).toBe('unknown');
    expect((await checkNoChanges(ports(), entry({ checkout: { sha: B, detached: true } }))).kind).toBe('unknown');
    expect((await checkNoChanges(ports({ mission: async () => null }), entry())).kind).toBe('unknown');
    expect((await checkNoChanges(ports({ headOf: async () => null }), entry())).kind).toBe('unknown');
    expect(await checkNoChanges(ports({ pushed: () => 'unknown' }), entry())).toMatchObject({ kind: 'unknown', why: expect.stringContaining('pushes') });
    expect(await checkNoChanges(ports({ remoteHead: async () => ({ ok: false, reason: 'git-failed', error: 'could not read from remote' }) }), entry())).toMatchObject({ kind: 'unknown', why: expect.stringContaining('could not read from remote') });
    expect((await checkNoChanges(ports({ headOf: async () => { throw new Error('boom'); } }), entry())).kind).toBe('unknown');
  });

});

// The stand-in ssh origin is a /bin/sh script.
describe.skipIf(process.platform === 'win32')('the no-changes check over real git, task.push and ledger.update', () => {
  const run = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
  let root = '';
  let origin = '';
  let repo = '';
  let work = '';
  let dataDir = '';
  let base = '';
  let ledger: TaskLedger;
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-no-changes-')));
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    work = path.join(root, 'work');
    dataDir = path.join(root, 'data');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-qm', 'init');
    run(repo, 'remote', 'add', 'origin', origin);
    run(repo, 'push', '-q', 'origin', 'main');
    // Main's network git allows https and ssh only: origin is reached over a
    // stand-in ssh the owner's global config names.
    run(repo, 'remote', 'set-url', 'origin', fakeSshUrl(origin));
    fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), `[core]\n\tsshCommand = ${writeFakeSsh(root)}\n`);
    run(repo, 'worktree', 'add', '-q', '-b', 'wtask/one', work);
    base = run(work, 'rev-parse', 'HEAD');
    gitCommonDir = fs.realpathSync.native(path.join(repo, '.git'));
    gitWorktreeDir = fs.realpathSync.native(run(work, 'rev-parse', '--path-format=absolute', '--git-dir'));
    ledger = new TaskLedger({ dir: path.join(root, 'ledger') });
    await ledger.register({ id: 't1', taskWorkspaceId: 'ws-t', ownerWorkspaceId: 'ws-o', title: 't', dispatch: { origin: { kind: 'operator' }, baseOid: base, gitCommonDir, gitWorktreeDir } });
    const r = await ledger.update({ id: 't1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'ws-t' }, expectedRev: 1, summary: 'read the API, nothing to commit' });
    if (!r.ok) throw new Error(r.message);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(os.homedir(), '.gitconfig'), { force: true });
  });
  let gitCommonDir = '';
  let gitWorktreeDir = '';
  const at = () => ({ worktreePath: work, branch: 'wtask/one', noHooksDir: path.join(root, 'nh'), gitCommonDir, gitWorktreeDir, relayRoot: path.join(root, 'relay'), taskId: 't1' });

  const check = () => liveNoChangesCheck({
    rpc: () => async () => ({ ok: true, tasks: [{ id: 't1', worktreePath: work, branch: 'wtask/one' }] }),
    wmuxDir: () => dataDir,
    botRepoKey: () => undefined,
  });
  const row = (): LedgerEntry => ledger.get('t1') as LedgerEntry;
  /** ledger.update as a brain, with the live check wired. */
  const complete = async (): Promise<unknown> => {
    const handlers = new Map<string, (p: Record<string, unknown>, c?: RpcContext) => Promise<unknown>>();
    registerLedgerRpc({ register: (m: string, h: never) => handlers.set(m, h) } as never, () => null, { getLedger: () => ledger, noChangesCheck: check() });
    return (handlers.get('ledger.update') as (p: Record<string, unknown>, c?: RpcContext) => Promise<unknown>)(
      { taskId: 't1', status: 'completed', expectedRev: row().rev },
      { origin: 'local', commanderWorkspace: 'ws-o' } as RpcContext,
    );
  };
  /** The skip, recorded the way the task gate records it. */
  const skip = async (): Promise<void> => {
    const v = await check()(row());
    expect(v).toEqual({ kind: 'unchanged', base, head: base });
    expect(await recordNoChangesGate(ledger, 't1', 'no commits', Date.now, base)).toBe(true);
  };
  /** Commit, publish it with task.push (recorded as task.push records it),
   *  then reset HEAD back to the base. */
  const commitPushReset = async (record = true): Promise<string> => {
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    run(work, 'add', '.');
    run(work, 'commit', '-qm', 'work');
    const pushed = await pushTaskBranch({ ...at(), defaultBranches: [] });
    if (!pushed.ok) throw new Error(pushed.error);
    if (record) taskPushRecordOf(dataDir).record('t1', pushed.head);
    run(work, 'reset', '-q', '--hard', base);
    return pushed.head;
  };

  it('a task that never pushed and holds no commits: unchanged, and its completion goes through', async () => {
    await skip();
    expect(await complete()).toMatchObject({ ok: true, entry: { status: 'completed' } });
  });

  it('commit, push, reset after the skip: the completion is refused (main\'s push record)', async () => {
    await skip();
    const pushed = await commitPushReset();
    expect(await check()(row())).toMatchObject({ kind: 'changed', why: expect.stringContaining(pushed) });
    expect(await complete()).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(row().status).toBe('review_requested');
  });

  it('commit, push, reset with no push record at all: origin itself shows the commit, and the completion is refused', async () => {
    await skip();
    const pushed = await commitPushReset(false);
    expect(taskPushRecordOf(dataDir).get('t1')).toBeNull();
    // The worker also deletes the remote-tracking ref main set: it is not read.
    run(work, 'update-ref', '-d', 'refs/remotes/origin/wtask/one');
    expect(await readTaskRemoteHead(at())).toEqual({ ok: true, sha: pushed });
    expect(await check()(row())).toMatchObject({ kind: 'changed', why: expect.stringContaining(`origin's wtask/one is at ${pushed}`) });
    expect(await complete()).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });

  it('origin unreachable: unknown, so the gate would run, and the completion is refused', async () => {
    await skip();
    run(work, 'remote', 'set-url', 'origin', fakeSshUrl(path.join(root, 'gone.git')));
    expect((await readTaskRemoteHead(at())).ok).toBe(false);
    expect(await check()(row())).toMatchObject({ kind: 'unknown', why: expect.stringContaining('could not be read') });
    expect(await complete()).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });

  it('push history that cannot be read (as main finds it at start): unknown, so the gate would run, and the completion is refused', async () => {
    fs.mkdirSync(path.join(dataDir, 'factory'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'factory', TASK_PUSHES_FILENAME), '{ not json');
    expect(await check()(row())).toMatchObject({ kind: 'unknown', why: expect.stringContaining('pushes') });
    // A skip on the row (as if recorded before) completes nothing either.
    expect(await recordNoChangesGate(ledger, 't1', 'no commits', Date.now, base)).toBe(true);
    expect(await complete()).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    // The unreadable file is left as it is, not overwritten with less.
    taskPushRecordOf(dataDir).record('t1', 'e'.repeat(40));
    expect(fs.readFileSync(path.join(dataDir, 'factory', TASK_PUSHES_FILENAME), 'utf8')).toBe('{ not json');
    expect(taskPushRecordOf(dataDir).get('t1')).toBe('unknown');
  });

  it('a commit dressed up as the base with a replace ref and a grafts file is still a change', async () => {
    await skip();
    fs.writeFileSync(path.join(work, 'c.txt'), 'c\n');
    run(work, 'add', '.');
    run(work, 'commit', '-qm', 'work');
    const c = run(work, 'rev-parse', 'HEAD');
    // The base "has" the new commit as its parent, as far as this repository says.
    run(work, 'replace', '--graft', base, c);
    fs.writeFileSync(path.join(gitCommonDir, 'info', 'grafts'), `${base} ${c}\n`);
    expect(run(work, 'merge-base', '--is-ancestor', c, base)).toBe('');
    expect(await check()(row())).toMatchObject({ kind: 'changed', why: expect.stringContaining(c) });
    expect(await complete()).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });

  it('a push under way: unknown until it ends', async () => {
    await skip();
    const record = taskPushRecordOf(dataDir);
    record.begin('t1');
    expect(await check()(row())).toMatchObject({ kind: 'unknown', why: expect.stringContaining('push is under way') });
    expect(await complete()).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    record.end('t1');
    expect((await check()(row())).kind).toBe('unchanged');
  });

  it('commits on the task branch with HEAD detached back at the base, never pushed: the branch ref is a change, refused', async () => {
    await skip();
    fs.writeFileSync(path.join(work, 'd.txt'), 'd\n');
    run(work, 'add', '.');
    run(work, 'commit', '-qm', 'parked');
    const parked = run(work, 'rev-parse', 'HEAD');
    run(work, 'switch', '-q', '--detach', base);
    expect(run(work, 'rev-parse', 'HEAD')).toBe(base);
    expect(await check()(row())).toMatchObject({ kind: 'changed', why: expect.stringContaining(`wtask/one is at ${parked}`) });
    expect(await complete()).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    // With the branch ref deleted too, HEAD and origin are at the base and
    // the branch is gone: nothing of the task remains to publish.
    run(work, 'branch', '-q', '-D', 'wtask/one');
    expect((await check()(row())).kind).toBe('unchanged');
  });

  it('a commit made while origin is read is a change: the completion is refused', async () => {
    await skip();
    const live = liveNoChangesPorts({
      rpc: () => async () => ({ ok: true, tasks: [{ id: 't1', worktreePath: work, branch: 'wtask/one' }] }),
      wmuxDir: () => dataDir,
      botRepoKey: () => undefined,
    });
    let committed = '';
    const slowOrigin: NoChangesPorts = {
      ...live,
      remoteHead: async (e, m) => {
        // The worker commits while main waits on origin.
        fs.writeFileSync(path.join(work, 'e.txt'), 'e\n');
        run(work, 'add', '.');
        run(work, 'commit', '-qm', 'during');
        committed = run(work, 'rev-parse', 'HEAD');
        return live.remoteHead(e, m);
      },
    };
    const handlers = new Map<string, (p: Record<string, unknown>, c?: RpcContext) => Promise<unknown>>();
    registerLedgerRpc({ register: (m: string, h: never) => handlers.set(m, h) } as never, () => null, { getLedger: () => ledger, noChangesCheck: (e) => checkNoChanges(slowOrigin, e) });
    const r = await (handlers.get('ledger.update') as (p: Record<string, unknown>, c?: RpcContext) => Promise<unknown>)(
      { taskId: 't1', status: 'completed', expectedRev: row().rev },
      { origin: 'local', commanderWorkspace: 'ws-o' } as RpcContext,
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringContaining(committed) } });
    expect(row().status).toBe('review_requested');
  });

  it('a commit after the skip that was never pushed: HEAD has moved, refused', async () => {
    await skip();
    fs.writeFileSync(path.join(work, 'c.txt'), 'c\n');
    run(work, 'add', '.');
    run(work, 'commit', '-qm', 'later');
    expect((await check()(row())).kind).toBe('changed');
    expect(await complete()).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });
});
