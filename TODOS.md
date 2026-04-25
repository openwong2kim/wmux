# TODOS

## Daemon reconnection retry on tray restore
- **What:** DaemonClient에 reconnection retry loop 추가
- **Why:** 트레이 복원 시 데몬이 아직 이전 shutdown 시퀀스 중일 수 있음. 현재 daemon.onConnected는 "늦은 연결"만 처리하고, "재연결"은 미지원. Outside voice가 지적한 레이스 컨디션.
- **Pros:** 트레이 UX의 안정성 확보. 창 닫기 → 즉시 다시 열기가 안정적으로 동작.
- **Cons:** DaemonClient에 retry loop + backoff 추가 필요 (~15분 CC 작업)
- **Context:** `src/main/index.ts` before-quit에서 daemon.shutdown RPC를 보내는데, 트레이 모드에서는 이걸 skip하게 변경 예정. 하지만 edge case(강제 종료, 데몬 크래시 후 재시작)에서는 여전히 reconnect가 필요.
- **Depends on:** 트레이 아이콘 구현

## Pane split max depth/count guard
- **What:** splitPane에 max leaf count 가드 추가 (예: 20개)
- **Why:** 무한 split 시 xterm.js 인스턴스 폭증 → 메모리 목표(200MB for 10 panes) 초과 가능
- **Pros:** 안정성 + 메모리 보호. 1줄 가드.
- **Cons:** 사용자에게 에러 메시지 표시 필요
- **Context:** `src/renderer/stores/slices/paneSlice.ts:46` splitPane 함수 시작 부분에 leaf count 체크 추가.
- **Depends on:** 없음 (즉시 가능)

## DESIGN.md 작성
- **What:** 디자인 시스템 문서 생성 (CSS 변수 목록, 스페이싱 스케일, 폰트, 컴포넌트 패턴)
- **Why:** 커뮤니티 테마 제작자가 어떤 변수와 패턴을 사용해야 하는지 알아야 함. 현재 디자인 결정이 themes.ts와 개별 컴포넌트에 흩어져 있음.
- **Pros:** 커뮤니티 테마 지원 용이, UI 일관성 유지, 새 컴포넌트 개발 시 참조
- **Cons:** 문서 작성/유지 비용
- **Context:** /design-consultation 스킬로 자동 생성 가능. 기존 themes.ts의 CSS 변수, StatusBar/Sidebar의 스타일 패턴에서 추출.
- **Depends on:** v1.0 출시 후

## destroyCompanyWithCleanup race condition
- **What:** PTY dispose가 완료되기 전에 store.destroyCompany()가 호출되는 레이스 컨디션 수정
- **Why:** dispose 중 UI 리렌더가 company === null을 만나 에러 가능성. 기존 inline 코드에도 동일한 문제가 있었음.
- **Pros:** company mode 종료 시 안정성 향상
- **Cons:** async/await 변환 필요
- **Context:** `src/company/renderer/provisioner.ts` destroyCompanyWithCleanup. await Promise.all(disposePromises) 후 destroyCompany() 호출하도록 변경.
- **Depends on:** 없음

## Member workspace PTY leak on company destroy
- **What:** company destroy 시 member workspace 내 분할된 pane의 PTY가 정리되지 않는 문제
- **Why:** m.ptyId만 dispose하고 workspace 내 다른 surface의 PTY는 무시됨
- **Pros:** 메모리 누수 방지
- **Cons:** collectLeafSurfaces로 workspace별 PTY 수집 로직 필요
- **Context:** `src/company/renderer/provisioner.ts` 및 기존 CompanyPanel.tsx의 destroy 로직
- **Depends on:** 없음

## [REMINDER 2026-06-06] wmux-max macOS/Linux 확장 — 게이트 재방문
- **What:** /plan-ceo-review (2026-04-25) 결과로 보류된 wmux-max 크로스플랫폼 인프라 plan 재방문
- **Why:** 메모리 비전의 게이트 ("랜딩 2주 + 홍보 4주 = 이메일 100명 GO/NO-GO") 도달 시점 확인
- **Pros:** 시기상조 회피 + 검증된 수요 위에서 인프라 결정
- **Cons:** 없음 (체크인 자체는 5분)
- **Context:**
  - Plan 파일: `C:\Users\rizz\.claude\plans\replicated-enchanting-dove.md`
  - 메모리: `project_company_mode_vision.md`
  - 결정 트리: 이메일 100+명 = Lean Spike 실행 / 50-99명 = 홍보 +2주 / 50명 미만 = /office-hours 메시징 재설계
  - 6주 = 메모리의 "랜딩 2주 + 홍보 4주" 게이트와 정렬
- **Depends on:** wmux-max.com 랜딩 라이브 + 이메일 수집 캠페인 시작
