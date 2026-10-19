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
Restart `opencode` after copying. On OpenCode 2.x the shared background service
reloads a changed plugin file by itself; `opencode service restart` forces it.

The same file works on OpenCode **1.4 or newer** and on **2.x**: its default
export carries a 1.x `server` entry and a 2.x `setup` entry, and each runtime
reads its own. OpenCode before 1.4 cannot load an object default export.

## Verify

1. Run `opencode` **inside a wmux pane** (so the `WMUX_PTY_ID` pane env is
   present for routing).
2. Give it a task and let a turn finish.
3. Check `~/.wmux/opencode-bridge.log` — you should see a `"loaded"` line at
   startup and an `"ok"` line each time a turn completes. `rpc-failed` /
   `no-auth-token` lines point at the problem (wmux not running, or the pane env
   not propagating).

## What it sends

Two canonical wmux `AgentSignal`s, over the same `hooks.signal` pipe RPC the
Claude/Codex bridges use (`hooks.rpc.ts` is agent-agnostic, so no wmux-side
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

## OpenCode 2.x

OpenCode 2.x reports the same three moments under new names, and the plugin
maps them to the same signals:

| wmux signal | OpenCode 1.x event | OpenCode 2.x event |
|---|---|---|
| `agent.stop` | `session.idle` | `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted` (reason `user` or `inactivity` only) |
| `agent.awaiting_input` | `permission.asked`, `question.asked` | `permission.asked`, `form.created` |
| `agent.input_answered` | `permission.replied`, `question.replied` | `permission.replied`, `form.replied`, `form.cancelled` |

**Routing in a shared service.** By default every `opencode` 2.x on the machine
talks to one background service (`opencode serve --service`), started by
whichever client came first. The plugin runs inside that service, so its
`WMUX_PTY_ID` is the pane that started the service, not the pane whose session
finished. There the plugin sends no `ptyId` / `workspaceId` / `surfaceId` and
takes `cwd` from the session's own directory; wmux routes by that directory.
Two OpenCode panes in the same directory can therefore not be told apart. Run
`opencode --standalone` to get a private server in the pane: the plugin then
sends the pane id, as on 1.x. Every plugin instance in the service sees every
session's events, so each event is handled once per process.

**Sub-agent suppression:** both signals fire only for the **root** session. The
plugin looks up the session via the SDK `client` and drops anything with a
`parentID` (a sub-agent session), so the orchestrator wakes on the top-level
turn, not every internal sub-turn (mirrors opencode-notify's
`notifyChildSessions=false`). On OpenCode 1.x, if the lookup can't run (no
client / offline) the stop fails open and treats the session as root, so a real
completion is never lost. In OpenCode 2.x's shared service a failed lookup also
loses the session's directory, so the plugin drops that stop (logged as
`skip-no-session-cwd`) rather than hand it to a guessed pane. A permission or
question whose lookup failed raises nothing on either version.
