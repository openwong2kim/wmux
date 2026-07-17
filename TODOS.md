# TODOS

## 커맨더 원격 제어 — OpenClaw 2호 어댑터 + 메신저 채널 브리지 (BYOB C, P2)
- **What:** 데크 커맨더를 폰/외부에서 제어하는 경로. OpenClaw를 두 번째 ACP... 정확히는
  Gateway WS 어댑터(`chat.send`→`agent` 이벤트: deltaText/tool_call/tool_result/finish,
  sessionKey=resume 핸들)로 붙이고, OpenClaw에 내장된 메신저 채널(텔레그램/WhatsApp 등)을
  통해 같은 커맨더 세션에 밖에서 말을 걸 수 있게 한다.
- **Why:** 오너 요구 "커맨더를 언제 어디서든(RC처럼) 제어". Claude Code RC 직결은 구조적
  불가(RC=대화형 세션 전용·폐쇄 프로토콜, 데크 브레인=headless 스트림), wmux 자체 원격
  표면(웹/모바일)은 에픽급 → 게이트웨이형 에이전트의 채널 기능을 얻어 타는 것이
  비용 대비 최적 경로(2026-07-17 결정, C안 채택·나중 진행).
- **Pros:** "텔레그램에서 함대 지휘" 데모 가치 큼(경쟁 차별), 어댑터 인프라(BrainAdapter·
  P4 role-gate·벤더 픽커) 전부 재사용, OpenClaw 스파이크 완료 상태(프로토콜 1:1 매핑 확인).
- **Cons:** 상주 게이트웨이 유휴 400–800MB(앱 무거움 에픽과 상충 — **온디맨드 기동/정지
  설계가 선행 조건**), challenge/nonce+deviceToken 핸드셰이크, 일일 세션 리셋 정책 핀 필요,
  구독 과금 정책이 "현재로서는" 조건부(zai/anthropic 재사용 모드).
- **Context:** 스파이크 리포트는 메모리 project-byob-brain-design-2026-07-16 + BYOB 설계
  문서(~/.gstack/.../rizz-main-design-20260716-233233-byob-brain.md)의 "B 스파이크 결과"
  섹션. 어댑터 계약/게이트는 #475(role-gate)·#477(AcpBrainAdapter — 구조 참고용 템플릿).
  OpenClaw Gateway 프로토콜 v4: 포트 18789 localhost, connect.challenge→hello-ok,
  `openclaw models status --json --check`로 인증 감지. 채널 브리지의 신뢰 모델(외부 메신저
  발화자=오너 검증)은 착수 시 별도 보안 리뷰 필수.
- **Depends on / blocked by:** 온디맨드 게이트웨이 수명주기 설계(선행), P4 role-gate(완료),
  벤더 픽커(완료). Hermes 업스트림 fix(hermes-agent#66038)와는 독립.
- **Priority:** P2 (오너 지시로 이연 — "나중에 진행")

## ✅ 채널 멘션: 크로스-워크스페이스 전달 — DONE v3.14.0 (2026-07-05)
- 데몬 `events.poll` union scope(`workspaceIds` 집합 필터, ea36425) + 렌더러 단일 폴 fan-out(`planChannelMessageDelivery` 순수함수 유닛테스트, 7a108ea)으로 구현. 1차 N-루프 시도의 same-ws 회귀는 이 재설계(TODO의 "더 나은 방향")로 회피. idle-since-attach 전달 차단은 grace+output-quiet paste 게이트로 해결(c8b3bf9, 941a639). 3모델 리뷰(Claude·Codex·GLM) 통과. 아래는 이력 보존:

### (이력) 원래 TODO 본문
- **What:** 채널은 워크스페이스 독립이어야 하는데, `useChannelsEventSubscription.ts:148`이 **활성 워크스페이스 하나만** `events.poll` 폴링. 데몬이 이벤트를 caller 워크스페이스(`recipientWorkspaceIds`)로 필터링하므로, WS1을 연 상태에서 WS2 판을 멘션하면 WS2 이벤트가 필터에서 빠져 전달 안 됨 (원문 주석에도 "for v1 we poll one / FIX-MULTI-WS follow-up"으로 명시된 알려진 v1 단축).
- **1차 시도 → 회귀로 revert:** 폴 루프를 `startLoop(workspaceId, isFull)`로 추출해 모든 로컬 워크스페이스 폴링(활성=full, 나머지=delivery전용). 그러나 도그푸딩에서 **same-ws 활성 멘션 전달 회귀** 발생(w18 무응답). diff상 full 경로는 기존과 100% 동일한데 실패 — 원격에서 렌더러 상태 검증 불가로 원인 미확정(가설: 8+ 동시 폴 루프 스케일의 타이밍 vs fail-closed busy 선재동작). **패치 보존: `~/.wmux-multiws-delivery.patch`** — 재개 시 여기서 시작.
- **재개 전 확정 필요:** (1) w18 회귀가 멀티-ws 때문인지 vs fail-closed busy(`channelMentionFlush` isBusy: status null/running=busy) 선재동작인지 — 로컬 dev 빌드에서 렌더러 로그로 flush 스킵 여부 관찰. (2) `setChannels` 전체 대체 클로버링 회피(delivery 모드가 표시 상태 미변경)는 맞았으나, N개 동시 폴의 비용/타이밍 재검토.
- **더 나은 방향(재설계):** 워크스페이스별 N폴 대신 "사람=모든 로컬 수신" 단일 스코프를 데몬 `events.poll`에 추가 — 렌더러가 로컬 워크스페이스 집합을 한 번에 넘기고 데몬이 union 필터. 폴 1개로 유지되고 스케일 문제 없음. 단 데몬 events.rpc 스코프 semantics 변경 필요.
- **시작점:** `src/renderer/hooks/useChannelsEventSubscription.ts:148`(폴 스코프), `src/main/pipe/handlers/events.rpc.ts:108-135`(caller 필터), `src/renderer/hooks/channelMentionFlush.ts`(isBusy fail-closed).
- **Priority:** P1 (사용자가 명시적으로 요구한 기능 — "워크스페이스 제약이 있으면 안 됨").

## 멘션 paste 게이트 OUTPUT_QUIET_MS 도그푸드 튜닝 (follow-up, P2)
- **What:** `channelMentionPasteGate.ts`의 `OUTPUT_QUIET_MS=2000` / `MAX_UNKNOWN_HOLD_MS=45000`은 실측 없이 잡은 보수값. 실제 idle vs thinking 에이전트의 pty 출력 주기를 도그푸드로 관측해 튜닝. perpetual-unknown이 하드-실링으로 배달되는 경로에 debug 로그 1줄 추가 검토(사일런트 지연 가시화).
- **Why:** 3모델 리뷰(Codex CRITICAL + Claude fallback) — QUIET 임계가 idle 커서-쿼리 주기보다 짧으면 배달 지연 가능. 현재는 실링으로 fail-safe(무배달 아닌 지연)이나 최적값은 관측 필요. Claude가 지적한 `useChannelsEventSubscription`의 stale `requireIdle` 주석(FlushOpts에 필드 없음) 정정도 이때 함께.
- **Context:** `src/renderer/hooks/channelMentionPasteGate.ts`, `useChannelsEventSubscription.ts`. 착수점 = 실 에이전트 pty 출력 스트림 관측.
- **Priority:** P2

## 터미널: 멘션 전달 직후 DSR-CPR(`ESC[<row>;<col>R`) 응답이 화면으로 새어 `;3R40` 폭주
- **What:** 채널 멘션이 판에 붙여넣어진 직후, 커서 위치 응답(`ESC[40;3R`)이 Claude TUI에 소비되지 않고 터미널 스크롤백에 리터럴 텍스트로 대량 출력됨. CPU 0% = 일회성 버스트(핫루프 아님), 데이터·채널 정상, 순수 표시 깨짐.
- **Why:** wmux 터미널 repaint 취약 지점(선재 결함, #318/#319/#333가 같은 "Claude 스트림 중 garbling" 영역을 반복 수정). 멀티-ws 멘션 전달 복구(useChannelsEventSubscription)로 전달이 빨라지면서 더 자주 드러남 — 원인은 전달이 아니라 터미널 DSR/repaint 처리.
- **가설:** 멘션 붙여넣기(`submitBracketedPasteToPty`) ↔ xterm.js repaint(#318 activity-cadence) ↔ Claude TUI 재그리기(cursor query 스톰)의 타이밍 경합. Claude가 `ESC[6n`을 연속 발행하는데 응답을 소비하기 전 상태 전환(붙여넣기/repaint)이 끼어들어 응답이 셸/화면으로 샘.
- **재현 조건(추정):** 멘션 여러 개 빠르게 연속 전달 → 대상 판이 답장 후 idle 전환하는 순간.
- **시작점:** `src/renderer/hooks/useTerminal.ts`(xterm write/repaint), `src/renderer/terminal/*`(#318 repaint cadence), `src/renderer/utils/ptyMessageDelivery.ts`(bracketed paste 주입).
- **Priority:** P2 (표시만, 기능·데이터 무영향 — Ctrl+L로 스크롤백 정리 가능).

## Invalidate pinned MCP terminal route when its workspace dies
- **What:** `paneResolver`에 `clearPin()` export 추가 후, `callRpc`의 stale-identity 자가치유 경로(`index.ts:64,68`, `isStaleIdentityResult` → `invalidateWorkspaceId()`)에서 pin도 함께 클리어.
- **Why:** 외부 MCP 호출자가 claim한 전용 workspace를 사용자가 세션 중간에 수동 종료하면, 프로세스 수명 pin이 죽은 PTY를 계속 가리켜 그 호출자의 terminal 도구가 MCP 재시작 전까지 영구 실패한다. `invalidateWorkspaceId()`는 verified 캐시만 self-heal하고 pin은 건드리지 않는다.
- **Pros:** 외부 호출자도 workspace 종료 후 다음 호출에서 재claim으로 자가치유.
- **Cons:** paneResolver 공개 API에 clearPin 추가 + callRpc 결합. 소규모지만 모듈 경계 확장.
- **Context:** 이번 #163 Part 2가 만든 결함이 아니라 기존 `resolveDefaultPtyId`의 ptyId pin에도 있던 선재 결함(verified-only path는 PR #125부터 존재). Part 2 리뷰(plan-eng-review)에서 R4로 식별. 시작점: `src/mcp/paneResolver.ts`(pin 상태) + `src/mcp/index.ts:62-72`(callRpc).
- **Depends on:** #163 Part 2 ship 후 (PinnedRoute 도입 이후 위에서 작업)

## Daemon reconnection retry on tray restore
- **What:** DaemonClient에 reconnection retry loop 추가
- **Why:** 트레이 복원 시 데몬이 아직 이전 shutdown 시퀀스 중일 수 있음. 현재 daemon.onConnected는 "늦은 연결"만 처리하고, "재연결"은 미지원. Outside voice가 지적한 레이스 컨디션.
- **Pros:** 트레이 UX의 안정성 확보. 창 닫기 → 즉시 다시 열기가 안정적으로 동작.
- **Cons:** DaemonClient에 retry loop + backoff 추가 필요 (~15분 CC 작업)
- **Context:** `src/main/index.ts` before-quit에서 daemon.shutdown RPC를 보내는데, 트레이 모드에서는 이걸 skip하게 변경 예정. 하지만 edge case(강제 종료, 데몬 크래시 후 재시작)에서는 여전히 reconnect가 필요.
- **Depends on:** 트레이 아이콘 구현

<!-- Pane split max depth/count guard — RESOLVED. paneSlice.ts now declares
     MAX_PANES_PER_WORKSPACE=20 and splitPane() returns false (blockedAtCap)
     when collectLeafIds(ws.rootPane).length >= the cap. Guard + boolean
     return contract are complete. -->

## DESIGN.md 작성
- **What:** 디자인 시스템 문서 생성 (CSS 변수 목록, 스페이싱 스케일, 폰트, 컴포넌트 패턴)
- **Why:** 커뮤니티 테마 제작자가 어떤 변수와 패턴을 사용해야 하는지 알아야 함. 현재 디자인 결정이 themes.ts와 개별 컴포넌트에 흩어져 있음.
- **Pros:** 커뮤니티 테마 지원 용이, UI 일관성 유지, 새 컴포넌트 개발 시 참조
- **Cons:** 문서 작성/유지 비용
- **Context:** /design-consultation 스킬로 자동 생성 가능. 기존 themes.ts의 CSS 변수, StatusBar/Sidebar의 스타일 패턴에서 추출.
- **Depends on:** v1.0 출시 후

<!-- destroyCompanyWithCleanup race condition (#4) — RESOLVED. provisioner.ts
     destroyCompanyWithCleanup() now `await Promise.all(ptyIds.map(dispose))`
     BEFORE state.destroyCompany(), so the store is never cleared while a
     dispose Promise is mid-flight. -->

<!-- Member workspace PTY leak on company destroy (#5) — RESOLVED.
     destroyCompanyWithCleanup() sweeps every member workspace AND the CEO
     workspace via collectLeafSurfaces(rootPane), de-duping ptyIds before
     dispose. No split-pane PTY survives a company destroy. -->

## (E3) Agent status dot transient flash on completed/waiting
- **What:** `agentStatusIcon.ts`/`MiniSidebar` dot animation을 `completed`/`waiting` 전환 시점에 한 번만 발화 (예: 2s flash). 현재 `running`만 `animate-pulse`이고 나머지는 정적.
- **Why:** wmux 창에 포커스가 있어도 측면 시야에서 변화를 잡을 수 있어야 함. inline toast가 transient라 놓치기 쉬움.
- **Pros:** 다중 agent 워크플로우에서 시각 신호 강화. CSS만으로 가능.
- **Cons:** 여러 workspace가 동시에 completed로 변하면 시각 노이즈. tuning 필요.
- **Context:** `src/renderer/components/Sidebar/agentStatusIcon.ts` className 매핑 + `MiniSidebar.tsx:133-140` / `WorkspaceItem.tsx:177-178`. `useEffect`로 status 변경 detect + setTimeout으로 transient class. CC 추정 15분.
- **Depends on:** validated-pondering-grove plan (알림 파이프라인 복구) ship 후 사용자 피드백
- **Priority:** P3 (cosmetic)

<!-- (E4) Per-workspace notification mute/snooze — DELIVERED 2026-05-22 in
     `team/2026-05-21/notification-system-expansion`. WorkspaceMetadata gained
     `notificationsMuted?: boolean`; SettingsPanel exposes a per-workspace mute
     list; `useNotificationPolicy` skips toast/sound/ring/flashFrame for muted
     workspaces while still recording the entry in the panel (policy A4). -->

## (E5) Tray icon unread badge (cross-platform)
- **What:** `src/main/tray.ts`에 unread count를 표시. macOS: `app.dock.setBadge(N)`, Windows: tray tooltip prefix `[N] wmux`, Linux: best-effort (NotificationServer 표준은 제한적).
- **Why:** wmux 창이 minimize/hide 상태에서는 OS 토스트 한 번 외에는 알림 신호 부재. tray가 영구 신호 채널.
- **Pros:** 창 안 열어도 unread 인지. macOS 사용자에게 자연스러운 UX.
- **Cons:** Cross-platform 차이 큼 — 3 OS에서 각각 QA 세션 필요. Linux fallback 정책 결정 필요.
- **Context:** memory `project_cross_platform_branch_policy` 정책에 따라 **feature branch + PR**로 진행. `src/main/notification/ToastManager.ts`와 같은 자리에 `TrayBadgeManager` 추가 고려. Renderer store unread count 변경 → main으로 push → tray 갱신. CC 추정 30-45분 + 3 OS QA.
- **Depends on:** 알림 파이프라인 복구 ship + 사용자가 minimize 사용 빈도 확인
- **Priority:** P2

## Fix B — Scrollback restore cap-aware suspended-session promote
- **What:** `daemon.listSessions`에 `{includeSuspended}` 파라미터 추가 + `daemon.promoteSession(id)` 신규 RPC. `AppLayout.reconcilePtys` fallback 직전에 promote 시도. cap=40 초과로 자동 복구되지 못한 suspended session도 reconnect 가능하게.
- **Why:** Fix 0 (mount gate + saved ptyId 보존)는 cap *안*의 graceful Quit session만 복원. cap *초과* session (50+ panes 사용자, 또는 force-kill 후 daemon snapshot은 살아있지만 cap에 밀린 case)은 여전히 fresh terminal. design doc §5 + Update에 spec.
- **Pros:** scrollback restore feature 100% 완성 (cap 안 + 초과 모두). power user 사용성 결정적.
- **Cons:** RPC 2개 추가 + dynamic test R2-R5 (cap-skipped promote 4 scenario). Effort ~3-4시간.
- **Context:** `docs/internal/scrollback-restore-design.md` §5 (Fix B) — full implementation sketch + failure modes + test matrix 이미 작성됨. 구현 시 그대로 따라가면 됨.
- **Depends on:** Fix 0 (plan `wiggly-booping-cascade.md`) ship + 최소 1주 dogfood. dogfood에서 stale-state / RPC guard / generation race 회귀 없는 것을 확인한 *후*에야 Fix B 진행 (한 번에 두 가지 architecture change 검증 어려움).
- **Priority:** P1 (Fix 0 dogfood 통과 후)

## (Phase 2 / Eureka) Agent stop-hook OSC 9 signal — promoted to design doc
- **Status:** Draft plan exists at `plans/agent-hook-integration.md` (209 lines).
  Covers PostToolUse/Stop/SubagentStop/SessionStart hooks + dedup with
  AgentDetector + marker-bounded `~/.claude/settings.json` editing + opt-in
  installer + ASAR-external bridge script. 7 hook items, ~700 LOC, dogfood-gated.
- **Why deferred:** substrate neutrality (`[[feedback_substrate_neutrality]]`) +
  no dogfood data justifying global config edit
  (`[[feedback_no_ship_without_user_verification]]`). The notification-system
  expansion shipped first; this is the next iteration after measured signal.
- **Depends on:** notification-system-expansion ship + ≥ 1 week dogfood + at
  least one of (false-positive rate / false-negative rate / user reports
  describing missed/wrong notifications that hooks would solve). If neither
  signal materializes within 4 weeks of merge, downgrade back to P3 idea.
- **Priority:** P1 (after measurement gate)

<!-- (P3) CLI notify command — RESOLVED. src/cli/commands/notify.ts implements
     `wmux notify --title X --body Y` (parses both flags, sends the `notify`
     RPC over the daemon pipe); src/main/pipe/handlers/notify.rpc.ts handles
     it; `wmux notify` is listed in the CLI help. -->

<!-- (P3) findSurfaceByPtyId / findActiveLeaf dedup — RESOLVED (this session).
     Both helpers extracted to src/renderer/utils/paneTraversal.ts (pure, no
     React/store deps). useNotificationListener now imports them; the two
     inline findActiveLeaf closures (isActivePtySurface / resolveNotificationTarget)
     are gone. Regression-locked listener tests (19) + full suite (2057) green.
     NOTE: findSurfaceByPtyId was already de-duplicated to a single module-level
     fn before this pass — only findActiveLeaf was still duplicated. -->

<!-- (P3) Pre-existing daemon ProcessMonitor flake — RESOLVED 2026-05-22.
     Root cause: watch() relied on the CHECK_INTERVAL_MS setInterval tick
     for the first probe; under CPU contention a 50ms interval + two tasklist
     execs (1-6s each) could exceed the test's 5s default it() timeout.
     Fix: watch() now triggers an immediate first runBatchCheck (production
     code) AND the test's outer it() timeout is bumped to 20s with a 15s
     vi.waitFor budget. Verified stable across 5 consecutive full-suite runs. -->

## Duplicate-daemon / split-brain on "Quit (keep sessions)" → relaunch (P1)
> **STATUS 2026-07-01 — RESOLVED (pending live re-verify):** the launcher 3-defect chain SHIPPED in
> v2.16.2 (PR #93: `checkProcessLiveness` 3-state, `tryEscalatedReping`, `classifyReclaimProbe` live-owner
> fail-fast + exit 75). The residual daemon-side sibling — `src/daemon/index.ts` `isProcessRunning`
> `catch → false` — is fixed on branch `feat/unattended-supervisor` (U-SPLIT: pure 3-state classifiers
> extracted to `src/shared/processLiveness.ts`; a probe `unknown` no longer reclaims a live daemon's lock,
> via `lockOwnerIsReclaimable`). Remaining: the dynamic autostart-triggered 2-instance race probe (live).
> The stale "Defect 1 = `isProcessAlive catch→false`" detail below refers to the LAUNCHER site,
> already superseded by v2.16.2.
- **What:** "Quit (keep sessions running)" 후 `npm start` 재실행 시 둘째 데몬이 `wmux-daemon-rizz-1` 폴백 파이프로 기동 → 첫 데몬의 세션 파이프 EADDRINUSE → reattach 실패 → 새 세션 → 터미널 초기화. persistence가 깨짐 + 데몬 중복(RAM 낭비).
- **Why:** (1) `ensureDaemon`이 살아있는 데몬에 재접속 안 하고 spawn. 유력 가설: 느린 OS probe(tasklist/WMI 타임아웃 머신)로 verify-ping 타임아웃→"데몬 없음" 오판 (false-death PR #87과 같은 근원 패턴). (2) `DaemonPipeServer.start()`(`src/daemon/DaemonPipeServer.ts:108-145`)의 `-N` 폴백이 *크래시 zombie*용인데 *살아있는 owner*와 구분 못 해 split-brain 허용.
- **Pros:** 영속성(핵심 기능) 정상화 + 중복 데몬 제거.
- **Cons:** 데몬 lifecycle = 최고위험 영역(여러 라운드 하드닝, issue #54). 성급한 패치 금지.
- **Context:** 별도 plan + codex 반복 리뷰. 순서: ① verify-timeout 동작 확인(launcher/DaemonRespawnController) → ② ensureDaemon이 live 데몬 확실히 재사용(timeout≠부재) → ③ `-N` 폴백이 live owner면 abort/양보. 메모리 project_duplicate_daemon_split_brain 참조.
- **Plan (grounded):** `plans/duplicate-daemon-split-brain.md` — 코드 대조로 3-defect
  체인 확정. **Defect 1 = `launcher.ts:64-77` `isProcessAlive`의 `tasklist timeout →
  catch → false`** (느린 머신서 live 데몬을 dead로 오판 → spawn). PR #87 ProcessMonitor와
  동일 안티패턴. ② kill+spawn은 keep-sessions 의도와 모순(켜둔 세션 파괴)이라 escalating
  re-ping + graceful 재사용으로 교체. ③ `-N` 폴백은 live-owner면 fail-fast→launcher 재접속.
  Step별 codex 리뷰 게이트. 미구현(코드 미변경).
- **Depends on:** 없음 (PR #87와 독립)
- **Priority:** P1 (persistence 깨짐)

## pty:resize "[UNKNOWN] rate limited" 폭주 + uncaught promise (P2 → renderer fix shipped)
- **Status:** Renderer side FIXED (this session, option (a) — minimal form). All
  three `useTerminal` resize call sites now route through a `sendResize` helper
  that `.catch()`es the RPC, so a "rate limited" / "not found" reject can no
  longer float as `Uncaught (in promise)`. On a "rate limited" reject it re-sends
  the *live* geometry once after the per-socket window clears (~1.1 s), so a
  resize dropped during a reconnect burst self-heals instead of stranding the PTY
  at a stale size (callers update lastSentCols/Rows *before* the send, so an
  identical re-fit was otherwise suppressed and never retried). tsc + full suite
  (2057) green. **Verify via GUI dogfood** (clean-daemon relaunch with many panes,
  watch console for the spam + confirm TUI geometry is correct).
- **Deferred (optional, needs codex review):** the *transport-layer* mitigations —
  (b) cross-terminal resize coalesce/debounce, or (c) exempting `pty:resize` from
  the `DaemonPipeServer` per-socket limit (`DaemonPipeServer.ts:413`,
  PER_SOCKET_RATE_LIMIT=50/s). These touch the security-sensitive rate limiter
  and were intentionally NOT done here; the renderer fix removes the symptom
  without altering the DoS guard. Revisit only if dogfood still shows dropped
  resizes under extreme pane counts (>50 simultaneous).
- **Dead-ptyId resize note:** a resize aimed at a swapped/disposed session returns
  "not found", which the main `pty:resize` handler already retries-then-logs and
  the new `sendResize` swallows — no uncaught reject, no infinite re-fire (the
  ResizeObserver disconnects on unmount).
- **Priority:** P2 (renderer symptom resolved; transport-layer option deferred)

## Cross-platform liveness/probe 신뢰성 일반화 (P3, follow-up of PR #87)
> **STATUS 2026-07-01:** the one confirmed BAD site (`isProcessAlive` / `isProcessRunning`
> `catch → false`) is now closed on BOTH processes — launcher via v2.16.2 (`checkProcessLiveness`),
> daemon via U-SPLIT (`feat/unattended-supervisor`, shared `processLiveness`). A broader sweep for any
> other latent sites is still open.
- **What:** Windows OS probe(tasklist/WMI)가 타임아웃하는 머신에서 "probe 실패=부재/죽음" 오해 패턴을 코드 전반에서 제거. PR #87이 ProcessMonitor kill 게이트는 고침. 같은 안티패턴이 남아있는지 audit(특히 데몬 verify, launcher PID 체크 — split-brain와 연결).
- **Why:** 동일 근원 버그(느린 probe→오판)가 여러 곳에 잠복. 원칙: probe 실패는 "unknown"이지 "absent/dead"가 아님.
- **Pros:** 느린/부하 머신에서 전반적 안정성.
- **Cons:** audit 범위 넓음.
- **Context:** `isAlive` catch→false 패턴 grep, launcher의 daemon verify 타임아웃 처리 확인. 메모리 project_processmonitor_false_death 참조.
- **Audit done (2026-06-01):** `plans/duplicate-daemon-split-brain.md` §"Cross-platform
  liveness/probe audit"에 사이트 표 작성. 확정 BAD 1건 = `launcher.ts:74` `isProcessAlive`
  `catch→false` (split-brain Defect 1로 승격). `getProcessImage` null→category(c) throw는
  안전, `ProcessMonitor`는 PR #87로 이미 정답. 원칙: timeout/예외 = `unknown`, 절대 `dead` 아님.
- **Depends on:** split-brain plan과 함께 진행 (Step ①이 이 항목을 흡수)
- **Priority:** P3 (P1 split-brain 작업 중 자연히 일부 커버됨)

## Substrate 3.0 lifecycle — daemon threshold config화 (P2, plan ready)
- **What:** 데몬 하드코딩 임계값 5개(`maxSessions` 200, memory `warn/reap/block` 500/750/1024MB, `suspendedTtlHours` 7d)를 config.json으로. `deadSessionTtlHours`는 이미 config(중복만 정리), `maxRecoverSessions`는 노출 안 하고 `maxSessions`에서 파생. + PROTOCOL.md에 lifecycle/config-contract 섹션.
- **Why:** 데몬이 lifecycle floor를 하드코딩 → substrate neutrality가 state/event/identity엔 적용되나 lifecycle엔 미적용. 운영자가 자원 floor를 조정 가능해야 + 계약 명문화.
- **Pros:** 저사양/고사양 머신별 한계 조정, substrate 일관성, "왜 이 값인가"를 계약으로 설명.
- **Cons:** 데몬 = 최고위험 영역. test-first + step별 codex + GUI dogfood 게이트 필수.
- **Context:** **plan ready + eng review 완료** — `plans/substrate-3.0-lifecycle-boundary.md`. 5 knobs + per-field clamp(idle만 0=off, 나머지 hard min + memory 절대상한) + per-field backfill(whole-file reset 금지) + default SSOT=createDefaultConfig. codex 13건 fold-in. 6파일 sequential(config.ts/types.ts/DaemonSessionManager/index/StateWriter/Watchdog). **codex P1 주의: ① acquireLock 조기 StateWriter.load(`index.ts:222`) config 경로 ② maxSessions 축소 시 overflow는 SUSPENDED 유지·dead 마킹 금지(`index.ts:412`) ③ memory block min floor + startup warning(silent brick 방지) ④ dead TTL은 per-session 영속(신규 세션만 적용).** 회귀 5건 필수.
- **Depends on:** 없음. 단 split-brain plan(P1)과 같은 daemon-lifecycle 영역 → 한 번에 두 architecture change 검증 어려움, 순차 권장.
- **Priority:** P2 (plan ready, defect성 — 하드코딩 floor가 저사양 머신서 조정 불가)

## Fleet activity line — pipe payload 슬림화 (P3, follow-up of fleet-activity-line-hook)
- **What:** `agent.activity`(PostToolUse) envelope에서 `tool_input`의 큰 필드(Edit old/new string 등)를 bridge에서 잘라 named pipe로 안 보내게. 활동 문자열 추출은 이미 main(`src/shared/activitySummary.ts`)에서 하므로 full tool_input 불필요.
- **Why:** 현재 PostToolUse가 full payload를 pipe로 보냄(기존 동작, fleet-activity PR이 만든 비용 아님). source에서 슬림 가능.
- **Pros:** pipe 트래픽 감소(특히 큰 Edit).
- **Cons:** bridge(.mjs) 변경 → 기존 사용자 `wmux setup-hooks` 재실행 필요(bridge-version skew). 그래서 v1에서 분리.
- **Context:** `plans/fleet-activity-line-hook.md` "Deferred" 참조. bridge=`integrations/claude/bin/wmux-bridge.mjs`.
- **Depends on:** fleet-activity-line ship 후.
- **Priority:** P3

## Fleet activity line — UserPromptSubmit "현재 요청" 신호 (P2, follow-up)
- **What:** setup-hooks에 UserPromptSubmit 추가 → "↳ {사용자 마지막 요청}"을 activity로. PostToolUse는 completion이라 "방금 한 것"인데, UserPromptSubmit이 "지금 뭐 하는지"의 더 정확한 신호.
- **Why:** v1 activity는 과거형(도구 완료 후). 진짜 "right now"는 사용자 요청 — 조종석 가치를 키움.
- **Pros:** "지금 X 작업 중" 의미가 더 정확.
- **Cons:** setup-hooks 변경(재실행 필요) + prompt truncation + 프라이버시(요청 텍스트 표시).
- **Context:** `plans/fleet-activity-line-hook.md` "Honest scope" + "Optional enrichment". `HOOK_TO_KIND`(wmux-bridge.mjs:52)에 매핑 추가.
- **Depends on:** fleet-activity-line ship 후.
- **Priority:** P2

## (bug) transient per-ptyId 맵이 surface close 시 leak (P3, found in fleet-activity adversarial review)
- **What:** `surfacePorts`(및 `surfaceAgentStatus`)가 `closePane`/`closeSurface`에서 정리 안 됨 → 죽은 ptyId 엔트리 잔존. fleet-activity PR이 `surfaceActivity`는 양 사이트에서 정리하지만 기존 두 맵은 미수정.
- **Why:** 적대 리뷰가 "surfacePorts를 cleanup 선례로 쓰지 말라(그 자체로 leak)"며 발견. 장기 세션서 죽은 ptyId 누적.
- **Pros:** store 위생, 미세 메모리.
- **Cons:** 영향 미미(엔트리 작음).
- **Context:** `closePane`(paneSlice.ts:322) + `closeSurface`(surfaceSlice.ts:132)에 delete 추가. fleet-activity가 정리 패턴을 이미 깔아둠.
- **Depends on:** 없음.
- **Priority:** P3

## (security) Unscoped plugin events.poll leaks cross-workspace lifecycle events (P2)
- **What:** `PluginFrame.tsx:89`가 `events.poll`을 `{}`(workspaceId 없음)로 호출 → `events.rpc.ts:97` `caller ? e.workspaceId===caller : true`가 unscoped 호출에 **전 워크스페이스**의 `pane.created/closed/focused/process.*`를 통과시킴. `events.subscribe` capability를 declare한 플러그인이 다른 ws의 lifecycle을 관측 가능. `a2a.task`만 unscoped서 fail-closed.
- **Why:** substrate 격리 원칙 위반. `a2a.task`의 `!!caller &&` fail-closed 절이 lifecycle 타입엔 없음. focus-rpc 리뷰(plan-eng-review, security 전문가)서 발견 — 선재 버그이며 focus 픽스가 만든 게 아니지만 EMIT이 약간 넓힘.
- **Pros:** 플러그인 샌드박스의 cross-ws 관측 차단.
- **Cons:** 둘 중 택1 — (a) `PluginFrame`이 호스트 프레임의 workspaceId를 poll에 실어보냄, 또는 (b) unscoped poll에서 lifecycle 타입도 fail-closed(`a2a.task`처럼). (a)가 깔끔하나 플러그인이 여러 ws를 의도적으로 보는 합법 케이스가 있는지 확인 필요.
- **Context:** `src/main/pipe/handlers/events.rpc.ts:93-104`(post-filter), `src/renderer/plugins/PluginFrame.tsx:88-89`(unscoped poll). 시작점=poll params에 workspaceId 주입 vs 필터 fail-closed 결정.
- **Depends on:** 없음 (focus 픽스와 독립).
- **Priority:** P2 (보안 격리)

## surface.focus capability를 pane.read로 통일 (P3)
- **What:** `methodCapabilityMap.ts:181` `surface.focus` = `wmux.internal` → `pane.read`로(sibling `pane.focus:186`과 일치). first-party MCP에 surface.focus 도구 노출 + 서드파티 declarable.
- **Why:** 동일 blast radius(focus 마커 이동)인 두 메서드가 다른 capability 클래스. security 전문가: 방어 가능(grandfather 경로 + self-asserted clientName이라 wmux.internal 라벨이 same-user 대상 보안 이득 0)하나 coherence 결함.
- **Pros:** capability 대칭, surface.focus가 sibling처럼 first-party/declarable.
- **Cons:** capability 정책 변경 = 별도 검토. focus ws-scoping 픽스에 묶지 말 것(orthogonal).
- **Context:** focus-rpc 리뷰서 식별. `src/main/mcp/methodCapabilityMap.ts:181/186`, `firstParty.ts` allowlist.
- **Depends on:** focus ws-scoping 픽스 ship 후.
- **Priority:** P3

## Per-target ownership authz for focus/close family (P3)
- **What:** globally-unique id 해석 메서드(`pane.focus`/`surface.focus`/`pane.close`/`surface.close`)에 호출자 ws 소유권 게이트 추가 — 공유 `resolvePaneOwner(id)` 헬퍼를 authz 지점으로.
- **Why:** id 보유 시 어느 ws의 pane이든 focus/close 가능. ids는 unguessable + `pane_list`/`surface_list`는 ws-scoped라 열거 불가지만, 적대적 멀티에이전트면 per-target authz가 정답. security 전문가: focus는 close(#256, pane 파괴)보다 약하므로 close-family부터.
- **Pros:** 진짜 적대적 멀티에이전트 격리.
- **Cons:** id-as-capability 모델을 owner-gate로 바꾸는 건 #256 close까지 소급 = 넓은 변경. 현 위협모델(single-user)에선 과함.
- **Context:** focus-rpc 리뷰서 식별. close-family부터 게이트, focus를 같은 패스에. 시작점=`useRpcBridge.ts:550` all-ws scan을 `resolvePaneOwner`로 추출 후 caller-ws 비교.
- **Depends on:** 구체적 적대 멀티에이전트 위협 리포트 발생 시.
- **Priority:** P3

## LanLink: unify the double daemon status probe (P3)
- **What:** `LanLinkSection`(PR-3)과 `LanLinkPairingSection`(PR-5)이 각각 `lanlink.status`를 폴링 → LanLink 탭 열 때 status RPC 2회. 상위 컨테이너가 status를 한 번 읽어 둘에 props로 공유.
- **Why:** codex review(PR-5 #275, codex P2). read-only minor지만 중복 probe.
- **Pros:** status RPC 1회, enabled/nic 단일 SoT.
- **Cons:** `LanLinkSection`을 props 받게 리팩터(PR-5 "LanLinkView 0편집" 원칙은 follow-up서 완화 가능).
- **Context:** `SettingsPanel.tsx` activeTab==='lanlink' 렌더(`<LanLinkSection/><LanLinkPairingSection/>`) → 상위 LanLinkTab 컨테이너로 status lift.
- **Depends on:** —
- **Priority:** P3

## Codex notify chaining when a foreign notify already exists (P3)
- **What:** codex resume 캡처(`wmux-codex-notify`) 등록 시 `~/.codex/config.toml`에 이미 사용자/외부 `notify`가 있으면, 현재는 SKIP(미등록 + `wmux mcp` status에 "codex notify: skipped (foreign present)" 노출)한다. 이를 프록시 체인으로 승격: 기존 notify를 wmux-owned 위치에 백업 → wmux notify가 캡처 후 백업한 원래 명령을 동일 argv 페이로드로 이어 실행(exit code 포워딩) → unregister 시 원복.
- **Why:** codex `notify`는 단일 슬롯이라 사용자가 이미 자기 notify(데스크톱 알림/로깅 등)를 쓰면 SKIP은 그 유저의 codex 자동 resume 캡처를 조용히 포기시킨다(pill `resume --last` 폴백은 유지되므로 break은 아님, soft downgrade). GLM-5.2 outside voice(P0)가 지적. 체인이면 100% 캡처 + 사용자 훅 둘 다 보존.
- **Pros:** foreign-notify 유저도 정확-id codex resume 획득. SKIP의 유일한 약점(침묵적 다운그레이드) 완전 해소.
- **Cons:** 매 턴 두 프로그램 스폰 + argv 중계 + exit code 포워딩 + 이중래핑 감지(이미 wmux-wrapped인 notify를 또 감싸는 버그 방지) + 백업/복원 생명주기. **P1#1(notify 실행 지연/실패→codex 턴 stall) 리스크를 두 배로 넓힘** — 그래서 self-contained JS 미러 대신 더 무거운 조율 필요.
- **Context:** 착수점 = `src/shared/mcpRegistration.ts`의 foreign-notify 분기(현재 SKIP+로그). codex 캡처는 `integrations/codex/bin/wmux-codex-notify.mjs`(self-contained JS, claude bridge 미러). 백업 저장 위치는 wmux-owned 파일(config.toml 주석은 TOML RMW로 소실되기 쉬움).
- **Depends on:** ★V1(codex notify가 fire-and-forget인가 await+timeout인가) 실측 선행 — await 모델이면 체인이 턴 지연/정지를 유발하는지부터 판단해야 함. 그리고 실제 foreign-notify wmux 유저 발생 시.
- **Priority:** P3


## Resource budget as a product contract (P3, from app-weight autoplan 2026-07-16)
- **What:** Explicit budgets: baseline RAM, incremental RAM per interactive pane / background job, max background CPU, recovery SLA — enforced or at least asserted in perf-bench.
- **Why:** Without a contract every subsystem (plugins, browser, Fleet, channels) consumes freely and "weight reduction" epics recur (codex CEO voice #16).
- **Context:** plans/app-weight-reduction-2026-07-16.md CEO review. Needs corrected private-WS baseline (P0-0) first.
- **Effort:** M (human) → S (CC). **Priority:** P3.

## Battery/power-aware polling (P3, from app-weight autoplan 2026-07-16)
- **What:** Slow daemon/main polls (liveness, portWatch, metadata) on battery / power-saver mode.
- **Why:** Laptop users pay idle CPU in battery life; Windows exposes power status events.
- **Context:** plans/app-weight-reduction-2026-07-16.md P1. Do after P1 lands (needs the knob plumbing from P1-6).
- **Effort:** S. **Priority:** P3.

## Default-shell weight surfaced at onboarding/Settings (P3, from app-weight autoplan 2026-07-16)
- **What:** Surface per-shell memory cost where the default shell is chosen (pwsh ≈ 95 MB WS / ~22 MB private per pane vs cmd ≈ 10 MB); optionally offer a lighter default.
- **Why:** Users multiply shell weight by pane count without knowing; informed choice beats silent policy.
- **Context:** plans/app-weight-reduction-2026-07-16.md CEO expansion scan. UX-facing → needs design pass.
- **Effort:** S-M. **Priority:** P3.

## Per-pane resource badge / footprint attribution (P2-P3, from app-weight autoplan 2026-07-16, owner-deferred at final gate)
- **What:** Pane-level RAM/CPU badge ("this Claude session: 1.2 GB") + kill/park affordance; possibly a Settings footprint panel.
- **Why:** Corrected private-WS measurement will likely show agent CLI processes dominate — weight wmux cannot shrink. Attribution converts "wmux is heavy" complaints into correct blame + user action. No competitor has it (CEO voice F15).
- **Context:** plans/app-weight-reduction-2026-07-16.md. Re-evaluate AFTER P0-0 corrected measurements land; needs its own design pass (UI surface).
- **Depends on:** P0-0 measurement fixes. **Effort:** M → S-M (CC). **Priority:** P2-P3.
