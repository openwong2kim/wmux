// hireSeat against real git in temp folders: a hired seat gets its own
// worktree and branch like a preset seat, a folder that is not a repository
// takes it only while no other staff agent works there, and a failure takes
// back what was made.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEAT_STAMP_FILE, hireSeat } from '../seatLaunch';
import { TaskWorktreeManager } from '../../worktask/TaskWorktreeManager';

const WS = 'ws-0123abcd-4567-89ab-cdef-0123456789ab';
const BRANCH = 'company/dev-4-456789ab';
const NOW = 1_700_000_000_000;

let root: string;
let repo: string;
let deps: Parameters<typeof hireSeat>[1];

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const branches = (): string[] => g(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
const metaOf = (worktree: string) => path.join(path.dirname(worktree), '.meta', path.basename(worktree));
const briefFile = () => path.join(root, 'data', 'company-briefs', WS, `hire-dev-4-${NOW}.md`);

const req = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  company: 'checkout',
  folder: repo,
  ceo: { label: 'ceo' },
  staff: [
    { label: 'dev-1', owns: '', agent: true },
    { label: 'notes', owns: 'Notes' },
  ],
  seat: { label: 'dev-4', owns: 'Windows', agent: 'codex' },
  ...over,
});

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hire-wt-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', '.');
  g(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  deps = {
    dir: path.join(root, 'data'), platform: 'darwin', takenLabels: () => ['ceo', 'dev-1', 'notes'], now: () => NOW,
    worktrees: new TaskWorktreeManager({ worktreesRoot: path.join(root, 'company-worktrees') }),
  };
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('hireSeat worktrees', () => {
  it('gives the seat its own worktree and branch, stamps it, and names both in its brief', async () => {
    const res = await hireSeat(req(), deps);
    if (!res.ok) throw new Error(res.error);
    const wt = res.cwd;
    if (!wt) throw new Error('the seat has no worktree');
    expect(res).toEqual({ ok: true, label: 'dev-4', command: `codex "$(cat '${briefFile()}')"`, cwd: wt, branch: BRANCH });
    expect(path.dirname(path.dirname(wt))).toBe(path.join(root, 'company-worktrees'));
    expect(g(wt, 'branch', '--show-current')).toBe(BRANCH);
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8').trim()).toBe('a');

    expect(JSON.parse(fs.readFileSync(path.join(metaOf(wt), SEAT_STAMP_FILE), 'utf8'))).toEqual({
      v: 1, workspaceId: WS, company: 'checkout', label: 'dev-4', branch: BRANCH, baseOid: g(repo, 'rev-parse', 'main'), createdAt: NOW,
    });
    expect(g(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('');

    const brief = fs.readFileSync(briefFile(), 'utf8');
    expect(brief).toContain('You are #dev-4 in the company "checkout" in wmux. Your CEO is #ceo.');
    expect(brief).toContain('You own: Windows.');
    expect(brief).toContain(`Your worktree is ${wt}, on branch ${BRANCH}.`);
  });

  it('refuses a folder that is not a repository while another staff seat\'s agent works there, and makes nothing', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect((await hireSeat(req({ folder: plain }), deps)).ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'data', 'company-briefs', WS))).toBe(false);
    expect(branches()).toEqual(['main']);
  });

  it('starts the seat in a folder that is not a repository when no other staff seat runs an agent', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const res = await hireSeat(req({ folder: plain, staff: [{ label: 'notes', owns: 'Notes' }] }), deps);
    expect(res).toMatchObject({ ok: true, label: 'dev-4', cwd: plain });
    expect(res).not.toHaveProperty('branch');
    expect(fs.readFileSync(briefFile(), 'utf8')).not.toContain('Your worktree');
  });

  it('takes back the worktree, its branch and its stamp when the brief cannot be written', async () => {
    // The data folder is a file, so the briefs folder cannot be made in it.
    fs.mkdirSync(path.join(root, 'blocked'));
    fs.writeFileSync(path.join(root, 'blocked', 'data'), '');
    const res = await hireSeat(req(), { ...deps, dir: path.join(root, 'blocked', 'data') });
    expect(res.ok).toBe(false);
    expect(branches()).toEqual(['main']);
    expect(g(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    const [hash] = fs.readdirSync(path.join(root, 'company-worktrees'));
    expect(fs.existsSync(path.join(root, 'company-worktrees', hash, '.meta', 'dev-4-456789ab'))).toBe(false);
  });

  it('keeps a branch it did not make when the seat\'s branch is already taken', async () => {
    g(repo, 'branch', BRANCH);
    expect((await hireSeat(req(), deps)).ok).toBe(false);
    expect(branches()).toEqual([BRANCH, 'main'].sort());
    expect(g(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });
});
