// ─── J3 fleet reboot survival demo (§5(a) — fanout N=4 round-trip, hard gate verdict) ────
//
// Fleet extension of J1 single-task demo (j1-reboot-survival.demo.test.ts). Reproduce §5(a)
// script demo scope with real git repo + 4 real worktrees + real AppendOnlyLog:
//   mission.start ×4 → worktree ×4 (real git) → artifact seeding (uncommitted change per worktree)
//   → task.update materialization ×4 → daemon restart simulation (service recreate +
//   boot replay) → **full daemon state restore**: 4 tasks open·materialized fields retained /
//   4 worktrees fs existence + artifact files retained / 4 mission channels active.
//
// Demo scope discipline (§5 — review G7+CL7): this verdict formula demonstrates **daemon state** only.
// Workspace·pane restore (session.json/renderer path) is manual scenario doc scope;
// do not claim "workspace survival" based on this test PASS.
//
// scripts/j3-fleet-reboot-survival-demo.mjs drives this spec.

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

const FLEET_N = 4;

let logDir: string;
let repoRoot: string;
let wtRoot: string;

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-j3demo-log-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-j3demo-repo-'));
  wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-j3demo-wt-'));
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

// Minimal channel port (same harness as J1 demo — active/archived tracking only).
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

function newSvc(port: WorkTaskChannelPort): WorkTaskService {
  return new WorkTaskService({
    log: newLog(),
    channels: port,
    origin: { machineId: 'm-fleet-demo', daemonEpoch: 1 },
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
  });
}

describe('J3 §5(a) fleet reboot survival round-trip (demo verdict)', () => {
  it(`fanout N=${FLEET_N} → seed artifacts → restart replay → full daemon state restore`, async () => {
    const { port, channels } = makeChannelPort();
    const svc = newSvc(port);
    await svc.boot();

    const mgr = new TaskWorktreeManager();
    const fleet: Array<{
      taskId: string;
      channelId: string;
      branch: string;
      worktreePath: string;
      workspaceId: string;
      artifactPath: string;
    }> = [];

    // ①~③ Fleet spawn: mission.start → real worktree → artifact seeding → materialization.
    for (let k = 0; k < FLEET_N; k++) {
      const started = await svc.startMission({
        title: `Fleet task #${k + 1}`,
        verifiedWorkspaceId: 'ws-ceo',
        memberId: 'ceo',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(`start #${k} failed`);
      const { taskId, channelId } = started;
      expect(channels.get(channelId)?.topic).toBe(missionTopicFor(taskId));

      const taskSlug = `fleet-task-${k + 1}-${taskId.slice(-8)}`;
      const worktreePath = path.join(wtRoot, taskSlug);
      const branch = `wtask/${taskSlug}`;
      const created = await mgr.createWorktree({
        repoRoot,
        repoHash: 'fleethash',
        taskSlug,
        worktreePath,
        branch,
        metaDir: path.join(wtRoot, '.meta', taskSlug),
      });
      expect(created.ok).toBe(true);

      // Artifact seeding: simulate agent work — uncommitted change (§5(a) "artifact seeding").
      const artifactPath = path.join(worktreePath, `artifact-${k + 1}.txt`);
      fs.writeFileSync(artifactPath, `fleet artifact ${k + 1}\n`);

      const workspaceId = `ws-task-${k + 1}`;
      const updated = await svc.updateMission({
        taskId,
        verifiedWorkspaceId: 'ws-ceo',
        branch,
        worktreePath,
        paneGroupId: workspaceId,
      });
      expect(updated.ok).toBe(true);

      fleet.push({ taskId, channelId, branch, worktreePath, workspaceId, artifactPath });
    }

    // ④ Daemon restart simulation — recreate service on same log·channels + replay.
    const svc2 = newSvc(port);
    await svc2.boot();

    // ⑤ Verify: full daemon state restore (all N=4 — any gap fails fleet survival).
    for (const m of fleet) {
      // projection: open + materialized fields retained.
      const t = svc2.getTask(m.taskId);
      expect(t?.status).toBe('open');
      expect(t?.branch).toBe(m.branch);
      expect(t?.worktreePath).toBe(m.worktreePath);
      expect(t?.paneGroupId).toBe(m.workspaceId);
      // worktree on-disk existence + uncommitted artifact retained (restart must not touch artifacts).
      expect(fs.existsSync(m.worktreePath)).toBe(true);
      expect(fs.existsSync(path.join(m.worktreePath, '.git'))).toBe(true);
      expect(fs.readFileSync(m.artifactPath, 'utf8')).toContain('fleet artifact');
      // mission channel active.
      expect(channels.get(m.channelId)?.status).toBe('active');
    }

    // Mutual isolation recheck: 4 worktrees·4 branches·4 channels all distinct.
    expect(new Set(fleet.map((m) => m.worktreePath)).size).toBe(FLEET_N);
    expect(new Set(fleet.map((m) => m.branch)).size).toBe(FLEET_N);
    expect(new Set(fleet.map((m) => m.channelId)).size).toBe(FLEET_N);
  });
});
