# 터미널 네이티브 paste 레이스 fix — 크로스플랫폼 회귀 검증

> 다음 세션 시작 프롬프트로 그대로 붙여넣어 쓸 것. Opus 단독 모델로 실행.

## 세션 시작 지시 (이 블록을 그대로 새 세션 첫 메시지로 사용)

```text
plans/terminal-paste-race-crossplatform-verification.md 읽고 이어서 진행해줘.

모델: 이 작업 전체를 Opus 단독으로 돌려라. CLAUDE.md의 기본 모델 전략(Scout/QA는
Sonnet, 파일검색은 Haiku)을 이번 세션만 예외로 오버라이드한다 — 크로스플랫폼 OS
이벤트 아키텍처 추론이라 얕은 조사로는 안 됨. Workflow 도구를 쓸 경우 모든 agent()
호출에 {model: 'opus'}를 명시하거나, 세션 자체를 Opus로 시작해서 옵션을 생략해라
(생략 시 세션 모델을 상속하므로 세션이 Opus면 그걸로 충분).

이 문서의 "조사 대상"과 "완료 기준"을 그대로 작업 스코프로 삼아라. 배경 섹션을 먼저
읽고, 이미 확인된 것과 안 된 것을 혼동하지 마라 — macOS 쪽은 이미 소스 레벨로 확정
검증됐고, Windows/Linux 쪽은 100% 추론이지 검증이 아니다.
```

---

## 배경

PR #328 (`fix/macos-terminal-native-paste-race` → `openwong2kim/wmux:main`)에서
wmux 터미널의 Cmd+V 붙여넣기 시 긴 경로 앞부분이 유실되는 버그를 고쳤다.

**근본 원인(macOS, 소스로 확정 검증됨):** wmux가 `Menu.setApplicationMenu()`를
호출하지 않아 Electron 기본 메뉴가 깔린다. macOS는 Cmd+V가 NSMenu key equivalent로
처리되어 DOM `keydown`의 `preventDefault()`로 못 막는다 → xterm.js 자체 네이티브
`'paste'` 리스너(`terminal.element`/`textarea`에 직접 붙음, `node_modules/@xterm/xterm/lib/xterm.js`에서
직접 확인)와 wmux의 커스텀 비동기 IPC paste 경로가 같은 pty에 동시에 써서 레이스가
생긴다.

**적용한 fix:** `src/renderer/hooks/useTerminal.ts` — 터미널 컨테이너(xterm
element/textarea의 상위 요소)에 capture-phase `'paste'` 리스너를 추가하되,
Cmd+V/Ctrl+V/Ctrl+Shift+V keydown 직후 `NATIVE_PASTE_RACE_WINDOW_MS`(300ms) 이내에만
"레이스 중"으로 보고 `stopPropagation()`으로 차단한다. 그 밖의 native paste(메뉴바
Edit>Paste 마우스 클릭, VoiceOver, UI 자동화처럼 keydown이 없는 경로)는 그대로
흘려보내 xterm 자체 파이프라인에 맡긴다 — 팀 리뷰(review-team, Claude 패스)가 무조건
차단하면 그 경로들이 조용히 무동작해지는 회귀를 잡아서, 시간 윈도우 방식으로
좁혔다.

**같이 확인한 사실:** `src/main/window/createWindow.ts`의 `new BrowserWindow({...})`에
`frame`/`autoHideMenuBar`/`titleBarStyle`가 전혀 설정되어 있지 않다. 즉 Electron
기본 메뉴바(Edit>Paste 포함)는 macOS뿐 아니라 **Windows/Linux에서도 그대로
노출**된다.

## 검증 안 된 것 (이번 세션의 한계)

1. **Windows에서 실제로 같은 레이스가 나는지 미검증.** "Windows는 단축키 처리가
   DOM keydown 흐름에 더 가깝게 통합되어 있어 재현 안 될 것"이라고 코드 주석·PR에
   적었지만, 이건 Electron/Chromium 아키텍처에 대한 **일반 지식 기반 추론이지
   wmux 실행 바이너리로 검증한 게 아니다.** Electron이 Windows에서 accelerator(메뉴
   단축키)를 실제로 어떻게 디스패치하는지 — WM_KEYDOWN 메시지 루프 레벨에서
   DOM `keydown`과 accelerator가 같은 이벤트를 공유하는지, 아니면 macOS의 NSMenu
   key equivalent처럼 별도 경로로 동시에 발화하는지 — 확인 안 됨.

2. **Linux(GTK) 검증 전무.** Windows보다도 더 안 봤다. 추가로 Linux 고유 이슈:
   `src/renderer/utils/clipboardChunk.ts` 상단 주석이 "middle-click paste on
   Linux"를 xterm native 파이프라인이 처리하는 대상으로 명시한다. middle-click
   paste(X11 PRIMARY selection)가 네이티브 `'paste'` DOM 이벤트를 발생시키는지,
   발생시킨다면 `lastPasteKeydownAt` 윈도우 로직과 어떻게 상호작용하는지(우연히
   직전에 Cmd/Ctrl+V를 했다면 300ms 윈도우에 걸려 오탐 차단될 수 있는지) 전혀
   조사 안 함.

3. **300ms 레이스 윈도우가 크로스플랫폼으로 유효한 가정인지 미검증.** macOS
   NSMenu 트리거는 사실상 동기적이라 300ms면 넉넉하다고 판단했는데, 이건 이
   파일의 기존 `RIGHT_CLICK_PASTE_SUPPRESS_MS` 관례를 재사용한 것이지 실측한
   값이 아니다. Windows/Linux에 별도 레이스가 있다면 그쪽 타이밍도 이 윈도우
   안에 들어오는지 모른다.

4. **GLM 5.2 리뷰가 완주 못 함.** `review-team` 실행 시 z.ai 게이트웨이가 두 번
   연속 529(과부하)로 실패했다. Claude 단독 리뷰로 CRITICAL 1건 잡아서 고쳤지만
   (native paste 무조건 차단 → 윈도우 방식으로 전환), GLM이 다른 각도(예:
   Windows/Linux 특유의 이슈)를 잡았을 가능성은 검증 안 됨. Codex는 바이너리
   미설치로 아예 못 돌렸다.

5. **macOS 실기기 라이브 검증도 여전히 미완.** PR #328 본문에 체크박스로 남겨둔
   기본 시나리오(Cmd+V 긴 경로 붙여넣기, 메뉴바 Edit>Paste 마우스 클릭) — 이건
   크로스플랫폼 이전에 macOS 기준선부터 닫아야 함.

## 조사 대상 (다음 세션 스코프)

### A. macOS 기준선 닫기 (선행 조건)
- `[단계]` wmux 앱 재시작(재빌드된 바이너리로) → 터미널 pane에서 (1) 긴 절대경로
  Cmd+V 붙여넣기, (2) 메뉴바 Edit > Paste 마우스 클릭 두 시나리오 실측
  `[검증]` 두 경우 모두 pty에 전체 텍스트가 정확히, 정확히 한 번 도달하는지 육안
  확인 (터미널 프롬프트에 찍힌 결과로 판단)

### B. Windows accelerator 디스패치 조사
- `[단계]` Electron/Chromium 소스 또는 공식 문서에서 win32 accelerator가
  DOM `keydown`과 독립적으로 발화하는지, 아니면 같은 이벤트 루프를 공유하는지
  리서치 (WebSearch 허용 — Electron GitHub 이슈에 관련 사례가 많음, "accelerator
  keydown race" "role paste double fire windows" 등으로 검색)
  `[검증]` 근거가 되는 구체적 소스/이슈 링크 확보. 추론이 아니라 1차 자료로
  뒷받침되는 결론이어야 함
- `[단계]` (가능하면) Windows 환경에서 wmux를 실제로 빌드/실행해 Ctrl+V + 메뉴바
  Edit>Paste를 실측. CI에 Windows 러너가 있으면(`ci-cross-platform-baseline.yml`
  확인) 거기서 자동화된 재현 시도도 고려
  `[검증]` 실측 결과를 이 문서에 기록

### C. Linux(GTK) 조사
- `[단계]` GTK 기반 Electron 메뉴 accelerator 디스패치 방식 리서치 (B와 동일
  방법론)
- `[단계]` middle-click paste(X11 PRIMARY selection)가 native `'paste'` DOM
  이벤트를 트리거하는지 확인 — 안 한다면(대부분의 X11 구현은 selection을 직접
  읽지 clipboard event를 안 씀) 이번 fix와 무관함을 문서화하고 끝. 트리거한다면
  `lastPasteKeydownAt` 윈도우와의 상호작용을 케이스로 정리
  `[검증]` Linux 환경(로컬 VM/CI)에서 실측 또는 GTK 소스/문서 근거

### D. 팀 리뷰 재시도
- `[단계]` `/review-team` 재실행 (GLM 502 재시도, 가능하면 Codex 설치 후 포함)
  대상: PR #328의 diff (`gh pr diff 328` 또는 `git diff origin/main...fix/macos-terminal-native-paste-race`)
  `[검증]` 3모델 중 최소 2개 이상 가동해서 교차 합의 리포트 확보. B/C에서 나온
  크로스플랫폼 조사 내용을 리뷰 프롬프트에 `--focus`로 반영

### E. 필요시 fix 확장
- A~D에서 Windows/Linux에 실제 레이스나 회귀가 확인되면, `useTerminal.ts`의
  `blockNativePaste`/`lastPasteKeydownAt` 로직을 플랫폼별로 분기하거나 윈도우
  값을 조정. 확인 안 되면(가장 유력한 시나리오) **코드는 그대로 두고 이 문서에
  "검증 완료, 변경 불필요"로 결론만 기록** — 불필요한 방어 코드 추가 금지
  (CLAUDE.md: 요청 안 한 리팩토링·과도한 추상화 금지)

## 완료 기준

- [x] A: macOS 실기기 두 시나리오 확인 완료 — **같은 날 오후 실측 완료
      (2026-07-03).** 처음엔 스킵했다가(이 세션을 호스팅 중인 프로덕션 앱이
      fix 없는 구버전 v3.12.0이라 재시작 리스크 있음), `WMUX_DATA_SUFFIX=-test`
      내장 격리 메커니즘으로 프로덕션 옆에 테스트 인스턴스를 동시 기동하는
      방법을 찾아 해결. 두 fix(이 브랜치 + PR #331 Finder 경로 fix) 결합
      빌드로 사용자가 직접 확인: (1) 긴 절대경로 Cmd+V ✓, (2) 메뉴바
      Edit>Paste 마우스 클릭 ✓, (3) Finder 폴더 Cmd+C→Cmd+V 전체 경로 ✓,
      (4) 일반 텍스트 회귀 없음 ✓.
- [x] B: Windows accelerator 디스패치 결론 + 근거 확보 (실측 또는 1차 자료)
- [x] C: Linux accelerator + middle-click paste 상호작용 결론 + 근거 확보
- [x] D: review-team 최소 2모델 교차 합의 리포트 확보 (Claude + GLM 5.2, Codex
      바이너리 여전히 미설치)
- [x] E: 조사 결과에 따라 fix 확장 — Windows/Linux는 "변경 불필요"가 아니라
      "가드 자체를 macOS 전용으로 축소"로 결론(아래 참고)
- [x] 이 문서를 조사 결과로 업데이트. PR #328은 owner가 fork 경유 대신 동일
      저장소 PR로 재오픈하며 close, 실제 작업 대상은 **PR #329**로 대체됨
      (커밋은 그대로 `fix/macos-terminal-native-paste-race` 브랜치에 추가하면
      #329에 반영됨 — 새 PR 불필요)

---

## 조사 결과 (2026-07-03 세션)

세션 전체를 Opus로 진행(연구 2건 + fix 구현 + Claude 리뷰 패스를 모두
`Agent`에 `model: 'opus'` 명시 위임 — 메인 세션 자체는 Sonnet 5로 시작되어
세션 상속 옵션은 못 씀).

### B. Windows — 결론: **레이스 재현 불가능** (신뢰도: 높음, 소스 확정)

원래 추정("Windows는 keydown 통합이 강해 아마 재현 안 될 것")보다 훨씬 강한
근거가 나옴 — 원인은 확률적 타이밍이 아니라 **구조적 부재**:

1. Electron 내장 `paste`/`copy`/`cut` 메뉴 role은 소스(`lib/browser/api/
   menu-item-roles.ts`)에서 `registerAccelerator: false`로 정의됨. Electron
   공식 문서: *"On Windows and Linux, ... so that the accelerator is visible
   in the system menu but not enabled."* → 기본 메뉴의 "Ctrl+V"는 라벨일 뿐,
   OS 단축키로 등록조차 안 됨.
2. 설령 등록되어도 Electron의 Windows 네이티브 창 코드(`native_window_
   views.cc`의 `HandleKeyboardEvent`)는 **렌더러가 처리 안 한(unhandled)** 키만
   받는 콜백이라, wmux의 Ctrl+V 핸들러가 이미 동기적으로 `e.preventDefault()`를
   호출하는 이상 도달하지 않음. Chromium 공식 문서(Aura 입력 모델): 포커스가
   웹 콘텐츠에 있으면 "important navigation accelerators"(Ctrl+T류) 제외 웹이
   우선.
3. 결론: macOS NSMenu key equivalent에 대응하는 "독립 네이티브 두 번째
   writer"가 Windows엔 아예 없음.

**잔여 불확실성(명시):** "keydown에서 preventDefault → Blink의 기본 paste
액션 자체가 안 뜬다"는 연결고리는 표준 Chromium DOM 동작으로 잘 알려져
있지만, 이 정확한 Electron 41 Windows 바이너리로 실측 확인된 적은 없음 —
연구 에이전트도 이 지점을 "표준 동작 기반 추론"으로 명시적으로 플래그함.
review-team의 GLM 패스도 독립적으로 같은 지점(연결고리의 실측 부재)을
짚었음 — 서로 다른 경로로 도출된 수렴 신호라 결론을 흔들진 않지만, 100%
실측 확인은 아니라는 점은 정직하게 남겨둠.

출처: Electron `lib/browser/api/menu-item-roles.ts`, `docs/tutorial/
keyboard-shortcuts.md`, `shell/browser/native_window_views.cc`, Chromium
`docs/ui/input_event/index.md`, Electron issue #19279/#11116/#48313.

### C. Linux — 결론: **accelerator 레이스는 불가능하지만, 별도의 실제 회귀
   리스크를 발견함** (신뢰도: 높음, 소스 확정)

- **Ctrl+V accelerator 레이스**: Windows와 동일 구조(Aura/Views 기반, 렌더러
  우선 + preventDefault로 억제됨) → 재현 불가능.
- **X11 middle-click(PRIMARY selection) paste**: Chromium이 middle-click 시
  진짜 DOM `'paste'` ClipboardEvent를 발화함(Mozilla Bugzilla #1461708 —
  *"Chromium dispatches 'paste' event even if it does NOT paste anything"*;
  Blink `SelectionController::HandlePasteGlobalSelection`). **기존
  `blockNativePaste`는 PRIMARY 출처와 CLIPBOARD 출처를 구분할 수 없어서**,
  Ctrl+V 직후 300ms 이내에 middle-click으로 다른 텍스트를 붙여넣으면 그
  이벤트를 오검출로 삼켜 조용히 무동작하게 만들 수 있었음 — 이건 macOS/
  Windows엔 없는 X11 Linux 전용 리스크. `clipboardChunk.ts`가 이미 "middle-
  click on Linux는 xterm 자체 onData 파이프라인으로 처리된다"고 전제하고
  있던 것과도 정면으로 충돌하는 지점이었음.

출처: Mozilla Bugzilla #1461708/#1521396, Blink 리뷰 `jzANXmR4pkU`, Electron
`root_view.cc`.

### D. review-team — Claude + GLM 5.2 교차 리뷰 (Codex 미설치, 2/3 가동)

대상: merge-base(`bdcfea1`) 기준 정정된 diff(`git diff origin/main`이 origin/
main의 문서 롤백 PR #327 때문에 무관한 README/이미지 차이를 섞어 보여줘서,
merge-base 기준으로 바로잡음 — 실제 대상은 `useTerminal.ts` +
`useTerminal.nativePasteBlock.test.ts` 2개 파일, 224줄).

**CRITICAL 0건.** INFO 수준 발견만 있었고, 처리 내역:

| 발견 | 합의 | 처리 |
|---|---|---|
| 신규 jsdom "non-macOS" 테스트가 실제 useTerminal 훅이 아니라 게이트 로직을 테스트 내부에서 재구현해 검증 — 실제 코드에서 게이트를 지워도 이 테스트만으론 안 잡힘 | **2-MODEL (Claude+GLM)** | 문서화만. 소스 레벨 정규식 테스트(같은 파일 첫 describe 블록)가 실질적 회귀 락 — 이 파일 전체가 원래부터 "실제 xterm+Electron 메뉴는 jsdom 재현 불가 → 소스 락 + 메커니즘 미러" 2단 구조였음(기존 3개 테스트도 동일 패턴). 새 테스트도 그 관례를 그대로 따른 것이라 구조를 더 키우지 않음 |
| Ctrl+V/Ctrl+Shift+V의 `lastPasteKeydownAt` 스탬프가 isMac 게이트 없이 전 플랫폼에서 찍힘 — 나중에 등록 게이트를 넓히면 값이 이미 차 있어 middle-click 오검출이 조용히 재발할 수 있음 | SOLO: GLM (conf 6) | **적용함** — 두 스탬프도 `if (isMac)`로 게이트(등록/정리와 일관성 확보, 2줄 변경) |
| `isMac` 상수가 723행(기존)과 408행(신규)에 중복 선언/shadow | SOLO: Claude (conf 6) | 미적용 — 기존 723행은 의도적으로 손대지 않음(CLAUDE.md: 인접 코드 리팩토링 금지, 최소 diff 원칙) |
| 정규식 락(`stampIndices.length===3` 등)이 포맷 변경에 취약 | SOLO: Claude (conf 7) | 미적용 — 이 파일 전체의 기존 테스트 관례이지 이번 변경이 새로 만든 패턴이 아님 |
| 300ms 윈도우가 출처 무관하게 전부 차단 — 이론상 오탐/누락 가능 | SOLO: GLM (conf 6) | 미적용 — 원래 PR(#328/#329)에서 이미 검토·승인된 기존 설계 트레이드오프, 이번 변경 범위 밖 |
| Ctrl+V 핸들러의 기존 주석("block event so xterm doesn't also paste via browser's native paste event")이 Win/Linux 리서치 결론과 모순 | SOLO: GLM (conf 5) | 재검토 후 기각 — 그 주석은 preventDefault의 *의도된 정상 동작*(표준 DOM: keydown을 preventDefault하면 후속 paste 이벤트가 안 뜸)을 설명하는 것이지, "native paste가 실제로 관측된다"는 뜻이 아님. macOS NSMenu 버그는 이 정상 규칙의 예외 사례. B 리서치가 이미 명시한 잔여 불확실성과 같은 지점 |

### E. 적용한 fix

`src/renderer/hooks/useTerminal.ts`:
- `const isMac = window.electronAPI?.platform === 'darwin';` 추가(mount effect
  top-level, 기존 723행 별도 선언은 그대로 둠).
- `blockNativePaste` 등록(`container.addEventListener`)과 정리(`removeEvent
  Listener`) 양쪽을 `if (isMac) { ... }`로 대칭 게이트.
- Ctrl+V(786행)·Ctrl+Shift+V(828행)의 `lastPasteKeydownAt` 스탬프도 `if
  (isMac)`로 게이트(Cmd+V 분기는 이미 `isMac &&` 조건 안이라 무변경).
- 상단 블록 주석 정정: "이론상 플랫폼 무관하게 방어한다"는 반증된 주장을
  제거하고 B/C 리서치 근거로 교체.

`src/renderer/hooks/__tests__/useTerminal.nativePasteBlock.test.ts`:
- 기존 8개 테스트 무변경. isMac 게이트 검증 테스트 2개 추가(소스 레벨 정규식
  1개 + jsdom 메커니즘 미러 1개) — CLAUDE.md "핵심 함수 테스트 1~2개 추가"
  규칙 반영, 추가 사실 보고함.

**검증**: `npx tsc --noEmit` 통과, `npx eslint useTerminal.ts` 신규 에러 0
(기존 6개 문제는 HEAD 대비 무관함을 확인), `npx vitest run src/renderer/
hooks`(31 files / 368 tests) 전체 통과.

### 잔여 리스크 / 후속 권장

1. ~~macOS 실기기 검증 미완~~ → **완료(2026-07-03 오후).** 위 완료 기준 A 참고.
2. Windows/Linux 결론은 1차 소스 기반으로 신뢰도가 높지만, 실제 바이너리
   라이브 테스트로 100% 확정된 것은 아님(위 "잔여 불확실성" 참고). CI에
   windows-latest/ubuntu-22.04 러너가 있으므로(`ci-cross-platform-baseline.
   yml`), 여유가 있으면 자동화된 스모크 테스트 추가를 고려.
3. 이번 조사로 "Windows가 현재 유일하게 실제 출시되는 플랫폼"(`plans/
   cross-platform-release.md`: "the only OS that works today")이라는 배경이
   확인됨 — 즉 B의 결론(Windows 안전)은 단순 참고가 아니라 현재 실사용자
   기반 전체에 대한 확인이었다는 뜻으로, 우선순위상 C보다 실질적으로 더
   중요했음.

## 참고
- PR: https://github.com/openwong2kim/wmux/pull/329 (이전 #328은 owner가
  fork 경유 → 동일 저장소 PR 전환을 위해 close, 같은 브랜치로 재오픈)
- 관련 fix 커밋: `d592027` (`fix/macos-terminal-native-paste-race` 브랜치),
  이번 세션의 isMac 게이트 커밋은 그 뒤에 추가
- 관련 기존 계획: `plans/cross-platform-release.md` (Windows/Linux 배포 전략,
  메뉴바/frame 논의는 없었음 — 이번 조사가 그 갭을 메움. 참고로 이 문서
  작성 시점(2026-05-31)엔 macOS가 DRAFT 단계였지만 현재(07-03)는 이미 v3.12.0
  프로덕션 앱으로 출시되어 있어 그 사이 진행됨)
- 관련 과거 버그: `e48f771` "chronic partial-paste truncation" — 같은 계열의
  paste 유실 버그가 반복되는 영역(이번이 최소 3번째: v2.9.1 최초 발견,
  e48f771/#36 main-side 100KB silent drop 수정, 이번 NSMenu race +
  크로스플랫폼 게이트). `gstack-learnings-log`에 기록 고려.
