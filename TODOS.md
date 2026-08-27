# TODOS

## 보관된 에이전트의 비용 가시성 (#977 follow-up, P2)
- **What:** 페인 보관함(#977)은 세션을 계속 돌린 채 화면에서 치운다. 3일쯤 지나면 사용자가 몇 개를 잊는데, **토큰·CPU를 얼마나 태우고 있는지 보여주는 곳이 앱 어디에도 없다.** 로스터 행의 "2h 전" 상대시각이 신규 인프라 0으로 일부를 덮지만, 그건 시간이지 비용이 아니다.
- **왜 이번에 안 했나:** 실측 인프라(per-pty 토큰/CPU 집계)가 없다. #977의 blast radius 밖이고, 미터를 급조하면 틀린 숫자를 권위 있게 보여주는 쪽이 침묵보다 나쁘다.
- **Priority:** P2

## session-owned shelf — 보관함의 장기 모델 (#977 / #1011, P3)
- **What:** #977은 `Workspace.stashedPanes` 배열로 "레이아웃 트리 = 소유한 페인" 등식을 깼다. 12개월 이상향은 **데몬 세션이 정본이고 레이아웃은 세션에 대한 attachment**인 모델 — attached / detached / exited 상태를 한 곳에서 다룬다.
- **묶어서 설계할 것:** #1011 "Archive / Recently Closed Workspaces"가 한 층 위의 같은 기능이고, TODOS의 cross-workspace pane move epic이 identity·profile·ordinal 때문에 막혀 있는 것도 같은 뿌리다. 셋을 따로 풀면 세 번째 페인 상태가 또 생긴다.
- **어휘 주의:** 페인 쪽은 `stash`를 유지한다. 채널의 `archive`는 **비활성화**를 뜻해서 "계속 실행 중"과 정반대다 — 이름을 합치면 의미가 충돌한다(`docs/api/inventory.md`에 구분 문장 있음).
- **Priority:** P3

## ✕ 유예 파괴 + 되돌리기 (#977 fast-follow, P2)
- **What:** 보관함이 들어간 지금 `✕`(즉사)와 치우기 버튼이 같은 시각 무게로 나란히 있다. 한쪽은 완전 복구, 다른 쪽은 에이전트 즉사인데 되돌리기 토스트는 치우기 쪽만 받아준다. `✕`도 "5초 유예 후 파괴 + 되돌리기"로 만드는 게 맞다.
- **왜 싸졌나:** stash가 선행되면 undo-close = **stash + 타이머**다. 데몬 세션 파괴를 유예하는 별도 메커니즘이 필요 없다.
- **Priority:** P2

## 오케스트레이터 자리를 Claude Code TUI 로 — 조사 완료, 다음은 도그푸드 (P1)
- **What:** 커맨더(Command Deck)가 원래 Agent SDK 자리라 채팅 UI 다. 오너 구상은 **오케스트레이터 자리를 진짜 Claude Code TUI 로** 바꾸고, 기존 자리는 그대로 둔 채 **옵션 선택 시 통짜 교체**.
- **조사 결과(2026-07-28, `plans/deck-commander-pty-survey.md` 23KB):** **거의 다 만들어져 있고 이미 출시됐다.** Settings 에서 **"Claude Code (terminal)"** 을 고르면 된다. 스위치·어댑터(`ClaudePtyBrainAdapter`, 벤더 `claude-pty`)·터미널 임베드(`BrainTerminalEmbed`)·훅 레인·벤더별 스레드 분리가 전부 존재. **판정 S — 단 셸 정책을 안 건드리는 경우.**
- **왜 싼가:** 함대·미션·루프·스케줄이 **전부 브레인 바깥**에 있다. heartbeat/scheduler/event-coalescer/decision 재개/loop kickoff 가 **전부 `runTurnForWorkspace` 하나를 통과**해서 자동화가 이미 벤더 무관하게 동작한다(pty 브레인엔 TUI 타이핑으로 실현).
- **다음 행동:** 만들 게 아니라 **써보는 것**. Settings 를 pty 벤더로 바꿔 도그푸드하면 걸림돌 1 이 실제로 얼마나 아픈지 즉시 나온다.
- **시스템 프롬프트 자리:** `<wmuxDir>/brains/<wsId>/CLAUDE.md` — 오퍼레이터가 직접 쓰는 파일, wmux 설정 불필요. **`.claude/skills/wmux-orchestration/` 내용이 들어갈 자리다.**
- **Priority:** P1

## 커맨더 셸 정책 — 통짜 교체의 유일한 진짜 설계 문제 (P1, 오너 결정)
- **What:** 커맨더 툴 표면은 allowlist 이고 `Bash` 가 이중 차단이다. 그런데 2026-07-28 오케스트레이션 작업의 **절반이 `git`·`gh`·워크트리**였다.
- **Why 어려운가:** `pane_split` + `terminal_send` 로 우회는 되지만 **exit code 를 못 읽고 출력 폴링이 필요**하다. 반대로 셸을 열면 **커맨더 role-gate 3중 방어(Layer 1 미등록 / Layer 2 서버 거부 / teardown deny)가 전부 무의미해진다** — 셸이 있으면 pane 도 닫고 gh PR 도 닫는다.
- **Context:** `src/shared/commanderSurface.ts`. 규칙은 "READS fleet-global, WRITES confined". fan-out 툴도 allowlist 에 없다(PR #673 워커 보고).
- **Priority:** P1 — 도그푸드 후 결정. 셸 없이 견딜 만한지가 먼저다.

## pty 브레인: 프롬프트 평탄화 + 제출 타이밍 (P2)
- **What:** `flattenPromptForPty` 가 개행·제어문자를 전부 스페이스로 바꾼다 → 다단계 지시·코드블록·체크리스트가 **한 줄로 뭉개진다**. 제출은 400ms/800ms 딜레이 + Enter 2회라는 경험적 타이밍.
- **Why:** 코드 주석이 직접 인정 — *"the first can still be swallowed when it lands during a TUI redraw right after the previous turn — observed in dogfood"*. **모델 문제가 아니라 입력 채널이 사람 키보드라서 생기는 근본 한계.**
- **Note:** 2026-07-28 오케스트레이션에서 내가 판에 긴 브리핑을 보낼 때 **두 번 제출 실패**한 것과 같은 뿌리다.
- **Priority:** P2

## pty 브레인 관측 비대칭 — 툴 칩·토큰 미터·버블 로그 오염 (P2)
- **What:** `claude-pty` 는 `tool-start`/`tool-end`/`usage`/스트리밍 델타를 **아예 안 낸다.** 그래서 이 벤더에선 **툴 칩(pane 점프 원클릭 — Deck 의 "모든 액션은 그 증거로 한 클릭" 리트머스)**·토큰/비용 미터·스트리밍 버블이 전부 죽는다.
- **더 나쁜 것:** 벤더를 오가면 **두 벤더의 버블이 한 로그에 섞인다** — `brainMessages` 는 workspace 단위 하나이고 벤더 무관하게 누적된다(세션 id 는 `wsId::vendor` 로 분리돼 있는데 버블 로그는 아님).
- **판정:** 이건 통짜 교체의 **부작용이 아니라 근거**다. 두 관측 표면이 이만큼 비대칭이면 한 화면에서 섞는 게 어느 쪽도 온전하지 않다. 지금의 sticky-터미널 + 아래 버블 로그가 그 절충이고, 벤더 전환 시 오염이 그 절충이 새는 지점.
- **Priority:** P2

## iOS 출시 차단 2건 + 미검증 파이프라인 (P0/P1)
- **판정서:** `~/Desktop/coding/wmux-ios/RELEASE-READINESS.md`. HANDOFF 의 "남은 둘"은 **둘 다 닫혔다**(① `/api/v1` → prefix 아닌 **핸드셰이크**로 해결, PR #648/3.37.x ② 사진 업로드 완료).
- **P0 업로드 차단:** `PrivacyInfo.xcprivacy` **0건** — `UserDefaults` 를 5개 파일에서 쓰는데 required-reason API 라 **ITMS-91053 거부**. 나머지 required-reason 계열은 grep 전부 0건이라 **선언 1건(CA92.1)이면 끝**. → 착수함
- **P0 오너 결정:** `ITSAppUsesNonExemptEncryption` 없음 → App Store Connect 가 "Missing Compliance" 로 멈춘다. 단순 HTTPS 가 아니라 **CryptoKit X25519 + AES-GCM 자체 프로토콜**이라 exempt 여부가 수출규제 판단. **오너만 정할 수 있다.**
- **P1 가장 큰 공백:** `~/Library/Developer/Xcode/Archives` 에 Wmux 아카이브가 **0건**. 서명→아카이브→export 경로가 **한 번도 안 돌았다.** 앱은 250테스트+실기 도그푸드 완료인데 **배포 파이프라인만 처녀지**. 여기서 터지는 게 정상이고 터지면 목록이 늘어난다.
- **P2:** remote 0개 — 64커밋 3일치가 이 맥 디스크 한 곳에만. 배포 차단은 아니고 백업 리스크.
- **참고:** TestFlight **내부 테스터(본인 팀)는 스크린샷·심사 불필요**. 외부 테스터일 때만 Beta App Review.

## ✅ 해결됨 — `wmux` CLI 가 임시 경로를 가리키던 문제 (2026-07-28)
- `~/.local/bin/wmux` 가 `/private/tmp/claude-501/.../scratchpad/cv-merge/...` 를 가리키고 있었다. macOS 가 `/private/tmp` 를 주기적으로 청소하므로 **어느 날 `wmux` 명령이 통째로 사라질 상태**였다.
- `/Applications/wmux.app/Contents/Resources/cli-bundle/index.js` 로 재연결하고 동작 확인. 이전 심링크는 `/tmp/wmux-symlink.bak`.
- **교훈:** 워커가 빌드 산출물을 PATH 에 링크할 수 있다. 브리핑에 "임시 경로를 PATH 에 걸지 마라"를 넣을 것.


## ✅ #679 명시적 `surfaceId` 경로 검증 — 툴 계층은 닫혀 있다 (2026-08-05)
- **원래 질문:** PR #679는 *신원 해석 실패* 시 브라우저 페이지 선택이 fail-open 하던 걸 막았다. 호출자가 `surfaceId`를 **명시적으로 넘기는** 경로도 소유권을 검증하는가?
- **답:** **툴 계층에 한해** 검증한다 — 이 범위 한정이 결론의 일부다. 전송 계층과 무스코프 호출 경로는 여전히 열려 있다(아래 "닫히지 않은 것"). 툴 계층을 닫은 건 #679가 아니라 그 뒤의 #695 작업이다. 세 층을 따라간 결과:
  1. **진입** — 브라우저 툴 전 호출 지점이 `getPageForScope(scope)` 하나만 쓴다. `scope`는 `requireBrowserTargetScope()` 산출물이고 workspaceId가 비면 fail-closed(`browserScope.ts`). `getPage()`는 private, 다른 진입점 없음 → 명시 surfaceId도 workspaceId 없이는 도달 불가. **단 이건 규약이지 구조가 아니다**: `resolveSelectionContext`의 explicit 분기는 workspaceId 유무와 무관하게 ctx를 만들고, `selectRegisteredTarget`의 `(!workspaceId || targetsScoped)` 단락은 workspaceId가 없으면 surfaceId만으로 무검증 반환한다. 지금 안전한 이유는 전 호출자가 `getPageForScope`를 쓴다는 사실뿐 — 호출자 하나만 우회하면 깨진다.
  2. **엔진 선택** — `selectRegisteredTarget()`이 명시 surfaceId를 대조한다. **두 분기의 검사 주체가 다르다**: 최신 main(`targetsScoped`)에서는 `browser.cdp.info`가 caller workspaceId로 **서버측 필터**를 이미 걸었으므로 응답에 남 워크스페이스 타깃이 없고, 클라이언트는 별도 재확인을 하지 않는다 — 이 경로의 소유권 검사는 서버 필터 **하나뿐**이다(서버가 소유권의 권위이므로 자가보고가 아니지만, 방어심층은 여기서 한 겹이다). 레거시 main에서만 클라이언트가 `target.workspaceId !== workspaceId`를 `WORKSPACE_SCOPE_UNRESOLVED`로 거부한다(태그 없는 타깃도 거부).
  3. **RPC 폴백 + 소유권** — #679 체인지로그가 "별개 구멍"이라 남겨둔 폴백은 이제 `sendScopedBrowserRpc`가 workspaceId를 강제 주입하고 params의 surfaceId를 덮어쓴다. 서버 핸들러는 전부 `scopeOf(params)`를 넘기고(누락 0건), 최종 판정은 `WebviewCdpManager.getTarget()`의 `ownedBy()` — 명시 surfaceId 분기에도 적용된다. `browser_tabs select/close`는 렌더러의 `findBrowserTab(workspaces, workspaceId, surfaceId)`로 워크스페이스-정확 조회.
- **회귀 커버리지:** `PlaywrightEngine.test.ts`의 *"strict surface targeting rejects a legacy main that returns a foreign or untagged explicit target"*, `WebviewCdpManager.test.ts`의 `getTarget('b-surface', 'ws-A') === null`.
- **닫히지 않은 것 — 이 항목을 "구멍 없음"으로 읽지 마라:**
  - **무스코프 호출 경로.** 파이프에 workspaceId를 **아예 안 보내면** `ownedBy(owner, undefined)`가 무조건 통과시키고 `getTarget`이 등록 맵 첫 세션을 반환한다. 도달 가능한 주체는 "손으로 만든 소켓 클라이언트"만이 아니다: `browser.evaluate`·`browser.read`·`browser.screenshot`은 `methodCapabilityMap`에서 **선언 가능한** capability이고(`RESERVED_PREFIXES`는 `wmux.`뿐), `PermissionEnforcer.check()`에는 **워크스페이스 차원이 아예 없다**(메서드 단위 capability만 본다). 즉 사용자가 승인한 **서드파티 MCP 플러그인**이 workspaceId를 생략하면 남의 워크스페이스 페이지에서 임의 JS 실행·스크린샷이 된다. 사용자는 "브라우저 평가"를 승인한 것이지 "모든 워크스페이스의 브라우저"를 승인한 게 아니다.
  - **Transport layer — #810 narrowing in progress.** `browser.cdp.info` previously returned `cdpPort` even on scoped responses, so `browser.read` alone supplied a direct `connectOverCDP` path around tool-layer checks. The first #810 change withholds `cdpPort` and `shellUrl` from approved third-party and legacy callers while preserving supported first-party attachment. This is approved-plugin confinement, not a same-user security boundary.
  - 이 둘은 #113 same-user 천장으로 뭉뚱그리기엔 주체 집합이 넓다. **#810**에서 추적한다.

## ✅ 스코핑 조사 U4·U8·U3 검증 완료 (2026-07-30)
- **U8** (`meta.setStatus/setProgress`): **REAL (P2) → FIXED** — `meta.rpc.ts`에 senderPtyId 기반 워크스페이스 해석 추가. 외부 caller는 서버가 해석한 ws만 쓰고, 해석 불가면 **거부**(fail-closed). 렌더러가 ws 없는 payload를 활성 워크스페이스에 적용하므로 `undefined` 통과는 취약점 그대로였다.
- **U4** (`principal.remove`/`markStaleWorkspace`): **ACCEPTED** — transport-mitigated (renderer-only IPC + wmux.internal capability + same-user ceiling).
- **U3** (`operatorList` "파이프 미등록"): **ACCEPTED** — 용어 혼란. 외부 facing RpcRouter에는 미등록, daemon 내부 파이프에만 등록. 주석 정정 완료.
- 판정서: `plans/scoping-u4-u8-u3-verdict.md`

## A4 재정의 — 자식 워크스페이스 트리 대신 "막힘 노출" (P1)
- **What:** 원안은 fan-out 태스크를 부모의 하위 워크스페이스로 만들어 오케스트레이터가 읽고 풀 수 있게 하는 것. **범위를 좁히자** — `agent.awaiting_input` 이벤트를 태스크 소유자에게만 보이게. 권한이 아니라 **가시성만**.
- **Why:** 2026-07-28 실측상 필요한 셋 중 둘(화면 보기·승인 풀기)은 **판을 오케스트레이터 워크스페이스에 만들면 해결**된다. 남는 건 "막혔다는 사실을 아는 것" 하나뿐이다. 계층 도입은 스코핑 164지점 상당수를 "동일하거나 소유자이거나"로 바꿔야 하고 전이·역방향·복구 규칙까지 필요해 표면 대비 이득이 작다.
- **Pros:** 신규 신뢰 프리미티브 0개 — `agent.awaiting_input`은 이미 감지되고, `a2a.task`가 이미 dual-party 예외 선례이며, `task.owner.verifiedWorkspaceId`는 이미 서버 검증돼 기록된다. Claude Agent Teams가 같은 형태로 이미 출하("teammate permission prompts appear in the lead session").
- **Cons:** 원안이 주던 "자식 판 화면 읽기"는 못 얻는다(배치로 우회).
- **Depends on:** 권한 경계 인접 → 3모델 패널.
- **Priority:** P1

## ✅ `plans/` 추적 여부 결정 — DONE (2026-07-30)
- `.gitignore`에서 `plans/` 항목 제거. 새로 작성한 설계 문서가 정상 추적 가능해짐.
- 기존 추적 중이던 파일은 영향 없음(gitignore는 이미 추적된 파일에 무효).
- 같은 커밋에서 로컬 런타임/생성물(`.tokensave/`, `.wmux/`, `semantic-review/`, `vite.*.dev.tmp.config.ts`)은 명시적으로 ignore.
- 워커가 `git add -f`로 우회할 필요 없어짐.

## `@anthropic-ai/claude-agent-sdk` 재배포 권리 미확인 (P2)
- **What:** 서명·공증 바이너리에 번들된다(`out/.../Resources/claude-agent-sdk/`). LICENSE.md는 "All rights reserved", 링크된 Anthropic 약관은 **사용**만 부여하고 재배포·서브라이선스·번들링에 침묵. 2026-07-28 양쪽 원문 확인 — 허락도 금지도 없음.
- **Why:** copyleft가 아니라 소스 공개 의무는 없다. 노출은 **재배포 권리 부재**다. 별개로 문서가 "Agent SDK 쓰는 개발자는 API 키 인증을 쓰라"고 권고하는데 `ClaudeSdkAdapter`는 `ANTHROPIC_API_KEY`를 의도적으로 스크럽해 구독 인증으로 떨어뜨린다(주석: "the wmux moat").
- **Context:** `license-allowlist.json` 9개 항목에 `redistributionStatus: unresolved`로 기록됨(PR #676). 해소 경로: 번들에서 빼고 사용자 머신에서 해석. 메모리의 `SDK/-p 유료화 헤지` TODO와 같은 줄기.
- **Priority:** P2 — 기록은 끝났고, 판단은 오너 몫.

## 별건 위생 묶음 (P2)
- `THIRD_PARTY_NOTICES` 버전 드리프트(기록 1.27.1 vs 설치 1.29.0) — PR #676의 재생성으로 해소됐는지 확인 필요
- `.claude/worktrees/agent-*` 잔여 24개 — README는 fan-out을 "never as mystery folders"로 파는데 리포가 그 상태다. wmux 정리 목록이 `~/.wmux/worktrees/`만 본다
- CHANGELOG `[Unreleased]`에 grapheme 항목 3개 중복 — #671 되돌림으로 전량 삭제 대상이었는데 확인 필요
- `collect-changelog.mjs`가 `## [Unreleased]` 헤딩을 **소비**한다 — 릴리즈 때마다 다음 사람이 손으로 다시 넣어야 하고, 안 넣으면 `applyToChangelog`가 throw한다(`changelog-fragments.mjs:117`). 3.47.1·3.48.0 두 릴리즈가 연속으로 이 절차를 밟았다. 수집기가 접은 뒤 빈 스텁을 되돌려놓으면 끝. ★3.47.1 릴리즈 커밋이 "이미 TODOS에 있다"고 적었지만 실제로는 없었고, 3.48.0이 그 문장을 검증 없이 복사했다 — 이 줄이 그 부채를 실제로 등록한다
- wmux web 터미널이 유니코드 애드온 미탑재 → Unicode 6 기본값. 데스크톱과 같은 판이 폰에서 폭이 다르다
- 오케스트레이션 스킬 3차 개정 — 긴 메시지 붙여넣기 실패 사례, 감시가 유휴도 잡아야 한다는 것


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

## ✅ (E5) Tray icon unread badge — DONE (2026-07-30)
- macOS: `app.dock?.setBadge(N)` (999+ cap, 0이면 빈 문자열로 클리어). Windows/Linux: tray tooltip `[N] wmux`.
- Renderer StatusBar에서 `computeUnreadCount` 변경 시 `useEffect`로 `IPC.NOTIFICATION_BADGE_COUNT` 전송.
- main `registerHandlers.ts`가 렌더러 값을 음이 아닌 정수로 정규화한 뒤 `tray.ts:updateUnreadBadge()` 호출.
- 3 OS QA는 별도. 단위 테스트로 두 플랫폼 분기·클리어·캡·정규화를 고정.

## ✅ Fix B — cap-aware suspended-session promote (2026-07-30)
- `daemon.listSessions({includeSuspended})` + 신규 `daemon.promoteSession(id)`. `pty:promote` IPC를 통해 `AppLayout.reconcilePtys`가 파괴적 clear **직전에** promote 시도. cap 초과로 자동 복구되지 못한 session도 ptyId를 유지한 채 reconnect.
- promote 실패(cap hit / spawn 실패)는 기존 clear 경로로 그대로 흘러간다. `pty.promote`가 없는 구버전 main·local mode는 Fix B 이전 동작 유지.
- 이미 active면 멱등 성공, suspended가 아니면 NOT_FOUND, transient ConPTY error 87만 제한 재시도.
- **남은 검증:** 실제 PTY spawn·scrollback dump 재생·cap RESOURCE_EXHAUSTED 경로는 라이브 데몬 dogfood 필요. 구조 불변식은 `pty.handler.promote.test.ts` + `appLayout.sessionSaveInvariants.test.ts`가 고정.

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
> **STATUS 2026-07-17 — CODE SHIPPED; only a live probe is left.** The launcher 3-defect chain
> shipped in v2.16.2 (PR #93: `checkProcessLiveness` 3-state, `tryEscalatedReping`,
> `classifyReclaimProbe` live-owner fail-fast + exit 75). The residual daemon-side sibling
> (`src/daemon/index.ts` `isProcessRunning` `catch → false`) shipped too — **`10c8a4b`, PR #323
> "feat: unattended supervisor + reboot-reattach RCA fix", 2026-07-02.** Verified on main today:
> `lockOwnerIsReclaimable` lives in `src/shared/processLiveness.ts` and is imported by
> `src/daemon/index.ts`, `classifyReclaimProbe` is in `DaemonPipeServer.ts`, and the old
> `isProcessRunning` is gone.
>
> Corrects the previous status block, which said the fix was "on branch `feat/unattended-supervisor`".
> That branch was merged by #323 the day after it was written and its ref deleted; nothing was ever
> stranded on it. (The 2026-07-17 direction review inherited the same stale claim and had it queued
> as a "revive or retire?" owner decision — there was nothing to revive.)
>
> **Remaining: the dynamic autostart-triggered 2-instance race probe (live).** That is a
> verification, not code.
>
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

## ✅ (bug) transient per-ptyId 맵 leak — FIXED (2026-07-30)
- `surfacePorts`와 `surfaceAgentStatus`를 `closePane`(paneSlice.ts)과 `closeSurface`(surfaceSlice.ts) 양쪽에서 정리하도록 추가.
- 기존 `surfaceAgent`/`surfaceActivity`/`surfacePendingQuestion` 정리 패턴과 동일.
- **Cons:** 영향 미미(엔트리 작음).
- **Context:** `closePane`(paneSlice.ts:322) + `closeSurface`(surfaceSlice.ts:132)에 delete 추가. fleet-activity가 정리 패턴을 이미 깔아둠.
- **Depends on:** 없음.
- **Priority:** P3

## ✅ (security) Unscoped plugin events.poll — FIXED (2026-07-30)
- 방안 (a) 채택: `PluginFrame.tsx`의 `events.poll` 호출에 `activeWorkspaceId`를 실어보냄(첫 poll·후속 poll 양쪽). 활성 워크스페이스가 바뀌면 effect가 재구독.
- 플러그인은 이제 active workspace의 lifecycle 이벤트만 수신. 다른 ws의 `pane.created/closed/focused/process.*` 누출 차단.
- PRIVATE 타입(a2a.task, channel.*)은 이미 unscoped poll에서 fail-closed였음 — 변경 없음.

## (security) Unscoped `events.poll` is still an all-workspace firehose — ACCEPTED, tracked (2026-08-01)
- **Measured, not inferred.** An external pipe caller on the main pipe
  (`\\.\pipe\wmux<suffix>-<user>`, token `~/.wmux<suffix>-auth-token`) that polls
  `events.poll` with **no** `workspaceId` receives non-PRIVATE lifecycle events
  for **every** workspace. Verified live against the dogfood build: a single
  unscoped poll returned events carrying two distinct `workspaceId`s; the same
  poll scoped to one workspace returned only that one.
- **Why this is not a regression of the fix above.** The 2026-07-30 change fixed
  the *plugin client* (`PluginFrame.tsx` now always sends `activeWorkspaceId`).
  The server-side behaviour for an unscoped poll was never narrowed.
- **Accepted for now, same reasoning as U4:** transport-mitigated. Reaching this
  requires the main pipe plus the on-disk auth token, i.e. same-user access, and
  the trust ceiling is #113 (identity is self-reported). PRIVATE types
  (`a2a.task`, `channel.*`) remain fail-closed.
- **Revisit when** either the pipe stops being same-user-only (remote/relay
  callers) or per-caller capability scoping lands — at that point an unscoped
  poll should resolve the caller's workspace from `senderPtyId` and fail closed,
  the way `meta.setStatus` now does.
- **Priority:** P3.

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

- [ ] Update the release procedure in CLAUDE.md: main is a protected branch, so the chore(release) commit must land through a release PR (squash), with the v* tag pushed onto the release commit — direct `git push` to main is rejected. (2026-07-30, found while shipping v3.38.1)

## Browser guest discard/wake path has never actually run (P3, from #756 eng review 2026-08-02)
- **What:** Determine whether the #517 lightweight discard/wake path is reachable in practice, and either exercise it or retire the 15s wake budget.
- **Why:** `ensureAwake`/`WAKE_TIMEOUT_MS = 15_000` (`WebviewCdpManager.ts`) is live code that appears never to execute: lightweight mode is default-off and `waking discarded surface` / `wake timed out` occur **zero times** across every `%APPDATA%\wmux\logs\main-*.log`. Untested, unexercised code that sits in the path of every browser RPC is a standing hazard — it was mistaken for the cause of #756 precisely because it looks load-bearing.
- **Context:** Found 2026-08-02 while diagnosing #756. Earlier notes here claimed a discarded guest "fails to remount"; that observation came from `browser_close`, which *unregisters* the surface rather than discarding it, so no wake was ever attempted. Start by enabling lightweight mode and confirming a guest is discarded after `DISCARD_AFTER_MS`, then that `ensureAwake` wakes it.
- **Depends on:** — **Effort:** M. **Priority:** P3.

## RPC timeout abandons live server work (P2, from #756 eng review outside voice 2026-08-02)
- **What:** Give RPC a propagated deadline, cancellation, and a status/idempotency path so a timeout is recoverable instead of terminal.
- **Why:** Restores the principle already stated further up this file — a timeout or an exception means `unknown`, never `dead` — instead of widening the window around the violation. Today slow work masquerades as failure and a retry can duplicate side effects (a navigation, a click).
- **Context:** Surfaced by Codex outside voice reviewing the #756 plan, 2026-08-02. `wmux-client.ts:141` rejects and destroys the socket while the main-side handler keeps running uncancelled; `RpcRouter.ts:385` flattens errors to a bare string so no machine-readable cause survives the wire. #756 only bounds one handler wait (the DNS guard) and deliberately does NOT fix this. Touching the RPC envelope is a Substrate contract change (PROTOCOL.md, inventory.md, stability tier).
- **Depends on:** Should follow #756 so the timeout path has a known-good case to test against. **Effort:** L. **Priority:** P2.


## Expose pane.move over RPC/MCP (P3, from #645 eng review 2026-08-02)
- **What:** Add a `pane.move` (and `pane.swap`) verb so an agent can re-lay-out panes it owns, mirroring the existing `pane.split` / `pane.close` / `pane.focus` family.
- **Why:** Once humans can drag panes around, an orchestrator asking "put the worker pane next to mine" is the obvious next request. Deliberately NOT in the #645 PR — the human UX should settle first, and nobody has asked for the agent-facing version yet.
- **Context:** #645 ships renderer-only (keyboard + drag). The RPC version is not a thin wrapper: it needs an entry in `src/main/mcp/methodCapabilityMap.ts`, first-party gating (`firstParty.ts`), a `#236`-style workspace-scope + fail-closed guard like `pane.split` has (`pane.rpc.ts:267-301`), `node scripts/gen-api-reference.mjs` regeneration, and a `docs/api` stability-tier decision. Start from `movePane` in `paneSlice.ts` once #645 lands.
- **Depends on:** #645. **Effort:** M. **Priority:** P3.

## Cross-workspace pane move / break-pane (P3, from #645 eng review 2026-08-02)
- **What:** Move a pane into a different workspace, and break a pane out into a new one (tmux `break-pane`).
- **Why:** The natural follow-up question after in-workspace move ships: "why can't I drag it to the other workspace?" Scoped out of #645 because it is an identity problem, not a layout one.
- **Context:** Three constraints make this an epic rather than an extension. (1) `panePrincipalId(wsId, paneId)` is the channel-membership coordinate (`paneSlice.ts:518`, purged on close via `purgeMembershipDaemon`), so a moved pane changes principal and its channel rows must migrate rather than be dropped. (2) Workspace env profiles (`WorkspaceProfile.env` / `startupCwd`) differ, so the PTY arrives under the wrong environment. (3) The auto-name `w<wsOrdinal>-<ordinal>` embeds the workspace, so the pane must be reissued an ordinal from the destination's `nextPaneOrdinal` — which breaks the "a pane's name is stable for its lifetime" property that `paneSlice.ts:411` calls critical.
- **Depends on:** #645. **Effort:** L. **Priority:** P3.

## User-authored JSON agent profiles (P3, deferred by eng review 2026-08-08)
- **What:** A `~/.wmux/agent-profiles/*.json` overlay so an operator can add or fix agent detection without waiting for a release. Schema, fail-closed reader, regex guard, runtime budget, hot reload.
- **Why:** Deferred, not rejected. Once the detector's built-in profiles are restructured (evidence gates, `extends`, `gateHint`), JSON is only the serialization of a structure that already exists — but that is exactly why the constraints below must survive the wait. Re-deriving them cost a full eng review.
- **Constraints established 2026-08-08 (do not re-litigate, verify then apply):**
  - Custom profiles are DETECTION-ONLY. `isAgentSignal` (`signal-types.ts:223`) is a closed set and stays closed; a custom agent has no hook bridge to admit anyway. No resume binding (`daemon/index.ts:431`), no approval keystrokes (`approvalKeystrokes.ts:74`).
  - Reserve BOTH slugs and DISPLAY names. `agentDisplayToSlug` (`AgentDetector.ts:85-97`) switches on the display name, so a profile naming itself `Claude Code` inherits `claude` and reaches HookSignalRouter dedup/authority. Slug reservation alone is not enough.
  - Slugs must not contain `:`. `HookSignalRouter.key()` (`:264`) builds `${slug}:${ptyId}:${kind}` and `dropPty` scans `:${ptyId}:`; the invariant is stated at `:233-236`. A `custom:` namespace prefix would break it. Validate `/^[a-z0-9][a-z0-9-]{0,31}$/`.
  - `fs.watch` needs the polling fallback the real precedent has (`daemon/transcript/types.ts:49`), plus read-retry: on Windows it fires mid-write, so a debounce alone does not make a half-written file complete.
  - Invalidation must reach BOTH processes. `AgentDetector` is constructed in `PTYBridge.ts:258` (Electron main) and `DaemonPTYBridge.ts:182` (daemon); a daemon-only watcher leaves local-mode panes on a stale profile set.
  - A user-visible failure toast from the daemon is not free: it rides DaemonClient → DaemonNotificationRouter, and a new event type forces `node scripts/gen-api-reference.mjs` under the CI drift guard.
  - Reader reads, the setter authorizes. Copy the split from `firstPartyConfig.ts:10-15` so no future caller can route around the gate.
  - RE2 is not an option: it has no lookbehind, and the Claude gate at `AgentDetector.ts:155` uses `(?<!Open)`.
- **Depends on:** the built-in restructure (evidence gates + `extends` + `gateHint`) — those decide the public contract. **Effort:** M-L. **Priority:** P3 until someone actually asks for it.

## Grow the built-in agent profile set past 8 (P3, from eng review 2026-08-08)
- **What:** Add detection profiles for agent CLIs wmux does not recognize today. Content work, not engine work.
- **Why:** The detector restructure ships zero new agents by itself — a user still sees the same 8. If supported-agent count is a competitive number, this is the work that moves it.
- **Rule (non-negotiable):** every pattern must be captured from a live TUI, never guessed. `AgentDetector.ts:7-9`: *"Only use patterns that are UNIQUE to each agent's output ... False positives are worse than missed detections."* A false agent identity lies to the pane badge and the orchestrator reads that badge.
- **Context:** PR unit is one agent + its tests. Forks of an existing agent should be 3 lines via `extends` rather than a copied pattern block. Candidates are unverified until someone installs and runs them.
- **Perf threshold (measured 2026-08-08):** gate regexes run twice per completed line on any pane with no identified agent, forever. A cheap literal prefilter was benchmarked and NOT added, because at 7 gated profiles it is 0.84x — one `toLowerCase()` per line costs more than the seven regex tests it skips. It breaks even near 16 profiles and reaches 1.42x at 48. **If this list roughly doubles, add the prefilter** (see the note over `checkGates`).
- **Depends on:** evidence gates + `extends` (so forks stay cheap). **Effort:** S per agent. **Priority:** P3, always open — a good external-contribution surface.

## Widen the web terminal's scrollbar touch target (P3, deferred by eng review 2026-08-14, #890)
- **What:** Make the wmux-web vertical scrollbar grabbable by a finger. Measured on a 390×780 phone viewport against the dev server: the bar is **14px wide, the slider 20px tall**, and a CDP touch-drag on the slider moved the view **not at all** (`F-254 → F-254`). The touch-target standard the same file already applies elsewhere is 44px (`styles.css:32`, `--bar-h`).
- **Why deferred, not skipped:** #890 ships swipe-to-scroll, and once a swipe works the scrollbar stops being the only way into scrollback. Widening costs readable width on a 390px screen, so paying that before knowing it is still needed is the wrong order. **Re-evaluate after the swipe fix reaches the reporter** — if cnxiekun still reaches for the bar, widen it; if not, close this.
- **How, when it comes back:** keep the bar visually thin and give the slider a transparent expanded hit area rather than growing the painted bar. The live selector is `.xterm-scrollable-element > .scrollbar.vertical` — note xterm 6 moved this; the pre-#890 rules at `styles.css:200-208` targeted `.xterm-viewport::-webkit-scrollbar`, which xterm 6 no longer scrolls, so they were dead code (#890 retargets them).
- **Context:** xterm exposes no touch API at all (zero `touch` matches in `xterm.d.ts`); its VS Code `Gesture` helper is internal. Upstream gaps: xterm.js#5377 (no dedicated touch handling), #1007 (swipe should send arrow keys), #594 (momentum impossible — "the viewport is actually underneath the row divs"). Verification harness: `scripts/_dog890-final.mjs`.
- **Depends on:** #890 landing first. **Effort:** XS. **Priority:** P3.

## Release partial failures report as success (P2, from /autoplan review of #964, 2026-08-21)
- **What:** `release.yml` carries `continue-on-error: true` in six places — Chocolatey push, the winget job, the macOS and Linux asset uploads, and symbol upload. Each was deliberate ("an upload hiccup must not fail the whole release"), and together they mean a release where WinGet silently failed and macOS assets never attached still reports green.
- **Why:** the acceptance check people actually run is "did the run go green" plus an eyeball of the asset list. Both survive a partial publish. Nobody learns that Chocolatey is a version behind until a user reports it. This is the release-pipeline instance of the silent-failure class already recorded for this repo.
- **Shape:** a final step in `build` (or a small aggregate job needing the others) that collects each channel's outcome and writes them to `$GITHUB_STEP_SUMMARY` as a table — channel, attempted?, succeeded?. Fail the run only if a channel that was *supposed* to publish did not. Do not remove the `continue-on-error`s; the point is to stop them being invisible, not to make one hiccup discard a good build.
- **Context:** `release.yml:243` (choco), `:263` (winget), `:353` (macos), `:497` (linux), plus symbols. #964's dry_run path now exists, so this is testable without burning a tag.
- **Effort:** S. **Priority:** P2 — cheap, and it is the difference between "the release worked" and "the release reported success".

## `Publish perf history` can still fail without anyone noticing (P3, from /autoplan review of #964, 2026-08-21)
- **What:** the step that appends to the `bench-history` branch (`perf.yml`, `if: !cancelled() && github.event_name == 'push'`) has no failure surface. #602 fixed the *cause* of a six-week silent outage (the bot cannot push to a protected branch, so the trend went to an unprotected one) but not the *class*: if the push fails again for a different reason, the run is still green and the trend just stops.
- **Why now:** #964 moved checkout across a change in how credentials are stored (actions/checkout#2286, v6). That specific upgrade was verified — `bench-history` gained a commit on the first main run after #966 — but the verification was a human running one `gh api` call, which is not a mechanism.
- **Shape:** cheapest useful version is a scheduled job that checks the newest `bench-history` commit is younger than N days and opens/annotates if not. Watching the push step's exit code inside the run is weaker: the step is best-effort by design.
- **Effort:** S. **Priority:** P3.

## No YAML-level validation of the workflows (P3, from /autoplan review of #964, 2026-08-21)
- **What:** `workflowSecurity.test.mjs` and `perfWorkflow.test.mjs` are regex contract tests over the file text. Neither parses YAML, so a structurally invalid workflow, a misspelled key, or an expression that references a nonexistent context passes both and is discovered by GitHub at run time.
- **Shape:** `actionlint` in the `validate` job. It knows the workflow schema, the available contexts, and shellcheck for `run:` blocks. Keep both vitest files — they encode repo-specific contracts (#940's escalation topology, the pin policy) that actionlint knows nothing about.
- **Effort:** XS. **Priority:** P3.

## Pin comments are not verified against their SHAs (P3, from /autoplan review of #964, 2026-08-21)
- **What:** `pinConsistencyViolations` (added in #966/#971) enforces one action → one commit → one label across the workflows. What no test can check offline is whether `# v7.0.1` is *true* of the SHA it labels — a typo, a stale comment, or an annotated tag's tag-object SHA (also 40 hex characters, and broken at runtime) all pass.
- **Shape:** a weekly scheduled job that resolves each pinned tag via the API and compares. Deliberately not in the PR path: it needs network, and a rate limit or an upstream outage must not fail unrelated PRs.
- **Effort:** S. **Priority:** P3.

## Dependabot action updates have no owner or SLA (P3, from /autoplan review of #964, 2026-08-21)
- **What:** `.github/dependabot.yml` (#971) schedules monthly grouped PRs, split `ci-actions` / `release-actions`, with signpath ignored. What it does not define: who reviews them, how fast, what happens when a grouped PR goes red, or what to do about a compromised or retargeted upstream release.
- **Why:** monthly already accepts up to a month of exposure. A bot PR nobody owns becomes a bot PR nobody merges, and six months later the pins are stale again — the same state #964 fixed, but now with the appearance of being covered.
- **Shape:** CODEOWNERS on `.github/`, plus a decision on whether `ci-actions` is auto-merge-eligible once its PR is green (it is fully exercised by its own PR; `release-actions` is not, and needs a dry_run first).
- **Effort:** XS. **Priority:** P3.
