# wmux Claude 알람 시스템 개선 — 26개 컨셉 검토 요청

## 배경

D:\wmux는 Windows 터미널 멀티플렉서. Claude Code 같은 AI 에이전트가 작업 끝났을 때 사용자에게 알리는 기능을 가지고 있음.

**현재 우리 시스템 (output sniffing 방식)**:
- `src/main/pty/PTYBridge.ts` — PTY 출력을 middleware 체인으로 가공
- `src/main/pty/AgentDetector.ts` — Claude/Aider/Codex/Gemini/OpenCode/Copilot의 idle 프롬프트 정규식 패턴 매칭. Gate(배너) 매칭 후에만 idle 패턴 활성화. 10초 suppression으로 중복 방지.
- `src/main/pty/ActivityMonitor.ts` — 3초간 2KB 출력 → "active", 5초 무출력 → "idle". 패턴 안 잡힐 때 fallback.
- `src/main/notification/sendNotification.ts` — IPC로 renderer에 알람 전달
- `src/main/notification/ToastManager.ts` — 윈도우 포커스 없을 때 OS-level toast
- `src/renderer/hooks/useNotificationListener.ts` — 알람 수신 → addNotification + pushToast + sound
- `src/renderer/components/Notification/NotificationPanel.tsx` — 알람 센터 패널 (이미 존재)
- `src/renderer/components/Toast/ToastContainer.tsx` — 인앱 토스트
- workspace별 unreadCount 일부 있음, 사운드 throttle 2초 있음

**경쟁 시스템 (wmux-master, Amir Lehmam 작)**:
Claude Code 공식 PostToolUse/Stop hook을 `~/.claude/settings.json`에 자동 등록해서 named pipe로 신호 받음. NotificationBell (titlebar 종 + 배지), NotificationRing (pane 테두리), workspace별 unread + 200개 cap + read-first eviction 등을 갖춤.

**라이센스 제약**: 저쪽은 LICENSE 파일은 MIT인데 README는 AGPL이라고 표시 — 모순. 보수적으로 AGPL 가정. 따라서 **코드 차용 금지, 컨셉만 차용**. clean room 구현 필요.

## 우리 메모리 제약 (반드시 준수)

- `feedback_substrate_neutrality.md` — substrate에 opinionated per-session/per-workspace 로직 금지. 사용자 환경(`~/.claude/`) 자동 편집은 opt-in이어야 함.
- `feedback_no_ship_without_user_verification.md` — 사용자 dogfood 끝나기 전 ship/push 금지. 플랜은 검증 단계 포함.
- `feedback_pr_strategy.md` — 외부 리뷰어 있는 ship 단위는 1 PR + commits. self-review 분리는 stacked PR로.
- `feedback_push_confirm.md` — git push 전 사용자 확인 필수.
- `project_substrate_10_plan.md` — Substrate 3.0 진행 중. 알람은 substrate가 아니라 Electron app layer.

## 26개 적용 후보 컨셉

### 알람 정확도 (Hook 기반)
1. Claude Code `PostToolUse` Hook 수신 — `~/.claude/settings.json`에 등록된 hook이 wmux pipe로 RPC 호출
2. `Stop` hook 활용 — turn 끝났을 때 정확한 신호 (현재 5초 idle 추측 대체)
3. `SubagentStop` hook — 서브에이전트 종료 시점 별도 처리
4. `SessionStart` hook — 새 Claude 세션 시작 시 metadata 리셋 트리거
5. Hook 신호와 AgentDetector 신호 간 중복 억제 — Hook 우선

### 알람 UI
6. Titlebar NotificationBell — 종 아이콘 + 전역 미읽음 배지
7. Pane 테두리 NotificationRing — flash → glow 2단계 전환
8. Pane focus 시 자동 markRead
9. timeAgo 포맷 — "just now / 3m ago / yesterday"

### 사용자 컨트롤
10. Toast notification on/off 토글
11. Taskbar flash on/off 토글 (Electron flashFrame)
12. Pane ring on/off 토글
13. Pane flash animation on/off 토글
14. Notification sound: default / none
15. 사운드 throttle 2초 (우리 이미 있음, 유지)

### 데이터 관리
16. Workspace별 unreadCount 분리 집계
17. MAX_NOTIFICATIONS = 200 cap
18. 읽은 알람 우선 eviction (LRU 아닌 read-first)
19. markAllRead(workspaceId?) — workspace 단위 또는 전역
20. jumpToUnread() — 최근 미읽음으로 점프

### 자동 설정
21. `~/.claude/settings.json` 자동 편집 + Marker 보호 (`<!-- wmux:start --> ... <!-- wmux:end -->`)
22. hook 자동 설치 opt-in 토글 — 기본 OFF
23. Hook script 절대 경로 + ASAR 외부 위치

### 신호 라우팅
24. workspaceId hint 기반 알람 라우팅 — MCP 호출자가 자기 workspace 알 때
25. 활성 surface 알람 자동 무시 — 이미 보고 있는 화면이면 토스트/배지 안 띄움 (우리 이미 일부 있음)
26. CLI `wmux notify` 명령 — 사용자/스크립트 직접 트리거

## 요청 사항

1. 26개 컨셉을 **검토**하고 다음을 답해주세요:
   - 어느 컨셉이 **최대 가치**인가? (top 5)
   - 어느 컨셉이 **시간 낭비/위험**인가?
   - **빠진 컨셉**은 무엇인가? (우리 시스템에 더 좋은 아이디어가 있다면)
   - 라이센스 clean room 관점에서 **위험한 패턴**이 있는가?

2. **구현 플랜** 작성:
   - Phase로 묶어서 (Phase 1: 정확도 / Phase 2: UI / Phase 3: 설정 등 자유)
   - 각 Phase의 PR scope (우리 PR 전략은 "외부 리뷰 있는 ship 단위 1 PR + commits")
   - 각 Phase별 위험도 + 의존성
   - 검증 방법 (테스트, dogfood 시나리오)
   - 예상 LOC / 파일 변경 범위

3. **substrate neutrality 충돌** 가능성 평가 — 어떤 컨셉이 사용자 환경/세션 가정을 침해할 우려가 있는가?

4. 우리 시스템에 **이미 있는 기능**이 있다면 명시 — 중복 작업 방지.

답변 형식: 마크다운. 결론부터 → 근거 → 단계 플랜. 분량 자유.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (SELECTIVE_EXPANSION) | 26 proposed, 17 accepted, 7 to separate P1 plan, 1 to TODOS P3 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (FULL_REVIEW) | 4 issues (2 stamped fixes, 2 → TODOS), 12 regression tests required, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | score: 5/10 → 9/10, 11 decisions added (hierarchy + state matrix + burst stack + emoji keep + Pane CSS spec + motion + var() rule + 5×ARIA) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 decisions outstanding.

**OUTSIDE VOICE:** Skipped (both reviews) — the 26 concepts list itself functioned as an external outside voice; CEO surfaced cross-model tension on hook timing and surface scope, user resolved both. No second codex pass needed.

**CEO PLAN:** `~/.gstack/projects/openwong2kim-wmux/ceo-plans/2026-05-21-notification-26-concepts.md`
**TEST PLAN:** `~/.gstack/projects/openwong2kim-wmux/rizz-main-eng-review-test-plan-20260521-220029.md`

**KEY DECISIONS (CEO + ENG):**
- Mode: SELECTIVE EXPANSION
- Approach: B (UX-First Expansion). Original estimate ~3h CC was over — eng found 8 of 17 ACCEPTED items already exist. Real new work ~2h CC.
- Hook cluster (1-5, 21-23): separate `plans/agent-hook-integration.md` P1 plan, dogfood-gated.
- License: attribution not required, clean room.
- Mute policy: unread preserved in panel; bell badge excludes muted workspaces.
- Burst protection: global debounce 500ms + cluster grouping via `createThrottler(ms)` factory (replaces module-scope `lastSoundTime` anti-pattern).
- Listener architecture: `useNotificationPolicy(payload, settings, target, focusState) → NotificationActions[]` pure function; `useNotificationListener` becomes thin dispatcher.
- jumpToUnread: navigate to most recent unread workspace, NO markRead (navigation only).
- Cap: keep current 500 (rejected external 200 recommendation — daemon long-running sessions justify higher).
- Cap eviction read-first policy: already exists, gets regression test.
- Stamp fixes: `BrowserWindow.isDestroyed()` flashFrame guard, timestamp-cutoff markRead, onPaneDeleted ring cleanup, alive-workspace filter on jumpToUnread, activeSurface null safety, throttle cleanup fn on unmount.

**ALREADY EXISTING (verified by eng review, 8 of 17):**
- 10 toast on/off — `uiSlice.ts:98, 415`
- 14 sound on/off — `uiSlice.ts:52, 321`
- 15 sound throttle 2s — `useNotificationListener.ts:36-37, 121-128`
- 16 per-workspace unreadCount — `MiniSidebar.tsx:44`
- 18 read-first eviction — `notificationSlice.ts:24-32`
- 19 markAllReadForWorkspace + clearNotifications — `notificationSlice.ts:47, 53`
- 24 workspaceId hint routing — `useNotificationListener.ts:49-78`
- 25 active surface skip — `useNotificationListener.ts:92-102`

**ACTUAL NEW WORK (9 items + 1 refactor + 12 regressions) — Design review correction applied:**
- 6 NotificationBell → **StatusBar `●{n}` enhancement** (click handler + ARIA + focus-visible + min-click-area on existing element, NOT a new component) — ~25-30 LOC
- 7 Pane NotificationRing flash→glow (paneSlice state + PaneFrame CSS using `var(--accent-blue)`)
- 8 Pane focus auto markRead (timestamp cutoff)
- 9 timeAgo format (NotificationPanel render util)
- 11 Taskbar flashFrame (main IPC handler + listener call)
- 12, 13 paneRingEnabled + paneFlashEnabled toggles (uiSlice + SettingsPanel)
- 19+ markAllRead global mode (notificationSlice new action)
- 20 jumpToUnread (selector + setActiveWorkspace)
- E4 per-workspace mute (workspaceSlice metadata + listener guard)
- CEO refactor: useNotificationPolicy split + createThrottler factory
- 12 regression tests for previously untested existing logic (IRON RULE)

**DEFERRED TO SEPARATE P1 PLAN:** 1, 2, 3, 4, 5, 21, 22, 23 → `plans/agent-hook-integration.md`

**DEFERRED TO TODOS.md (P3):**
- 26 CLI notify
- `useNotificationListener.ts:97` workspace-find non-null assertion → graceful fallback
- `findSurfaceByPtyId` / `findActiveLeaf` traversal helpers → `utils/paneTraversal.ts` extraction

**REMOVE FROM TODOS.md AT IMPLEMENTATION:** E4 per-workspace mute (implemented in this PR)

**FAILURE MODES:** 12 paths mapped, 0 critical gaps. All test-covered + error-handled. 1 pre-existing risk flagged to TODOS (line 97 assertion).

**PARALLELIZATION:** Sequential implementation. All changes converge on `slices/` + `hooks/` + `components/Notification/`. One PR, one developer.

**DESIGN DECISIONS ADDED (Pass 1-7, 11 stamped + 2 user-resolved):**

*5-channel visual hierarchy* (Pass 1):
```
                  Toast        →  immediate eye (foreground, transient)
                  Pane ring    →  peripheral (active area, source identification)
                  Sidebar dot  →  side-eye (continuous status)
                  StatusBar `●{n}`  →  scan (top bar, accumulator)
                  taskbar flash →  OS chrome (unfocused-only attention recall)
```
Constraint worship: minimum effective set = Toast + StatusBar `●{n}`.

*State coverage matrix* (Pass 2):
```
SURFACE           | no unread | NEW arrival     | 1+ unread (steady) | active surface | muted ws        | unfocused
------------------|-----------|-----------------|--------------------|----------------|-----------------|----------
Toast             | —         | 4-6s autohide   | — (already seen)   | suppressed     | suppressed      | (OS toast separate)
Pane ring         | none      | flash 500ms     | steady glow        | suppressed     | suppressed      | same
Sidebar dot       | idle icon | completed→pulse 2s | completed icon  | unchanged      | unchanged       | unchanged
StatusBar `●{n}`  | hidden    | n+1, flash 250ms | shown steady      | unchanged      | excluded from n | unchanged
taskbar flashFrame| —         | flash once      | —                  | suppressed     | suppressed      | TRIGGER (only here)
```

*Burst Toast policy* (Pass 2, user-resolved): individual Toast per event, ToastContainer max-stack = 3, oldest fades. Each Toast labels its workspace.

*Notification icons* (Pass 4, user-resolved): keep existing emoji set (🤖❌⚠️ℹ️) — scope hygiene; emoji-vs-ASCII glyph debate is out of scope.

*Pane ring CSS spec* (Pass 4):
```
flash:  border-color: var(--accent-blue);
        box-shadow: 0 0 0 2px var(--accent-blue) inset;
        transition: box-shadow 500ms ease-out;
glow:   border-color: var(--accent-blue);
        opacity: 0.6;  (1px, no shadow)
cleared: border-color: var(--bg-surface);
         transition: border-color 200ms;
prefers-reduced-motion:
  flash → instant border change (no transition)
  glow  → instant border change (no transition)
prefers-reduced-motion + high-contrast:
  thicker 2px border instead of opacity
```

*CSS variable enforcement* (Pass 5): all new visual elements must consume `var(--accent-*)`, `var(--bg-*)`, `var(--text-*)`. No literal hex. themes.ts already provides per-theme values across all 8 builtin themes (catppuccin-mocha, monochrome, stars-and-stripes, red-dynasty, nightowl, void, hinomaru, taegeuk).

*Accessibility spec* (Pass 6):
- StatusBar `●{n}`: `role="button"`, `aria-label="N unread notifications, click to open panel"`, Enter/Space activates, `focus-visible` outline `var(--accent-blue)` 2px, click area ≥ 24×24px.
- NotificationPanel: `role="dialog"`, `aria-label="Notification center"`, initial focus on first unread, Esc closes, Tab cycles list, screen-reader announces "{agent type}, {title}, {time ago}, {read/unread}".
- Pane ring: visual only, decorative; screen-reader users rely on Panel. prefers-reduced-motion respected (no 500ms transition).
- Toast: `role="status" aria-live="polite"`, hover/focus pauses auto-dismiss, announced once.
- Sound: always supplement, never sole channel; "none" choice respected.
- Settings toggles: native `<input type="checkbox">` with explicit `<label>`, `aria-describedby` for explanation text.
- Contrast: implementation verifies `--accent-blue` on `--bg-mantle/base` ≥ 4.5:1 across all 8 builtin themes.

*Bell badge 999+ clipping* (Pass 7): use literal "999+" string (3 chars). Don't use "1k+" or "∞" — utility language wins.

**TWO CRITICAL CORRECTIONS prior reviews missed:**
1. **StatusBar.tsx:127-131 already renders `● {unreadCount}`** — existing `accent-blue` dot + count. The "NotificationBell NEW component (~80 LOC)" eng estimate is wrong. Real work: add click handler + ARIA + `focus-visible` outline + minimum click area = ~25-30 LOC, no new component file.
2. **wmux uses standard Electron frame (OS chrome)** — `createWindow.ts` has no `frame: false` or `titleBarStyle`. The external advice's "Titlebar NotificationBell" maps to **StatusBar (top bar of main area)**, not the OS titlebar. CEO + Eng both inherited "Titlebar" as the location — correct anchor is StatusBar.

**VERDICT:** CEO + ENG + DESIGN CLEARED — ready to implement. Updated scope estimate: ~1.5h CC (NotificationBell scope shrunk per Design correction). Hook P1 plan (`plans/agent-hook-integration.md`) must be drafted before merge for traceability.
