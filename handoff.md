# Teammate Handoff

(필요 시 채움. teammate 교체 또는 세션 복구 시 사용.)

## Session State
- **current_phase**: Phase 0 완료 → Phase 3 진입
- **completed_tasks**: (없음, sprint 시작)
- **blocked_items**: (없음)
- **next_steps**: Wave 1 병렬 스폰 (T1, T2, T3, T4)
- **active_worktrees**: (Wave 1 시작 시 추가)

---

## Template (teammate 교체 시 채울 것)

## Outgoing Teammate Summary
- **Role**: [무엇을 하던 teammate인가]
- **Agent**: [subagent_type]
- **Termination reason**: [completed / stuck / error loop / context full / timeout]

## What Was Completed
- [bullet list]
- Files created/modified: [경로]

## What Remains
- [bullet list]
- Expected approach: [전략]

## Gotchas & Warnings
- [다음 teammate가 알아야 할 것]
- [실패한 접근 — 반복 금지]

## Key File Paths
- [관련 파일 목록]

## Interface Changes
- [다른 모듈에 영향 주는 변경사항]

---

## For Incoming Teammate

이 handoff를 읽고:
1. 남은 태스크 이해 확인
2. 시작 전 plan 제출
3. 체크포인트마다 보고
