# Managed multi-agent chat

wmux owns the chat session lifecycle in the daemon. Renderer components consume
wmux events and capabilities rather than SDK-specific objects. Codex uses its
native app-server protocol, OpenCode its official HTTP/SSE SDK, and other agents
can use the official ACP SDK. ACP is an optional adapter, not the common data model.
No competitor implementation code was used.

## Using it

Enable the experimental chat view in Settings, then open Chat on a terminal pane without an attached Claude transcript, select Codex
or OpenCode, and choose **Start new chat**. Install and authenticate the agent CLI
first. The new chat uses the pane's original working directory. It is a separate
session; it does not take over the program running in the terminal.

The chat supports streaming, collapsed activity, provider-supplied file change
previews, permission/questions where supported, stop, reconnect, and close.
Closing archives the wmux record; it does not delete native agent history.
Existing Claude transcript chat remains available.

## Adding ACP agents

Create `chat-providers.json` in the active wmux data directory (normally
`~/.wmux`, with the application's development/profile suffix if configured):

```json
{
  "version": 1,
  "providers": [
    {
      "id": "opencode-acp",
      "name": "OpenCode (ACP)",
      "transport": "acp",
      "command": "/absolute/path/to/opencode",
      "args": ["acp"]
    }
  ]
}
```

Restart the daemon after changes. Commands must be absolute paths. The renderer
cannot submit arbitrary executables; repository files and agent output cannot
register providers. The user is responsible for installing/authenticating the
configured agent. Grok or another future agent requires a supported native
adapter or ACP implementation; a model name alone does not provide tool execution,
approvals, or session resume.

## Delivery and recovery

The daemon atomically persists send intent before dispatch. Request IDs are
idempotent within the session. A lost connection produces an unconfirmed state;
reconnect restores provider history and never automatically resends the prompt.
Permissions are tied to the current native session/connection and running turn.
Closing a view does not stop the agent. Explicit stop requests cancellation and
waits for a confirmed turn boundary; an unresponsive provider is disconnected.

Records live under `chat-sessions/` with restrictive file permissions. History is
bounded to 2,000 events / 4 MiB; individual display bodies are truncated. Retention
and reconnect change the history generation so stale pagination is discarded.
OpenCode runs on authenticated loopback with random per-process credentials.
ACP clients currently do not expose filesystem or terminal client methods.

## Current limits and validation

File undo and live terminal takeover are deliberately unavailable. File previews
are bounded excerpts, not a complete review system. Attachments/model selection,
an archived-session picker, and a managed Claude SDK adapter are not implemented.
Provider permissions and native sandboxes remain provider-specific; ACP itself
is not a sandbox. Windows process launching is implemented but has not been
verified live in this macOS session.

Real macOS smoke probes passed prompt completion and same-session history restore
with Codex CLI 0.156.1, OpenCode 1.18.30, and OpenCode through ACP. Unit/integration
checks cover durable intents, duplicates, stale identities/approvals, disconnects,
retention, and legacy transcript behavior. Desktop end-to-end checks passed for Codex and OpenCode: create, send, render,
completion, and terminal/chat switching. OpenCode also passed a real one-time
file-write approval, file preview, and daemon-restart/history-reconnect check.
235 related tests, root type checking, and daemon build passed; scoped lint has
no errors (33 warnings). Live cancellation fault coverage and cross-platform
qualification remain necessary before calling this release production-qualified.
An OpenCode turn in the home directory exceeded the desktop check timeout;
cancellation transitioned to unconfirmed rather than claiming success. The same
UI flow passed in the isolated temporary workspace; the home-directory delay
has not been diagnosed.

The opt-in `scripts/chat-agent-probe.ts` creates a temporary working directory and
new native session. Bundle it with esbuild, then run with `codex`, `opencode`, or
`acp-opencode`; `--prompt --resume` sends one small real request and verifies
history restoration. It consumes the configured provider's tokens.

`scripts/managed-chat-live-e2e.mjs` repeats the real desktop send/response/view-switch
check against an explicitly supplied disposable development app and temporary
workspace. It currently expects the English UI.

On the PR branch rebased onto main at `0d7f2b64`, all 244 focused tests, root
type checking, and the daemon build pass. Scoped lint has 0 errors / 36 warnings;
production dependency license checks pass and notices are regenerated. Live desktop checks above were run
before that rebase; existing main fixes and the default-off chat flag are retained.
