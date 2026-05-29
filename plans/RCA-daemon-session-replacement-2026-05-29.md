# RCA: "데몬 초기화 → 세션 신규 교체" 안정성/보안 근본원인 분석

> 작성일 2026-05-29 · 전문가 10명 진단 → 12개 안건 취합 → 6개 안건 × 3명(근본원인검증/수정설계/적대적반증) 심층검토 → 합성
> 검토 규모: 35 에이전트, ~307만 토큰, 763회 코드 조사

## 0. 한 줄 결론

**"데몬이 초기화된다"는 멘탈 모델은 틀렸다.** 데몬 프로세스는 죽지 않는다(uptime 단조증가·메모리 안정·bootId 불변으로 확정). 진짜 버그는 **렌더러(및 main)의 재연결/reconcile 로직이 "일시적 실패"와 "영구 사망"을 구분하지 못하고, 살아있는 세션의 `ptyId`를 파괴적으로 비워 `Terminal`이 빈 신규 세션을 self-create** 하는 것이다. 데몬은 기존 세션을 그대로 들고 있으므로(고아화) 데몬 로그에 흔적이 없다 → 사용자에겐 "창은 유지, 세션만 신규 교체"로 보인다.

핵심 결함 클래스(모든 direct 안건이 수렴): **"한 번 실패 = 즉시 세션 폐기" — 비파괴(non-destructive) 보장의 부재.**

## 1. 확정된 사실 (코드 + 런타임 로그 교차검증)

- 데몬 프로세스 생존: `daemon-2026-05-28.log` uptime 39,611s→48,463s 단조증가, 메모리 ~100MB.
- launcher `ensureDaemon`이 살아있는 데몬 발견 시 `spawned:false`로 재사용(`launcher.ts:381-384`) → 재연결돼도 uptime 리셋 없음 → 로그와 정합.
- `main onInstall`이 초기/재연결 구분 없이 `webContents.send('daemon:connected')`(`index.ts:591`) → 렌더러 `reconcilePtys()` 재실행.
- 종착점: `Terminal.tsx:68-138` `externalPtyId` falsy → `pty.create`로 신규 빈 데몬 세션 생성.

## 2. 직접 근본원인 (버그 direct)

### A1 — 렌더러 reconcile/reconnect의 거짓 사망 판정 → 파괴적 폐기 [CRITICAL, confidence: HIGH]
살아있는 세션을 죽은 것으로 오판하는 두 경로:
- **경로1 (reconcile):** `pty.list`(=`daemon.listSessions`)가 데몬 recover 중 **빈/부분 배열을 "성공적으로" 반환**하면 `AppLayout.tsx:419-425`가 `activeIds.has(ptyId)=false`로 보고 `updateSurfacePtyId('')`로 폐기.
- **경로2 (useTerminal mount):** `daemon:connected`로 5개 Terminal이 동시 `pty.reconnect` 재발사 → handler-swap 윈도/pipe-not-writable에서 `{success:false}`/throw → `clearSurfacePtyIdByPty`(`useTerminal.ts:672-689, 779-796`)로 즉시 폐기.
- 두 경로 모두 `ptyId=''` → `Terminal` self-create. **5개 중 일부만 팅기는 비결정성**은 경로2의 swap/probe 윈도 경쟁으로 설명됨.
- 5명 전문가가 독립적으로 1순위 지목(강한 수렴).

### A2 — reconcile 타임아웃(5s) < RPC 타임아웃(10s) 비대칭 [CRITICAL, MEDIUM]
- `RECONCILE_TIMEOUT_MS=5_000`(`AppLayout.tsx:76`) < `RPC_TIMEOUT_MS=10_000`(`DaemonClient.ts:7`). 데몬이 6~9초 내 정상 응답 가능한데도 렌더러가 5초에 먼저 포기 → `catch`에서 `clearAllPtyState()`(전 세션 폐기, startup 경로).
- **정정(적대적 검증):** "데몬 이벤트루프 stall" 가설은 코드상 반박됨(`listSessions`는 동기 인메모리 연산). 5초 초과의 실제 트리거는 named-pipe/IPC 왕복 지연. mid-session 팅김의 직접원인은 비대칭이 아니라 `daemon.onConnected→reconcilePtys`의 stale-list clear(=A1 경로1).

### A4 — health-probe(3×3s) 오탐 → 강제 respawn/재연결 폭풍 [HIGH, MEDIUM]
- `runHealthPing`(`DaemonRespawnController.ts:301-325`): 3초 타임아웃 ping을 3연속 실패하면 timeout/unauthorized/일시 stall/진짜 hang을 **구분 없이** "hang" 단정 → `handleDisconnect`+respawn → `daemon:connected` 재발신 → A1 발화.
- 5세션 고부하로 이벤트루프 ~9초 stall 시 살아있는 데몬 오탐 → "하루 2회" 산발성과 정합.
- **잠복 변종:** `launcher.ts:500-533` two-shot ping마저 실패하면 검증된 진짜 데몬을 `SIGKILL` → 더 심한 데이터 손실.
- **미확정(적대적 검증):** 비SIGKILL(데몬 재사용) 경로에서 "오탐→세션 교체"의 인과는 코드상 자동으로 이어지지 않음(데몬 listSessions는 부분/공집합 레이스가 없음). 실제 사건이 SIGKILL 경로였는지 비SIGKILL이었는지는 **로그 부재로 판별 불가** → A8 필요.

### A6 — 제어 파이프 단절 복원력 부재 + 무관용 reconnect [HIGH, MEDIUM]
- `DaemonClient.connect`(`DaemonClient.ts:42-64`)는 `net.createConnection` 1회만 시도, `err.code` 무시, TCP fallback 없음(대조: `wmux-client.ts:158-192`는 보유). `disconnectSync`는 pending RPC를 reject만(replay 없음).
- Windows EPERM/ECONNRESET(AV 스캔·핸들 경합)으로 일시 단절 → 영구 실패로 취급 → A1 경로로 세션 폐기 전파.

## 3. 메타 결함 — 이것을 가장 먼저 고쳐야 한다

### A8 — 라이프사이클/연결 관측성 전무 [HIGH] **(8명 전원 독립 지적, 최강 수렴)**
- `attach`/`detach`/`reconnect`/`rebind`/`ptyId-clear`/`auth-fail`이 데몬·main 어디에도 로깅되지 않음. 렌더러의 파괴적 결정은 `console.log`로만 남아 데몬 로그와 상관분석 불가.
- **결과: A1·A2·A4·A6 중 어느 경로가 실제 어제 팅김을 일으켰는지 코드만으로 단정 불가.** 적대적 검증이 반복해서 "로그 없이는 그럴듯한 추측"이라 결론.
- → **수정·재발감시·가설 확정의 전제 조건. P0 최우선.**

## 4. 기여/배경 요인

| 안건 | 내용 | 판정 |
|------|------|------|
| A3 | `daemon:connected` 재발신 → 가드 없는 late reconcile | **강등(LOW)**. reconcile v2는 이미 비파괴적이라 단독 원인 아님. 진짜 용의자는 `useTerminal.ts:728/658`의 조건부 `terminal.reset()`(스크롤백만 소실) |
| A5 | wmic.exe 부재 → `getBootId()` `uptime-` 폴백 | **버그 비인과로 반증(HIGH→LOW)**. bootId는 데몬 생애 1회 캐시되어 안정적이고, 영향 지점은 `recoverSessions`(startup 한정, 데몬 무재시작 시 미실행)뿐. **사실이지만 세션 교체와 무관.** 코드 위생 차원 수정만 권고 |
| A7 | SessionPipe 단일클라 재접속 레이스 + 비원자 attach → 데이터/입력 먹통(체감 "빈 세션") | HIGH |
| A9 | sessions.json 부분기록·경합·NaN TTL → 세션 메타 유실 | HIGH |
| A10 | RingBuffer 8MB 포화 + `bufferMaxMb=64` 미적용 → 장시간 세션 스크롤백 영구 손실 | MEDIUM. "컨텍스트 사라짐"의 일부는 교체가 아닌 정상 포화 |
| A11 | 데몬 모드 pid-map 영구 누수 + PID 재사용 미검증 | MEDIUM(별도 워크스페이스 난립) |

### ⚠️ A5에 대한 정정 (초기 분석 수정)
초기에 런타임 로그에서 "reboot detected 28건" + "어제 PC = Win11 최신 = wmic 없음"을 근거로 A5(bootId)를 어제 버그의 유력 원인으로 격상했으나, **안건당 3명 심층검토의 적대적 반증이 이를 코드로 반박**했다: bootId는 OS 부팅감지가 제어흐름을 바꾸는 곳이 `recoverSessions`(데몬 startup 한정) 단 한 곳뿐이고, 데몬이 재시작되지 않았으므로 라이브 세션 교체에 닿을 경로가 없다. **사실관찰은 맞지만 인과는 틀렸다.** 진짜 원인은 렌더러 reconnect/reconcile(A1)이다.

## 5. 보안 — 별도 트랙 (버그 무관, 프로덕션 영향 큼)

### A12 [HIGH]
1. 토큰 ACL 재하드닝 부재 — `daemon-auth-token`이 Administrators/SYSTEM/CodexSandboxUsers에 읽기 노출(`.wmux-backup-acl-broken-*` 2개가 과거 사고 입증).
2. Windows TCP fallback이 127.0.0.1에 항상 열리고 단일 토큰만으로 인증 → 동일 호스트 임의 프로세스가 RPC 호출 가능.
3. SSRF: `browser_navigate`가 검증 후 hostname 재해석(loadURL) → DNS 리바인딩 TOCTOU; 127.0.0.0/8 전체 허용.
4. `McpRegistrar`가 `~/.claude.json`을 부팅마다 비원자·비잠금 read-modify-write로 덮어씀 → 사용자 설정 유실 위험.

## 6. 처방 — 단일 원칙으로 수렴

> **"데몬이 살아있는 한, 살아있는 ptyId를 절대 파괴적으로 비우지 않는다."**

공통 수정:
- reconcile 비파괴화: `pty.list`가 빈/부분/throw일 때 그 사이클 **no-op(보존)**. 개별 부재는 즉시 clear 대신 **2-strike**(짧은 backoff 후 재조회, 2연속 부재일 때만 사망 확정). 사망 확정은 가급적 명시적 `session:died` 신호에만.
- `pty.reconnect` 실패 시 error code로 "영구 부재(session not found/dead)" vs "일시 실패(pipe not writable yet)"를 구분 → 일시 실패는 재시도(2~3s 상한).
- 타임아웃 단일 소스화: `shared/timeouts.ts`에서 `RECONCILE = DAEMON_RPC + 5s` 파생(독립 표류 차단).
- late-reconnect(`AppLayout.tsx:623-636`)에 startup과 동일한 abort/timeout/generation 가드 + catch에서 `clearAllPtyState` 금지.

## 7. 실행 우선순위

- **P0 (즉시):**
  1. **A8 관측성 로깅** — attach/detach/reconnect/ptyId-clear/health-hang/list-count를 데몬·main 공통 logSink에 구조화 기록. (진단·확정의 전제)
  2. **A1 비파괴 reconcile/reconnect** — 어느 트리거든 공통으로 차단. "하루 2번 팅김"을 직접 멈춤.
- **P1:** A2(타임아웃 단일소스), A4(health-probe 보수화: 임계 3→5, 타임아웃 3s→5s, 이벤트루프 self-stall 감지, SIGKILL 전 재확인), A6(파이프 재시도/EPERM 분기/TCP fallback).
- **P2:** A7(attach 직렬화·원자화), A9(load 실패와 빈상태 구분), A10(bufferMaxMb 적용), A3(`terminal.reset` 가드).
- **별도 보안 트랙:** A12.

## 8. 정직한 한계

코드만으로는 어제 "2번 팅김"의 **정확한 단일 트리거**(A1 reconcile vs A4 health-probe vs A6 파이프단절 vs `useTerminal.reset`)를 확정할 수 없다 — 모두 동일 종착점(빈 세션 self-create)으로 수렴하지만 발화 선행조건이 로그로 입증되지 않았다. **올바른 순서: A8 로깅을 먼저 배포 → 다음 재발 시 로그로 트리거 확정.** 단, A1 비파괴화는 모든 트리거를 공통 차단하므로 로그 확정을 기다리지 말고 즉시 적용한다.
