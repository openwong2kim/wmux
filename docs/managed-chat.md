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

File undo and live terminal takeover are unavailable. File previews are bounded
excerpts, not a complete review system. Attachments/model selection, an archived
session picker, and a managed Claude SDK adapter are not implemented. Provider
permissions and native sandboxes remain provider-specific; ACP is not a sandbox.
The mobile HTTP bridge is a separate change. Windows process launching is
implemented but still needs live agent qualification on Windows hardware.

On the PR branch based on main `0d7f2b64`, real desktop checks passed for both
Codex and OpenCode: create, composer send, response rendering, confirmed
completion, and terminal/chat switching. Both providers also passed requested
cancellation and forced provider-process death: the composer becomes disabled,
the outcome is unconfirmed, and reconnect restores the same native session and
history without resending the request. OpenCode's native `MessageAbortedError`
is accepted only after an explicit cancellation request; an unsolicited abort
remains a failure. Regression tests cover that distinction.

Earlier live checks also covered an OpenCode one-time file-write approval, file
preview, and daemon restart/history recovery. Codex CLI 0.156.1, OpenCode 1.18.30,
and OpenCode through ACP passed native prompt/resume probes. The previously seen
OpenCode home-directory delay did not reproduce in the latest native probe
(about 3.9 seconds including resume) or the latest home-directory desktop check;
its original cause remains unknown.

Root type checking, daemon build, and production dependency license checks pass.
Third-party notices are generated. See the PR test plan for the latest complete
suite and CI results; automated Windows CI is distinct from live Windows agent
qualification.

## Repeating live checks

These opt-in scripts consume the configured provider's tokens. Use a disposable
profile and test workspace, never an existing user conversation.

- `scripts/chat-agent-probe.ts`: bundle with esbuild and choose `codex`,
  `opencode`, or `acp-opencode`. `--prompt --resume` sends one small request and
  verifies history restoration. `--home` explicitly diagnoses home-directory
  behavior; tool requests remain denied and cleanup only removes the separately
  allocated temporary directory.
- `scripts/managed-chat-live-e2e.mjs`: real desktop send/response/view-switch
  checks against an explicitly supplied development app and temporary workspace.
- `scripts/managed-chat-fault-probe.mjs`: real cancellation and process-death
  checks. It verifies the temporary workspace and isolated daemon socket, and
  refuses to kill a process unless it is the sole matching provider descendant
  of that daemon. Currently POSIX only.

The desktop probes currently expect the English UI with experimental Chat view
enabled. Their file headers document the required environment variables.
