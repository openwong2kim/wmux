# Multi-Agent Identity & Addressing Hardening — Implementation Plan

> Phase 1 (UNDERSTAND+PLAN) output. Base: `main` after PR #239 merge. Model policy: Opus 4.8 단독.
> Source task: `plans/next-session-multiagent-identity-hardening.md`.
> Status: **Revision 2 — eng-review 게이트 통과 (적대 Opus 패널 4명 검증 반영). 구현 결정 LOCK.**

---

## Revision 2 — 적대 검증 결정 (이 섹션이 구현의 source of truth)

4명 적대 패널이 각 가드를 REFUTE 시도. 확정 결정:

### D1 (P0, CRITICAL) — ws-scoping을 P0에 **포함** (defer 불가)
적대 발견: ptyId 생략 시 `resolveActivePtyId`가 `input.readScreen`를 **params 없이** 호출(`input.rpc.ts:32`) → 렌더러가 `store.activeWorkspaceId`의 UI-focused pane으로 fallback. caller가 **같은 ws의 다른 pane**이면(멀티팬 1 ws = dogfood 토폴로지) resolved pty가 focused sibling → `decideTerminalSelfSend`는 sibling으로 보여 ALLOW → `assertWorkspaceOwnsPty`는 cross-ws 전용이라 PASS → **엉뚱한 sibling에 silent write**(submit:true 강제 Enter / ctrl+c가 다른 agent 명령 kill). self-loop보다 나쁜 silent corruption.
**결정:** `resolveActivePtyId(getWindow, callerWs)`로 caller `workspaceId`를 렌더러에 forward(렌더러는 이미 `callerWsId` 스코핑 지원, `useRpcBridge.ts:937`). **추가**: ws-scoping만으론 "caller's ws의 active pane ≠ caller 자기 pane"(caller가 focused 아닐 때)을 못 고침 → first-party가 ptyId 생략 + 멀티팬 ws면 **ambiguous로 취급해 명시 ptyId 요구**(`decideSameWsSend`의 "no address→reject" 미러, `a2aAddressing.ts:110-116`). `terminal_send_key` 동일 적용. → P0 가드는 (a)self-loop + (b)sibling-misroute 둘 다 닫는다.

### D2 (P0) — senderPtyId provenance: terminal guard도 검증
적대 발견(HOLE 6): 비-MCP pipe client가 `params.senderPtyId`를 raw로 설정 가능(A2A는 렌더러서 `isTerminalPtyInLeaves` validate, terminal 경로는 안 함) → self-reject DoS(misroute는 아님, P2). **결정:** terminal self-guard도 senderPtyId를 신뢰 전 provenance 확인 — main에서 `input.findOwnerWorkspace`(`useRpcBridge.ts:912`)로 senderPtyId가 callerWs 소속인지 확인하거나, A2A와 동일하게 렌더러 validate. overclaim 금지: `MY_PTY_ID`는 cache fast-path(`terminalRouting.ts:106`)서 PID re-walk 스킵 → "last-walk" provenance(HOLE 4).

### D3 (P1a) — exact-name tier만 STRICT, number/substring은 first-match 유지
적대 발견(HIGH): number-tier를 strict화하면 문서화된 "N번"/number addressing(`index.ts:635` tool schema + `ARCHITECTURE.md:102`)이 깨짐. `to:"3"` vs `["Workspace 3","v3-app"]` → 오늘 resolve, strict면 error. 스크립트는 8/8 전부 UUID(tier-1 short-circuit)라 안전. dogfood 충돌은 **exact-name 중복**(`cross-ws-probe`×2)이라 exact tier가 잡음.
**결정 (Q-P1a-1/2 resolved):** exact ID(short-circuit) → **exact name(ci) ≥2면 error** → number/substring은 **기존 first-match 유지**. 추출 helper `resolveWorkspaceTarget`는 `{error}` envelope 보존, error path서 `toWorkspaceId`(`useRpcBridge.ts:1528`) emit 안 함(main execute router가 undefined 라우팅 방지).

### D4 (P1b) — 근거 교정, 불변식 명시
적대 발견: "senderPtyId는 server-derived/외부 caller는 ''라 아무것도 못 얻음"은 **MCP tool path만 참** — direct pipe client(토큰 보유)는 `{workspaceId, senderPtyId}` 임의 설정 가능. A1 disclosure(victim pane agentName)는 **`a2a.discover`가 이미 동일 노출** → 한계 노출 ~0.
**결정:** #163 미약화 결론은 유지하되 **근거를 교정** — 안전 이유는 "whoami가 capability-free + #163 router와 코드/상태 공유 0(구조적 분리)"이지 "senderPtyId unspoofable"이 아님. 불변식 LOCK: (1) whoami read-only/capability 0, (2) client-supplied pane selector를 trusted로 echo 금지, (3) forged/foreign senderPtyId → ws-level degrade(error 금지), (4) 미래에 whoami 출력으로 capability gate 금지. discover 이미 노출하는 pane agentName은 ratify(별도 ownership 스코핑은 P1b 스코프 밖).

### D5 (P2a) — CLI 경로 + throw 행동변화 명시
적대 발견: CLI `list-surfaces`(`src/cli/commands/surface.ts:44`)는 MCP 우회 → 렌더러 fallback 유지(convergence 부분적). 또 `requireWorkspaceId()`는 miss 시 **throw** — 오늘 `surface_list`는 miss면 `[]` 반환(`useRpcBridge.ts:439`). read tool이 fail-soft→fail-loud로 바뀜.
**결정:** `surface_list`(omitted)를 caller-scoped로 하되, **fail-soft 보존** — miss 시 throw 대신 `input.readScreen` 스타일 caller-ws fallback 또는 `[]` 유지(write tool `browser_open`과 read tool은 다름). "convergence 부분적"(CLI는 별도) 명시. boot reconcile window(paneGate!=='ready')서 throw 회귀 방지.

### D6 (P2b) — diagnostics + 정확조건 fail-loud로 **downgrade**, live-dogfood 불가 인정
적대 발견: (Issue 2,HIGH) ENV축이면 empty suffix=prod 구분 불가 → "userData===prod default면 fail"로 구현하면 **모든 정상 prod boot crash**. (Issue 3,HIGH) helper-rewrite 옵션은 suffix double-apply(`wmux-dev-dev/`). (Issue 4,MED) `constants.test.ts`가 userData/session.json 축 커버 0. (Issue 5,HIGH) **dogfood가 P2b 재현 불가** — harness가 suffix 올바로 전파 = 버그 안 남.
**결정 (Q-P2b resolved):** P2b는 **① 진단 로깅 + ② 정확조건 fail-loud만** — fail-loud 조건은 `WMUX_DATA_SUFFIX` 非空 **AND** `getPath('userData')`가 suffix로 안 끝남(setPath threw)일 때만. "userData===prod" 조건 **금지**. helper-rewrite 옵션 **폐기**(double-apply 위험), `SessionManager`는 `getPath('userData')` verbatim 유지. `main/index.ts` regression 테스트 추가(empty suffix→setPath 미호출/userData 불변, fail-loud predicate가 empty서 안 트립). ENV축은 launch 문서화로 분리(코드 강제 불가). **live dogfood 대신 unit + negative-launch 진단**으로 검증.

### 변경 없음 (적대 검증 통과)
- **P3** — ship-safe. `"Invalid transition"` string consumer 0(grep 확인), single funnel(`a2aSlice.ts:108`), message-only. 단 메시지는 `VALID_TRANSITIONS[from]`만 interpolate(task payload 금지).
- **구현 순서** — P0/P1b senderPtyId forward는 다른 tool/line이라 충돌 0. 순서 유지.
- **explicit ptyId 안전** — 구조적으로 guard 도달 불가(HOLE 5, 깨지 못함).

---

> 이하 원본 분석(Revision 1). 위 Revision 2 결정이 충돌 시 우선.

## 배경 (self-contained)

PR #239가 same-workspace pane-to-pane A2A 메시징을 ship했고, 그 라이브 GUI dogfood(한 워크스페이스 내 Claude×2 + Codex×2)가 **인접 버그군**을 들췄다. #239는 A2A 경로에 true-self 가드(`senderPtyId` + `decideSameWsSend`)를 넣었지만, 같은 클래스의 결함이 terminal/identity 경로 곳곳에 남아 있다. 이 플랜은 그 잔여를 프로덕션 기준으로 하드닝한다.

**#239가 확립한 재사용 패턴 (검증 완료):**
- `MY_PTY_ID` — MCP 서버 모듈 글로벌, verified PID-map hit마다 채워짐 (`src/mcp/index.ts:142`). PID-map miss(외부 caller)면 `''`.
- senderPtyId forward — `send_message`가 `if (MY_PTY_ID) params.senderPtyId = MY_PTY_ID;` (`src/mcp/index.ts:610`).
- `decideSameWsSend` / `isTerminalPtyInLeaves` — 순수 헬퍼 `src/renderer/hooks/a2aAddressing.ts:71,104`. 렌더러가 `senderPtyId`를 **자기 트리에 대해 validate**한 뒤에만 신뢰(`useRpcBridge.ts:1477-1478`).

## 우선순위 요약

| 우선 | 항목 | 근본 결함 (검증된 위치) | 수정 축 |
|------|------|------------------------|---------|
| **P0** | terminal_send self-loop 가드 | `input.rpc.ts:32` active-pty 해석이 caller 자기 pane으로 귀결 | code (MCP forward + main guard + 순수 helper) |
| **P1a** | 동명 워크스페이스 모호성 거부 | `useRpcBridge.ts:1427` `.find` silent first-wins | code (순수 helper 추출 + tier 매칭) |
| **P1b** | a2a_whoami pane-레벨 identity | `useRpcBridge.ts:1216-1228` ws-레벨만 반환 | code (MCP forward + 렌더러 enrich) |
| **P2a** | identity 발산 정합 | `surface_list`가 `requireWorkspaceId()` 미호출 → UI-active ws | code (surface_list 스코핑) |
| **P2b** | 세션복원 suffix 격리 | `main/index.ts:203-209` userData suffixing이 ENV-gated + fail-soft | env+code (진단 우선 → fail-loud) |
| **P3** | a2a.task.update 전이 메시지 | `a2aSlice.ts:108` 불명확한 `Invalid transition` | code (message-only) |

---

## P0 — terminal_send self-loop 가드

### 근본 원인 (검증됨)
`terminal_send`/`terminal_send_key`에서 **ptyId를 생략**하면:
1. MCP: `resolveTerminalRouteBound(ptyId)` → route `{ workspaceId: <caller ws>, ptyId: undefined }`. `base.ptyId`는 explicit일 때만 세팅(`index.ts:435`). **`senderPtyId`는 전혀 안 넘어감.**
2. Main `input.send`: ptyId 없음 → else 분기 `resolveActivePtyId(getWindow)` (`input.rpc.ts:103`).
3. `resolveActivePtyId`(`input.rpc.ts:31-43`)는 `sendToRenderer(getWindow, 'input.readScreen')`를 **params 없이** 호출 → 렌더러(`useRpcBridge.ts:930-944`)가 `store.activeWorkspaceId`의 active pane으로 fallback.

→ **두 self-loop 모드:**
- **(a) 진짜 self-loop**: caller가 UI-focused active pane이면 resolved pty == caller 자기 pty → bracket-paste가 자기 프롬프트로 주입돼 루프.
- **(b) 오라우팅-후-실패**: caller가 focused가 아니면 다른 ws의 pane을 가리켜 `assertWorkspaceOwnsPty`가 reject(에러).

`assertWorkspaceOwnsPty`(`input.rpc.ts:56-74`, #163)는 **cross-ws**만 막는다. self-send는 intra-ws라 통과 → #163과 **orthogonal**.

### 수정 설계 (프로덕션 판단: main-process guard + MCP forward + 순수 helper)
1. **MCP forward** (`index.ts:432-438`, `:450-455`): `terminal_send`/`terminal_send_key`에 `if (MY_PTY_ID) base.senderPtyId = MY_PTY_ID;` 추가 — `send_message`(`:610`)와 동일.
2. **순수 helper** — `a2aAddressing.ts`에 신규 `decideTerminalSelfSend(resolvedPtyId, senderPtyId)`:
   - `senderPtyId && resolvedPtyId === senderPtyId` → **reject**(명시 ptyId 안내 메시지).
   - senderPtyId 부재(`''`) → **allow** (no-op, 외부 caller 무영향).
   - resolvedPtyId 부재 → allow (기존 "PTY not found" 에러가 처리).
   - `decideSameWsSend`를 오버로드하지 않고 sibling helper로 분리(A2A의 "deliver silently/EventBus" fallback이 terminal엔 없음).
3. **Main guard** (`input.rpc.ts` else 분기, `:102-104` 직후): `senderPtyId`를 params에서 받아, `decideTerminalSelfSend(ptyId, senderPtyId)`가 reject면 throw. `input.sendKey`(`:142-`)에도 **동일 적용**(enter/ctrl+c 자기주입도 동등하게 유해).

**경계 보장 (CRITICAL):** explicit ptyId는 early 분기(`input.rpc.ts:100-101`)로 빠져 guard 코드에 **절대 도달하지 않음** → 정상 cross-pane explicit send는 구조적으로 안전. guard는 else 분기에만.

### 엣지/회귀 가드
- **explicit cross-pane ptyId**: 구조적 안전(early branch). guard를 explicit 분기에 넣지 말 것.
- **single-pane ws 자기-타깃**: ptyId 생략 + resolved==self → reject. 올바른 동작이나 변화 → 메시지로 "명시 ptyId 전달" 안내.
- **외부(non-agent) caller**: `MY_PTY_ID=''` → guard no-op(fail-open). 외부 caller의 resolved 타깃은 자기 pinned terminal(정당) → 허용.
- **terminal_send_key 누락 금지**: 같은 resolver(`input.rpc.ts:160`) → 동일 수정.
- **spoofed senderPtyId**: main-process guard는 신뢰되는 MCP 글로벌에서 옴(agent param 아님) → 스푸핑 위험 낮음. defense-in-depth: `input.findOwnerWorkspace`(`useRpcBridge.ts:912-924`)로 provenance 확인 가능.

### 테스트
- 순수 `decideTerminalSelfSend`: self→reject / sibling→allow / 빈 senderPtyId→allow / undefined resolved→allow.
- main `input.rpc.test.ts`: **explicit ptyId==senderPtyId는 절대 차단 안 됨**(CRITICAL 회귀 가드, write 발생) / 생략+resolved==sender→reject+**write 미발생** / 생략+sibling→write / 생략+senderPtyId 부재→write / `input.sendKey` parity.

### 열린 질문 → eng-review
- **Q-P0**: `resolveActivePtyId`가 caller `workspaceId`를 렌더러로 forward하도록 ws-scoping까지 P0에 포함할지? (모드 (b) 오라우팅을 정확히 교정하지만 스코프 확대, P2a와 같은 클래스.) → **권장: 별도 P2a로 묶고 P0는 self-guard에 집중.**

---

## P1a — 동명 워크스페이스 모호성 거부

### 근본 원인 (검증됨)
A2A target 매칭 `useRpcBridge.ts:1422-1442`: `store.workspaces.find(w => ...)` — 단일 `.find` 술어가 4 규칙(exact ID → exact name ci → embedded number → substring)을 OR로 평가, **첫 매칭 workspace가 array 순서로 승리**. 동명 2개면 둘 다 rule(2) 만족 → silent first-wins, **에러 없음**. (dogfood의 `cross-ws-probe` 충돌.)

**Drift**: 같은 "name→entity" 연산이 두 곳에 반대 안전성으로 존재:
- Path A(`useRpcBridge.ts:1427`, workspace A2A) — **가드 없음** (버그).
- Path B(`src/company/renderer/rpcHandlers.ts:48-49`, company A2A) — partial은 `length === 1`일 때만 resolve, 아니면 `[]` (**모호성 안전**). + dead duplicate `companyRpcHandlers.ts:18-50`(미import).

**생성/유일성**: explicit name uniqueness 체크 0(`workspaceSlice.ts:89-107`). `duplicateWorkspace`만 dedupe(`nextCopyName:25-33`). ID는 랜덤 UUID(`types.ts:612-614`) — name-derived 아님 → 동명도 **ID로는 이미 구분 가능**(단지 caller에게 안 보임).

### 수정 설계 (프로덕션 판단: 순수 helper 추출 + tier 매칭)
1. **순수 helper 추출** — `resolveWorkspaceTarget(workspaces, to)` (sibling to a2aAddressing.ts, 테스트 가능). Path A의 인라인 로직을 옮김.
2. **Tier 매칭**: exact ID(UUID, 절대 모호 안 함) → exact name(ci). 해당 tier에서 매칭 **≥2면 `{ error }`** — 각 후보 `name` + **full id** 나열(disambiguation 계약). unique면 그 tier에서 즉시 반환. 그 다음에야 number/substring tier로.
3. **생성-time ID surface**(낮은 침습): `workspace.new` 응답은 이미 `{id, name}` 반환(`useRpcBridge.ts:330`), CLI는 표시(`cli/commands/workspace.ts:64`). daemon/UI에서 id를 prominent하게 노출. **explicit name 거부는 채택 안 함**(기존 동작 변화 과대) — ID 노출로 충분.
4. dead duplicate `companyRpcHandlers.ts` 삭제(inert지만 향후 divergence 방지).

### 엣지/회귀 가드
- full ID direct(rule 1) — UUID는 모호성 체크 전 short-circuit.
- unique exact name — 무에러 resolve 유지.
- number/index(rule 3, "3번"/"workspace 3") — 이미 모호-by-design. tier화 시 `Workspace 3` vs `Workspace 30` 충돌 처리 결정 필요.
- substring(rule 4) — 매우 loose. **기존 dogfood 스크립트가 first-match partial 의존 가능** → `scripts/_a2a-drive.mjs`, `_a2a-launch-agents.mjs`, `issue-236-*.mjs`의 하드코딩 `to:` 확인 후 변경.
- `a2a.broadcast`은 별도 메서드 → target resolver를 strict하게 만들어도 "send to all" 무영향.
- `workspaceRouting.test.ts`(own-identity)는 안 깨짐.

### 테스트
unique exact resolve / duplicate exact → error w/ both IDs / ID-direct under dup / unique substring resolve / ambiguous substring error / number index(+ `Workspace 3` vs `30` 명시) / creation dedup policy.

### 열린 질문 → eng-review
- **Q-P1a-1**: number/substring tier도 모호성 에러로 묶을지, 아니면 exact tier만 strict하고 number/substring은 기존 first-match 유지? (스크립트 호환 vs 일관성.)
- **Q-P1a-2**: `Workspace 3` vs `Workspace 30` — number 매칭을 더 strict한 패턴으로 anchor할지.

---

## P1b — a2a_whoami pane-레벨 identity

### 근본 원인 (검증됨)
`a2a_whoami`(`index.ts:582`)는 `{ workspaceId }`만 전달. 렌더러 핸들러(`useRpcBridge.ts:1216-1228`)는 `store.workspaces.find(w => w.id === workspaceId)`로 **whole workspace** 반환 → `{ workspaceId, name, metadata }` 전부 ws-레벨. ptyId/surfaceId 0. 4 agent 한 ws면 **동일 응답**. per-pane 진실은 `store.surfaceAgent[ptyId]`(`paneSlice.ts:67`)에 있으나 whoami가 안 봄. (`a2a.discover`는 이미 `panes[]`를 빌드 — whoami만 누락.)

### 수정 설계 (프로덕션 판단: server-derived forward + 렌더러 enrich, #163 불변식 보존)
1. **MCP forward**(`index.ts:582`): `if (MY_PTY_ID) params.senderPtyId = MY_PTY_ID;` — `:610` 미러.
2. **렌더러 enrich**(`useRpcBridge.ts:1216-1228`): `senderPtyId` 받아 `isTerminalPtyInLeaves(findLeafPanes(ws.rootPane), raw)`로 validate(`:1478` 동일) → leaf/surface 해석 → `ptyId`/`surfaceId`/`paneId`/**per-pane** `agentName`(`store.surfaceAgent[ptyId] ?? null`) 추가.
3. **Graceful degrade**: `MY_PTY_ID` 부재(env-hint fallback) → 오늘의 ws-레벨 응답으로 degrade(에러 금지).

**#163 불변식 (보존 필수, 검증된 verdict):** whoami pane-level은 #163을 **약화하지 않음** — (a) `senderPtyId`는 agent-settable param이 아니라 **서버 verified `MY_PTY_ID`**(외부 caller는 `''`라 아무것도 못 얻음), 렌더러가 자기 트리에 validate → forged value는 absent 취급(fail-closed). (b) whoami는 read-only self-id(no capability), terminal IO와 별개 trust boundary. **금지선:** client-supplied `ptyId`/`surface_id` param을 trusted로 echo하지 말 것(그러면 #163이 죽인 spoof 채널 재생성).

### 엣지/회귀 가드
- additive only(신규 optional 키) → 기존 consumer 무영향. (whoami 응답 shape에 의존하는 기존 테스트/2nd consumer 없음 확인됨.)
- senderPtyId 부재→ws-레벨 / foreign→echo 안 함(fail-closed) / ptyId 유효하나 agent 미감지→`agentName: null` / ws re-mint 중→stale ptyId 캐시 안 함.

### 테스트
multi-pane ws서 두 sibling ptyId가 **서로 다른** 응답 / 빈 senderPtyId→legacy shape 유지 / foreign senderPtyId→echo 안 함. 패턴: `useRpcBridge.a2aPaneIdentity.test.ts`(source-text assertion 스타일; 가능하면 behavior 테스트로 강화).

---

## P2a — identity 발산 정합

### 근본 원인 (검증됨)
세 surface가 서로 다른 질문에 답해 발산:
- `a2a_whoami` → caller pane's owning ws (PID-anchored, `requireWorkspaceId`). **가장 정확**.
- `surface_list`(`index.ts:467-474`) → `requireWorkspaceId()` **미호출** → 렌더러(`useRpcBridge.ts:437`)가 `store.activeWorkspaceId`(UI-focused).
- `workspace.list` → 전체 directory(caller identity 없음).

`browser_open`(`index.ts:301-308`)은 주석으로 정확히 이 함정("omit하면 store.activeWorkspaceId로 fall back → wrong workspace")을 경고하며 `requireWorkspaceId()`를 호출 — `surface_list`만 그 가드가 빠짐.

### 수정 설계
`surface_list`(`index.ts:467-474`)를 `requireWorkspaceId()`-스코프로(`browser_open` 패턴). explicit `workspaceId` form은 그대로(omitted 케이스만 caller-scoped로). `workspace.list`는 directory라 그대로(정합은 client가 "self"엔 whoami 호출로).

### 엣지/회귀 가드
- explicit `workspaceId` form 무영향(omitted만 변경).
- 일부 caller가 `surface_list`로 "내가 보고 있는 ws"(UI focus)를 기대할 수 있음 → eng-review 확인.

### 테스트
`store.activeWorkspaceId=A`인데 caller가 B로 resolve → `surface_list`(omitted)가 **B**의 surface 반환. explicit form은 verbatim.

### 열린 질문 → eng-review
- **Q-P2a**: `surface_list`의 default를 caller-scoped로 바꾸면 UI-focus를 의도한 기존 caller가 surprise. Q-P0의 `resolveActivePtyId` ws-scoping과 함께 "active = caller's, not UI focus" 원칙을 일괄 적용할지.

---

## P2b — 세션복원 suffix 격리

### 근본 원인 (검증됨, 두 축 분리)
identity surface가 읽는 workspace는 boot시 `session.json`(under userData)서 hydrate(`AppLayout.tsx:557`→`SessionManager.ts:42`). userData suffixing은 `main/index.ts:203-209` `app.setPath('userData', ... + WMUX_DATA_SUFFIX)` 단 한 곳 — **ENV-gated**(env var가 main process에 이미 present해야). auto `-dev`는 `!app.isPackaged`만(`:200`). **모든 code-axis 경로(pipe/`~/.wmux`/pid-map/daemon sessions.json)는 suffix 존중** — userData만 one-shot setPath.

- **ENV axis (가장 유력)**: packaged exe는 `app.isPackaged===true`라 auto-`-dev` skip → suffix는 launched exe의 process env서 상속해야. fresh-suffix 인스턴스가 main process env에 `WMUX_DATA_SUFFIX` 없이 부팅되면 → setPath 안 됨 → userData=**production default** → `session.json`=공유 prod → old workspace 복원. (경로 *construction*은 옳음, *input 변수*가 그 process에 부재.)
- **CODE axis (secondary)**: setPath가 throw해도 로그만(`:206-207`) → silent prod fallback.

daemon `sessions.json`은 PTY state지 workspace 아님 → P2b의 red herring(이미 suffix-aware).

### 수정 설계 (프로덕션 판단: 진단 우선 → CODE-axis fail-loud)
1. **런타임 진단 먼저**(축 확정): `main/index.ts:203`서 `process.env.WMUX_DATA_SUFFIX` + resolved `app.getPath('userData')` 로깅. 비어있음→ENV축(launch 미전파). 설정됐는데 userData에 suffix 없음→CODE축(setPath threw).
2. **CODE-axis fix (순수, 안전)**: userData suffixing이 silent prod fallback 못 하게 — suffix가 set인데 setPath 실패면 **loud/hard fail**. 선택: `session.json` 경로를 use-time suffix-aware helper로(`getWmuxHomeDir` 미러) 재구성해 setPath 실패에도 격리.
3. **ENV-axis (launch 계약, 코드로 강제 불가)**: 방어적으로 "wmux pane 내부에서 spawn(inherited marker)인데 suffix 불일치면 경고". dogfood harness는 이미 main env로 전파.

### 엣지/회귀 가드
- **no-suffix production은 100% 동일 default**(`constants.ts:177`) — empty-suffix→기존 prod 경로 불변 보장 필수(`constants.test.ts` 커버).
- child-PTY propagation 단방향 안전(`resolveSpawnEnv.test.ts`, `DaemonSessionManager.test.ts`) — main fix가 교란 금지.

### 열린 질문 → eng-review
- **Q-P2b**: P2b는 환경 의존적이고 라이브 repro가 불확실. 이번 스코프에 **CODE-axis fix + 진단만** 넣고 ENV-axis는 분리(별도 추적)할지, 아니면 전체 포함할지. → **권장: 진단 + CODE fail-loud만, ENV는 launch 문서화로 분리.**

---

## P3 — a2a.task.update 전이 메시지

### 근본 원인 (검증됨)
전이 graph `types.ts:524-538` `VALID_TRANSITIONS`: `submitted: ['working','canceled']`. `submitted→completed` reject. 에러는 **2 layer**: `useRpcBridge.ts:1558` `validStatuses`는 enum value만 체크(transition 아님 — 힌트 `~1543-1553` partially stale). 실제 reject는 `a2aSlice.ts:107-109` `validateTransition` → `Invalid transition: submitted -> completed`(왜/무엇을 해야 하는지 불명확).

### 수정 설계 (message-only)
`a2aSlice.ts:108`(single source of truth, 모든 caller funnel)에서 `VALID_TRANSITIONS[from]`을 읽어 allowed next states를 surface, 예: `Invalid transition: submitted -> completed. A task must first move to 'working' (allowed next: [working, canceled]).` **`validateTransition`/`VALID_TRANSITIONS` 로직 불변 — 에러 STRING만.** receiver-permission gate(`a2aSlice.ts:103-105`)와 conflate 금지.

### 테스트
`submitted→completed`→새 메시지(/working|submitted → working/) / `submitted→working` 성공(gate 안 조임) / `working→completed` 성공·`completed→working` 여전 실패 / receiver-permission 에러 불변. (현재 `a2aSlice.test.ts`에 transition-rejection 테스트 부재 — coverage gap.)

---

## 구현 순서 & 의존성

순수 헬퍼 + 단위 테스트 우선, 그 다음 wiring (#239 패턴):
1. **P0** — `decideTerminalSelfSend` 순수 helper + 단위 → MCP forward + main guard + handler 테스트. (가장 작고 확실, dogfood disaster 직접 차단.)
2. **P1b** — whoami forward + enrich (P0와 같은 senderPtyId forward 패턴 재사용).
3. **P1a** — `resolveWorkspaceTarget` 추출 + tier 매칭 + 단위.
4. **P2a** — surface_list 스코핑 (P1b/whoami 정합과 함께).
5. **P3** — message-only (독립, 언제든).
6. **P2b** — 진단 + CODE fail-loud (gate 결정에 따라).

P0/P1b/P2a는 `MY_PTY_ID`/`senderPtyId`/`requireWorkspaceId` 공통 패턴 → 함께 가면 일관. P1a/P3는 독립.

## 검증 계획
- 정적: `tsc` 0 / 유닛(기존 3432+16 위 가산) / drift 0(`gen-api-reference --check`) / lint clean.
- **라이브 dogfood (REAL enforcer)**: 패키지 exe + `WMUX_DATA_SUFFIX` 격리. repro 재현 — 동명 ws 2개 + `terminal_send`(ptyId 생략) self-loop 거부 / `a2a_whoami` pane-레벨(sibling 2개 서로 다른 응답) / 모호 이름 거부(both IDs) / `surface_list` caller-scoped / P3 메시지.

## 스코프 밖
- PR #239 자체.
- full `from.ptyId` 모델(대칭 reply pinning / role-per-pane / pane-granular authz) — 별도 S-C2.
- P1a explicit-name uniqueness **거부**(ID surface로 충분 판단).
- P2b ENV-axis 강제(launch 계약 — 문서화로 분리 권장).

## PR (Phase 5, #239 머지 후)
main 기반. author `wong2kim <open.wong2kim@gmail.com>` + co-author trailer(`openwong2kim <100856670+...>` + `Claude Opus 4.8 (1M context) <noreply@anthropic.com>`). 영어 commit/PR, **마케팅 푸터 금지**. CI green + 사용자 GUI dogfood 후 머지.
