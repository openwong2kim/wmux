# Terminal chat and optional managed sessions

The default Chat view projects the conversation already running in the pane's
terminal. Switching Terminal ↔ Chat must not spawn an agent, create a native
session, resume a second execution owner, or send a prompt. Claude, Codex and
OpenCode feed the same wmux `TurnEvent` model. ACP is an optional transport for
separately managed sessions; it does not establish ownership of an existing TUI.
No competitor implementation code was used.

## Using terminal chat

Enable the experimental Chat view in Settings. Install/authenticate the agent
CLI, run `wmux setup-hooks`, and start or resume the agent in a terminal. Open
Chat to see that same conversation. Existing terminals may need restarting to
load a newly installed integration; native history remains with the agent.

- **Claude Code:** existing hook-bound JSONL projection and guarded PTY input.
- **Codex:** native rollout records are decoded using a separate adapter. Hooks
  or the daemon's owned TUI relay supply the exact thread identity. If a binding
  has an ID but no path, discovery searches for that exact UUID in the account's
  sessions directory, with bounded traversal. It never chooses the newest file
  or guesses a conversation from cwd. Chat input uses the same PTY and fresh
  process, session, draft, approval and input-revision checks. Codex hooks require
  native trust review. An empty/unknown composer layout refuses input. Rollout
  text appears when the CLI writes display records, rather than token-by-token.
- **OpenCode 1.18.30+ (1.x):** `wmux-chat-tui.mjs` runs inside the existing TUI.
  It reads the TUI's selected route, native messages, parts and approval state.
  Chat sends through that TUI's own SDK client to the selected session; native
  events update its terminal too. It does not launch `opencode serve`. Local
  composer drafts are left untouched. The plugin is registered in `tui.json`,
  separately from the server lifecycle plugin. JSONC/malformed configurations
  and user-owned assets are preserved; setup prints the plugin URL for manual
  addition when needed. Unverified API generations are not auto-registered.

The OpenCode plugin exposes only `read` and identity-bound `send` on an
unadvertised authenticated loopback endpoint. A mode-0600 descriptor is bound to
the pane's verified live native PID and incarnation. The daemon checks ownership
before and after I/O, validates response shapes and limits response bytes.
Renderer clients cannot supply a PID, port, token, path or arbitrary RPC method.
Changing the selected route changes the history epoch and rejects stale sends.
Disconnect disables input and preserves the last readable history. Requests are
never automatically resent; uncertain dispatch is reported as unconfirmed.

History projection and safe input are separate capabilities in
`TranscriptStatus.terminal`. Native permissions and cancellation remain in
Terminal for this iteration; file undo is unavailable. OpenCode display history
is bounded, with truncation disclosed. Its native history remains authoritative.

## Extending to another agent

A provider must establish the existing pane/process, selected native session,
account scope and connection generation. Then implement a bounded native history
reader and normalize messages, tools, changes and turn boundaries into wmux
events. Declare input/approval/cancel/undo capabilities independently; having a
model name or readable output is not proof that input is safe.

`src/daemon/transcript/providers.ts` is the file-provider seam, including each
provider's parser and path/identity guard. `TerminalChatService` is the TUI bridge
seam. A new provider must not inherit another provider's path rules or reuse a
cwd/latest-session heuristic. Grok and other agents can be added through their
native integration mechanisms when these ownership guarantees are available.
Unsupported capabilities stay disabled; opening Chat never substitutes a new
background conversation.

## Optional managed adapters

The daemon also retains explicit private lifecycle adapters for Codex app-server,
OpenCode HTTP/SSE and ACP. These create separate execution owners and are not the
default Terminal ↔ Chat path. The default UI no longer offers **Start new chat**
as a substitute for an unavailable terminal conversation. Previously created
managed records can still be viewed/closed when no native terminal conversation
is selected. Creation remains an explicit private RPC for future separate-mode
UI work, not a view-switch side effect.

Managed sends persist intent before dispatch; reconnect never resends an
uncertain prompt. Managed records live in `chat-sessions/` with restrictive
permissions and bounded retention. Custom ACP providers are configured by the
operator in the active wmux data directory's `chat-providers.json`, with absolute
executable paths. ACP currently exposes neither filesystem nor terminal client
methods. These adapters do not attach to an arbitrary running TUI.

## Validation and remaining scope

Real macOS checks passed for Codex 0.156.1 and OpenCode 1.18.30: existing terminal
history, Chat input, native reply, identical native session ID, exactly one user
turn, and the reply appearing in the original terminal after switching back.
The repeatable probe is `scripts/terminal-chat-live-e2e.mjs`; it requires an
explicit loopback CDP endpoint and disposable `wmux-chat-*` pane, with an existing
completed native turn. It consumes provider tokens. English UI and experimental
Chat view must be enabled.

Unit/runtime coverage includes path containment, malformed records, native-ID
discovery, lazy body fetch, process ownership, stale route epochs, duplicate
requests, uncertain dispatch, dialogs, and existing Claude regression checks.
Actual Windows native-agent execution is still unverified. The new terminal
bridge has not yet been exposed through the iOS HTTP chat routes. Phone routes
must keep existing device/operator permissions, workspace ownership and
transcript opt-in, and call the same native service instead of exposing its
loopback endpoint or arbitrary daemon RPCs.

The older managed smoke/fault scripts exercise only separate-session adapters;
their results are not evidence for same-terminal behavior. The old managed UI
creation probe is retained as a historical/optional-mode probe and requires a
separate explicit creation UI before it can run again.
