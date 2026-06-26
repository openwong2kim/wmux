# PROPER MCP 신원 fix — 서버측 프로세스-트리 상관 (handshake-PID)

> **레인:** L2 Core / Platform · **로드맵:** W3 "MCP 신원 PROPER fix(mcp.handshake)" 당겨옴
> **선행:** WI-002([[project_wi002_mcp_identity_quickfix]], PR #299) = Claude env 폴백+진단. 본 작업이 **진짜 멀티에이전트(Codex 포함) 해결책.**
> **프로세스:** PLAN → ENGREVIEW(plan-eng-review + codex) → 구현 → REVIEW → DOGFOOD(라이브, Codex+Claude)
> **준수:** [[no_claude_attribution]] · [[git_identity_openwong2kim]] · codex 게이트 · company.* 무변경

---

## 1. 문제 (라이브 규명 확정 — [[reference_mcp_env_propagation_split]])

MCP 서버는 자기 pane/workspace를 (a)검증 PID-walk(`a2a.resolve.identity`→pid-map→**클라이언트측** getParentPid PowerShell 프로세스트리 walk) (b)`WMUX_WORKSPACE_ID` env힌트 로 해석. 라이브 실측:
- **Claude = env FULL 전파** → (b)로 해석 가능(env 폴백=WI-002가 ptyId까지 커버).
- **Codex = env 완전 스트립** → (b) 0. **walk(a) 전용.** + Codex가 MCP 서버를 **샌드박스**하면 클라이언트측 getParentPid의 PowerShell spawn 차단 → walk도 실패 → "Workspace identity unknown"(화면 라이브).

**근본:** 신원 해석이 **클라이언트(MCP 자식) 측**에서 일어나 env(Codex 스트립)·자식 프로세스 권한(Codex 샌드박스)에 종속. **env·walk 양쪽 독립인 서버측 해석이 필요.**

## 2. 설계 — handshake가 caller PID, main이 서버측 walk

**핵심:** MCP 서버가 자기 `process.pid`를 RPC로 보내고, **main이 프로세스 트리를 서버측에서 walk**해 owning pane을 해석. env 불필요(PID=RPC), 샌드박스 무관(walk=main, 비샌드박스).

```
[현행 — 클라이언트측, Codex서 깨짐]
  MCP child: getParentPid(PowerShell)×N hops  ←샌드박스 차단/env 스트립
       └ a2a.resolve.identity → 전체 pid-map 반환 → 클라가 자기 트리 매칭

[PROPER — 서버측]
  MCP child: sendRpc('a2a.resolve.identity', { callerPid: process.pid })
       main: Win32_Process 스냅샷 1회 → callerPid부터 위로 in-memory walk
             → pid-map(PID→ptyId) 조상 매칭 → ptyId→live workspace(렌더러)
             → 반환 { resolved: { workspaceId, ptyId } }
  MCP: resolved 캐시(MY_WORKSPACE_ID/MY_PTY_ID), 이후 현행대로 사용
```

### 2.1 왜 peer-PID(GetNamedPipeClientProcessId) 아닌가 (issue-113 §3 근거)
- Node에 peer-cred API 없음 → **네이티브 애드온**(N-API, platform×arch×abi prebuilt) 필요. 프로젝트 네이티브 애드온 0개 = 빌드/릴리스 카테고리 변경 = 고비용. **issue-113이 이미 defer.**
- Windows TCP 폴백(항상 가동)은 peer-id 아예 없음 → 구조적 미커버.
- → **handshake-PID(MCP가 자기 pid를 RPC로 전송)는 네이티브 애드온 회피** — pid가 기존 RPC 채널로 옴. main의 walk는 PowerShell(main은 비샌드박스, 가능).

### 2.2 RPC: `a2a.resolve.identity` 확장 (신규 메서드 대신 — DRY)
- optional `{ callerPid: number }`. 있으면 main이 서버측 walk 수행 → `resolved: {workspaceId, ptyId} | null` 추가 반환. 기존 `mappings`/`entries`는 verbatim(하위호환). **메서드명 불변 → firstParty 허용목록/methodCapabilityMap 무변경.**
- 서버측 walk: `Win32_Process` 스냅샷 1회(전 프로세스 ParentProcessId) → callerPid부터 in-memory 상향 walk(depth cap) → pid-map 조상 매칭. (현행 클라 per-hop spawn보다 빠름.) 비동기(main UI 블록 금지).
- 매칭 ptyId → 현행 `input.findOwnerWorkspace`(렌더러)로 live workspace 해석(재사용).

### 2.3 MCP 소비 (`src/mcp/index.ts`)
- `lookupPidMapWorkspace`/`resolveWorkspaceId`에서 **handshake(callerPid) 우선**: `resolved` 있으면 MY_WORKSPACE_ID/MY_PTY_ID 채우고 hit. 없으면(구 main) 현행 클라측 walk + env 폴백(WI-002)으로 graceful fallback. 1회 캐시.
- 채널: MY_PTY_ID가 handshake로 채워지면 `getSenderPtyId`(verified-only)가 **walk-miss 시에도 유효** → 채널 mutation이 Codex서 작동(현재 fail-closed → 해결).

## 3. 보안 (issue-113 trust 모델 정합)
- **위조 callerPid:** 악성 same-user 클라가 victim의 pid 전송 → main이 victim workspace 해석 가능. 단 **same-user 천장(#113)**: 토큰 보유 same-user는 이미 legacy grandfather로 allow-all → 위조 pid는 **신규 경계 약화 0**(issue-113 §6 결론과 동일). 채널 verified-senderPtyId는 same-user 보안경계가 아니라 **신뢰성**(정당 caller가 신원 확보) 메커니즘.
- **#163 터미널 라우팅:** 서버측 resolved ptyId도 `assertWorkspaceOwnsPty` 통과(현행 검증 유지). 약화 없음.
- **connection-binding(소켓당 신원 고정) 보류:** issue-113이 same-user 신원검증=near-moot로 판정 → 추가 보안가치 marginal. 본 작업은 **신뢰성(reliability)** 해결만, 보안경계 불변. (P1 legacy 닫힘 + P2 per-identity 토큰 후에 재고.)

## 4. ★OPEN 데이터 게이트 (DOGFOOD가 검증)
**가정: Codex의 MCP 서버가 pane shell의 프로세스 조상인가?** Codex가 pane에서 `codex` 실행→MCP를 자식 spawn이면 `MCP→codex→pane shell` = 서버측 walk가 도달(✓). 단 Codex가 **백그라운드 데몬/detached로 MCP spawn**하면 조상 아님→서버측 walk도 미스(✗, 더 깊은 문제). **DOGFOOD에서 Codex를 dev pane에 띄워 서버측 walk 해석 확인이 1차 게이트.** (WI-002 진단로깅이 walk hit/miss/depth 노출.)
- 보조 가정: 클라측 walk 실패 원인=Codex 샌드박스(H1). 서버측 walk가 우회. dogfood 확인.

## 5. 엣지 케이스
- **PID 재사용:** handshake는 startup 1회+캐시. walk 시점 스냅샷 일관. 재발급 workspace는 현행 `isLiveWorkspace`/invalidate로 self-heal(불변).
- **구 main(resolved 미지원):** MCP가 `resolved` 부재→현행 walk+env 폴백. 하위호환.
- **main getParentPid 비용:** Win32_Process 스냅샷 1회/handshake(캐시). async. POSIX는 `ps -eo pid,ppid` 1회.
- **callerPid 부재/비정상:** main이 무시하고 기존 map 반환(현행 동작).
- **렌더러 down(rpc-down):** handshake도 input.findOwnerWorkspace 필요 → 현행 grace/transient 처리 재사용.

## 6. 테스트
- 서버측 walk 순수 유닛: pid 트리 fixture + pid-map → resolved 매칭(hit/miss/depth-cap/순환방지). (electron-free 모듈로 추출.)
- `a2a.resolve.identity.resolveIdentity.test.ts` 확장: callerPid 경로 회귀+신규.
- mcp/index resolver: handshake 우선 + 폴백 순서 source-invariant(WI-002 패턴).
- 회귀 0: 기존 클라측 walk/env/채널 provenance/#163.

## 7. DOGFOOD (라이브)
`scripts/proper-mcp-identity-dogfood.mjs`(신규):
1. 격리 dev wmux(out/, 본 fix+WI-002 진단). pane 생성.
2. **★Codex를 dev pane에 실행**(codex config `[mcp_servers.wmux] env={WMUX_SOCKET_PATH=dev,...}`로 dev 연결 — env 스트립 우회) → 서버측 handshake가 신원 해석함을 진단로그로 확인(클라 walk 미스여도 resolved hit). **채널 mutation 성공**(현재 fail-closed→해결) 실증.
3. Claude도 동일 pane 테스트(회귀: 여전히 작동).
4. before/after: handshake 비활성(현행 walk만, Codex 미스) vs 활성(resolved hit).
5. 사용자 GUI 라이브 dogfood = ship 게이트([[no_ship_without_user_verification]]).

## 8. NOT in scope
- peer-PID/네이티브 애드온(issue-113 defer). connection-binding(보안 near-moot). company.*. WI-002 env폴백 제거(상호보완 유지). trust-root P1/P2(별개 에픽).

## ✅ 11. CORRECTION (2026-06-27) — §10 진단이 틀린 pid-map을 읽음 → §2 서버측-walk RE-VALIDATED

**§10은 결함 데이터다.** `.wmux/pid-map`(무접미사=패키지앱 app-3.3.0 stale, 87엔트리)을 읽었으나 라이브 Codex는 **`.wmux-dev` 인스턴스**(npm-start, electron `daemon-bundle`, 287엔트리). 올바른 `.wmux-dev/pid-map` 재측정:
- **node-pty `ptyProcess.pid` = 셸(powershell.exe)** (격리 dev 클린 확인: 앵커 PID=powershell, conhost 아님). 앵커 메커니즘 **정상**.
- **라이브 Codex 셸이 `.wmux-dev`에 정확히 앵커:** 49076→daemon-57454146, 29244→daemon-8904015f.
- **재-walk: Codex MCP(39876)→codex(25020)→node(40452)→powershell(49076)=ANCHOR at depth 3.** 앵커가 조상체인에 있고 reachable. MCP는 자식 0(샌드박스 일치).

**→ §10 "앵커 틀림" 결론 철회. 진짜 원인 = 앵커는 정확·reachable, 클라 walk가 depth-3까지 traverse 못함(Codex 샌드박스가 getParentPid PowerShell child spawn 차단; process.ppid는 depth1=codex만 무료, depth2/3는 PowerShell 필요).** `mcp-identity-shell-pid-anchor.md`(셸-자기보고)는 **무의미(앵커 이미 정확)→폐기.**

**→ §2 서버측-walk가 정답으로 RE-VALIDATED:** main이 MCP pid부터 walk(비샌드박스, Win32_Process 스냅샷=`portWatch.ts:58` 재사용)→depth3 셸 앵커 hit→해석. codex 1차리뷰 게이트("MCP→codex→매핑 셸 PID 보이면 서버측 walk 타당") **충족.** codex 1차리뷰 반영: portWatch 스냅샷 재사용, handshake coalesce, callerPid=self-asserted-server-correlated 라벨, stale-prune 동반(287엔트리 누적→재활용 오라우팅). **다음=§2 구현(서버측 walk).**

## ⛔ 10. (철회됨 — §11 참조) DATA INVALIDATES §2 DESIGN (2026-06-27, 틀린 pid-map `.wmux` 기준 — 무효)

codex 플랜리뷰가 코어 가정(MCP가 pane shell의 자손이고 pid-map 앵커가 그 조상)을 미증명으로 **빌드 차단** 권고 → **사용자 프로덕션 실제 Codex 에이전트의 프로세스 트리를 서버측 직접 walk**(아무것도 안 띄움). 결과:

- **실제 Codex×2(PID 25020, 8968): MCP 서버=`node dist/mcp/mcp/index.js`(codex 직계자식) 존재. 그러나 전체 조상체인(codex→node→powershell→electron→…→GONE)에 pid-map 앵커 0 = depth -1 MISS.** 서버측 walk도 동일하게 미스.
- **pid-map=87엔트리 중 4 생존, 생존앵커=conhost.exe×2 / wmux.exe / TabTip.exe** = 앵커가 셸 PID 아님(conhost거나 재활용 PID). **stale 누적(prune 실패) + OS PID 재사용 = 유령**.
- 생존 Codex 셸 PID(49076, 29244)는 pid-map 부재.

**결론: walk(클라/서버 무관)가 미스하는 진짜 원인 = pid-map 앵커가 에이전트의 셸 조상이 아님**(node-pty `ptyProcess.pid`가 ConPTY서 conhost일 가능성 + stale/recycled). **§2 서버측-walk 설계는 틀린 문제를 품 — 폐기.**

### ✅ REAL FIX 방향 (데이터 기반)
**pid-map 앵커를 에이전트가 실제로 descend하는 셸 PID로** 교정:
- **(권장) 셸 자기보고 앵커:** wmux가 이미 주입하는 셸 훅(OSC133 `pwsh.ps1`/`bash.sh`)이 셸 자신의 `$PID`+WMUX_PTY_ID를 wmux에 보고 → pid-map에 **진짜 셸 PID** 기록 → 에이전트(셸 자식)가 walk-up 시 확실히 hit. node-pty/conhost 모호성 우회.
- **+ stale-accretion 수정:** prune 신뢰성(87엔트리 누적은 별개 버그).
- (조사 필요) node-pty `ptyProcess.pid`가 ConPTY서 conhost인지 dev서 클린 확인.
- 서버측 walk는 보조(여전히 클라 샌드박스 우회엔 유용하나, 앵커가 맞아야 의미).

**상태: §2 폐기, REAL FIX는 별도 재-PLAN 필요(앵커 교정). 다음=dev서 node-pty pid 정체 확인 → 셸 자기보고 앵커 설계.**

## 9. 파일 영향 (예상 — §2 기준, SUPERSEDED by §10)
- `src/shared/rpc.ts`(a2a.resolve.identity 반환에 `resolved?` + callerPid 파라미터 doc).
- `src/main/pipe/handlers/a2a.rpc.ts`(callerPid 시 서버측 walk).
- 신규 `src/main/identity/serverSidePidWalk.ts`(+test, 순수 walk 로직).
- `src/mcp/index.ts`(handshake 우선 + 폴백).
- 신규 `scripts/proper-mcp-identity-dogfood.mjs`.
- 무변경: firstParty/methodCapabilityMap(메서드명 불변), terminalRouting(#163), channels.ts/a2a.channel.rpc.ts(provenance), company.*.
