// J3 worktask 핸들러 — refire(§3·F2·F7) + owner 스코프 close(F1 E2E) + disk-missing
// close(F3). electron ipcMain을 캡처해 핸들러를 직접 호출한다(diff.handler.os.test.ts 패턴).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

import { registerWorktaskHandlers } from '../worktask.handler';
import { forgetBotWorkerSession, noteBotWorkerSession, reloadBotWorkerSessionsForTests, setWorkerMcpResolvers } from '../../../agents/botWorkerMergeGuard';
import { IPC } from '../../../../shared/constants';
import { pendingRemovalRefusal } from '../../../worktask/pendingWorktreeRemovals';
import type { DaemonClient } from '../../../DaemonClient';

async function call(channel: string, payload: unknown): Promise<unknown> {
  const fn = captured.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn({} as unknown, payload);
}

/** rpc(list owner-scoped / close) + writeToSession을 가진 최소 DaemonClient 페이크. */
function makeDaemon(
  tasks: Array<{ id: string; title: string; status: 'open' | 'closed'; owner: string; worktreePath?: string; branch?: string; detachedAt?: number }>,
) {
  const writes: Array<{ sessionId: string; data: string }> = [];
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sessions: Array<{ id: string; cwd?: string; spawnCwd?: string }> = [];
  const trust = { state: 'clear' as 'trust' | 'clear' | 'unknown' };
  const client = {
    folderTrustState: async () => ({ state: trust.state }),
    rpc: async (method: string, params: Record<string, unknown>) => {
      rpcCalls.push({ method, params });
      if (method === 'task.mission.list') {
        const vws = params.verifiedWorkspaceId;
        return { ok: true, tasks: tasks.filter((t) => t.owner === vws) };
      }
      if (method === 'task.mission.close') return { ok: true, taskId: params.taskId, archivePending: false };
      if (method === 'daemon.listSessions') return sessions;
      return { ok: true };
    },
    writeToSession: (sessionId: string, data: string | Buffer) => {
      writes.push({ sessionId, data: typeof data === 'string' ? data : data.toString() });
      return true;
    },
  };
  return { client: client as unknown as DaemonClient, writes, rpcCalls, sessions, trust };
}

let base: string;
let prevUserProfile: string | undefined;
let prevHome: string | undefined;
let prevSuffix: string | undefined;
let dispose: (() => void) | undefined;
let daemon: ReturnType<typeof makeDaemon>;

beforeEach(() => {
  captured.clear();
  base = mkdtempSync(join(tmpdir(), 'wmux-wth-'));
  // getWmuxHomeDir()가 {base}/.wmux로 해석되도록 홈 env를 임시 지정(F7 전용 루트 검증).
  prevUserProfile = process.env.USERPROFILE;
  prevHome = process.env.HOME;
  prevSuffix = process.env.WMUX_DATA_SUFFIX;
  process.env.USERPROFILE = base;
  process.env.HOME = base;
  delete process.env.WMUX_DATA_SUFFIX;
});
afterEach(() => {
  dispose?.();
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
  else process.env.WMUX_DATA_SUFFIX = prevSuffix;
  rmSync(base, { recursive: true, force: true });
});

/** {base}/.wmux/worktrees/{repoHash}/{slug}(+ sibling .meta/{slug}/prompt.md)를 만든다. */
function seedWorktree(slug: string, withPrompt: boolean): string {
  const root = join(base, '.wmux', 'worktrees', 'repohash');
  const worktreePath = join(root, slug);
  mkdirSync(worktreePath, { recursive: true });
  if (withPrompt) {
    const metaDir = join(root, '.meta', slug);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, 'prompt.md'), 'do the thing', 'utf8');
  }
  return worktreePath;
}

describe('worktask:refire (§3·F2 — 원래 initialCommand 재전송)', () => {
  it('prompt.md 존재 + 전용 루트 하위면 sanitize된 initialCommand를 writeToSession으로 재전송', async () => {
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const wt = seedWorktree('task-a', true);
    const res = (await call(IPC.WORKTASK_REFIRE, {
      ptyId: 'pty-1',
      worktreePath: wt,
      initialCommand: 'claude "$(cat \'/x/prompt.md\')"',
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(daemon.writes).toHaveLength(1);
    expect(daemon.writes[0].sessionId).toBe('pty-1');
    expect(daemon.writes[0].data).toContain('claude');
    expect(daemon.writes[0].data.endsWith('\r')).toBe(true);
  });

  it('types nothing at a folder-trust prompt and says why; a screen it cannot read does not stop a re-fire a person asked for', async () => {
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const wt = seedWorktree('task-trust', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    daemon.trust.state = 'trust';
    const refused = (await call(IPC.WORKTASK_REFIRE, { ptyId: 'pty-1', worktreePath: wt, initialCommand: 'claude "go"' })) as { ok: boolean; error?: string };
    expect(refused).toEqual({ ok: false, error: 'worktask:refire: the pane is on a folder-trust prompt; answer it in the pane' });
    expect(daemon.writes).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('[folder-trust] refused task re-fire line on pane pty-1: folder-trust trust');
    daemon.trust.state = 'unknown';
    expect(((await call(IPC.WORKTASK_REFIRE, { ptyId: 'pty-1', worktreePath: wt, initialCommand: 'claude "go"' })) as { ok: boolean }).ok).toBe(true);
    expect(daemon.writes).toHaveLength(1);
    warn.mockRestore();
    // Asked before a launch of the task is recorded.
    const src = readFileSync(join(__dirname, '..', 'worktask.handler.ts'), 'utf8');
    expect(src.indexOf("folderTrustLaunchRefusal(dc, ptyId, 'task re-fire line'")).toBeLessThan(src.indexOf('beginPaneRelaunch(ptyId)'));
  });

  it('re-fires a bot worker\'s launch line with the merge-lane guard after a restart, or types nothing', async () => {
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const wt = seedWorktree('task-bot', true);
    reloadBotWorkerSessionsForTests();
    noteBotWorkerSession('pty-bot', 'ws-task', undefined, { cwd: wt });
    daemon.sessions.push({ id: 'pty-bot', cwd: wt, spawnCwd: wt });
    setWorkerMcpResolvers({ entry: () => '/opt/wmux/mcp/index.js', registeredLevel: () => null });
    // The app restarts between the spawn and the re-fire: only the durable record knows the pane.
    reloadBotWorkerSessionsForTests();
    try {
      const ok = (await call(IPC.WORKTASK_REFIRE, { ptyId: 'pty-bot', worktreePath: wt, initialCommand: 'claude "$(cat \'/x/prompt.md\')"' })) as { ok: boolean };
      expect(ok.ok).toBe(true);
      expect(daemon.writes[0].data).toMatch(/^claude --settings="[^"]*factory[\\/]worker-settings[\\/][0-9a-f]{12}\.json" --mcp-config="[^"]*factory[\\/]worker-mcp[\\/][0-9a-f]{12}\.json" --strict-mcp-config /);
      const refused = (await call(IPC.WORKTASK_REFIRE, { ptyId: 'pty-bot', worktreePath: wt, initialCommand: 'codex "$(cat \'/x/prompt.md\')"' })) as { ok: boolean; error?: string };
      expect(refused.ok).toBe(false);
      // A codex line in a bot worker's pane is re-fired only for a guarded codex launch on record.
      expect(refused.error).toMatch(/worktask:refire: a bot's codex worker was not launched: this pane has no guarded codex launch on record/);
      expect(daemon.writes).toHaveLength(1);
    } finally {
      forgetBotWorkerSession('pty-bot');
      reloadBotWorkerSessionsForTests();
    }
  });

  it('prompt.md 소실이면 재발사 거부(원문 프롬프트를 흘리지 않음)', async () => {
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const wt = seedWorktree('task-b', false); // prompt.md 없음.
    const res = (await call(IPC.WORKTASK_REFIRE, { ptyId: 'p', worktreePath: wt, initialCommand: 'claude x' })) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('소실');
    expect(daemon.writes).toHaveLength(0);
  });

  it('F7 — 전용 루트 밖 worktreePath는 거부(경로 오라클 차단)', async () => {
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const outside = join(base, 'not-worktrees', 'evil');
    mkdirSync(outside, { recursive: true });
    const res = (await call(IPC.WORKTASK_REFIRE, { ptyId: 'p', worktreePath: outside, initialCommand: 'claude x' })) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('전용 루트');
    expect(daemon.writes).toHaveLength(0);
  });

  it('필수 필드 누락은 형태 에러', async () => {
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const res = (await call(IPC.WORKTASK_REFIRE, { ptyId: 'p' })) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('F7 — `..` 트래버설로 루트를 탈출하는 worktreePath는 거부(prefix 검사 우회 차단)', async () => {
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    // 문자열 prefix로는 루트 하위처럼 보이지만 resolve하면 밖으로 나가는 경로.
    // join()은 `..`를 미리 접으므로 원시 문자열로 구성해야 우회가 재현된다.
    const traversal = `${join(base, 'worktrees')}/../../escaped`;
    mkdirSync(join(base, '..', 'escaped'), { recursive: true });
    const res = (await call(IPC.WORKTASK_REFIRE, { ptyId: 'p', worktreePath: traversal, initialCommand: 'claude x' })) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('전용 루트');
    expect(daemon.writes).toHaveLength(0);
  });
});

describe('task:close owner 스코프(F1 E2E — 자식 실패·owner 성공)', () => {
  it('자식 ws id로는 태스크를 못 찾아 실패, owner ws id로는 close 성공', async () => {
    // 태스크는 owner='parent-ws'가 소유(자식 태스크 ws는 'child-ws'). worktreePath
    // 부재라 close-only 경로로 단순화.
    daemon = makeDaemon([{ id: 'wtask-1', title: 'T', status: 'open', owner: 'parent-ws' }]);
    dispose = registerWorktaskHandlers(() => daemon.client);

    // 자식 ws id → listMissions(child-ws)는 빈 목록 → resolve 실패.
    const childRes = (await call(IPC.TASK_CLOSE, { taskId: 'wtask-1', verifiedWorkspaceId: 'child-ws' })) as {
      ok: boolean;
      reason?: string;
    };
    expect(childRes.ok).toBe(false);
    expect(childRes.reason).toBe('error');
    expect(daemon.rpcCalls.find((c) => c.method === 'task.mission.close')).toBeUndefined();

    // owner ws id → 찾음 → close-only 성공.
    const ownerRes = (await call(IPC.TASK_CLOSE, { taskId: 'wtask-1', verifiedWorkspaceId: 'parent-ws' })) as { ok: boolean };
    expect(ownerRes.ok).toBe(true);
    const closeCall = daemon.rpcCalls.find((c) => c.method === 'task.mission.close');
    expect(closeCall?.params.verifiedWorkspaceId).toBe('parent-ws');
  });
});

describe('task:close disk-missing 라우팅(F3)', () => {
  it('worktreePath가 디스크에 없으면 remove를 건너뛰고 close-only로 정합화', async () => {
    const ghost = join(base, '.wmux', 'worktrees', 'repohash', 'ghost'); // 생성하지 않음.
    daemon = makeDaemon([{ id: 'wtask-2', title: 'G', status: 'open', owner: 'parent-ws', worktreePath: ghost, branch: 'wtask/g' }]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const res = (await call(IPC.TASK_CLOSE, { taskId: 'wtask-2', verifiedWorkspaceId: 'parent-ws' })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(daemon.rpcCalls.filter((c) => c.method === 'task.mission.close')).toHaveLength(1);
  });
});

// #2388: a folder whose removal did not finish is locked against new panes
// while the handlers run; a close of its task whose repository is gone (it
// can never be checked again) closes, keeps the folder and ends the lock.
describe('task:close of a half-removed folder whose repository is gone', () => {
  it('closes the task, keeps the folder and its files, and unlocks it', async () => {
    const wt = seedWorktree('task-gone', false);
    writeFileSync(join(wt, 'held.txt'), 'x', 'utf8');
    mkdirSync(join(base, '.wmux', 'worktask'), { recursive: true });
    writeFileSync(
      join(base, '.wmux', 'worktask', 'pending-removals.json'),
      JSON.stringify({ version: 1, removals: [{ path: wt, repoRoot: join(base, 'moved-away'), repoHash: 'repohash', at: 1 }] }),
      'utf8',
    );
    daemon = makeDaemon([{ id: 'wtask-g', title: 'G', status: 'open', owner: 'parent-ws', worktreePath: wt, branch: 'wtask/g' }]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    expect(pendingRemovalRefusal(wt)).toMatch(/removal did not finish/);
    const res = (await call(IPC.TASK_CLOSE, { taskId: 'wtask-g', verifiedWorkspaceId: 'parent-ws' })) as { ok: boolean; keptFolder?: string };
    expect(res).toMatchObject({ ok: true, keptFolder: wt });
    expect(readFileSync(join(wt, 'held.txt'), 'utf8')).toBe('x');
    expect(daemon.rpcCalls.filter((c) => c.method === 'task.mission.close')).toHaveLength(1);
    expect(daemon.rpcCalls.some((c) => c.method === 'daemon.destroySession')).toBe(false);
    expect(pendingRemovalRefusal(wt)).toBeNull();
  });

  it('the lock ends with the handlers', async () => {
    const wt = seedWorktree('task-locked', false);
    mkdirSync(join(base, '.wmux', 'worktask'), { recursive: true });
    writeFileSync(
      join(base, '.wmux', 'worktask', 'pending-removals.json'),
      JSON.stringify({ version: 1, removals: [{ path: wt, repoRoot: join(base, 'repo'), repoHash: 'repohash', at: 1 }] }),
      'utf8',
    );
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    expect(pendingRemovalRefusal(join(wt, 'src'))).not.toBeNull();
    dispose();
    dispose = undefined;
    expect(pendingRemovalRefusal(wt)).toBeNull();
  });
});

// #2388: Close and keep folder — the task closes, its folder stays as it is,
// and the folder's pending removal (the lock against new panes) ends.
describe('task:close keepFolder', () => {
  it('closes the task, keeps the folder and its files, and unlocks it', async () => {
    const wt = seedWorktree('task-keep', false);
    writeFileSync(join(wt, 'held.txt'), 'x', 'utf8');
    const file = join(base, '.wmux', 'worktask', 'pending-removals.json');
    mkdirSync(join(base, '.wmux', 'worktask'), { recursive: true });
    // Its repository is there: only keepFolder closes the task.
    mkdirSync(join(base, 'repo'), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, removals: [{ path: wt, repoRoot: join(base, 'repo'), repoHash: 'repohash', at: 1 }] }), 'utf8');
    daemon = makeDaemon([{ id: 'wtask-k', title: 'K', status: 'open', owner: 'parent-ws', worktreePath: wt, branch: 'wtask/k' }]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    expect(pendingRemovalRefusal(wt)).not.toBeNull();
    const res = (await call(IPC.TASK_CLOSE, { taskId: 'wtask-k', verifiedWorkspaceId: 'parent-ws', keepFolder: true })) as { ok: boolean; keptFolder?: string };
    expect(res).toMatchObject({ ok: true, keptFolder: wt });
    expect(readFileSync(join(wt, 'held.txt'), 'utf8')).toBe('x');
    expect(daemon.rpcCalls.filter((c) => c.method === 'task.mission.close')).toHaveLength(1);
    expect(daemon.rpcCalls.some((c) => c.method === 'daemon.destroySession')).toBe(false);
    expect(pendingRemovalRefusal(wt)).toBeNull();
  });

  it('a detached task (kept earlier, even before a restart) only closes: its folder stays', async () => {
    const wt = seedWorktree('task-detached', false);
    daemon = makeDaemon([{ id: 'wtask-d', title: 'D', status: 'closed', owner: 'parent-ws', worktreePath: wt, branch: 'wtask/d', detachedAt: 1 }]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const res = (await call(IPC.TASK_CLOSE, { taskId: 'wtask-d', verifiedWorkspaceId: 'parent-ws' })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(daemon.rpcCalls.some((c) => c.method === 'daemon.listSessions' || c.method === 'daemon.destroySession')).toBe(false);
  });
});

describe('worktask:sweep-company-seats', () => {
  it('refuses a malformed keep set, and answers at once when there is no seat folder', async () => {
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    expect(await call(IPC.WORKTASK_SWEEP_COMPANY_SEATS, { keep: ['/a', 1] })).toEqual({ ok: false, error: 'invalid request' });
    expect(await call(IPC.WORKTASK_SWEEP_COMPANY_SEATS, {})).toEqual({ ok: false, error: 'invalid request' });
    expect(await call(IPC.WORKTASK_SWEEP_COMPANY_SEATS, { keep: ['/a'] })).toEqual({ ok: true, run: 1, removed: 0 });
    expect(daemon.rpcCalls.some((c) => c.method === 'daemon.listSessions')).toBe(false);
  });
});

describe('company seat worktrees in the cleanup list', () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

  /** A repository with one seat worktree, made an hour ago, holding a file git does not track. */
  function seedSeat(): { repo: string; seat: string } {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
    const hash = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 12);
    const seat = join(base, '.wmux', 'company-worktrees', hash, 'dev-1-456789ab');
    gitIn(repo, 'worktree', 'add', '-q', '-b', 'company/dev-1-456789ab', seat);
    writeFileSync(join(seat, 'notes.txt'), 'mine');
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(seat, anHourAgo, anHourAgo);
    return { repo, seat };
  }

  it('worktask:scan lists a seat with changes, unless the renderer keeps it or sent no keep set', async () => {
    const { seat } = seedSeat();
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    const listed = (await call(IPC.WORKTASK_SCAN, { verifiedWorkspaceId: 'ws', keep: [] })) as { entries: unknown[] };
    expect(listed.entries).toEqual([expect.objectContaining({
      category: 'company-seat', title: 'dev-1-456789ab', worktreePath: realpathSync.native(seat), detailCode: 'seat-uncommitted',
    })]);
    expect(((await call(IPC.WORKTASK_SCAN, { verifiedWorkspaceId: 'ws', keep: [seat] })) as { entries: unknown[] }).entries).toEqual([]);
    expect(((await call(IPC.WORKTASK_SCAN, { verifiedWorkspaceId: 'ws' })) as { entries: unknown[] }).entries).toEqual([]);
    expect(existsSync(join(seat, 'notes.txt'))).toBe(true);
  });

  it('removes only a seat-shaped folder, and deletes only that seat\'s company branch', async () => {
    const { repo, seat } = seedSeat();
    const phone = join(base, '.wmux', 'worktrees', 'abc123def456', 'phone-x');
    mkdirSync(phone, { recursive: true });
    daemon = makeDaemon([]);
    dispose = registerWorktaskHandlers(() => daemon.client);
    for (const other of [repo, phone, join(seat, '..'), join(seat, '..', '.meta')]) {
      expect(await call(IPC.WORKTASK_REMOVE_COMPANY_SEAT, { worktreePath: other, force: true })).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(existsSync(phone)).toBe(true);
    for (const branch of ['main', 'company/dev-2-456789ab', 'dev-1-456789ab']) {
      expect(await call(IPC.WORKTASK_DELETE_COMPANY_SEAT_BRANCH, { worktreePath: seat, repo, branch, oid: 'a'.repeat(40) })).toEqual({ ok: false, error: "not this seat's branch" });
    }
    expect(await call(IPC.WORKTASK_DELETE_COMPANY_SEAT_BRANCH, { worktreePath: repo, repo, branch: 'company/dev-1-456789ab', oid: 'a'.repeat(40) })).toEqual({ ok: false, error: "not this seat's branch" });

    expect(await call(IPC.WORKTASK_REMOVE_COMPANY_SEAT, { worktreePath: seat, force: false })).toEqual({ ok: false, reason: 'dirty' });
    const removed = (await call(IPC.WORKTASK_REMOVE_COMPANY_SEAT, { worktreePath: seat, force: true })) as { ok: boolean; branch?: string; repo?: string; oid?: string };
    expect(removed).toMatchObject({ ok: true, branch: 'company/dev-1-456789ab', oid: gitIn(repo, 'rev-parse', 'company/dev-1-456789ab') });
    expect(existsSync(seat)).toBe(false);
    // A branch that gained a commit after the question was asked stays.
    gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'later');
    gitIn(repo, 'branch', '-f', 'company/dev-1-456789ab', 'main');
    expect(await call(IPC.WORKTASK_DELETE_COMPANY_SEAT_BRANCH, { worktreePath: seat, repo: removed.repo, branch: removed.branch, oid: removed.oid }))
      .toEqual({ ok: false, error: 'the branch moved since; it was kept' });
    expect(gitIn(repo, 'branch', '--format=%(refname:short)')).toContain('company/dev-1-456789ab');
    const now = gitIn(repo, 'rev-parse', 'company/dev-1-456789ab');
    expect(await call(IPC.WORKTASK_DELETE_COMPANY_SEAT_BRANCH, { worktreePath: seat, repo: removed.repo, branch: removed.branch, oid: now })).toEqual({ ok: true });
    expect(gitIn(repo, 'branch', '--format=%(refname:short)')).toBe('main');
  });
});
