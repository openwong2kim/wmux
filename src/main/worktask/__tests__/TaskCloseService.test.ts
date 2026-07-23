// ─── TaskCloseService — J3 §1 close ordering contract (remove success → close commit) ──────

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

describe('J3 §1 close order contract', () => {
  it('clean: remove success → close commit → meta delete (order inversion contract)', async () => {
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
    // worktree remove + meta delete + close RPC once.
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(metaDir)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('task.mission.close');
  });

  it('dirty: remove rejected + close deferred (0 RPC) + preserve path returned', async () => {
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
    // close deferred — task stays open (contradictory state removed).
    expect(calls).toHaveLength(0);
    // deliverables·prompt.md preserved.
    expect(fs.existsSync(path.join(worktreePath, 'wip.txt'))).toBe(true);
    expect(fs.existsSync(metaDir)).toBe(true);
  });

  it('unpushed commits: abort progress + unpushed warning (0 remove·close)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('ahead-task');
    // remotes must exist for warning gate (local-only repo skipped to avoid false positives).
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-close-remote-'));
    git(['init', '-q', '--bare'], remoteDir);
    git(['remote', 'add', 'origin', remoteDir], repoRoot);
    // one unpushed commit on worktree.
    fs.writeFileSync(path.join(worktreePath, 'done.txt'), 'work\n');
    git(['add', '.'], worktreePath);
    git(['commit', '-q', '-m', 'artifact'], worktreePath);

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

  it('unmaterialized (missing worktreePath): skip worktree step, close only', async () => {
    const { port, calls } = makeDaemon();
    const mgr = new TaskWorktreeManager();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });
    const res = await svc.closeTask({ taskId: 'wtask-4', verifiedWorkspaceId: 'ws-owner' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.unmaterialized).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('archivePending: unconfirmed archive from daemon response passed through (CX2)', async () => {
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
