# AskUserQuestion Awaiting-Input Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude Code shows an AskUserQuestion prompt in a wmux pane, fire the existing `awaiting_input` experience (yellow sidebar dot + notification sound), driven by a reliable `PreToolUse` hook instead of fragile regex.

**Architecture:** Ride the existing Claude hook bridge → `hooks.signal` RPC → `HookSignalRouter` → `hooks.rpc.ts` fan-out. The `agent.awaiting_input` kind already exists in the signal union and in `titleFor`/`bodyFor`; we (1) let the validator accept it from hooks, (2) make the fan-out emit it AND light the sidebar dot, and (3) register the `PreToolUse`/AskUserQuestion hook in the bridge.

**Tech Stack:** Node (self-contained bridge .mjs), TypeScript (main process), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-askuserquestion-awaiting-input-design.md`

---

## File Structure

- **Modify** `integrations/shared/signal-types.ts` — `isAgentSignal()` accepts `agent.awaiting_input`; update stale comment.
- **Modify** `src/main/pipe/handlers/hooks.rpc.ts` — add `agent.awaiting_input` to `isEmitKind`; broadcast `agentStatus: 'awaiting_input'` on emit.
- **Modify** `integrations/claude/bin/wmux-bridge.mjs` — `HOOK_TO_KIND.PreToolUse = 'agent.awaiting_input'` + `tool_name` guard.
- **Modify** `integrations/claude/hooks/hooks.json` — register `PreToolUse` matcher `"AskUserQuestion"`.
- **Tests:** extend `integrations/shared/__tests__/signal-types.test.ts` and `src/main/pipe/handlers/__tests__/hooks.rpc.emit.test.ts`.

---

## Task 1: Validator accepts `agent.awaiting_input`

**Files:**
- Test: `integrations/shared/__tests__/signal-types.test.ts`
- Modify: `integrations/shared/signal-types.ts:121-129` (and doc comment ~20-27)

- [ ] **Step 1: Write the failing test**

In `integrations/shared/__tests__/signal-types.test.ts`, add `'agent.awaiting_input'` to the existing `it.each([...])('accepts kind = %s', ...)` list (the array currently holds the four other kinds):

```ts
  it.each([
    'agent.stop',
    'agent.activity',
    'agent.subagent_stop',
    'agent.session_start',
    'agent.awaiting_input',
  ])('accepts kind = %s', (kind) => {
    expect(isAgentSignal({ ...valid, kind })).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/shared/__tests__/signal-types.test.ts`
Expected: FAIL on `accepts kind = agent.awaiting_input` (validator rejects it today).

- [ ] **Step 3: Accept the kind in the validator**

In `integrations/shared/signal-types.ts`, change the kind guard in `isAgentSignal` (lines ~124-129) to also allow `agent.awaiting_input`:

```ts
  if (
    v['kind'] !== 'agent.stop' &&
    v['kind'] !== 'agent.activity' &&
    v['kind'] !== 'agent.subagent_stop' &&
    v['kind'] !== 'agent.session_start' &&
    v['kind'] !== 'agent.awaiting_input'
  ) return false;
```

- [ ] **Step 4: Update the stale doc comment**

In `integrations/shared/signal-types.ts`, in the `AgentSignalKind` doc block (~lines 20-27), replace the "Hook bridges are not expected to emit this kind today" sentence so it reflects that the Claude bridge now emits it on AskUserQuestion:

```ts
 * - agent.awaiting_input  — agent paused for input: a y/N or approval prompt
 *                           (regex AgentDetector), OR Claude Code's
 *                           AskUserQuestion tool (emitted by the Claude hook
 *                           bridge via PreToolUse). Routed through the same
 *                           HookSignalRouter ledger as agent.stop.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run integrations/shared/__tests__/signal-types.test.ts`
Expected: PASS (all kinds incl. `agent.awaiting_input`; `rejects unknown kind` still passes).

- [ ] **Step 6: Commit**

```bash
git add integrations/shared/signal-types.ts integrations/shared/__tests__/signal-types.test.ts
git commit -m "feat(signals): accept agent.awaiting_input from hook bridges"
```

---

## Task 2: Fan out `awaiting_input` + light the sidebar dot

**Files:**
- Test: `src/main/pipe/handlers/__tests__/hooks.rpc.emit.test.ts`
- Modify: `src/main/pipe/handlers/hooks.rpc.ts:179` and the emit block ~229-236 (+ import)

- [ ] **Step 1: Write the failing test**

In `src/main/pipe/handlers/__tests__/hooks.rpc.emit.test.ts`, add a mock for the metadata handler near the other `vi.mock` calls (after line 24), plus a hoisted mock fn (extend the `vi.hoisted` block at line 13):

```ts
const { sendToRendererMock, sendNotificationMock, broadcastMetadataUpdateMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  broadcastMetadataUpdateMock: vi.fn(),
}));
```

```ts
vi.mock('../../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: broadcastMetadataUpdateMock,
}));
```

Then add a test inside the `describe('hooks.signal — agent.lifecycle event tee', ...)` block:

```ts
  it('emits and lights the sidebar dot for agent.awaiting_input', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: '8',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.awaiting_input' }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('agent.awaiting_input');
    // Sound/toast fires…
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    // …and the sidebar dot is set to awaiting_input for the resolved pty.
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentStatus: 'awaiting_input' }),
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/pipe/handlers/__tests__/hooks.rpc.emit.test.ts -t "lights the sidebar dot"`
Expected: FAIL — `awaiting_input` is not an emit-kind, so no lifecycle event, no `sendNotification`, no `broadcastMetadataUpdate`.

- [ ] **Step 3: Import the metadata broadcaster**

In `src/main/pipe/handlers/hooks.rpc.ts`, add to the imports (near line 44, after the `sendNotification` import):

```ts
import { broadcastMetadataUpdate } from '../../ipc/handlers/metadata.handler';
```

- [ ] **Step 4: Add `awaiting_input` to the emit-kinds**

In `hooks.rpc.ts`, change `isEmitKind` (line ~179):

```ts
    const isEmitKind = signal.kind === 'agent.stop'
      || signal.kind === 'agent.subagent_stop'
      || signal.kind === 'agent.awaiting_input';
```

- [ ] **Step 5: Light the dot on emit**

In `hooks.rpc.ts`, in the final emit block (currently lines ~229-236), after the `sendNotification(...)` call and inside the `if (win)` guard, set the agent status for `awaiting_input`:

```ts
    const win = getWindow();
    if (win) {
      sendNotification(win, ptyId, {
        type: 'agent',
        title: titleFor(signal),
        body: bodyFor(signal),
      });
      // Hook path (unlike the detector path in DaemonNotificationRouter) does
      // not otherwise touch agentStatus. For awaiting_input, set it so the
      // sidebar dot turns yellow — the part users see at a glance.
      if (signal.kind === 'agent.awaiting_input') {
        broadcastMetadataUpdate(win, { ptyId, agentStatus: 'awaiting_input' });
      }
    }
    return { ok: true };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/main/pipe/handlers/__tests__/hooks.rpc.emit.test.ts`
Expected: PASS (new test + all existing regression tests in the file).

- [ ] **Step 7: Commit**

```bash
git add src/main/pipe/handlers/hooks.rpc.ts src/main/pipe/handlers/__tests__/hooks.rpc.emit.test.ts
git commit -m "feat(hooks): fan out agent.awaiting_input + set sidebar agentStatus"
```

---

## Task 3: Bridge mapping + guard, and hook registration

**Files:**
- Modify: `integrations/claude/bin/wmux-bridge.mjs:52-57` and `main()` (~line 304)
- Modify: `integrations/claude/hooks/hooks.json`

- [ ] **Step 1: Map PreToolUse → awaiting_input**

In `integrations/claude/bin/wmux-bridge.mjs`, extend `HOOK_TO_KIND` (lines 52-57):

```js
const HOOK_TO_KIND = {
  PreToolUse: 'agent.awaiting_input',
  PostToolUse: 'agent.activity',
  Stop: 'agent.stop',
  SubagentStop: 'agent.subagent_stop',
  SessionStart: 'agent.session_start',
};
```

- [ ] **Step 2: Guard PreToolUse to AskUserQuestion only**

In `wmux-bridge.mjs`, in `main()`, after the empty-stdin check (the block ending ~line 322, right before the auth-token read) add a tool-name guard so only AskUserQuestion produces an awaiting_input signal:

```js
  // PreToolUse fires per tool call; we only treat AskUserQuestion as
  // "awaiting input". A future broad PreToolUse matcher can never tunnel a
  // spurious awaiting_input through here. (Other PreToolUse tools are dropped.)
  if (hookName === 'PreToolUse'
      && !(payload && payload.tool_name === 'AskUserQuestion')) {
    logEvent('skip-pretooluse', { tool: payload && payload.tool_name });
    return;
  }
```

- [ ] **Step 3: Register the hook in hooks.json**

In `integrations/claude/hooks/hooks.json`, add a `PreToolUse` entry to the `hooks` object (alongside `PostToolUse`/`Stop`/etc.), scoped by matcher so the bridge is only invoked for AskUserQuestion:

```json
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs\" PreToolUse"
          }
        ]
      }
    ],
```

- [ ] **Step 4: Validate the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('integrations/claude/hooks/hooks.json','utf8')); console.log('hooks.json OK')"`
Expected: prints `hooks.json OK`.

- [ ] **Step 5: Sanity-run the bridge mapping (no wmux needed)**

Run (simulates a non-matching PreToolUse — should skip, exit 0, write a skip log):
```bash
echo '{"tool_name":"Read","cwd":"/tmp","session_id":"s"}' | node integrations/claude/bin/wmux-bridge.mjs PreToolUse; echo "exit=$?"
```
Expected: `exit=0` (the guard drops it; no crash). A matching `tool_name:"AskUserQuestion"` would proceed to attempt the pipe RPC and fail-open if wmux isn't running — both are exit 0.

- [ ] **Step 6: Commit**

```bash
git add integrations/claude/bin/wmux-bridge.mjs integrations/claude/hooks/hooks.json
git commit -m "feat(claude-bridge): emit awaiting_input on AskUserQuestion PreToolUse"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: PASS (the known daemon save-debounce flake may fail under parallel load — re-run that file in isolation to confirm it's unrelated).

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Lint touched TS files**

Run:
```bash
npx eslint integrations/shared/signal-types.ts src/main/pipe/handlers/hooks.rpc.ts integrations/shared/__tests__/signal-types.test.ts src/main/pipe/handlers/__tests__/hooks.rpc.emit.test.ts
```
Expected: PASS for the changed code (pre-existing warnings elsewhere are out of scope).

- [ ] **Step 4: Manual smoke (real app)**

With the wmux Claude plugin installed, run Claude Code in a wmux pane and trigger an AskUserQuestion. Expect the pane's sidebar dot to turn yellow and the notification sound to play the moment the question appears; answering clears it as the agent resumes.

---

## Self-Review Notes (author checklist — completed)

- **Spec coverage:** validator accepts kind (Task 1) ✓; fan-out emit + dot (Task 2) ✓; bridge map + tool_name guard (Task 3 Steps 1-2) ✓; hooks.json registration (Task 3 Step 3) ✓; tests (Tasks 1-2) ✓; non-goals respected (no new status/sound, no regex, no clear hook) ✓.
- **Type consistency:** `agent.awaiting_input` kind string used identically across signal-types, hooks.rpc, bridge; `broadcastMetadataUpdate(win, { ptyId, agentStatus: 'awaiting_input' })` matches its `(window, MetadataUpdatePayload)` signature and the `AgentStatus` union.
- **No placeholders:** every step has full code/commands with expected output.
```
