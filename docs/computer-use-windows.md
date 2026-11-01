# Computer use: the Windows helper

`native/computer-use-windows` is the Windows half of the computer-use design
(`docs/computer-use-design.md`): a C# NativeAOT executable,
`wmux-computer-use.exe`, that speaks the helper protocol of
`src/shared/computer/protocol.ts` (version 2) over stdio. Its behaviour
matches the macOS helper (`docs/computer-use-macos.md`); this page records
what differs on Windows and how to verify it.

Requirements: Windows 10 1809 or later, x64. The exe is self-contained (no
.NET runtime on the target machine).

## Build

```
npm run build:computer-use-windows                 # Windows only; a no-op elsewhere
npm run build:computer-use-windows -- --no-stage   # publish only, do not stage for forge
npm run test:computer-use-windows                  # C# unit tests (also run on macOS/Linux)
```

Building needs the .NET 10 SDK. `build.mjs` runs `dotnet publish -c Release -r
win-x64` with NativeAOT into `native/computer-use-windows/dist/wmux-computer-use.exe`,
the path a dev build of wmux spawns. It then stages a copy at
`dist/computer-use-windows/`, which forge ships as
`resources/computer-use-windows/` (an `extraResource`, added only when the
staged copy exists).

Layout:

- `src/Core`: pure logic with no Win32: tree walking and rendering, the
  sensitive-field rule, the key table, Unicode chunking, screenshot scale,
  virtual-desktop coordinate normalisation, held-state file validation, the
  background-input planner (what may be posted, and in which order). The
  unit tests in `tests/` cover this project and run on any OS.
- `src/Helper`: the executable (UIA, capture, SendInput and PostMessage, the
  request loop).
  Win32 and COM bindings come from CsWin32 with marshalling off, so every COM
  call is an unmanaged function pointer and NativeAOT needs no runtime COM
  interop. FlaUI is not used (its COM interop is not AOT-compatible).
- `smoke.mjs <exe>`: CI's smoke run (hello latency, `capabilities`,
  `listApps` with Notepad open, `getAppState`).
- `probe.mjs <exe> <method> [params] …`: sends requests by hand and prints
  each reply with its latency. `$snap` and `$target` in params are replaced
  by the last `getAppState`'s snapshot id and `{pid, windowId}`.

## Trust model

Windows has no TCC-like grant for synthetic input or screen capture. Any
process of the same user, at the same integrity level, can already call
`SendInput` or `PostMessage`, read other windows through UI Automation and
capture them. So:

- **The helper is not a privilege boundary.** It does what its stdin says,
  with the user's own rights, and checks nothing about its parent. A process
  that could drive the helper could drive the desktop without it. wmux's
  safety lives in main (opt-in consent per app, blocklist, input lock, stop key,
  rate cap) and in the helper's own refusals below.
- **That holds only while the helper runs with the user's ordinary rights.**
  The manifest says `asInvoker` and `uiAccess="false"` (no UIPI bypass), and
  declares PerMonitorV2 DPI awareness. If its own token is elevated (wmux
  started as administrator), the helper refuses to run: it writes
  `[computer-use] refusing to run elevated` to stderr and exits with code 72
  before `hello`. An elevated helper could drive elevated apps. Main checks
  its own token first (`src/main/computer/selfElevation.ts`): Settings shows
  "Unavailable: wmux runs as administrator", the switch stays off, and agents
  get `helper_unavailable` saying so. Exit 72 maps to the same answer.
- **The SHA-256 pin is not a security boundary either.** A packaged wmux
  refuses a helper whose bytes do not hash to the value baked into its main
  bundle at build time (`src/main/computer/verifyHelper.ts`). That catches
  corruption, a partial update and antivirus tampering. Everything under the
  install directory (`%LOCALAPPDATA%\wmux`) is writable by the same user, who
  could rewrite the bundle and its pin together. The gap between the hash
  check and the spawn is accepted for the same reason. Dev builds skip the
  check, and only they honour `WMUX_COMPUTER_HELPER`.

## Signing

SignPath is wired into `release.yml` but its policy is `test-signing` and the
API token secret is not set, so in practice the helper ships **unsigned**.

- The helper goes through its own SignPath request, before forge packages
  it, with its own artifact configuration (repo variable
  `SIGNPATH_HELPER_ARTIFACT_CONFIGURATION_SLUG`). The Setup.exe request signs
  only the outer installer, never the exes inside it. Both requests are no-ops
  until SignPath is configured.
- Order: build, sign, stage, `make` (which pins the staged bytes' SHA-256),
  then a check that the packaged exe matches the pin and that the pin is in
  `app.asar`. `scripts/__tests__/computerHelperRelease.test.mjs` fails the
  build if the order changes, because signing after the pin would make every
  packaged wmux refuse its own helper.
- **A release signature is not required.** A packaged Windows wmux runs the
  helper whenever its bytes match the SHA-256 pin baked into the build; a
  helper that does not match is refused. Settings runs the same check and
  shows such a helper as "Damaged: reinstall wmux", and the switch does not
  turn on. Its verdict is cached by file identity (device, inode, size,
  ctime), so the helper is hashed once per binary, not on every read; the
  check before each spawn is never cached. The release job marks the helper
  release-signed only when the policy is `release-signing` and
  `Get-AuthenticodeSignature` says `Valid` and the signer's thumbprint equals
  the repo variable `SIGNPATH_RELEASE_SIGNER_THUMBPRINT`. Without that mark,
  Settings shows one note that the helper is not code-signed and that Windows
  Defender or SmartScreen may warn about it; the switch still turns on. Dev
  builds are unaffected.
- SmartScreen judges files that carry the Mark of the Web, which is the
  downloaded Setup.exe. The helper is unpacked by the installer and has no
  MOTW, so SmartScreen does not prompt for it. Defender real-time and cloud
  protection still scan it, and an unsigned exe that injects input is a known
  machine-learning false-positive profile. A quarantined helper fails to spawn
  (`ERROR_VIRUS_INFECTED`, which Node reports as `UNKNOWN`) and main answers
  `helper_unavailable` with the plain "not in this build" text.

## Units

The helper is PerMonitorV2 DPI aware, so on Windows the protocol's "logical
points" are **physical pixels**: window bounds, the screenshot scale (image
pixels per window pixel) and the window-relative points main sends all use
that unit. Pointer input uses `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`,
normalised over the virtual screen as `(x - left) * 65535 / (width - 1)`, so
monitors at negative coordinates work.

## Observation

- The tree is read one level at a time: one cached children query per parent
  (control view), capped by the remaining node budget, inside one 7 s walk
  budget that also covers the Chromium re-query below. A child list cut at
  the cap sets `truncated: true` even when pruned children leave the budget
  unfilled. A huge window (Chromium, Office) is cut off with `truncated: true`
  instead of timing out before the caps apply. All UIA and COM
  work runs on one dedicated STA thread with a message pump. `IUIAutomation2`
  timeouts are 2 s to connect and 6 s per transaction, below main's 15 s and
  8 s, so a hung target produces an error reply instead of a killed helper.
- Tree format: `docs/computer-use-design.md`, with the macOS rules from
  `docs/computer-use-macos.md` (what is kept, value vs. name, states).
  Roles are UIA control types humanised (`Edit` → `edit`, `MenuItem` →
  `menu item`). `IsPassword` fields and fields named like a secret show
  `Value: [redacted]`; static text that reads like a secret is redacted too.
- Chromium and Electron build their UIA tree lazily: when the web root has no
  children on the first query, the helper waits briefly and queries once
  more.
- Staleness: an indexed action re-reads that element's RuntimeId and process
  id; a mismatch is `element_stale`.
- Screenshots: `PrintWindow` with `PW_RENDERFULLCONTENT` only. The helper
  never copies the screen, because a screen copy can include windows that
  cover the target (a blocked app or a password manager). When `PrintWindow`
  fails, `screenshotStatus` reports `screenshot_failed`; a window that renders
  black through it (some GPU or DRM-protected surfaces) comes back black, and
  the agent can still use `mode: "ax"`. Windows over 40 MP are refused.
  Cropped to the DWM extended frame
  bounds (no shadow), scaled with the shared formula and encoded as JPEG
  (quality 80) through WIC. A minimized window reports
  `screenshotStatus: failed` instead of capturing garbage. So does a window
  that is not responding (`IsHungAppWindow`, then a 500 ms `WM_NULL`):
  `PrintWindow` would block on its thread, so it runs on its own thread with
  a 2 s deadline and the request loop never waits on it.
- Apps hosted by `ApplicationFrameHost.exe` (Settings, Calculator) are
  reported as the process behind their `CoreWindow`, so the blocklist sees
  `SystemSettings.exe`, not the host.
- `listWindows` covers every visible top-level window, owned ones (dialogs)
  included with their `ownerId`. Each window carries its `className`; File
  Explorer folder windows (`CabinetWClass`, `ExploreWClass`) also carry
  `shellLocation`, the folder shown, read through `IShellWindows` with a
  1.5 s deadline: a filesystem path or a `::{GUID}` shell parse name, absent
  when unknown.
- An app name or exe name covers every process of that app: `listWindows`
  lists the windows of all of them and a window id is found in any of them.
  A name or title that matches windows in more than one process answers
  `invalid_argument`; pass a window id from `listWindows` or `pid:N`.
- Main no longer judges explorer.exe per window (owner decision 2026-10-08:
  the blocklist is down to password managers, wmux and credential prompts,
  see docs/computer-use-design.md › Safety). The helper still reports
  `className` and `shellLocation`; `listWindows` hides a folder's location,
  like its title, until the person consented to Explorer while Settings ›
  Computer use › Ask before each app is on.
- The Windows helper does not implement the optional `openApp` and
  `configure` methods yet. Its hello does not list them, so main answers
  `openApp` with `unsupported_action` and skips `configure`: no agent cursor
  or halo on Windows for now.

## Background input

An input action first tries to post its input to the target window alone,
so the user's cursor, foreground window and focused control stay as they
were, and several panes can drive different apps at once. Only what is
refused before anything was posted goes the real way (`SendInput`, next
section); that result says `delivery: "foreground"`. A posted one says
`delivery: "background"`.

- **How.** `PostMessage` to one child window of the target: the child a real
  click at the point would hit. From the target window down, that is the
  topmost child in z-order that is visible, enabled, not
  `WS_EX_TRANSPARENT`, contains the point, and does not answer
  `WM_NCHITTEST` with `HTTRANSPARENT` (a group box lets the click through to
  the control behind it). Each hit test gets 100 ms; one that goes
  unanswered refuses, and so does a window with more than 512 children (the
  one hit may be past the cut). The point is sent in that child's client
  coordinates, in physical pixels: when the target window or the child
  does not use the DPI of the monitor at the point (a DPI-unaware window,
  or a system-aware one on a monitor of another DPI), it would read them as
  logical pixels and the click would land elsewhere, so that is refused
  (coordinates are not converted in v1).
- **The receiver is re-checked before every message.** It is resolved with
  the process and thread that own it; before each `PostMessage`, under the
  input lock, the handle must still exist and belong to that process and
  thread (slow UIA reads run in between, a handle can be reused, and
  Chromium recreates its widgets on navigation). Changed before the first
  message: nothing is posted (`not_delivered`, then real input). Changed
  later: the action stops with an error (`delivered_unverified`), and no up
  event is sent after it, because the handle may now be another app's.
  A click is `WM_MOUSEMOVE`, `WM_LBUTTONDOWN`, `WM_LBUTTONUP`. Text is one
  `WM_CHAR` per UTF-16 unit (both halves of a surrogate pair); named keys
  are `WM_KEYDOWN` and `WM_KEYUP` with the scan code and extended bit in
  `lParam` (the key-up also sets bits 30 and 31), and the app's own
  `TranslateMessage` makes their characters. Posted messages press nothing
  system-wide, so they are not recorded as held input.
- **Covered windows are the point.** The child is looked up inside the
  target window whoever covers that point on screen, so the "foreground
  window" and "window under the point" preflights of real input do not
  apply. The safety checks do: the input desktop, elevation, secret fields,
  the shutdown gate.
- **Which windows.** Only the window classes posted input is measured with,
  and the plain edit control: `Chrome_RenderWidgetHostHWND` and
  `Chrome_WidgetWin_*` (Chrome, Edge, Electron), `RichEditD2DPT`
  (Notepad), the `RichEdit` family (`RichEdit20W`, `RICHEDIT50W`) and
  `Edit` (class names compare case-insensitively). UIA reports a plain
  `Edit`'s keyboard focus only while its window is in front, so for it the
  focus checks below also accept its own thread's focused window
  (`GetGUIThreadInfo`) being that `Edit`, re-read right before the keys; it
  is a password field when its UIA element says so or it has `ES_PASSWORD`
  (unreadable counts as one). Everything else gets
  real input: buttons, list boxes, list and tree views act on a click
  through `GetMessagePos` (the user's real cursor), a combo box dropdown
  takes mouse capture, and WPF, UWP / WinUI / XAML islands, Qt, Java,
  Flutter, SDL, games reading raw input or custom controls could drop
  posted input without a trace.
- **Per action.** Checked first, before any window state is read: what the
  action asks for.
  - `click`: a single left click with no modifiers, after the UIA ladder
    (Invoke, Toggle, SelectionItem, ExpandCollapse) found no pattern.
    Right and middle buttons, double and triple clicks, and modifiers go the
    real way: posted messages carry no keyboard state, and the rest was not
    measured.
  - `type` with an index: the field's focus is read, the field is clicked
    (posted), and before any key is posted it must report keyboard focus
    (it is the system's focused element, or its UIA `HasKeyboardFocus` is
    true, within 300 ms) and its fresh frame must still contain the clicked
    point. A field that already had focus before the click is read only
    after a 60 ms settle, so its old focus is not taken for the click's.
    The keys go to the window under that click. Always clicked, because
    Chromium and Electron drop posted keys that no posted click preceded,
    and ignore them again after any real activation; for other apps it
    moves focus inside the target without UIA `SetFocus`, which can raise
    the window. The caret lands where the click puts it, the middle of the
    field. If the field does not report focus, or moved away from the
    point, nothing is typed and the action fails (`action_not_supported`,
    `delivered_unverified`: the click went in), never falling back to real
    input.
  - `type` without an index, `pressKey`, and `hotkey` with no modifiers: the
    keys go to the target thread's focused window (`GetGUIThreadInfo`), only
    when it lies inside the target window, is one of the classes above and
    not a Chromium window (no field to click), is itself a UIA Edit or
    Document, and the element with keyboard focus inside it (the window's
    own element or a windowless descendant) is found and is not a password
    field. The focused window is read again right before the keys are
    posted; if it changed, nothing is posted and the keys go the real way.
    A thread that is not in front may have no focused window; then too the
    keys go the real way.
  - `type` whose text holds a Tab or any other control character goes the
    real way, which re-checks focus before every chunk: a Tab can move
    focus (to the next field of a page, or through a dialog) so the rest
    would land where no check was made. Only one trailing newline is
    posted: a trailing `\n` (backslash, n) types Enter in the same action.
  - `hotkey` with modifiers and `scroll`: always the real way (a chord
    cannot be posted; `WM_MOUSEWHEEL` was not measured).
  - `setValue` and the UIA click ladder are not input; their results say
    `background` unless the target window came to the front during the call
    (the foreground is read before the call's checks).
- **Refused before posting** (`not_delivered`, then real input), besides
  the above: the target window is minimized, hidden or cloaked, on another
  virtual desktop (`IVirtualDesktopManager`; if that call fails it is no
  reason to refuse), or elevated; nothing of the target's process at the
  point; a hit test went unanswered; a window on the way has more than 512
  children; the window at the point does not use the monitor's DPI; the
  point is on a frame or scroll bar;
  a menu, an owned window (a dropdown, a dialog) or a tool window of the
  target process lies over the point, whatever covers it on screen (it
  takes a real click); the window at the point is not one of the classes
  above; the field under the click is (or may be) a password field. A
  `PostMessage` that fails on the first message also counts as nothing
  posted.
- **No delivery acknowledgement.** `PostMessage` succeeding is not proof the
  app acted on it. A posted action is `unverified` (`delivered_unverified`)
  unless a re-read confirms it: for `type`, the field's UIA value is the
  value before with exactly the typed text inserted (the same rule as real
  input, but read from the target field, not the system focus). Clicks and
  keys are `unverified`.
- **Our side effects.** The cursor position and the foreground window are
  read before posting and again at least 60 ms after it. If the cursor now
  sits on the target point and did not before, or the foreground window
  changed to a window of the target's process (the target, a dialog or popup
  it opened, another of its windows), the result is `unverified` with
  `delivery: "foreground"` and a note, and the input is never sent a second
  way. The user moving the mouse or switching to another app meanwhile is
  not counted, and neither is any change when the user's own input arrived
  in between (`GetLastInputInfo` moved, which posted messages never do):
  then the result keeps `background` and a confirmed read-back stays
  `verified`.
- **Errors.** Once anything was posted, a later failure ends the action with
  an error and no fallback. If a button-up or key-up is refused after its
  down went in, the up is posted once more (and for a button
  `WM_CANCELMODE`, which ends a capture or drag the app started). Every
  control error carries a `disposition`: `not_delivered` when no input
  event, posted message or UIA pattern call went out during the request,
  `delivered_unverified` otherwise (the same rule as the macOS helper).
- **Capabilities.** `hello.capabilities.input` is
  `{ backgroundPointer: true, focusWithoutRaise: false, keyAuth: true,
  deferForeground: true }`: posted clicks leave the cursor alone; nothing
  gives a window focus without the app taking it itself; posted keys reach
  Chromium-based apps after a posted click on the field; and the helper
  honours `foreground: 'refuse'`.
- **`foreground: 'refuse'`** (main's input lanes,
  `docs/computer-use-design.md`). Every input method takes an optional
  `foreground: 'allow' | 'refuse'` (default `allow`, the behaviour above).
  With `refuse`, wherever the action would go the real way after a
  refusal that posted nothing, it answers `needs_foreground`
  (`not_delivered`) instead, and main re-sends it with `allow` under its
  foreground lease. The decision is Core `Background.Next`: only a refusal
  with nothing posted and the sent counter unchanged since the action
  began becomes `needs_foreground`; a stop after posting started (no focus
  after the click, the field moved, the keys refused) keeps its own answer.
  `scroll` and a `hotkey` with modifiers answer `needs_foreground` at once.
  `setValue` and the UIA click ladder are pattern calls, not input, and
  nothing in them raises the window, so `refuse` changes nothing for them.
  The sent counter's baseline for a request is taken after the release of
  keys a dead helper left down, so those up events never decide an
  action's `not_delivered` or `needs_foreground`. The helper's stderr says
  `needs foreground (…)` for such a refusal under `refuse`, and
  `real input, not background (…)` under `allow`.
- Measured on Windows 11 with Chrome 155, Electron 42 and Notepad
  (`RichEditD2DPT`): posted clicks move the caret or land as
  `pointerType: mouse`, posted keys insert text, and the cursor, foreground
  window and focus stay untouched.

## Input

- Real input is `SendInput` only. Each batch is one `SendInput` call:
  modifiers down, key down and up, modifiers up; or move, button down and
  up. So nothing stays held between calls. If Windows inserts fewer events
  than asked, the helper sends up events for what it tracked at once.
- Before every batch, and again before every typed chunk, repeated key and
  scroll notch, the helper requires the following. The slow checks
  (password field, focused element) run first; the fast Win32 ones (input
  desktop, foreground window and pid, and the focused window handle, which
  must still be the one recorded at the check) run again under the input
  lock immediately before each `SendInput`, so an Alt+Tab or a focus move
  during the slow check sends nothing. That last check is per window
  handle: focus moving between windowless controls inside one window is not
  caught there:
  - the input desktop to be the normal one (`OpenInputDesktop` succeeds and is
    named `Default`). A locked screen, the UAC secure desktop or
    Ctrl+Alt+Delete is refused with `window_not_focused`, never reported as
    sent;
  - keyboard: the foreground window is `target.windowId`, owned by
    `target.pid`, and its thread's focus is inside it (a failed
    `GetGUIThreadInfo` refuses). Pointer: the window under the point, owned by
    `target.pid` at that moment, is the target, a menu (`#32768`), or a
    window owned by the target;
  - the target not to run at a higher integrity level than the helper. If its
    integrity cannot be read, it counts as higher. UIPI drops such input
    silently, so this is `target_elevated`;
  - keyboard actions (`type`, `pressKey`, `hotkey`, `setValue`): the focused
    element is known not to be a password field. A password field
    (`IsPassword` or a secret-like name) and a focus that cannot be read
    (no element, a UIA timeout) are both `app_blocked`.
- Semantic actions (UIA Invoke, Toggle, SelectionItem, ExpandCollapse,
  Value) check the input desktop, elevation and that the element's process
  and top-level window are the target's before every call. Like AXPress on
  macOS they work on a covered background window, because they are not
  input. Once a pattern call was made, an ambiguous error (a timeout behind a
  modal dialog, say) ends the action saying it may have taken effect; the
  helper falls back to another pattern or a synthetic click only when the
  pattern is absent or certainly did not run.
- Foreground: the helper never uses `AttachThreadInput` or Alt-key tricks to
  take the foreground. A covered pointer target gets one UIA focus request;
  if the window still is not in front, the answer is `window_not_focused`.
- `type`: Unicode key events (`KEYEVENTF_UNICODE`) in chunks of at most 16
  UTF-16 units, never splitting a surrogate pair or a grapheme; newline and
  tab are Enter and Tab presses. **The clipboard is never used**, whatever
  the length (`TYPE_PASTE_THRESHOLD` does not apply to either helper).
  `verified` means the focused value after equals the value before with
  exactly the typed text inserted at one position; text that was already
  there never verifies a failed insert.
- Secret fields are refused on the target element itself as well as on the
  focused one: `setValue` and `type` with an index answer `app_blocked` for an
  `IsPassword` field, a Win32 `ES_PASSWORD` edit, a secret-like name,
  AutomationId or class, or an element whose properties cannot be read,
  focused or not.
- Held input: every key and button is recorded before its batch and cleared
  after its up event, in memory and in
  `%LOCALAPPDATA%\wmux\computer-use\held\<pid>.json`:
  - the directory is found through `SHGetKnownFolderPath`, not the
    environment, gets a protected owner-only DACL, and is refused when it is
    a reparse point or owned by someone else;
  - files are small, owned by the user, carry the pid and the process start
    time (pid reuse), and are sanitized: only vocabulary keys, the four
    modifiers and buttons 0–2 at finite coordinates ever become up events,
    and a button goes up where it went down.
- A partial batch (Windows inserted fewer events than asked) releases
  exactly what its prefix left down, Unicode units included: the main key
  first, then the modifiers in reverse, the Win key behind an unassigned key
  tap. The records stay in memory and on disk until those ups are confirmed;
  otherwise the action fails, and main sends `releaseInput` to a fresh
  helper.
- At start-up, and before every control request until it succeeds, the
  helper releases what a dead helper recorded. Until then control requests
  fail with `internal`.
- `releaseInput { keys?, modifiers?, buttons? }` releases what this helper
  tracked, what a dead helper recorded, and what main lists. With no fields
  it releases only the modifiers and mouse buttons that are actually down,
  never plain keys (a stray right-button up opens a context menu on
  Windows). A held Windows key is released behind an unassigned key press, so the
  Start menu does not open.
- Shutdown (stdin EOF, 6 minutes idle, a console control event) goes through
  one gate: posting stops first, then held input is released once, then the
  helper exits. **Node's `child.kill()` on Windows is `TerminateProcess`,
  which runs no handler at all.** For a killed helper the held-state file and
  main's `releaseInput` to a fresh helper (`HelperProcess.ts`) are the
  release path; because every batch is a single `SendInput` call, a kill
  practically never leaves anything down.

## Performance targets

`getAppState` (ax) ≤ 300 ms on Notepad, Explorer and VS Code; screenshot
≤ 150 ms; `click` / `type` ≤ 100 ms (a posted action includes its 60 ms
side-effect check; a verified `type` returns as soon as its text reads
back). CI's smoke run reports first-hello
latency and Notepad's `getAppState` times in the job summary.

## Dogfood checklist (Windows agent)

Run on a real Windows 11 machine, not CI. Report each item as pass or fail
with the command and its output. Report security-relevant failures (a refusal
that did not happen) in chat only, never in a public issue.

### 0. Build and start

1. Get the helper. Either download the artifact
   `wmux-computer-use-<head sha>` from the PR's `computer-use-windows` CI job
   (the NativeAOT exe plus its `.sha256`, kept 7 days; check the hash with
   `Get-FileHash`) and put it at
   `native\computer-use-windows\dist\wmux-computer-use.exe`, or build it:
   install the .NET 10 SDK, then from the repo root:
   `npm ci`, `npm run test:computer-use-windows`, `npm run build:computer-use-windows`.
   Expect `native\computer-use-windows\dist\wmux-computer-use.exe`.
2. `node native\computer-use-windows\smoke.mjs native\computer-use-windows\dist\wmux-computer-use.exe`.
   Report the printed timings.
3. Start dev wmux on that helper:
   `$env:WMUX_COMPUTER_HELPER = (Resolve-Path native\computer-use-windows\dist\wmux-computer-use.exe).Path; npm start`.
   Settings › Computer use: the helper reads ready; turn the switch on; the
   stop key reads held. Confirm that no console window flashes when the
   helper starts.

### 1. End to end with an agent

1. `Set-Content $env:TEMP\wmux-cu.txt "hello from the dogfood"`, then
   `notepad $env:TEMP\wmux-cu.txt`.
2. In a wmux pane (started after the switch went on), run:

   ```
   claude -p --model haiku --allowedTools mcp__wmux__computer "Use the computer tool. In Notepad, open the window for wmux-cu.txt, replace its whole text with 'edited by the wmux agent', save it with ctrl+s, then call getAppState and tell me the document text you see. Never say it worked unless the tool result is verified or the new state shows it."
   ```

   Approve the consent prompt for Notepad.
3. Pass when `Get-Content $env:TEMP\wmux-cu.txt` prints
   `edited by the wmux agent`. Report the action methods and verification
   values the agent got.

### 2. Latency

With `probe.mjs`, measure on Notepad, Explorer (a folder window) and VS Code:
`getAppState` with `mode: "ax"` (≤ 300 ms), `mode: "vision"` (≤ 150 ms
screenshot), and on Notepad a `click` on the document and a short `type`
(≤ 100 ms each). Run each three times and report the median and the element
count. Example:

```
node native\computer-use-windows\probe.mjs <exe> getAppState '{"app":"notepad","mode":"ax","maxNodes":800,"maxDepth":40}' click '{"snapshotId":"$snap","target":"$target","index":1,"button":"left","clickCount":1,"modifiers":[]}' type '{"snapshotId":"$snap","target":"$target","text":"abc"}'
```

### 3. Safety refusals

1. **Stop key.** Have the agent type a long paragraph into Notepad and press
   Ctrl+Alt+Shift+Esc midway. Typing stops. Afterwards, typing by hand in
   Notepad shows no stuck Ctrl, Shift, Alt or Win, and
   `%LOCALAPPDATA%\wmux\computer-use\held` holds no files.
2. **Focus race.** Have the agent type a long paragraph into Notepad and
   Alt+Tab to another app midway. Nothing lands in the other app. Typing
   posted in the background (result `delivery: "background"`) does not
   follow focus and finishes in Notepad; typing sent as real input
   (`delivery: "foreground"`) stops with `window_not_focused` ("after N of M
   characters").
3. **Partial batch / crash recovery.** While the agent holds a chord
   (`hotkey` ctrl+shift+…) or types, kill the helper from Task Manager
   (`wmux-computer-use.exe`). The next computer call succeeds, no modifier
   stays stuck, and the `held` directory is empty afterwards. Then drop a
   hand-written record there with `Set-Content`
   (`{"pid":<a dead pid>,"created":0,"keys":[162],"buttons":[]}`): its DACL is
   not the helper's protected owner-only one, so the next call deletes it
   without acting on it.
4. **Password field.** In Edge, open a page with a password input
   (`data:text/html,<input type=password autofocus>`). `getAppState` shows
   `Value: [redacted]`; `type` and `setValue` into it answer `app_blocked`.
5. **Elevated target.** Start Notepad as administrator. Every control action
   on it answers `target_elevated`; nothing is typed.
6. **Elevated wmux.** Start wmux as administrator. Settings shows
   "Unavailable: wmux runs as administrator" and the switch cannot turn on;
   an agent call answers `helper_unavailable` saying so. Running the exe from
   an elevated prompt exits with code 72 and the stderr line above.
7. **Secure desktop.** While a UAC prompt is open, and while the screen is
   locked (Win+L, then a timed `probe.mjs` call), control actions answer
   `window_not_focused` and nothing is sent.
8. **Settings app.** `listApps` reports Settings as `SystemSettings.exe`
   (not `ApplicationFrameHost.exe`), and the agent gets `app_blocked` for it.
9. **Hung target.** Run `native\computer-use-windows\tools\HangWindow`
   (`dotnet build` it; it stops responding 3 s after it shows), or any app
   stopped in a debugger. Through `probe.mjs`, `getAppState` with `mode`
   `ax`, `vision` and `both` each answers within about 8 s (vision and both
   with `screenshotStatus: failed`, "not responding"), and the helper answers
   the next request.
10. **Unfocused password field.** In the Edge page above, without focusing
    the field, `setValue` and `type` with its index answer `app_blocked`.
11. **Typing verification.** Type `abc` three times into a Notepad document
    that already contains `abc`; every `verified` matches one new `abc` in
    the file. Report any `verified` without its text landing.
12. **Background input.** Cover Notepad, then a Chrome or Electron window,
    with another app. `click` an element and `type` with an index into a
    text field of each: the text lands, the results say
    `delivery: "background"`, and the mouse pointer, the window in front and
    the focused control of the covering app do not change. A right click,
    a double click, `scroll` and a `hotkey` with modifiers come back
    `delivery: "foreground"` (real input, as before). The helper's stderr
    names why a click or typing that could have been posted was not.

### 4. Explorer windows

Open the Run dialog (Win+R by hand), Control Panel (`control`), a File
Explorer window on a drive folder and one on This PC. Then:

1. `probe.mjs <exe> listWindows '{}'` lists all four, the Run dialog with
   its `ownerId`; report each window's `className` and `shellLocation`.
2. `probe.mjs <exe> listWindows '{"app":"explorer.exe"}'` lists the windows
   of every explorer.exe process, and `getAppState` with `app: "explorer.exe"`
   and no window answers `invalid_argument` when more than one process has
   windows.
3. Through an agent (dev wmux): the drive folder can be driven; the Run
   dialog, Control Panel and This PC answer `app_blocked`. Navigate the
   allowed folder window to Control Panel by hand, then let the agent click
   with its old snapshot: `app_blocked`, nothing clicked.

### 5. DPI and monitors

At 125 % and 150 % display scaling, and with a second monitor placed left of
the primary one (negative coordinates), click a Notepad menu item by index and
by screenshot coordinates. The click lands on the intended item every time.

At 125 %, a `getAppState` vision screenshot of a DPI-unaware window (a
WinForms window with no DPI manifest) shows the whole window at its physical
size, with no black band on the right or bottom.

### 6. Packaged build

1. Build a packaged wmux with a staged, unsigned helper:
   `npm run build:computer-use-windows`, `npm run make`. Install it; Settings
   shows the helper ready with the not-code-signed note, the switch turns on,
   and computer use works.
2. With `$env:WMUX_WIN_HELPER_RELEASE_SIGNED = "true"` set before `make`, the
   same build shows no note.
3. Append one byte to the installed
   `resources\computer-use-windows\wmux-computer-use.exe`: the next call
   answers `helper_unavailable` (fail closed). A dev build pointed at the same
   modified exe through `WMUX_COMPUTER_HELPER` still runs it.

### 7. Defender

On a fresh Windows 11 with default Defender (real-time and cloud protection
on), download the Setup.exe through a browser and install it. Report any
SmartScreen prompt (expected only for the Setup.exe) and any Defender
detection of `wmux-computer-use.exe` with the threat name from Protection
history. If Defender quarantines the helper, computer use answers
`helper_unavailable` with the "not in this build" text and Settings shows the
helper as missing.
