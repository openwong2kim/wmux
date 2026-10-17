// task.fetch: main fetches origin's default branch and the task branch into a
// worker's task repository (real git, local bare remote), for the caller's
// own open task only, and never pushes or moves the checkout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchTaskRefs as fetchTask, parseLsRemoteHeads, taskFetchArgs, taskFetchConfigRefusal } from '../taskFetch';
import { registerTaskPushRpc } from '../../pipe/handlers/taskPush.rpc';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

describe('fetchTaskRefs', () => {
  let root: string;
  let work: string;
  let origin: string;
  let other: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-fetch-'));
    origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    other = path.join(root, 'other');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'init');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-qb', 'wtask/one');
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'work');
    // Someone else moves main on origin, and tags it.
    execFileSync('git', ['clone', '-q', origin, other]);
    fs.writeFileSync(path.join(other, 'c.txt'), 'c\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'main moved');
    git(other, 'tag', 'v1');
    git(other, 'push', '-q', 'origin', 'main', 'v1');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const input = (over: Partial<Parameters<typeof fetchTask>[0]> = {}) => ({
    worktreePath: work, branch: 'wtask/one', noHooksDir: path.join(root, 'no-hooks'),
    gitCommonDir: fs.realpathSync.native(path.join(work, '.git')), relayRoot: path.join(root, 'relay'), taskId: 'wtask-1', ...over,
  });
  // The fixtures' origins are local folders: git's `file` transport.
  const fetchTaskRefs = (i: Parameters<typeof fetchTask>[0]) => fetchTask(i, undefined, { protocols: ['https', 'ssh', 'file'] });
  // The worker runs the returned fetch line in its own worktree.
  const runFetchLine = (cmd: string) => {
    const m = /^git fetch --no-tags --no-write-fetch-head (['"])(.*?)\1 (.+)$/.exec(cmd);
    if (!m) throw new Error(`unexpected fetch line: ${cmd}`);
    const refspecs = m[3].split(' ').map((r) => r.replace(/^(['"])(.*)\1$/, '$2'));
    git(work, 'fetch', '--no-tags', m[2], ...refspecs);
  };

  it('fetches origin\'s default branch, leaves the recorded repository untouched, and the worker\'s fetch line brings it in', async () => {
    const head = git(work, 'rev-parse', 'HEAD');
    const originRefs = git(origin, 'for-each-ref', '--format=%(refname) %(objectname)');
    const refsBefore = git(work, 'for-each-ref', '--format=%(refname) %(objectname)');
    const r = await fetchTaskRefs(input());
    expect(r).toMatchObject({ ok: true, remote: 'origin', defaultBranch: 'main', fetched: [{ ref: 'origin/main', sha: git(other, 'rev-parse', 'HEAD') }], missing: ['origin/wtask/one'] });
    expect(typeof (r as { fetchCommand: string }).fetchCommand).toBe('string');
    // Main wrote nothing under the recorded repository: no ref, no namespace.
    expect(git(work, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('wtask/one');
    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(git(origin, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(originRefs);
    // The worker runs the returned line, then merges.
    runFetchLine((r as { fetchCommand: string }).fetchCommand);
    expect(git(work, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(other, 'rev-parse', 'HEAD'));
    expect(git(work, 'tag', '--list')).toBe('');
    git(work, 'merge', '-q', '--no-edit', 'origin/main');
    expect(fs.existsSync(path.join(work, 'c.txt'))).toBe(true);
  });

  it('fetches the task branch too once it is on origin', async () => {
    git(work, 'push', '-q', 'origin', 'wtask/one');
    git(work, 'update-ref', '-d', 'refs/remotes/origin/wtask/one');
    const r = await fetchTaskRefs(input());
    expect(r).toMatchObject({ ok: true, missing: [], fetched: [{ ref: 'origin/main' }, { ref: 'origin/wtask/one', sha: git(work, 'rev-parse', 'HEAD') }] });
    runFetchLine((r as { fetchCommand: string }).fetchCommand);
    expect(git(work, 'rev-parse', 'refs/remotes/origin/wtask/one')).toBe(git(work, 'rev-parse', 'HEAD'));
  });

  it('refuses a bot\'s task whose origin is not the bot\'s repository, and a repository with no origin', async () => {
    expect(await fetchTaskRefs(input({ expectedRepoKey: 'github.com/acme/app' }))).toMatchObject({ ok: false, reason: 'remote-refused' });
    git(work, 'remote', 'remove', 'origin');
    expect(await fetchTaskRefs(input())).toMatchObject({ ok: false, reason: 'no-origin' });
  });

  it('refuses when the repository config names a program, and runs none of it', async () => {
    const marker = path.join(root, 'ran');
    git(work, 'config', 'core.sshCommand', `touch ${marker}`);
    expect(await fetchTaskRefs(input())).toMatchObject({ ok: false, reason: 'config-refused' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('fetches into the relay, not the recorded repository (its objects are unchanged by the fetch)', async () => {
    const countBefore = git(work, 'count-objects', '-v');
    const r = await fetchTaskRefs(input());
    expect(r).toMatchObject({ ok: true });
    // The new commit is in the relay, not the recorded repository's own store.
    expect(git(work, 'count-objects', '-v')).toBe(countBefore);
    const relay = path.join(root, 'relay', 'wtask-1');
    expect(git(relay, 'cat-file', '-t', git(other, 'rev-parse', 'HEAD'))).toBe('commit');
  });

  it('refuses a remote named by origin\'s URL and a bundle URI, and writes nothing', async () => {
    const victim = git(work, 'rev-parse', 'refs/heads/main');
    git(work, 'config', `remote.${origin}.fetch`, '+refs/heads/main:refs/heads/main');
    expect(await fetchTaskRefs(input())).toMatchObject({ ok: false, reason: 'config-refused', error: expect.stringContaining(`remote.${origin.toLowerCase()}.fetch`) });
    expect(git(work, 'rev-parse', 'refs/heads/main')).toBe(victim);
    git(work, 'config', '--unset', `remote.${origin}.fetch`);
    git(work, 'config', 'fetch.bundleURI', 'https://bundles.example.invalid/b');
    expect(await fetchTaskRefs(input())).toMatchObject({ ok: false, reason: 'config-refused', error: expect.stringContaining('fetch.bundleuri') });
    git(work, 'config', '--unset', 'fetch.bundleURI');
    // Another remote of the owner's own is fine.
    git(work, 'remote', 'add', 'upstream', 'https://github.com/acme/app.git');
    expect(await fetchTaskRefs(input())).toMatchObject({ ok: true });
    expect(taskFetchConfigRefusal([{ scope: 'global', key: 'fetch.bundleuri', value: 'x' }], origin)).toBeNull();
    expect(taskFetchConfigRefusal([{ scope: 'global', key: `remote.${origin.toLowerCase()}.url`, value: 'x' }], origin)).toBeNull();
  });

  it('fetches each branch into the relay\'s own refs/heads, at origin\'s URL, with no tags, submodules or FETCH_HEAD', () => {
    expect(taskFetchArgs('https://github.com/o/r.git', ['main', 'wtask/one'])).toEqual([
      'fetch', '--no-tags', '--recurse-submodules=no', '--no-write-fetch-head', '--no-auto-maintenance', '--no-write-commit-graph',
      '--', 'https://github.com/o/r.git', '+refs/heads/main:refs/heads/main', '+refs/heads/wtask/one:refs/heads/wtask/one',
    ]);
    expect(parseLsRemoteHeads(`${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/tags/v1\n`)).toEqual(new Map([['main', 'a'.repeat(40)]]));
  });
});

describe('task.fetch RPC', () => {
  type Handler = (params: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>;
  type Rec = { taskId: string; botId: string; ownerWorkspaceId: string };
  const setup = (over: { tasks?: unknown[]; caller?: string | null; botRepo?: string; row?: unknown; ended?: unknown; reclaimed?: (ws: string, pty: string) => Rec | null; exists?: boolean } = {}) => {
    const handlers = new Map<string, Handler>();
    const fetch = vi.fn(async () => ({ ok: true as const, remote: 'origin' as const, defaultBranch: 'main', fetchCommand: 'git fetch --no-tags R +refs/heads/main:refs/remotes/origin/main', fetched: [{ ref: 'origin/main', sha: 'abc' }], missing: [] }));
    const push = vi.fn();
    const row = over.row === undefined ? { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { origin: { kind: 'pane' }, repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' } } : over.row;
    registerTaskPushRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, {
      getWindow: () => null,
      daemon: { rpc: vi.fn(async () => ({ ok: true, tasks: over.tasks ?? [{ id: 'wtask-1', status: 'open', branch: 'wtask/one', worktreePath: '/w/one' }] })) },
      getLedger: () => ({ findOpenByTaskWorkspace: (ws: string) => (ws === 'ws-task' ? row : null), get: (id: string) => (id === 'wtask-1' ? over.ended ?? null : null) }) as never,
      reclaimedWorkerOfPane: over.reclaimed ?? (() => null),
      exists: () => over.exists ?? true,
      resolveCallerWorkspace: async () => (over.caller === undefined ? 'ws-task' : over.caller),
      wmuxDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-fetch-rpc-')),
      fetch: fetch as never,
      push: push as never,
      repoDefaultBranch: async () => 'main',
      botRepoKey: () => over.botRepo,
    });
    return { call: handlers.get('task.fetch')!, fetch, push };
  };
  const local = { origin: 'local' };

  it('fetches for the caller\'s own task, named by main\'s record only, and never pushes', async () => {
    const { call, fetch, push } = setup();
    const r = await call({ senderPtyId: 'pty-1', branch: 'main', worktreePath: '/elsewhere' }, local);
    expect(r).toMatchObject({ ok: true, defaultBranch: 'main', fetched: [{ ref: 'origin/main', sha: 'abc' }], taskId: 'wtask-1' });
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'wtask/one', worktreePath: '/w/one', expectedRepoKey: 'github.com/acme/app' }));
    expect(push).not.toHaveBeenCalled();
  });

  it('fetch uses the origin main recorded for the task: a task with none is refused', async () => {
    const none = setup({ row: { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task' } });
    expect(await none.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringMatching(/recorded no origin/) } });
    expect(none.fetch).not.toHaveBeenCalled();
    // A bot's task: its dispatch's repository first, over the bot's profile now.
    const bot = setup({ row: { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' } }, botRepo: 'github.com/acme/other' });
    await bot.call({ senderPtyId: 'pty-1' }, local);
    expect(bot.fetch).toHaveBeenCalledWith(expect.objectContaining({ expectedRepoKey: 'github.com/acme/app' }));
  });

  it('a bot\'s worker resumed after its task ended fetches from its recorded pane, for that task only', async () => {
    const ended = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'completed', dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' } };
    const rec = { taskId: 'wtask-1', botId: 'bot-1', ownerWorkspaceId: 'ws-owner' };
    const reclaimed = (ws: string, pty: string) => (ws === 'ws-task' && pty === 'pty-1' ? rec : null);
    const closed = [{ id: 'wtask-1', status: 'closed', branch: 'wtask/one', worktreePath: '/w/one' }];
    const ok = setup({ row: null, ended, reclaimed, tasks: closed });
    expect(await ok.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: true, taskId: 'wtask-1' });
    expect(ok.fetch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'wtask/one', worktreePath: '/w/one', expectedRepoKey: 'github.com/acme/app' }));
    // Another pane in that workspace is not that worker.
    expect(await setup({ row: null, ended, reclaimed, tasks: closed }).call({ senderPtyId: 'pty-2' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // A record whose task is another bot's, or another owner's, stands for nothing.
    expect(await setup({ row: null, ended, reclaimed: () => ({ ...rec, botId: 'bot-2' }), tasks: closed }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await setup({ row: null, ended, reclaimed: () => ({ ...rec, ownerWorkspaceId: 'ws-x' }), tasks: closed }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // Its worktree branch must still be there, and a detached task is not its own.
    expect(await setup({ row: null, ended, reclaimed, tasks: closed, exists: false }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(await setup({ row: null, ended, reclaimed, tasks: [{ ...closed[0], detachedAt: 1 }] }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });

  it('refuses a pane that is not the task\'s worker: remote, a brain, a bot, an unresolvable pane, a pane with no task', async () => {
    expect(await setup().call({ senderPtyId: 'pty-1' }, {})).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup().call({ senderPtyId: 'pty-1' }, { ...local, commanderWorkspace: 'ws-owner' })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup().call({ senderPtyId: 'pty-1' }, { ...local, bot: { botId: 'bot-1' } })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup().call({}, local)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup({ caller: null }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup({ caller: 'ws-other' }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('refuses a task that is not open, and a detached checkout', async () => {
    for (const status of ['closed', 'merged']) {
      // An open task's worker whose mission record says otherwise.
      const { call, fetch } = setup({ tasks: [{ id: 'wtask-1', status, branch: 'wtask/one', worktreePath: '/w/one' }] });
      expect(await call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringMatching(/not open/) } });
      expect(fetch).not.toHaveBeenCalled();
    }
    const detached = setup({ tasks: [{ id: 'wtask-1', status: 'open', branch: 'wtask/one', worktreePath: '/w/one', detachedAt: 1 }] });
    expect(await detached.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    const checkout = setup({ row: { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { checkout: { sha: 'abc' } } } });
    expect(await checkout.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });

  it('pins a bot\'s task to the bot\'s repository', async () => {
    const row = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, gitCommonDir: '/r/.git' } };
    const pinned = setup({ row, botRepo: 'github.com/acme/app' });
    await pinned.call({ senderPtyId: 'pty-1' }, local);
    expect(pinned.fetch).toHaveBeenCalledWith(expect.objectContaining({ expectedRepoKey: 'github.com/acme/app' }));
    const none = setup({ row });
    expect(await none.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });
});
