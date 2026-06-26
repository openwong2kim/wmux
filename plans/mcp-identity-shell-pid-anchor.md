# MCP 신원 REAL fix — pid-map 앵커를 셸 자기보고 PID로 교정

> **레인:** L2 Core / Platform · **대체:** `proper-mcp-identity-server-side.md`(서버측-walk 설계는 라이브 데이터로 폐기 §10)
> **선행:** WI-002(PR #299, Claude env+진단) · [[reference_mcp_env_propagation_split]]
> **프로세스:** PLAN → ENGREVIEW(codex) → 구현 → REVIEW → DOGFOOD(라이브 Codex+Claude)
> **준수:** [[no_claude_attribution]] · [[git_identity_openwong2kim]] · codex 게이트

## 1. 근본 원인 (라이브 프로덕션 프로세스트리 직접 측정으로 확정)

MCP 서버는 자기 pane을 **프로세스 트리 walk**(조상 중 pid-map 엔트리 찾기)로 해석. Codex는 env 스트립([[reference_mcp_env_propagation_split]])이라 walk가 유일 경로. **그런데 walk가 미스한다 — 진짜 이유:**

**pid-map 앵커 PID가 에이전트의 셸 조상이 아니다.** 실측(사용자 라이브 dev wmux):
- conhost 앵커(24412, 13308, pid-map에 있음) 부모 = electron(wmux). 실제 Codex 셸(49076, 29244 = `powershell.exe`, **pid-map 부재**) 부모도 electron. → **conhost와 셸이 형제(sibling).**
- 즉 node-pty `ptyProcess.pid`가 **conhost.exe**를 가리키고, `PTYManager.writePidMap`/`pty.handler.writePidMap`이 그 conhost PID를 기록(`PTYManager.ts:200`·`pty.handler.ts:407,750`이 "셸 PID"로 가정·미검증). 에이전트(codex)는 **셸(powershell)에서 descend** → walk-up이 셸→electron으로 가며 **conhost(형제, 조상 아님)를 영원히 못 만남** → MISS → "identity unknown".
- 부수: pid-map 87엔트리 중 4생존(prune 실패=stale 누적) + OS PID 재사용 = 유령 앵커.

**핵심: walk의 위치(클라/서버)가 아니라 앵커가 틀렸다.** (그래서 peer-PID[네이티브애드온]도 서버측-walk도 무의미.)

## 2. 설계 — 셸이 자기 `$PID`를 pid-map에 직접 앵커

**핵심:** wmux가 이미 주입하는 셸 훅(`src/main/pty/shell-hooks/pwsh.ps1`·`bash.sh`)이 **셸 시작 시 셸 자신의 실제 PID를 pid-map에 기록.** 셸은 (a) 자기 `$PID`(=에이전트의 실제 조상) (b) `$WMUX_PTY_ID`(env, 셸은 가짐) (c) fs 접근(비샌드박스) 모두 보유 → conhost 모호성·node-pty quirk·에이전트 env-strip/샌드박스 전부 우회.

```
현행: wmux가 node-pty.pid(=conhost) 기록 → 에이전트 walk가 conhost(형제) 못 찾음 = MISS
신규: 셸 훅이 $PID(=진짜 셸, 에이전트의 조상) 기록 → 에이전트 walk가 셸 hit
```

### 2.1 셸 측 (`pwsh.ps1`·`bash.sh`)
- 시작 시(OSC133 init 옆): `WMUX_PTY_ID` 있으면 `{wmuxHome}/pid-map/{$PID}` = `$WMUX_PTY_ID` 기록. wmuxHome = `$USERPROFILE\.wmux{$WMUX_DATA_SUFFIX}` (셸이 USERPROFILE+SUFFIX 보유). best-effort(실패 무시), 1회.
- cmd.exe는 훅 제약 → node-pty.pid 폴백 유지(cmd서 에이전트 희소).
- **ENGREVIEW Q:** 셸이 직접 fs write vs OSC 이스케이프로 보고→wmux가 write(단일 writer). 권장=직접 write(단순), 단 경로/권한 검증.

### 2.2 메인 측
- node-pty.pid write **유지(폴백)** — daemon 모드선 셸 PID 맞을 수 있음(WI-002 dogfood서 walk hit). 셸 자기보고가 **추가** 앵커(둘 다 있으면 walk가 셸 hit). **ENGREVIEW Q:** node-pty.pid가 항상 conhost면 그 write는 유령 생성 → 제거? dev 클린 재현으로 confirm.
- **stale-prune 수정(별개·동반):** removePidMapByPtyId 신뢰성 + read-path에서 죽은 PID 엔트리 정리(현 87엔트리 누적). a2a.rpc 읽기 시 live PID 아닌 엔트리 스킵(현행 일부) + 주기적 정리.

### 2.3 검증 단계 (구현 1단계 = 데이터)
- **dev 클린 재현:** 격리 dev(local+daemon 모드 각각) 신규 pane → pid-map 엔트리 PID가 conhost인가 셸(pwsh)인가 + 그 pane서 `codex`/자식 spawn → walk hit 확인. node-pty.pid 정체 확정 → §2.2 결정.

## 3. 보안
- 셸 자기보고 PID는 셸(비샌드박스, env 보유)이 자기 $PID 기록 = **위조 불가**(셸은 자기 PID만 앎). 외부 same-user가 임의 pid-map 엔트리 위조? 이미 same-user 천장(#113, pid-map dir owner-writable). 신규 약화 0. 채널 verified-senderPtyId는 이제 **올바른 셸 앵커로 walk hit** → Codex 채널 mutation 작동(현재 fail-closed→해결), 신뢰성 개선.
- #163 터미널: 앵커 교정은 walk가 **올바른** workspace 해석 → assertWorkspaceOwnsPty 정상. 약화 없음.

## 4. 엣지/회귀
- daemon 모드(node-pty.pid=셸일 수 있음): 자기보고 추가는 무해(같은 ptyId, 같은/다른 PID 둘 다 hit). 회귀 0.
- 셸 재시작/respawn: 훅 재실행→재기록(새 $PID). cleanup은 ptyId 매칭(content)이라 PID 무관 제거.
- WMUX_PTY_ID 부재(CLI/비-wmux 셸): 훅 no-op(기록 안 함). 안전.
- WI-002 env폴백/진단: 상호보완 유지(Claude 경로·진단 로깅).

## 5. 테스트
- 셸 훅 단위(pwsh.ps1·bash.sh): WMUX_PTY_ID 있을 때 pid-map write, 없을 때 no-op, 경로 조립. (`pwshHook.test.ts` 패턴.)
- pidMap/a2a.resolve.identity: 셸-앵커 엔트리 해석 + stale 정리 회귀.
- 회귀: 기존 walk/env/채널 provenance/#163/WI-002.

## 6. DOGFOOD (라이브 — 진짜 게이트)
`scripts/mcp-identity-anchor-dogfood.mjs`:
1. 격리 dev wmux pane. 셸 훅이 $PID 기록 확인(pid-map 엔트리=셸 PID, conhost 아님).
2. **그 pane서 실제 Codex 실행** → MCP가 walk로 셸 앵커 hit → 신원 해석 성공 → **채널 mutation 성공**(현재 실패→해결) 진단로그로 실증. (Codex MCP는 default pipe 연결=단일 dev 인스턴스면 OK.)
3. Claude 동일 pane 회귀.
4. before/after: 셸-자기보고 off(현행, Codex 미스) vs on(hit).
5. **사용자 GUI 라이브**(Codex×2 채널) = ship 게이트([[no_ship_without_user_verification]]).

## 7. 파일 영향 (예상)
- `src/main/pty/shell-hooks/pwsh.ps1`·`bash.sh`(자기보고 1블록).
- `src/main/pty/PTYManager.ts`·`ipc/handlers/pty.handler.ts`(node-pty.pid write 처분 — §2.2 confirm 후).
- `src/main/pty/pidMap.ts`·`pipe/handlers/a2a.rpc.ts`(stale 정리 강화).
- 신규 dogfood + 단위 테스트.
- 무변경: terminalRouting(#163), channels provenance, company.*, WI-002 env폴백.

## 8. NOT in scope
서버측-walk/peer-PID/mcp.handshake(폐기). trust-root P1/P2. WI-002 제거.

## ✅ 9b. ENGREVIEW (codex, 2026-06-27) — "Proceed, but revise" · 수정 LOCKED
코어 셸-자기보고 설계 **승인**("right direction for interactive shell panes"). 구현 전 필수 수정:
1. **★daemon 훅 추가:** 로컬 pane=`shell-hooks/pwsh.ps1·bash.sh`, **daemon pane=`src/daemon/shell-integration.ts`가 생성**(:29,117,328,346). **양쪽 다 self-report 추가**(안 그러면 daemon dogfood가 fix 미검증=프로덕션 미커버).
2. **node-pty.pid 주장 완화:** codex가 node-pty 1.1.0 소스 확인—`WindowsTerminal._pid=_agent.innerPid`, ConPTY innerPid=native `connect().pid`=`CreateProcessW piClient.dwProcessId`=**셸이어야 정상**. → 프로덕션 conhost 앵커는 **재활용 PID(stale)**일 가능성(node-pty.pid=conhost 단정 아님). **confirm-first 게이트 필수.** node-pty.pid write는 **확인 전까지 유지**(cmd/unknown/exec의 유일 앵커).
3. **★exec-pane 갭:** daemon exec(X8 `exec:codex`/supervised, DaemonSessionManager:274)는 OSC133 훅 스킵→self-report 없음. WMUX_PTY_ID는 받지만 Codex가 스트립→여전히 node-pty.pid 의존. **dogfood에 supervised codex 케이스 추가**, 미스 시 exec용 verified 앵커 유지 또는 self-report 셸 래핑(supervision 의미 변경 주의).
4. **★stale-prune 동반(필수):** liveness만으론 재활용-live-PID 오라우팅 못 막음. **`writePidMap`이 먼저 `removePidMapByPtyId(ptyId)`**(같은 ptyId 옛 엔트리 삭제) + local `dispose`도 ptyId 제거 + resolver가 no-owner(렌더러 가용 시) 엔트리 삭제. read-path liveness는 additive.
5. **보안 문구 정정:** "셸은 자기 PID만 기록"=거짓. same-user 셸코드는 임의 pid-map 파일명 기록 가능(신규 break 아님—`~/.wmux*/pid-map` 이미 same-user writable). plan은 "same-user 스푸핑 잔존" 명시. read서 ptyId 소유 검증+stale 정리로 우발 오라우팅 축소.

**구현 디테일(codex):** write=hook load 시 1회, try/catch(`2>/dev/null||true`), **prompt 안에서 절대 실행 금지**(latency). PowerShell=Join-Path/따옴표(공백 경로 OK). Bash=Windows/Git Bash는 `$USERPROFILE`(있으면 `cygpath -u`), 없으면 `$HOME`; WSL≠Windows USERPROFILE 주의. OSC-보고 대안은 더 깨끗(셸측 path/suffix 로직 제거+단일 writer)하나 exec 갭은 동일—직접 write도 양쪽 훅+best-effort면 OK.

**구현 1단계=confirm-first:** dev 클린 재현(local+daemon)으로 node-pty.pid 정체(conhost vs 셸) + 왜 셸 엔트리 부재(prune? recycle?) 확정 → §2.2/exec 결정.
