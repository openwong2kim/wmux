// ─── J1 reboot survival demo (§0 — single task round-trip + worktree fs check) ──────────
//
// Reproduce §0 success criteria with real git repo + real worktree + real AppendOnlyLog:
//   mission.start → worktree create (real git) → task.update materialization → daemon restart
//   simulation (service recreate + boot replay) → projection restored (open·fields retained)
//   + worktree on-disk existence (fs.existsSync check) + mission channel active.
//
// scripts/j1-reboot-survival-demo.mjs drives this spec. Passing here is the reboot
// survival demo verdict formula.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { WorkTaskService } from '../WorkTaskService';
import type { WorkTaskChannelPort } from '../WorkTaskService';
import { TaskWorktreeManager } from '../../../main/worktask/TaskWorktreeManager';
import { missionTopicFor } from '../../../shared/workTask';

let logDir: string;
let repoRoot: string;
let wtRoot: string;

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-j1demo-log-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-j1demo-repo-'));
  wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-j1demo-wt-'));
  // Init real git repo + first commit (worktree add needs HEAD).
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'demo@wmux.test']);
  git(['config', 'user.name', 'demo']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# demo\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
});
afterEach(() => {
  for (const d of [logDir, repoRoot, wtRoot]) fs.rmSync(d, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir: logDir, fsync: () => {} });
  log.open();
  return log;
}

// Minimal channel port — in-memory active/archived tracking instead of real ChannelService
// (demo only needs to check channel active status).
function makeChannelPort() {
  const channels = new Map<string, { id: string; topic?: string; status: 'active' | 'archived'; createdByWorkspaceId?: string }>();
  let seq = 0;
  const port: WorkTaskChannelPort = {
    create: vi.fn(async (params) => {
      const id = `ch-${++seq}`;
      channels.set(id, {
        id,
        ...(params.topic !== undefined ? { topic: params.topic } : {}),
        status: 'active',
        createdByWorkspaceId: params.createdBy.workspaceId,
      });
      return { ok: true as const, channel: { id } };
    }),
    archive: vi.fn(async (params) => {
      const ch = channels.get(params.channelId);
      if (!ch) return { ok: false as const, error: { code: 'CHANNEL_NOT_FOUND', message: 'nf' } };
      ch.status = 'archived';
      return { ok: true as const };
    }),
    listAllForReconcile: () => [...channels.values()].map((c) => ({ ...c })),
  };
  return { port, channels };
}

describe('J1 §0 reboot survival round-trip (demo)', () => {
  it('mission.start → real worktree → task.update → restart replay → fields survive + worktree fs exists + channel active', async () => {
    const { port, channels } = makeChannelPort();
    const svc = new WorkTaskService({
      log: newLog(),
      channels: port,
      origin: { machineId: 'm-demo', daemonEpoch: 1 },
      realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
    });
    await svc.boot();

    // ① mission.start
    const started = await svc.startMission({ title: 'Reboot demo task', verifiedWorkspaceId: 'ws-ceo', memberId: 'ceo' });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('start failed');
    const { taskId, channelId } = started;
    expect(channels.get(channelId)?.topic).toBe(missionTopicFor(taskId));

    // ② Real worktree create (TaskWorktreeManager — cannot inject wtRoot as dedicated root,
    //    so create via git directly but path·branch match manager derivation rules).
    const taskSlug = 'reboot-demo-task-' + taskId.slice(-8);
    const worktreePath = path.join(wtRoot, taskSlug);
    const branch = `wtask/${taskSlug}`;
    const mgr = new TaskWorktreeManager();
    const created = await mgr.createWorktree({
      repoRoot,
      repoHash: 'demohash',
      taskSlug,
      worktreePath,
      branch,
      metaDir: path.join(wtRoot, '.meta', taskSlug),
    });
    expect(created.ok).toBe(true);
    // On-disk existence check (§0 — conditions script captures and verifies).
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);

    // ③ task.update — materialization ({branch, worktreePath, paneGroupId=workspaceId}).
    const workspaceId = 'ws-task-1';
    const updated = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-ceo',
      branch,
      worktreePath,
      paneGroupId: workspaceId,
    });
    expect(updated.ok).toBe(true);

    // ④ Daemon restart simulation — recreate service on same log·channels + boot replay.
    const svc2 = new WorkTaskService({
      log: newLog(),
      channels: port,
      origin: { machineId: 'm-demo', daemonEpoch: 1 },
      realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
    });
    await svc2.boot();

    // Verify: projection restored (open·fields retained).
    const t = svc2.getTask(taskId);
    expect(t?.status).toBe('open');
    expect(t?.branch).toBe(branch);
    expect(t?.worktreePath).toBe(worktreePath);
    expect(t?.paneGroupId).toBe(workspaceId);

    // Verify: worktree on-disk existence (after restart too).
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Verify: mission channel active.
    expect(channels.get(channelId)?.status).toBe('active');
  });
});
