# WI-002 — MCP 신원 QUICK fix (identity 파일 폴백 + 진단 로깅)

> **레인:** L2 Core / Platform · **로드맵:** `100b-exit-roadmap-3person-13week-2026-06-26.md` W1 (D1–D5)
> **tier:** S · **PW:** 1.0 · **exit:** high · **launchCrit:** ✅ (런치 데모 same-machine A2A의 직접 블로커)
> **프로세스:** PLAN → **ENGREVIEW(plan-eng-review + codex)** → 구현 → REVIEW(code-reviewer + codex) → DOGFOOD(라이브)
> **준수:** [[feedback_no_claude_attribution]] · [[feedback_company_mode_is_paid_do_not_enable]](OSS 코어만, company.mcp 무변경) · codex 게이트

---

## 1. 한 문장 문제

> *"daemon 모드(프로덕션)에서 PTY shell은 `WMUX_PTY_ID` env를 받지만 MCP 서버는 그걸 읽지 않고, 자기 신원을 hop마다 PowerShell `Get-CimInstance`로 프로세스 트리를 walk해서 찾는다. 이 walk가 Windows에서 MISS하면 env 폴백(`WMUX_WORKSPACE_ID`)은 workspaceId는 주지만 **ptyId(`MY_PTY_ID`)는 못 줘서**, same-ws pane-level A2A(런치 데모의 핵심)가 fail-closed 된다."*

## 2. 근본 원인 (코드 그라운딩)

**신원 해석 3경로** (`src/mcp/index.ts`):
1. **검증된 PID-walk** (`lookupPidMapWorkspace` :103-152): `a2a.resolve.identity` RPC로 `{pid→ptyId→live ws}` 맵을 받고(렌더러 `input.findOwnerWorkspace` 경유), `process.ppid`부터 위로 walk. hop마다 `getParentPid()`가 **PowerShell `Get-CimInstance Win32_Process`를 spawn**(:239-245, 5s timeout). HIT 시 `MY_WORKSPACE_ID`+`MY_PTY_ID` 둘 다 채움.
2. **env 힌트 폴백** (`resolveWorkspaceId` :187-189): `ENV_WORKSPACE_HINT = process.env.WMUX_WORKSPACE_ID`. `isLiveWorkspace` 게이트. **ptyId 없음 → `MY_PTY_ID=''`**.
3. 캐시 last-resort (:198-202).

**생산자 측** — pid-map = `{getPidMapDir()}/{shellPID}` = `"{ptyId}"` (bare string):
- 로컬 모드: `PTYManager.create` → `writePidMap(pid, id)` (:192-194). identity env = `{SOCKET_PATH, WORKSPACE_ID?, SURFACE_ID?}` — **`WMUX_PTY_ID` 미설정**.
- daemon 모드(기본): `pty.handler.ts` create(:409) + reconnect(:751)가 `writePidMap`. shell env는 `DaemonSessionManager.createSession`이 `env[WMUX_PTY_ID]=params.id` 설정(:250) → **shell은 ptyId env를 받지만 MCP 서버가 안 읽음**.
- cleanup: `removePidMapByPtyId(id)` on dispose(:642)/died(:823).

**왜 walk가 MISS하는가 (런치 데모 깨짐의 기전):**
- Windows 프로세스 트리: `pwsh.exe(shell, pid in map)` → `claude(node)` → `MCP server(node)`. 실제로는 `.cmd` 셔임/`node` 래퍼가 끼어 hop이 늘고, **각 hop이 PowerShell cold spawn ~300-800ms**.
- `Get-CimInstance`(WMI)는 부하 시 느리거나 실패; 5s timeout × depth로 전체 해석이 무너질 수 있음.
- ConPTY `ptyProcess.pid`가 실제 ancestor 체인과 불일치할 가능성(가설, dogfood로 검증).
- walk MISS → 경로 2 폴백 → `MY_PTY_ID=''` → 렌더러가 same-ws 페이스트를 **fail-closed로 억제**(`mcp/index.ts:48-50, 663-668` 주석) → **런치 데모(같은 머신 2+ 에이전트)가 서로 못 보냄**.

**이미 존재하는 자산:** daemon `bootId`(`src/daemon/index.ts:505`, 재부팅 감지) = 로드맵의 `daemonBootId`. `src/daemon/types.ts:74 bootId?: string` 영속.

## 3. 목표 / 범위

**In:**
- MCP 서버가 **walk 없이** 자기 `ptyId`(불변)를 복구하는 신뢰 경로 = **identity 파일 폴백**.
- 파일 레코드 `{ pid, ptyId, workspaceId, daemonBootId, createdAt }` + ACL(0600) + TTL + cleanup + **fail-closed**.
- **진단 로깅**: 각 해석 분기(walk hit/miss/rpc-down/empty-map, file hit/miss+사유, env-hint)를 MCP stderr로 구조화 출력 → 실패하는 런치 데모를 로그만으로 진단.
- 라이브 dogfood: 격리 패키지 exe에서 실제 MCP 서버가 파일 폴백으로 신원 복구함을 증명.

**Out (PROPER fix = 별도, 로드맵 W3):**
- `mcp.handshake` RPC + `PTYManager.instances` O(1) 매칭 (`a2a.rpc.ts`·`PTYManager.instances`). 구조적 해결은 PROPER가 담당.
- 렌더러-독립 disk-read 폴백(rpc-down 윈도우용) — §9 결정사항, 기본 **defer**.
- company.mcp(`src/company/mcp/index.ts`) 무변경(유료 모듈 펜싱).
- 터미널 라우팅(#163) 보안 경계 무변경.

## 4. 설계 — env-keyed identity 파일 폴백 (PRIMARY)

핵심: **불변 `WMUX_PTY_ID` env를 키로** 자기 사이드카 파일을 직접 읽어, 검증된 walk가 HIT를 못 줄 때 `MY_PTY_ID`(+게이트된 workspaceId 힌트)를 복구한다. walk·렌더러 round-trip 불필요.

### 4.1 데이터 / 경로
- 디렉토리: `getPidIdentityDir()` = `{getWmuxHomeDir()}/pane-identity` (신규 헬퍼, `constants.ts`). pid-map과 분리(역할·정리 수명 다름).
- 파일: `{dir}/{ptyId}.json`, 내용:
  ```json
  { "pid": 12345, "ptyId": "daemon-ab12cd34", "workspaceId": "ws-...", "daemonBootId": "…|null", "createdAt": "2026-06-26T…Z" }
  ```
- 권한: 0600 (`fs.writeFileSync(..., { mode: 0o600 })`); 디렉토리 0700. Windows는 `~/.wmux`가 이미 user-scoped(USERPROFILE) → ACL은 defense-in-depth(POSIX 모드 best-effort).
- `daemonBootId`: daemon 모드는 daemon의 `bootId`(가용 시; §9 plumbing 결정). 로컬 모드는 per-app-run id 또는 `null`. **워크스페이스 staleness의 authoritative 게이트는 `isLiveWorkspace`** — `daemonBootId`는 belt-and-suspenders.

### 4.2 Write (3 사이트, 신규 `paneIdentity.ts` 모듈)
- `writePaneIdentity({ pid, ptyId, workspaceId, daemonBootId })` — atomic write(tmp+rename), 0600, `createdAt=now`.
- 로컬: `PTYManager.create`(pid-map write 옆, :192). **+ `WMUX_PTY_ID`를 identity env에 추가**(현재 미설정).
- daemon: `pty.handler.ts` create(:409 옆) + reconnect(:751 옆). (shell env의 `WMUX_PTY_ID`는 daemon이 이미 설정.)
- TTL sweep: write 시 opportunistic — `createdAt`이 TTL(예: 36h) 초과한 파일 제거(write-boundary 정리, pid-map과 동일 패턴, read hot-path엔 probe 없음).

### 4.3 Cleanup (2 사이트)
- `removePaneIdentity(ptyId)` — `removePidMapByPtyId` 호출 옆(dispose :642, died :823). 로컬 `PTYManager.dispose`(:230)도.

### 4.4 MCP read (`src/mcp/index.ts`)
신규 `resolveIdentityFromFile()`:
- `const ptyId = process.env.WMUX_PTY_ID; if (!ptyId) return null;`
- `{dir}/{ptyId}.json` 읽기 → JSON parse → shape 검증(`pid:number, ptyId===env, workspaceId:string, createdAt 파싱가능`).
- TTL 검사(createdAt within window) — 만료 시 무시(fail-closed).
- 성공: `{ ptyId: rec.ptyId, workspaceId: rec.workspaceId, daemonBootId: rec.daemonBootId }`.

`resolveWorkspaceId` 폴백 순서 (검증 walk는 **PRIMARY 유지** — #163 불변):
1. `workspaceResolved && MY_WORKSPACE_ID` 캐시.
2. `lookupPidMapWorkspace()` HIT → wsId+ptyId(현행).
3. **NEW** `resolveIdentityFromFile()` → `MY_PTY_ID = rec.ptyId`(불변, 안전); `rec.workspaceId`를 `isLiveWorkspace !== 'absent'`로 게이트해 반환(미캐시 — 다음 호출 재해석).
4. bare `ENV_WORKSPACE_HINT`(현행, ptyId 없음).
5. 캐시 last-resort(현행).

`MY_PTY_ID` 채움 분리: walk가 transient(rpc-down/empty-map)로 wsId를 못 줘도, file 폴백이 `MY_PTY_ID`만 단독으로 채울 수 있게 한다(senderPtyId 단독 복구 → 런치 데모 unblock의 핵심).

### 4.5 진단 로깅
- `logIdentity(stage, detail)` → `console.error('[wmux-mcp] identity: …')`(MCP는 stdout=프로토콜이므로 **stderr 전용**).
- 분기별 1줄: walk `hit ws=… pty=…` / `miss` / `rpc-down` / `empty-map`; file `hit pty=… ws=…` / `miss(no-env|no-file|malformed|expired)`; `env-hint ws=…`; 최종 resolved.
- 과다 방지: 해석당 1회(캐시 fast-path는 무로그).

## 5. 보안 분석 (eng-review 잠금 대상)

- **신뢰 천장:** same-OS-user(issue #113 / trust-root 에픽). 파일 폴백은 env 힌트와 **동일 채널의 신뢰 모델** — 새 경계 약화 없음. 악의적 동일-유저 프로세스는 이미 `WMUX_WORKSPACE_ID`를 위조 가능; `WMUX_PTY_ID` 추가는 같은 spoofable env에 ptyId를 더할 뿐.
- **#163 불변:** 터미널 라우팅(`resolveTerminalRoute`)은 **검증된 walk HIT만** 신뢰; 파일 폴백 wsId는 절대 터미널 라우팅에 안 들어감(write tool 무영향). 파일은 WEAK A2A 해석자 + `MY_PTY_ID`에만 기여.
- **senderPtyId 위조 영향:** 렌더러에서 (a) true self-send 가드, (b) pane-level whoami, (c) task.update per-pane role/authz에 쓰임. (c)가 **인가 경계인지** 구현 중 렌더러 코드로 검증 필요 — same-user 천장 내라도, 위조 senderPtyId가 *다른* pane의 task 권한을 탈취하면 안 됨. 현재 분석: cross-ws 전송은 `resolvePaneAddress`가 pane∈`to` 검증(senderPtyId 무관) → 위조는 자기 pane 라벨 오기 수준. **eng-review 확인 항목.**
- **cross-user:** 0600 ACL + user-scoped 디렉토리로 타 유저의 읽기/위조 차단(defense-in-depth).
- **fail-closed:** malformed/expired/ACL-fail/ptyId 불일치 → workspaceId 무시(ghost 누출 금지). 파일의 ptyId는 self-send 가드/라벨에만 소비.

## 6. 엣지 케이스
- **legacy bare pid-map**: pid-map은 그대로(이 작업은 pane-identity 사이드카만 추가). `a2a.resolve.identity`의 legacy `ws-` purge 무변경.
- **env 미전파**: `WMUX_PTY_ID` 안 오면 file 폴백도 무력(no-env 로그) → 경로 4(현행)로. **회귀 없음**(현재와 동일). PROPER fix가 구조적 해결.
- **stale 파일**(이전 daemon boot): `daemonBootId` 불일치 OR `isLiveWorkspace('absent')` → wsId 게이트 드롭, ptyId는 불변이므로 유효.
- **ptyId 재사용**: ptyId는 `daemon-{uuid8}`/`pty-{n}` — daemon은 uuid라 충돌 무시 가능; 로컬 `pty-{n}`은 인스턴스 수명 내 단조. cleanup이 dispose/died에 제거.
- **동시 write/read 레이스**: atomic write(tmp+rename) → 부분 파일 안 읽힘. read는 parse 실패 시 fail-closed.
- **TTL sweep 비용**: write 시에만, dir 스캔 1회. pid-map 정리와 동급.

## 7. 테스트 (unit, electron-free)
- `paneIdentity.test.ts`(신규): write→read round-trip, 0600 mode, atomic, TTL 만료 제거, malformed/누락 fail-closed, cleanup by ptyId.
- `mcp/index` 해석 경로: `resolveIdentityFromFile` 단위(env 없음/파일 없음/malformed/expired/정상). 기존 `lookupPidMapWorkspace`/`resolveWorkspaceId` 테스트 회귀 0.
- `a2a.rpc.resolveIdentity.test.ts` 회귀 0(이 작업은 그 핸들러 무변경).
- `resolveSpawnEnv` 회귀: 로컬 모드 `WMUX_PTY_ID` 추가가 identity-forced-last 불변 유지.
- tsc 0 + eslint 0 신규 + `gen-api-reference` drift 0(MCP 툴 스키마 무변경) + 전체 유닛 green.

## 8. DOGFOOD (라이브)
`scripts/wi-002-mcp-identity-dogfood.mjs`(신규, `multiagent-identity-hardening-dogfood.mjs` + `a2a-pane-identity-dogfood.mjs` 패턴):
- 격리 패키지 exe(`out/wmux-win32-x64/wmux.exe` + 고유 `WMUX_DATA_SUFFIX` + temp USERPROFILE).
- **실제 MCP 서버 spawn**(`resources/mcp-bundle/index.js`)을 controlled env로:
  1. `WMUX_PTY_ID` 설정 + identity 파일 존재 → `a2a_whoami`가 **ptyId 포함**(MY_PTY_ID 복구) 증명.
  2. `WMUX_WORKSPACE_ID` stale + 파일 fresh → 파일 wsId 우선 + ptyId 복구.
  3. 파일 없음/만료 → fail-closed(env-hint로 degrade, ptyId 없음 = 현행).
  4. (가능 시) same-ws 2-agent: 둘 다 MY_PTY_ID 복구 → pane addressing/self-send 가드 정상.
- before/after: 파일 폴백 비활성(env만) vs 활성 대비로 **MY_PTY_ID 복구 차이** 증명.
- **사용자 라이브 dogfood**(GUI, Claude×2 same-ws 인사) = 최종 게이트([[no_ship_without_user_verification]]).

## 9. eng-review 결정 항목 (OPEN)
1. **`daemonBootId` plumbing**: daemon `bootId`를 create 시 main으로 전달(신규 필드) vs main이 daemon state에서 읽기 vs **로컬/`null` 허용 + `isLiveWorkspace`에 의존**(최소). → 권장: 최소(파일에 best-effort, 미가용 시 null).
2. **렌더러-독립 disk-read 폴백**(rpc-down 윈도우): 이번 포함 vs PROPER로 defer. → 권장: **defer**(런치 데모는 렌더러 UP·walk-miss가 주범 → env-keyed 파일이 우선순위; rpc-down은 드물고 PROPER가 구조 해결).
3. **TTL 값**(36h?) + sweep 위치(write-only).
4. **pid-map 통합 vs 분리 파일**: pid-map 레코드를 JSON으로 enrich(키=PID, walk로 발견) vs **별도 ptyId-keyed 사이드카**(키=env). → 권장: 별도(키잉이 walk 독립 = 런치 데모 unblock의 본질). 단, eng-review가 "enrich가 더 단순"이라 판단하면 재고.
5. **senderPtyId 인가 영향**(§5 (c)) 렌더러 코드 확정.

## 10. 파일 영향 요약 (§4 PRIMARY 기준 — §11에 의해 SUPERSEDED)
- 신규: `src/main/pty/paneIdentity.ts`(+test), `scripts/wi-002-mcp-identity-dogfood.mjs`.
- 수정: `src/shared/constants.ts`(`getPidIdentityDir`, `ENV_KEYS` 무변경), `src/main/pty/PTYManager.ts`(WMUX_PTY_ID env + write/cleanup), `src/main/ipc/handlers/pty.handler.ts`(write×2 + cleanup×2), `src/mcp/index.ts`(read 폴백 + 로깅).
- 무변경: `a2a.rpc.ts`, `terminalRouting.ts`(보안), company.*, MCP 툴 스키마.

---

## 11. ✅ LOCKED DESIGN (eng-review + codex, 2026-06-26) — §4 사이드카 SUPERSEDE

**결정(사용자):** Lean·증거우선. codex 아웃사이드 보이스가 §4 사이드카 파일을 **과잉**으로 판정 → 파일은 dogfood가 env 미전파를 증명할 때만. **provenance 분리는 필수**(채널 보안 다운그레이드 방지).

### 11.1 codex가 잡은 핵심 (코드 검증 완료)
1. **사이드카 = tier-S 과잉.** 파일도 `WMUX_PTY_ID`로 키잉 → env 전파가 불안정 변수면 파일이 해결 못 함, stale 표면만 추가. pid-map enrich는 `a2a.resolve.identity`/`removePidMapByPtyId` bare-ptyId 가정을 깨는 blast radius. workspaceId를 파일에 저장 = "ws-id는 stale, live 해석" 불변과 충돌.
2. **★보안(플랜이 놓침, 코드 확인):** `a2a.channel.rpc.ts:53-111` mutating 채널(create/archive/join/leave/post)은 `senderPtyId`→`input.findOwnerWorkspace`로 게이트, **헤더(:30-32)가 "verified-senderPtyId가 spoofable env 힌트를 안 타는 게 핵심"이라 명시**. `MY_PTY_ID`를 weak 소스로 채우면 채널 mutation authz가 unforgeable PID-tree → spoofable env로 다운그레이드. → **provenance 분리.**
3. **렌더러-독립 disk-read 무용.** A2A send/whoami/update는 어차피 하류에서 렌더러 RPC 필요 → 신원 시점 렌더러-down 생존이 op을 살리지 못함. → defer 확정.

### 11.2 구현 (최소·되돌리기 쉬움)
**핵심 통찰:** 워크스페이스 해석은 이미 `WMUX_WORKSPACE_ID` env 힌트로 작동 → **빠진 건 ptyId 하나**. env `WMUX_PTY_ID`가 그 갭만 메움.

1. **진단 로깅 (먼저, stderr 전용):** `[wmux-mcp] identity:` 분기별 1줄 — `WMUX_WORKSPACE_ID`/`WMUX_PTY_ID` present?, `a2a.resolve.identity` rpc-down/empty/map-size, walk hit/miss/depth/failing-pid, 최종 분기(verified-walk|env-pty|env-ws|cache). 해석당 1회.
2. **로컬 모드 `WMUX_PTY_ID` set:** `PTYManager.create` identity에 `[ENV_KEYS.PTY_ID]: id` 추가(daemon은 `DaemonSessionManager:250` 이미 set). `resolveSpawnEnv` forced-last 불변 유지.
3. **MCP weak ptyId 폴백 + provenance 분리:**
   - `MY_PTY_ID` = **verified walk 결과만**(현행 유지, 불변).
   - 신규 `getTaskSenderPtyId()` = `MY_PTY_ID || process.env.WMUX_PTY_ID || ''` (verified 우선, 없으면 weak env).
   - **소비처 분리:**
     - A2A task + terminal 도구(`send_message`/`a2a_task_send`/`a2a_whoami`/`a2a_task_update`/`terminal_send`/`terminal_send_key`) → `getTaskSenderPtyId()`(weak 허용). 위조 영향: 자기-pane 라벨 오기 + self-loop 가드 활성(가드는 reject만 = 안전), same-user residual 내.
     - **채널(`getSenderPtyId`) → `MY_PTY_ID`(verified-only) 유지 = 무변경.** 채널 mutation은 walk-miss 시 현행대로 fail-closed(안전), PROPER fix의 mcp.handshake가 verified ptyId로 채널까지 복구.
4. **dogfood = 실제 Claude/Codex 에이전트**(controlled MCP spawn은 코드패스만 증명; env 전파는 실제 런처로). GUI same-ws 2-agent 인사.
5. **defer:** 사이드카 파일/TTL/ACL/daemonBootId/disk-read — dogfood가 env 미전파 증명 시에만 복귀(§4 설계 보존).

### 11.3 테스트 커버리지

```text
[+] src/main/pty/PTYManager.ts (create)
    └── identity에 WMUX_PTY_ID 포함 + forced-last 불변 ── [GAP→ADD] resolveSpawnEnv.test.ts / PTYManager 구조테스트
[+] src/mcp/index.ts (resolver)
    ├── getTaskSenderPtyId: verified 우선 ── [GAP→ADD] MY_PTY_ID set시 그 값
    ├── getTaskSenderPtyId: walk-miss + env set ── [GAP→ADD] env.WMUX_PTY_ID 반환
    ├── getTaskSenderPtyId: 둘다 없음 ── [GAP→ADD] '' 반환
    ├── 채널 getSenderPtyId = MY_PTY_ID(verified-only) ── [GAP→ADD] walk-miss+env set시 채널엔 '' (provenance 분리 락)
    └── 진단 로깅 stderr-only(stdout 무오염) ── [GAP→ADD] console.error만
[+] 회귀 (무변경 증명)
    ├── lookupPidMapWorkspace / resolveWorkspaceId 기존 ── [★유지]
    ├── terminalRouting (#163 verified-only) ── [★유지]
    └── a2a.channel.rpc / channels getSenderPtyId ── [★유지]
─────────────────────────────────
신규 유닛 ~6, 회귀 0. tsc0+eslint0+api-ref drift0.
```

### 11.4 실패 모드

| 모드 | 테스트 | 에러핸들링 | 사용자 체감 |
|---|---|---|---|
| env 미전파(WMUX_PTY_ID 부재) | weak='' 유닛 | degrade(현행 동일, 회귀0) | 데모 여전히 막힘 → **진단 로그가 노출** → dogfood가 잡음 → 사이드카/PROPER 에스컬레이트 |
| 위조 WMUX_PTY_ID | provenance 분리 유닛 | 채널 verified-only(불변) | 자기-pane 라벨 오기(same-user residual) |
| walk 정상 동작 | 회귀 | weak 미사용 | 무변화 |
| 채널 walk-miss | 회귀(fail-closed) | NOT_AUTHORIZED(현행) | 채널 mutation 막힘(안전, PROPER가 해결) |

### 11.5 NOT in scope (확정)
- 사이드카 파일/TTL/ACL/daemonBootId(§4) — defer(dogfood 게이트).
- 렌더러-독립 disk-read — 무용(§11.1-3).
- `mcp.handshake` PROPER fix — 로드맵 W3.
- company.mcp / 터미널 #163 / MCP 툴 스키마 — 무변경.

### 11.6 What already exists (재사용)
- `ENV_KEYS.PTY_ID`(constants.ts:251), daemon `WMUX_PTY_ID` set(DaemonSessionManager:250), `ENV_WORKSPACE_HINT` 폴백 패턴(mcp/index.ts:43,187), `MY_PTY_ID` verified 캐시(mcp/index.ts:50,144), 채널 verified-senderPtyId 게이트(a2a.channel.rpc.ts) — 전부 재사용, 신규 파일 0(dogfood 스크립트 제외).

### 11.7 파일 영향 (LOCKED)
- 수정: `src/main/pty/PTYManager.ts`(create identity에 WMUX_PTY_ID 1줄), `src/mcp/index.ts`(getTaskSenderPtyId + 6 소비처 교체 + 진단 로깅).
- 신규: `scripts/wi-002-mcp-identity-dogfood.mjs`, 유닛 테스트(resolveSpawnEnv 또는 신규 mcp resolver test).
- **무변경: `channels.ts`/`a2a.channel.rpc.ts`(보안 — provenance 분리의 핵심), `a2a.rpc.ts`, `terminalRouting.ts`, `paneIdentity.ts`(미생성), company.*.**

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 3 (사이드카 과잉, diagnostic-first, ★채널 보안 다운그레이드) — 전부 반영 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 핵심 1결정 사용자 락(Lean·증거우선) + provenance 분리 필수화 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — (UI 없음) | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** 사이드카 → env-ptyId 최소 fix로 축소, diagnostic-first, ★채널 mutation authz 다운그레이드(provenance 분리로 차단).
- **CROSS-MODEL:** codex vs 로드맵(파일 명시) 텐션 → 사용자가 Lean·증거우선 선택(codex 측).
- **VERDICT:** ENG CLEARED — 구현 진행 가능. 핵심 게이트 = dogfood가 env 전파 증명.

---

## 12. 🔬 LIVE INVESTIGATION (2026-06-26, 사용자 GUI dogfood + 적대 규명)

전 파이프라인 후 라이브 GUI dogfood에서 사용자의 프로덕션 wmux에 **실제 Codex 에이전트들의 채널 작업이 "Workspace identity unknown"으로 간헐 실패** 중인 것을 목격 → "증거우선"으로 끝까지 규명.

### 12.1 실측 결과 (env 전파 split — [[reference_mcp_env_propagation_split]])
마커 env + env-dump 스텁 MCP 서버로 직접 측정:
- **Claude Code = 부모 env를 MCP 자식에 FULL 전파** (`WMUX_PTY_ID`/`WMUX_WORKSPACE_ID`/마커 전부 수신). → `pidMap.ts`의 "Claude는 env 전파 안 함" 주석은 **구식/오류**.
- **Codex = MCP 자식에 env 완전 스트립** (마커조차 0). → Codex MCP 서버는 신원 env가 0이라 **검증 PID-walk 전용**.
- (검증: 이 세션 자체는 wmux pane이 아니라[WindowsTerminal 조상] whoami 실패는 교란변수였음.)

### 12.2 근본 원인 (확정)
**화면의 Codex 채널 실패 = Codex env 스트립 → walk 전용 → walk miss → "identity unknown".** env 기반 신원 fix(WI-002 `WMUX_PTY_ID` 폴백, 기존 `WMUX_WORKSPACE_ID` 힌트)는 **Codex에 구조적 무력.** Claude는 env 전파되어 힌트로 해석 가능, 남는 실패는 ghost workspace(respawn 재발급).

### 12.3 WI-002의 정직한 범위 (재명시)
- ✅ **Claude same-ws A2A senderPtyId 하드닝** + **진단 로깅**(이 규명을 가능케 함).
- ❌ Codex 채널 실패 **안 고침**(env 스트립). ❌ 워크스페이스 "identity unknown" **안 고침**(senderPtyId만). ❌ 채널 mutation은 verified walk 필요.
- → 멀티에이전트(Codex 포함) 신원의 **robust fix = PROPER**: 서버측 상관(main이 파이프 연결 PID `GetNamedPipeClientProcessId`로 pane 해석 = **env·child-walk 독립**), 로드맵 W3.

### 12.4 SHIP 근거 (사용자 결정: WI-002 ship → PROPER)
WI-002를 ship하는 이유는 Codex fix가 아니라 **(a) Claude senderPtyId 하드닝(정확·검증) + (b) 진단 로깅을 프로덕션에 투입**해 다음 실패 시 walk hit/miss/depth·env 유무를 로그로 확보 → 그 데이터로 PROPER fix를 정확히 설계. **주의: 진단이 프로덕션에 보이려면 릴리스+사용자 업데이트 필요**(PR 머지만으론 설치본 미반영).
