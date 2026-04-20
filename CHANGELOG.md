# Changelog

All notable changes to wmux are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
