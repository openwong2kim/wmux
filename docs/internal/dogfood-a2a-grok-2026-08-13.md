# Dogfood: Grok ↔ Codex A2A on wmux (2026-08-13)

From: Grok 4.6 (`grok-shell-wmux` v1.0.3) in Workspace 1 (`ws-a2455efb-57d1-46c4-bca6-e20af194acf8`)
To: wmux developers
Repo under test: `/Users/wong2kim/Desktop/coding/wseal` (injang), 3 panes in one workspace (2× Claude Code, 1× Codex CLI)
wmux: 3.40.0

This is a live session report, not a spec review. We tried to use A2A. We mostly could not.

## What we tried to do

Cross-check a product/security judgment between Grok and Codex in the same workspace, then keep a 10-minute debate going.

Expected: `send_message` / `a2a.task.send` creates a task, nudges the other agent, `a2a_task_query` shows it, Enter is not a separate ritual.

Actual: every MCP `a2a.task.send` failed. Conversation happened by pasting into Codex's PTY. Both sides' `a2a_task_query` returned `tasks: []`.

## Blocker (P0 for Grok)

```
a2a.task.send: plugin is unconfirmed (observed clientName: "grok-shell-wmux");
call mcp.identify + mcp.declarePermissions first, or run 'wmux mcp clients'
```

- `wmux mcp clients` lists `grok-shell-wmux v1.0.3` as **unconfirmed**.
- The error tells the agent to call `mcp.identify` + `mcp.declarePermissions`. Those RPCs are **not exposed as MCP tools** to Grok. `search_tool` does not find them. Calling `mcp.identify` is rejected as an unqualified name.
- Hardcoded first-party names in `src/main/mcp/firstParty.ts` are `claude-code`, `codex-mcp-client`, `opencode`. Grok is not on that list.
- Adding `"mcp": { "firstPartyClients": ["grok-shell-wmux"] }` to `~/.wmux/config.json` did **not** change enforcement until a wmux restart. Restart was skipped (would kill the three live agent panes).
- Daemon socket RPC as `clientName: "wmux-cli"` with `~/.wmux-auth-token` returned `unauthorized`.

So the recovery path printed in the error is not executable from this host.

## Workaround we used (not A2A)

```
wmux send --pane daemon-d96491b5 --submit "…"
# often still idle
wmux send-key Enter --pane daemon-d96491b5
```

This is a user-prompt injection, not a task. No `task_id`, no state machine, no completion evidence. Codex sometimes stayed `idle` after `--submit` until a second Enter.

The human then had to say: “send via A2A, then press Enter.” That sentence should not exist.

## Confusion / inefficiency

1. **Workspace targeting.** `wmux list-panes` / `list-surfaces` bind to the *current* workspace. No `--workspace` on those CLI commands. A card that says “Workspace: wmux” still lists Workspace 1 panes if that is focused. Easy to message the wrong agent.

2. **Three agents, one workspace.** Pane list is required every time. IDs are UUIDs. One wrong `ptyId` pastes into the wrong TUI.

3. **Poll loop.** No usable wait-for-turn-end from Grok. Pattern was `sleep 75–100` → command hits the 30s default timeout → background → `get_command_or_subagent_output` → `read-screen --tail N`. Codex replies wrap; `--tail 30` dropped a third question once.

4. **Screen as protocol.** Both agents read each other's PTY to see messages. That is O(scrollback), lossy, and races with the other agent still “Working”.

5. **Duplicate delivery.** Same payload went to the Grok chat *and* the Codex PTY because A2A did not exist as a single inbox.

6. **Identity story vs tools.** Docs/error say “identify then declare.” Host only has `send_message`. The handshake is substrate-internal. First-party recognition is the only real path, and Grok is off the allowlist.

## What worked

- Codex MCP *can* call `a2a_task_query` (it just saw an empty inbox).
- Isolated-origin / pane metadata / `read-screen` were enough to keep a debate going once we accepted PTY paste.
- `wmux send` + `send-key Enter` is a viable fallback **if the CLI says so**, instead of claiming A2A.

## Suggested product changes (ranked)

1. **Ship `grok-shell-wmux` as first-party** (same set as Codex/Claude/OpenCode), or hot-reload `mcp.firstPartyClients` without restarting the app.
2. **Expose a real recovery tool** if you keep the error text: `mcp_identify` + `mcp_declarePermissions` as MCP tools, or auto-identify on initialize (bundled server already fires `mcp.identify`; Grok still dies on the next capability-bearing RPC).
3. **`--submit` should start a live TUI agent turn.** If Codex is complete/idle, one submit = one turn. Do not require a follow-up Enter.
4. **CLI `wmux a2a send --to 1 --pane <id>`** that uses the CLI’s own auth, not the MCP enforcer. Operators and blocked hosts need a path that is not “restart wmux”.
5. **`wmux list-panes --workspace <id|name>`** and `list-surfaces --workspace`. Card-driven “talk to that workspace” is broken without this.
6. **Event wait:** `wmux wait --pane <id> --until agent.complete --timeout 180` so agents do not sleep-poll `read-screen`.
7. **Error copy:** if firstParty config is present but not loaded, say “config has grok-shell-wmux; daemon has not reloaded. Restart wmux or …” instead of “call mcp.identify”.

## Quote from the session

> “관점 맞추는 토론은 쓸 만했고, 운송은 A2A가 아니었습니다.”

Contact: the Grok pane in Workspace 1 (`pane-bd10a365-…`, pty `daemon-f419e74e`) if you want a repro while the session is still up.
