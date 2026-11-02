# 도그푸드 흡수 카탈로그 (설계 §8 / G10)

`scripts/*dogfood*.mjs` **29본**(`ls scripts/*dogfood*.mjs` 전수) 목록화. 각 행 = 스크립트 /
검증하던 것 / 처분. **물리 삭제 0** — 이 문서는 매핑만 한다(삭제는 시나리오 CI 1주 그린 후
개별 PR, §8). "리그가 60번째 도그푸드가 되는 것"(footgun 1)을 막는 계약 문서다.

## 처분 3분류

- **absorb→시나리오 id**: 그 스크립트가 검증하던 **데몬측 불변식**을 SIM 리그 시나리오가
  결정적·격리·CI 편입 형태로 대체한다(§2.5 커버리지 맵의 "데몬 정본"·"파이프 핸들러" 행).
  absorb ≠ 즉시 삭제 — 시나리오가 CI 1주 그린(G11 번인) 후 개별 삭제 PR.
- **keep→수동/E2E 사유**: 리그가 **구조적으로 못 잡는** 것(§2.5 사각 — 렌더러/CDP, MCP
  신원 해석, main 라우터 3중 게이트, 패키지 앱 스폰). E2E 레인(PR-R3+) 또는 수동 유지.
- **retire→중복**: 피처 검증이 아니거나 다른 것으로 완전 커버돼 흡수 대상조차 아님.

핵심 경계(§2.5): SIM은 **헤드리스 데몬 파이프 직결**이라 렌더러·MCP·main 라우터를 우회한다.
CDP로 렌더러를 몰거나(pixel/DOM), MCP 서버의 신원 해석(process-tree walk)을 검증하거나,
패키지 exe를 스폰하는 도그푸드는 **원리상 SIM 밖**이다 — E2E 레인 몫으로 keep.

## 집계

| 처분 | 본수 |
|---|---|
| absorb | 4 |
| keep | 24 |
| retire | 1 |
| **합계** | **29** |

---

## 전수 목록 (29본 — 실제 파일명)

### A2A · 채널 신원 (MCP/렌더러 경로 — 대부분 keep)

| 스크립트 | 검증하던 것 | 처분 | 근거 |
|---|---|---|---|
| `a2a-eventbus-dogfood.mjs` | A2A 인박스 dual-party 스코핑 (패키지 exe) | keep→E2E | 패키지 exe + MCP 인박스 delivery. SIM은 A2A 태스크 정본(S8)은 잡지만 인박스 UI·MCP 스코핑은 §2.5 사각 |
| `a2a-pane-identity-dogfood.mjs` | pane-level A2A 신원·주소지정 (PTY 스푸핑) | keep→E2E | ptyId→pane 해석은 렌더러 소유(S-C2). pane-granular authz는 §2.5 MCP·렌더러 행 |
| `a2a-silent-default-dogfood.mjs` | per-receiver silent-default delivery | keep→E2E | live PTY 전달 기본값 — 실 PTY 전제(S4 재정의가 배제한 넛지 층) |
| `a2a-symmetric-reply-dogfood.mjs` | 대칭 from.ptyId reply + pane-authz (S-C2) | keep→E2E | senderPtyId verbatim + PID-map = MCP/렌더러. **단 rpcCall 패턴은 PipeClient가 승격**(설계 §5 — 코드 재사용은 흡수됨) |
| `same-ws-a2a-dogfood.mjs` | same-ws 멀티에이전트 A2A (self-send 거부) | keep→E2E | same-ws 주소지정 판정이 MCP 신원 해석 의존(§2.5) |
| `multiagent-identity-hardening-dogfood.mjs` | 멀티에이전트 신원 하드닝 (senderPtyId/PID-map) | keep→E2E | 세 repro 전부 MCP 신원 경로 + main 라우터 게이트(양 레인 사각) |
| `proper-mcp-identity-dogfood.mjs` | MCP server-side process-tree walk 신원 | keep→수동 | MCP 계층 — §2.5에서 SIM·E2E **양 레인 사각**(MCP 유닛 몫) |
| `wi-002-mcp-identity-dogfood.mjs` | WMUX_PTY_ID weak fallback 신원 복구 | keep→수동 | 동상 — MCP 신원 fallback(MCP 유닛) |
| `sa-token-acl-dogfood.mjs` | 토큰-ACL re-harden 콜드스타트 (동일 HOME 2회) | absorb→S7 계열 | **데몬측 재부팅 후 상태 생존** = S7 `respawn()` 내구 패턴과 동형. re-harden 특화는 S7 확장 후보 |

### 채널 UI (렌더러 CDP — keep, 데몬 정본은 SIM이 흡수)

| 스크립트 | 검증하던 것 | 처분 | 근거 |
|---|---|---|---|
| `channel-dock-dogfood.mjs` | 채널 dock reflow (bounding box CDP) | keep→E2E | 순수 렌더러 픽셀(요소 rect diff) — E2E-1 계열 |
| `channel-members-dogfood.mjs` | 채널 members roster UI (CDP DOM) | keep→E2E | 렌더러 DOM. **멤버십 정본(getMembers)은 S3가 데몬측 흡수** |

### Fleet · 플러그인 (렌더러/MCP — keep)

| 스크립트 | 검증하던 것 | 처분 | 근거 |
|---|---|---|---|
| `b1-plugin-host-dogfood.mjs` | 플러그인 호스트 end-to-end (CDP GUI) | keep→E2E | 플러그인 UI 패널 — 렌더러 |
| `s-c1-fleet-dogfood.mjs` | Fleet View cockpit (dev CDP) | keep→E2E | 렌더러 cockpit — E2E(CDP) |
| `s-c2-fleet-deepening-dogfood.mjs` | Fleet deepening + MCP trust-DB (패키지 exe) | keep→E2E | 렌더러 + MCP trust chain |

### pane · surface lifecycle (렌더러 leaf 트리 — keep)

| 스크립트 | 검증하던 것 | 처분 | 근거 |
|---|---|---|---|
| `issue-236-pane-split-workspace-dogfood.mjs` | pane.split이 명시 workspaceId 존중 | keep→E2E | pane 스플릿은 렌더러 leaf 트리 소유 — SIM(채널·A2A) 밖 |
| `issue-285-pane-lifecycle-enforce-dogfood.mjs` | pane/surface lifecycle MCP (enforce 모드) | keep→E2E | MCP allowlist + pane lifecycle(렌더러) |

### LanLink (네트워크 페어링 — v1 스코프 밖)

| 스크립트 | 검증하던 것 | 처분 | 근거 |
|---|---|---|---|
| `lanlink-pr3-dogfood.mjs` | control-plane 영속 (HARD KILL+respawn 생존) | absorb→S7 계열 | **데몬측 kill→respawn 후 config.json 생존** = S7 `respawn()` 내구 패턴(다른 도메인). 흡수 후보, 물리 삭제는 S7 CI 그린 후 |
| `lanlink-pr5-dogfood.mjs` | 페어링/피어 control-pipe RPC 7종 (데몬측) | keep→수동 | 데몬 파이프지만 lanlink 도메인(채널·A2A 밖) — 리그 v1 스코프 아님(네트워크). 후속 SIM 확장 가능 |
| `lanlink-pr5-cdp-dogfood.mjs` | lanlink PR5 렌더러 픽셀 (dev CDP) | keep→E2E | 렌더러 픽셀 — SIM 밖 |

### resume · recovery (데몬 복구 골격은 S7, UI 게이트는 E2E)

| 스크립트 | 검증하던 것 | 처분 | 근거 |
|---|---|---|---|
| `x6-resume-dogfood.mjs` | supervised exec resume on RECOVERY (번들 데몬+shim) | absorb→S7 계열 | **번들 데몬 SIGKILL→recovery** = S7 재스폰 골격. exec spawn 특화는 실 CLI shim 의존(§11-5)이라 keep 잔여 |
| `x6-resume-binding-dogfood.mjs` | resume-binding capture→persist→SIGKILL→recover | absorb→S7 계열 | **SIGKILL→recover 후 바인딩 persist 생존** = S7 단방 부분집합(커밋 생존)과 동형 |
| `x6-resume-pill-dogfood.mjs` | recovery-only resumeAgent 노출 (sessions.json 시드) | keep→E2E | daemon.listSessions는 데몬측이나 resumeAgent **pill UI 게이트**는 렌더러 판정 |
| `x6-pill-killreal-dogfood.mjs` | reboot-survival pill (REAL detect→persist) | keep→E2E | detect→persist→pill = 렌더러 detect + UI |
| `x6-multipane-resume-dogfood.mjs` | ALL-PANE resume 신뢰성 (daemon KILL-REAL) | keep→E2E | 멀티페인 resume UI — 렌더러 leaf 트리 |

### 임베디드 브라우저 (렌더러 surface — keep, 1본 retire)

| 스크립트 | 검증하던 것 | 처분 | 근거 |
|---|---|---|---|
| `x3-dogfood-main.mjs` | 임베디드 브라우저 pane 인세션 (CDP) | keep→E2E | 브라우저 pane — 렌더러/CDP |
| `x3-dogfood-restore.mjs` | 브라우저 URL 재시작 영속 (session.json) | keep→E2E | 브라우저 surface 복원 — 렌더러 |
| `x3-dogfood-linkclick.mjs` | 터미널 URL 클릭 스마트 라우팅 (CDP) | keep→E2E | 터미널 링크 클릭 — 렌더러 좌표 |
| `x3-dogfood-cleanup.mjs` | 테스트 workspace 정리 (sidebar close) | retire→중복 | 피처 검증이 아닌 **정리 유틸** — 리그는 격리 홈 teardown(§2 removeRigHome)으로 정리 내장, 별도 cleanup 불요 |

---

## 흡수 논거 요약

- **absorb 4본**(`sa-token-acl`·`lanlink-pr3`·`x6-resume`·`x6-resume-binding`)은 전부
  **데몬측 kill→respawn/recover 내구 불변식**이다 — S7(`RigDaemon.respawn()` + 단방
  부분집합, 확인된 커밋 무손실)이 그 골격을 결정적·격리·CI 형태로 대체한다. 각 도메인
  특화분(re-harden·lanlink config·exec spawn·resume binding)은 S7 확장 시나리오 후보로
  §9-5(후속)에 남는다. 물리 삭제는 S7이 CI 1주 그린 후.
- **keep 24본**은 §2.5 커버리지 맵의 SIM 사각(렌더러 CDP·MCP 신원·main 라우터·패키지
  스폰)에 정확히 대응한다 — 리그가 "전부 커버한다"는 착시를 금지하는 계약(footgun 1).
  대부분 PR-R3+ E2E 레인이 점진 흡수하고, MCP 신원 2본(`proper-mcp-identity`·
  `wi-002-mcp-identity`)과 lanlink RPC 1본은 유닛/후속 몫으로 유지.
- **retire 1본**(`x3-dogfood-cleanup`)은 피처 검증이 아닌 정리 유틸이라 흡수 대상이 아니다
  (리그가 teardown 내장).

> **정직 선언**: 채널 delivery/unread(S1·S3·S5)·A2A 수명주기(S8)·캡 경계(S6)의 **데몬
> 정본**은 SIM이 이미 커버하지만, 그 표면을 검증하던 도그푸드는 전부 **렌더러/MCP 경유**
> (패키지 exe·CDP)라 absorb가 아니라 keep→E2E다 — 데몬측 골격만 SIM이 흡수하고 렌더러
> 상층은 E2E가 흡수한다는 §2.5 이중 흡수 구조.
