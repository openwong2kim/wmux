# wmux-claude-integration

A Claude Code plugin that turns Forge Mux's heuristic agent detector into a
deterministic notification source. When installed, every `Stop`,
`SubagentStop`, `SessionStart`, and (optionally) `PostToolUse` event from
Claude Code is delivered to Forge Mux via its native auth-protected named pipe,
deduplicated against the legacy regex detector, and fanned out to Forge Mux's
toast / sound / ring / taskbar-flash channels with sub-200ms latency.

## Why

Pre-plugin, Forge Mux watched terminal output with regex and a 5-second
idle fallback. That works most of the time, but it misses real
turn-ends and fires false positives when streams stall mid-tool-call.
Claude Code itself knows the truth, and exposes it through hooks.

This plugin is the bridge: hook fires → bridge reads stdin and
`~/.fmux-auth-token` → talks to Forge Mux's main pipe → notification fans out.

## Install

### Option A — from GitHub (typical)

Run inside Claude Code:

```
/plugin marketplace add skflowne/fmux
/plugin install wmux-claude-integration@fmux
```

### Option B — from a local checkout (dev / dogfood before merge)

If you've cloned this repo and want to test the plugin against the
current branch without pushing to GitHub first:

```
/plugin marketplace add D:/wmux
/plugin install wmux-claude-integration@fmux
```

Substitute your local clone path. Claude Code reads
`.claude-plugin/marketplace.json` from that directory.

### Option C — `fmux setup-hooks` (no plugin)

If you'd rather not use the marketplace plugin at all, the fmux CLI can
install the same 4 hooks directly into your Claude Code user settings
(`~/.claude/settings.json`):

```
fmux setup-hooks            # install
fmux setup-hooks --status   # show install + bridge freshness
fmux setup-hooks --remove   # uninstall (leaves your other hooks intact)
```

This copies the bridge to a stable path (`~/.fmux/hooks/wmux-bridge.mjs`)
and references it from settings.json, so it survives app updates. Re-run
`fmux setup-hooks` after a Forge Mux update to refresh the copied bridge.

**Caveat — do not combine with the plugin.** If you install BOTH this
plugin (Option A/B) and the `setup-hooks` settings entries, each turn
fires the hook twice. Forge Mux dedups hook-vs-detector, but not
hook-vs-hook, so you'd get double signals. Pick one path.

### After either path

Restart your Claude Code session for the hooks to take effect. Forge Mux
must be running to receive signals; if it isn't, the bridge logs the
miss to `~/.fmux/bridge.log` and exits 0 so Claude is not slowed
down.

When you edit `bin/wmux-bridge.mjs` locally, run `/plugin reload` in
Claude Code (or restart the session) to pick up the change.

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
   │ 2. Reads ~/.fmux-auth-token
   │ 3. Connects to \\.\pipe\fmux-{user}  (Windows)
   │                  or ~/.fmux.sock     (Unix)
   │ 4. Sends RPC: hooks.signal { kind, agent: "claude", cwd, ts, payload }
   ▼
Forge Mux PipeServer → RpcRouter → hooks.rpc handler
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

- The bridge reads ONLY `~/.fmux-auth-token` (mode 0600, owned by you)
  and the stdin hook payload Claude Code sent it.
- Bridge writes a one-line JSON record per fire to `~/.fmux/bridge.log`
  (timestamp, hook name, outcome). No payload contents are logged.
- Nothing leaves your machine. The bridge talks only to Forge Mux's local
  named pipe.
- If Forge Mux is not running, the bridge exits without ever opening a
  socket connection.

## Phase 1 scope vs. Phase 1.5 (deferred)

This is the Phase 1 backbone. The list below is ordered as a
fallback ladder — if Phase 1.5 capacity runs short, items are cut
from the top, never from the bottom. The hard floor must ship before
Phase 2 starts.

### Fallback ladder (cut from top first)

1. **First cut — First-run onboarding banner** (`HookOnboardingBanner.tsx`).
   Users can still install via the README command. Banner is a
   discoverability nice-to-have.
2. **Second cut — Settings "Plugin signal health" card.** Data
   collection (SignalLatencyMeter + uiSlice fields) already ships
   in Phase 1. The IPC bridge from main → renderer and the card
   itself land in Phase 1.5. Fallback diagnostic: tail
   `~/.fmux/bridge.log` for per-fire outcomes.
3. **Third cut — TokenTracker `/cost` regex maintenance.** Hook
   path already covers token counts authoritatively for plugin
   users. The regex stays as a no-plugin fallback but does not
   need new patterns if Claude Code's `/cost` format changes.
4. **Hard floor — Bidirectional hook ↔ AgentDetector dedup wiring.**
   Phase 1 ships `HookSignalRouter` with the ledger + `recordDetector()`
   API, but `PTYBridge.onEvent` is not yet calling it. Result: a
   hook fire and a detector regex match within ~1s can both emit
   notifications. This must ship before Phase 2; otherwise the
   dedup story is dishonest. Files involved: `src/main/pty/PTYBridge.ts`
   constructor injection of the router, gate the `agentDetector.onEvent`
   `sendNotification` call through `recordDetector`. Helper
   `agentStatusToSignalKind` already exported in `AgentDetector.ts`.

### What capacity looks like

Phase 1.5 estimated: 8–12 hours/week × 2–3 weeks = 20–30 productive
hours. Phase 2 estimated: 8–12 h/w × 4–6 weeks = 40–60 hours. If
reality falls short of the estimate at any gate, cut from the
ladder above. Silent slipping is the worst failure mode — every
cut is recorded in this README and in `plans/wmux-claude-integration.md`.

If any of these matter for your dogfood case, file an issue on
`skflowne/fmux` and we'll prioritize Phase 1.5.

## Troubleshooting

- **No notifications:** check `~/.fmux/bridge.log` — every fire is
  logged. If you see `"outcome":"no-auth-token"`, Forge Mux isn't running
  (or hasn't written the token file yet). If you see
  `"outcome":"connect-error"`, the pipe path can't be reached —
  ensure Forge Mux is the current user's instance. If you see
  `"outcome":"rpc-rejected"` with `reason: "no-workspace-match"`,
  the hook fired in a cwd that doesn't belong to any Forge Mux workspace
  (run `cd` into a Forge Mux-tracked dir).
- **Two notifications per turn:** Phase 1.5 dedup wiring is not
  landed yet. The plugin notification and the legacy regex detector
  can both fire. Workaround: temporarily disable Forge Mux's heuristic
  notification in Settings → Notifications (or wait for Phase 1.5).

## Uninstall

```
/plugin uninstall wmux-claude-integration
```

Forge Mux falls back to its built-in regex detector immediately. No Forge Mux
restart needed.
