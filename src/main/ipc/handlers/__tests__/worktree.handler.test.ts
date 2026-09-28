// worktree:list / add / remove 핸들러 테스트 — 실제 임시 git repo로 왕복 검증.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync, appendFileSync, cpSync } from 'node:fs';
import os from 'node:os';
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

// Each git spawn costs 100 ms+ on the Windows runner, so the base repo (and the
// bare "origin" the remote-only test fetches from) is built once; every test
// gets a byte copy of the repo. The copied index carries the template's stat
// data, so it is refreshed once — otherwise git reads a.txt as modified.
let templateBase: string;
let templateRepo: string;
let templateRemote: string;

function buildTemplates(): void {
  templateBase = realpathSync.native(mkdtempSync(join(os.tmpdir(), 'wmux-wth-tpl-')));
  templateRepo = join(templateBase, 'repo');
  mkdirSync(templateRepo);
  g(templateRepo, ['init', '-q', '-b', 'main']);
  appendFileSync(join(templateRepo, '.git', 'config'), '[user]\n\temail = t@t\n\tname = t\n');
  writeFileSync(join(templateRepo, 'a.txt'), 'a\n');
  g(templateRepo, ['add', '-A']);
  g(templateRepo, ['commit', '-q', '-m', 'base']);
}

function buildTemplateRemote(): void {
  // Mimics an origin that has feat/remote at main's commit. Tests only fetch
  // from it, so one shared bare repo is safe.
  templateRemote = join(templateBase, 'remote.git');
  g(templateBase, ['clone', '-q', '--bare', templateRepo, templateRemote]);
  g(templateRemote, ['branch', 'feat/remote', 'main']);
}

function makeRepo(): { base: string; repo: string; cleanup: () => void } {
  // realpathSync.native로 8.3 단축폼(CI Windows RUNNER~1)을 롱폼으로 정규화 —
  // 핸들러가 git canonical 경로 기준으로 파생·비교하므로 fixture도 맞춰야 한다.
  const base = realpathSync.native(mkdtempSync(join(os.tmpdir(), 'wmux-wth-')));
  const repo = join(base, 'repo');
  cpSync(templateRepo, repo, { recursive: true });
  g(repo, ['update-index', '-q', '--refresh']);
  return { base, repo, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

type ListRes = { ok: boolean; repoPath?: string; worktrees?: WorktreeEntry[]; error?: string };
type MutRes = { ok: boolean; worktreePath?: string; error?: string };

describe('worktree.handler — list/add/remove 왕복', () => {
  let scn: ReturnType<typeof makeRepo>;
  // Separate hooks so no single hook's 10 s budget has to cover every spawn.
  beforeAll(buildTemplates);
  beforeAll(buildTemplateRemote);
  afterAll(() => rmSync(templateBase, { recursive: true, force: true }));
  beforeEach(() => {
    captured.clear();
    registerWorktreeHandlers();
    scn = makeRepo();
  });
  afterEach(() => scn.cleanup());

  it('add(새 브랜치) → list에 나타남 → remove → list에서 사라짐', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;

    const a = (await add({}, scn.repo, 'feat/x')) as MutRes;
    expect(a.ok).toBe(true);
    // 관례 위치: <repo부모>/<repo이름>-worktrees/<branch-dir>.
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

  it('add — 기존 브랜치는 -b 없이 체크아웃', async () => {
    g(scn.repo, ['branch', 'existing']);
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const a = (await add({}, scn.repo, 'existing')) as MutRes;
    expect(a.ok).toBe(true);
    const head = g(a.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    expect(head).toBe('existing');
  });

  it('add — 위험 브랜치명(-플래그·traversal) fail-soft 거부', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    for (const bad of ['--force', 'a..b', 'a b']) {
      const r = (await add({}, scn.repo, bad)) as MutRes;
      expect(r.ok).toBe(false);
    }
  });

  it('remove — dirty 워크트리는 git 거부 사유를 그대로 표면화(--force 없음)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const a = (await add({}, scn.repo, 'feat/dirty')) as MutRes;
    writeFileSync(join(a.worktreePath!, 'junk.txt'), 'x\n');
    const r = (await remove({}, scn.repo, a.worktreePath!)) as MutRes;
    expect(r.ok).toBe(false);
    expect(existsSync(a.worktreePath!)).toBe(true); // 워크트리 보존.
  });

  it('remove — 목록에 없는 임의 경로·본 워크트리 거부', async () => {
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const arb = (await remove({}, scn.repo, join(scn.base, 'not-a-worktree'))) as MutRes;
    expect(arb.ok).toBe(false);
    expect(arb.error).toContain('not a listed worktree');
    const main = (await remove({}, scn.repo, scn.repo)) as MutRes;
    expect(main.ok).toBe(false);
    expect(main.error).toContain('main worktree');
  });

  it('list — linked worktree 컨텍스트에서도 mainPath는 본 repo(dogfood 회귀)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const a = (await add({}, scn.repo, 'feat/ctx')) as MutRes;
    expect(a.ok).toBe(true);
    // 링크드 워크트리 "안에서" 목록을 열면: repoPath=자기 자신, mainPath=본 repo.
    const r = (await list({}, a.worktreePath!)) as ListRes & { mainPath?: string };
    expect(r.ok).toBe(true);
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    expect(norm(r.repoPath!)).toBe(norm(a.worktreePath!));
    expect(norm(r.mainPath!)).toBe(norm(scn.repo));
    // 본 워크트리 remove는 어느 컨텍스트에서도 거부.
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const m = (await remove({}, a.worktreePath!, scn.repo)) as MutRes;
    expect(m.ok).toBe(false);
    expect(m.error).toContain('main worktree');
  });

  it('remove — 활성(호출 컨텍스트) 워크트리는 clean이어도 거부(Codex P2)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const a = (await add({}, scn.repo, 'feat/active')) as MutRes;
    // 그 워크트리 "안에서"(repoPath=자기 자신) 자기 자신을 지우려 하면 거부.
    const r = (await remove({}, a.worktreePath!, a.worktreePath!)) as MutRes;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('currently in');
    expect(existsSync(a.worktreePath!)).toBe(true);
  });

  it('add — linked worktree 컨텍스트에서도 경로는 본 repo 기준으로 도출(Codex P2)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const a = (await add({}, scn.repo, 'feat/first')) as MutRes;
    // 첫 워크트리 "안에서" 두 번째 생성 — 경로는 <linked>-worktrees가 아니라
    // 본 repo의 형제 <repo>-worktrees여야 한다.
    const b = (await add({}, a.worktreePath!, 'feat/second')) as MutRes;
    expect(b.ok).toBe(true);
    expect(dirname(b.worktreePath!)).toBe(join(dirname(scn.repo), `${basename(scn.repo)}-worktrees`));
  });

  it('add — remote-only 브랜치는 origin 추적 로컬 브랜치로 체크아웃(Codex P2)', async () => {
    // The shared bare origin already has feat/remote; locally it is remote-only.
    g(scn.repo, ['remote', 'add', 'origin', templateRemote]);
    g(scn.repo, ['fetch', '-q', 'origin']);
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const a = (await add({}, scn.repo, 'feat/remote')) as MutRes;
    expect(a.ok).toBe(true);
    // 새 로컬 브랜치가 origin/feat/remote를 upstream으로 추적해야 한다.
    const upstream = g(a.worktreePath!, ['rev-parse', '--abbrev-ref', 'feat/remote@{upstream}']).trim();
    expect(upstream).toBe('origin/feat/remote');
  });

  it('list — 비-git 경로는 fail-soft', async () => {
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const plain = join(scn.base, 'plain');
    mkdirSync(plain);
    const r = (await list({}, plain)) as ListRes;
    expect(r.ok).toBe(false);
  });

  it('list — 서브디렉토리 경로도 toplevel로 정규화해 성공', async () => {
    mkdirSync(join(scn.repo, 'sub'));
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const r = (await list({}, join(scn.repo, 'sub'))) as ListRes;
    expect(r.ok).toBe(true);
    expect(r.worktrees!.length).toBeGreaterThanOrEqual(1);
  });

  it('F2 (#615) — a valid repo under home .ssh is still confine-rejected', async () => {
    // Verifies resolveToplevel actually routes through fs.handler's sensitive-path
    // blocklist. Relocate home to the test base, make <home>/.ssh/repo a real git
    // repo, and assert the handler fail-softs despite it being a valid repo — the
    // regression guard for the gap where an unconfined repoPath ran `git -C <path>`.
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(scn.base);
    try {
      const sshRepo = join(scn.base, '.ssh', 'repo');
      mkdirSync(dirname(sshRepo), { recursive: true });
      mkdirSync(sshRepo);
      g(sshRepo, ['init', '-q', '-b', 'main']);
      const list = captured.get(IPC.WORKTREE_LIST)!;
      const r = (await list({}, sshRepo)) as ListRes;
      expect(r.ok).toBe(false);
    } finally {
      homeSpy.mockRestore();
    }
  });
});
