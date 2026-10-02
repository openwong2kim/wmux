# Computer use: the macOS helper

`native/computer-use-macos` is the macOS half of the computer-use design
(`docs/computer-use-design.md`): a Swift executable inside its own signed
bundle, `wmux Computer Use.app`, that speaks the helper protocol of
`src/shared/computer/protocol.ts` over stdio.

Requirements: macOS 14 or later (ScreenCaptureKit's `SCScreenshotManager`),
Apple silicon (the release runner builds arm64 only). On older systems the
binary does not start; main is expected to answer `unsupported_platform`
before it tries.

## Build

```
npm run build:computer-use-macos                      # ad-hoc signature
npm run build:computer-use-macos -- --identity <id>   # Apple Development / Developer ID
npm run build:computer-use-macos -- --dev-any-parent  # dev wmux may drive it (never for release)
npm run test:computer-use-macos                       # Swift unit tests
```

`build.sh` produces `native/computer-use-macos/dist/wmux Computer Use.app`,
the path a dev build of wmux spawns, and stages a copy at
`dist/computer-use-macos/`, which forge ships as
`Contents/Resources/computer-use-macos/` (an `extraResource`, added only when
the staged copy exists).

The package targets Swift tools 5.9 / Swift 5 mode because the release runner
(`macos-14`) ships Xcode 15.

Sources:

- `Sources/ComputerUseCore`: pure logic with no AX, CGEvent or TCC: tree
  walking and rendering, the key table, screenshot scale. The unit tests cover
  this target.
- `Sources/wmux-computer-use`: the executable (the AX adapter, input, capture,
  the request loop).

## Signing

The helper is signed by `build.sh` and nowhere else:

- hardened runtime, a secure timestamp for real identities, **no
  entitlements**, and the permanent identifier `com.electron.wmux.computer-use`;
- forge's `osxSign` skips `Contents/Resources/computer-use-macos/`
  (`forge.config.ts`). Its `optionsForFile` gives every Mach-O wmux's Electron
  entitlements (`allow-dyld-environment-variables`,
  `disable-library-validation`), which an input-injecting helper must never
  carry;
- the release job resolves the team's Developer ID identity by SHA-1, builds
  the helper with it before `make`, and runs `check-signature.sh --release` on
  the staged helper and again on the one inside the packaged app.

A packaged wmux spawns the helper only after `src/main/computer/verifyHelper.ts`
accepts it:

```
codesign --verify --strict -R='anchor apple generic and certificate leaf[subject.OU] = "8RGHH2F237" and identifier "com.electron.wmux.computer-use"'
```

That requirement accepts any certificate of the wmux team (Developer ID or
Apple Development). An unsigned wmux build ships an ad-hoc helper, which fails
the check, so computer use is unavailable there.

The bundle id and the signing team are permanent. TCC grants are bound to
them, and changing either one makes every user grant both permissions again.

## TCC attribution

A process that wmux execs inherits wmux as its *responsible process*, and TCC
checks and records grants against that process. Left alone, the helper's
grants would land on wmux, and through wmux on every shell and agent it hosts.

So the first thing the helper does is re-exec itself once with responsibility
disclaimed, through the private `responsibility_spawnattrs_setdisclaim` SPI
(Chromium and LLDB use it the same way) together with `POSIX_SPAWN_SETEXEC`.
SETEXEC replaces the process image in place, which keeps the same pid, the
same stdin, stdout and stderr, and the same parent, so main's `kill()` and the
stdin-EOF exit keep working and nothing has to forward signals. `open` and
LaunchServices would also disclaim, but they detach stdio. If the helper is
still not its own responsible process after the re-exec, it exits (code 70)
rather than run under wmux's identity.

To check: `log show --last 5m --predicate 'subsystem=="com.apple.TCC"'`. The
`AUTHREQ_ATTRIBUTION` lines show `identifier=com.electron.wmux.computer-use` as
the accessing process, with no responsible wmux.

## Permissions

The helper needs **Accessibility** (reading other apps and posting input) and,
for screenshots, **Screen & System Audio Recording**. Requests never prompt at
runtime:

- a missing grant is reported as `permission_missing`, with the System Settings
  deep link (`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
  or `?Privacy_ScreenCapture`). A `false` is re-checked every 100 ms for up to
  2 s first, because a fresh grant can read as denied for a moment;
- a missing Screen Recording grant does not fail `getAppState`.
  `screenshotStatus` reports it and the tree still comes back;
- `wmux-computer-use --request-permissions` is for onboarding only: it shows
  the system prompts, which add "wmux Computer Use" to both lists. Settings is
  expected to run it on an explicit button press.

A grant stays on whatever signature the helper had when its row was created.
An ad-hoc row is pinned to a cdhash. If a rebuild, or a switch between ad-hoc
and a real identity, leaves the switch on but the helper still reports
`permission_missing`, the TCC log shows `Failed to match existing code
requirement for subject com.electron.wmux.computer-use`. To fix it, remove
the row:

```
tccutil reset Accessibility com.electron.wmux.computer-use
tccutil reset ScreenCapture com.electron.wmux.computer-use
tccutil reset PostEvent com.electron.wmux.computer-use
```

Then run `--request-permissions` and grant again. Builds signed with a real
identity get a requirement-based row, which survives rebuilds.

Electron apps build their accessibility tree only on request, so the helper
sets `AXManualAccessibility` once per process instance of an Electron app,
then waits 300 ms.

## Observation

`getAppState` walks the target window, then the app's menu bar, then any open
context menu. All of them hang off one `0 window …` root:

```
App: TextEdit (pid 4812) · Window: "notes.txt"
0 window notes.txt
	1 text area, Value: hello world
	2 button Close
	3 menu bar
		4 menu bar item File
Focused: 1
```

These are the macOS choices the design doc leaves open, written down so that
the Windows helper can match them:

- A line is `<index> <role>[ <name>][, Value: v][, Description: d][, State: s1 s2]`.
  With no name the role stands alone (`3 menu bar`). Multiple states are
  separated by spaces: `State: disabled selected`.
- The name is `AXTitle`, else `AXDescription`. Description is shown only when
  both exist and differ. Value is left out when it equals the name.
- Static text has its text as its name: `5 text Saved`, with no `Value:`.
- Window buttons with no title are named after their subrole (`Close`,
  `Minimize`, `Zoom`, `Full Screen`).
- Roles are humanised from `AXRole`, and a subrole wins when it changes what
  the element is: `search field`, `secure text field`, `switch`, `tab`, `row`.
- Kept elements:
  - landmarks (window, sheet, menu bar, menu, toolbar, tab group, table,
    outline, list, web area) and interactive roles, always;
  - text, when it has text;
  - images, when they have a name;
  - everything else, when it has a name, a value or an action other than
    `AXShowMenu`, `AXScrollToVisible` or `AXRaise`. Dropped nodes pass their
    children up a level.
- Tables and outlines contribute only `AXVisibleRows`. A closed menu is not
  descended into, because AX exposes every item of every menu even while it
  is closed. A subtree of the window whose frame lies wholly outside the window is
  skipped (the menu bar is not clipped), and so are rulers (a row of tab
  stops).
- Secure text fields, and fields whose name says password, passcode, PIN,
  one-time, OTP, verification code or security code (plus the usual words in
  Korean, Japanese, Chinese, German, French, Spanish, Portuguese and
  Russian), show `Value: [redacted]`.
- Text is whitespace-collapsed and capped at 120 characters (`…`). The caps
  are 800 indexed elements and 40 levels of AX depth, with an 8 s walk budget
  inside main's 15 s timeout; any cap sets `truncated: true`.

The screenshot is the window alone, captured with ScreenCaptureKit
(`desktopIndependentWindow`, shadows ignored, no cursor) at the shared scale
and encoded as JPEG at quality 80. `scale` is image pixels per window point,
measured from the captured image.

Snapshot ids carry a random per-process prefix, so a restarted helper never
re-issues an id main still maps to a dead helper's elements. Before an indexed
action, the element is re-read and compared on role, subrole, title,
identifier and parent role. Value is left out of the comparison, and the tree
is not re-walked.

## Input

- Every event comes from a `CGEventSource(.privateState)`, with its flags set
  explicitly. A Cmd or Shift the person is physically holding never merges
  into an agent's keystroke. Local-event suppression is set to 0, so the
  person's own mouse is never frozen.
- Targets (`ControlTarget`, per protocol): keyboard batches need the target
  window to be the focused window of the frontmost app. Pointer batches need
  the target window itself under the point, or a menu or popover of the same
  app (a window above the normal layer); another normal window of the same app
  does not count. No window is skipped for being wmux's: when the agent-cursor
  overlay lands, main must name its window ids, because "content-protected
  window of the parent" also matches real wmux windows. A covered window is
  first raised through AX (`AXFrontmost`, `AXRaise`; neither counts as input).
  When the check fails, nothing is sent and the call returns
  `window_not_focused`.
- Re-checks inside a batch: before every typed chunk and every repeated key,
  the helper checks again that the screen is not locked, the target app is in
  front, its focused window is the target window, and no password field has
  focus. Before every scroll notch, the point must still hit the target. The
  batch stops at the first failure and says how far it got.
- Action ladder: a plain left click on an element with `AXPress` is pressed
  through accessibility. `setValue` is `AXValue` followed by a read-back, which
  counts as `verified`. Everything else is synthetic.
- `type`: with an index, the element must actually take keyboard focus, or
  nothing is typed. Text of any length is typed as Unicode key events. Each
  event carries at most 16 UTF-16 units, and graphemes are never split, so a
  composed Hangul syllable or an emoji arrives whole. `\n` and `\t` are sent as
  Return and Tab presses. The clipboard is never used: no leak to clipboard
  managers, no restore race, and nothing of the person's clipboard can be
  pasted into the target. (`TYPE_PASTE_THRESHOLD` in protocol.ts does not
  apply to this helper.) The result is `verified` only when the focused
  element's value changed and now ends with the text.
- Keystrokes (`type`, `pressKey`, `hotkey`) and `setValue` are refused with
  `app_blocked` while secure keyboard entry is on (`IsSecureEventInputEnabled`)
  or the focused element is a password field: an `AXSecureTextField`, or a
  field whose label matches the redaction rule above.
- Keys: the closed vocabulary of `protocol.ts`. Letters and digits use the key
  that types them on the current ASCII-capable layout (AZERTY `a` is the key
  labelled A), and named keys are positional. Arrows carry the NumericPad and
  Fn flags, and Home, End, PageUp, PageDown, Delete and F1 to F12 carry Fn, as
  on a real keyboard. The layout map is rebuilt when the input source changes.
- Held input: every key-down and button-down, including the key behind a
  Unicode event, is recorded before it is posted and cleared after its up
  event. Every batch sends its ups from a `defer`. The record is also kept in a
  file per helper pid, so the next helper can release what a crashed one left
  down:
  - the directory is `<per-user temp>/com.electron.wmux.computer-use.held`,
    found through `confstr(_CS_DARWIN_USER_TEMP_DIR)` rather than `$TMPDIR`;
  - it must be a real directory owned by the user with mode 0700; a looser
    mode is tightened, anything else turns persistence off;
  - files are created 0600 with `O_NOFOLLOW`, and read back only when the user
    owns them and they are small regular files;
  - their entries become up events only for keys a helper can press (the main
    key block, the named keys, the modifiers) and the three buttons. A button
    goes up where it went down.
- `releaseInput { keys?, modifiers?, buttons? }` releases what this helper
  tracked, what a dead helper recorded, and whatever main lists from the
  request that was cut off. For a cut-off `type`, main lists Enter, Tab and
  the modifiers. With no fields at all it releases the four modifiers and the
  three mouse buttons only. It never sweeps plain keys, because a stray key-up
  reaches keyup handlers in the app in front. `released: true` means every up
  event was created and posted (CGEventPost itself reports nothing).
- Shutdown (stdin EOF, idle, SIGTERM/SIGINT/SIGHUP) goes through one gate.
  Posting stops first, under the lock every post takes, so a post already
  under way finishes and no later one starts. Held input is released after
  that, exactly once. A second trigger, such as EOF racing a signal, parks
  instead of exiting in the middle of the release.

While the screen is locked, AX reports no windows for any app and the lock
screen owns the keyboard. Every method except `capabilities`, `listApps` and
`releaseInput` then answers `window_not_focused` and says the screen is
locked.

## Who may drive the helper

The helper owns its own grants and does what its stdin says. Without a check,
any process of the same user could exec it and drive the desktop with none of
wmux's consent prompts, blocklist or stop key. So before anything else,
before the TCC trampoline, it checks the code signature of its parent process
against:

```
anchor apple generic and certificate leaf[subject.OU] = "8RGHH2F237" and identifier "com.electron.wmux"
```

If the check fails, it exits with code 71 (70 is the trampoline failing). Dev wmux (Electron from
`node_modules`) is not signed that way, so a helper built with
`build.sh --dev-any-parent` (Swift flag `WMUX_ALLOW_ANY_PARENT`) skips the check
and logs that it did. The release job never passes the flag, and
`check-signature.sh --release` fails a binary that carries the dev marker.

## Process

A single AX messaging timeout of 1.5 s is set on the system-wide element, so
it covers every element. NSApplication is initialized with the prohibited
activation policy, because ScreenCaptureKit needs a window-server connection.
Requests are handled one at a time on the main thread; the main run loop keeps
`NSWorkspace`'s app list current. The helper exits on stdin EOF, and after
6 minutes without a request, releasing held input first. That is longer than
main's 5-minute idle timer, so main always closes an idle helper first. stdout is written
unbuffered, one JSON line per message. stderr carries short diagnostics only.
