// ─── J3 함대 리부트 생존 데모(§5(a) — fanout N=4 왕복, 하드 게이트 판정식) ────
//
// J1 단일 태스크 데모(j1-reboot-survival.demo.test.ts)의 함대 확장. 실 git 리포
// + 실 worktree 4개 + 실 AppendOnlyLog로 §5(a) 스크립트 실증 범위를 재현한다:
//   mission.start ×4 → worktree ×4(실 git) → 산출물 시딩(각 worktree에 미커밋
//   변경) → task.update 물질화 ×4 → 데몬 재시작 시뮬레이션(서비스 재생성 +
//   boot replay) → **데몬 상태 전량 복원**: projection 4태스크 open·물질화 필드
//   잔존 / worktree 4개 fs 실존 + 산출물 파일 잔존 / 미션 채널 4개 active.
//
// 실증 범위 규율(§5 — 리뷰 G7+CL7): 이 판정식이 실증하는 것은 **데몬 상태**까지다.
// 워크스페이스·페인 복원(session.json/렌더러 경로)은 수동 시나리오 문서 몫이며,
// 이 테스트의 PASS를 근거로 "워크스페이스 생존"을 주장하지 않는다.
//
// scripts/j3-fleet-reboot-survival-demo.mjs가 이 스펙을 구동한다.
// This spec shells out to real Git and creates four worktrees, so it belongs
// in the serial runtime lane rather than the parallel unit-test lane.

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

// 최소 채널 포트(J1 데모 하네스 동형 — active/archived 추적만).
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

describe('J3 §5(a) 함대 리부트 생존 왕복(데모 판정식)', () => {
  it(`fanout N=${FLEET_N} → 산출물 시딩 → 재시작 replay → 데몬 상태 전량 복원`, async () => {
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

    // ①~③ 함대 스폰: mission.start → 실 worktree → 산출물 시딩 → 물질화.
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

      // 산출물 시딩: 에이전트 작업 시뮬레이션 — 미커밋 변경(§5(a) "산출물 시딩").
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

    // ④ 데몬 재시작 시뮬레이션 — 같은 로그·같은 채널 위에 서비스 재생성 + replay.
    const svc2 = newSvc(port);
    await svc2.boot();

    // ⑤ 검증: 데몬 상태 전량 복원(N=4 전원 — 하나라도 결손이면 함대 생존 실패).
    for (const m of fleet) {
      // projection: open + 물질화 필드 잔존.
      const t = svc2.getTask(m.taskId);
      expect(t?.status).toBe('open');
      expect(t?.branch).toBe(m.branch);
      expect(t?.worktreePath).toBe(m.worktreePath);
      expect(t?.paneGroupId).toBe(m.workspaceId);
      // worktree 디스크 실존 + 미커밋 산출물 잔존(재시작이 산출물을 못 건드림).
      expect(fs.existsSync(m.worktreePath)).toBe(true);
      expect(fs.existsSync(path.join(m.worktreePath, '.git'))).toBe(true);
      expect(fs.readFileSync(m.artifactPath, 'utf8')).toContain('fleet artifact');
      // 미션 채널 active.
      expect(channels.get(m.channelId)?.status).toBe('active');
    }

    // 상호 격리 재확인: 4 worktree·4 branch·4 채널이 전부 상이.
    expect(new Set(fleet.map((m) => m.worktreePath)).size).toBe(FLEET_N);
    expect(new Set(fleet.map((m) => m.branch)).size).toBe(FLEET_N);
    expect(new Set(fleet.map((m) => m.channelId)).size).toBe(FLEET_N);
  });
});
