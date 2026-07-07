<!-- /autoplan restore point: /Users/wong2kim/.gstack/projects/openwong2kim-wmux/feat-completion-evidence-gate-autoplan-restore-20260708-004204.md -->
# 환경변수 상속 개선 설계 — passthrough allowlist + 관측가능성 + 레지스트리 신선 병합

작성: 2026-07-08 | 대상: wmux env 상속 결함 (MCP `${KAD_GATEWAY_KEY}` 빈 값 사건)

---

## 1. 문제 진술

wmux 아래에서 실행되는 도구(Claude Code, MCP 서버 등)가 OS에 등록된 특정
환경변수를 빈 값으로 보게 되어 연결이 실패한다. 대표 사례:

```
mcp config --env 'RAIL_APIKEY=${KAD_GATEWAY_KEY}'
→ Missing environment variables: KAD_GATEWAY_KEY
```

같은 변수가 시작메뉴에서 새로 연 PowerShell/Windows Terminal에서는 정상 표시된다.

## 2. 근본 원인 (코드로 확정)

두 개의 독립적 원인이 겹쳐 있다. **둘 다 고쳐야 사건이 재발하지 않는다.**

### 원인 A — env 스냅샷 냉동 (staleness)

- 새 pane env는 pane 생성 시점의 **main 프로세스 `process.env`**에서 온다
  (`src/main/ipc/handlers/pty.handler.ts:358` → 데몬 RPC로 전달, 데몬은 그대로 재생).
- wmux는 tmux식 백그라운드 상주(`src/main/index.ts:249`) + 단일 인스턴스
  잠금(`index.ts:258`) + 부팅 자동실행(`index.ts:130`, `HKCU\...\Run`) 때문에
  프로세스가 잘 죽지 않는다. 그래서 `process.env`가 최초 실행 시점에 냉동된다.
- 살려둔/복구 세션은 만들 때 env(`meta.env`)를 그대로 재생
  (`src/daemon/DaemonSessionManager.ts:156,254`) → 며칠 전 값 부활.
- Windows에서 `setx`/시스템 설정 변경은 레지스트리에만 기록되고 실행 중
  프로세스에 소급 적용되지 않는다. wmux는 `WM_SETTINGCHANGE` 브로드캐스트를
  받지 않는다.

**결과: "wmux 재시작", "새 워크스페이스"로도 해소되지 않는다** (관찰로 확인됨).
데몬까지 완전 종료해야만 신선해진다.

### 원인 B — 자격증명 이름 denylist (의도적 필터)

- `src/shared/envFilter.ts:34`의 `SENSITIVE_PATTERNS`가 `_KEY$` / `_TOKEN$` /
  `_SECRET$` / `_PASSWORD$` / `_CREDENTIALS$`로 끝나는 변수를 pane 진입 전 제거한다.
- **`KAD_GATEWAY_KEY`는 `_KEY$`에 걸려 항상 삭제된다.** 이건 시점과 무관한
  결정론적 필터라, staleness를 완벽히 고쳐도 이 변수는 여전히 빈 값이다.
- 이 필터는 pane 안 신뢰 못 할 npm 스크립트 등에 자격증명이 새는 걸 막는
  의도적 ground 보안 장치다 (제거 대상 아님).
- 현재 워크스페이스 프로필 에디터도 저장 시 secret-이름 키를 정책적으로 버린다
  (`src/shared/workspaceProfile.ts:69`, `dropSecretKeys`). **따라서 지금은
  `KAD_GATEWAY_KEY`를 pane에 주입하는 지원되는 경로가 존재하지 않는다.**

### 왜 두 원인을 분리해야 하나

원래 제안서(A안: spawn 시 레지스트리 재독)는 원인 A만 다룬다. A안을 완벽히
구현해도 레지스트리에서 갓 읽은 `KAD_GATEWAY_KEY`가 원인 B에서 다시 삭제되므로
이 사건은 재발한다. 제안서의 "이 클래스 문제가 함께 해결됨"은 틀렸다.

## 3. 설계 정체성 — wmux는 substrate인가 ground인가

- **substrate(tmux형)** 라면 denylist 자체가 계약 위반 — env는 충실히 투과해야 함.
- **ground(에이전트 상주지)** 라면 "기본 차단 + 명시적 지급(capability)"이 정답.

wmux는 A2A·채널·태스크 데몬·ClaudeWorker를 갖춘 **ground**다. 따라서 denylist
방향은 유지한다. 단 현재 구현의 진짜 결함은 필터의 존재가 아니라 **침묵**이다:
무엇을 왜 제거했는지 통보하지 않아 사용자가 며칠을 헤맸다. 올바른 capability
시스템은 차단을 **관측 가능**하게 만들고 **명시적 지급 경로**를 제공한다.

tmux 대조: tmux의 유일한 env 개입(`update-environment`)은 denylist가 아니라
**allowlist**이며, `show-environment`로 전부 관측 가능하고, 기존 pane 소급 불가는
문서화된 한계다. 배울 점 3가지: ① 갱신은 allowlist로 명시적으로, ② env는 관측
가능하게, ③ 소급 불가는 정직하게 문서화.

## 4. 제안 — "값이 아니라 이름을 저장하는" passthrough allowlist

워크스페이스 프로필에 `envPassthrough: string[]` (변수 **이름만** 저장). spawn 시점에
denylist가 다 걸러낸 **다음**, 이 목록의 변수만 **살아있는 OS 소스에서 그 자리에서
읽어** 주입한다. 값은 절대 디스크에 저장하지 않는다.

한 장치로 모든 요구를 만족:

| 요구 | 충족 |
|---|---|
| ground 보안 (기본 차단 + 명시 지급) | 차단 유지, 워크스페이스별 이름 지목만 통과 |
| secret 디스크 저장 금지 (기존 정책) | 값 저장 안 함, 이름은 secret이 아님 |
| tmux 교훈 (allowlist + 살아있는 소스) | `update-environment`와 동형 |
| staleness (원인 A) | spawn마다 새로 읽으므로 자동 해소 |
| 이번 사건 (원인 B) | 한 번 등록으로 해결 |

## 5. 실행 패키지 (PR 3개)

### PR1 — passthrough + 관측가능성 (최우선, 실제 아픔 해결)
- 프로필 스키마에 `envPassthrough: string[]` 추가.
- `resolveSpawnEnv`에서 denylist strip 이후, passthrough 이름 목록의 변수를
  live 소스(우선 `process.env`, PR2 이후 레지스트리)에서 재주입.
- spawn 시 denylist로 제거된 변수 **이름 목록**을 pane 메타데이터 + 로그 1줄로 기록
  → "왜 없지?"가 5분 디버깅으로 끝남.
- 검증: pane에서 `echo %KAD_GATEWAY_KEY%` 값 확인 + 프로필 JSON에 값 없음 확인.

### PR2 — Windows 레지스트리 신선 병합 (원인 A, A안)
- spawn 시 Machine(`HKLM\...\Session Manager\Environment`) → User(`HKCU\Environment`)
  병합. PATH만 `Machine;User` 연결. `REG_EXPAND_SZ`의 `%VAR%` 확장 처리.
  `HKCU\Volatile Environment` 포함.
- `process.env` 위에 **override 병합** (완전 치환 금지 — 부모 셸 세션 한정 변수 보존).
- reg.exe/powershell.exe shell-out 지양 → 네이티브 읽기 또는 TTL 캐시(2~5s)로
  pane-spawn hot path 지연 방지 (`launcher.ts:172` getProcessCommandLine이 이미
  겪은 비용 교훈).
- passthrough 읽기 소스를 이걸로 승격 → `setx` 직후 새 pane에서 즉시 반영.

### PR3 — 정직한 문서
- "살려둔/복구 세션과 이미 떠 있는 pane은 소급 안 됨(OS 원리)" 릴리스 노트에 명시.
  tmux도 동일한 한계. 개선 후 **새로 여는 pane부터** 반영.

## 6. 가드레일 (ground라서 필수)

**passthrough 등록은 사용자 제스처로만 가능해야 한다.** pane 안 에이전트가 프로필을
스스로 편집해 self-grant하면 이 장치 전체가 유출 통로가 된다 (보세구역 불출 대장에
작업자가 셀프 사인 금지). 등록 UI/RPC는 사용자 인증 경로로 제한.

## 7. Non-goals

- denylist 제거 또는 secret 이름 필터 완화 (ground 정체성에 반함).
- 이미 실행 중인 pane/자식 프로세스 소급 갱신 (OS 원리상 불가).
- macOS/Linux 레지스트리 상당물 (해당 없음 — 이들은 `process.env`가 신선하면 충분).
- B안(WM_SETTINGCHANGE 수신): 데몬은 창 없는 순수 Node 프로세스라 메시지 펌프가
  없다. A안이 두 spawn 경로(main/daemon)를 창 없이 균일 커버하므로 불필요.

## 8. 수용 기준

- [ ] `envPassthrough`에 `KAD_GATEWAY_KEY` 등록 후, 새 pane에서 값이 보인다.
- [ ] 프로필 JSON에 값이 저장되지 않는다 (이름만).
- [ ] wmux 실행 중 `setx FOO bar` 후, 새 pane에서 FOO가 즉시 보인다 (PR2).
- [ ] PATH가 Machine+User로 올바르게 병합된다 (중복/누락 없음).
- [ ] `REG_EXPAND_SZ`(TEMP/TMP 등)가 확장되어 들어온다.
- [ ] pane 생성 시 denylist 제거 변수 이름이 로그/메타데이터에 남는다.
- [ ] pane 안 에이전트가 passthrough를 self-grant할 수 없다.
- [ ] 기존 pane 동작에 회귀 없음.

## 9. 확정 필요한 taste 결정 (열린 질문)

1. **관측 통보 채널**: 로그 1줄 vs pane 메타데이터 vs 둘 다 vs UI 토스트.
2. **PR1과 PR2 순서/분리**: PR1만으로도 이번 사건은 해결됨(등록 시 process.env가
   신선하다는 전제). PR2는 staleness 별건. 별개 PR 2건이 맞는가?
3. **레지스트리 읽기 구현**: 네이티브 addon(크로스컴파일 리스크) vs reg.exe
   shell-out + TTL 캐시(단순, 약간 느림).

---

# /autoplan CEO Review (Phase 1) — 2026-07-08

## CEO DUAL VOICES — CONSENSUS TABLE
```
  Dimension                            Claude   Codex   Consensus
  ──────────────────────────────────── ──────── ─────── ──────────
  1. Premises valid?                   REFRAME  REFRAME  둘 다 핵심 전제 반박
  2. Right problem to solve?           partial  partial  mechanism 옳음/정책·포장 틀림
  3. Scope calibration correct?        NO       NO       per-ws 마찰+PR2 과대 (합의)
  4. Alternatives explored?            NO       NO       "필터 안함"·글로벌 미검토(합의)
  5. Competitive/market risks?         NO       NO       침묵 삭제=이탈 리스크(합의)
  6. 6-month trajectory sound?         NO       NO       냉동 자격+per-ws 부채(합의)
```
6개 차원 전부에서 **양 모델이 독립적으로 "설계 변경 필요"로 수렴**. 고신뢰 신호.

## 확정 발견 (심각도순, 양 모델 교차 합의)

- **CRIT-1 (Codex, 코드검증 CONFIRMED)** — §4의 "값은 절대 디스크에 저장 안 함"은
  **거짓**. 데몬이 resolved `env`를 세션 메타로 sessions.json에 저장
  (`DaemonSessionManager.ts:388`, `types.ts:31`; 주석 254·273 "persist a clean
  env / replays persisted meta.env"). passthrough 값이 env에 주입되면 그대로
  디스크+백업에 남는다. → **fix**: 영속 env를 `envRecipe`(이름/grant 서술자)와
  메모리 전용 spawn env로 분리. spawn/recovery마다 live 소스에서 재구성. 기존
  persisted secret 값 마이그레이션으로 스크럽.

- **CRIT-2 (양 모델, USER CHALLENGE)** — substrate-vs-ground는 **가짜 이분법**.
  wmux는 두 제품(사람 셸 pane + 에이전트 런타임 pane)이다. 이름 기반 필터를 모든
  pane에 균일 적용하면 터미널 계약(타 터미널은 다 투과)이 깨진다. → **fix**: 정책을
  **실행 컨텍스트**로: 사람이 연 대화형 셸 pane = live OS env 투과(단 wmux/Electron
  내부 auth는 계속 strip), wmux가 스폰하는 에이전트/supervised exec/plugin/무인 실행
  = 명시적 capability grant.

- **CRIT-3 (양 모델)** — 침묵 삭제는 "설정 누락"이 아니라 시장 리스크 버그.
  → **fix**: 무음 필터 금지. 첫 차단 시 **pane 가시 진단 + 원클릭 허용**,
  `wmux env doctor/diff`(OS env → wmux resolved → pane env).

- **HIGH-4 (양 모델)** — §6 "사용자 제스처만" 강제 불가(pane가 session.json 직쓰기로
  self-grant). → **fix**: grant를 main/데몬 소유 capability 서비스 뒤로. in-pane
  write API 없음. main 서명 토큰 붙은 항목만 데몬이 존중. pane가 추가 못 함을
  증명하는 테스트.

- **HIGH-5 (양 모델)** — per-workspace allowlist = 사용자 적대적 부채(n×m 등록/발견).
  → **fix**: 기본 글로벌(사용자 프로필) + config의 `${VAR}` 참조 자동 preflight
  grant 프롬프트. per-ws는 좁히기 override로만.

- **HIGH-6 (양 모델)** — PR1 단독은 신고 케이스 못 고침(소스가 냉동 process.env면
  undefined). §5 PR1 헤더/열린질문#2의 "PR1이 사건 해결"은 원인 A와 모순. → **fix**:
  passthrough 읽기 소스를 처음부터 live(레지스트리). "PR1이 해결" 철회.

- **HIGH-7 (Codex)** — "recovery replays exact create-time env"는 냉동 자격 보존 →
  로테이션 차단 + live-read와 충돌. → **fix**: recovery는 identity/세션 shape만
  재생, secret 값은 매 launch 현행 정책으로 재해석.

- **MED-8 (Claude C2)** — passthrough를 credential 클래스(③)로 **하드 스코프**.
  reserved `WMUX_*`·툴링 내부(①②)는 사용자 제스처와 무관하게 무조건 거부(re-entry/
  RPC 토큰 유출 방지). 재주입 위치는 strip 이후·identity/DATA_SUFFIX 이전 고정.

- **MED-9 (양 모델)** — 로그/메타데이터 이름 기록은 서비스/고객 누설 + 표면 과다.
  → **fix**: 영속 로그는 count/reason만, 정확한 이름은 로컬 사용자-오픈 inspector에서만.

## Decision Audit Trail
| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|----------------|-----------|-----------|
| 1 | CEO | CRIT-1 secret 영속: envRecipe/메모리 분리 채택 | Mechanical | P1 완결 | 코드검증된 사실결함, 선택지 없음 |
| 2 | CEO | CRIT-2 실행컨텍스트 정책 전환 | **USER CHALLENGE** | — | 양모델 전제반박 → 게이트로 |
| 3 | CEO | CRIT-3 실패순간 pane 가시 진단+원클릭 | Mechanical | P1 완결 | 침묵이 이번 사건의 실제 원인 |
| 4 | CEO | HIGH-4 main-서명 capability 서비스 | Mechanical | P1 완결 | 강제불가 가드레일은 무의미 |
| 5 | CEO | HIGH-5 기본 글로벌+preflight | Taste | P3 실용 | per-ws 마찰, 단 취향 여지 |
| 6 | CEO | HIGH-6 live 소스 처음부터 | Mechanical | P2 blast | 원인A와 모순 해소 필수 |
| 7 | CEO | HIGH-7 recovery 재해석 | Mechanical | P1 완결 | 로테이션 차단 회귀 |
| 8 | CEO | MED-8 credential 클래스 하드스코프 | Mechanical | P5 명시 | re-entry 방지 불변식 |
| 9 | CEO | MED-9 count/reason 기본, 이름 로컬 | Taste | P3 실용 | 채널 선택 취향 |

**Phase 1 판정: 설계의 mechanism(이름-only allowlist + spawn시 live 읽기)은 방향이
옳으나, 정책·강제·영속·입도 4축에서 재작성 필요. CRIT-2가 premise-level USER
CHALLENGE라 Eng/DX 진행 전 사용자 확인 필수 (아키텍처가 이 답에 종속).**

## D1 게이트 결과 (사용자 확정): 실행 컨텍스트로 전환

§3~§6은 아래 reframed 설계로 **대체**된다 (audit trail 보존 위해 원문 유지).

---

# Reframed Design — 실행 컨텍스트 정책 (post-D1)

## R1. 정책 = f(실행 컨텍스트), NOT f(변수 이름)

spawn 시점 신호로 분기 (신호는 이미 존재: `daemon/types.ts` exec/supervision/agent):

- **사람이 연 셸 pane** (`exec`·`supervision`·`agent` 전부 없음 = 순수 인터랙티브):
  → **live OS env 그대로 상속** (타 터미널과 동형). credential-이름 필터 **미적용**.
  단 wmux/Electron 내부만 무조건 strip: `WMUX_*` 예약 네임스페이스(특히 `WMUX_AUTH*`),
  `ELECTRON_*`/`VITE_*`/`NODE_OPTIONS`/`ELECTRON_RUN_AS_NODE`. (envFilter의 ①② 클래스는
  유지, ③ credential-이름 클래스는 셸 pane에서 해제.)
- **wmux가 스폰한 에이전트/exec pane** (`exec`||`supervision`||`agent` 세팅):
  → **기본 strip(③ 포함) + 명시적 capability grant**만 주입.

경계 근거: "사용자가 직접 연 셸이면 그가 로그인 셸에서 물려받은 env는 그의 것"
(사용자가 셸에서 손수 `claude` 실행 = 인터랙티브 → 투과 = 신고 시나리오 해결).
wmux가 자율 스폰한 에이전트만 반신뢰로 게이트.

## R2. CRIT-1 해소 — secret 디스크 영속 차단

현행: 데몬이 resolved `env`를 세션 메타로 sessions.json 저장(`DaemonSessionManager.ts:388`).
- 영속 대상을 **`envRecipe`**(비밀 아닌 env + grant 서술자=허용된 capability 이름 목록)와
  **메모리 전용 resolved spawn env**로 분리. 데몬은 envRecipe만 디스크에.
- spawn/recovery마다 grant를 **live 소스에서 재해석**. 기존 persisted `*_KEY/*_TOKEN/
  *_SECRET` 값은 마이그레이션으로 스크럽.

## R3. CRIT-3 해소 — 실패 순간 pane 가시 진단

- strip이 후속 config `${VAR}` 참조 실패로 이어지는 순간(또는 첫 차단) **pane 가시
  진단 + 원클릭 grant**. 무음 필터 금지.
- `wmux env doctor` / `wmux env diff` : OS env → wmux resolved → pane env 3단 표시.

## R4. HIGH-4 해소 — main 소유 capability 서비스

- grant는 main/데몬 소유 capability 서비스에. **in-pane write API 없음**. 데몬은
  **main-서명 토큰** 붙은 grant 항목만 존중(raw session.json 항목 무시).
- pane 프로세스가 grant 추가 불가함을 증명하는 테스트(★수용). C1 인접결함(hand-edited
  session.json의 secret-이름 프로필 env가 살아 들어감)도 이 서명 게이트로 차단.

## R5. HIGH-6/7 해소 — live 소스 + recovery 재해석

- grant 해석은 **처음부터 live 소스**(`EnvSource` 추상: Windows=레지스트리, mac/linux=
  process.env 또는 shell-env import). "PR1이 냉동 process.env로 해결" 주장 철회.
- recovery는 identity/세션 shape + envRecipe만 재생, secret 값은 매 launch 현행
  정책으로 재해석(로테이션 차단 회귀 방지).

## R6. taste (최종 게이트로) — grant 입도 & 관측 채널

- **입도**: 기본 글로벌(사용자 프로필) grant + config `${VAR}` 자동 preflight vs
  per-workspace. (HIGH-5)
- **관측 채널**: 영속 로그=count/reason만, 정확한 이름은 로컬 inspector만. (MED-9)

## R7. 개정 PR 시퀀스 (docs는 각 PR에 동봉 — trailing PR3 폐기)

- **PR1**: `EnvSource` 추상 + 실행컨텍스트 정책 분기(셸 투과/에이전트 게이트) + 관측
  (pane 가시 진단 + doctor). → 신고 케이스(사람 셸의 KAD_GATEWAY_KEY)를 실제로 닫음.
- **PR2**: capability 서비스(main-서명, in-pane write 없음) + envRecipe 영속 분리 +
  마이그레이션 스크럽.
- **PR3**: Windows 레지스트리 EnvSource 구현 + recovery 재해석(잔여 staleness 종결).

## R8. Non-goals (개정)
- 실행 중 pane 소급 갱신 (OS 원리상 불가, 문서화).
- 셸 pane의 내부 auth strip 해제 (WMUX_AUTH*/Electron은 무조건 유지).

---

# /autoplan Eng Review (Phase 3) — 2026-07-08

## ENG DUAL VOICES — CONSENSUS TABLE
```
  Dimension                            Claude   Codex   Consensus
  ──────────────────────────────────── ──────── ─────── ──────────
  1. Architecture sound?               NO       NO       R1 신호 거짓(합의)
  2. Test coverage sufficient?         NO       NO       6종 필수 테스트 부재(합의)
  3. Performance risks addressed?      NO       NO       EnvSource hot-path 행(합의)
  4. Security threats covered?         NO       NO       grant 위조/RPC 유출(합의)
  5. Error paths handled?              partial  partial  recovery 순서 위험(합의)
  6. Deployment risk manageable?       NO       NO       마이그레이션 fleet 리스크(합의)
```

## 확정 발견 (양 모델 교차 합의, 코드 file:line 근거)

- **E-CRIT-1 (합의)** — `exec/supervision/agent` 부재는 "사람 셸"의 신뢰 신호가
  아님. company/team 에이전트는 **인터랙티브 경로**로 스폰(`provisioner.ts:68,100`),
  `agent` 필드는 spawn에서 **한 번도 안 세팅**(`pty.handler.ts:364` 미설정, 죽은 신호),
  MCP claimWorkspace/surface.new/pane.split·무감독 project seed(`AppLayout.tsx:1088`)도
  신호 없음 → 전부 "사람 셸"로 오분류 → **가장 에이전트 밀집 pane이 풀 시크릿 상속**.
  → **FIX(자동채택)**: main 유도 `spawnKind: 'user-shell'|'agent'|'exec'` 명시 스탬프를
  스폰 원점(funnel/provisioner/company)에서 강제, **fail-CLOSED**(미스탬프→gated),
  `PtyCreateOptions`+`DaemonCreateSessionParams`에 추가, 두 callsite(`PTYManager.ts:166`·
  `pty.handler.ts:358`) 모두에 threading. R1의 "신호 이미 존재" 폐기.

- **E-HIGH-2 (합의)** — 로컬(비데몬) 모드는 신호 zero(`PTYManager.create` 컨텍스트
  파라미터 없음, `pty.handler.ts:456`이 로컬 분기 전 exec/supervision drop).
  → **FIX**: executionContext를 daemon/local 분기 **이전**에 계산해 양쪽에 전달.

- **E-HIGH-3 (합의, TASTE→최종게이트)** — X6 인터랙티브 resume은 spawn-time 분류로
  보호 불가(`agentResume.ts:347`, exec/supervision 부재·lastDetectedAgent 키). 셸이
  풀 env로 뜬 뒤 resume pill이 시크릿 보유 셸에 타이핑 → 사후 경계 없음. **정책을
  명시 결정 필요**: (a) 사용자가 손수 띄운 인터랙티브 resume은 passthrough 유지 vs
  (b) recovery 시점에 별도 gated 컨텍스트.

- **E-CRIT-4 (합의)** — "메모리 전용 env"는 디스크뿐 아니라 **데몬 메타+RPC에서도**
  제거해야 함. `DaemonSession.env`(`types.ts:31`)가 `listSessions`(`:665`)→
  `daemon.listSessions`(`index.ts:1276`)로 전달 → 데몬 토큰 보유 클라이언트가
  sessions.json 고쳐도 시크릿 read. → **FIX**: `ManagedSession.runtimeSpawnEnv`(메모리)
  ↔ 직렬화/공개 `DaemonSession` DTO(시크릿 env 없음) 분리.

- **E-HIGH-5 (합의, Codex 신규)** — env 제거가 surface recovery 파괴. main이
  `s.env[WMUX_SURFACE_ID]`로 surfaceId 복원(`pty.handler.ts:706`). → **FIX**:
  workspaceId/surfaceId/ptyId/memberId/suffix를 **1급 typed identity 필드**로 영속,
  WMUX_* 는 spawn 시 주입.

- **E-HIGH-6 (합의)** — 모든 recovery 경로가 `session.env` verbatim 재생
  (`index.ts:714,799,843,986`, `snapshotRunner.ts:71`). 데몬의 "profile-agnostic,
  replay-verbatim" 계약을 바꿔야 함. **recovery-순서 위험**: capability 서비스/
  EnvSource가 `recoverSessions` 전에 안 뜨면 무감독 에이전트가 **자격 없이 재기동**.
  → **FIX**: recovery도 동일 resolver(`envRecipe+spawnKind+identity+EnvSource`) 호출,
  부팅 순서 명시(verify key/cap 서비스 → recoverSessions), 마이그레이션은 live+
  suspended+backup 레코드 스크럽. (.buf 스냅샷은 scrollback만 — env 누출 없음, 안전.)

- **E-CRIT-7 (합의)** — main-서명 grant는 **위조 가능**. 데몬은 데몬 auth 토큰만 검증
  (`DaemonPipeServer.ts:436`)하고 pane은 그 토큰을 **설계상 보유**(MCP 도그푸드).
  pane이 grant-bearing create 파라미터 위조 또는 읽을 수 있는 키로 HMAC 위조 가능.
  → **FIX(자동채택)**: **데몬 소유 grant 레코드 + opaque grant ID** 방식(서명보다 우월).
  서명 유지 시 non-pane-readable 키 custody(main 메모리, spawn 핸드셰이크 전달, 비대칭)
  + (sessionId,capability,epoch,expiry) 바인딩 + revocation epoch(CHANNELS_EPOCH 패턴).

- **E-MED-8 (합의)** — `envFilter`가 내부+credential strip을 한 함수에 혼재
  (`envFilter.ts:25`), 매칭 **case-sensitive**라 소문자 credential 이름 우회 가능.
  → **FIX**: `buildInteractiveShellEnv`/`buildGatedAutomationEnv`로 분리, 키 정규화,
  origin×key-class×(local/daemon/recovery) 매트릭스 테스트.

- **E-HIGH-9 (Claude)** — EnvSource가 spawn hot-path에서 행 가능(reg.exe/PowerShell).
  → **FIX**: 하드 타임아웃 + `process.env` 폴백, spawn 절대 블록 금지.

## 필수 테스트 (양 모델, "pane self-grant 불가" 증명)
1. provenance: company pane+무감독 seed → **gated**, 맨 터미널 → user-shell (★최중요)
2. RPC self-grant: 데몬 토큰 pane이 grant RPC 호출 → **거부**
3. 위조 서명: pane이 읽은 토큰으로 grant HMAC → 데몬 로드 시 거부
4. replay/revocation: epoch 후 옛 grant 재생 → 거부
5. disk-secret 무시: hand-written secret env → 자식에 미도달
6. no-persist: granted secret 주입 후 sessions.json에 값 없음(이름만)

## Decision Audit Trail (Eng)
| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|----------------|-----------|-----------|
| 10 | Eng | E-CRIT-1 명시 spawnKind 스탬프 fail-closed | Mechanical | P5 명시 | 추론 신호 거짓, 대안 없음 |
| 11 | Eng | E-HIGH-2 분기 전 컨텍스트 계산 양경로 | Mechanical | P5 명시 | 로컬/데몬 대칭 필수 |
| 12 | Eng | E-HIGH-3 X6 resume 정책 | **Taste** | — | 사용자 정책 결정 → 게이트 |
| 13 | Eng | E-CRIT-4 runtimeSpawnEnv↔DTO 분리 | Mechanical | P1 완결 | RPC 유출 경로 실증 |
| 14 | Eng | E-HIGH-5 identity 1급 필드화 | Mechanical | P1 완결 | env 제거의 필연 종속 |
| 15 | Eng | E-HIGH-6 recovery 재해석+부팅순서 | Mechanical | P1 완결 | 자격없는 재기동 회귀 |
| 16 | Eng | E-CRIT-7 데몬소유 opaque grant ID | Mechanical | P5 명시 | 서명보다 단순·강함 |
| 17 | Eng | E-MED-8 빌더 분리+case 정규화 | Mechanical | P5 명시 | 우회 + 정책 명료화 |
| 18 | Eng | E-HIGH-9 EnvSource 타임아웃 폴백 | Mechanical | P3 실용 | hot-path 행 방지 |

**Phase 3 판정: pivot 방향 유효하나 R1 신호는 명시 provenance 스탬프로 교체,
R2/R4는 스코프 대폭 확대(env를 RPC/메타/recovery/identity 전반에서 재설계) 필요.
scope 현실: 이건 3-PR "작은 정리"가 아니라 데몬 신뢰경계 개편급. E-HIGH-3만 taste.**

---

# /autoplan DX Review (Phase 3.5) — 2026-07-08

## DX DUAL VOICES — CONSENSUS TABLE
```
  Dimension                            Claude   Codex   Consensus
  ──────────────────────────────────── ──────── ─────── ──────────
  1. Time-to-recovery < 5 min?         셸✅게이트❌ 동일  게이트 경로 미해결(합의)
  2. 정책 mental model 이해가능?       NO       NO       ambient 배지 필요(합의)
  3. 에러 메시지 실행가능?             NO(CRIT) NO(CRIT) 하류 문자열 미상관(합의)
  4. preflight 신뢰성?                 유예     유예      최대레버인데 taste(합의→승격)
  5. CLI 발견가능?                     NO       NO       wmux doctor 중복(합의)
```

## 확정 발견 (양 모델 교차 합의, 코드 근거)

- **DX-CRIT-1 (합의)** — `"Missing environment variables: X"`는 **wmux가 아니라 하류
  도구(MCP 클라이언트)가 뱉는 문자열**(`src/`에 0건). wmux가 strip 순간 아무것도 안
  하면 개발자는 며칠 헤맨 **똑같은 문자열**을 본다 → 재설계가 그에게 아무것도 안 바꿈.
  → **FIX(하드 수용기준)**: strip이 후속 `${VAR}` 참조 실패와 상관될 때 wmux 소유 라인을
  pane에 방출 — **문제+원인(정책 명명)+한줄fix+정확한 grant 명령/클릭** 리터럴 템플릿.
  R3의 "원클릭 grant"는 placeholder→명세로 승격.

- **DX-HIGH-2 (합의)** — 2-정책 mental model("셸=투과/에이전트=게이트")은 개발자가
  터미널 동작만으론 추론 불가. `$GITHUB_TOKEN`이 한 pane엔 있고 옆엔 없으면 원래 버그의
  "유령 비결정성"이 wmux 내부로 이전된 것. E-CRIT-1 fail-closed면 "셸처럼 보이는데
  gated"인 pane까지 생겨 혼란 가중. → **FIX**: **ambient pane 배지**(`passthrough`/`gated`,
  `Pane.tsx`) — 물리기 전에 정책을 보이게. 호버 시 "N개 자격 withheld → 검토 클릭".

- **DX-HIGH-3 (합의)** — preflight(`${VAR}` 감지→실패 전 프롬프트)가 사건을 **완전 예방**할
  최대 레버인데 R6 taste로 유예. E-CRIT-1이 config 산재를 실증(provisioner/company/MCP/
  seed) → preflight는 best-effort·누락 불가피. → **FIX**: wmux가 직접 파싱/런치하는 config
  (MCP 서버 config·project seed)에 한해 **preflight를 PR1 확정 산출물로 승격**, 나머지는
  reactive로 정직히 스코프. reactive 메시지(DX-CRIT-1)를 floor로 먼저 프로덕션급.

- **DX-MED-4 (합의)** — `wmux env doctor`는 기존 `wmux doctor`(이미 `environment`
  섹션·`CheckLine.hint`·`recovery[]`·`--json` 보유, `cli/commands/doctor.ts`)와 중복.
  3-tier(OS→wmux resolved→pane)는 CLI가 pane 안에서 돌아 자기 env는 pane tier뿐 →
  **main RPC 필수**. → **FIX**: 요약은 기존 `wmux doctor` `environment`에 접고,
  `wmux env diff [--pane]`(3-tier, main RPC 해석) + `wmux env grant/why/grants/revoke`
  동사. 출력: `VAR | OS | wmux정책(pass/strip/grant) | pane값 | next:<명령>`.

- **DX-HIGH-5 (Claude F-extra, 합의)** — 개발자는 pane 안에 사는데 E-CRIT-7이 in-pane
  grant 금지. (a) pane에서 grant 차단=끔찍한 DX(GUI 강제 이탈) vs (b) pane의
  `wmux env grant`가 **main 소유 GUI 확인**(진짜 사용자 제스처) 유발. → **FIX**: (b) 명시.
  CLI grant 허용하되 항상 main 확인 프롬프트, pane은 grant 자체를 쓰지 않음.

- **DX-HIGH-6 (Claude F-extra-2)** — E-HIGH-6 recovery 순서 위험은 DX로는 "grant했고
  됐는데 리부트하니 또 깨짐"(간헐적 = 원래 버그보다 나쁨). → **FIX**: 부팅순서를 **수용기준**.

## Developer Journey (게이트 경로, friction)
```
1 열기 low → 2 config low → 3 벽(하류문자열) CRIT → 4 wmux 탓 추측 CRIT(며칠 갭)
→ 5 doctor 발견 HIGH → 6 grant 방법 HIGH → 7 grant med → 8 검증 low → 9 재부팅 지속 HIGH
```
**노력이 friction과 역배분**: 설계는 5~8(doctor/cap 서비스)에 투자, 정작 막히는 3~4에 과소투자.

## TTHW / 복구시간
| 시나리오 | 시간 | <5분? |
|---|---|---|
| 인터랙티브 셸(정분류) = 신고 케이스 | ~0 (tmux parity) | ✅ 설계의 승리 |
| 게이트 + preflight 발동 | ~30s | ✅ |
| 게이트 + reactive 증강메시지(DX-CRIT-1) | ~2분 | ✅ |
| 게이트 + raw 하류에러(**현 설계 보장치**) | 30분~며칠 | ❌ 원래 버그 |
| 오분류 셸(스탬프 누락) | 시간~며칠 | ❌ 더 나쁨 |

## Decision Audit Trail (DX)
| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|----------------|-----------|-----------|
| 19 | DX | DX-CRIT-1 pane 인라인 메시지 리터럴 템플릿 | Mechanical | P1 완결 | 침묵이 실제 버그, floor |
| 20 | DX | DX-HIGH-2 ambient pane 배지 | Mechanical | P1 완결 | 물리기 전 가시화 |
| 21 | DX | DX-HIGH-3 preflight PR1 승격(파싱가능 config) | **Taste** | P1 완결 | 스코프 확대 취향 → 게이트 |
| 22 | DX | DX-MED-4 기존 wmux doctor에 접기+env diff | Mechanical | P4 DRY | 중복 CLI 금지 |
| 23 | DX | DX-HIGH-5 CLI grant + main GUI 확인(b) | Mechanical | P5 명시 | 키보드 네이티브 + 보안 |
| 24 | DX | DX-HIGH-6 부팅순서 수용기준화 | Mechanical | P1 완결 | 간헐 회귀 방지 |

**Phase 3.5 판정: 설계의 best case는 tmux를 이기나(0-step 투과+grant), worst case는
막으려던 그 며칠 사건과 동일 — 차이를 만드는 DX-CRIT-1(메시지)·DX-HIGH-3(preflight)이
미명세·유예. 둘을 하드 수용기준화 + ambient 배지면 게이트 복구 ~30s~2분.**

---

# /autoplan 최종 승인 (Phase 4) — 2026-07-08 · APPROVED

## 확정된 taste 결정 (사용자 게이트)
- **D1 (premise, USER CHALLENGE)**: 실행 컨텍스트 정책으로 전환 ✓
- **X6 resume (E-HIGH-3)**: **투과 유지** — 사용자가 손수 띄운 에이전트의 resume은
  passthrough (provenance='누가 띄웠나'=사용자, D1과 일관). 정책 불변을 명시 문서화.
- **grant 입도 (HIGH-5)**: **글로벌 기본 + `${VAR}` preflight**, per-workspace는
  좁히기 override로만.

## v2 확정 아키텍처 (mechanism + 정책)
1. **정책 = f(spawnKind)**: `user-shell`(투과, 내부 auth만 strip) / `agent`·`exec`
   (자격 strip + grant). 명시 스탬프, **fail-CLOSED**(미스탬프→gated), 스폰 원점에서
   강제, local+daemon 두 callsite threading. resume=user-shell 유지.
2. **secret 비영속**: `runtimeSpawnEnv`(메모리) ↔ 직렬화/RPC용 `DaemonSession` DTO
   (secret env 없음) 분리. `daemon.listSessions`도 DTO. identity(ws/surface/pty/
   member/suffix) 1급 typed 필드화 → surface recovery 보존. 마이그레이션 스크럽.
3. **grant = 데몬소유 opaque grant ID** (서명보다 단순·강함). in-pane write 없음.
   CLI `wmux env grant`는 main 소유 GUI 확인 유발(사용자 제스처). (sessionId,cap,
   epoch,expiry) 바인딩 + revocation epoch.
4. **live 소스 + recovery 재해석**: `EnvSource` 추상(Win=레지스트리, mac/linux=
   process.env/shell import), 하드 타임아웃+폴백(spawn 블록 금지). recovery도 동일
   resolver 호출, 부팅순서(verify key/cap 서비스 → recoverSessions) **수용기준**.
5. **관측 = floor + ceiling**: (floor) strip이 `${VAR}` 참조 실패와 상관 시 pane
   인라인 메시지 리터럴 템플릿(문제+원인+한줄fix+정확 명령/클릭) + ambient pane
   배지(passthrough/gated). (ceiling) wmux가 파싱/런치하는 config에 한해 preflight.
   요약은 기존 `wmux doctor` `environment`에 접고 `wmux env diff/grant/why/grants/
   revoke` 동사 추가.
6. **envFilter 분리**: `buildInteractiveShellEnv`/`buildGatedAutomationEnv`, 키 case
   정규화, origin×key-class×(local/daemon/recovery) 매트릭스 테스트.

## v2 수용 기준 (하드)
- [ ] company/team pane·무감독 seed·MCP surface.new/pane.split → **gated 분류**;
      맨 터미널 → user-shell (provenance 회귀 테스트 ★최중요).
- [ ] 데몬 토큰 보유 pane이 grant RPC 호출 → 거부. 위조 서명/session.json 주입 grant
      → 거부. epoch 후 replay → 거부.
- [ ] granted secret 주입 후 sessions.json·`daemon.listSessions` 응답에 값 없음(이름만).
- [ ] gated pane에서 자격 strip 시 pane에 wmux 소유 메시지(정확 명령 포함) 방출.
- [ ] ambient 배지가 pane 정책을 물리기 전 표시.
- [ ] `setx FOO`(Win) 후 새 셸 pane에서 FOO 즉시 보임; 신고 케이스(사람 셸의
      KAD_GATEWAY_KEY)는 grant 없이 투과로 해결.
- [ ] 리부트 후 grant된 에이전트가 자격 유지(부팅순서). EnvSource 행→폴백, spawn 무블록.
- [ ] 기존 pane 소급 갱신 불가는 문서화(OS 원리).

## 개정 PR 시퀀스 (scope 현실: 데몬 신뢰경계 개편급)
- **PR1**: spawnKind 스탬프(fail-closed) + `buildInteractive/GatedEnv` 분리 + EnvSource
  추상 + 관측 floor(pane 메시지 + 배지 + `wmux doctor` 통합). → 신고 케이스 해결.
- **PR2**: runtimeSpawnEnv↔DTO 분리 + identity 1급화 + 마이그레이션 스크럽 +
  데몬소유 grant 서비스(opaque ID, GUI 확인) + self-grant 테스트.
- **PR3**: recovery 재해석 + 부팅순서 + Windows 레지스트리 EnvSource + preflight(파싱
  가능 config) + `wmux env diff/why/grants/revoke`.
- docs는 각 PR 동봉(trailing docs PR 폐기).

## Completion Summary
| 항목 | 결과 |
|---|---|
| 리뷰 모델 | Claude 서브에이전트 ×3(opus) + Codex ×3, 각 단계 독립 |
| 총 결정 | 24 (auto 21 + taste 3) |
| USER CHALLENGE | 1 (실행컨텍스트 전환) — D1 게이트 해소 |
| CRITICAL 확정 | secret 영속(코드검증) / R1 신호 거짓 / grant 위조 / 하류 침묵 |
| Cross-phase | 침묵의 이전 · fail-closed provenance · 스코프 인플레이션 |
| 판정 | **APPROVED as v2** — 방향 견고, 구현 재작성, 스코프 재설정 완료 |

**STATUS: DONE.** 코드 구현은 이번 범위 밖(승인 후 별건). 다음: 구현 위임(레저) 또는 /ship.
