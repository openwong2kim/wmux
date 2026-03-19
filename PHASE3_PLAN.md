# WinMux Phase 3: CLI & API 구현 계획

## Context
Phase 1 완료 (터미널, 사이드바, Pane 분할, Surface 탭, 키보드, 세션). Phase 2 완료 (알림 시스템, OSC 파서, Agent 감지, 메타데이터, Toast). Phase 3에서는 Named Pipe API 서버, winmux CLI, Command Palette를 구현하여 외부 도구/에이전트가 WinMux를 프로그래밍적으로 제어할 수 있게 한다.

---

## Step 1: JSON-RPC 프로토콜 정의 + 환경변수 (기반)

**생성:**
- `src/shared/rpc.ts` — JSON-RPC 타입 + 메서드 정의

**수정:**
- `src/shared/constants.ts` — PIPE_NAME, ENV 변수명 상수 추가
- `src/main/pty/PTYManager.ts` — PTY 생성 시 환경변수 주입 (WINMUX_WORKSPACE_ID, WINMUX_SURFACE_ID, WINMUX_SOCKET_PATH)

**내용:**
```typescript
// JSON-RPC Request/Response
interface RpcRequest { id: string; method: string; params: Record<string, unknown> }
interface RpcResponse { id: string; ok: boolean; result?: unknown; error?: string }

// Method 목록
type RpcMethod =
  | 'workspace.list' | 'workspace.new' | 'workspace.focus' | 'workspace.close' | 'workspace.current'
  | 'surface.list' | 'surface.new' | 'surface.focus' | 'surface.close'
  | 'pane.list' | 'pane.focus' | 'pane.split'
  | 'input.send' | 'input.sendKey' | 'input.readScreen'
  | 'notify'
  | 'meta.setStatus' | 'meta.setProgress'
  | 'system.identify' | 'system.capabilities'
```
- 환경변수: `WINMUX_WORKSPACE_ID`, `WINMUX_SURFACE_ID`, `WINMUX_SOCKET_PATH=\\.\pipe\winmux`
- PTYManager.create()에서 env에 위 변수 자동 주입

---

## Step 2: Named Pipe 서버 (Main process)

**생성:**
- `src/main/pipe/PipeServer.ts` — Windows Named Pipe 서버 (`net.createServer` + `\\.\pipe\winmux`)
- `src/main/pipe/RpcRouter.ts` — JSON-RPC 메서드 라우터 (method → handler 매핑)

**수정:**
- `src/main/index.ts` — PipeServer 시작/종료 통합

**내용:**
- `net.createServer()` + `server.listen('\\\\.\\\pipe\\winmux')` 사용 (Node.js net 모듈이 Named Pipe 지원)
- 클라이언트 연결 시 줄 단위(`\n`) JSON-RPC 메시지 수신
- RpcRouter: method string → handler function 매핑, handler는 Promise<unknown> 반환
- 연결 관리: 다수 클라이언트 동시 접속 지원
- 앱 종료 시 pipe 서버 정리

---

## Step 3: RPC 핸들러 구현 — Workspace/Surface/Pane (Step 1+2 후)

**생성:**
- `src/main/pipe/handlers/workspace.rpc.ts` — workspace.list/new/focus/close/current
- `src/main/pipe/handlers/surface.rpc.ts` — surface.list/new/focus/close
- `src/main/pipe/handlers/pane.rpc.ts` — pane.list/focus/split

**수정:**
- `src/main/pipe/RpcRouter.ts` — 핸들러 등록
- `src/preload/index.ts` — RPC에서 renderer store 조작을 위한 IPC 채널 추가
- `src/shared/constants.ts` — RPC→renderer IPC 채널 추가

**내용:**
- **핵심 설계**: Named Pipe → Main process → IPC → Renderer (store 조작) → IPC 응답 → Main → Pipe 응답
- Main process에서 `BrowserWindow.webContents.send()`로 renderer에 명령 전달
- Renderer에서 `ipcRenderer.on()`으로 수신 후 store 액션 실행, 결과를 `ipcRenderer.send()`로 반환
- workspace.list: 전체 워크스페이스 ID/이름 목록 반환
- workspace.current: 현재 활성 워크스페이스 반환
- pane.split: direction 파라미터로 수평/수직 분할

---

## Step 4: RPC 핸들러 — Input/Notify/Meta (Step 2+3 후)

**생성:**
- `src/main/pipe/handlers/input.rpc.ts` — input.send/sendKey/readScreen
- `src/main/pipe/handlers/notify.rpc.ts` — notify (알림 트리거)
- `src/main/pipe/handlers/meta.rpc.ts` — meta.setStatus/setProgress
- `src/main/pipe/handlers/system.rpc.ts` — system.identify/capabilities

**내용:**
- input.send: PTYManager.write()로 텍스트 전송
- input.sendKey: 특수 키(Enter, Tab, Ctrl+C 등) 시퀀스 매핑 후 전송
- input.readScreen: xterm.js buffer에서 현재 화면 텍스트 추출 (renderer IPC 필요)
- notify: Phase 2 알림 시스템 활용 (addNotification + ToastManager)
- system.identify: `{ app: "winmux", version: "1.0.0", platform: "win32" }` 반환
- system.capabilities: 지원하는 전체 메서드 목록 반환

---

## Step 5: winmux CLI 실행 파일 (Step 2 후 병렬 가능)

**생성:**
- `src/cli/index.ts` — CLI 엔트리 포인트
- `src/cli/client.ts` — Named Pipe 클라이언트 (연결 + JSON-RPC 요청/응답)
- `src/cli/commands/workspace.ts` — workspace 서브커맨드
- `src/cli/commands/surface.ts` — surface 서브커맨드
- `src/cli/commands/pane.ts` — pane 서브커맨드
- `src/cli/commands/input.ts` — send/send-key/read-screen
- `src/cli/commands/notify.ts` — notify 명령
- `src/cli/commands/system.ts` — identify/capabilities

**수정:**
- `package.json` — cli 빌드 스크립트 + bin 필드 추가
- `tsconfig.json` 또는 별도 `tsconfig.cli.json` — CLI 빌드 설정

**내용:**
- 경량 CLI: 의존성 최소화 (commander.js 또는 직접 argv 파싱)
- Named Pipe 클라이언트: `net.connect('\\\\.\\\pipe\\winmux')` → JSON-RPC 요청 → 응답 출력
- 사용 예시:
  ```
  winmux list-workspaces          → workspace.list RPC 호출
  winmux new-workspace --name dev → workspace.new {name:"dev"}
  winmux send "hello"             → input.send {text:"hello"}
  winmux notify --title T --body B → notify {title:"T",body:"B"}
  ```
- JSON 출력 모드 (`--json` 플래그) 지원 — 스크립트 파이프라인용
- 에러 처리: 앱 미실행 시 "WinMux is not running" 메시지

---

## Step 6: Command Palette (Ctrl+K) (Step 1 후 병렬 가능)

**생성:**
- `src/renderer/components/Palette/CommandPalette.tsx` — 오버레이 팔레트 UI
- `src/renderer/components/Palette/PaletteItem.tsx` — 개별 항목 컴포넌트

**수정:**
- `src/renderer/stores/slices/uiSlice.ts` — commandPaletteVisible 상태 추가
- `src/renderer/hooks/useKeyboard.ts` — Ctrl+K (팔레트 토글)
- `src/renderer/components/Layout/AppLayout.tsx` — CommandPalette 렌더링

**내용:**
- 중앙 오버레이 (400px 너비), 상단에 입력 필드
- 퍼지 검색 대상:
  - 워크스페이스 (`> workspace: ...`)
  - Surface (`> surface: ...`)
  - 명령 (Toggle sidebar, Split pane, New workspace, Show notifications 등)
- 항목 선택 시 해당 액션 실행 (워크스페이스 전환, 명령 실행 등)
- ESC 또는 배경 클릭으로 닫기
- 키보드 네비게이션: 화살표 위/아래 + Enter

---

## Step 7: Renderer RPC 브릿지 (Step 3 필수 선행)

**생성:**
- `src/renderer/hooks/useRpcBridge.ts` — Main에서 오는 RPC 명령을 store 액션으로 변환

**수정:**
- `src/preload/index.ts` — rpc.onCommand, rpc.respond API 추가
- `src/shared/constants.ts` — RPC_COMMAND, RPC_RESPONSE IPC 채널
- `src/renderer/components/Layout/AppLayout.tsx` — useRpcBridge 훅 사용

**내용:**
- Main → Renderer: `RPC_COMMAND` IPC로 `{requestId, method, params}` 전달
- Renderer에서 store 액션 실행 후 결과를 `RPC_RESPONSE` IPC로 반환
- workspace/surface/pane 조작은 renderer store에서 처리
- input.readScreen은 xterm.js buffer 접근이 필요하므로 renderer에서 처리

---

## 병렬 실행 맵

```
Step 1 ─┬─→ Step 2 ─→ Step 3 ─→ Step 4
        │            └─→ Step 5 (CLI, 병렬)
        │            └─→ Step 7 (RPC 브릿지)
        └─→ Step 6 (Command Palette, 병렬)
```

**실행 순서:** Step 1 → Step 2 + Step 6 (병렬) → Step 3 + Step 5 (병렬) → Step 4 + Step 7 (병렬)

---

## 검증

1. `npx tsc --noEmit` — 타입 에러 0개 확인
2. `npm start` — 앱 실행 후:
   - PowerShell에서 `echo $env:WINMUX_WORKSPACE_ID` → 값 출력 확인
   - `echo $env:WINMUX_SOCKET_PATH` → `\\.\pipe\winmux` 확인
   - Ctrl+K → Command Palette 열림, 워크스페이스 검색 가능
   - 팔레트에서 "New workspace" 선택 → 워크스페이스 생성 확인
3. CLI 테스트 (별도 터미널에서):
   - `winmux identify` → `{ app: "winmux", version: "1.0.0" }` 출력
   - `winmux list-workspaces` → 현재 워크스페이스 목록 출력
   - `winmux new-workspace --name "test"` → 앱에 새 워크스페이스 생성 확인
   - `winmux notify --title "Hello" --body "World"` → 앱에 알림 표시 확인
   - `winmux send "echo hello"` → 활성 터미널에 텍스트 입력 확인
   - `winmux capabilities` → 전체 메서드 목록 출력
4. Git 커밋
