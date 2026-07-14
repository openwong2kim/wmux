# wmux ↔ OpenCode bridge

Lets the wmux **orchestrator** (Command Deck) know when an OpenCode agent
finishes a turn.

## Why

The orchestrator wakes on `agent.stop` lifecycle events. Claude Code emits them
through its hook plugin and Codex through its `notify` bridge. OpenCode had no
bridge, so its turn completions reached wmux through **none** of the three
detection paths:

- **hook** — no OpenCode bridge existed;
- **detector** — OpenCode's full-screen TUI never matches the placeholder
  `opencode>` prompt regex in `AgentDetector`;
- **osc133** — that marker means "a shell command ended", not "a TUI agent
  finished its turn" (a long-running `opencode` process never returns to the
  shell prompt between turns).

Result: an orchestrator that handed work to an OpenCode pane never learned when
it was done. This plugin closes the gap on the deterministic **hook** path via
OpenCode's `session.idle` event.

## Install

Copy the plugin into your OpenCode global plugin directory:

```
# macOS / Linux
cp integrations/opencode/plugins/wmux.js ~/.config/opencode/plugins/wmux.js

# Windows (PowerShell)
Copy-Item integrations\opencode\plugins\wmux.js "$env:USERPROFILE\.config\opencode\plugins\wmux.js"
```

(Or place it in a project's `.opencode/plugins/` for that project only.)
OpenCode auto-loads every `.js` / `.ts` file in those directories at startup.
Restart `opencode` after copying.

## Verify

1. Run `opencode` **inside a wmux pane** (so the `WMUX_PTY_ID` pane env is
   present for routing).
2. Give it a task and let a turn finish.
3. Check `~/.wmux/opencode-bridge.log` — you should see a `"loaded"` line at
   startup and an `"ok"` line each time a turn completes. `rpc-failed` /
   `no-auth-token` lines point at the problem (wmux not running, or the pane env
   not propagating).

## What it sends

On each `session.idle`, one canonical wmux `AgentSignal`:

```json
{ "kind": "agent.stop", "agent": "opencode", "ptyId": "<WMUX_PTY_ID>",
  "workspaceId": "<WMUX_WORKSPACE_ID>", "cwd": "<pane cwd>", "payload": {}, "ts": 0 }
```

sent over the same `hooks.signal` pipe RPC the Claude/Codex bridges use.
`hooks.rpc.ts` is agent-agnostic, so no wmux-side change is needed. Routing
prefers `ptyId` (exact per-pane) → `workspaceId` → `cwd`.

## Scope

This bridge covers **turn completion** (`agent.stop`) — the reported gap.
Approval-prompt detection (`agent.awaiting_input`) is a follow-up: it needs the
exact shape of OpenCode's permission events, which should be captured against a
live session before wiring it, so a wrong signal never makes the orchestrator
think a pane is waiting for a y/N it is not.
