#!/usr/bin/env node
// ─── J3 함대 리부트 생존 데모 러너(§5(a) — 하드 게이트 판정식) ────────────────
//
// fanout N=4 → 실 worktree 4개 + 산출물 시딩 → 데몬 재시작 replay → **데몬 상태
// 전량 복원**(projection·물질화 필드·worktree fs + 산출물·채널 active)을 재현한다.
//
// 실증 범위 규율(§5): 이 스크립트의 PASS는 데몬 상태 복원까지만 실증한다.
// 워크스페이스·페인 복원은 수동 시나리오 문서(docs) 절차로 별도 확인한다.
//
// 사용:
//   node scripts/j3-fleet-reboot-survival-demo.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_CLI = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SPEC = 'src/daemon/worktask/__tests__/j3-fleet-reboot-survival.demo.runtime.test.ts';

console.log('[j3-fleet-demo] 함대 리부트 생존 왕복 시작 — N=4 실 worktree + 산출물 시딩 + 재시작 replay');

// Invoke the installed CLI through Node so Windows never needs to spawn a
// .cmd shim and a missing dependency cannot make npx download code.
const res = spawnSync(
  process.execPath,
  [VITEST_CLI, 'run', SPEC],
  { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
);

if (res.status === 0) {
  console.log('[j3-fleet-demo] PASS — 재시작 후 함대 4기 데몬 상태 전량 복원(projection·worktree·산출물·채널)');
  process.exit(0);
} else {
  console.error('[j3-fleet-demo] FAIL — 함대 왕복 검증 실패(위 vitest 출력 참조)');
  process.exit(res.status ?? 1);
}
