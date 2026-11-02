// seatLaunches against real git in temp folders: each seat but the CEO gets
// its own worktree and branch, and a failure takes back what was made.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEAT_STAMP_FILE, seatLaunches } from '../seatLaunch';
import { TaskWorktreeManager } from '../../worktask/TaskWorktreeManager';

const WS = 'ws-0123abcd-4567-89ab-cdef-0123456789ab';
const branchOf = (label: string) => `company/${label}-456789ab`;

let root: string;
let repo: string;
let deps: Parameters<typeof seatLaunches>[1];

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const branches = (): string[] => g(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
/** The meta folder beside a seat worktree, where its stamp is. */
const metaOf = (worktree: string) => path.join(path.dirname(worktree), '.meta', path.basename(worktree));

const req = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  company: 'checkout',
  ceo: 0,
  tellSeats: true,
  folder: repo,
  seats: [
    { label: 'ceo', owns: 'Plans', agent: 'claude' },
    { label: 'dev-1', owns: '', agent: 'claude' },
    { label: 'dev-2', owns: 'Windows', agent: 'codex' },
    { label: 'notes', owns: '' },
  ],
  ...over,
});

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-seat-wt-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', '.');
  g(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  deps = { dir: path.join(root, 'data'), platform: 'darwin', takenLabels: () => [], worktrees: new TaskWorktreeManager({ worktreesRoot: path.join(root, 'company-worktrees') }) };
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('seatLaunches worktrees', () => {
  it('gives each seat but the CEO its own worktree and branch, and names them in the briefs', async () => {
    const res = await seatLaunches(req(), deps);
    if (!res.ok) throw new Error(res.error);
    const [ceo, dev1, dev2, notes] = res.cwds;
    expect(ceo).toBeNull();
    expect(notes).toBeNull();
    if (!dev1 || !dev2) throw new Error('a dev seat has no worktree');
    expect(path.dirname(path.dirname(dev1))).toBe(path.join(root, 'company-worktrees'));
    expect(g(dev1, 'branch', '--show-current')).toBe(branchOf('dev-1'));
    expect(g(dev2, 'branch', '--show-current')).toBe(branchOf('dev-2'));
    expect(fs.readFileSync(path.join(dev1, 'a.txt'), 'utf8').trim()).toBe('a');

    const brief = (n: number) => fs.readFileSync(path.join(root, 'data', 'company-briefs', WS, `seat-${n}.md`), 'utf8');
    expect(brief(2)).toContain(`Your worktree is ${dev1}, on branch ${branchOf('dev-1')}.`);
    expect(brief(1)).toContain(`#dev-1 (branch ${branchOf('dev-1')}), #dev-2 (owns Windows; branch ${branchOf('dev-2')}), #notes`);
    expect(brief(1)).not.toContain('Your worktree');
  });

  it('stamps each seat worktree with what it was made for and the commit its branch started at', async () => {
    const res = await seatLaunches(req(), { ...deps, now: () => 1_700_000_000_000 });
    if (!res.ok) throw new Error(res.error);
    const dev1 = res.cwds[1];
    if (!dev1) throw new Error('dev-1 has no worktree');
    const stamp = JSON.parse(fs.readFileSync(path.join(metaOf(dev1), SEAT_STAMP_FILE), 'utf8'));
    expect(stamp).toEqual({
      v: 1, workspaceId: WS, company: 'checkout', label: 'dev-1', branch: branchOf('dev-1'),
      baseOid: g(repo, 'rev-parse', 'main'), createdAt: 1_700_000_000_000,
    });
    // Nothing of it is in the worktree.
    expect(g(dev1, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('refuses two such seats without a folder or outside a repository, and makes nothing', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect((await seatLaunches(req({ folder: undefined }), deps)).ok).toBe(false);
    expect((await seatLaunches(req({ folder: plain }), deps)).ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'data', 'company-briefs', WS))).toBe(false);
    expect(branches()).toEqual(['main']);
  });

  it('lets a lone such seat share a folder that is not a repository with the CEO', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const res = await seatLaunches(req({ folder: plain, seats: [{ label: 'ceo', owns: '', agent: 'claude' }, { label: 'dev-1', owns: '', agent: 'claude' }] }), deps);
    expect(res).toMatchObject({ ok: true, cwds: [null, null] });
  });

  it('takes back the worktrees it made when a later seat cannot have one, and keeps branches it did not make', async () => {
    g(repo, 'branch', branchOf('dev-2'));
    const res = await seatLaunches(req(), deps);
    expect(res.ok).toBe(false);
    expect(branches()).toEqual([branchOf('dev-2'), 'main'].sort());
    expect(g(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'data', 'company-briefs', WS))).toBe(false);
    // The stamp of the worktree it took back went with it.
    const [hash] = fs.readdirSync(path.join(root, 'company-worktrees'));
    expect(fs.existsSync(path.join(root, 'company-worktrees', hash, '.meta', 'dev-1-456789ab'))).toBe(false);
  });
});
