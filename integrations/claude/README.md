# wmux-claude-integration

A Claude Code plugin that turns wmux's heuristic agent detector into a
deterministic notification source. When installed, every `Stop`,
`SubagentStop`, `SessionStart`, and (optionally) `PostToolUse` event from
Claude Code is delivered to wmux via its native auth-protected named pipe,
deduplicated against the legacy regex detector, and fanned out to wmux's
toast / sound / ring / taskbar-flash channels with sub-200ms latency.

## Why

Pre-plugin, wmux watched terminal output with regex and a 5-second
idle fallback. That works most of the time, but it misses real
turn-ends and fires false positives when streams stall mid-tool-call.
Claude Code itself knows the truth, and exposes it through hooks.

This plugin is the bridge: hook fires → bridge reads stdin and
`~/.wmux-auth-token` → talks to wmux's main pipe → notification fans out.

## Install

Run inside Claude Code:

```
/plugin marketplace add iamwongeeeee/wmux
/plugin install wmux-claude-integration
```

After install, restart your Claude Code session for the hooks to take
effect. wmux must be running to receive signals; if it isn't, the
bridge logs the miss to `~/.wmux/bridge.log` and exits 0 so Claude is
not slowed down.

## Architecture

```
Claude Code event (Stop / PostToolUse / ...)
   │
   ▼
hooks/hooks.json registers:
   node ${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs <HookName>
   │
   ▼
bin/wmux-bridge.mjs (self-contained, no TS imports)
   │ 1. Reads hook payload from stdin
   │ 2. Reads ~/.wmux-auth-token
   │ 3. Connects to \\.\pipe\wmux-{user}  (Windows)
   │                  or ~/.wmux.sock     (Unix)
   │ 4. Sends RPC: hooks.signal { kind, agent: "claude", cwd, ts, payload }
   ▼
wmux PipeServer → RpcRouter → hooks.rpc handler
   │ resolves cwd → workspaceId/ptyId via workspace.list
   │ HookSignalRouter dedup against AgentDetector (10s window)
   ▼
sendNotification → renderer → toast / sound / ring / taskbar flash
```

## Files

- `.claude-plugin/plugin.json` — plugin manifest
- `hooks/hooks.json` — hook registrations (4 entries)
- `bin/wmux-bridge.mjs` — bridge executor (self-contained Node script)
- `marketplace.json` — marketplace listing
- `README.md` — this file

## Privacy and security

- The bridge reads ONLY `~/.wmux-auth-token` (mode 0600, owned by you)
  and the stdin hook payload Claude Code sent it.
- Bridge writes a one-line JSON record per fire to `~/.wmux/bridge.log`
  (timestamp, hook name, outcome). No payload contents are logged.
- Nothing leaves your machine. The bridge talks only to wmux's local
  named pipe.
- If wmux is not running, the bridge exits without ever opening a
  socket connection.

## Troubleshooting

- **No notifications:** check `~/.wmux/bridge.log` — every fire is
  logged. If you see `"outcome":"no-auth-token"`, wmux isn't running
  (or hasn't written the token file yet). If you see
  `"outcome":"connect-error"`, the pipe path can't be reached —
  ensure wmux is the current user's instance.
- **Hook fires but no notification in wmux:** open Settings →
  Notifications and check "Plugin signal health". If P50 latency is
  reasonable, you're seeing a deduplication win against the legacy
  detector, which is fine.

## Uninstall

```
/plugin uninstall wmux-claude-integration
```

wmux falls back to its built-in regex detector immediately. No wmux
restart needed.
