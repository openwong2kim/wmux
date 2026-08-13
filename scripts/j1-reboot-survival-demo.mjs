#!/usr/bin/env node
/**
 * J1 리부트 생존 데모(§0 페어링 — 단일 태스크 왕복 + worktree fs 검사).
 *
 * 실 git 리포지토리에 실 worktree를 하나 만들고, 데몬측 정본(WorkTaskService)이
 * mission.start → task.update 물질화 → **데몬 재시작 시뮬레이션(서비스 재생성 +
 * boot replay)** 을 거쳐 projection(open·branch·worktreePath·paneGroupId)이
 * 잔존하는지, 그리고 그 worktreePath가 **디스크에 실존**하는지 검사한다.
 *
 * 성공기준(§0): 데몬 재시작 → projection 복원(open·필드 잔존) + worktree 디스크
 * 실존(스크립트가 fs 검사) + 채널 active. 디스크 실존은 "자동 보증"이 아니라 이
 * 스크립트가 확보·검사하는 조건이다(리뷰 G3).
 *
 * 이 스크립트는 컴파일 산출물 없이 실 git + 실 로그로 왕복을 재현한다. 실행:
 *   node scripts/j1-reboot-survival-demo.mjs
 * 내부적으로 dedicated vitest 스펙을 돌려 src/ 정본 모듈을 직접 구동한다.
 * Exit 0 = 왕복 성공, non-zero = 실패.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_CLI = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SPEC = 'src/daemon/worktask/__tests__/j1-reboot-survival.demo.runtime.test.ts';

console.log('[j1-demo] 리부트 생존 왕복 시작 — 실 git worktree + 데몬 재시작 replay + fs 검사');

// Invoke the installed CLI through Node so Windows never needs to spawn a
// .cmd shim and a missing dependency cannot make npx download code.
const res = spawnSync(
  process.execPath,
  [VITEST_CLI, 'run', SPEC],
  { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
);

if (res.status === 0) {
  console.log('[j1-demo] PASS — 재시작 후 projection 복원 + worktree 디스크 실존 확인');
  process.exit(0);
} else {
  console.error('[j1-demo] FAIL — 왕복 검증 실패(위 vitest 출력 참조)');
  process.exit(res.status ?? 1);
}
