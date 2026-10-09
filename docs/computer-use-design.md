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
                 SendInput, PrintWindow)                 CGEvent, ScreenCaptureKit)
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
  `{"type":"hello","protocolVersion":2,"os":"win32","helperVersion":"…","capabilities":{…}}`.
  A request is replayed after a crash only if `hello` was never seen for it.
- Request: `{"id":7,"method":"getAppState","params":{…}}`.
- Response: `{"id":7,"ok":true,"result":{…}}` or
  `{"id":7,"ok":false,"error":{"code":"element_stale","message":"…"}}`.
  An `id` that matches no pending request means the stream is out of sync:
  kill the helper.
- Only one request is in flight at a time, because UIA and AX calls run on
  one STA / main thread anyway.
- Timeouts: 15 s for `getAppState`, 8 s for other calls. On timeout the
  helper is killed, not waited on. Killing a helper does not lift keys or
  buttons it held, so when the killed request was an input action (timeout,
  stop key, crash) main starts a fresh helper at once and sends
  `releaseInput`, without waiting for the next request. Until a release
  answers `released: true`, control requests fail closed (a fresh helper is
  tried for each). A helper tracks every key and button it pressed, not
  only modifiers, and releases all of them on stdin EOF or a termination
  signal; on quit main closes stdin and waits briefly before killing it. A
  fresh helper does not know what the dead one pressed. Main sends one request
  at a time, so only the cut-off request can have left input down, and main
  names what it sent: `releaseInput { keys?, modifiers?, buttons? }` (its
  `pressKey` key, its `hotkey` modifiers and key, its `click` button and
  modifiers). With no fields the helper releases the modifiers and mouse
  buttons only, never a blanket list of ordinary keys: a stray key-up lands in
  the foreground window, and pages act on key-up.
- **Key vocabulary.** `pressKey` and `hotkey` carry only canonical names
  from `protocol.ts`: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`,
  `Space`, `ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp`, `PageDown`,
  `F1`–`F12`, lower-case `a`–`z` and `0`–`9`, plus the modifiers `ctrl`,
  `alt` (Option), `shift` and `meta` (Command / Windows key). Main
  normalizes the agent's spelling (`Return`, `Esc`, `cmd`, `win`) and refuses
  the rest with `invalid_argument`, so a helper maps a closed set and never
  parses free text. `hotkey` is `{ modifiers, key }` with exactly one key; a
  modifier is never sent alone.
- **Control target.** Every control request carries `target: { pid,
  windowId }`, the window main vetted. Right before each input batch the
  helper checks that the foreground window (keyboard) or the window under
  the point (pointer) belongs to it, and otherwise sends nothing and answers
  `window_not_focused`. Only the helper can do this check without a race.
- Protocol version 2: the key vocabulary, `target` and `hotkey` as
  `{ modifiers, key }` replaced the version-1 shape incompatibly. No helper
  ever shipped speaking 1.
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

`capabilities`, `listApps`, `listWindows`, `getAppState`, `openApp`, `click`,
`setValue`, `type`, `pressKey`, `hotkey`, `scroll`.

- **`openApp { app }`.** Launches the app if needed, brings it forward and
  makes sure it has a window. `app` is an app name, bundle id, `listApps` id
  or `.app` path. It is an optional helper method (`OPTIONAL_HELPER_METHODS`):
  main calls it only when the helper's hello lists it and otherwise answers
  `unsupported_action`. It travels over `computer.act` like the other input
  actions, but addresses its app by selector, not by snapshot.
- **`capabilities`** adds `missingPermissions` (`accessibility`,
  `screenRecording`) and drops what cannot work without them: no
  Accessibility, no input actions and no `ax` tree; no Screen Recording, no
  screenshot; `getAppState` goes when no observation mode is left.

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
- **Focus.** Input actions bring the target app forward themselves (helper
  auto-activation, 2026-10-08), and a pointer action whose point is covered
  raises the target window first. The helper still re-checks, right before
  each keyboard batch, that focus is on the target and the screen is not
  locked, and answers `window_not_focused` when it is not.
- **Honest results.** Every action returns
  `{ method: "accessibility" | "synthetic" | "clipboard", verification: "verified" | "unverified", note? }`.
  `verified` means state was read back, for example the value after
  `setValue`. The tool description tells the agent never to report an
  unverified action as done.

## Errors

The error codes live in `src/shared/computer/errors.ts`. Each code carries
`nextSteps` that the MCP tool appends to the error text:

`app_not_found`, `app_blocked`, `window_not_found`, `window_not_focused`,
`element_not_found`, `element_stale`, `action_not_supported`, `unsupported_action`,
`value_not_settable`, `snapshot_unknown`, `permission_missing`,
`target_elevated`, `input_busy`, `shortcut_blocked`, `stop_key_unavailable`, `aborted`, `timeout`,
`screenshot_failed`, `helper_unavailable`, `helper_incompatible`,
`turned_off`, `shutting_down`, `unsupported_platform`, `invalid_argument`,
`internal`.

`turned_off` (the person switched computer use off) and `shutting_down` (wmux
is quitting or restarting its helper) are main-only, like `shortcut_blocked`;
helpers never send them. `helper_unavailable` is kept for a helper that is
missing, damaged or failed to start, which is the case that needs a reinstall.

Errors are classified by stable identifiers (HRESULTs, AXError values), never
by localized message text.

## Safety

**Policy (owner decision 2026-10-08).** The first version was safe enough that
a person was faster by hand, so the defaults moved:

- The per-app consent prompt is opt-in (`askPerApp` in `computer-use.json`,
  Settings › Computer use › Ask before each app; off by default). Off, every
  app that passes the blocklist counts as consented.
- The blocklist shrank to password managers, wmux itself and system
  credential / elevation prompts. Terminals, System Settings, Xcode and agent
  apps are allowed.
- `openApp` launches or raises an app, and input actions bring their app
  forward instead of failing on focus.
- An agent cursor and a halo around the target window show while an agent
  drives (`overlay`, on by default).
- Kept: the per-keystroke re-check (focus on the target, screen unlocked),
  the secure-input / password-field refusal, the stop key, the input lock and
  the rate cap.

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
- **Re-vetting.** `getAppState` vets the app and window the helper answered
  for every time, not only when they differ from the resolved pair, and
  refuses a window whose pid or app id does not match its app. A control
  action that waited on a consent prompt re-checks its snapshot's expiry and
  the stop cooldown on a fresh clock before it takes the input lock.
- **Window titles.** With `askPerApp` off, `listWindows` sends the title of
  every window of an unblocked app. With it on, `listApps` and `listWindows`
  still ask for no consent, so `listWindows` sends a window's title only when
  the calling agent already has the person's consent for its app (matched on
  the window's `appId`); every other window keeps its id and bounds with a
  blank title, and a caller that sends no identity gets no titles at all.
  Blocked apps are always marked and blank.
- **Hard blocklist in main, not only in the helper.** It covers:
  - password managers (by exe, bundle id and, for `openApp`, app name);
  - wmux itself;
  - OS credential prompts: Credential UI / UAC consent on Windows,
    SecurityAgent and the login window on macOS.

  Terminals, shells, agent apps and system tools (System Settings, Task
  Manager, Script Editor and the rest) are no longer blocked, and explorer.exe
  windows are no longer judged per window. Password managers inside a
  browser share their host's process and are not caught.

  `openApp` checks its selector against the list before anything launches
  (bundle id, `.app` or exe basename, app name), and the app the helper
  opened again afterwards. An absolute `.app` path is judged by the bundle id
  in its `Info.plist` (`/usr/bin/plutil`, no shell), since its file name can
  be anything; one whose bundle id cannot be read is not opened.

  The helper reports the process path and bundle ID of each target; main
  refuses before it forwards the action.
- **OS-wide chords.** Main refuses, with `shortcut_blocked` (a main-only code
  helpers never send) and before consent, the lock or the helper, only the
  chords that end the session or kill apps wholesale:
  - everywhere: Escape with Ctrl+Alt (the stop key and its neighbours);
  - Windows: Win+L (lock), Win+X (shut down / sign out menu),
    Ctrl+Alt+Delete, Ctrl+Shift+Esc (Task Manager);
  - macOS: Ctrl+Cmd+Q (lock), Cmd+Shift+Q and Cmd+Opt+Shift+Q (log out),
    Cmd+Opt+Esc (Force Quit).

  App switching (Cmd+Tab, Alt+Tab), Start / Spotlight and Mission Control are
  allowed. Power and eject keys are outside the key vocabulary, so the
  shutdown chords built on them cannot be sent at all.

  Modifiers on `pressKey`, `type` or `scroll` are refused rather than
  dropped (`hotkey` is the way to send a chord).

  App-level chords stay allowed even when they change the window: Alt+F4 and
  Cmd+Q close the vetted app, and Ctrl+Cmd+F toggles its full screen.
- **Approvals.** Plugins need the `computer.observe` capability (list,
  inspect) and the `computer.control` capability (input), both granted through
  the existing enforcer, whose verdict on the `computer` risk class is binding
  even in shadow mode (like the commander gate). With `askPerApp` on, every agent also needs the person's consent
  per app, asked through the approval queue (`computer-app` prompt, both the
  modal and the Fleet inbox) and remembered for the run. `openApp` asks
  before raising an app that is already running, and right after launching
  one that was not.
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
    goes off and on quit, when the service is also disposed. Disposal is
    final: a call that arrives during quit starts no helper and does not
    take the shortcut again.
  - It fails closed: while the shortcut cannot be registered (another app
    owns the chord), every input action is refused with
    `stop_key_unavailable`, and Settings shows the key as unavailable instead
    of advertising it. Observation still works.
- **Rate cap.** 120 control actions per minute per agent session.
- **Elevation (Windows).** Before injecting input, the helper compares token
  integrity levels. An elevated target returns `target_elevated`; UIPI would
  otherwise drop the input silently. The UAC secure desktop is never
  targeted.
- **Agent cursor and halo.** Drawn by the native helper, not Electron:
  borderless windows with `sharingType` none (so captures never include
  them), ignored by the helper's own hit test. A second cursor glides to the
  injected point (about 150 ms before a pointer action) and a halo outlines
  the target window. It never changes the person's system cursor, so a crash
  leaves nothing behind. Main pushes `configure { overlay }` right after a
  hello that lists `configure`, and again whenever Settings › Computer use ›
  Show agent cursor and halo changes; a helper without `configure` is
  skipped. Known limit: the overlay's pill shows the default stop key text,
  because `configure` carries no stop key.
- **Permissions (macOS).** Settings › Computer use shows the helper's
  Accessibility and Screen Recording grants from a short-lived, verified
  probe (a running helper keeps a stale Screen Recording answer), re-read on
  window focus. Request access runs the verified helper with
  `--request-permissions`; Reset access runs `/usr/bin/tccutil reset` for
  `Accessibility` and `ScreenCapture` on the helper's identifier (after an
  in-page confirm), which clears a stale row that reads as on but denies the
  installed helper; Show helper in Finder selects the helper .app. A
  `permission_missing` error names the full helper .app path and says to
  remove it with "−" and add it again, or to use Reset access.
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

The helper as built, its trust model, signing and the dogfood checklist:
`docs/computer-use-windows.md`. Like the macOS helper it types Unicode only
and never uses the clipboard.

- CsWin32 bindings with NativeAOT give a single exe with no runtime
  dependency. FlaUI is not used because its COM interop does not support
  NativeAOT.
- UIA3 through a CacheRequest: one round-trip per subtree, all UIA work on one
  STA thread.
- Capture: PrintWindow with `PW_RENDERFULLCONTENT` only, never a screen copy
  (it could include covering windows). Windows.Graphics.Capture is
  not used because an unpackaged exe cannot hide its yellow border. DWM
  extended frame bounds are used to avoid shadow trim.
- **The helper must be Authenticode-signed with the installer's identity.**
  Unsigned input-injecting AOT exes are a known Defender ML false-positive
  profile. No packers, no PowerShell.
- **Packaged builds spawn only the bundled helper.** The `WMUX_COMPUTER_HELPER`
  override (an absolute path to a locally built helper) works only in dev
  builds, so an environment variable cannot swap the input-injecting process
  in an installed wmux. A packaged wmux checks the helper against a SHA-256
  pinned at build time and refuses one that does not match; a release
  signature is not required (`docs/computer-use-windows.md`).

## Performance targets (spike acceptance)

`getAppState` (ax) ≤ 300 ms on Notepad, Explorer and VS Code;
screenshot ≤ 150 ms; `click` / `type` ≤ 100 ms with the overlay off (with it
on, the cursor glides about 150 ms before each pointer action).

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
