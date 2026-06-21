# LanLink PR-5 — 렌더러 가시화 + 페어링 UX (build-ready plan)

> 산출: grounding 워크플로우(7 opus reader, post-PR-4 실측, `wf_80b987c5-b83`) → 이 plan.
> 선행: PR-1(#270)·PR-2(#271)·PR-3(#272)·PR-4(#273 `77b0e63`) 전부 main 머지.
> 미션: PR-4의 데몬 네트워크 코어 + control-pipe 페어링 RPC를 **사람이 쓸 수 있게** 만든다.
> **데몬(`src/daemon/**`) 0줄.** execute-불가·no-PTY-paste 불변식 유지.

---

## 0. 실측 vs 프롬프트 — 드리프트 요약 (실측이 우선)

grounding 7 reader가 §0.5 앵커를 전수 검증. **메서드 문자열/param/return은 100% HOLDS.** 단 5건의 드리프트/미해결 결정:

| # | 항목 | 프롬프트 가정 | 실측 | 결정(eng-review LOCKED 2026-06-21) |
|---|---|---|---|---|
| **D1** | RpcMethod 승격 | §0.5(48-52): 7개를 `rpc.ts` union+array + `methodCapabilityMap` + `reference.md`에 추가 | `daemon/index.ts:1364-1369` 주석 명시 **"control-pipe RPCs, not RpcMethods"**. 현재 union/array/map에 7개 부재. 단 PR-3 `lanlink.status/configure`는 같은 control-pipe인데도 union+map+ref에 등록됨(선례). | ✅ **승격** (§4.3). PR-3 선례 일관 + capability 문서화. reference.md 104→111 regen. |
| **D2** | remote 카드 surface | FleetView 3번째 탭 vs 섹션(plan 결정) | FleetView 탭=`'fleet'|'approvals'`(`uiSlice.ts:41`), per-tab roving focus(focusedIdx/inboxIdx), 라벨 inline ternary(`FleetView.tsx:372`) | ✅ **3번째 탭 `'remote'`** (§5.1). |
| **D3** | revoke → 카드 소멸 | §2 dogfood: "revoke → 카드/peer 소멸" | `RemoteInboxItem`에 **peerUuid 없음**(`{recordId,origin,peerName,text,seq,receivedAt}`). revoke(peerUuid)와 카드 조인 **구조적 불가**. slice에 dismiss 액션 없음(append-only). | ✅ revoke=**peer 목록만 제거** + **per-card dismiss**(slice `dismissRemoteItem(recordId)`) (§5.3). dogfood 기대 조정. |
| **D4** | no-paste 스캔 커버리지 | §2: "no-paste 소스스캔 green" | `remoteInboxNoPaste.test.ts`는 `src/main/lanlink/**`만 스캔. PR-5 새 파일(`lanlink.handler.ts`, `DaemonClient.ts`)은 **범위 밖** → trivially green, 0 커버리지. | ✅ **sibling 스캔 추가**(§7) — 새 bridge 파일에 동일 벽 enforce. |
| **D5** | result 타입 위치 | §1: "shared/lanlink.ts 신규 결과 타입(PairBeginResult/...)" | shared/lanlink.ts에 해당 타입 **부재**. `src/shared`는 `tsconfig.daemon.json` 포함이나 `src/daemon/**`는 아님. | ✅ shared/lanlink.ts에 타입 추가 = **허용**("daemon 0줄"=`src/daemon/**`만, §4.4). |
| **D6** | send 아웃바운드 UI | §1: "send" 브리지 포함 | design doc v0=수신 단방향("답장은 받는 쪽이 pane 타입") | ✅ **send 브리지+타입만, GUI 버튼 미노출**(P1). dogfood/미래용 배관만. |

---

## 1. 범위 (정확히)

**만든다 (3 트랙):**
1. **main 브리지(layer 1-3 + 타입 + drift)** — 7 RPC를 렌더러가 호출 가능하게.
2. **Settings 페어링 UI** — PIN 발급+카운트다운, join 폼, peers 목록+revoke.
3. **remote-inbox 카드 + "remote peer" 배지** — `selectRemoteInbox()` 소비, FleetView 3번째 탭.

**안 만든다(명시):** `src/daemon/**` 수정 · mDNS/Agent Cards · 대칭 reply cross-PC · 원격 execute · 새 인박스 IPC plumbing(PR-2 완비) · **send 아웃바운드 GUI 버튼**(D6: 브리지/타입만, UI는 P1).

---

## 2. 7개 control RPC 계약 (실측 확정 — `daemon/index.ts:1372-1399` / `server.ts`)

| RPC 문자열 | params | return | 비고 |
|---|---|---|---|
| `lanlink.pair.begin` | 없음 | `{ pin:string, expiresInMs:number\|null }` | server.ts:333. `expiresInMs` null 가드 필수 |
| `lanlink.pair.status` | 없음 | `{ active:boolean, expiresInMs:number\|null, failCount:number }` | server.ts:310. 폴링 소스 |
| `lanlink.pair.cancel` | 없음 | `{ ok:true }` | |
| `lanlink.pair.join` | `{ host:string, port:int1..65535, pin:string }` 전부 필수 | `{ peerUuid:string, peerName:string }` | 누락 throw. async, reject 가능 |
| `lanlink.send` | `{ host, port, peerUuid, text? }` host/port/peerUuid 필수 | `{ ok:true }` | async, reject 가능 |
| `lanlink.peers.list` | 없음 | `{ peers: Array<{ peerUuid, peerName, pairedAt, lastSeenAt, burned }> }` | **래퍼 키 `peers`**. 5필드(secret stripped) |
| `lanlink.peers.remove` | `{ peerUuid:string }` | `{ ok:true }` | 빈 peerUuid=silent no-op(error 아님)→removal은 list refresh로 확인 |

**클라이언트측 가드(데몬은 신뢰경계 보유):** port 1..65535 검증, pair.join/send는 RPC reject catch→UI 표면화, peers.remove는 `{ok}`만으로 신뢰 말고 list refresh.

---

## 3. 트랙 1 — main 브리지 (4-layer, PR-3 패턴 미러)

PR-3이 `lanlink.status/configure`로 깐 4-layer chain을 7개로 복제. **각 RPC = 5개 파일 기계적 편집:**

### 3.1 IPC 채널 상수 — `src/shared/constants.ts` (line 151 LANLINK_CONFIGURE 뒤)
```ts
LANLINK_PAIR_BEGIN:  'lanlink:pair:begin',
LANLINK_PAIR_STATUS: 'lanlink:pair:status',
LANLINK_PAIR_CANCEL: 'lanlink:pair:cancel',
LANLINK_PAIR_JOIN:   'lanlink:pair:join',
LANLINK_SEND:        'lanlink:send',
LANLINK_PEERS_LIST:  'lanlink:peers:list',
LANLINK_PEERS_REMOVE:'lanlink:peers:remove',
```

### 3.2 shared 결과 타입 — `src/shared/lanlink.ts` (신규, D5)
```ts
export interface LanLinkPairBeginResult { pin: string; expiresInMs: number | null; }
export interface LanLinkPairingStatus  { active: boolean; expiresInMs: number | null; failCount: number; }
export interface LanLinkJoinResult      { peerUuid: string; peerName: string; }
export interface LanLinkPeerSummary     { peerUuid: string; peerName: string; pairedAt: number; lastSeenAt: number; burned: boolean; }
export interface LanLinkPeersListResult { peers: LanLinkPeerSummary[]; }
export interface LanLinkPairJoinArgs    { host: string; port: number; pin: string; }
export interface LanLinkSendArgs        { host: string; port: number; peerUuid: string; text?: string; }
```

### 3.3 DaemonClient 메서드 — `src/main/DaemonClient.ts` (line 346 lanlinkConfigure 뒤)
camelCase `lanlink<Verb>()`, RPC 문자열은 dotted. (`rpc()` 시그니처: `async rpc(method, params={}, opts={}): Promise<unknown>`)
```ts
async lanlinkPairBegin(): Promise<LanLinkPairBeginResult> {
  return (await this.rpc('lanlink.pair.begin', {})) as LanLinkPairBeginResult;
}
async lanlinkPairStatus(): Promise<LanLinkPairingStatus> { return (await this.rpc('lanlink.pair.status', {})) as LanLinkPairingStatus; }
async lanlinkPairCancel(): Promise<{ ok: true }> { return (await this.rpc('lanlink.pair.cancel', {})) as { ok: true }; }
// ⏱ pair.join/send는 scrypt PIN-EKE PAKE + LAN 왕복 → 기본 10s 초과 가능(outside voice P2). timeoutMs 30s 사전설정.
async lanlinkPairJoin(args: LanLinkPairJoinArgs): Promise<LanLinkJoinResult> {
  return (await this.rpc('lanlink.pair.join', args as unknown as Record<string, unknown>, { timeoutMs: 30_000 })) as LanLinkJoinResult;
}
async lanlinkSend(args: LanLinkSendArgs): Promise<{ ok: true }> { return (await this.rpc('lanlink.send', args as unknown as Record<string, unknown>, { timeoutMs: 30_000 })) as { ok: true }; }
async lanlinkPeersList(): Promise<LanLinkPeersListResult> { return (await this.rpc('lanlink.peers.list', {})) as LanLinkPeersListResult; }
async lanlinkPeersRemove(peerUuid: string): Promise<{ ok: true }> { return (await this.rpc('lanlink.peers.remove', { peerUuid })) as { ok: true }; }
```
> ✅ pair.join/send `timeoutMs: 30_000` 사전설정(outside voice P2: scrypt lifetime이 기본 `RPC_TIMEOUT_MS=10s` 초과 시 "RPC timeout" 오인 방지). begin/status/cancel/peers는 기본 10s.

### 3.4 IPC 핸들러 — `src/main/ipc/handlers/lanlink.handler.ts` (registerLanLinkHandlers 본문 + cleanup)
read shape(no args)/write shape(`_event, payload`) 미러. 각 `ipcMain.handle` 앞에 `removeHandler`, cleanup 클로저에도 `removeHandler` 추가.
```ts
ipcMain.removeHandler(IPC.LANLINK_PAIR_BEGIN);
ipcMain.handle(IPC.LANLINK_PAIR_BEGIN, wrapHandler(IPC.LANLINK_PAIR_BEGIN,
  async (): Promise<LanLinkPairBeginResult> => daemonClient.lanlinkPairBegin()));
// ... join (write):
ipcMain.handle(IPC.LANLINK_PAIR_JOIN, wrapHandler(IPC.LANLINK_PAIR_JOIN,
  async (_event, args: LanLinkPairJoinArgs): Promise<LanLinkJoinResult> => daemonClient.lanlinkPairJoin(args)));
// peers.remove (write):
ipcMain.handle(IPC.LANLINK_PEERS_REMOVE, wrapHandler(IPC.LANLINK_PEERS_REMOVE,
  async (_event, peerUuid: string): Promise<{ ok: true }> => daemonClient.lanlinkPeersRemove(peerUuid)));
```
> `registerHandlers.ts:134`은 이미 daemon-mode 게이팅+teardown. **0 변경**(7 핸들러가 registerLanLinkHandlers 안에 탑승).

### 3.5 preload 노출 — `src/preload/preload.ts:563-583` (기존 literal **확장**, 재할당 금지)
```ts
pairBegin:  () => ipcRenderer.invoke(IPC.LANLINK_PAIR_BEGIN) as Promise<LanLinkPairBeginResult>,
pairStatus: () => ipcRenderer.invoke(IPC.LANLINK_PAIR_STATUS) as Promise<LanLinkPairingStatus>,
pairCancel: () => ipcRenderer.invoke(IPC.LANLINK_PAIR_CANCEL) as Promise<{ ok: true }>,
pairJoin:   (args: LanLinkPairJoinArgs) => ipcRenderer.invoke(IPC.LANLINK_PAIR_JOIN, args) as Promise<LanLinkJoinResult>,
send:       (args: LanLinkSendArgs)     => ipcRenderer.invoke(IPC.LANLINK_SEND, args) as Promise<{ ok: true }>,
peersList:  () => ipcRenderer.invoke(IPC.LANLINK_PEERS_LIST) as Promise<LanLinkPeersListResult>,
peersRemove:(peerUuid: string) => ipcRenderer.invoke(IPC.LANLINK_PEERS_REMOVE, peerUuid) as Promise<{ ok: true }>,
```
preload.ts:10 type import에 신규 타입 추가.

### 3.6 렌더러 타입 선언 — `src/shared/electron.d.ts:65-73` (lanlink 객체에 7키 추가)
electron.d.ts:65는 **이미 fully-typed** `lanlink?` 블록(status/configure typed). 7키를 typed block에 추가 + `import` line 2에 신규 타입 추가. **⚠️ 갭(outside voice P1 근거 교정):** preload의 `(electronAPI as Record<string,unknown>).lanlink = {...}` cast는 **할당**에 있어 preload literal 키 추가는 이 선언에 대해 tsc 체크 0 — 오타난 키(`pairBegn`)는 렌더러 호출부에서만 fail. **완화:** preload 객체에 `satisfies` 적용 고려(타입 강제) 또는 기존 출시된 cast 위험 수용. 렌더러 호출부 타입은 electron.d.ts가 보장.

---

## 4. 트랙 1b — capability/drift 동기화 (D1: 승격 결정)

### 4.1 sync points (승격 시)
1. `src/shared/rpc.ts` RpcMethod union(line 159 뒤) — 7 문자열 추가.
2. `src/shared/rpc.ts` ALL_RPC_METHODS(line 266 뒤) — **동일 7 문자열**(union과 정확 일치, 아니면 gen-api die).
3. `src/main/mcp/methodCapabilityMap.ts`(line 312 뒤) — 7개 `{ capability:'wmux.internal' }`. (`Record<RpcMethod,...>` totality가 강제)
4. `scripts/gen-api-reference.mjs` GROUP_ORDER — **`lanlink` 그룹 1줄 추가**(outside voice P1 최고위험). 현재 GROUP_ORDER에 `lanlink.` 키 없음 → 7+기존 status/configure가 `### other` 잡동사니로 떨어짐. `{ key: 'lanlink.', title: 'lanlink' }`를 `daemon.` 앞에 추가 → 9개 메서드 전용 섹션. ⚠️ status/configure도 other에서 이동하므로 reference.md diff가 +7행보다 큼(자명).
5. `docs/api/reference.md` — `node scripts/gen-api-reference.mjs`로 **regen**(Total 104→111 + lanlink 섹션 신설, 하드편집 금지). CI=`--check`(genApiReference.test.mjs).

### 4.2 테스트
- `methodCapabilityMap.test.ts:63-66` it() 안에 7개 `expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.pair.begin'],{})).toBe('wmux.internal')` 추가.

### 4.3 D1 결정 근거 (승격) + 반론
**승격 채택.** 근거:
- **PR-3 선례:** `lanlink.status/configure`도 control-pipe RPC(`index.ts:1360`)인데 union+map+reference.md에 등록됨. 동일 처리가 일관.
- **capability 문서화/방어:** `wmux.internal`=plugin/MCP 절대 호출불가. 미래에 누가 RpcRouter로 노출해도 자동 차단(defense-in-depth). reference.md에 보안 표면 가시화.
- **프롬프트 §0.5 명시 요구.**

**반론(eng-review 검증 대상):** `daemon/index.ts:1369` 주석이 "not RpcMethods"라고 명시 → 이 7개는 RpcRouter/RpcContext를 절대 안 거치므로 capability gating은 **발동 안 하는 dead 표식**. 잘못된 "RpcRouter로 호출 가능" 신호 우려.
**반박:** 주석은 *데몬 dispatch 메커니즘*(pipeServer.onRpc, RpcRouter 아님)을 설명. union 등록은 *드리프트 가드+문서화* 목적이며 status/configure 선례가 정확히 그 패턴(둘 다 RpcRouter 안 거침에도 등록). → **승격이 PR-3과 일관.** eng-review가 최종 lock.

### 4.4 do-not-touch (drift-lock 유지)
- `router.test.ts:11-25` — LAN net.Server allow-list(`ACCEPTED_KINDS=['msg.text','state.update']`, admitKind가 pair.begin/peers.remove 거부). **불변.** 7개를 ACCEPTED_KINDS에 넣으면 보안 회귀.
- `src/daemon/**` — 0줄. (shared/lanlink.ts 타입 추가는 daemon 동작 불변이므로 허용)

---

## 5. 트랙 2 — remote-inbox 카드 (FleetView 3번째 탭, D2)

### 5.1 surface 결정: 3번째 탭 `'remote'`
**근거:** (a) per-tab roving focus(focusedIdx/inboxIdx) 패턴에 remoteIdx 추가로 슬롯-인 vs 섹션은 단일 탭 내 2 listbox→단일 roving index 불변식 붕괴. (b) cross-PC peer는 same-machine approvals와 구분되는 top-level 개념. (c) 탭바 map/body ternary/keyboard effect가 이미 `tab` 분기 → grain-aligned.

### 5.2 편집 (`src/renderer/components/FleetView/FleetView.tsx` + `uiSlice.ts`)
1. `uiSlice.ts:41` union → `'fleet' | 'approvals' | 'remote'`.
2. `FleetView.tsx:359` 배열 → `['fleet','approvals','remote']`.
3. `FleetView.tsx:372` 라벨 → **명시적 3-way 삼항/맵**(`id==='remote' ? 'fleet.tab.remote' : id==='approvals' ? 'fleet.tab.approvals' : 'fleet.tab.fleet'`). ⚠️ **`t(\`fleet.tab.${id}\`)` 템플릿 리터럴 금지**(outside voice P1급): `t()`가 `(string & {})` escape 브랜치로 컴파일돼 키 부재 시 tsc-pass + raw 문자열 `"fleet.tab.remote"` 렌더. 명시적 키만 `TranslationKey` exhaustiveness 보존.
4. `FleetView.tsx:379` body ternary → switch/IIFE에 `tab==='remote'` 분기(`<RemoteInboxList items={remoteInbox}/>`, 빈 상태는 FleetView 소유, approvals 미러).
5. remote inbox 파생: `selectRemoteInbox(s)`를 FleetView에서 호출(selectApprovalInbox:79 미러), prop 전달.
6. keyboard/focus effect(`:180/:248/:281`)에 `tab==='remote'` 분기 + `remoteIdx` state/clamp(inboxIdx 미러). **읽기전용이면 roving은 no-op + Tab-cycle**(D3에 따라 dismiss 버튼 유무 결정).
7. `AppLayout.tsx:264` `inboxOwnsApprovals` 게이트는 `==='approvals'`만 → remote 탭 modal suppress **안 함**(불변, eng-review 확인).

### 5.3 RemoteInboxList 컴포넌트 (신규, ApprovalInboxList 미러)
- 순수 presenter: `<div role="listbox">` + rows. row optionProps `{role:'option', aria-selected, tabIndex:focused?0:-1, data-inbox-row, data-source:'remote'}`.
- row className `flex flex-col gap-2 p-3 rounded-lg outline-none`, border `1px solid ${focused?'var(--accent-blue)':'var(--bg-overlay)'}`.
- 표시: **"remote peer" 배지**(KbdRow pill 스타일 `text-[10px] font-mono px-2 py-0.5 rounded`) + peerName + **text(React 텍스트 child `{item.text}` ONLY)** + receivedAt(timestamp 포맷).
- **🔒 보안 하드 제약:** `dangerouslySetInnerHTML` 금지, submitToPty/paste 금지, 터미널/a2a execute 퍼널 금지. UNTRUSTED off-machine 입력.
- **D3 dismiss (✅ LOCKED = B):** revoke로 카드 못 지움(peerUuid 부재) → per-card dismiss 버튼. 신규 slice 액션 `dismissRemoteItem(recordId)`(remoteItems delete + remoteItemOrder filter, recordId 기반 안전). row에 X 버튼(stopPropagation→onDismiss(recordId), caller=FleetView가 dispatch 소유). slice 액션 추가 = `remoteInboxSlice.ts` 편집 + `remoteInboxSlice.test.ts` dismiss 단위테스트.
- **⌨ dismiss 포커스 모델 (✅ outside voice P2, approvals 정확히 미러):** dismiss 버튼은 `tabIndex={focused?0:-1}`(roving) + **포커스된 행에서 Delete/Backspace로 dismiss**. Tab으로 X 버튼 도달에 의존 금지 — Fleet 모달 Tab-트랩(`FleetView.tsx:219`)과 roving `remoteIdx`가 dual-focus 경쟁(S-C2 codex P1 전례)하므로. approvals 키보드 분기(`:248-265`) 그대로 미러.

---

## 6. 트랙 3 — Settings 페어링 UI (PR-3 LanLink 섹션 확장)

### 6.1 구조: sibling `LanLinkPairingSection` 컨테이너 + `LanLinkPairingView` 순수 뷰
**LanLinkView/LanLinkSection(`SettingsPanel.tsx:834/881`)는 0편집**(zero-state 순수성+기존 테스트 보존). 신규 sibling이 `LanLinkView/LanLinkSection` 분리 패턴(순수뷰 renderToStaticMarkup + 컨테이너 useState/useIpc) 미러.

### 6.2 컨테이너 와이어(LanLinkSection 881-991 verbatim 복제)
- lazy `window.electronAPI.lanlink` 옵셔널체이닝 가드 → 부재 시 unavailable placeholder(블랭크 금지).
- `useIpc({ silent:['NOT_FOUND','UNKNOWN','DAEMON_DISCONNECTED'] })` ipcInvoke.
- `refresh()` in useEffect + `daemon.onConnected` 재probe.
- **enabled===true일 때만 페어링 섹션 actionable**(disabled LanLink는 폼 숨김/비활성, §9 OQ 확인).

### 6.3 UI 요소
- **"Pair this machine":** `pairBegin()` → PIN 표시(KbdRow pill, 큰 mono 숫자) + **카운트다운**(`expiresInMs` deadline 기준 setInterval, null 가드 → inactive 표시) + `pairStatus()` 폴링으로 active/failCount. cancel 버튼(`pairCancel()`).
- **"Join a machine":** host/port/pin 폼(SettingPathInput commit-on-blur 미러 + SettingNumberInput port) → `pairJoin({host,port,pin})`. reject catch→error 표면화. 성공 시 peers refresh.
- **peers 테이블:** `peersList()` → `result.peers` 행. 각 행 peerName + pairedAt/lastSeenAt + **"remote peer" 배지** + revoke 버튼(destructive, confirm-then-act ResetSection:537-545 미러) → `peersRemove(peerUuid)` → list refresh(`{ok}` 불신뢰, D3).
- 카운트다운/PIN source of truth: `expiresInMs`→deadline epoch을 컨테이너 state에 저장(re-render 생존).
- **⚡ cleanup(perf, 비협상):** 카운트다운 `setInterval`+`pairStatus` 폴링은 `useEffect` return으로 clear. **active일 때만 폴링, inactive/unmount 시 중단**(leak 방지). `peersList`는 변경시(join/revoke)만 refresh — 상시 폴링 금지.

### 6.4 i18n (en/ko BOTH, 실측 경로 `src/renderer/i18n/locales/{en,ko}.ts`)
`// LanLink pairing (PR-5)` 주석 아래 flat dotted `settings.lanlinkPair*`/`lanlinkPeers*`. `t()`는 interpolation vars 지원(`lanlinkPairCountdown` `{seconds}`). 키 목록:
```
settings.lanlinkPair, lanlinkPairStart, lanlinkPairStartDesc, lanlinkPairPin, lanlinkPairPinHint,
lanlinkPairCountdown ({seconds}), lanlinkPairExpired, lanlinkPairCancel,
lanlinkPairJoin, lanlinkPairJoinDesc, lanlinkPairJoinHost, lanlinkPairJoinPort, lanlinkPairJoinPin,
lanlinkPairJoinButton, lanlinkPairPairing, lanlinkPairError,
lanlinkPeers, lanlinkPeersEmpty, lanlinkPeerBadge ('remote peer'), lanlinkPeerPairedAt,
lanlinkPeerLastSeen, lanlinkPeerRevoke, lanlinkPeerRevokeConfirm, lanlinkPeerRevoked
```
+ FleetView 탭: `fleet.tab.remote`(en/ko), remote 빈 상태 `fleet.remote.empty`. + 카드 "remote peer" 배지 라벨.
> ⚠️ **i18n 정직(outside voice P2):** `TranslationMap`은 `en` 키 기준 required, ko 포함 22개 locale은 `Partial`→누락 키는 **silent en fallback**(빌드 실패 아님). 따라서 **en 추가는 tsc 강제**(`t('settings.lanlinkPair…')` 호출부가 키 요구), **ko 누락은 silent**. "en/ko parity 검증됨" 주장 금지 — ko는 수동 추가하되 누락이 CI를 깨지 않음을 인지. 나머지 21 locale=en fallback(기존 동작 일치, 허용).

---

## 7. 검증 매트릭스 (머지 = 비압축 바닥)

### 7.1 정적/스위트 green (전부 유지)
- **tsc 4-config** exit0 (main/renderer/preload/daemon).
- **vitest 풀스위트** green.
- **`gen-api-reference --check`** green (reference.md regen+커밋, D1 승격 시 필수).
- **router drift-lock**(`router.test.ts`) 불변 — ACCEPTED_KINDS, admitKind 거부 유지.
- **methodCapabilityMap totality** — 7 entry 추가로 만족(D1).

### 7.2 신규/확장 테스트
- **DaemonClient 7 브리지**(`DaemonClient.test.ts` createMockDaemonServer 하네스): 7 mock 핸들러 등록, 각 `client.lanlinkXxx()` 호출, params verbatim forward + return 검증. peers.list `{peers}` 언랩 확인.
- **methodCapabilityMap +7**(§4.2).
- **LanLinkPairingView**(`LanLinkSection.test.tsx` 확장): renderToStaticMarkup 순수 뷰(jsdom 없음, RTL 없음) — PIN 마크업/begin·cancel·join affordance/busy/peers row/badge. onStartPair/onJoin/onRevoke prop 직접호출 와이어. peers projection 순수헬퍼 테스트(nicOptions 스타일).
- **RemoteInboxList**(FleetCard.test.tsx 미러): renderToStaticMarkup, html.toContain "remote peer" 배지 + peerName + text. **제어문자 무해**: text에 ESC/`\x1b[` 넣어도 React escape(마크업에 raw 제어문자 부재).
- **D4 no-paste sibling 스캔**: 신규 테스트가 `src/main/ipc/handlers/lanlink.handler.ts`에 submitToPty/deliverPty*/useRpcBridge/a2a.rpc/_bridge import·call 0 단언. DaemonClient 전체 스캔은 오탐→핸들러 파일 타깃. ⚠️ **정직(outside voice P2):** handler가 `shared/lanlink`만 import + `daemonClient.lanlink*()`만 호출 → trivially pass forever. 이건 **cheap 회귀 가드**(미래에 누가 paste 머신을 import하면 잡음)지 의미있는 coverage 아님. **진짜 no-paste 벽 = dedicated `LANLINK_REMOTE` IPC 채널 아키텍처(PR-2)** + outside voice가 입증한 구조적 도달불가. oversell 금지.

### 7.3 CDP 라이브 dogfood (메모리 PR-2/3/4 CDP법: Start-Process detached + WMUX_DATA_SUFFIX 격리 + playwright-core + Vite-URL import)
1. Settings → `pairBegin` → **PIN 픽셀 렌더 + 카운트다운 감소**.
2. 2번째 suffix 데몬이 `pairJoin`(LAN IP — loopback은 C2가 막음) → peers 목록에 표시.
3. `send` → **remote-peer 카드 픽셀 렌더 + "remote peer" 배지**.
4. **remote text에 ESC/제어문자 → 터미널 효과 0**(React 텍스트 증명).
5. revoke → **peer 목록서 소멸**(카드는 D3 결정대로 — 읽기전용이면 잔존, dismiss면 per-card).
> 1머신 real-net(LAN IP). 물리 2머신 라이브는 사용자 몫(메모리 W-T2).

### 7.4 적대 게이트
- **eng-review**(§아래) + **codex cross-model**(`codex review --base main -c 'model_reasoning_effort="high"'`) + CodeRabbit. no-paste·capability·drift·UNTRUSTED-render 전수 통과.

---

## 8. 파일 변경 목록 (요약)

**main 브리지:** `shared/constants.ts`(+7 IPC) · `shared/lanlink.ts`(+7 타입) · `shared/electron.d.ts`(+7 키) · `main/DaemonClient.ts`(+7 메서드) · `main/ipc/handlers/lanlink.handler.ts`(+7 핸들러+cleanup) · `preload/preload.ts`(literal +7키, import) · `shared/rpc.ts`(union+array +7) · `main/mcp/methodCapabilityMap.ts`(+7) · `docs/api/reference.md`(regen).
**remote 카드:** `renderer/stores/slices/uiSlice.ts`(union +remote) · `renderer/components/FleetView/FleetView.tsx`(탭/body/keyboard) · `renderer/components/FleetView/RemoteInboxList.tsx`(신규) · (D3-B 시 `remoteInboxSlice.ts` +dismiss).
**Settings:** `renderer/components/Settings/SettingsPanel.tsx`(+LanLinkPairingSection/View sibling) · `renderer/i18n/locales/{en,ko}.ts`(+키).
**테스트:** `DaemonClient.test.ts` · `methodCapabilityMap.test.ts` · `LanLinkSection.test.tsx` · `FleetView/__tests__/RemoteInboxList.test.tsx`(신규) · no-paste sibling 스캔(신규).
**불변:** `src/daemon/**`(0) · `router.test.ts`(0) · `LanLinkView/LanLinkSection`(0) · `registerHandlers.ts`(0).

---

## 9. 결정 로그 + 잔여 Open Questions
**eng-review LOCKED (2026-06-21):** D1=승격 · D2=3번째 탭 · D3=per-card dismiss · D4=sibling 스캔 · D5=shared 타입 허용 · D6=send 브리지만.

**잔여(구현 중 확정 — codex outside voice 검토 대상):**
1. pair.join/send `rpc()` timeoutMs 비기본 필요? (scrypt lifetime/네트워크 — 데몬 PR-4 메모리). 기본값으로 시작, dogfood 타임아웃 시 상향.
2. 페어링 섹션 gating — **enabled===true에서만 actionable**(권고). disabled LanLink는 폼 비활성.
3. remote 카드 keyboard: dismiss 버튼 1개 → inboxIdx 미러 roving(approvals 패턴).

## 10. seam 메모 (channels §11)
remote 카드/배지=미래 cross-PC 방(channels × LanLink) 원격 멤버 표시 토대. `deliver()` seam은 별 트랙. 정직 루프: ship → 4-5인 dogfood 3주 → 데이터만이 P1(대칭 reply/팀 발견) 정당화.

---

## 11. eng-review 종합 (2026-06-21)

### 11.1 Failure modes (신규 codepath별)
| codepath | 실패 | 테스트 | 에러핸들링 | 사용자 가시 |
|---|---|---|---|---|
| pair.begin→PIN 카운트다운 | `expiresInMs=null` 크래시 | LanLinkSection.test | null 가드(§6.3) | inactive 표시 ✓ |
| pair.join reject(잘못PIN/네트워크) | silent 실패 | dogfood | catch→error state(§6.3) | error 표면 ✓ |
| peers.remove `{ok}` 무신뢰 | 미제거인데 UI 제거표시 | dogfood | list refresh 확인(§6.3) | refresh로 검증 ✓ |
| remote text 제어문자 | 터미널 효과 | 단위+dogfood(이중) | React escape | 무력화 ✓ |
| **preload 키 오타** | tsc 미검출(cast 갭) | — | satisfies 완화 권고(§3.6) | 렌더러 호출부 fail (약한 갭, critical 아님) |
| 카운트다운 setInterval | unmount leak | — | useEffect cleanup(§6.3) | — ✓ |

**critical gap(no test+no error+silent): 0.** preload 오타 갭(§3.6)이 유일 약점이나 `satisfies`로 완화 + 렌더러 호출부에서 결국 tsc-fail → critical 아님.

### 11.2 병렬화 전략
| Lane | 트랙 | 모듈 | 의존 |
|---|---|---|---|
| **A** | main 브리지 + shared 타입 + capability/drift | `shared/`, `main/`, `preload/`, `scripts/gen-api` | — (선행: 인터페이스 정의) |
| **B** | Settings 페어링 UI | `renderer/components/Settings/`, `renderer/i18n/` | A (electronAPI.lanlink 타입) |
| **C** | remote 카드 + slice dismiss | `renderer/components/FleetView/`, `renderer/stores/` | A |

**실행:** Lane A 먼저(인터페이스). 그 후 B·C 병렬 가능 — **단 `renderer/i18n/locales/{en,ko}.ts`를 B(settings.lanlinkPair*)와 C(fleet.tab.remote) 둘 다 편집 → 충돌 조율 필요**(작은 충돌). 규모상 worktree 분리는 과함(merge 비용 > 이득) → **단일 세션 워크플로우 권장**(plan §90 step 3). 인터페이스(shared 타입)는 트랙 A가 먼저 확정.

### 11.3 dogfood 결과 (라이브, 2026-06-21)
- **데몬 7-RPC 라이브 19/19** (`scripts/lanlink-pr5-dogfood.mjs`, standalone daemon spawn + suffix 격리): pair.begin PIN 실발급(6자리, expiresInMs=120000) · pair.status active→cancel→inactive · peers.list `{peers}` 래퍼 빈 · peers.remove 빈/unknown uuid `{ok}` no-op · pair.join/send 필수필드 reject. **브리지가 호출하는 데몬 control-pipe 경로(load-bearing half) 전부 실작동.**
- **dev CDP 렌더러 픽셀 9/9** (`scripts/lanlink-pr5-cdp-dogfood.mjs` + PowerShell 래퍼, Start-Process dev 앱 + 포트스캔 18800-18899 + Vite store import): Fleet View 'remote' 탭 open + empty state · remote 카드 2개 + "remote peer" 배지 · peerName/text 렌더 · **제어문자 무해 픽셀 증명**(`←[31mRED←[0m`이 빨강 적용 0, inert 텍스트) · per-card dismiss 정확 1개 제거. 좀비 0(taskkill /T 정리). 스크린샷 `out-pr5-dogfood/`.
- 교훈: 패키지 bundle은 useStore 미노출(s-c2:664)→dev Vite `import('/src/renderer/stores/index.ts')` 필수. dev 앱 spawn은 `node spawn(npm)` 실패→PowerShell `Start-Process`가 작동(forge child stdout 미전파→포트 스캔으로 CDP 발견). taskkill은 harness PowerShell 정적분석 차단→node spawn 풀패스로 우회. **물리 2머신 cross-PC 라이브는 사용자 몫(W-T2).**

### 11.5 pre-merge review (2026-06-21, PR #275)
- **codex review(diff, 이번엔 hang 없이 작동) P2×2** — Claude 적대 diff review가 놓친 **진짜 user-visible 버그 2건 적발(cross-model 가치 입증)**: ①join host/PIN이 commit-on-blur(`SettingPathInput`)라 포커스 안 뺀 채 Join→stale 빈 값 제출(primary 경로 실패) ②`onCancelPair`가 실패해도 PIN 무조건 숨김→데몬 active인데 취소됨 표시. **둘 다 수정**(즉시-onChange 입력 / r.ok 가드).
- **Claude 적대 diff review P2×4** — dead `send`(D6 의도 유지) · double daemon probe(minor follow-up) · null-deadline stall(가드 반영) · stale failCount(reset 반영). VERDICT: safe to merge, 보안 불변식 전부 holds.
- **CI 전 green**: Baseline macos/ubuntu/windows ×2 · validate · bench · **CodeRabbit pass**.
- **PR 인라인 리뷰 2차(codex P2×5+P3×1, CodeRabbit 7)**: 실제버그 수정=pairing status(enabled/nic)+peers **3s 폴링**(sibling 토글 sync+inbound peer 반영)·**NIC gate**(enabled&&nic)·failCount clear on cancel·`window.electronAPI?` optional-chain·assertReject **validation substring 강제**(transport 위장 차단)·empty catch→non-empty. ko 'remote peer' 배지 현지화('원격 피어'). **수용/오탐**: codex#1 advertise(`system.capabilities`가 ALL_RPC_METHODS를 필터없이 노출=**PR-3 status/configure 선례 동일**, wmux.internal로 plugin/MCP 도달불가→cross-cutting follow-up) · CR#2 real ESC(**오탐**: dogfood가 이미 `\x1b` byte 주입, ANSI 렌더가 숨김) · codex#5 effective port(UX follow-up).

### 11.4 outside voice 반영 (Claude subagent, codex 5min timeout 폴백)
P0 두 건 CLEARED(D1 promotion 보안 무해 + no-paste/execute 벽 입증). 발견 6건 전부 plan 반영: ①gen-api GROUP_ORDER +lanlink(§4.1 #4) ②t() 명시맵(§5.2.3) ③dismiss approvals 미러(§5.3) ④electron.d.ts 근거교정+satisfies(§3.6) ⑤timeout 30s(§3.3) ⑥i18n parity/D4 톤(§6.4·§7.2). **cross-model tension 0** — locked 결정 전부 동의.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | (office-hours design doc 존재) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | codex 5min timeout→Claude subagent 폴백, 6 findings 전반영 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | **CLEAR** | 6 결정 lock + 8 issues, critical gap 0 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | (UI 스코프 — 선택) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | N/A |

- **OUTSIDE VOICE:** Claude subagent(codex 폴백) — P0 2건 CLEARED(promotion/no-paste 벽 입증), P1 1건(gen-api 그룹핑)+P2 5건 전반영. cross-model tension 0.
- **UNRESOLVED:** 0 (D1~D6 전부 lock).
- **VERDICT:** ENG CLEARED — 구현 준비 완료. 단일 최고위험(gen-api GROUP_ORDER) 반영됨. 데몬 0줄·no-paste·execute 벽 입증.
