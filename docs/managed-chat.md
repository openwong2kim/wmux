# Terminal chat, chat v2 and optional managed sessions

wmux has two chat views. Terminal chat projects the conversation already
running in the pane's terminal: viewing it never spawns an agent or sends a
prompt, and Claude, Codex and OpenCode feed the same wmux `TurnEvent` model.
Chat v2 (below) is a conversation the daemon runs itself through the agent's
structured protocol, bound to the pane with exactly one writer at a time. ACP
is an optional transport for separately managed sessions; it does not
establish ownership of an existing TUI.

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

## Start from Chat

An empty pane uses the same bottom composer as an active conversation. Choose
Claude or Codex and the run mode inside the composer, then send the first message.
The private launch RPC starts the installed CLI in that same PTY and includes the
first message as a literal argument, so native conversation discovery can connect
Chat without requiring an initial terminal prompt. No managed session is created.
Existing readable conversations are retained and do not offer replacement launch.

Launch currently supports zsh/bash/sh with OSC 133 shell integration and a
positively empty prompt. Draft input, foreground/background child processes,
pending approvals, unknown shell state, Windows and other shells are refused.
The initial message supports newlines and at most 2,000 characters; subsequent chat messages
retain the regular multiline composer. Login/trust onboarding remains in Terminal.
No automatic launch retry occurs after a failed or uncertain response.

Codex launch uses its native account server;
wmux observes the TUI connection through its existing private relay to obtain the
actual conversation ID (hook invocation IDs are not sufficient). If that server
is not running, the explicit launch action calls the official idempotent
`codex app-server daemon start` command before connecting the TUI. This starts
only the native runtime, not another conversation, and never restarts an existing
server or enables remote control. Failure stops before typing into the shell.

### Codex typed in a pane shell

A `codex` typed in a bash or zsh pane (by a person, or by a fan-out worker's
launch line) goes through a small shell function from the pane's shell
integration. When the installed Codex knows the `daemon_auto_start` feature,
every call gets `-c features.daemon_auto_start=false`, so even a command line the
function misreads cannot start the shared account server from that pane.
Interactive forms (no subcommand, a prompt, `resume`, `fork`, anything with
`-i/--image`) also get `--no-daemon`, so the thread runs in that process with
that pane's identity. `codex exec` and `codex review` already run in-process and
keep the pane's identity, so their hooks still reach the pane. A line that
mentions `app-server`, `exec-server`, `remote-control` or `daemon` anywhere, any
other subcommand, and a line with an option the function does not know on a
Codex without the feature guard all run with every `WMUX_*` variable removed.
What the installed Codex supports is checked once per binary.

A line that already picks a server (`--remote`, `--no-daemon`) and a
user-defined `codex` function are left alone. `WMUX_CODEX_WRAP=0` turns the
function off, and `WMUX_SHELL_INTEGRATION=0` turns it off with the rest of the
integration.

The function is not reached by scripts, `bash -c`/`zsh -c` lines, `env codex`,
`exec codex`, a full path to the binary, an alias for `codex` that runs
something other than `codex` (aliases take precedence over functions), a shell
started inside the pane (a nested zsh or bash, tmux, screen), Git Bash, fish or
PowerShell, or shells opened before the integration update; those still start
the shared server with whatever environment they have.

Validation probe: `scripts/terminal-chat-launch-live-e2e.mjs` starts from an empty
selected test pane and verifies the initial native answer, one user turn, and
Terminal/Chat round-trip without a managed conversation. Native Codex transport
accepts bounded 16 MiB metadata frames (Chat history keeps its smaller limits),
and excludes ephemeral `thread_title` sessions from foreground selection.

The default run mode adds no permission flags. Explicit Claude Bypass mode adds
`--dangerously-skip-permissions`; explicit Codex YOLO mode adds
`--dangerously-bypass-approvals-and-sandbox`. These are native startup options, not
changes to an already running agent. Switching provider resets the mode to default.
Only the matching agent/mode combinations are accepted by IPC and the daemon.


### Composer skill discovery

The same bottom composer opens an installed-skill list with `/` (Codex also accepts
`$`), or its `/` button. Search matches names and descriptions. Arrow keys navigate;
Enter/Tab inserts, Escape dismisses without discarding the draft, and IME Enter
is left to composition. Insertion never sends a turn. Existing arguments remain.
Claude inserts `/name`; Codex inserts `$name`. Provider changes cancel stale reads.
The list shows source labels, bounded descriptions, loading, empty, unavailable
and partial states. It does not create a terminal, session or agent process.

Private `chat:skills` → `daemon.chat.skills` takes `{id, agent}`. The daemon derives
cwd and account configuration from the owned live pane, rechecks scope after I/O,
and rejects WSL panes. The renderer cannot supply paths or methods. Returned
metadata contains only name, description, invocation and source; no bodies or
paths. Reads are bounded and coalesced with a five-second cache.

Codex uses the existing native account server's read-only `skills/list`, scoped to
the selected native thread cwd when known, and excludes disabled skills. It does
not start the account server just to populate a menu: before that runtime exists,
the list reports unavailable and can be retried after native launch.
Claude scans personal/project skills, command files and enabled installed plugins,
respects personal-name precedence, `user-invocable: false`, local visibility
settings and plugin namespaces. This disk inventory is explicitly partial:
session-only CLI settings, enterprise policy, synced skills and custom plugin
paths may differ from the native menu. Built-in interactive terminal commands
are not fabricated as chat actions. OpenCode/managed skill discovery is not yet
advertised. Adding another provider requires its own catalogue adapter.


### Native commands and rolling app updates

`/` lists command actions alongside skills; `$` lists only skills. The curated
command entries state their destination. For a live Codex session, `/model` opens
an in-chat model/effort dialog using the native runtime catalogue and current
thread settings. Apply is explicit, revision-bound and confirmed by a fresh
runtime read. Busy/stale/uncertain outcomes do not trigger automatic mutations.
Other native interactive commands (permissions, fast mode, IDE/keymap/Vim,
experimental features and approval review) switch to the existing Terminal view;
they are not auto-executed or injected into its potentially occupied composer.
This is not a claim of complete native command UI parity. Selecting an action
consumes only its query token and retains any remaining draft. The send button is
disabled while the discovery menu is open.

A renderer-only hot update can expose a newer preload method while the main
process still lacks its IPC handler. The UI distinguishes that condition from an
empty skill list. Reopening the app refreshes main/preload without killing the
existing daemon or terminal. If that daemon specifically answers `Unknown method:
daemon.chat.skills`, the trusted desktop uses a read-only compatibility adapter:
existing list/status/agent RPCs establish pane incarnation, PID, account, live
agent and native session; `thread/read` supplies the selected Codex cwd; ownership
is checked again after discovery. No fallback occurs on authorization/transport
errors. `chat:settings` uses the same scoped desktop adapter with the native
model-settings allowlist. It never exposes an arbitrary RPC method or path.
Neither desktop method introduces a phone HTTP route.

### Returning to a conversation

The renderer overlaps subscription registration with the initial snapshot read,
while buffering append events until both finish. Hovering or focusing Chat warms
the UI module. A bounded memory-only cache (eight panes, at most 1,000 events and
512 Ki characters per entry) can show previous history after fresh status confirms
the same native session, transcript basename, size and modification time. Changed
files and replacement conversations do not reuse that preview. Sending remains
blocked until the fresh snapshot and subscription are ready; cached history never
authorizes input. Providers without a file fingerprint skip this cache.

## Chat v2: driver-owned conversations

Chat v2 runs the agent through its structured protocol instead of projecting a
terminal. The daemon starts the agent process (a *driver*), streams its replies,
tool calls, subagent work, approvals and questions, and keeps the folded
conversation. The wire contract and its rules are in `src/shared/chatv2/ipc.ts`
(limits in `limits.ts`); the daemon side is `src/daemon/chat/v2/`. The daemon
runs Claude Code this way and a paired phone can read and approve; the desktop
view that starts and shows these conversations comes later. Parts of the event model and fold are adapted from
MIT-licensed code; each such file names its source in a header, and the license
is in `THIRD_PARTY_NOTICES`.

### Ownership

- A chat-v2 conversation belongs to one pane. The pane keeps its shell PTY as the
  anchor (`Surface.ptyId`, hooks, Fleet, identity); the driver is a daemon record
  keyed by that pane id. There is no surface without a PTY.
- One writer per pane. A driver starts (and restarts) only when no agent process
  is tracked in the pane and its shell is idle with no child processes;
  otherwise `agent-running-in-pane`.
- The only handoff is chat → terminal: the daemon stops the driver, proves its
  process exited, records the conversation as handed off, and types
  `cd -- '<cwd>' && claude --resume <id>` (with the chat's model and permission
  mode) into the anchor shell. It needs an idle turn and a shell sitting at an
  empty prompt, and is not offered on Windows or WSL panes. A handed-off
  record no longer sends.
  Terminal → chat is not offered: without proof that the TUI process has exited,
  both could append to the same conversation file.

### Events, snapshots and seq

- Drivers emit `HarnessEvent`s. The daemon stamps each with a per-session `seq`
  that never restarts and a time, folds it with `src/shared/chatv2/apply.ts`, and
  persists the folded session atomically under `chat-sessions/v2/`.
- The fold is a pure function of the session and the stamped events: block ids
  are `<seq>.<n>`, turn times come from the stamp, deltas always append, and
  approvals attach to tool calls by call id only. The daemon and every renderer
  that folds the same events reach the same blocks, however the events are
  batched.
- Each load of a record gets a new random epoch. Renderers subscribe, then load a
  snapshot (head plus a tail window starting at the open turn when it fits), and
  fold the pushed events with the same `apply.ts`. A renderer re-snapshots on an
  epoch change, a seq gap, a change below its window, a fold that does not match
  the push, and after the app reconnects to the daemon.
- Deltas are batched every 120 ms; approvals, questions, errors and turn ends
  flush at once. One push stays under 128 KiB. Block text, tool detail and tool
  output are capped in bytes; the cut part stays readable through `bodies`.

### Approvals

Driver permission requests and questions are ApprovalRegistry native decisions
(`adapter: 'claude'`). The desktop answers by request id through
`daemon.chatv2.answer`; a phone answers through `/api/approvals/:id/answer`. The
first answer wins and the driver writes exactly one reply per request. A request
the registry cannot record, or one made while native decisions are switched off,
is denied at once. Permission replies are allow or deny; question answers use the
form's option keys.

### Environment and accounts

The driver env is built like a scheduled run's: agent-nesting markers removed,
the pane's account directory applied, then `WMUX_PTY_ID` set to the anchor pane
and `WMUX_GATE=0` so the PreToolUse gate does not show a second card for the same
request. Provider settings exported only in your shell profile (for example
`CLAUDE_CODE_USE_BEDROCK` or `ANTHROPIC_BASE_URL`) are not inherited; put them in
the `env` block of the agent's `settings.json` instead. Images are copied into a
staging folder in the wmux data directory before they are sent.

### Restore

Records survive app and daemon restarts. After a daemon restart a record has no
process; the next message restarts the driver with the agent's resume option.
Nothing is resent automatically. On start the daemon stops a driver left from a
previous run only when its process id, start time and command line all match the
record, and expires its pending approvals.

### Phone

A phone sees a chat-v2 conversation on `/turns` as `binding: 'managed'` with
`historyEpoch` `c2:<chatSessionId>:<epoch>`: it can read and approve. Sending
from the phone stays `409 managed-read-only` until a new capability is agreed.
