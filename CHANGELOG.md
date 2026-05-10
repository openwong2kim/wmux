# Changelog

All notable changes to wmux are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.8.2] — 2026-05-11 — Session Cap Headroom + Silent-Failure Fix

@alphabeen 이 v2.8.1 출시 직후 PR #25 로 보고한 두 문제를 한 patch 에 묶는다. v2.8.1 의 startup brick 픽스 이후에도 **runtime accumulation** 시나리오 (X close 후 daemon 이 유지하는 detached 세션이 며칠에 걸쳐 누적) 에서는 hard cap 50 에 다시 도달했고, 더 나쁜 건 cap throw 가 renderer 의 `Ctrl+T` 핸들러에서 silent 하게 묻혀 단축키가 무반응처럼 보이던 결함이다. v2.8.1 사용자는 즉시 업그레이드 권장.

### Fixed

- **데몬 세션 hard cap 50 → 200 상향** — #25, @alphabeen. v2.8.0 의 세션 영속화 이후 cap 의 의미가 "한 세션 동안 최대 동시 PTY" → "lifetime 누적 detached PTY 총합" 으로 바뀐 결과, multi-workspace + 빈번한 split 사용자는 며칠 내 50 에 재도달. 50 자체는 [commit 989dd8a](https://github.com/openwong2kim/wmux/commit/989dd8a) 의 보안 하드닝 단계에서 정한 DoS 휴리스틱이었고 200 도 같은 카테고리 안. soft cap 40 (recovery) / 7-day suspended TTL 정책은 무변경. 헤드룸 10 → 160. 근본 해결 (orphan detached GC) 은 v2.9 트랙으로 별도 검토. 구현: `src/daemon/DaemonSessionManager.ts`, `src/daemon/index.ts` 주석 동기화.
- **`pty.create` rejection 이 묻혀 단축키 무반응처럼 보이던 회귀** — @alphabeen 이 PR #25 description 에서 짚어준 두 번째 문제. cap 도달 시 daemon 이 actionable 에러 (`Cannot create new terminal: 200 active sessions already running. Close some panes (or restart wmux) and try again.`) 를 throw 하는데 renderer 의 세 호출 지점 (`useKeyboard` Ctrl+T 핸들러 / `AppLayout` empty-leaf 자동 PTY / `FloatingPane` 첫 열림) 모두 `.then()` 만 달고 `.catch()` 누락 (또는 silent catch) 이라 rejection 이 묻히고 단축키가 무반응처럼 보였다. v2.8.1 Bug 1 의 actionable error 의도가 무력화되던 결함.
  - **신규 IPC 에러 코드 `RESOURCE_EXHAUSTED`** — `wrapHandler` 의 `classifyError` 가 cap 메시지 패턴 (`cannot create new terminal` + `active sessions already running`) 을 감지해 분류. 메시지에 `[RESOURCE_EXHAUSTED]` prefix 가 stamp 되어 renderer 가 분기 가능.
  - **`useIpc` 매핑** — `DEFAULT_MESSAGES['RESOURCE_EXHAUSTED']` = "터미널 세션 한도에 도달했습니다. 일부 pane을 닫거나 wmux를 재시작한 뒤 다시 시도해주세요.", level `'warn'`. UNKNOWN 으로 매핑되어 generic "알 수 없는 오류" 토스트가 뜨던 path 차단.
  - **세 호출 지점 모두 `ipcInvoke` wrap 으로 통일** — `useKeyboard` Ctrl+T (ref 패턴으로 once-on-mount effect 안에서 사용), `AppLayout` empty-leaf 자동 PTY effect, `FloatingPane` 첫 PTY 생성. 모두 `result.ok` 분기 + 실패 시 toast 자동 게재.
  - **Electron invoke envelope wrap 처리** — codex P2 review 에서 잡힌 결함. `ipcRenderer.invoke` 가 main side 에러를 renderer 로 전달할 때 메시지를 `Error invoking remote method 'X': Error: <orig>` 형태로 감싸서, `useIpc` 의 `MESSAGE_CODE_PREFIX` 가 `^` anchor 였던 탓에 `[RESOURCE_EXHAUSTED]` stamp 가 envelope 뒤로 밀려 매칭 실패 → 모든 coded error 가 다시 UNKNOWN 으로 떨어지던 path 차단. renderer regex 만 anchor 제거 (main side 는 자기 raw output 매칭이라 anchor 유지). 알phabeen 이 PR #25 description 에서 짚어준 결함이 두 번 일어나지 않도록 회귀 테스트 추가.
  - 구현: `src/main/ipc/wrapHandler.ts`, `src/renderer/hooks/useIpc.ts`, `src/renderer/hooks/useKeyboard.ts`, `src/renderer/components/Layout/AppLayout.tsx`, `src/renderer/components/Terminal/FloatingPane.tsx`. 6 unit tests 추가 (wrapHandler RESOURCE_EXHAUSTED classification + message prefix stamping + useIpc default 매핑 + Electron-wrapped envelope classification).

### Migration Notes

- 자동. 클라이언트 / 외부 MCP 통합 측에 변경 없음. 신규 `RESOURCE_EXHAUSTED` 코드는 내부 IPC 경계 안쪽에서만 사용 (renderer ↔ main).

## [2.8.1] — 2026-05-10 — Session Recovery Stability Hotfix

@alphabeen 이 v2.8.0 출시 직후 보고한 세 가지 회귀 — 시간이 갈수록 wmux 가 사용 불가 상태로 빠지던 critical, recovered pane 출력이 깨지던 high, 매 시작마다 generic 에러 토스트가 뜨던 medium — 을 한 릴리스에 묶어 수정한다. v2.8.0 사용자는 즉시 업그레이드 권장 — 자동 마이그레이션이 누적된 `sessions.json` 을 첫 실행 시 정리한다.

### Fixed

- **세션 누적으로 인한 brick 상태 (Critical)** — v2.8.0 에서 도입된 데몬 세션 영속화는 사용자가 X 로 종료한 모든 live pane 을 `suspended` 로 저장하고 다음 시작 시 복구한다. 그런데 (1) 복구 횟수에 상한이 없었고, (2) 종료 시점에 사용자가 명시적으로 닫지 않은 세션은 영원히 `sessions.json` 에 남아 누적됐다. 4–5 회 재시작이면 데몬의 하드 PTY 캡 (`MAX_SESSIONS=50`) 을 모두 소진하여 startup recovery 가 새 pane 슬롯을 못 만들고, UI 는 `Ctrl+T` 도 안 먹히고 generic "알 수 없는 오류" 토스트만 도배되는 상태에 빠진다. 자가복구 불가능 (재시작해도 같은 시나리오 반복).
  - **Suspended 7-day TTL** — `StateWriter.load` 가 이제 dead 세션뿐 아니라 7 일 이상 inactive 한 suspended 도 함께 prune. v2.8.0 에서 누적된 기존 `sessions.json` 도 첫 v2.8.1 실행 시 자동 정리된다.
  - **Recovery soft cap 40** — 신규 `MAX_RECOVER_SESSIONS=40`. 복구 후보를 `lastActivity` 내림차순 정렬해 상위 40 개만 PTY 로 재생성하고 나머지는 그대로 suspended 로 남는다. 다음 launch 에서 활성 카운트가 줄면 자동으로 복구 후보에 다시 들어오며, 7 일 TTL 이 그래도 정체된 것을 reap. 이로써 hard cap 50 에 도달해도 항상 신규 pane 헤드룸 10 슬롯이 보장된다.
  - **`createSession` 에러 메시지 사용자 친화적 변경** — `Maximum session limit (50) reached` → `Cannot create new terminal: 50 active sessions already running. Close some panes (or restart wmux) and try again.`. RPC 응답으로 그대로 노출되어 향후 토스트가 generic 이 아닌 actionable 메시지로 보임.
  - 구현: `src/daemon/StateWriter.ts`, `src/daemon/index.ts`, `src/daemon/DaemonSessionManager.ts`, `src/daemon/recoverySelector.ts` (신규 — pure 함수로 cap 정책을 분리해 unit-test 가능). 9 unit tests 추가.

- **복구된 pane 출력 interleave (High)** — v2.8.0 은 종료 시점의 PTY cols/rows 를 저장하고 복구 시 그 값으로 ConPTY 를 spawn 한다. 사용자가 윈도우 사이즈를 바꾸고 재시작하면 ConPTY 는 옛 geometry 로 출력하는데 xterm 은 새 geometry 로 그려서 같은 줄에 두 paint 의 문자가 interleave 된다 (예: `Accessing workspace:` → `Accessingwworkspace:`).
  - **Deferred output mode** — `DaemonPTYBridge` 에 `setMuted(bool)` 추가. recovery 경로에서 `createSession({deferOutput: true})` 면 bridge 가 muted 로 시작하여 PTY 데이터 path 가 ring buffer 에 쓰지 않는다 (exit 알림은 muted 와 무관하게 정상 동작). renderer 가 첫 `daemon.resizeSession` 을 호출하면 PTY 가 진짜 geometry 로 resize 되고 `DEFERRED_UNMUTE_DELAY_MS=100` 후 자동 unmute. ConPTY 가 옛 geometry 에서 큐잉했던 출력은 100 ms 동안 drain 되고 버려진다. 저장된 scrollback (buffer dump) 은 ring buffer 에 직접 pre-fill 되므로 muted path 와 무관하게 보존된다.
  - 구현: `src/daemon/DaemonPTYBridge.ts`, `src/daemon/DaemonSessionManager.ts`, `src/daemon/index.ts` (recoverSessions 의 createSession 호출 3 곳 모두 `deferOutput: true`). 5 unit tests 추가 (drop while muted / scrollback 보존 / resize-then-unmute / 비-deferred regression / muted 중 exit 발화).

- **시작 시 generic 에러 토스트 폭주 (Medium)** — main process 가 daemon connect 를 비동기로 시도하는 동안 renderer 가 이미 IPC 호출을 던져, handler swap (`cleanupHandlers()` → `registerAllHandlers(...)`) 의 sub-millisecond 무등록 윈도우에 떨어진 호출이 `No handler registered for ...` 로 실패해 `useIpc` 가 `UNKNOWN` → "알 수 없는 오류가 발생했습니다." 토스트를 5–10 회 띄우던 문제.
  - main 이 단일 IPC handler `daemon:get-ready-state` 를 등록 (registerAllHandlers swap cycle 바깥이라 무등록 race 불가). connect 시도가 끝나면 `markDaemonReady()` 가 그동안 큐잉된 invoke 를 해제. 이후 invoke 는 즉시 현재 `daemonClient` 상태로 응답.
  - preload 의 `electronAPI.daemon.whenReady()` 가 `ipcRenderer.invoke('daemon:get-ready-state')` 를 호출 (one-shot event 가 아니라 query). renderer crash recovery 의 `mainWindow.reload()` 로 새로 로드된 preload 인스턴스도 정상 응답을 받아 deadlock 안 됨 (codex review fix — 초기 event-based 설계의 P2 결함 보강).
  - `AppLayout` 의 첫 reconcile 이 `daemon.whenReady()` 를 await 하여 handler 가 안정된 뒤에야 `pty.list` / `pty.reconnect` 를 호출. 토스트 폭주 사라짐.
  - 구현: `src/main/index.ts`, `src/preload/preload.ts`, `src/renderer/components/Layout/AppLayout.tsx`.

- **Split 후 빈 pane 이 영구 placeholder 로 남던 문제** — `AppLayout` 의 auto-PTY effect 가 `activeWorkspace.id` 만 deps 로 가져 split 으로 추가된 새 leaf 가 `surfaces=[]` 인 채 effect 재실행을 유발하지 못했다. 결과적으로 분할된 새 pane 이 "빈 창" placeholder 로 굳어 PTY 가 영영 안 붙었다. `collectEmptyLeaves` 를 effect 바깥으로 끌어올리고 빈 leaf id 들의 join 키를 deps 에 추가해 split 이 즉시 PTY 생성을 트리거하도록 수정. paneSlice 에 회귀 테스트 추가 (`src/renderer/stores/slices/__tests__/paneSlice.test.ts`).

- **한글 IME 상태에서 Ctrl+D / Ctrl+Shift+D split 단축키 미작동** — Hangul 레이아웃에서 `e.key` 가 `'ㅇ'` 또는 `'Process'` 가 되어 useKeyboard 의 `key === 'd'` 매칭이 빗나가고, useTerminal 의 xterm allowlist 도 같은 이유로 빠져 단축키가 xterm 에 흘러갔다. 두 곳 모두 `e.code === 'KeyD'` (물리 키 코드) 도 함께 매칭하도록 수정 — 기존 Ctrl+B / Ctrl+M 등의 cross-layout 패턴과 일관. 구현: `src/renderer/hooks/useKeyboard.ts`, `src/renderer/hooks/useTerminal.ts`.

- **분할 pane 을 키보드/마우스로 닫을 수 없던 문제** — Ctrl+W 가 `closeSurface` 만 호출해 마지막 surface 닫혀도 pane 이 collapse 안 되고, 단일 surface pane 에서는 `SurfaceTabs` 가 strip 자체를 숨겨 X 버튼도 없었다. (1) Ctrl+W 가 마지막 surface 닫힐 때 `closePane` cascade 호출 (Pane.tsx X-button 동작 미러), (2) `SurfaceTabs` 가 surfaces.length === 1 이어도 strip 렌더, (3) 신규 Ctrl+Shift+Q (tmux kill-pane equivalent) 추가 + `BUILTIN_KEYS` 로 보호, (4) SettingsPanel 의 Ctrl+W 라벨이 실제 동작과 어긋났던 것을 closeSurface / closePane 두 줄로 분리해 i18n 4개 로케일 (en/ko/ja/zh) 모두 수정. 구현: `src/renderer/hooks/useKeyboard.ts`, `src/renderer/components/Pane/SurfaceTabs.tsx`, `src/renderer/components/Settings/SettingsPanel.tsx`.

- **Reconnect 후 출력이 두 줄로 중복되던 문제** — `pty.handler.ts` 의 `PTY_CREATE` 와 `PTY_RECONNECT` 가 매번 새 `daemonClient.on('session:data', listener)` 를 등록하면서 이전 listener 를 떼지 않아 누적됐다. 한 세션을 reconnect 한번만 해도 두 listener 가 같은 chunk 를 두 번 forward 해 renderer xterm 에 중복 출력. per-session listener map 으로 분리하여 같은 ptyId 의 이전 listener 를 항상 정리한 뒤에만 새 listener 등록. 구현: `src/main/ipc/handlers/pty.handler.ts`.

### Migration Notes

- 자동. 첫 v2.8.1 실행 시 `StateWriter.load` 가 7 일 이상 묵힌 suspended 세션을 prune 한다. 추가 액션 불필요. v2.8.0 에서 이미 brick 된 사용자도 업그레이드 후 첫 실행에서 정상 복구된다 (alphabeen 이 가이드한 수동 `sessions.json`/`daemon-pipe`/`daemon.lock`/`daemon.pid` 삭제 절차는 더 이상 필요 없음).
- 외부 MCP 통합 측에 변경 없음 — 모든 변경은 daemon 내부 + main↔renderer IPC 가드.

## [2.8.0] — 2026-05-09 — External Tooling Surface + Cross-Pane Search

외부 AI 도구(Claude Code, 서드파티 MCP)가 wmux 위에 워크플로우를 빌드할 수 있도록 세 개의 신규 surface를 동시 도입한 minor 릴리스다. @alphabeen 의 RFC #15 가 직접적인 트리거이며, 그 결과로 (1) pane 단위 metadata API, (2) cursor 기반 JSON-RPC event bus, (3) cross-pane search 가 묶음으로 들어온다. 모든 신규 필드는 optional 이라 기존 클라이언트는 영향 없으며, `system.capabilities().features` 의 새 키 (`paneMetadata`, `events`) 로 신규 표면을 감지할 수 있다.

릴리스 본문이 큰 만큼 데이터 마이그레이션은 없다. 다만 외부 MCP 통합 코드를 작성한 사람은 "Migration Notes" 의 `bootId` / `asOfSeq` 항목을 한 번 읽고 캐시 무효화 경로를 확인할 것.

### Added

- **Pane metadata API** — #16. `PaneLeaf` 에 optional `PaneMetadata { label?, role?, status?, custom?: Record<string,string>, updatedAt? }` 부착. RPC 3 개 (`pane.setMetadata`/`getMetadata`/`clearMetadata`) + MCP tool 2 개 (`pane_set_metadata`, `pane_get_metadata`). 8 KB 직렬화 캡, label ≤ 64, role ≤ 64, status ≤ 128, custom ≤ 32 entries × 64-char keys. 외부 MCP 의 cross-workspace 하이재킹은 `workspaceId` 자동 스코프 + slice 레벨 검증으로 차단 (v2.7.2 `mcp.claimWorkspace` fix 와 같은 클래스 패턴). `custom` 맵은 `merge=true` 일 때 1 단계 deep-merge — 협력하는 두 MCP 가 서로의 키를 덮어쓰지 않는다.
  구현: `src/shared/types.ts`, `src/shared/rpc.ts`, `src/main/pipe/handlers/pane.rpc.ts`, `src/renderer/stores/slices/paneSlice.ts`, `src/renderer/hooks/useRpcBridge.ts`, `src/mcp/index.ts`.

- **JSON-RPC event bus** — #21 (resubmit of #17, base-deleted artifact). `WmuxEventType` union: `pane.created` / `pane.closed` / `pane.focused` / `pane.metadata.changed` / `workspace.metadata.changed` / `process.started` / `process.exited`. In-memory ring (1024 events) + monotonic `seq` cursor. RPC `events.poll({cursor, types?, workspaceId?, max?})` + MCP tool `wmux_events_poll`. 외부 도구는 자기 워크스페이스 이벤트만 자동 스코프. `bootId` (UUIDv4 / EventBus 인스턴스마다 변경) 가 `events.poll` / `system.capabilities` / `pane.list` 응답에 모두 노출되어 데몬 재시작 시 클라이언트 캐시(pane id, pty id, cursor) 를 깨끗이 무효화할 수 있다. `pane.list` 는 envelope `{asOfSeq, bootId, panes}` 로 변경되어 resync 후 reconcile 의 frame of reference 를 명확히 한다. polling 만 — push/SSE 는 stdio MCP transport 와 안 맞아 deferred.
  구현: `src/shared/events.ts`, `src/main/events/EventBus.ts`, `src/main/pipe/handlers/events.rpc.ts`, `src/renderer/events/publisher.ts`, `src/renderer/stores/slices/searchSlice.ts`.

- **Cross-pane search** — #20. wmux 의 첫 cross-pane primitive. `Ctrl+F` 의 "All Panes" 토글로 현재 워크스페이스 모든 live pane 의 xterm.js 버퍼를 on-demand grep 한다. 결과 ≤ 10 개는 search bar dropdown, > 10 개는 하단 panel 자동 확장 (progressive disclosure UX with hysteresis: open at > 10, close at ≤ 5, sticky bit until session reset). 결과 클릭 → 해당 pane focus + `scrollToLine(physicalBaseY)` 로 wrapped line 까지 정확히 jump. regex 모드 + 잘못된 패턴 visual error (red border + tooltip, no toast). MCP tool `wmux_search_panes(query, regex?)` 로 외부 AI 도 자율 추론 가능 ("JWT 에러 단 pane" 같은). 200-result cap, 20k lines/pane scan cap, 500-char line truncation. cross-workspace 검색은 v2 deferred (RPC-layer caller-identity gate 추가 설계 필요).
  구현: `src/renderer/utils/searchEngine.ts`, `src/renderer/components/Terminal/SearchBar.tsx`, `src/renderer/components/Search/SearchResultsPanel.tsx`, `src/renderer/stores/slices/searchSlice.ts`, `src/mcp/index.ts`. i18n: en/ko/ja/zh 4 locale 모두 신규 키 추가.

### Changed

- **`pane.list` 응답 형태** — `PaneListEntry[]` → `{asOfSeq: number, bootId: string, panes: PaneListEntry[]}` envelope. resync 시 클라이언트가 "이 스냅샷 이후 events" 를 정확히 결정할 수 있다. `panes[]` 는 기존 키 그대로 + 새 `metadata?: PaneMetadata` 필드 추가. 기존 클라이언트는 envelope unwrap 후 `.panes` 만 사용하면 되며, `metadata` 는 optional 이라 무시해도 됨.

- **`system.capabilities` 응답 확장** — `methods: RpcMethod[]` 만 있던 응답에 `features: { paneMetadata: true, events: { types, maxRingSize, bootId } }` 추가. 기존 `methods` 배열은 변경 없이 신규 method 들이 자동 추가된다 (`'pane.setMetadata'`, `'pane.getMetadata'`, `'pane.clearMetadata'`, `'pane.search'`, `'events.poll'`).

### Security

- **Cross-workspace pane.search 누출 차단** — RPC handler 가 caller 가 보낸 `workspaceId` 를 우선 사용하고 fallback 으로만 active workspace 를 쓴다. 외부 MCP 가 자기 ws 컨텍스트로 검색 호출 시, 사용자가 다른 ws 를 보고 있어도 caller 의 ws 결과만 받는다. v2.7.2 `mcp.claimWorkspace` fix 와 동일 클래스의 보안 게이트.
- **Pane metadata cross-ws 하이재킹 차단** — `pane.setMetadata` / `pane.clearMetadata` 도 `workspaceId` 스코프 강제. 외부 MCP 가 사용자 보는 ws 에 임의 metadata 작성 불가.

### Fixed

- **Clipboard selection 잔존 fix** — #19. v2.7.4 에서 도입한 selection-preserving fit 가드가 `isVisible` useEffect 와 `document.fonts.ready` 콜백 두 곳에 누락돼 워크스페이스 전환 직후나 폰트 로드 직후 selection 이 wipe 되던 문제. 또 selection 후 명시적 Ctrl+C 사이에 PTY 출력으로 selection 이 자연 클리어되어 SIGINT 가 가던 문제. fix: 두 가드 추가 + `terminal.onSelectionChange` 기반 자동 복사 (150 ms debounce, main-IPC 경유로 1 MB cap·Win32 lock retry·error toast 모두 보존). 해당 layer 9 unit tests 추가.
  구현: `src/renderer/hooks/useTerminal.ts`, `src/renderer/utils/autoSelectionCopy.ts` (신규).

### Migration Notes

- **외부 MCP 통합 코드** 는 `wmux_search_panes` / `wmux_events_poll` / `pane_get_metadata` 등 신규 도구를 즉시 사용할 수 있다. 신규 surface 감지는 `system.capabilities().features.paneMetadata` 와 `features.events` 키로.
- **`pane.list` 호출자** 는 응답이 envelope 으로 바뀐 점을 반영해야 한다. 기존 코드가 `panes[0].id` 처럼 직접 인덱싱했다면 `result.panes[0].id` 로. 단, MCP `pane_list` tool 은 envelope 그대로 반환하므로 AI 에이전트는 자연어로 처리 가능.
- **이벤트 폴링 클라이언트** 는 매 응답의 `bootId` 를 비교하고, 변경됐다면 cached pane id / pty id / cursor 를 모두 폐기하고 `pane.list` 로 reconcile. `cursor > latestSeq()` 또는 `resync: true` 도 동일하게 처리.

### v1 deferred → v2 candidates

다음 항목들은 본 릴리스 범위 밖으로 명시 deferred — 트래킹 #18 :

- Cross-workspace search 및 metadata write (현재 caller ws 만 — explicit setting + RPC-layer caller-identity gate 설계 필요)
- Push / SSE event delivery (stdio MCP 와 어울리지 않음, 폴링 latency 가 UX 문제 될 때 재검토)
- Dead session scrollback dump 검색 (live pane 만 v1)
- Optimistic concurrency (`expectedVersion`) on `meta.set` — 다중 도구 contention 시 last-writer-wins 를 깨끗이 분리

## [2.7.4] — 2026-05-07 — Terminal Stability (4-bug Fix)

v2.7.0 의 UI 확장 후 누적된 터미널 안정성 4 건을 묶은 patch. 모두 사용자 가시 회귀라 우선 ship. 데이터 마이그레이션 없음.

### Fixed

- **Hang / CPU 풀가동 (큰 출력)** — `PTYBridge.ts` onData 에 8 ms micro-batch 도입. `OscParser.ts` 가 slice 기반(O(n²) → O(n)). `ActivityMonitor.ts` 가 100 ms 타임스탬프 가드.
- **Ctrl+V paste 일부 누락** — `useTerminal.ts` 의 Ctrl+V / Ctrl+Shift+V 핸들러에 4096 청킹 추가 (우클릭 path 와 동일). `pty.handler.ts` 100 K silent drop backstop 은 유지하되 `console.warn` 추가.
- **Copy 완전 안 됨** — `clipboard.handler.ts` silent return 3 건을 typed throw (`CLIPBOARD_INVALID_TYPE` / `CLIPBOARD_TOO_LARGE` / `CLIPBOARD_WRITE_FAILED`) 로 변환. 4 호출부 (useTerminal ×3 + Terminal.tsx) 가 await + try/catch, 실패 시 selection 유지 + `showCopyErrorToast` (i18n 4 locale).
- **마지막 문단만 복사** — `useTerminal.ts` ResizeObserver / font-theme effect 에 `hasSelection()` 가드 + `windowsPty: { backend: 'conpty', buildNumber: 21376 }` 옵션으로 ConPTY reflow 활성화 (xterm.js 6 의 SelectionService unconditional clear 우회).

### Changed

- `IPC.CLIPBOARD_WRITE` invoke 가 실패 시 throw — renderer 는 await + try/catch 필수.
- `IPC.PTY_DATA` 송신 빈도가 청크 단위 → 8 ms batch 단위 (데이터 내용 / 순서 동일).
- `IPC.PTY_WRITE` 100K 초과 silent drop backstop 은 유지 — renderer 가 청킹으로 회피해야 함.

### Migration Notes

스키마 변경 없음. `clipboardAPI.writeText` 를 호출하는 신규 코드는 await + try/catch 필수.

## [2.7.3] — 2026-04-28 — A2A Execute Approval Gate

외부 MCP 호출자가 `a2a_task_send` 의 `execute:true` 한 줄로 사용자의
워크스페이스에서 `--permission-mode bypassPermissions` 모드의 Claude
CLI 를 무인 실행할 수 있던 표면을 차단한 보안 patch. 단일 항목이지만
RCE 급 표면이라 즉시 출하한다. 데이터 마이그레이션 없음.

### Security

- **A2A `execute:true` 사용자 승인 게이트** — 1cd5ab3. 신규 task 가
  `execute:true` 로 들어오면 ClaudeWorker spawn 직전에 사용자에게
  확인 다이얼로그를 띄운다 — 발신/수신 워크스페이스, 작업 cwd, 메시지
  500 자 미리보기, 30 초 자동 거부 카운트다운. 거부 또는 타임아웃 시
  task 가 `canceled` 로 마크되어 발신자가 `a2a_task_query` 로 거부를
  확인할 수 있다. `cancelTask` 권한이 발신자에서 발신자/수신자로
  완화돼, 수신자가 들어오는 task 를 deny 할 수 있다.
  구현: `src/main/pipe/handlers/a2a.rpc.ts`,
  `src/main/pipe/handlers/_bridge.ts`,
  `src/renderer/components/A2a/ExecuteApprovalDialog.tsx`,
  `src/renderer/utils/executeApproval.ts`,
  `src/renderer/hooks/useRpcBridge.ts`,
  `src/renderer/stores/slices/a2aSlice.ts`.

### Migration Notes

스키마 변경 없음. 자동 마이그레이션 없음. `execute:true` 를 사용하는
기존 자동화는 이제 사람의 승인 없이는 실행되지 않으므로, 신뢰된
caller 가 무인 실행을 기대했다면 향후 도입될 `autoApproveExecute`
설정 토글을 기다리거나 `execute` 없이 호출하도록 조정한다.

## [2.7.2] — 2026-04-25 — Stability & MCP Hardening

v2.7.1 이후 누적된 안정성·보안 하드닝을 묶은 patch 릴리스다. 신규
사용자 대상 UI 기능은 없고, 데이터 마이그레이션도 필요 없다. MCP
통합을 사용하는 외부 클라이언트는 워크스페이스 점유 동작이 바뀌었으니
"Changed" 항목을 한 번 확인할 것.

### Fixed

- **Daemon mass-kill cascade** — fb65626. 한 PTY 가 비정상 종료될 때
  같은 워크스페이스의 다른 PTY 들까지 연쇄 종료되던 문제. 종료 사유를
  per-PTY 로 분리해 cascade 트리거를 차단했다.
  구현: `src/daemon/SessionManager.ts`, `src/daemon/PtySupervisor.ts`.
- **PlaywrightEngine CDP 메모리 누수** — df37e97. `mcp__wmux__browser_*`
  툴 호출 후 CDP 세션이 detach 되지 않아 장시간 사용 시 RAM 이 단조
  증가하던 문제. 페이지 lifecycle 에 detach 를 묶었다.
  구현: `src/main/browser/PlaywrightEngine.ts`.
- **PWSH non-zero exit code 보고** — 83d584e. OSC 133 hook 이 항상 0 을
  보고해 shell-integration 이 실패한 명령을 성공으로 표기하던 회귀.
  `$LASTEXITCODE` 폴백을 추가했다.
  구현: `src/main/pty/shell-hooks/pwsh.ps1`.
- **Multiview 자동 종료** — 77e4d58. 멀티뷰에 포함되지 않은 워크스페이스로
  전환할 때 멀티뷰가 그대로 유지되어 잘못된 팬이 화면에 남던 문제. 전환
  시점에 멀티뷰 상태를 자동 해제한다.
  구현: `src/renderer/store/uiSlice.ts`.
- **우클릭 이미지 붙여넣기** — d071b08 + 889c6d8. (1) 우클릭 컨텍스트
  메뉴에서 이미지 붙여넣기를 지원하고 (2) 공백이 포함된 임시 경로를
  올바르게 quoting + bracketed paste 로 래핑해 셸이 명령을 즉시 실행하지
  않도록 한다. 큰 텍스트 chunk 의 분할 전송 경로도 정리됐다.
  구현: `src/renderer/hooks/useTerminal.ts`,
  `src/main/clipboard/ImagePaste.ts`.
- **Ultrareview 6 건 일괄 수정** — b79115c. SoulLoader RCE/Windows
  비호환 경로(POSIX heredoc → IPC `fs.writeFile`), A2A CR/LF/ANSI 인젝션
  (`safeName`/`safeBody` 가 ESC CSI 와 개행을 strip), StateWriter
  saveImmediate race(immediateEpoch 스냅샷 보존), Squirrel 설치 파일명
  pin (`wmux-{version}.Setup.exe`) 등.
  구현: `src/company/core/SoulLoader.ts`,
  `src/main/a2a/envelope.ts`, `src/daemon/StateWriter.ts`,
  `forge.config.ts`.
- **SoulLoader fs 가드** — `window.electronAPI.fs` 가 옵셔널인데 가드
  없이 접근하던 부분으로 strict TS 체크가 깨져 CI 가 레드였던 문제.
  fs 가 없으면 false 를 반환하도록 정리.
  구현: `src/company/core/SoulLoader.ts`.

### Changed

- **MCP 워크스페이스 claim** — 9db0b25. 외부 MCP 호출자가 사용자의 active
  pane 을 hijack 하지 않고 전용 워크스페이스를 점유한다 (`mcp.claimWorkspace`).
  다중 MCP 클라이언트가 한 wmux 인스턴스에 붙는 시나리오에서 키 입력
  충돌을 제거한다. 기존 클라이언트는 자동 폴백.
  구현: `src/mcp/server.ts`, `src/daemon/WorkspaceClaim.ts`.
- **PTY env filter 일원화** — b19f25a. spawn 직전 env 화이트리스트가
  여러 곳에 흩어져 있던 것을 한 모듈로 모으고, browser export 경로도
  같은 sanitizer 를 거치도록 정리해 환경변수 누설 surface 를 줄였다.
  구현: `src/main/pty/envFilter.ts`,
  `src/main/browser/exportPaths.ts`.

### Internal

- 릴리스 워크플로우에 winget publishing step 추가 (#5, 825f4ee).
- README/SEO 정리 — `cmux for Windows` 포지셔닝 강화, 설치 가이드에
  winget·choco 명령 추가 (0fbbe43, 5f89c0e).

### Migration Notes

스키마 변경 없음. 자동 마이그레이션도 필요 없다. MCP 통합을 사용하는
외부 클라이언트만 워크스페이스 점유 동작 변화를 확인할 것.

## [2.7.1] — 2026-04-20 — Constrained Language Mode Hotfix

PowerShell Constrained Language Mode (AppLocker / WDAC가 적용된 회사·학교 PC)
환경에서 v2.7.0 사용 시 `사용자 지정 키 처리기에서 예외가 발생했습니다`
오류가 매 Enter / 매 prompt 렌더마다 발생하던 회귀를 수정한다. 다른
변경 사항은 없으며 데이터 마이그레이션도 필요 없다.

### Fixed

- **Shell integration script (OSC 133)** — `Set-PSReadLineKeyHandler`의
  Enter 핸들러가 `[Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()` /
  `[Console]::Write()`를 호출하던 부분이 Constrained Mode에서 메서드 호출
  금지 정책에 걸려 PSReadLine이 매 키스트로크마다 예외를 노출했다. 이제
  init 스크립트가 시작 시 `$ExecutionContext.SessionState.LanguageMode`를
  검사해 `FullLanguage`가 아니면 통합 자체를 건너뛰고, 핸들러 본문도
  try/catch로 감싸 런타임 실패 시 plain `AcceptLine`으로 폴백한다.
  구현: `src/daemon/shell-integration.ts`, `INTEGRATION_VERSION` 1 → 2로
  bump하여 디스크에 캐시된 옛 스크립트가 자동으로 재생성된다.
- **PWSH prompt hook (OSC 7 / 7727)** — `[System.Net.Dns]::GetHostName()`
  과 `[Console]::Write()`가 Constrained Mode에서 매 prompt 렌더 시 예외를
  던지던 문제. 이제 LanguageMode 게이트 + try/catch + `$env:COMPUTERNAME`
  치환으로 안전하다.
  구현: `src/main/pty/shell-hooks/pwsh.ps1`.
- **Terminal 우클릭 UX** — 항상 Copy/Paste 모달이 뜨던 동작을 Windows
  Terminal 스타일로 정리. 선택 영역이 있으면 즉시 복사 + 선택 해제, 없으면
  즉시 붙여넣기, 링크 위에서만 작은 컨텍스트 메뉴(Open Link / Copy Link)가
  뜬다. 모달 인터럽트 제거.
  구현: `src/renderer/hooks/useTerminal.ts`,
  `src/renderer/components/Terminal/ContextMenu.tsx`.
- **타입 부채 정리** — `companySlice`에 `taskHistory` / `waitGraph` /
  `createCompany`의 `workDir` 누락, `IPC.FS_WRITE_FILE` 상수 미정의,
  `OnboardingOverlay`의 옛 필드명 참조 등 27건의 TypeScript 오류를 해결해
  PR CI가 다시 녹색이 된다. 런타임 동작 변화는 없다.

## [2.7.0] — 2026-04-19 — Terminal UX Expansion

Terminal 사용성에 집중한 피처 릴리스다. 데몬/세션 영속성 계층 변경은 없으며,
업그레이드 시 추가 조치는 필요 없다. 키 바인딩 기본값이 추가·변경되었으므로 기존
커스텀 바인딩과 충돌이 없는지 한 번 확인해 두면 좋다.

### Added

- **Floating pane (Quake 스타일 드롭다운 터미널)** — 전역 핫키로 메인 레이아웃과
  독립된 터미널 팬을 띄우거나 숨긴다. 첫 호출 시 전용 PTY를 생성해 세션 유지.
  구현: `src/renderer/components/Terminal/FloatingPane.tsx`, `uiSlice`의
  `floatingPaneVisible`/`floatingPanePtyId`.
- **우클릭 컨텍스트 메뉴** — 복사·붙여넣기·링크 열기·링크 복사 항목. 선택 영역 및
  커서 아래 링크 감지에 따라 메뉴 항목이 동적으로 변경된다. ESC·바깥 클릭으로 닫힘,
  뷰포트 밖으로 넘어가지 않도록 위치 클램핑.
  구현: `src/renderer/components/Terminal/ContextMenu.tsx`.
- **스크롤 북마크** — 현재 스크롤 위치를 북마크로 찍고 이후 해당 라인으로 즉시
  점프한다. 컨테이너 좌측에 북마크 인디케이터가 뜨며, 스크롤에 따라 뷰포트 내에
  들어온 북마크만 렌더링된다.
  구현: `BookmarkIndicator.tsx`, `paneSlice`의 `bookmarks` 필드.
- **tmux 스타일 prefix 모드** — `Ctrl + <prefix key>` 입력 후 다음 단일 키로 동작을
  발동. 분할(가로/세로), 팬 닫기, 워크스페이스 순회, 포커스 이동, 팔레트 호출,
  플로팅 팬 토글 등 13종의 액션을 제공하며 사용자 바인딩 커스터마이즈 및 기본값
  초기화 지원.
  구현: `useKeyboard.ts`, `SettingsPanel` prefix 섹션, `uiSlice` prefix 상태.
- **레이아웃 템플릿** — 현재 분할 레이아웃을 저장해 재사용. 명령 팔레트에서 "레이아웃:"
  항목으로 빠르게 적용하고 "최근" 카테고리에서 직전 사용 항목을 바로 호출.
  구현: `CommandPalette`, `workspaceSlice` / `paneSlice`.
- **정규식 검색 토글** — 터미널 검색 바에서 regex 모드를 on/off 할 수 있다. xterm
  `SearchAddon`의 regex 옵션 전달.
- **xterm Unicode 11 width tables** — `@xterm/addon-unicode11` 추가 후
  `terminal.unicode.activeVersion = '11'` 활성화. CJK/이모지 width 산정을 v11 기준으로
  맞춰 TUI 앱(특히 Claude Code)의 cursor positioning과 한글 glyph 폭이 일치한다.

### Changed

- `useTerminal` hook — scrollback 복원·컨텍스트 메뉴 이벤트·right-click paste
  fallback 경로가 정리되었고, WebGL 컨텍스트 수명관리(가시성 기반 dispose/reload)
  로직이 명확해졌다.
- Preload 계층 — `window.electronAPI.shell.openExternal` / 클립보드 IPC 노출 경로가
  컨텍스트 메뉴와 링크 오픈 플로우에 맞춰 소폭 확장되었다.
- i18n 4개 언어(한국어·영어·일본어·중국어)에 prefix 모드, 컨텍스트 메뉴, 플로팅 팬,
  검색 regex, 레이아웃 저장, 북마크 문자열 40여 키 추가.

### Fixed

- **한글·CJK 프레임 겹침 (Claude Code TUI 렌더링 깨짐)** — xterm 기본 Unicode v6이
  한글의 display width를 잘못 계산해 ANSI CUP(cursor position) 시퀀스를 쓰는 TUI
  애플리케이션의 프레임이 겹쳐 그려지던 문제. Unicode 11 활성화로 해결.
  (재현: Claude Code 실행 중 한글 입력 후 thinking 애니메이션이 돌아갈 때 상태바가
  프롬프트 위에 겹쳐 쓰이는 증상.)

### Migration Notes

스키마 변경은 없다. 기존 데이터·세션·워크스페이스는 그대로 로드된다. 기본 prefix
키는 비활성 상태로 출발하므로 사용자가 활성화하기 전까지는 기존 단축키 동작에 영향이
없다.

## [2.6.0] — 2026-04-17 — Stability & Persistence Hardening

이번 릴리스는 daemon 안정성과 세션 영속성을 강화하는 방어·복원 작업이다.
사용자 데이터 파일 포맷 자체는 동일하되, 저장 경로와 에러 처리에 내부 변화가 있다.
업그레이드 시 추가로 할 일은 없다. 자동 마이그레이션으로 처리된다.

### Added

- `src/daemon/util/atomicWrite/` — 공통 atomic-write 모듈. tmp→bak→rename 순서와
  `__proto__`/`constructor`/`prototype` sanitizer를 한 곳에서 관리한다. SessionManager와
  StateWriter의 중복 구현이 이 모듈로 통합된다.
- `src/daemon/util/AsyncQueue.ts` — 30~50줄 수준의 자체 Promise 큐. `saveDebounced`
  경로에서 concurrent write 경합을 제거한다. `flushSync()` 메서드로 종료 시점의
  synchronous drain을 보장한다.
- `src/main/ipc/wrapHandler.ts` — `ipcMain.handle` 전용 래퍼. 핸들러 예외를
  구조화 JSON 로그(`{ts, level, event, channel, error_code, stack}`)로 메인 프로세스
  stderr에 기록하고, 에러에 `code` 속성을 부여한다.
- `.bak` rotation chain — save 성공 시 `.bak.2→.bak.3`, `.bak.1→.bak.2`, `.bak→.bak.1`
  rename 체인이 실행되어 최근 3개 스냅샷이 유지된다. 읽기 경로는
  primary → .bak → .bak.1 → .bak.2 → .bak.3 순서로 fallback한다.
- Lazy 마이그레이션 프레임워크 — `src/daemon/migrations/`. load 시점에 스키마 버전을
  확인하고 메모리에서만 체이닝 변환한다. 새 포맷 기록은 다음 save에서 이루어진다.
  프로덕션 레지스트리는 `CURRENT_VERSION=1`로 identity 유지 상태다.
- 손상 파일 격리 — validate 실패 시 파일을 `{userData}/corrupted/` 서브디렉토리로
  이동하고 `CORRUPT_FILE` 이벤트를 JSON 로그로 남긴다. 30일 경과 또는 10개 초과 시
  오래된 격리 파일이 자동 정리된다.
- Premigrate 스냅샷 — 스키마 업그레이드가 발생하는 load 경로에서 원본을
  `{basename}.v{N}.premigrate.bak`로 일회성 보존한다. 롤백 자료로 사용된다.

### Changed

- IPC 에러 포맷이 통일된다. 이전에는 핸들러 예외가 renderer로 그대로 promise
  rejection 되어 stack이 불분명했다. 이번 릴리스부터 메인 프로세스 stderr에 JSON
  line으로 기록되고, 에러 객체에 `code` 속성이 붙는다. 사용 가능한 코드는
  `DAEMON_DISCONNECTED`, `VALIDATION_ERROR`, `NOT_FOUND`, `PERMISSION_DENIED`,
  `UNKNOWN`이다. renderer 호출부의 응답 값 자체는 그대로 raw value를 반환한다
  (정규화는 후속 작업인 T4 `useIpc` 훅에서 수용 예정).
- `StateWriter`와 `SessionManager`의 내부 구조 — atomic-write 중복 경로를 공통
  모듈 호출로 치환했다. 외부 API 시그니처는 변경 없다. `saveImmediate`는 기존 동기
  시그니처를 유지한다(shutdown/suspend emergency sync 경로 호환).
- Rotation allowlist regex가 `^sessions\.json\.bak(\.[123])?$` 패턴에 한정된다.
  `corrupted/` 디렉토리와 `*.premigrate.bak` 파일은 rotation 대상에서 제외된다.

### Fixed

- StateWriter/SessionManager의 concurrent save race — AsyncQueue coalescing
  (같은 key 재진입 시 마지막 값만 실행, key 간은 FIFO 보장)로 해결.
- IPC 핸들러에서 던진 예외가 메인 로그에 남지 않는 문제 — `wrapHandler`가 전 핸들러
  공통 try/catch 경로로 흡수하고 stderr JSON 로그로 기록한다.
- validate 실패 시 무음으로 빈 세션이 출발하던 문제 — 손상 파일을 corrupted/로
  격리하고, .bak 체인에서 fallback을 시도한다. 복구에 성공하면 즉시 승격 save.

### Migration Notes

사용자 데이터 손실은 발생하지 않는다. 업그레이드 절차에서 수동 작업은 없다.
다만 `{userData}` 디렉토리 내부에 다음 두 종류의 새 경로가 등장한다.

- `{userData}/corrupted/` — validate 실패로 격리된 파일의 보관소. 30일 경과 또는
  10개 초과 시 자동 정리된다.
- `{basename}.premigrate.bak` — 스키마 업그레이드 load 시점에 생성되는 원본
  스냅샷. 자동 정리 대상이 아니다. 수동 삭제 가능(향후 릴리스에서 자동 정리 검토).

플랫폼별 `{userData}` 경로와 롤백 절차는
[`docs/upgrade-2026-04-17.md`](docs/upgrade-2026-04-17.md)를 참고한다.
