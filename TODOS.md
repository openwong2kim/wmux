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

## (E3) Agent status dot transient flash on completed/waiting
- **What:** `agentStatusIcon.ts`/`MiniSidebar` dot animation을 `completed`/`waiting` 전환 시점에 한 번만 발화 (예: 2s flash). 현재 `running`만 `animate-pulse`이고 나머지는 정적.
- **Why:** wmux 창에 포커스가 있어도 측면 시야에서 변화를 잡을 수 있어야 함. inline toast가 transient라 놓치기 쉬움.
- **Pros:** 다중 agent 워크플로우에서 시각 신호 강화. CSS만으로 가능.
- **Cons:** 여러 workspace가 동시에 completed로 변하면 시각 노이즈. tuning 필요.
- **Context:** `src/renderer/components/Sidebar/agentStatusIcon.ts` className 매핑 + `MiniSidebar.tsx:133-140` / `WorkspaceItem.tsx:177-178`. `useEffect`로 status 변경 detect + setTimeout으로 transient class. CC 추정 15분.
- **Depends on:** validated-pondering-grove plan (알림 파이프라인 복구) ship 후 사용자 피드백
- **Priority:** P3 (cosmetic)

## (E4) Per-workspace notification mute/snooze
- **What:** `WorkspaceMetadata`에 `notificationsMuted: boolean` 필드 추가 + 사이드바 우클릭 메뉴 또는 settings에서 toggle. `useNotificationListener`가 muted workspace의 알림은 store에 안 push.
- **Why:** v2.8.2에서 MAX_SESSIONS 50→200 확장됨. 다중 agent 동시 실행 시 알림 폭주 방지 필수.
- **Pros:** 사용자 통제권. 시끄러운 빌드 workspace를 silent로.
- **Cons:** UI 토글 위치/아이콘/i18n key 결정 필요. settings vs context menu 결정.
- **Context:** `src/shared/types.ts:139` WorkspaceMetadata 확장, `src/renderer/hooks/useNotificationListener.ts:41-66`에서 muted 체크 추가, `notificationSlice.markAllReadForWorkspace`와 같은 패턴으로 mute action 추가. CC 추정 30-40분.
- **Depends on:** 알림 파이프라인 복구 ship 후 사용자 피드백 (정말 시끄러운지 확인 후 우선순위)
- **Priority:** P2

## (E5) Tray icon unread badge (cross-platform)
- **What:** `src/main/tray.ts`에 unread count를 표시. macOS: `app.dock.setBadge(N)`, Windows: tray tooltip prefix `[N] wmux`, Linux: best-effort (NotificationServer 표준은 제한적).
- **Why:** wmux 창이 minimize/hide 상태에서는 OS 토스트 한 번 외에는 알림 신호 부재. tray가 영구 신호 채널.
- **Pros:** 창 안 열어도 unread 인지. macOS 사용자에게 자연스러운 UX.
- **Cons:** Cross-platform 차이 큼 — 3 OS에서 각각 QA 세션 필요. Linux fallback 정책 결정 필요.
- **Context:** memory `project_cross_platform_branch_policy` 정책에 따라 **feature branch + PR**로 진행. `src/main/notification/ToastManager.ts`와 같은 자리에 `TrayBadgeManager` 추가 고려. Renderer store unread count 변경 → main으로 push → tray 갱신. CC 추정 30-45분 + 3 OS QA.
- **Depends on:** 알림 파이프라인 복구 ship + 사용자가 minimize 사용 빈도 확인
- **Priority:** P2

## (Phase 2 / Eureka) Agent stop-hook OSC 9 signal
- **What:** Claude Code/Codex의 `stop` hook 또는 shell integration을 통해 turn 종료 시 OSC 9 BEL (`\x1b]9;Agent done\x07`)를 emit하도록 가이드 + 설치 스크립트. 우리 `OscParser.ts`는 이미 OSC 9를 듣고 있어서 100% 신뢰 신호 채널이 됨.
- **Why:** 휴리스틱(throughput) + 패턴 매칭(AgentDetector)은 외부에서 추측. agent 자신이 turn boundary를 가장 정확히 안다. tmux `monitor-silence` + iTerm2 OSC 9의 진화 형태.
- **Pros:** 100% 정확. 휴리스틱 의존 0. Eureka 후보.
- **Cons:** Claude Code 환경 변동 시 hook 깨질 위험. 사용자가 hook 설정 안 하면 fallback 필요(현재 path가 fallback 역할).
- **Context:** Claude Code hooks 시스템(`~/.claude/settings.json`의 hook 정의). 설치 스크립트는 wmux 첫 실행 시 hook 등록 권유 wizard로 풀 수 있음.
- **Depends on:** 알림 파이프라인 복구 ship 후 실측 데이터 — heuristic 정확도가 충분하면 우선순위 ↓
- **Priority:** P3 (가치 높지만 외부 의존 + 가이드 필요)
