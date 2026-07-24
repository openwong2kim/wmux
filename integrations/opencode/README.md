# Forge Mux ↔ OpenCode bridge

Lets the Forge Mux **orchestrator** (Command Deck) know when an OpenCode agent
finishes a turn.

## Why

The orchestrator wakes on `agent.stop` lifecycle events. Claude Code emits them
through its hook plugin and Codex through its `notify` bridge. OpenCode had no
bridge, so its turn completions reached Forge Mux through **none** of the three
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

1. Run `opencode` **inside a Forge Mux pane** (so the `WMUX_PTY_ID` pane env is
   present for routing).
2. Give it a task and let a turn finish.
3. Check `~/.fmux/opencode-bridge.log` — you should see a `"loaded"` line at
   startup and an `"ok"` line each time a turn completes. `rpc-failed` /
   `no-auth-token` lines point at the problem (Forge Mux not running, or the pane env
   not propagating).

## What it sends

Two canonical Forge Mux `AgentSignal`s, over the same `hooks.signal` pipe RPC the
Claude/Codex bridges use (`hooks.rpc.ts` is agent-agnostic, so no Forge Mux-side
change is needed). Routing prefers `ptyId` (exact per-pane) → `workspaceId` → `cwd`.

- On **`session.idle`** (a turn finished) → `agent.stop`:

  ```json
  { "kind": "agent.stop", "agent": "opencode", "ptyId": "<WMUX_PTY_ID>",
    "workspaceId": "<WMUX_WORKSPACE_ID>", "cwd": "<pane cwd>", "payload": {}, "ts": 0 }
  ```

- On **`permission.updated`** (OpenCode is asking to run something) → `agent.awaiting_input`,
  with the approval `title` in `payload`. Debounced by `PERMISSION_SETTLE_MS`
  (500 ms): a `permission.replied` arriving first — the case under
  `"permission": "allow"`, where approvals auto-resolve in milliseconds —
  cancels it, so an auto-approved permission never raises a false "waiting"
  signal.

**Sub-agent suppression:** both signals fire only for the **root** session. The
plugin looks up the session via the SDK `client` and drops anything with a
`parentID` (a sub-agent session), so the orchestrator wakes on the top-level
turn, not every internal sub-turn (mirrors opencode-notify's
`notifyChildSessions=false`). If the lookup can't run (no client / offline) it
fails open and treats the session as root, so a real completion is never lost.
