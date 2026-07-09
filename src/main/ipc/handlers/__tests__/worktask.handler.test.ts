// J3 worktask 핸들러 — refire(§3·F2·F7) + owner 스코프 close(F1 E2E) + disk-missing
// close(F3). electron ipcMain을 캡처해 핸들러를 직접 호출한다(diff.handler.test.ts 패턴).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { IPC } from '../../../../shared/constants';
import type { DaemonClient } from '../../../DaemonClient';

async function call(channel: string, payload: unknown): Promise<unknown> {
  const fn = captured.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn({} as unknown, payload);
}

/** rpc(list owner-scoped / close) + writeToSession을 가진 최소 DaemonClient 페이크. */
function makeDaemon(
  tasks: Array<{ id: string; title: string; status: 'open' | 'closed'; owner: string; worktreePath?: string; branch?: string }>,
) {
  const writes: Array<{ sessionId: string; data: string }> = [];
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    rpc: async (method: string, params: Record<string, unknown>) => {
      rpcCalls.push({ method, params });
      if (method === 'task.mission.list') {
        const vws = params.verifiedWorkspaceId;
        return { ok: true, tasks: tasks.filter((t) => t.owner === vws) };
      }
      if (method === 'task.mission.close') return { ok: true, taskId: params.taskId, archivePending: false };
      return { ok: true };
    },
    writeToSession: (sessionId: string, data: string | Buffer) => {
      writes.push({ sessionId, data: typeof data === 'string' ? data : data.toString() });
      return true;
    },
  };
  return { client: client as unknown as DaemonClient, writes, rpcCalls };
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
