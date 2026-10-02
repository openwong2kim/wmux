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
  is closed. A subtree whose frame lies wholly outside the window is skipped.
- Secure text fields, and fields whose name says password, passcode, PIN,
  one-time, OTP, verification code or security code, show `Value: [redacted]`.
- Text is whitespace-collapsed and capped at 120 characters (`…`). The caps
  are 800 indexed elements and 40 levels of AX depth, with a 9 s walk budget
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
  window to be the focused window of the frontmost app; pointer batches need
  the target's window under the point. A covered window is first raised
  through AX (`AXFrontmost`, `AXRaise`; neither counts as input). When the
  check fails, nothing is sent and the call returns `window_not_focused`.
- Action ladder: a plain left click on an element with `AXPress` is pressed
  through accessibility. `setValue` is `AXValue` followed by a read-back, which
  counts as `verified`. Everything else is synthetic.
- `type`: text shorter than 64 characters is typed as Unicode key events, with
  `\n` and `\t` sent as Return and Tab. Longer text is pasted. The pasteboard
  item carries `org.nspasteboard.ConcealedType` and `TransientType`, so
  clipboard managers skip it. The previous clipboard is put back only if the
  pasteboard's `changeCount` has not moved since the paste. The result is
  `verified` once the focused element's value shows the text.
- Keystrokes (`type`, `pressKey`, `hotkey`) and `setValue` are refused with
  `app_blocked` while secure keyboard entry is on (`IsSecureEventInputEnabled`)
  or the focused element is an `AXSecureTextField`.
- Keys: the closed vocabulary of `protocol.ts`. Letters and digits use the key
  that types them on the current ASCII-capable layout (AZERTY `a` is the key
  labelled A), and named keys are positional. Arrows carry the NumericPad and
  Fn flags, and Home, End, PageUp, PageDown, Delete and F1 to F12 carry Fn, as
  on a real keyboard.
- Held input: modifier key-downs and button-downs are recorded before they are
  posted and cleared after their up event, and every batch sends its ups from a
  `defer`. `releaseInput`, stdin EOF and SIGTERM/SIGINT/SIGHUP release what is
  held. The record is also kept in
  `$TMPDIR/com.electron.wmux.computer-use.held.json`, keyed by pid, so a fresh
  helper's `releaseInput` also releases what a killed helper left down. Only
  what a helper pressed is released, never a key the person holds.

## Process

Requests are handled one at a time on the main thread; the main run loop keeps
`NSWorkspace`'s app list current. The helper exits on stdin EOF and after
5 minutes without a request, releasing held input first. stdout is written
unbuffered, one JSON line per message. stderr carries short diagnostics only.
