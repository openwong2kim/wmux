# Notify on Claude Code AskUserQuestion (awaiting-input via PreToolUse hook)

**Date:** 2026-06-12
**Status:** Approved design, ready for implementation plan
**Area:** `integrations/claude`, `integrations/shared`, `src/main/pipe/handlers`

## Problem

When Claude Code (running in a wmux pane) uses its interactive **AskUserQuestion**
tool, wmux gives the user no signal — no sound, no sidebar dot — so a user who
looked away never learns Claude is blocked waiting on them. wmux *does* notify on
replies (`Stop`) and on the single-line permission prompt (`Do you want to
proceed?`), but not on AskUserQuestion.

### Root cause

wmux detects "awaiting input" only via **AgentDetector regex** on terminal
output, anchored to single-line prompts (`Do you want to proceed?`, `Allow tool
use for X`). AskUserQuestion renders a **multi-line boxed** header + option list,
so no pattern matches → the `awaiting_input` agent status (which already maps to a
yellow sidebar dot + sound) never fires.

The robust fix is signal-based, not regex-based. Authoritative Claude Code docs
confirm: the **Notification hook does NOT fire** for AskUserQuestion, but
**`PreToolUse` with matcher `"AskUserQuestion"` DOES** — firing the instant Claude
is about to show the question, with `tool_name: "AskUserQuestion"`. wmux already
runs a Claude Code **hook bridge** (`wmux-bridge.mjs`) for `Stop`/`PostToolUse`/
`SubagentStop`/`SessionStart`; we add one more hook to it.

## Goal

When Claude Code shows an AskUserQuestion prompt in a wmux pane, fire the existing
`awaiting_input` experience: the **sidebar dot turns yellow** and the
**notification sound/toast** plays — same as the regex path already does for
permission prompts, but driven by a reliable hook.

## Non-goals (YAGNI)

- No new agent status, sound, or sidebar styling — reuse the existing
  `awaiting_input` status, yellow dot, and `type: 'agent'` notification.
- No regex pattern for AskUserQuestion (fragile; the hook is authoritative).
- No enriched notification body (the question text) — `bodyFor` already returns a
  sensible "Approval requested"; question-aware body is a possible follow-up.
- No explicit "clear" hook — answering resumes the agent, whose next
  `session:active` / `Stop` already updates the status away from `awaiting_input`.

## Architecture

Ride the existing bridge → `hooks.signal` RPC → `HookSignalRouter` dedup →
`hooks.rpc.ts` fan-out. The `agent.awaiting_input` kind already exists in the
signal union and in `titleFor`/`bodyFor`; three boundaries currently drop it, and
the fan-out doesn't light the dot. Close exactly those gaps.

```
Claude Code shows AskUserQuestion
  → PreToolUse hook (matcher "AskUserQuestion")
    → wmux-bridge.mjs PreToolUse  (guard: tool_name === "AskUserQuestion")
      → RPC hooks.signal { kind: 'agent.awaiting_input', ... }
        → isAgentSignal() must ACCEPT awaiting_input        [gap 3]
        → resolve cwd/env → ptyId
        → isEmitKind must INCLUDE awaiting_input            [gap 4a]
          → sendNotification(type:'agent')  → sound + toast (existing)
          → broadcastMetadataUpdate({ptyId, agentStatus:'awaiting_input'}) → yellow dot  [gap 4b]
```

## Components & changes

### 1. `integrations/claude/hooks/hooks.json` — register the hook (gap 1)

Add a `PreToolUse` entry whose matcher is scoped to the tool, so the bridge is
invoked only for AskUserQuestion (not every tool call):

```json
"PreToolUse": [
  {
    "matcher": "AskUserQuestion",
    "hooks": [
      { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs\" PreToolUse" }
    ]
  }
]
```

### 2. `integrations/claude/bin/wmux-bridge.mjs` — map + guard (gap 2)

- Add `PreToolUse: 'agent.awaiting_input'` to `HOOK_TO_KIND`.
- Defense in depth: for `PreToolUse`, only emit when the payload's `tool_name`
  is `AskUserQuestion`; otherwise log and exit 0 (so a future broad `PreToolUse`
  matcher can never tunnel a spurious awaiting_input). This is a small guard in
  `main()` after the payload is read.

### 3. `integrations/shared/signal-types.ts` — accept the kind (gap 3)

- `isAgentSignal()` currently accepts only `agent.stop` / `agent.activity` /
  `agent.subagent_stop` / `agent.session_start` and rejects everything else. Add
  `agent.awaiting_input` to the accepted set.
- Update the now-stale doc comment that says "Hook bridges are not expected to
  emit this kind today."

### 4. `src/main/pipe/handlers/hooks.rpc.ts` — fan out + dot (gap 4)

- `isEmitKind` (currently `agent.stop || agent.subagent_stop`) must also include
  `agent.awaiting_input`, so it runs the dedup ledger and fans out a
  notification. `titleFor`/`bodyFor` already cover the kind.
- On an **emit** decision for `agent.awaiting_input`, additionally call
  `broadcastMetadataUpdate(win, { ptyId, agentStatus: 'awaiting_input' })` so the
  sidebar dot turns yellow (the hook path sends notifications but, unlike the
  detector path in `DaemonNotificationRouter`, does not currently touch
  `agentStatus`). Import `broadcastMetadataUpdate` from the metadata handler.

## Data flow & dedup

`agent.awaiting_input` is an emit-kind, so it flows through `HookSignalRouter`
exactly like `agent.stop`: if the regex detector *also* fired for the same
(agent, pty, kind) within 10 s, the hook is deduped (no double toast) but latency
is still recorded. For AskUserQuestion the detector never matches, so the hook is
the sole emitter — which is the whole point.

## Error handling

- Bridge: unchanged fail-open posture — any error logs to `~/.wmux/bridge.log`
  and exits 0, never slowing or breaking Claude. The `tool_name` guard simply
  drops non-matching PreToolUse calls.
- RPC: a malformed or unmatched-cwd signal returns the existing
  `invalid-envelope` / `no-workspace-match` reasons; no behavior change for other
  kinds.

## Testing

- **`integrations/shared/__tests__/signal-types.test.ts`:** `isAgentSignal`
  accepts a well-formed `agent.awaiting_input` envelope (currently it would
  reject it), and still rejects unknown kinds.
- **`src/main/pipe/handlers/__tests__/hooks.rpc.*` (extend or add):** a
  `hooks.signal` with `kind: 'agent.awaiting_input'` resolved to a known pty
  produces (a) a `sendNotification` call and (b) a `broadcastMetadataUpdate` with
  `agentStatus: 'awaiting_input'`. Reuse the existing handler-test harness/mocks
  if present; otherwise assert via the injected `getWindow`/sendNotification
  seam.
- **Bridge mapping:** the `.mjs` is a self-contained script (hard to unit-test in
  the vitest TS suite). Cover the mapping decision by asserting `HOOK_TO_KIND`
  semantics indirectly through the signal-types + rpc tests; manual smoke
  verifies the end-to-end.

## Manual verification (end to end)

With the wmux Claude plugin installed (the user already gets `Stop`
notifications, so the bridge is live): run Claude Code in a wmux pane, trigger a
`/`-flow or any turn that calls AskUserQuestion. Expect: the pane's sidebar dot
turns **yellow** and the notification **sound** plays the moment the question
appears; answering it clears the dot as the agent resumes.

## Dependency note

This works only when the Claude Code hook bridge is installed/active (wmux's
plugin). That is already true for any user who gets wmux notifications when Claude
finishes a turn. No new install step is introduced.
