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
  before `hello`, which main reports as `helper_unavailable`. An elevated
  helper could drive elevated apps.
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
  `Valid`. Without that mark, Settings shows the helper as not in this build,
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

- One CacheRequest per tree (subtree scope, control view), so the walk is one
  cross-process round-trip; children are read from the cache. All UIA and COM
  work runs on one dedicated STA thread with a message pump. `IUIAutomation2`
  timeouts are 2 s to connect and 6 s per transaction, below main's 15 s and
  8 s, so a hung target produces an error reply instead of a killed helper.
- Tree format: `docs/computer-use-design.md`, with the macOS rules from
  `docs/computer-use-macos.md` (what is kept, value vs. name, states).
  Roles are UIA control types humanised (`Edit` → `edit`, `MenuItem` →
  `menu item`). `IsPassword` fields and fields named like a secret show
  `Value: [redacted]`.
- Chromium and Electron build their UIA tree lazily: when the web root has no
  children on the first query, the helper waits briefly and queries once
  more.
- Staleness: an indexed action re-reads that element's RuntimeId and process
  id; a mismatch is `element_stale`.
- Screenshots: `PrintWindow` with `PW_RENDERFULLCONTENT`, then `BitBlt` from
  the screen when that comes back black, cropped to the DWM extended frame
  bounds (no shadow), scaled with the shared formula and encoded as JPEG
  (quality 80) through WIC. A minimized window reports
  `screenshotStatus: failed` instead of capturing garbage.
- Apps hosted by `ApplicationFrameHost.exe` (Settings, Calculator) are
  reported as the process behind their `CoreWindow`, so the blocklist sees
  `SystemSettings.exe`, not the host.
- Each window also carries `className`, a diagnostic field outside the
  protocol type, so Explorer's Run dialog and Control Panel windows can be
  told apart from file windows (see the dogfood list).

## Input

- `SendInput` only. Each batch is one `SendInput` call: modifiers down, key
  down and up, modifiers up; or move, button down and up. So nothing stays
  held between calls. If Windows inserts fewer events than asked, the helper
  sends up events for what it tracked at once.
- Before every batch, and again before every typed chunk, repeated key and
  scroll notch, the helper requires:
  - the input desktop to be the normal one (`OpenInputDesktop` succeeds and is
    named `Default`). A locked screen, the UAC secure desktop or
    Ctrl+Alt+Delete is refused with `window_not_focused`, never reported as
    sent;
  - keyboard: the foreground window is `target.windowId`, owned by
    `target.pid`, and its thread's focus is inside it. Pointer: the window under
    the point is the target, or a menu or popup of the same process;
  - the target not to run at a higher integrity level than the helper. If its
    integrity cannot be read, it counts as higher. UIPI drops such input
    silently, so this is `target_elevated`;
  - keyboard actions (`type`, `pressKey`, `hotkey`, `setValue`): the focused
    element is not a password field (`IsPassword` or a secret-like name),
    else `app_blocked`.
- Foreground: the helper never uses `AttachThreadInput` or Alt-key tricks to
  take the foreground. A covered pointer target gets one UIA focus request;
  if the window still is not in front, the answer is `window_not_focused`.
- `type`: Unicode key events (`KEYEVENTF_UNICODE`) in chunks of at most 16
  UTF-16 units, never splitting a surrogate pair or a grapheme; newline and
  tab are Enter and Tab presses. **The clipboard is never used**, whatever
  the length (`TYPE_PASTE_THRESHOLD` does not apply to either helper).
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

1. Install the .NET 10 SDK, then from the repo root:
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
2. **Password field.** In Edge, open a page with a password input
   (`data:text/html,<input type=password autofocus>`). `getAppState` shows
   `Value: [redacted]`; `type` and `setValue` into it answer `app_blocked`.
3. **Elevated target.** Start Notepad as administrator. Every control action
   on it answers `target_elevated`; nothing is typed.
4. **Elevated wmux.** Start wmux as administrator with computer use on. Any
   call answers `helper_unavailable`; running the exe from an elevated prompt
   exits with code 72 and the stderr line above.
5. **Secure desktop.** While a UAC prompt is open, and while the screen is
   locked (Win+L, then a timed `probe.mjs` call), control actions answer
   `window_not_focused` and nothing is sent.
6. **Settings app.** `listApps` reports Settings as `SystemSettings.exe`
   (not `ApplicationFrameHost.exe`), and the agent gets `app_blocked` for it.
7. **Hung target.** Make a window hang (a small WinForms app that sleeps on
   its UI thread after a click, or any app stopped in a debugger). Run
   `getAppState` on it through `probe.mjs`: the helper answers with an error
   within about 8 s and stays alive for the next request.

### 4. Control Panel and the Run dialog (#1689)

Explorer's Run dialog and Control Panel belong to `explorer.exe`, so main
cannot block them by executable. Open the Run dialog (Win+R by hand), Control
Panel (`control`) and an ordinary File Explorer window, then run
`probe.mjs <exe> listWindows '{"app":"explorer.exe"}'`. Report each window's
`title` and `className`, and for Control Panel the address-bar location.
Main will block on these fields.

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
