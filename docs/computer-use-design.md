# Computer use: design

Date: 2026-09-30. Status: accepted by the owner; implementation in progress.
Supersedes the earlier research-only plan of the same date.

Goal: let agents running in wmux see and drive other desktop apps
(accessibility tree, screenshots, mouse, keyboard) on **Windows first, then
macOS**, the way wmux already lets them drive a browser over CDP.

## Code-origin rule

Same rule as `docs/chat-view-oss-research-2026-09-24.md`: other projects are
referenced for behaviour, protocol shape and UX only. No source, tests or
assets are copied, translated or adapted. AGPL components are not even read
for design (trycua `som`, `cua-perception`).

## Shape

```
agent ──MCP──> wmux MCP server ──pipe RPC──> main: computer.rpc.ts
                  tool `computer`                 │  PermissionEnforcer + approvals
                                                  │  blocklist, input lock, abort
                                                  ▼
                                    ComputerService (src/main/computer)
                                                  │ NDJSON over stdio
                              ┌───────────────────┴──────────────────┐
                 native/computer-use-windows            native/computer-use-macos
                 C# NativeAOT exe (CsWin32 UIA,          Swift .app (AXUIElement,
                 SendInput, PrintWindow/BitBlt)          CGEvent, ScreenCaptureKit)
```

- **One OS switch.** `ComputerService` picks the helper binary once through
  `platformChoice` (`src/shared/platform.ts`). Everything above it is
  OS-agnostic; OS-specific facts reach the agent as shared error codes and
  the helper's `hello.capabilities`.
- **MCP is the primary surface.** Screenshots go back inline as MCP image
  content, the calling agent is identified by its MCP `clientName` and the
  pane it runs in (see Approvals), and the helper stays resident (no process
  spawn per action). Protocol overhead is a
  few milliseconds; the slowness seen in other Windows MCP servers comes from
  per-call interpreter start-up and uncached cross-process UIA walks, which
  this design avoids.
- **One MCP tool, `computer`, with an `action` enum.** Registered only when the
  user turns computer use on in settings, and only in the `full` profile.
- **CLI later, read-only.** The CLI cannot tell which agent is calling, so input
  injection stays MCP-only.

## Helper protocol (NDJSON over stdio)

stdio pipes belong to the parent alone, so no socket, token file or peer check
is needed.

- The helper's first line is
  `{"type":"hello","protocolVersion":1,"os":"win32","helperVersion":"…","capabilities":{…}}`.
  A request is replayed after a crash only if `hello` was never seen for it.
- Request: `{"id":7,"method":"getAppState","params":{…}}`.
- Response: `{"id":7,"ok":true,"result":{…}}` or
  `{"id":7,"ok":false,"error":{"code":"element_stale","message":"…"}}`.
  An `id` that matches no pending request means the stream is out of sync:
  kill the helper.
- Only one request is in flight at a time, because UIA and AX calls run on
  one STA / main thread anyway.
- Timeouts: 15 s for `getAppState`, 8 s for other calls. On timeout the
  helper is killed, not waited on, and its held modifiers are released
  (see Safety).
- Idle exit after 5 minutes. The helper also exits when stdin closes, so it
  never outlives wmux.
- The maximum line length is 24 MB (base64 screenshots). stderr keeps a 4 KB
  tail for crash reports.
- A `protocolVersion` mismatch triggers one restart, then `helper_incompatible`.

## Observation

`getAppState { app, window?, mode: "ax" | "vision" | "both" }`. `ax` does not
need screen-recording permission.

**Tree text.** Both helpers render it the same way. Golden fixtures in
`src/shared/computer/__fixtures__` pin the format, and each helper's tests
must reproduce them.

```
App: Notepad (pid 4812) · Window: "notes.txt - Notepad"
0 window notes.txt - Notepad
	1 menu bar
		2 menu item File
	3 document Text editor, Value: hello world
	4 button Close
Focused: 3
```

- One line per element, indented with tabs by depth:
  `<index> <role> <name>[, Value: …][, Description: …][, State: disabled|selected|expanded]`.
- Roles are humanised (`AXPopUpButton` → `pop up button`, UIA `Edit` → `edit`).
- Pruning:
  - Structural nodes with no name, value or actions are dropped, but their
    children are kept.
  - Only interactive control types and text are kept (the Windows whitelist
    follows the usual UIA interactive set).
  - Off-screen rows are skipped.
- Password fields render as `[redacted]`. Detection is IsPassword / AXSecure,
  plus a name match on password, passcode, PIN, one-time or verification code.
- Caps: `MAX_NODES` = 800, `MAX_DEPTH` = 40, and text previews of 120 chars.
  The result carries `truncated: true` when a cap is hit.

**Snapshot binding.** Every state gets a `snapshotId`. Indexes are valid only
with the `snapshotId` they came from. The helper keeps the last 16 snapshots
for 2 minutes.

**Staleness.** Before an indexed action, the helper re-resolves that one
element and compares its identity:

- Windows compares the UIA RuntimeId.
- macOS compares role, subrole, title, identifier and ancestry. Value is
  excluded, so a text field still matches after typing.

On a mismatch it returns `element_stale`. Clicks use the freshly resolved
frame, so a window that moved in the meantime does not cause a misclick.
Unlike some implementations, the whole tree is **not** re-walked before
every action; that is the main latency cost to avoid.

**Screenshot.**

- Window-only, JPEG (quality 80).
- `scale = min(1, 1280 / longEdge, sqrt(1.15e6 / (w·h)))`.
- The result reports `{width, height, scale, mime}`. That text block comes
  before the image block in the MCP result, which improves click accuracy.
- A screenshot failure does not fail the tree: `screenshotStatus` reports it
  separately.

**Coordinates.** The agent gives `x, y` in **screenshot pixels** of the
snapshot it names. Main divides by that snapshot's `scale` and sends window
logical points to the helper, which maps them to screen coordinates. The
Windows helper is per-monitor-v2 DPI aware and uses `MOUSEEVENTF_VIRTUALDESK`,
so multi-monitor setups work. Element indexes remain the primary way to
target; coordinates are the fallback.

**Diffs (v1.1).** Actions return a small result by default. The agent asks for
a fresh `getAppState` when it needs one. A tree diff against the previous
snapshot is the v1.1 token saver.

## Actions (v1)

`capabilities`, `listApps`, `listWindows`, `getAppState`, `click`, `setValue`,
`type`, `pressKey`, `hotkey`, `scroll`.

- **Action ladder.** Use the semantic action first (UIA Invoke / Toggle /
  Value / ExpandCollapse; AXPress / AXSetValue), then synthetic input.
- **`setValue` is in v1.** It bypasses the IME, so it is the right path for
  Korean and other composed text.
- **`type`.** Short text goes through `SendInput` with `KEYEVENTF_UNICODE`
  (Windows) or `CGEventKeyboardSetUnicodeString` (macOS). Text of 64 characters
  or more is pasted through the clipboard, and the previous clipboard is
  restored afterwards.
- **`click { modifiers }`.** Modifier-down, click and modifier-up go in one
  input batch, and the up events are sent even if the batch fails part-way.
  There is no separate `keyDown` action.
- **Focus.** Synthetic keyboard input requires the target window to be
  foreground; otherwise the action returns `window_not_focused`. Semantic
  actions skip that check.
- **Honest results.** Every action returns
  `{ method: "accessibility" | "synthetic" | "clipboard", verification: "verified" | "unverified", note? }`.
  `verified` means state was read back, for example the value after
  `setValue`. The tool description tells the agent never to report an
  unverified action as done.

## Errors

The error codes live in `src/shared/computer/errors.ts`. Each code carries
`nextSteps` that the MCP tool appends to the error text:

`app_not_found`, `app_blocked`, `window_not_found`, `window_not_focused`,
`element_not_found`, `element_stale`, `action_not_supported`,
`value_not_settable`, `snapshot_unknown`, `permission_missing`,
`target_elevated`, `input_busy`, `stop_key_unavailable`, `aborted`, `timeout`,
`screenshot_failed`, `helper_unavailable`, `helper_incompatible`,
`unsupported_platform`, `invalid_argument`, `internal`.

Errors are classified by stable identifiers (HRESULTs, AXError values), never
by localized message text.

## Safety

- **Off by default.** Turned on with `{ "enabled": true }` in
  `~/.wmux/computer-use.json`, a file only main writes. It is not a key in the
  daemon's `config.json`, because the daemon rewrites that file from the copy
  it loaded at boot and would drop or resurrect the switch. The MCP server
  reads it when it builds its tool list, so `computer` is absent for everyone
  else. Main re-reads it on every call. **Settings › Computer use** writes it. Its switch description says
  that screenshots and window text go to the agent's model provider. The tab
  also shows the helper status and the stop key, or that the key is unavailable. Turning the switch off also
  aborts whatever is in flight. Running agents see the tool appear or vanish
  only after they restart.
- **Window titles.** `listApps` and `listWindows` need no per-app consent, so
  blocked apps are marked, and their window titles are blanked.
- **Hard blocklist in main, not only in the helper.** It covers:
  - password managers;
  - wmux itself;
  - terminals and other agent hosts (driving them would bypass shell
    approvals);
  - on Windows, Credential UI / UAC consent.

  The helper reports the process path and bundle ID of each target; main
  refuses before it forwards the action.
- **Approvals.** Plugins need the `computer.observe` capability (list,
  inspect) and the `computer.control` capability (input), both granted through
  the existing enforcer, whose verdict on the `computer` risk class is binding
  even in shadow mode (like the commander gate). On top of that, every agent needs the person's consent
  per app, asked through the approval queue (`computer-app` prompt, both the
  modal and the Fleet inbox) and remembered for the run.
  - Consent, snapshot ownership, the input lock and the rate cap are per agent
    session, not per client name (every Claude Code pane reports the same
    name). The MCP server stamps the pane from its own PID-map walk (hit only,
    never the `WMUX_PTY_ID` env hint), and main resolves it to the workspace
    that owns it; an orchestrator brain is keyed on its commander workspace;
    a caller with no pane is keyed on a random id its MCP server process
    mints once. A pane that does not resolve is refused. The tool's input
    schema has no identity field, so a prompt-injected model cannot pick
    one, and a caller-supplied `workspaceId` is not trusted.
  - The prompt names the asking session by client name and workspace name
    (`claude-code in workspace "api"`). Ids stay out of anything shown to the
    person or to other agents.
  - Consent is fail-closed: a prompt nobody answers within 2 minutes refuses
    that call (`timeout`). Only an explicit Deny is remembered; an unanswered,
    withdrawn or unshowable prompt is not, so the next call asks again.
- **Input lock.** One agent session at a time holds desktop input. Another
  that tries gets `input_busy`, with the holder's client and workspace name.
- **Abort.** A global shortcut (default `Ctrl+Alt+Shift+Escape`) cancels the
  in-flight request, releases modifiers, takes down every open consent prompt
  (the calls parked on them fail with `aborted` at once), drops the input lock
  and every consent given this run, and for 5 s rejects control actions and
  opens no new prompt. A call after the stop never joins a prompt raised
  before it: each stop starts a new prompt epoch.
  - The shortcut is held only while computer use is on: taken on the first
    call (or when Settings shows the switch on), given back when the switch
    goes off and on quit, when the service is also disposed.
  - It fails closed: while the shortcut cannot be registered (another app
    owns the chord), every input action is refused with
    `stop_key_unavailable`, and Settings shows the key as unavailable instead
    of advertising it. Observation still works.
- **Rate cap.** 120 control actions per minute per agent session.
- **Elevation (Windows).** Before injecting input, the helper compares token
  integrity levels. An elevated target returns `target_elevated`; UIPI would
  otherwise drop the input silently. The UAC secure desktop is never
  targeted.
- **Agent cursor overlay.** Drawn as an Electron click-through, non-focusable,
  content-protected window. It shows an amber cursor dot at the injected
  point, per DESIGN.md: amber = alive. It never changes the user's system
  cursor, so a crash leaves nothing behind. Window-only captures never
  include it.
- **Untrusted screen text.** The tool description says screen text is data,
  never instructions, and that send, submit, pay and delete need the user's
  say-so.

## macOS specifics (phase 2)

- The helper is a separately signed `.app` with a **permanent** bundle ID and
  signing identity. TCC grants attach to it, and changing either later forces
  every user to re-grant.
- Main spawns the helper's executable directly, so the helper is the process
  TCC attributes permissions to.
- Runtime calls never prompt; they return `permission_missing` with the
  Settings deep link.
- A grant can read as denied for about 2 s after it is given, so the helper
  re-checks every 100 ms for up to 2 s before reporting missing.
- Electron targets need `AXManualAccessibility` set once per process instance.

## Windows specifics (phase 1)

- CsWin32 bindings with NativeAOT give a single exe with no runtime
  dependency. FlaUI is not used because its COM interop does not support
  NativeAOT.
- UIA3 through a CacheRequest: one round-trip per subtree, all UIA work on one
  STA thread.
- Capture order: PrintWindow with `PW_RENDERFULLCONTENT`, then BitBlt of the
  window rectangle when PrintWindow returns black. Windows.Graphics.Capture is
  not used because an unpackaged exe cannot hide its yellow border. DWM
  extended frame bounds are used to avoid shadow trim.
- **The helper must be Authenticode-signed with the installer's identity.**
  Unsigned input-injecting AOT exes are a known Defender ML false-positive
  profile. No packers, no PowerShell.

## Performance targets (spike acceptance)

`getAppState` (ax) ≤ 300 ms on Notepad, Explorer and VS Code;
screenshot ≤ 150 ms; `click` / `type` ≤ 100 ms.

## Plan

1. **Shared contract and main-side glue**, verified against a fake helper:
   protocol types, scale math, blocklist, errors, RPC names, capabilities,
   `ComputerService`, `computer.rpc.ts`, the MCP tool, the settings gate.
   Checks: `tsc` and unit tests.
2. **Windows spike on a real machine:** Defender/SmartScreen behaviour with a
   signed and an unsigned build, and the latency targets above.
3. **Windows helper** (`native/computer-use-windows`), built and signed in the
   release workflow. Dogfood: an agent types into Notepad and verifies the
   result.
4. **Agent cursor overlay + abort shortcut** end-to-end.
5. **macOS helper** (`native/computer-use-macos`), with signing and TCC
   onboarding.
6. **v2:** tree diffs, drag, per-app "always allow" grants, macOS background
   input behind a flag with a public-API fallback.

## References

Behaviour and UX only:

- stablyai/orca: `docs/site/content/docs/cli/computer-use.mdx`
- trycua/cua `libs/cua-driver` (MIT core): action-result contract, background
  delivery notes
- openclaw/Peekaboo: snapshot-bound element IDs, permission onboarding
- CursorTouch/Windows-MCP: UIA control-type filtering and caching
- mediar-ai/terminator: pre-action checks, click result reporting
- FlaUI/FlaUI: UIA caching model; NativeAOT limitation, FlaUI#672
- microsoft/CsWin32: AOT-compatible COM bindings
- Anthropic computer-use tool docs: screenshot scaling, action set
- be1st6666/guarded-computer-use-mcp: physical-input-only approvals,
  abort key, rate cap
