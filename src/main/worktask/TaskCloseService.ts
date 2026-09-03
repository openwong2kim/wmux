/**
 * TaskCloseService — 태스크 close 오케스트레이션(J3 §1, main측).
 *
 * 순서 계약(리뷰 CX1·CX2·G2 — v1 "close 먼저"의 역전):
 *   ⓪ upstream/ahead 검사 — 미push 커밋이 있으면 close를 진행하지 않고 경고
 *      반환(CX3: porcelain-clean ≠ 수확 완료. PR 제안은 호출측 UI 몫).
 *   ① worktree remove — TaskWorktreeManager.removeWorktree(내부 porcelain
 *      재검사가 dirty 정본 게이트 — G1 TOCTOU는 remove 내부 검사로 흡수).
 *      dirty면 remove 거부 + **close도 보류**(태스크 open 유지 — "닫혔는데
 *      산출물 잔존" 모순 제거) + 보존 목록 등재.
 *   ② remove 성공 후에만 mission.close(데몬 RPC). archive 실패는 데몬이
 *      삼키고 부트 reconcile이 수렴하므로 여기선 결과만 전달.
 *   ③ meta dir(prompt.md) 삭제 — 태스크 종료 후 재발사 무의미(§1).
 *
 * ②↔③ 사이 크래시 = closed 태스크 + meta 잔존 → 정리 스캔(디스크 정본) 몫.
 * ①↔② 사이 크래시 = open 태스크 + worktree 없음 = 미물질화형 잔여 → 동일.
 *
 * 미물질화 태스크(worktreePath 부재 — CX4): worktree 단계를 건너뛰고 close만.
 * 호출측 UI가 회수 확인 다이얼로그를 선행한다(여기선 플래그로만 표시).
 */

import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TaskWorktreeManager } from './TaskWorktreeManager';
import { noteWorkTaskClosed } from '../deck/taskLedgerHost';
import { getExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

/** 데몬 RPC 최소 표면(FanOutDaemonPort 동형 — 테스트 주입 가능). */
export interface CloseDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface CloseTaskInput {
  taskId: string;
  verifiedWorkspaceId: string;
  /** 물질화 정보(데몬 projection에서 조회한 값 — 부재면 미물질화 close). */
  repoRoot?: string;
  repoHash?: string;
  worktreePath?: string;
  metaDir?: string;
}

export type CloseTaskResult =
  | { ok: true; taskId: string; archivePending: boolean; unmaterialized?: boolean }
  | {
      ok: false;
      taskId: string;
      /** 'unpushed' = 미push 커밋 경고(진행 안 함) / 'dirty' = 보존 + close 보류 / 'error' = 기타 */
      reason: 'unpushed' | 'dirty' | 'error';
      error: string;
      /** dirty 보존 시 등재 경로. */
      preservedWorktree?: string;
      /** unpushed 시 ahead 커밋 수(경고 표시용). */
      aheadCount?: number;
    };

export interface TaskCloseServiceOptions {
  daemon: CloseDaemonPort;
  worktrees: TaskWorktreeManager;
}

export class TaskCloseService {
  private readonly daemon: CloseDaemonPort;
  private readonly worktrees: TaskWorktreeManager;

  constructor(opts: TaskCloseServiceOptions) {
    this.daemon = opts.daemon;
    this.worktrees = opts.worktrees;
  }

  async closeTask(input: CloseTaskInput): Promise<CloseTaskResult> {
    const { taskId } = input;

    // 미물질화 close(CX4): worktree 단계 전체 건너뜀 — close만 커밋.
    if (!input.worktreePath) {
      const closed = await this.missionClose(taskId, input.verifiedWorkspaceId);
      if (!closed.ok) return { ok: false, taskId, reason: 'error', error: closed.error };
      return { ok: true, taskId, archivePending: closed.archivePending, unmaterialized: true };
    }

    // ⓪ upstream/ahead 검사(CX3): 커밋됐지만 push 안 된 산출물이 있으면 진행 중단.
    const ahead = await this.aheadOfUpstream(input.worktreePath);
    if (ahead.kind === 'ahead') {
      return {
        ok: false,
        taskId,
        reason: 'unpushed',
        error: `close: ${ahead.count}개 커밋이 push되지 않았습니다 — PR 생성 또는 push 후 다시 close하세요`,
        aheadCount: ahead.count,
      };
    }
    // upstream 부재 + 로컬 커밋 존재(fan-out 직후 base에서 전진) — 동일하게 경고.
    if (ahead.kind === 'no-upstream-with-commits') {
      return {
        ok: false,
        taskId,
        reason: 'unpushed',
        error: `close: push되지 않은 브랜치에 커밋 ${ahead.count}개가 있습니다 — PR 생성 또는 push 후 다시 close하세요`,
        aheadCount: ahead.count,
      };
    }

    // ① worktree remove — 내부 porcelain 재검사가 dirty 정본 게이트(G1).
    if (!input.repoRoot || !input.repoHash) {
      return { ok: false, taskId, reason: 'error', error: 'close: repoRoot/repoHash 부재(물질화 정보 불완전)' };
    }
    const removed = await this.worktrees.removeWorktree(input.repoRoot, input.repoHash, input.worktreePath);
    if (!removed.ok) {
      if (removed.preserved) {
        // dirty 보존 — close 보류(태스크 open 유지, §1 계약).
        return {
          ok: false,
          taskId,
          reason: 'dirty',
          error: removed.error,
          preservedWorktree: input.worktreePath,
        };
      }
      return { ok: false, taskId, reason: 'error', error: removed.error };
    }

    // ② remove 성공 후에만 close 커밋.
    const closed = await this.missionClose(taskId, input.verifiedWorkspaceId);
    if (!closed.ok) {
      // remove는 이미 성립(clean이었으므로 산출물 유실 없음) — close 실패는
      // open+worktree 없음 상태로 남고 재시도 가능. 명시 에러.
      return { ok: false, taskId, reason: 'error', error: closed.error };
    }

    // ③ meta dir(prompt.md) 삭제 — 실패는 비치명(정리 스캔 몫), 결과에 무영향.
    if (input.metaDir) {
      try {
        fs.rmSync(input.metaDir, { recursive: true, force: true });
      } catch {
        /* 정리 스캔이 줍는다 */
      }
    }

    return { ok: true, taskId, archivePending: closed.archivePending };
  }

  /** mission.close 데몬 RPC — archive 실패 여부(archivePending)를 결과에 전달(CX2). */
  private async missionClose(
    taskId: string,
    verifiedWorkspaceId: string,
  ): Promise<{ ok: true; archivePending: boolean } | { ok: false; error: string }> {
    try {
      const res = (await this.daemon.rpc('task.mission.close', {
        taskId,
        verifiedWorkspaceId,
      })) as { ok?: boolean; archivePending?: boolean; error?: { message?: string } };
      if (res && res.ok === true) {
        // Lane F: the task ledger learns about the close now, not on the
        // next reconcile pass (an open row would hold the brain's Stop gate).
        await noteWorkTaskClosed(taskId);
        return { ok: true, archivePending: res.archivePending === true };
      }
      return { ok: false, error: res?.error?.message ?? 'task.mission.close failed' };
    } catch (err) {
      return { ok: false, error: `task.mission.close: ${(err as Error).message}` };
    }
  }

  /**
   * upstream 대비 ahead 커밋 검사(CX3). 판정 3종:
   *   - upstream 존재: `rev-list --count @{upstream}..HEAD` > 0 → ahead
   *   - upstream 부재: fan-out base(머지베이스 추적 불가) 대신 브랜치 자체 커밋
   *     여부 — `rev-list --count HEAD ^--remotes` 근사 대신 안전하게
   *     `rev-list --count HEAD --not --remotes`로 원격 어디에도 없는 커밋 수.
   *   - 검사 실패: 보수적으로 통과(clean 판정은 remove의 porcelain이 정본 —
   *     여기는 경고 게이트라 fail-open이 UX 손실뿐 데이터 손실 없음).
   */
  private async aheadOfUpstream(
    worktreePath: string,
  ): Promise<{ kind: 'clean' } | { kind: 'ahead' | 'no-upstream-with-commits'; count: number }> {
    try {
      const upstream = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { cwd: worktreePath, timeout: 15000, env: getExecEnv() },
      ).then(
        () => true,
        () => false,
      );
      if (upstream) {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', '@{upstream}..HEAD'],
          { cwd: worktreePath, timeout: 15000, env: getExecEnv() },
        );
        const n = parseInt(stdout.trim(), 10);
        return n > 0 ? { kind: 'ahead', count: n } : { kind: 'clean' };
      }
      // 원격이 아예 없는 로컬 전용 repo면 push 개념이 없다 — 경고 생략(오탐 방지).
      const remotes = await execFileAsync('git', ['remote'], { cwd: worktreePath, timeout: 15000, env: getExecEnv() });
      if (remotes.stdout.trim().length === 0) return { kind: 'clean' };
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath, timeout: 15000, env: getExecEnv() },
      );
      const n = parseInt(stdout.trim(), 10);
      return n > 0 ? { kind: 'no-upstream-with-commits', count: n } : { kind: 'clean' };
    } catch {
      return { kind: 'clean' };
    }
  }
}
