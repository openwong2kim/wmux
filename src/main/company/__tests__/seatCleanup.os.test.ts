// The company seat cleanup against real folders and real git: which paths
// count as a seat worktree, and what the sweep removes and keeps, with a bare
// repository as the remote.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapedWorktreeDir } from '../../worktask/PhoneWorktreeRemoval';
import { TaskWorktreeManager } from '../../worktask/TaskWorktreeManager';
import { COMPANY_SEAT_SHAPE, SEAT_SWEEP_MIN_AGE_MS } from '../seatCleanupRule';
import { listCompanySeatLeftovers, removeCompanySeat, serialSeatSweeps, sweepCompanySeats, type SeatSession } from '../seatCleanup';
import { seatLaunches } from '../seatLaunch';

const HASH = 'abc123def456';
const SLUG = 'dev-1-456789ab';
let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-seat-cleanup-')));
  root = path.join(base, 'company-worktrees');
  fs.mkdirSync(path.join(root, HASH, '.meta', SLUG), { recursive: true });
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('the company seat folder shape', () => {
  it('accepts the folders seatLaunches makes', () => {
    const dir = path.join(root, HASH, SLUG);
    fs.mkdirSync(dir);
    expect(shapedWorktreeDir(root, dir, COMPANY_SEAT_SHAPE)).toBe(dir);
    // A label with no slug leaves the workspace id's suffix alone.
    const bare = path.join(root, HASH, '456789ab');
    fs.mkdirSync(bare);
    expect(shapedWorktreeDir(root, bare, COMPANY_SEAT_SHAPE)).toBe(bare);
  });

  it('refuses .meta, the wrong depth, a repository folder that is not 12 hex, and a link', () => {
    fs.mkdirSync(path.join(root, HASH, SLUG, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'not-a-hash', SLUG), { recursive: true });
    for (const bad of [
      path.join(root, HASH, '.meta'),
      path.join(root, HASH, '.meta', SLUG),
      path.join(root, HASH),
      root,
      path.join(root, HASH, SLUG, 'src'),
      path.join(root, 'not-a-hash', SLUG),
      `${root}/${HASH}/../${HASH}/${SLUG}/..`,
    ]) {
      expect(shapedWorktreeDir(root, bad, COMPANY_SEAT_SHAPE)).toBeNull();
    }
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, HASH, 'linked-456789ab'), 'dir');
    expect(shapedWorktreeDir(root, path.join(root, HASH, 'linked-456789ab'), COMPANY_SEAT_SHAPE)).toBeNull();
    // A repository folder that is a link leads elsewhere too.
    fs.symlinkSync(path.join(root, HASH), path.join(root, 'fedcba987654'), 'dir');
    expect(shapedWorktreeDir(root, path.join(root, 'fedcba987654', SLUG), COMPANY_SEAT_SHAPE)).toBeNull();
  });

  it('reports only the folder\'s own company branch', () => {
    expect(COMPANY_SEAT_SHAPE.branch(`company/${SLUG}`, SLUG)).toBe(true);
    expect(COMPANY_SEAT_SHAPE.branch('company/dev-2-456789ab', SLUG)).toBe(false);
    expect(COMPANY_SEAT_SHAPE.branch('feature/mine', SLUG)).toBe(false);
  });
});

describe('the seat sweep', () => {
  const WS = 'ws-0123abcd-4567-89ab-cdef-0123456789ab';
  const T0 = 1_700_000_000_000;
  const LATER = T0 + SEAT_SWEEP_MIN_AGE_MS + 60_000;
  let repo: string;
  let remote: string;
  let worktrees: TaskWorktreeManager;

  const g = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
  const branches = (): string[] => g(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
  const metaOf = (dir: string) => path.join(path.dirname(dir), '.meta', path.basename(dir));
  const commit = (dir: string, file: string) => {
    fs.writeFileSync(path.join(dir, file), file);
    g(dir, 'add', file);
    g(dir, 'commit', '-q', '-m', file);
  };

  /** Two seats besides the CEO, made the way a company makes them, at T0. */
  async function seats(): Promise<[string, string]> {
    const res = await seatLaunches({
      workspaceId: WS, company: 'checkout', ceo: 0, tellSeats: false, folder: repo,
      seats: [{ label: 'ceo', owns: '', agent: 'claude' }, { label: 'dev-1', owns: '', agent: 'claude' }, { label: 'dev-2', owns: '', agent: 'claude' }],
    }, { dir: path.join(base, 'data'), platform: 'darwin', takenLabels: () => [], now: () => T0, worktrees });
    if (!res.ok || !res.cwds[1] || !res.cwds[2]) throw new Error(res.ok ? 'a seat has no worktree' : res.error);
    return [res.cwds[1], res.cwds[2]];
  }

  const sweep = (over: { keep?: string[]; sessions?: SeatSession[]; recoveryDone?: boolean; now?: number } = {}) => sweepCompanySeats({
    root,
    sessions: async () => ({ sessions: over.sessions ?? [], recoveryDone: over.recoveryDone ?? true }),
    keep: over.keep ?? [],
    worktrees,
    now: () => over.now ?? LATER,
  });

  beforeEach(() => {
    remote = path.join(base, 'remote.git');
    repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    g(base, 'init', '-q', '--bare', '-b', 'main', remote);
    g(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'a.txt');
    g(repo, 'remote', 'add', 'origin', remote);
    g(repo, 'push', '-q', 'origin', 'main');
    worktrees = new TaskWorktreeManager({ worktreesRoot: root });
  });

  it('removes a seat whose work is pushed, with its stamp and its branch', async () => {
    const [dev1, dev2] = await seats();
    commit(dev1, 'work.txt');
    g(dev1, 'push', '-q', 'origin', 'HEAD');
    // dev-2 never committed: it is at origin's main.
    expect((await sweep())?.removed.sort()).toEqual([dev1, dev2].sort());
    expect(fs.existsSync(dev1)).toBe(false);
    expect(fs.existsSync(metaOf(dev1))).toBe(false);
    expect(branches()).toEqual(['main']);
    // The remote keeps what was pushed.
    expect(g(remote, 'branch', '--list', 'company/dev-1-456789ab')).toContain('company/dev-1-456789ab');
  });

  it('removes the seats of a company made in a linked worktree of the repository', async () => {
    const linked = path.join(base, 'linked');
    g(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
    const res = await seatLaunches({
      workspaceId: WS, company: 'checkout', ceo: 0, tellSeats: false, folder: linked,
      seats: [{ label: 'ceo', owns: '', agent: 'claude' }, { label: 'dev-1', owns: '', agent: 'claude' }],
    }, { dir: path.join(base, 'data'), platform: 'darwin', takenLabels: () => [], now: () => T0, worktrees });
    if (!res.ok || !res.cwds[1]) throw new Error(res.ok ? 'no worktree' : res.error);
    expect((await sweep())?.removed).toEqual([res.cwds[1]]);
    expect(branches()).toEqual(['main', 'side']);
  });

  it('removes a seat that never committed, even with no remote, and its branch', async () => {
    g(repo, 'remote', 'remove', 'origin');
    const [dev1, dev2] = await seats();
    expect((await sweep())?.removed.sort()).toEqual([dev1, dev2].sort());
    expect(branches()).toEqual(['main']);
  });

  it('leaves a branch the seat made itself, and deletes its company branch at the base', async () => {
    const [dev1] = await seats();
    g(dev1, 'checkout', '-q', '-b', 'feature/mine');
    commit(dev1, 'mine.txt');
    g(dev1, 'push', '-q', 'origin', 'feature/mine');
    expect((await sweep())?.removed).toContain(dev1);
    expect(branches()).toContain('feature/mine');
    expect(branches()).not.toContain('company/dev-1-456789ab');
  });

  it('keeps and lists a seat with an untracked file, and one with a commit only on this PC with its count', async () => {
    const [dev1, dev2] = await seats();
    fs.writeFileSync(path.join(dev1, 'notes.txt'), 'mine');
    commit(dev2, 'local.txt');
    expect(await sweep()).toEqual({ removed: [] });
    expect(fs.readFileSync(path.join(dev1, 'notes.txt'), 'utf8')).toBe('mine');
    expect(fs.existsSync(path.join(dev2, 'local.txt'))).toBe(true);
    expect(branches()).toContain('company/dev-2-456789ab');
    const listed = await listCompanySeatLeftovers({
      root, sessions: async () => ({ sessions: [], recoveryDone: true }), keep: [], now: () => LATER,
    });
    expect(listed.sort((a, b) => a.worktreePath.localeCompare(b.worktreePath))).toEqual([
      { worktreePath: dev1, reason: 'uncommitted', label: 'dev-1', company: 'checkout' },
      { worktreePath: dev2, reason: 'unpushed', commits: 1, label: 'dev-2', company: 'checkout' },
    ]);
  });

  it('lists nothing while the daemon cannot say which panes run where, and nothing it removes or keeps in use', async () => {
    const [dev1] = await seats();
    fs.writeFileSync(path.join(dev1, 'notes.txt'), 'mine');
    const list = (over: { recoveryDone?: boolean; keep?: string[]; now?: number }) => listCompanySeatLeftovers({
      root, sessions: async () => ({ sessions: [], recoveryDone: over.recoveryDone ?? true }), keep: over.keep ?? [], now: () => over.now ?? LATER,
    });
    expect(await list({ recoveryDone: false })).toEqual([]);
    expect(await list({ keep: [dev1] })).toEqual([]);
    expect(await list({ now: T0 })).toEqual([]);
    // dev-2 is clean and at origin's main: the sweep's, not the list's.
    expect((await list({})).map((s) => s.worktreePath)).toEqual([dev1]);
    expect(fs.existsSync(dev1)).toBe(true);
  });

  it('keeps a seat the renderer keeps, one a pane works in, and a young one', async () => {
    const [dev1, dev2] = await seats();
    expect(await sweep({ keep: [path.join(dev1, 'src')], sessions: [{ id: 's1', spawnCwd: path.join(base, 'elsewhere'), cwd: dev2 }] })).toEqual({ removed: [] });
    expect(await sweep({ now: T0 + 60_000 })).toEqual({ removed: [] });
    expect(fs.existsSync(dev1) && fs.existsSync(dev2)).toBe(true);
  });

  it('asks before removing a listed seat whose commits are on no branch and only here', async () => {
    const [dev1, dev2] = await seats();
    g(dev1, 'checkout', '-q', '--detach');
    commit(dev1, 'detached.txt');
    const remove = (dir: string, force: boolean) => removeCompanySeat(dir, force, { root, livePaneCwds: async () => [] });
    expect(await remove(dev1, false)).toEqual({ ok: false, reason: 'unpushed' });
    expect(fs.existsSync(path.join(dev1, 'detached.txt'))).toBe(true);
    expect(await remove(dev1, true)).toMatchObject({ ok: true });
    expect(fs.existsSync(dev1)).toBe(false);
    // On no branch but still at the base: nothing of its own to lose.
    g(dev2, 'checkout', '-q', '--detach');
    expect(await remove(dev2, false)).toMatchObject({ ok: true });
    // A folder git does not know is refused as that, not as commits.
    const stray = path.join(path.dirname(dev1), 'stray-456789ab');
    fs.mkdirSync(stray);
    expect(await remove(stray, false)).toEqual({ ok: false, reason: 'unregistered' });
  });

  it('keeps and lists a seat whose own branch has commits only here after HEAD left it', async () => {
    const [dev1] = await seats();
    commit(dev1, 'kept.txt');
    g(dev1, 'checkout', '-q', '--detach', 'origin/main');
    expect((await sweep())?.removed).not.toContain(dev1);
    expect(fs.existsSync(dev1)).toBe(true);
    expect(branches()).toContain('company/dev-1-456789ab');
    const listed = await listCompanySeatLeftovers({
      root, sessions: async () => ({ sessions: [], recoveryDone: true }), keep: [], now: () => LATER,
    });
    expect(listed.find((s) => s.worktreePath === dev1)).toMatchObject({ reason: 'unpushed', commits: 1 });
  });

  it('removes nothing until the daemon has recovered its sessions, and answers at once with no seat folder', async () => {
    const [dev1] = await seats();
    expect(await sweep({ recoveryDone: false })).toBeNull();
    expect(fs.existsSync(dev1)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
    const sessions = vi.fn(async () => null);
    expect(await sweepCompanySeats({ root, sessions, keep: [], worktrees })).toEqual({ removed: [] });
    expect(sessions).not.toHaveBeenCalled();
  });
});

describe('serialSeatSweeps', () => {
  it('runs one sweep at a time, then one more with the latest keep set for every request that waited', async () => {
    let release: () => void = () => undefined;
    const calls: (readonly string[])[] = [];
    const sweep = vi.fn(async (keep: readonly string[]) => {
      calls.push(keep);
      if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return { removed: calls.length === 1 ? ['a'] : ['b', 'c'] };
    });
    const sweeps = serialSeatSweeps(sweep, { attempts: 1, delayMs: 0 });
    const first = sweeps.request(['k1']);
    const second = sweeps.request(['k2']);
    const third = sweeps.request(['k3']);
    release();
    expect(await first).toEqual({ run: 1, removed: 1 });
    expect(await second).toEqual({ run: 2, removed: 2 });
    expect(await third).toEqual({ run: 2, removed: 2 });
    expect(calls).toEqual([['k1'], ['k3']]);
  });

  it('tries again with the newest keep set a request brought while it waited', async () => {
    let wake: () => void = () => undefined;
    const sleep = vi.fn(() => new Promise<void>((resolve) => { wake = resolve; }));
    const calls: (readonly string[])[] = [];
    const sweep = vi.fn(async (keep: readonly string[]) => {
      calls.push(keep);
      return calls.length === 1 ? null : { removed: [] };
    });
    const sweeps = serialSeatSweeps(sweep, { attempts: 3, delayMs: 15_000, sleep });
    const first = sweeps.request(['k1']);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled(), { timeout: 5_000 });
    const second = sweeps.request(['k2']);
    wake();
    await first;
    await second;
    expect(calls).toEqual([['k1'], ['k2'], ['k2']]);
  });

  it('tries again while the daemon is not ready, and gives up after its attempts', async () => {
    const sleep = vi.fn(async () => undefined);
    const ready = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ removed: ['a'] });
    expect(await serialSeatSweeps(ready, { attempts: 3, delayMs: 15_000, sleep }).request([])).toEqual({ run: 1, removed: 1 });
    expect(sleep).toHaveBeenCalledWith(15_000);
    const never = vi.fn(async () => null);
    expect(await serialSeatSweeps(never, { attempts: 3, delayMs: 1, sleep }).request([])).toEqual({ run: 1, removed: 0 });
    expect(never).toHaveBeenCalledTimes(3);
  });
});
