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
  virtual-desktop coordinate normalisation, held-state file validation. The
  unit tests in `tests/` cover this project and run on any OS.
- `src/Helper`: the executable (UIA, capture, SendInput, the request loop).
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
`SendInput`, read other windows through UI Automation and capture them. So:

- **The helper is not a privilege boundary.** It does what its stdin says,
  with the user's own rights, and checks nothing about its parent. A process
  that could drive the helper could drive the desktop without it. wmux's
  safety lives in main (consent per app, blocklist, input lock, stop key,
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
- **A packaged Windows wmux keeps computer use off until the helper carries a
  release signature.** The release job marks the helper release-signed only
  when the policy is `release-signing` and `Get-AuthenticodeSignature` says
  `Valid` and the signer's thumbprint equals the repo variable
  `SIGNPATH_RELEASE_SIGNER_THUMBPRINT`. Without that mark, Settings shows the helper as not in this build,
  the switch cannot turn on, and the spawn is refused. Dev builds are
  unaffected.
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
- Main judges explorer.exe per window (`windowBlockReasonFor` in
  `src/shared/computer/blocklist.ts`): only folder windows whose
  `shellLocation` is a filesystem path may be driven; every other shell
  window is a shell system surface and is refused, as is a folder window
  whose location cannot be read. Before input, main re-reads the live
  location, because a folder window can navigate after the snapshot.
  `listWindows` hides a folder's location, like its title, until the person
  consented to Explorer.

## Input

- `SendInput` only. Each batch is one `SendInput` call: modifiers down, key
  down and up, modifiers up; or move, button down and up. So nothing stays
  held between calls. If Windows inserts fewer events than asked, the helper
  sends up events for what it tracked at once.
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
≤ 150 ms; `click` / `type` ≤ 100 ms. CI's smoke run reports first-hello
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
   Alt+Tab to another app midway. Typing stops with `window_not_focused`
   ("after N of M characters"); nothing lands in the other app.
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

### 6. Packaged build

1. Build a packaged wmux with a staged helper and the release mark forced for
   the test: `npm run build:computer-use-windows`,
   `$env:WMUX_WIN_HELPER_RELEASE_SIGNED = "true"`, `npm run make`. Install it;
   computer use works.
2. Without that variable the packaged build shows the helper as not in this
   build and the switch stays off.
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
