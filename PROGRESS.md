# WinMux 구현 진행 상황

## 프로젝트 위치
`D:\wykim\8. coding\26\1.wmux`

## 전체 계획 문서
- PRD: `WinMux_PRD_v1.0.md` (프로젝트 루트)

---

## Phase 1 완료 ✅

### Step 1: 프로젝트 스캐폴딩 ✅
### Step 2: ConPTY PoC — node-pty + xterm.js 기본 연결 ✅
### Step 3: 공유 타입 + Zustand 스토어 ✅
### Step 4: Sidebar + Workspace 관리 ✅
### Step 5: Pane 분할 (react-resizable-panels) ✅
### Step 6: Surface 탭 ✅
### Step 7: 키보드 단축키 ✅
### Step 8: 세션 저장/복원 + Git 초기화 ✅

---

## Phase 2 완료 ✅

- Notification 타입 + notificationSlice
- OSC 7/9/99/777 파서 + IPC 채널
- Notification Ring 애니메이션 + 알림 수신 훅
- Sidebar 알림 배지 + 메타데이터 표시
- Git Branch / CWD / Listening Ports 수집 (5초 폴링)
- Notification Panel (Ctrl+I)
- Windows Toast + AI Agent 감지 (Claude Code, Cursor, Aider)

---

## Phase 3 완료 ✅

- JSON-RPC 프로토콜 정의 (`src/shared/rpc.ts`)
- Named Pipe 서버 (`\\.\pipe\winmux`) + RpcRouter
- RPC 핸들러: workspace/surface/pane/input/notify/meta/system
- Main ↔ Renderer IPC 브릿지 (`_bridge.ts`, `useRpcBridge.ts`)
- winmux CLI (`src/cli/`) — 전체 명령 세트, --json 모드
- Command Palette (Ctrl+K) — 퍼지 검색, 키보드 네비게이션
- PTY 환경변수 자동 주입 (WINMUX_WORKSPACE_ID, SURFACE_ID, SOCKET_PATH)

---

## Phase 4 완료 ✅

- In-App Browser: WebView2 `<webview>` 태그, Ctrl+Shift+L 분할 열기
  - URL 바, Back/Forward/Reload, DevTools, 페이지 타이틀
- Vi Copy Mode: Ctrl+Shift+C, h/j/k/l/w/b/0/$, Visual 선택, y 복사
- 커스텀 알림 사운드: Web Audio API, 타입별 음정
- 다국어 UI (i18n): en/ko/ja/zh, 경량 함수 기반
- Settings Panel: Ctrl+, (언어, 사운드, 업데이트)
- Auto Updater: Electron autoUpdater 구조 + IPC

---

## 현재 파일 구조

```
winmux/
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── pty/
│   │   │   ├── PTYManager.ts        ← 환경변수 주입
│   │   │   ├── PTYBridge.ts         ← OSC파서/Agent감지 통합
│   │   │   ├── OscParser.ts
│   │   │   ├── AgentDetector.ts
│   │   │   └── ShellDetector.ts
│   │   ├── pipe/
│   │   │   ├── PipeServer.ts        ← Named Pipe 서버
│   │   │   ├── RpcRouter.ts
│   │   │   └── handlers/
│   │   │       ├── _bridge.ts       ← Main→Renderer IPC 유틸
│   │   │       ├── workspace.rpc.ts
│   │   │       ├── surface.rpc.ts
│   │   │       ├── pane.rpc.ts
│   │   │       ├── input.rpc.ts
│   │   │       ├── notify.rpc.ts
│   │   │       ├── meta.rpc.ts
│   │   │       └── system.rpc.ts
│   │   ├── ipc/
│   │   │   ├── registerHandlers.ts
│   │   │   └── handlers/
│   │   │       ├── pty.handler.ts
│   │   │       ├── session.handler.ts
│   │   │       ├── shell.handler.ts
│   │   │       └── metadata.handler.ts
│   │   ├── metadata/
│   │   │   └── MetadataCollector.ts
│   │   ├── notification/
│   │   │   └── ToastManager.ts
│   │   ├── updater/
│   │   │   └── AutoUpdater.ts
│   │   ├── session/
│   │   │   └── SessionManager.ts
│   │   └── window/
│   │       └── createWindow.ts      ← webviewTag: true
│   ├── preload/
│   │   └── index.ts                 ← pty/shell/session/notification/metadata/rpc/updater API
│   ├── renderer/
│   │   ├── index.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Browser/
│   │   │   │   ├── BrowserPanel.tsx
│   │   │   │   └── BrowserToolbar.tsx
│   │   │   ├── Sidebar/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   └── WorkspaceItem.tsx
│   │   │   ├── Terminal/
│   │   │   │   ├── Terminal.tsx
│   │   │   │   └── ViCopyMode.tsx
│   │   │   ├── Pane/
│   │   │   │   ├── PaneContainer.tsx
│   │   │   │   ├── Pane.tsx
│   │   │   │   └── SurfaceTabs.tsx
│   │   │   ├── Notification/
│   │   │   │   └── NotificationPanel.tsx
│   │   │   ├── Palette/
│   │   │   │   ├── CommandPalette.tsx
│   │   │   │   └── PaletteItem.tsx
│   │   │   ├── Settings/
│   │   │   │   └── SettingsPanel.tsx
│   │   │   └── Layout/
│   │   │       └── AppLayout.tsx
│   │   ├── stores/
│   │   │   ├── index.ts
│   │   │   └── slices/
│   │   │       ├── workspaceSlice.ts
│   │   │       ├── paneSlice.ts
│   │   │       ├── surfaceSlice.ts
│   │   │       ├── uiSlice.ts
│   │   │       └── notificationSlice.ts
│   │   ├── hooks/
│   │   │   ├── useKeyboard.ts
│   │   │   ├── useTerminal.ts
│   │   │   ├── useNotificationListener.ts
│   │   │   ├── useNotificationSound.ts
│   │   │   ├── useRpcBridge.ts
│   │   │   └── useViCopyMode.ts
│   │   ├── i18n/
│   │   │   ├── index.ts
│   │   │   └── locales/
│   │   │       ├── en.ts
│   │   │       ├── ko.ts
│   │   │       ├── ja.ts
│   │   │       └── zh.ts
│   │   └── styles/
│   │       └── globals.css
│   ├── cli/
│   │   ├── index.ts
│   │   ├── client.ts
│   │   ├── utils.ts
│   │   └── commands/
│   │       ├── workspace.ts
│   │       ├── surface.ts
│   │       ├── pane.ts
│   │       ├── input.ts
│   │       ├── notify.ts
│   │       └── system.ts
│   └── shared/
│       ├── constants.ts
│       ├── types.ts
│       ├── rpc.ts
│       └── electron.d.ts
```

---

## 키보드 단축키 (전체)

| 키 | 동작 |
|---|------|
| Ctrl+B | 사이드바 토글 |
| Ctrl+N | 새 워크스페이스 |
| Ctrl+Shift+W | 워크스페이스 닫기 |
| Ctrl+1~9 | 워크스페이스 전환 |
| Ctrl+D | 수평 분할 |
| Ctrl+Shift+D | 수직 분할 |
| Ctrl+T | 새 Surface |
| Ctrl+W | Surface 닫기 |
| Ctrl+Shift+]/[ | Surface 전환 |
| Alt+Ctrl+방향키 | Pane 포커스 이동 |
| Ctrl+Shift+R | 워크스페이스 이름변경 |
| Ctrl+I | 알림 패널 토글 |
| Ctrl+Shift+U | 최신 unread 알림으로 점프 |
| Ctrl+K | Command Palette |
| Ctrl+Shift+L | 브라우저 분할 열기 |
| Ctrl+Shift+C | Vi Copy Mode 진입 |
| Ctrl+, | 설정 패널 |

---

## Zustand Store

```
useStore (immer middleware)
├── workspaceSlice: workspaces[], activeWorkspaceId, CRUD + updateWorkspaceMetadata
├── paneSlice: splitPane(), closePane(), focusPaneDirection()
├── surfaceSlice: addSurface(), closeSurface(), addBrowserSurface(), next/prevSurface()
├── uiSlice: sidebarVisible, notificationPanelVisible, commandPaletteVisible,
│            viCopyModeActive, settingsPanelVisible, notificationSoundEnabled, locale
└── notificationSlice: notifications[], addNotification, markRead, clearNotifications
```

---

## 알려진 이슈 & 주의사항

### 1. node-pty 빌드 (경로 공백 문제)
프로젝트 경로에 공백이 포함되어 있어 node-gyp 빌드 시 winpty bat 스크립트 실패.
**해결**: `node_modules` 내 3개 파일 수동 수정 후 `npx electron-rebuild -f -w node-pty` 실행.

---

---

## Phase 6 완료 ✅ — 비용 모니터링 대시보드

### 생성 파일
- `src/renderer/company/CostEstimator.ts` — PTY 출력 글자 수 + 활성 시간 기반 비용 추정 클래스
- `src/renderer/components/Company/CostDashboard.tsx` — 부서별/멤버별 비용 트리 UI (Catppuccin Mocha)

### 수정 파일
- `src/renderer/stores/slices/companySlice.ts`
  - `memberCosts: Record<string, number>` — memberId별 누적 비용 Map
  - `sessionStartTime: number | null` — 세션 시작 시간
  - `addMemberCost(memberId, amount)` — 개별 비용 누적 + totalCostEstimate 자동 동기화
  - `resetCosts()` — 비용 초기화 + 세션 시간 리셋
  - `setSessionStartTime(time)` — 세션 시간 설정
  - `createCompany` → 자동 세션 시작 시간 설정
- `src/renderer/components/Company/CompanySidebar.tsx`
  - 사이드바 하단에 `<CostDashboard />` 고정 배치 (접기/펴기 지원)
  - `flex-1 min-h-0` 레이아웃으로 스크롤 영역 분리
- `src/renderer/components/Company/CompanyView.tsx`
  - 우측 패널(`w-52`)에 `<CostDashboard alwaysOpen />` 배치
  - MemberNode에 개별 비용 표시
  - DeptNode에 부서 합계 비용 표시
  - `memberCosts` store 연결
- `src/renderer/components/StatusBar/StatusBar.tsx`
  - Company 모드일 때 상태바 우측에 `~$총비용` 표시
  - COMPANY 배지 표시
  - 세션 분 카운터 (tooltip)

### 기능 요약
- PTY 출력 글자 수 기반 비용 추정 (Claude Opus 4.6: $75/M output tokens)
- 활성 시간 분당 $0.02 추가 추정 (하이브리드 모델)
- 부서 → 멤버 트리 구조로 비용 시각화
- 비율 바 (색상: 초과 75% = 빨강, 40% = 노랑, 나머지 = 파랑)
- 분당 비용률 + 세션 경과 시간
- Reset 버튼 (비용 + 세션 타이머 초기화)
- CompanySidebar 하단 고정 (접기/펴기)
- CompanyView 우측 전용 패널 (항상 펼침)
- StatusBar Company 모드 뱃지 + 총비용

## 다음 단계

- Phase 7: Worktree 통합 (git worktree 자동 생성/전환)
- Phase 8: 에이전트 간 메시지 라우팅 고도화
