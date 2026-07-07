# env-passthrough PR2 설계 — secret 값 비영속 (직렬화 경계 strip + 마이그레이션)

작성: 2026-07-08 | 베이스: PR1(`feat/env-execution-context`) 위 스택 | 대상: E-CRIT-4/1

## 1. 동기 — PR1이 노출을 넓혔다

PR1 이전에는 모든 pane이 gated라 `meta.env`에 자격증명이 아예 없었다. PR1 이후
**사용자 셸(passthrough)은 자격증명을 투과받고**, 그 resolved env가 데몬 세션 메타로
들어간다. 그런데 그 메타는:

- **디스크에 평문 영속** — `buildState`(`daemon/index.ts:2620`)가 `listSessions()`를
  그대로 `sessions.json`에 씀.
- **RPC로 노출** — `daemon.listSessions`(`daemon/index.ts:1276,1291`)가 `{...s}`(env
  포함)를 반환. 데몬 토큰을 가진 **모든** same-user 프로세스(도그푸드 MCP 포함)가
  전 세션의 env를 읽음.

즉 PR1은 사용자의 `GITHUB_TOKEN`·`KAD_GATEWAY_KEY` 등을 `~/.wmux/sessions.json`
평문 + 데몬 RPC로 흘리기 시작했다. **이건 새 기능이 아니라 PR1이 넓힌 유출 — 최우선 차단.**

## 2. 근본 원인 (코드 확정)

- 데몬은 `meta.env`(resolved, 자격증명 값 포함)를 **직렬화 경계에서 그대로** 내보낸다.
  인메모리 메타와 직렬화/공개 표현이 분리돼 있지 않다.
- 데몬 인증(`DaemonPipeServer.ts:436-447`)은 토큰 일치만 검증하고 **caller 신원을
  구분하지 않는다**. pane도 토큰을 보유하므로, 데몬 RPC 게이트만으론 pane과 main을
  못 가른다 → grant를 데몬이 해석하면 self-grant 벡터(E-CRIT-7).

## 3. 설계 — 인메모리 full env ↔ 직렬화 stripped env 분리

**원칙: 자격증명 *값*은 인메모리 spawn env에만 존재하고, 디스크·RPC로 나가는 어떤
표현에도 담기지 않는다.**

### 3.1 직렬화 경계 strip (핵심)
- `shared/envFilter`에 `stripCredentialValues(env)` 추가 — `isCredentialEnvKey`가 참인
  키를 제거한 fresh 사본(내부 WMUX_*/identity/PATH/LANG 등 비자격 키는 보존).
- 적용 지점 2곳:
  - `daemon.listSessions` 응답 — 각 세션의 `env`를 stripped로 치환 (RPC 유출 차단).
  - `buildState` — 영속 직전 세션 `env`를 stripped로 치환 (디스크 유출 차단).
- **인메모리 `ManagedSession.meta.env`는 full 유지** — spawn(`DaemonSessionManager`
  createSession)과 in-daemon suspend→restore가 이걸 직접 쓰므로 무영향.

### 3.2 in-daemon vs cross-restart 복구 구분
- **in-daemon 복구**(suspend/restore, 같은 데몬 생애): 인메모리 meta.env(full) 사용 →
  자격증명 유지 (동작 불변).
- **cross-restart 복구**(데몬 재기동, sessions.json에서): stripped env 사용 → 자격증명
  **부재**. 이는 수용된 저하 — PR3의 live 재해석이 이걸 닫는다. 릴리스 노트 명시.
  (PR1 이전에도 재기동 후 gated pane은 자격증명이 없었으니, 사용자 셸에 한해 "재기동
  후 새 pane을 열어야 자격증명 복귀"라는 기존 한계와 동일 계열.)

### 3.3 마이그레이션 스크럽
- 데몬 부팅 로드 시 기존 `sessions.json`의 각 세션 env에서 자격증명 값을 스크럽.
- `DaemonState.version`을 1→2로 범프, 로드 시 `.bak` 백업 후 스크럽본 저장.
- 스크럽 실패/파싱 오류는 fail-safe: 원본 보존 + 경고(세션을 잃느니 유출 위험을
  로그로 알리고 다음 저장 때 재시도). 절대 세션 목록을 통째로 드롭하지 않는다.

## 4. 왜 grant 서비스는 이 PR에서 빼는가

- **결합 리스크**: 명시 grant는 "자격증명을 gated pane에 재주입"인데, 재주입한 값은
  다시 영속되면 안 되고(이 PR의 strip과 상호작용), cross-restart 복구 시 재해석이
  필요(E-HIGH-6/7, 부팅 순서 위험). 이는 PR3의 live 재해석과 한 몸.
- **신뢰 경계**: grant는 **main-side 적용**이어야 안전하다(데몬은 caller 구분 불가).
  즉 main이 env 해석 시 grant된 자격증명을 strip 이후 재주입, 데몬은 여전히 verbatim
  재생. 이 설계는 데몬 grant 서비스가 불필요함을 의미하고, PR3(live 소스)와 함께
  구현하는 게 자연스럽다.
- 따라서 **PR2 = 순수 유출 차단**(능력 추가 없음). grant 능력은 PR3에 편입 권고.

## 5. 변경 파일 (예상)
- `shared/envFilter.ts` — `stripCredentialValues` 추가 (+테스트).
- `daemon/index.ts` — `daemon.listSessions` 응답 strip, `buildState` 영속 strip.
- `daemon/StateWriter.ts`(로드 경로) 또는 `daemon/index.ts` 부팅 — 마이그레이션 스크럽
  + version 2 + 백업.
- 테스트: strip 순수 함수, listSessions RPC 미유출, 영속 미유출, 마이그레이션 멱등·
  fail-safe, in-daemon 복구 자격증명 유지.

## 6. 수용 기준
- [ ] 사용자 셸(passthrough) pane 생성 후 `sessions.json`에 자격증명 **값**이 없다
      (이름/비자격 env는 있어도 무방).
- [ ] `daemon.listSessions` 응답에 자격증명 값이 없다.
- [ ] in-daemon suspend→restore 후 셸이 여전히 자격증명을 본다(동작 불변).
- [ ] 기존 자격증명 함유 `sessions.json`이 부팅 시 스크럽되고 `.bak` 백업이 남는다.
- [ ] 마이그레이션 파싱 실패 시 세션 목록을 잃지 않는다(fail-safe).
- [ ] PR1 회귀 없음(정책 분기·투과·게이트 불변).

## 7. Non-goals
- 명시 grant 통로(자격증명 재주입) — PR3.
- cross-restart 복구의 자격증명 재해석 / live 소스(EnvSource) — PR3.
- identity 1급 필드화 — 이 PR의 strip은 WMUX_* 를 보존하므로 `pty:list`의
  `s.env[WMUX_SURFACE_ID]` 복원이 계속 동작(불필요). 필요 시 PR3.
- Windows 레지스트리 병합 — PR3.

## 8. 리스크
- **마이그레이션이 최대 리스크**: 스크럽이 비자격 env(PATH/LANG/identity)를 잘못
  지우면 재기동 후 전 세션 셸이 깨진다. `stripCredentialValues`는 자격증명 키만
  건드리고(화이트리스트 아닌 좁은 블랙리스트), 백업 + fail-safe로 방어.
- 병렬 데몬 작업(완료증거·envelope)과 `daemon/index.ts` 충돌면 — 최소 diff·additive로.

---

# Eng Review 개정 (2026-07-08, Codex + Claude eng 서브에이전트 확정)

§3~§5의 "buildState + listSessions strip"은 **불완전·위험**으로 판명. 아래로 대체.

## R1. chokepoint = StateWriter (디스크), NOT buildState

buildState+listSessions는 디스크 writer 3개를 놓친다(양 모델 확정):
- `snapshotRunner.ts:71,85` — 자체 DaemonState를 listSessions()로 만들어 30초/생성마다 저장
- `index.ts:2755` — shutdown suspend가 `managedSessions.map(m => ({...m.meta}))` **직접**
  직렬화(buildState·listSessions 둘 다 우회) — **재부팅 복구의 주 영속 경로**
- `index.ts:3490` — Windows sync-exit 폴백이 위와 동일

**해결**: `StateWriter`(sessions.json의 **유일한** writer)에 private `toPersistable(state)`
—각 `session.env`를 `stripCredentialValues`로 **교체(fresh 사본)** — 를 두고 모든 write
경로(saveImmediate·async 큐 task·sync 폴백·flushSync)에 적용. 이러면 위 3개 + 미래
writer까지 **구조적으로** 커버.

## R2. 마이그레이션 = 버전 레지스트리 폐기, 부팅 스크럽으로

버전 범프(1→2 레지스트리 스텝)는 3중 하자(양 모델 확정):
- premigrate/`.bak`/rotation `.bak.N`이 **원본 자격증명을 영구 보존**(core.ts:490,
  rotation.ts:48, migrate.ts:278) — 스크럽하려는 그 secret이 백업에 남음
- 던지는 마이그레이터 = parse 실패 취급 → 백업 폴백 → 전 세션 드롭(core.ts:537)
- 4개 writer가 `version:1` 하드코딩 → 범프해도 매 저장이 되돌려 **매 부팅 재실행**;
  v0/no-version은 exact-step 부재로 throw→세션 상실(migrate.ts:126)

**해결(레지스트리 안 씀)**: 부팅 시 load()+recovery 후,
1. 기존 `sessions.json` **주 파일 + 모든 `.bak`/`.bak.N` 슬롯**을 1회 in-place 스크럽
   (각각 read→`stripCredentialValues`→원자적 rewrite; 없으면 skip). total·non-throwing —
   env가 없거나 non-object면 `{}`로 두고 세션은 **보존**(절대 throw/드롭 금지).
2. 이후 정상 write는 R1의 StateWriter strip으로 자동 clean 유지(rename된 `.bak`도
   이미 스크럽된 주 파일에서 오므로 clean).
- 레거시 함유 파일은 load가 인메모리로 자격증명을 올려 **첫 recovery는 자격증명 유지**
  (graceful), 직후 스크럽으로 at-rest 제거.

## R3. RPC 노출도 닫기 (fresh 사본)

- `daemon.listSessions`(index.ts:1276,1291) — 응답의 각 env를 stripped로 **교체**.
- `daemon.createSession` 반환(index.ts:1122) — main은 `pid`만 씀(pty.handler:443) →
  **최소 반환**(pid 등)으로 축소하거나 env strip.

## R4. fresh 사본 교체, in-place mutation 금지 (핵심 버그 예방)

`listSessions`는 `{...m.meta}` shallow copy라 `.env`가 **live meta.env와 동일 참조**
(DaemonSessionManager.ts:665). `delete s.env[k]`로 in-place 수정하면 **live env 오염 →
spawn/supervised-restart 붕괴**. 반드시 `{...s, env: stripCredentialValues(s.env)}`로
**참조 교체**. `stripCredentialValues`는 fresh 반환(buildFilteredEnv 재사용)이지만,
호출부가 반환값으로 **교체**해야 안전.

## R5. 개정 수용 기준 (추가)
- [ ] shutdown suspend·30초 스냅샷·Windows sync-exit 저장 후에도 sessions.json에
      자격증명 값 없음 (StateWriter chokepoint 실증).
- [ ] 부팅 후 주 파일 + 모든 `.bak` 슬롯에 자격증명 값 없음.
- [ ] `daemon.createSession`/`daemon.listSessions` 응답에 자격증명 값 없음.
- [ ] strip이 live 인메모리 meta.env를 오염시키지 않음(스폰·supervised-restart 불변).
- [ ] env가 non-object인 세션도 마이그레이션에서 보존됨(throw 없음).

## R6. 문구 정정
"in-daemon suspend→restore"는 부정확 — suspended 세션의 in-daemon restore는 없다
(attach/resize가 throw, DaemonSessionManager.ts:616/636). 유일한 in-daemon 재기동은
`restartSupervisedSession`(dead 세션, index.ts:986, live meta.env 사용). §3.2 문구를
"in-daemon supervised-restart는 live meta.env 사용"으로 정정.
