// ─── J1 리부트 생존 데모(§0 — 단일 태스크 왕복 + worktree fs 검사) ──────────
//
// 실 git 리포 + 실 worktree + 실 AppendOnlyLog로 §0 성공기준을 재현한다:
//   mission.start → worktree 생성(실 git) → task.update 물질화 → 데몬 재시작
//   시뮬레이션(서비스 재생성 + boot replay) → projection 복원(open·필드 잔존)
//   + worktree 디스크 실존(fs.existsSync 검사) + 미션 채널 active.
//
// scripts/j1-reboot-survival-demo.mjs가 이 스펙을 구동한다. 여기 통과가 리부트
// 생존 데모의 판정식이다.
// This spec shells out to real Git and creates a worktree, so it belongs in
// the serial runtime lane rather than the parallel unit-test lane.

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
  // 실 git 리포 초기화 + 최초 커밋(worktree add에 HEAD가 필요).
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
  const log = new AppendOnlyLog({ dir: logDir, fsync: () => undefined });
  log.open();
  return log;
}

// 최소 채널 포트 — 실 ChannelService 대신 in-memory active/archived 추적(데모는
// 채널 active 여부만 검사하면 충분).
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

describe('J1 §0 리부트 생존 왕복(데모)', () => {
  it('mission.start → 실 worktree → task.update → 재시작 replay → 필드 잔존 + worktree fs 실존 + 채널 active', async () => {
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

    // ② 실 worktree 생성(TaskWorktreeManager — 전용 루트를 wtRoot로 고정 주입 불가하므로
    //    직접 git으로 만들되, 경로·branch는 매니저 파생 규칙과 동형으로 잡는다).
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
    // 디스크 실존 검사(§0 — 스크립트가 확보·검사하는 조건).
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);

    // ③ task.update — 물질화({branch, worktreePath, paneGroupId=workspaceId}).
    const workspaceId = 'ws-task-1';
    const updated = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-ceo',
      branch,
      worktreePath,
      paneGroupId: workspaceId,
    });
    expect(updated.ok).toBe(true);

    // ④ 데몬 재시작 시뮬레이션 — 같은 로그·같은 채널 위에 서비스 재생성 + boot replay.
    const svc2 = new WorkTaskService({
      log: newLog(),
      channels: port,
      origin: { machineId: 'm-demo', daemonEpoch: 1 },
      realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
    });
    await svc2.boot();

    // 검증: projection 복원(open·필드 잔존).
    const t = svc2.getTask(taskId);
    expect(t?.status).toBe('open');
    expect(t?.branch).toBe(branch);
    expect(t?.worktreePath).toBe(worktreePath);
    expect(t?.paneGroupId).toBe(workspaceId);

    // 검증: worktree 디스크 실존(재시작 후에도).
    expect(fs.existsSync(worktreePath)).toBe(true);

    // 검증: 미션 채널 active.
    expect(channels.get(channelId)?.status).toBe('active');
  });
});
