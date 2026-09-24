// ─── TaskCloseService — J3 §1 close 순서 계약(remove 성공 → close 커밋) ──────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { TaskCloseService } from '../TaskCloseService';
import type { CloseDaemonPort } from '../TaskCloseService';
import { TaskWorktreeManager } from '../TaskWorktreeManager';

let repoRoot: string;
let wtBase: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd }).toString();
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-close-repo-'));
  wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-close-wt-'));
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 't'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'a\n');
  git(['add', '.'], repoRoot);
  git(['commit', '-q', '-m', 'init'], repoRoot);
});
afterEach(() => {
  for (const d of [repoRoot, wtBase]) fs.rmSync(d, { recursive: true, force: true });
});

function makeDaemon(closeResult?: unknown): { port: CloseDaemonPort; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const port: CloseDaemonPort = {
    rpc: vi.fn(async (method, params) => {
      calls.push({ method, params });
      return closeResult ?? { ok: true, taskId: params['taskId'] };
    }),
  };
  return { port, calls };
}

async function makeWorktree(slug: string): Promise<{ mgr: TaskWorktreeManager; worktreePath: string; metaDir: string }> {
  const mgr = new TaskWorktreeManager();
  const worktreePath = path.join(wtBase, slug);
  const metaDir = path.join(wtBase, '.meta', slug);
  const created = await mgr.createWorktree({
    repoRoot,
    repoHash: 'closehash',
    taskSlug: slug,
    worktreePath,
    branch: `wtask/${slug}`,
    metaDir,
  });
  if (!created.ok) throw new Error(`worktree create failed: ${created.error}`);
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'prompt.md'), 'prompt\n');
  return { mgr, worktreePath, metaDir };
}

describe('J3 §1 close 순서 계약', () => {
  it('clean: remove 성공 → close 커밋 → meta 삭제 (순서 역전 계약)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('clean-task');
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });

    const res = await svc.closeTask({
      taskId: 'wtask-1',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(true);
    // worktree 제거 + meta 삭제 + close RPC 1회.
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(metaDir)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('task.mission.close');
  });

  it('dirty: remove 거부 + close 보류(RPC 0회) + 보존 경로 반환', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('dirty-task');
    fs.writeFileSync(path.join(worktreePath, 'wip.txt'), 'uncommitted\n');
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });

    const res = await svc.closeTask({
      taskId: 'wtask-2',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('dirty');
    expect(res.preservedWorktree).toBe(worktreePath);
    // close 보류 — 태스크는 open 유지(모순 상태 제거).
    expect(calls).toHaveLength(0);
    // 산출물·prompt.md 보존.
    expect(fs.existsSync(path.join(worktreePath, 'wip.txt'))).toBe(true);
    expect(fs.existsSync(metaDir)).toBe(true);
  });

  it('a failed status check is preserved but reported as an error, not as dirty (#1461)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('broken-task');
    // Stub only the remove step with the result removeWorktree returns when its
    // `git status` fails. Corrupting a real `.git` to get there is not portable
    // (Windows refuses to open the hidden `.git` file for writing).
    const removeWorktree = vi.fn(async () => ({
      ok: false as const,
      error: 'removeWorktree: status check failed: fatal: not a git repository',
      preserved: true,
    }));
    const worktrees = Object.assign(Object.create(mgr) as TaskWorktreeManager, { removeWorktree });
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees });

    const res = await svc.closeTask({
      taskId: 'wtask-2b',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('error');
    expect(res.error).toContain('status check failed');
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    // Still nothing removed and nothing closed.
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('미push 커밋: 진행 중단 + unpushed 경고(remove·close 0회)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('ahead-task');
    // 원격이 있어야 경고 게이트가 켜진다(로컬 전용 repo는 오탐 방지로 생략).
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-close-remote-'));
    git(['init', '-q', '--bare'], remoteDir);
    git(['remote', 'add', 'origin', remoteDir], repoRoot);
    // worktree에 커밋 1개(미push).
    fs.writeFileSync(path.join(worktreePath, 'done.txt'), 'work\n');
    git(['add', '.'], worktreePath);
    git(['commit', '-q', '-m', '산출물'], worktreePath);

    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });
    const res = await svc.closeTask({
      taskId: 'wtask-3',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('unpushed');
    expect(res.aheadCount).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(worktreePath)).toBe(true);
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it('미물질화(worktreePath 부재): worktree 단계 건너뛰고 close만', async () => {
    const { port, calls } = makeDaemon();
    const mgr = new TaskWorktreeManager();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });
    const res = await svc.closeTask({ taskId: 'wtask-4', verifiedWorkspaceId: 'ws-owner' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.unmaterialized).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('archivePending: 데몬 응답의 archive 미확정이 결과에 전달된다(CX2)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('pending-task');
    const { port } = makeDaemon({ ok: true, taskId: 'wtask-5', archivePending: true });
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });
    const res = await svc.closeTask({
      taskId: 'wtask-5',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.archivePending).toBe(true);
  });
});
