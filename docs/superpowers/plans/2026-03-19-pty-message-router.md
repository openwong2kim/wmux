# PTY Message Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PTY 출력에서 `[WMUX-MSG]` / `[WMUX-BROADCAST]` 패턴을 감지하여 자동으로 타겟 멤버의 PTY에 라우팅한다.

**Architecture:** AgentDetector(main process)에 메시지 패턴 파서 추가 → 새 IPC 채널로 renderer에 전달 → renderer가 이름 기반으로 타겟 멤버를 찾아 MessageQueue에 enqueue → idle 시 자동 전달.

**Tech Stack:** TypeScript, Electron IPC, Zustand (immer)

---

### Task 1: AgentDetector에 메시지 라우팅 패턴 추가

**Files:**
- Modify: `src/main/pty/AgentDetector.ts`

- [ ] **Step 1: MessageRouteEvent 인터페이스 추가**

```typescript
export interface MessageRouteEvent {
  from: string;
  to: string;
  message: string;
  priority: 'low' | 'normal' | 'high';
  isBroadcast: boolean;
}
```

- [ ] **Step 2: WMUX-MSG / WMUX-BROADCAST 패턴 상수 추가**

```typescript
// [WMUX-MSG from CEO to Engineering / Priority: HIGH] task description
const MSG_HEADER_RE = /\[WMUX-MSG\s+from\s+(.+?)\s+to\s+(.+?)(?:\s*\/\s*Priority:\s*(LOW|NORMAL|HIGH))?\]\s*(.*)/i;

// [WMUX-BROADCAST from CEO / Priority: HIGH] announcement
const BROADCAST_HEADER_RE = /\[WMUX-BROADCAST\s+from\s+(.+?)(?:\s*\/\s*Priority:\s*(LOW|NORMAL|HIGH))?\]\s*(.*)/i;
```

- [ ] **Step 3: AgentDetector에 메시지 콜백과 파싱 로직 추가**

`AgentDetector` 클래스에:
- `private messageCallbacks: MessageRouteCallback[]` 필드
- `onMessage(callback)` 메서드
- `processLine()` 내부에서 critical/agent 패턴 체크 전에 MSG_HEADER_RE, BROADCAST_HEADER_RE 매칭
- 매칭 시 `MessageRouteEvent` emit
- 메시지 본문이 헤더 라인에 없으면 다음 non-empty 라인을 본문으로 사용하기 위해 `pendingRoute` 버퍼 추가

- [ ] **Step 4: 멀티라인 본문 처리**

헤더 뒤에 본문이 비어있는 경우(`]` 다음에 공백만 있거나 빈 문자열):
- `pendingRoute`에 from/to/priority/isBroadcast 저장
- 다음 non-empty 라인이 올 때 본문으로 사용하여 emit
- `pendingRoute`는 빈 라인 또는 새 `[WMUX-` 헤더가 오면 초기화

---

### Task 2: IPC 채널 추가

**Files:**
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: `MESSAGE_ROUTE` IPC 채널 추가**

```typescript
// Phase 6: Company message routing
MESSAGE_ROUTE: 'company:message-route',
```

---

### Task 3: PTYBridge에서 메시지 라우팅 이벤트 전달

**Files:**
- Modify: `src/main/pty/PTYBridge.ts`

- [ ] **Step 1: agentDetector.onMessage 콜백 등록**

`setupDataForwarding()` 내부에서, `agentDetector.onCritical` 콜백 아래에:

```typescript
agentDetector.onMessage((routeEvent) => {
  const win = this.getWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.MESSAGE_ROUTE, ptyId, routeEvent);
});
```

---

### Task 4: Preload에 MESSAGE_ROUTE 리스너 노출

**Files:**
- Modify: `src/preload/preload.ts` (또는 `src/preload/index.ts` — 실제 electronAPI 정의 파일)

- [ ] **Step 1: company.onMessageRoute API 추가**

```typescript
company: {
  onMessageRoute: (callback: (ptyId: string, event: MessageRouteEvent) => void) => () => void,
}
```

ipcRenderer.on(IPC.MESSAGE_ROUTE, ...) 래핑. cleanup 함수 반환.

---

### Task 5: Renderer에서 메시지 라우팅 처리

**Files:**
- Modify: `src/renderer/hooks/useRpcBridge.ts`

- [ ] **Step 1: useEffect 내부에 MESSAGE_ROUTE 리스너 추가**

```typescript
const cleanupRoute = window.electronAPI.company.onMessageRoute(
  (sourcePtyId: string, event: MessageRouteEvent) => {
    const store = useStore.getState();
    if (!store.company) return;

    // sourcePtyId로 발신자 멤버 찾기 (자기 자신에게 재전송 방지)
    const allMembers = store.company.departments.flatMap((d) => d.members);
    const sourceMember = allMembers.find((m) => m.ptyId === sourcePtyId);

    if (event.isBroadcast) {
      // 브로드캐스트: 발신자 제외 전원에게 전송
      for (const member of allMembers) {
        if (!member.ptyId || member.id === sourceMember?.id) continue;
        if (member.status === 'idle') {
          const formatted = formatBroadcast(event.from, event.message);
          window.electronAPI.pty.write(member.ptyId, formatted + '\r');
        } else {
          store.enqueueMessage(member.id, member.ptyId, member.name, event.message, event.from, true);
        }
      }
    } else {
      // DM: 이름으로 타겟 찾기 (부서명 또는 멤버명 매칭)
      const targets = resolveTargetMembers(store.company, event.to, sourceMember?.id);
      for (const member of targets) {
        if (!member.ptyId) continue;
        if (member.status === 'idle') {
          const formatted = formatMessage(event.from, member.name, event.message);
          window.electronAPI.pty.write(member.ptyId, formatted + '\r');
        } else {
          store.enqueueMessage(member.id, member.ptyId, member.name, event.message, event.from, false);
        }
      }
    }
  },
);
```

- [ ] **Step 2: resolveTargetMembers 헬퍼 함수 구현**

`event.to` 문자열로 타겟을 찾는 로직:
1. 부서명과 정확히 일치 → 해당 부서 리드에게 전송
2. 멤버명과 정확히 일치 → 해당 멤버에게 전송
3. 부서명 + " Lead" 패턴 → 리드에게 전송
4. "CEO" → ceoWorkspaceId의 PTY로 전송
5. 대소문자 무시 + 부분 매칭 (fallback)

```typescript
function resolveTargetMembers(
  company: Company,
  toName: string,
  excludeId?: string,
): TeamMember[] {
  const normalized = toName.trim().toLowerCase();
  const allMembers = company.departments.flatMap((d) => d.members);

  // 1. CEO 매칭
  if (normalized === 'ceo') {
    if (company.ceoWorkspaceId) {
      // CEO는 별도 워크스페이스 — 멤버 리스트에 없을 수 있음
      // ceoWorkspaceId로 PTY 찾아서 직접 전송 필요
      // → 이 경우는 별도 처리 (아래 Step 3)
    }
    return [];
  }

  // 2. 부서명 매칭 → 리드에게 전달
  const dept = company.departments.find(
    (d) => d.name.toLowerCase() === normalized,
  );
  if (dept) {
    const lead = dept.members.find((m) => m.id === dept.leadId);
    return lead && lead.id !== excludeId ? [lead] : [];
  }

  // 3. 멤버명 정확 매칭
  const exactMember = allMembers.find(
    (m) => m.name.toLowerCase() === normalized && m.id !== excludeId,
  );
  if (exactMember) return [exactMember];

  // 4. 부분 매칭 (fallback)
  const partialMatches = allMembers.filter(
    (m) => m.name.toLowerCase().includes(normalized) && m.id !== excludeId,
  );
  return partialMatches;
}
```

- [ ] **Step 3: CEO 타겟 처리**

CEO에게 메시지를 보내는 경우, `company.ceoWorkspaceId`로 워크스페이스를 찾고, 해당 워크스페이스의 활성 PTY에 메시지를 주입:

```typescript
if (normalized === 'ceo' && company.ceoWorkspaceId) {
  const ws = useStore.getState().workspaces.find((w) => w.id === company.ceoWorkspaceId);
  if (ws) {
    // ws의 활성 pane의 활성 surface에서 ptyId 추출
    const leaves = findLeafPanes(ws.rootPane);
    const activeLeaf = leaves.find((l) => l.id === ws.activePaneId) ?? leaves[0];
    if (activeLeaf) {
      const surface = activeLeaf.surfaces.find((s) => s.id === activeLeaf.activeSurfaceId) ?? activeLeaf.surfaces[0];
      if (surface?.ptyId) {
        const formatted = formatMessage(event.from, 'CEO', event.message);
        window.electronAPI.pty.write(surface.ptyId, formatted + '\r');
      }
    }
  }
  return; // CEO 처리 완료
}
```

- [ ] **Step 4: cleanup에 cleanupRoute 추가**

```typescript
return () => {
  cleanupRpc();
  cleanupSubscription();
  cleanupRoute();
};
```

---

### Task 6: 루프 방지 (자기 메시지 재감지 차단)

**Files:**
- Modify: `src/main/pty/AgentDetector.ts`
- Modify: `src/main/pty/PTYBridge.ts`

- [ ] **Step 1: PTYBridge에 최근 주입 메시지 추적**

메시지가 PTY에 write 된 직후, 해당 PTY의 AgentDetector에 "이건 무시해" 신호를 보내야 함.
`AgentDetector`에 `suppressNextMessage()` 메서드 추가:

```typescript
private suppressedMessages = new Set<string>();

suppressMessage(fingerprint: string): void {
  this.suppressedMessages.add(fingerprint);
  // 5초 후 자동 만료
  setTimeout(() => this.suppressedMessages.delete(fingerprint), 5000);
}
```

- [ ] **Step 2: PTY write 시 fingerprint 등록**

메시지를 PTY에 write할 때, 해당 ptyId의 AgentDetector에 fingerprint를 등록.
이를 위해 PTYBridge에 `suppressRouteForPty(ptyId, fingerprint)` 메서드 추가.

renderer → main IPC 채널 필요: `company:suppress-route`

- [ ] **Step 3: processLine에서 suppress 체크**

```typescript
// 메시지 라우팅 감지 시
const fingerprint = `${from}→${to}:${body.slice(0, 50)}`;
if (this.suppressedMessages.has(fingerprint)) {
  this.suppressedMessages.delete(fingerprint);
  return; // 주입된 메시지 — 재라우팅 하지 않음
}
```

**대안 (더 간단):** renderer에서 PTY write 전에 main process의 AgentDetector에 suppress 요청을 보내는 대신, **수신 측 PTY의 AgentDetector에서만 WMUX-MSG를 무시**하도록 설정. 즉, 메시지를 write하는 PTY가 아니라 read하는 PTY에서 감지하므로, write 대상 PTY의 detector를 잠시 비활성화.

실제로 더 간단한 접근: **메시지 라우팅은 발신 PTY에서만 감지**하고, 수신 PTY에서는 감지하지 않음. 이미 `onData`는 PTY의 output만 캡쳐하고, `pty.write()`로 주입된 텍스트는 input이므로 `onData`에서 echo되지 않을 수 있음.

→ **검증 필요**: node-pty에서 `process.write()`한 텍스트가 `onData`로 에코되는지 확인. 에코되면 suppress 필요, 아니면 불필요.

---

### Task 7: Preload 타입 안전성

**Files:**
- Modify: `src/preload/index.ts` 또는 `src/preload/preload.ts`
- Modify: `src/shared/types.ts` (MessageRouteEvent export)

- [ ] **Step 1: MessageRouteEvent를 shared/types.ts에서 export**

`AgentDetector`의 `MessageRouteEvent`를 shared로 이동하여 main/renderer 양쪽에서 사용:

```typescript
// src/shared/types.ts
export interface MessageRouteEvent {
  from: string;
  to: string;
  message: string;
  priority: 'low' | 'normal' | 'high';
  isBroadcast: boolean;
}
```

- [ ] **Step 2: preload에서 타입 import 및 API 노출**

---

### Task 8: 커밋

- [ ] **Step 1: 변경사항 커밋**

```bash
git add src/main/pty/AgentDetector.ts src/main/pty/PTYBridge.ts src/shared/constants.ts src/shared/types.ts src/preload/ src/renderer/hooks/useRpcBridge.ts
git commit -m "feat: auto-route WMUX-MSG from PTY output to target members"
```
