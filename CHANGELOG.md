## [3.48.0] — 2026-08-27

### Added

- **A best-effort "installing the update, please wait" window during the install handoff.** Clicking "install now" used to close the app and go silent for up to ~1-2 minutes while the install waiter confirmed every process had actually let go of the install root — indistinguishable, from the outside, from the update having failed. The waiter (which already has to run outside the install root it is watching) now shows a small always-on-top window for that wait, and closes it right before Squirrel's own installer UI takes over. Failing to show it (a locked-down machine, no display subsystem) degrades to today's silent-but-correct behavior — it can never block or fail the install itself. (#1043)

- **First-run system-locale detection.** A session that has never had a language chosen (fresh install, or a `session.json` from before the `locale` field existed) now picks up the OS locale via `navigator.language` and maps it to one of the 23 shipped languages — a region variant like `pl-PL` or `de-AT` matches its base language, and Traditional-vs-Simplified Chinese is routed by script/region rather than defaulting to one. A language nobody ships (or a locale string that doesn't parse) falls back to English, same as today. Detection runs exactly once: any explicit choice already on record in `session.json` — the user's own pick, or a previous run's detection — is left untouched.

### Fixed

- **Five Polish strings that drifted after the English changed.** Follow-up to
  #1029 — the maintainer's `git blame` comparison of `en.ts` against `pl.ts`
  caught keys whose English was edited after the Polish translation was
  written, so the translation kept describing an older feature shape.
  `settings.fontFamilyDesc` still said "monospace font for the terminal" after
  the setting started accepting any installed font; the four `fanout.*` keys
  still said "Fan-out" after the feature was renamed to "Multi Task" and its
  prompt became optional.

- **A half-completed install now says so, from the two places that can still
  speak.** An antivirus scan holding the freshly written executable can make
  the Windows installer abort partway, leaving an installation that either
  never starts (a required Chromium resource was never copied) or starts but
  can never update or uninstall (Squirrel's `Update.exe` was never written) —
  in both cases silently, with the only diagnostic buried in the installer's
  own log. On the update path, the install waiter now stays for the
  installer's exit and verifies what it left behind: a broken result gets a
  visible warning right there — the one surface that still reaches a machine
  too broken to start — plus a notice the next time the app can start at all.
  An installation that runs but is missing `Update.exe` is detected at
  startup and explained once, with reinstall guidance, instead of every
  future update failing with no visible reason. Fresh installs run by hand
  remain the installer's own responsibility — no process of the app exists
  yet on such a machine. (#1048)

- **The roster no longer shows idle for a pane genuinely mid-turn.** A tool
  call whose own terminal output is sparse — a polling loop, a slow build,
  anything writing well under the activity threshold — could leave a working
  pane marked idle in the sidebar for its whole duration, with the pane's own
  status footer visibly ticking the entire time. The agent's own "running"
  lifecycle signal now re-arms the activity detector, so the first byte of
  output after it counts as proof of work; while a turn is already showing as
  running, repeated lifecycle signals change nothing, so status broadcasts
  stay deduplicated exactly as before. (#1050)

- **Windows port monitoring no longer starts PowerShell processes.** The
  workspace sidebar's listening-port chips were collected by shelling out to
  PowerShell every ten seconds to enumerate every process and every listening
  socket on the machine. From an unsigned executable that fixed heartbeat looks
  like a recon signature, and Defender quarantined the app over it — the command
  line in the quarantine report was ours, byte for byte (#1051). The same data
  now comes from in-process Win32 calls (`GetExtendedTcpTable`,
  `CreateToolhelp32Snapshot`), so no child process is spawned and there is no
  PowerShell command line to match. Chips appear and clear as before; if a
  snapshot fails the sidebar keeps the ports it last knew about rather than
  blanking them, and polling pauses briefly before retrying. Anyone already
  quarantined on 3.47.x will need to restore the file or reinstall. This removes
  the behaviour that was flagged — it cannot by itself guarantee how any
  particular scanner rates an unsigned installer, which is a separate problem
  that code signing addresses.

## [3.47.1] — 2026-08-26

### Fixed

- **The Polish locale now covers the full UI.** `pl.ts` had drifted to 374 of
  1464 keys (26%) — the same stalled point every locale but `ko`/`zh` sits at,
  since a translation only lands when someone can verify it. Settings alone was
  missing 219 strings; large surfaces like Deck, Channels, and the first-run
  wizard fell back to raw English inside an otherwise-Polish UI. Filled in the
  remaining 1091 strings and dropped one orphaned key (`fanout.errPromptRequired`)
  that no longer exists in `en.ts` — `pl.ts` now matches `en.ts` at 1464 keys
  exactly, with nothing missing and nothing orphaned. A new coverage test locks
  key parity and `{placeholder}` consistency against `en.ts` going forward,
  scoped to `pl` only.

- **Korean inline composition no longer drags backwards while an agent
  streams.** Typing a multi-syllable word into a pane with output flowing
  painted the syllable being composed near where the word started, so
  `정확히 어떻` read `떻확히 어` until the space committed it. The anchor added
  for Chinese candidate windows pins both IME surfaces to the input line it
  finds, and fluid Korean typing reaches that path too — commit echoes are
  output — so the visible preedit was held at a column one pause stale while
  the caret moved on. The candidate-window pin stays where it was; the inline
  preedit now follows the caret whenever the cursor is on the anchor's own
  row. (#1034)

## [3.47.0] — 2026-08-26

### Added

- **Stash a pane instead of killing it.** Until now the only way to take a pane
  off the screen was `✕`, which destroys its daemon session with no way back —
  so tidying a split and killing an agent were the same gesture. The pane
  header's new archive button (and `prefix` + `!`, tmux's break-pane) removes a
  pane from the layout and leaves its session running. It shows up in the
  workspace's sidebar list — gathered under a divider below the running agents,
  each row marked with a crossed-out eye — where its status keeps updating as
  proof it is still working. Hovering or focusing a row turns the eye back on:
  one click brings the pane back next to its former neighbour with its
  scrollback replayed. A ten-second undo rides the confirmation toast.

  Stashing is refused, with the reason, when the pane is the only one on screen,
  when there is no daemon connection (nothing would be holding the session), or
  when the pane holds an editor or diff tab whose unsaved state cannot be
  replayed. If a stashed session dies while it is off-screen, the row says so
  rather than pretending, and bringing it back offers the same recovery a dead
  visible pane gets — never a silent fresh shell wearing the old pane's name.

  Everything that watches your agents already counts stashed panes: the "N need
  you" chip, the fleet cards, notifications, the sidebar's idle badge. Clicking
  any of them brings the pane back and takes you to it.

- **`pane.stash` / `pane.unstash` RPC + the `pane_stash` / `pane_unstash` MCP
  tools.** A stashed pane stays fully addressable: `terminal_send`,
  `terminal_read`, `pane_close` and A2A delivery all work against it, because
  its PTY is alive and none of them need to know where the pane is on screen.
  Only position-dependent calls (`pane_focus`, `surface_focus`) are refused, and
  they answer with a `PANE_STASHED` error carrying a `recovery` payload the
  caller can invoke verbatim.

  `pane_list` and `surface_list` keep their existing membership — they still
  mean "what is in the layout" — and gained `includeStashed: true` for the rest.
  Every row now carries an explicit `stashed` boolean; stashed rows add
  `stashedLiveness`. Two new events, `pane.stashed` and `pane.unstashed`, keep
  the `pane_list` + `wmux_events_poll` recovery path complete: a pane leaving the
  default listing is always explained by an event, never by silence. Feature
  detection: `system.capabilities` → `features.paneStash`.

- **Stash, in the fine print.** A few limits worth knowing before you lean on it:

  - An orchestrator brain running under a commander binding can stash and unstash
    only inside its own workspace, the same confinement `pane_focus` and
    `pane_split` already have. A pane elsewhere is refused by name rather than
    quietly rearranging a workspace the brain has no business touching.

  - Stashed panes count against the 20-pane-per-workspace limit. The cap exists to
    bound memory, and a stashed session is still running; when the stash is part of
    why you hit the limit, the message says so.
  - Downgrading to a build without stash support does not lose the panes: the
    older session writer round-trips the field it does not understand, so they
    reappear on upgrade. While you are on the older build those sessions keep
    running unmanaged — the same thing that already happens to any session when the
    app is not there to show it.
  - A session that stays silent for more than 8 hours while the app is CLOSED can
    still be reaped by the daemon (#557). That is unchanged and applies to every
    pane, not just stashed ones; the difference is that a stashed pane now tells
    you it happened instead of quietly coming back empty.

- **`wmux daemon start | stop | status` — run the daemon without the app.** The
  daemon no longer needs the Electron main process to exist just to be spawned:
  `wmux daemon start` starts it (or reports it's already running), `wmux daemon
  status` pings it, and `wmux daemon stop` shuts it down — the same spawn,
  readiness, and shutdown paths the app itself uses, headless. A first step
  toward running wmux's actual workload on a machine with no display, with a
  lighter local client attaching to it.

- **`a2a_discover` now reports each pane's own title, not just the generic
  vendor name.** A workspace running two or more sessions of the same vendor
  (several "Claude Code" panes under one role) used to list as indistinguishable
  rows — another agent had no way to tell which pane was which before
  addressing one. Each entry in `agents[].panes` now carries `paneTitle`
  (the same title source the sidebar roster leads with, #934) alongside the
  unchanged `agentName`, additive so existing callers are unaffected.

- **`pane_get_metadata` can read another workspace's pane, read-only.** It
  was hard-scoped to the calling workspace and errored `"not in workspace"`
  against any other pane — the underlying RPC already supported an explicit
  `workspaceId`, only the tool wrapper forced it to the caller's own. Pass
  `workspaceId` to read cross-workspace; `pane_set_metadata` keeps no such
  override and stays confined to the calling workspace. (#1018)

- **Seven more workspace color tags, and two more places they show up.** The
  optional color tag introduced in #927 grows from 8 to 15 hues (amber, lime,
  mint, cyan, indigo, magenta, rose), so tagging a dozen-plus workspaces no
  longer runs out of visually distinct colors. The tag now also appears next
  to a workspace's name in a multiview tile header, and as a thin underline on
  each pane tab's label — not just in the sidebar. Untagged workspaces (the
  default) look exactly as before.

- **Rename pane** in the pane-actions menu (right-click the pane header) — pane renaming no longer requires knowing the double-click gesture. (#1026)

### Changed

- **The pane header collapses its action buttons into a menu on a narrow
  pane.** The split / browser / stash / zoom cluster is fixed-width, so below
  roughly 220px it was squeezing the tab strip — the coordinate, the title and
  the ✕ — down to nothing, leaving a header that was all buttons and no
  identity. Such a pane now shows a single `⋮` that opens the same five actions
  as a vertical menu: one button's worth of chrome instead of five. The `⋮`
  stays however narrow the pane gets — the tab strip scrolls, so the pane's
  identity is never lost to it, and the menu holds the ways out of a layout
  that cramped (zoom, stash). **Right-clicking a pane header opens the same
  menu at any width**, so the actions are never more than one click away.

  This matters most where it used to hurt most: a crowded layout is exactly when
  you want stash and zoom, and one of the five — adding a browser tab to *this*
  pane — had no other entry point at all. The palette's Open Browser splits off
  a new pane, which is the opposite of what a cramped layout is asking for.

- The pane header no longer shows the auto label (`w2-1`) on a pane with a single tab and no custom name — the tab title already says it. Naming the pane, adding a second tab, or opening the rename editor brings it back. (#1021, #1026)

### Fixed

- **Chinese IME candidate window no longer jumps to wherever a streaming
  agent parked its cursor.** Typing Chinese (WeChat IME, Microsoft Pinyin)
  while Claude Code streamed output anchored the candidate window to the
  TUI's repaint cursor — a screen corner or an output row — because a cursor
  that sat still for 32 ms was trusted as the caret, and a streaming TUI
  parks its cursor between output bursts far longer than that. The anchor
  now tracks output recency: while output is streaming, the composition
  anchors to the cell the cursor held through the last output-quiet period —
  the input line the TUI deliberately parked it on — instead of trusting
  stillness alone. Ordinary typing into a quiet pane is unaffected, and the
  IME diagnostic log (`ime-anchor3` → `ime-anchor4`) now records the output
  gap and snapshot age so a follow-up report is self-diagnosing. (#951)

- **A replayed pane no longer overwrites your clipboard.** Reconnecting a pane,
  resyncing it, or restoring its scrollback writes stored output back into the
  terminal — and any OSC 52 clipboard write inside those bytes was executed
  again, silently replacing whatever you had just copied with text from
  whenever that output was produced. Since the ring buffer outlives the session
  that produced it, this could resurrect a copy from days earlier, including
  one you would not want back. The clipboard bridge is now closed while
  historical bytes are parsed and open for everything live, so a copy made
  during a resync still lands.

- **`setup-hooks` no longer removes a hook of your own that shares a matcher
  group with wmux's.** Claude Code allows several commands under one matcher.
  If you had added yours next to wmux's, `wmux setup-hooks --remove` took yours
  with it — and so did every reinstall, including the bridge refresh that runs
  on app update. Removal now drops only the wmux command and leaves the group,
  its matcher, and your commands in place. Hooks in groups of their own were
  never affected. (#1008)

- **Splitting a pane no longer replays the conversation you were reading.** The
  split rebuilt the surviving pane's terminal from scratch, so the daemon's
  scrollback arrived in chunks and you watched the whole session scroll past
  from the top before settling at the bottom. Nothing had restarted — only the
  view was thrown away — so the terminal is now handed to the new layout intact,
  buffer and scroll position included. Dragging a pane and closing a pane that
  collapses a split reached the same flash, and are fixed with it. (#1010)

- **A pane could get stuck showing "running" forever after its turn actually
  ended.** The byte-silence fallback that clears a stale `running` back to
  `idle` deferred to any precise `waiting`/`complete` status set in the last
  10 seconds — but nothing stopped a short burst afterward (a final chrome
  repaint, a keystroke echo) from overwriting that correct status with
  `running` first. Once that happened the same 10-second window blocked the
  only thing that could undo it, and a quiet pane never produces another
  burst to retry. The clear now goes through whenever `running` is the status
  actually showing, precise or not. (#1013)

- **Chinese IME candidate window now anchors to Claude Code's input box
  while output streams.** The quiet-caret snapshot shipped for #951 could
  itself capture the streaming cursor's parking spot (the end of whatever
  the last frame painted — any column), because Claude Code never parks its
  cursor on the input caret mid-stream. Compositions started during
  streaming now find the input line by content — the `│ > ` prompt row
  under its box border — and anchor there, outranking every cursor-derived
  source. Idle panes keep the field-verified cursor behavior unchanged, and
  the IME diagnostic (`ime-anchor4` → `ime-anchor5`) records when the
  content scan was used. (#1016)

- **"Token expired" clears itself once you log back in.** The Anthropic usage
  meter stopped polling the moment Anthropic refused its token, so the titlebar
  kept reading `Token expired — log in to Claude Code again` after a successful
  re-login — there was nothing left running to notice. It now keeps looking, and
  the notice goes away on its own within a few minutes of Claude Code writing a
  new token. It still will not sit there re-sending a credential it already
  knows is bad: while the notice stands, a check that finds the same token on
  disk stops before the request, and a genuine retry happens no more often than
  the ordinary hourly check would have — so a refusal that was never about your
  token clears itself too. The refresh button still forces a real attempt
  whenever you want one. (#1024)

## [3.46.0] — 2026-08-22

### Added

- **`wmux setup-hooks --signals-only` installs the lifecycle signals without
  the per-tool-call permission gate.** The remote-approval gate is a wide
  `PreToolUse` hook, so Claude Code spawns the bridge on every single tool call
  — ~120 ms on Windows 11, of which ~85 ms is bare `node` startup. That cost
  cannot be optimised away once the hook is registered, and `gatedTools: []`
  does not help: a policy of "gate nothing" still spawns the process that asks.
  It buys nothing for a terminal-only operator either, because both things the
  wide hook does need a web surface — approvals arm only under
  `wmux web --allow-input`, and the tool-name liveness it feeds is fanned out
  only to web clients. `--signals-only` installs the turn-boundary signals and
  the approval-card pair and stops there; `--with-gate` puts the gate back. The
  profile is derived from `settings.json` rather than stored beside it, so a
  bare `wmux setup-hooks` — the app-update refresh and the in-app install
  button included — keeps whatever is already installed instead of quietly
  re-adding the gate.

- **`wmux web --allow-input` now says when the permission-gate hook is
  missing.** Enabling input is what arms the gate, so it is the only place that
  can catch a signals-only install: without the hook no tool call ever raises
  an approval, and nothing else reports it — the phone simply never rings.
  `wmux setup-hooks --status` also stops calling an absent gate a defect when
  the signals-only profile is the reason it is absent.

- **A `Matrix` terminal palette** — phosphor green on green-tinted black, in
  Settings → Terminal Palette. Green carries the identity (foreground, cursor,
  the green slot and a green-cast white), but red and yellow keep their warmth
  so a failing test, a removed diff line and a warning still read as
  themselves, and blue/cyan/magenta are separated on the hue wheel rather than
  collapsed into green, so `ls` can still tell a directory from an executable.

### Changed

- **The agent roster spends its width on the name, not on repetition.** In a
  workspace where every session runs the same agent, the vendor name is no
  longer printed on each row — it returns as soon as a workspace mixes vendors,
  which is when it answers something. Polish status labels lost their "Agent "
  prefix (the row already names the agent) and gained the missing
  awaiting-input label, which had been falling back to English.

### Fixed

- **A pane reports that it is working when the agent starts a turn by itself.**
  A background task finishes, the agent picks up and works for a minute — and
  the pane kept wearing the previous turn's `complete` for the whole thing,
  because the only two things that could start a turn were you pressing Enter
  and a hook that a plugin-less install does not wire. Byte activity now counts
  while a pane is settled, held back by a cool-down after the turn end, by your
  own keystrokes still echoing, and by a resize still repainting. A pane waiting
  on an approval is left alone: only answering it retires a question.

- **A pane's own overlays can no longer paint over app chrome.** The pane box
  did not contain its layering, so anything inside one — a decoration badge, a
  terminal find bar — could land on top of a dialog or an overlay elsewhere in
  the app. Panes now stack independently, and the terminal's right-click menu
  opens above everything instead of being clipped or misplaced by the pane
  around it.

- **"Don't ask again" now sticks on the Claude Code hook-install prompt.**
  Dismissing the modal only ever hid it for that process, so anyone who had
  decided against installing hooks was asked again on every launch and on every
  raise of agent mode. The prompt now carries a durable refusal that survives
  restart and upgrade and silences both of those moments. "Later" is unchanged —
  it hides that showing, and raising agent mode still warns you that lifecycle
  signals are degraded. Turn prompting back on from Settings → integration
  setup. (#968)

- **The in-app update installs again.** Clicking "Install now" downloaded and
  verified the release, restarted wmux, and came back on the old version — with
  Settings still offering an install that then did nothing at all until the app
  was restarted by hand. The installer is launched by a detached waiter that
  refuses to run until every process under the install root is gone, and wmux
  was holding that root open itself: the handoff force-killed every `wmux.exe`
  under the root except the daemon, and on Windows our own renderer, GPU and
  utility processes are that same `wmux.exe`. The very next step quits, and the
  quit handler waits for a session save in the renderer that was just killed, so
  the quit never finished. The main process stayed alive for a full day across
  two attempts, holding the tree the waiter was waiting to see released.
  The force-kill now takes only what nothing else ends — the MCP servers, which
  run out of the install root but belong to agent hosts. Our own processes exit
  with the app, and the waiter still waits for all of them, so the installer
  still cannot start against a live tree.

- **A quit can no longer wedge the app.** The teardown's force-exit fallback was
  armed only after every teardown step had finished, so a step that never
  settled left a process that had cancelled its own quit, latched the quit flag,
  and armed no timer — alive, window-less, and ignoring taskbar clicks and
  relaunches, recoverable only by killing it. The deadline is now armed before
  anything can hang, and the renderer's session save is bounded rather than
  waited on indefinitely.

- **A refused install says so instead of going quiet.** If wmux is still running
  well after it asked to quit for an install, it now reports what happened —
  including the waiter's own reason when it left one — and clears the
  in-progress latch, so the next attempt is not answered with "an update install
  is already in progress" forever. And a retry cannot race the first attempt's
  waiter into launching the installer twice: only one waiter per install root
  ever runs — a newcomer finds a live incumbent and yields to it.

- **The install waiter no longer goes blind after 24 days of uptime.** Its
  budget was measured with a 32-bit millisecond counter that wraps and turns
  negative, at which point the remaining time overflowed, the wait threw, the
  error was swallowed, and the whole guard silently became a no-op. It is
  measured with a monotonic clock now.

- **Terminal colour overrides survive a restart.** Customising individual ANSI
  colours on top of a palette preset (Settings → Terminal Palette → Customize
  terminal colors) worked for the rest of the session and was then lost at the
  next launch: the custom-theme migration that runs on every session load
  rebuilt the theme from a fixed field list that did not include the overrides,
  while documenting itself as idempotent. The preset id survived, so only users
  who tuned individual colours were affected.

- **"Needs input" is translated again.** The status that means an agent is
  blocked waiting for you was missing from every locale but English, Korean and
  Chinese, so in the other nineteen it rendered in English inside an otherwise
  translated sidebar — the one status a user has to act on being the one that
  looked out of place.

- **An update you already downloaded is no longer downloaded again.** The
  verified installer's path lived only in memory, so a restart — or an install
  that aborted — forgot about the ~150 MB Setup.exe sitting in temp, and the
  cleanup sweep deleted it a day later. wmux now recognizes an installer it
  already has, re-checks its SHA-256 against the current manifest before
  trusting it, and keeps the installer for the version you have not taken yet.

- **An installer is checked again in the moment it is run.** Verification used
  to happen when an update was found, and the install could be days later —
  long enough for the file in the shared temp directory to become a different
  file. wmux now re-checks the bytes against the release digest immediately
  before handing them to the installer, and refuses to run them if they do not
  match.

- **A shortcut repair that could not run no longer reports success.** If
  Windows refused the COM object the icon-repair pass used, the pass quietly
  reported "nothing needed fixing" — so a taskbar icon that stayed blank after
  an update left no trace of why. The pass now says it failed — whether COM
  was refused outright or not one shortcut could be opened — retries a refused
  COM object once inside the same time budget, and writes what Windows
  returned to the install log.

## [3.45.0] — 2026-08-21

### Added

- **The unread-glow dim is now adjustable.** A pane holding an unvisited
  notification used to drop to 60% opacity — "the inactive terminal is
  shadowed" — which made a session you were monitoring harder to read at the
  exact moment it produced output. Settings → Notifications now has an
  "Unread pane brightness" slider: 100% removes the shadowing entirely (the
  colored border glow still marks the unread pane), 60% keeps the classic
  look, and the default is unchanged. (#960)

### Fixed

- **The roster no longer reads a working pane as waiting.** Claude Code's
  `bypass permissions on` footer is on screen for the whole turn in
  bypass-permissions mode, and the detector read every repaint of it as
  "ready for input" — which put a false `waiting` on the pane's roster row
  and inflated the "N need you" chip while the agent was still working. Once a
  pane's hook bridge has claimed that pane's lifecycle, the Stop signal owns the
  lifecycle status outright, on both the local and the packaged daemon path.
  Approval prompts (`awaiting_input`) are unaffected, and a pane whose hook has
  not claimed the lifecycle — no bridge at all, or one that has only announced
  itself — keeps the detector as its backstop.

  Note for anyone running a mixed pair: on the packaged daemon path the fix
  rides the daemon's own arbitration stamp, so an older daemon with a newer
  app does not get it until both are updated. (#935, #939)

- **Claude Code panes are detected again.** The Claude gate needed its footer
  spelled with literal spaces on a line of its own. The shipping product
  (measured on v2.1.235) provides neither: spaces are cursor advances
  (`ESC[1C`), so the footer strips to `bypasspermissionson`, and the whole
  bottom region — input box, statusline, footer — arrives as one newline-free
  run whose rows are placed with cursor-position escapes. The gate therefore
  never opened on a real Claude pane, which quietly disabled every Claude
  detector pattern, `waiting` and the approval `awaiting_input` regexes alike.
  Whitespace is now optional in the footer fragments (the same treatment the
  banner pattern already carried) and candidate lines are cut on row-position
  escapes as well as newlines. (#935)

- **A freshly launched agent no longer reads as busy.** Hook authority answers
  "a bridge speaks for this pane", which is not the same as "the hook has
  claimed this pane's lifecycle". A bridge that had sent only `SessionStart`
  suppressed the detector's true "ready for input" read, leaving the pane on
  the gate's one-shot `running` until its first turn ended. The status veto now
  waits for the hook to actually take the lifecycle over. (#935)

- **Korean IME no longer paints the composing syllable over the one just
  committed.** Since v3.42.0, typing Korean showed syllables disappearing as
  you typed (`대한민국` read `대한국` until the composition ended) — the
  candidate-window pin introduced for Chinese/Japanese IMEs dragged the whole
  helper container, inline preedit included, back onto committed cells. The
  pin now holds only the hidden textarea that anchors the candidate window,
  while the visible inline preedit stays on the live cursor, so Korean input
  reads correctly keystroke by keystroke and the Chinese/Japanese
  candidate-window behavior is unchanged. The IME diagnostic log (now
  `ime-anchor2` → `ime-anchor3`) also records mid-composition and
  composition-end corrections when they change, so a future report of this
  family is self-diagnosing. (#945)

- **The perf gate's frame-budget metrics are judged in frames, so a two-frame
  measurement no longer passes by a rounding accident.**
  `frameBudget.*.frameDeltaMs.p95` only ever lands on whole frame intervals,
  and the old rule — "more than 2x the blessed baseline" — put its threshold
  at exactly the top of the two-frame cluster. Every two-frame run passed
  because the comparison was strictly-greater, not because it was judged. It
  also meant a baseline blessed from a slow run quietly doubled the allowance.
  The rule is now "at most one frame interval above the baseline", which
  reaches the same verdict on every one of the 648 samples in the recorded
  trend while resting on the measurement instead of on where a threshold
  happened to fall. (#947)

- **A red perf gate no longer describes its confirmation re-run as an
  independent measurement.** The re-run happens on the same runner, so it can
  tell a passing spike from a repeatable one but cannot clear a machine that
  was slow for its whole life — which is what happened before v3.44.0 was
  tagged, where the same commit measured clean on a fresh runner twenty
  minutes later. The summary and the failure line now say "same runner" and
  say what that does and does not prove. (#947)

- **Codex panes no longer show a second blinking cursor on the status
  line.** Codex ends some of its synchronized-output frames with the
  hardware cursor visibly parked after the model/cwd status text or next to
  the "Working" spinner, and the terminal faithfully painted it there for a
  frame or two — quasi-periodic flashes that read as a second caret blinking
  alongside the composer's. The cursor is now rendered only at rest: frame
  traffic hides it, and it reappears 32 ms after the last frame — at the
  composer, where the resting position actually is. Classic TUIs (vim, less,
  htop) never bracket frames, so their cursor behavior is unchanged. (#954)

- **Restored history no longer draws garbled after a restart.** When a pane
  came back from a dead-process recovery (daemon restart or the local
  scrollback cache), the restored screen stayed in the viewport while the
  freshly spawned shell's coordinates started from row 1 — so typed input and
  PSReadLine repaints landed on top of the restored text, overlapping it until
  a `clear`. The restored screen now scrolls fully into scrollback before the
  new prompt paints: the prompt starts on a clean viewport, and the history —
  commands included — sits intact one wheel-notch above. (#955)

- **A pane's attention ring no longer draws on top of menus and modals.** The
  green completed-blink ring, the notification pulse, and the pane flash sat
  at overlay-level z-index without a containing stacking context, so a pane
  that lit up could paint its ring straight across the new-workspace picker
  (and the flash briefly over any modal). The decorations now sit above
  everything inside their pane and below all app chrome. (#956)

- **An approved plugin can no longer read another workspace's private
  activity by naming it.** The iframe plugin host dispatches through the same
  trusted in-process channel as the app's own UI, and two read paths —
  `events.poll` (private `a2a.task` / channel events) and the a2a channel /
  mission reads — treated that shared channel as "the operator", so a plugin
  granted an ordinary read capability could aim those reads at any workspace
  by passing its id (or omitting one). Both paths now bind such a plugin to
  the workspace it is actually hosted in, matching the scope its approval
  implied; an unbound plugin read fails closed. This confines an approved
  plugin — it is not a defense against hostile same-user code, and external
  (non-plugin) callers are unchanged. (#959)

- **A perf-gate red that reproduces on its own runner is now confirmed on a
  fresh machine before it blocks anything.** The in-job re-run can absorb a
  transient spike but cannot tell a real regression from a runner degraded for
  its whole lifetime — three activations on `main` showed reds that a
  different machine could not reproduce, and only a human clicking "re-run all
  jobs" resolved them. That click is now a dependent CI job: reproduced reds
  escalate to a fresh runner whose verdict is the gate's — green with the
  reasoning on record when the failure cannot be measured elsewhere, red on
  the strongest evidence the pipeline can produce when it can. Correctness
  failures and harness errors still fail closed on the spot. (#961)

### Security

- **A UI plugin can no longer point most browser calls at a workspace you are
  not in.** An approved iframe plugin could already only *watch* the active
  workspace — its event feed has been scoped since #719 — but its own
  `browser.*` calls were forwarded with whatever workspace id the plugin chose.
  The workspace the plugin host is showing now travels with each request on its
  own channel, out of the plugin's reach: a browser call that names a different
  workspace is refused, one that names none resolves to the workspace hosting
  the plugin instead of being rejected as unresolved, and a plugin whose host
  has no active workspace is refused rather than falling back to naming its own.
  This covers the browser methods that resolve a target — navigation,
  evaluation, extraction, input, capture and the rest. Opening and closing
  browser surfaces (`browser.open`, `browser.close`) resolve their workspace on
  a different path and are **not** covered yet; that is the next step on #922.
  Either way this confines an approved plugin to the scope its approval implied
  — it is not a defence against hostile code already running as your user, and
  callers on the local RPC wire are unchanged. (#941)

## [3.44.0] — 2026-08-18

### Added

- **An opt-in `+` for a second terminal in the same pane.** Settings → Terminal
  → "New-terminal button on the tab strip", off by default and labeled
  experimental: wmux is built around one pane = one terminal, and splitting is
  the usual way to get another. Turning it on is choosing to work differently,
  which is why it is a setting rather than new chrome for everyone (#909).

- **Grok is a first-class agent.** The detector recognizes the Grok TUI (startup banner, Help improve Grok, live composer `Grok 4.6 (high) · always-approve`) and the roster / pane names show Grok instead of a generic terminal. (#916)

- **Settings has a search field.** Type a label, a description, or a synonym (`커서`, `언어`, `mcp`) and jump to the control instead of walking the nine tabs. Esc clears the query first, then closes Settings. (#921, #925)

- **Terminal cursor shape is a setting.** Settings → Appearance offers Block, Underline, or Bar. Block stays the default. The change applies live and survives restart. (#920, #925)

- Workspaces can carry an optional color tag (right-click a workspace →
  **Color tag**). The color shows as a rail on the sidebar row and on the 48px
  mini-rail, so a long list of same-shaped names stays scannable. Purely
  visual — the agent status dot, git lights and badges keep their meanings.

- The wmux web browser terminal now supports select-to-copy, Ctrl+C-with-selection
  copy, Ctrl+V paste, and Shift+Enter / Ctrl+Enter newline, matching the local
  terminal and the attach mirror (#924, #931).

- Copy/paste/newline handling now works in the split view as well as the 1-up
  view — both share the same key-decision wiring, so Ctrl+C with a selection
  copies in a tile instead of SIGINT'ing that pane's process (#931).

### Changed

- The sidebar company panel, Missions section, workspace account submenu,
  workspace search, editor/file-tree panels, and the error boundary now
  respect the selected locale instead of showing hardcoded English (#912).

- Toast, notification panel, onboarding overlay, status bar, usage meter,
  deck fleet, diff panel, channel-create modal, the multiview close button,
  the orchestrator model chip, and the approval dialogs now respect the
  selected locale instead of showing hardcoded English (#913).

- Relative timestamps ("5m ago") are localised along with the rest of the
  interface (#913).

- **Settings tabs are grouped and renamed.** The same nine tabs, now under App / Agents / System. Claude Integration is labeled Accounts; LAN Link is labeled Network. Existing controls are unchanged — language is still the full locale list. (#925)

- The workspace agent roster now leads with each session's terminal title
  instead of the vendor name, so a workspace running several Claude Code
  sessions no longer renders as a column of identical "Claude Code · w2-1xx"
  rows. The vendor moves to the muted trailer next to the pane coordinate, and
  a session whose terminal has no title still leads with the vendor name as
  before.

- **The agent verbs are one toolbar again, and it appears when you reach for
  it.** Attach, files, snippets, rich input (⌘G), Broadcast, Multi Task, and
  new conversation are back on a single bar instead of split across the pane
  tab cluster and the workspace card. The bar overlays the terminals rather
  than taking a row from them, so nothing shrinks and no terminal is resized
  when it appears — it slides up when the pointer nears the bottom edge and
  retreats when you go back to typing. It will not appear while you are
  dragging out a selection, and it stays put once your cursor is on it. Pin it
  from the lock button (or ⌘K) to keep it open all the time. (#937)

- **The collapsed deck no longer costs a column.** The vertical strip of icons
  on the right edge is gone; one `«` / `»` button beside Settings opens and
  closes the deck, and the terminals now run to the window edge while it is
  closed. A dot appears on that button when the closed deck holds unread
  channels or dirty worktrees. (#937)

### Fixed

- The Shortcuts list said `Ctrl+T` was "New workspace". It is not — `Ctrl+T`
  adds a terminal to the pane you are in, and the key that makes a workspace is
  `Ctrl+N`, which the list did not mention at all. Both rows now say what the
  keys do (#909).

- **Mouse clicks and wheel now reach vim and other TUIs on Windows 10.** The in-box ConPTY on Windows 10 (and Server 2022) never forwards the escape sequences that turn on mouse reporting, so `set mouse=a` in vim silently did nothing — the wheel scrolled wmux's own scrollback instead. Those builds now spawn their panes against the OpenConsole build bundled with wmux, which forwards mouse events correctly. Windows 11 is untouched. Every spawn logs which ConPTY backend actually started. If the bundled one cannot start, wmux retries once and then falls back to the previous behaviour — the shell still opens, and the log says the pane has no mouse reporting.

- A translated string whose interpolated value contained `$&`, `$$`, ``$` `` or
  `$'` came out corrupted — the placeholder reappeared verbatim instead of
  being replaced. Crash messages carry a raw `Error.message` and channel names
  carry agent-authored titles, so any of those could reach it (#913).

- An approval prompt or crash screen already on display now follows a locale
  change instead of staying in the previous language (#913).

- **Grok panes no longer show up as Claude Code.** A Grok TUI that reads this repo (or any file quoting Claude's banner/footer) used to trip Claude's compound gate. Identity now requires per-line TUI chrome, and another agent's status patterns cannot steal the pane back. (#916)

- **Grok's transcript scrolls with the wheel.** Grok runs in the alt screen, so xterm had no scrollback. The wheel now sends PageUp/PageDown, which is how Grok itself scrolls. (#916)

- **A mirrored remote pane now copies, pastes, and inserts newlines like any
  other terminal.** Attaching to a remote wmux gave you a pane that forwarded
  every keystroke straight through, so the editing habits that never leave your
  own machine stopped working: selecting text copied nothing, `Ctrl+C` over a
  selection interrupted the remote process instead of copying it, `Ctrl+V` did
  nothing at all, and `Shift+Enter` submitted where a local pane would have
  added a line. All four now behave the way they do in a local pane — including
  `⌘C` / `⌘V` on macOS — while an empty-selection `Ctrl+C` still interrupts the
  remote process, and a host started without `--allow-input` still receives
  nothing. `Shift+Enter` sends the newline form the remote app actually asked
  for: apps that enable the kitty keyboard protocol get it, and anything else
  keeps the plain carriage return it has always received. (#924)

- **A plugin no longer goes silent when you switch workspace.** The host hands
  each plugin iframe a message port once, when the frame loads. Re-subscribing
  the plugin event feed on a workspace switch also tore that port down, and
  there is no second load to rebuild it — so from the first switch onward the
  plugin's requests were dropped and its palette commands stopped arriving. It
  affected every mounted plugin, not only the ones receiving events; sidebar
  panels came back if you collapsed and re-opened them, while status-bar
  widgets stayed broken for the rest of the session. The port now outlives the
  switch, and the event feed still follows the workspace you are in. (#928)

- Web terminal paste actually works now: xterm's keydown handler used to encode
  Ctrl+V as the SYN control byte and preventDefault, so the browser's native
  paste event never fired. The key now steps aside so the browser's own paste
  path delivers the text (#931).

- A select followed by Ctrl+C then an immediate Ctrl+V no longer freezes the
  page for tens of seconds. xterm fires `onSelectionChange` once per cell during
  a drag, so select-to-copy was issuing a burst of concurrent clipboard writes;
  the write is now debounced to the settled selection like the desktop's
  `autoSelectionCopy.ts`. An explicit Ctrl+C also cancels any pending auto-copy
  so the two never race (#931).

- Ctrl+D now behaves like a real terminal again: it sends EOF (exits a shell,
  ends `cat > file`), matching the desktop and every other terminal, instead of
  being swallowed by the browser page (#931).

- Shift+Enter no longer corrupts apps that never negotiated the kitty keyboard
  protocol. The CSI-u byte (`\x1b[13;2u`) only means "newline" to an app that
  asked for kitty encodings; the browser now watches each pane's output for the
  negotiation and falls back to a plain Enter for panes that did not — so vim
  no longer exits insert mode and runs `u` as undo (#931, same gate as the
  attach mirror in #924).

- Shift+Enter / Ctrl+Enter / Ctrl+J no longer cause a `bash: syntax error` in a
  shell that does not speak the kitty keyboard protocol. The newline decision
  now `preventDefault`s the browser's own newline, which xterm's `input` handler
  would otherwise forward to the PTY right after the newline byte (#931).

- Copying no longer steals keyboard focus: the legacy clipboard fallback restores
  the previously focused element, and a click on any page control (buttons wrap
  their label/icon in a SPAN or SVG) no longer yanks focus into the terminal
  (#931).

- **A pane's agent label now prefers process truth over screen text.** The
  label, roster entry, and status events for a pane are decided by a
  precedence of signals — a corroborated or fresh hook self-report first, then
  the live attributed agent process, and only then what the terminal happened
  to print. Screen text still names the pane when nothing stronger is
  available, which is what remote and SSH panes rely on. A confirmed-dead
  same-slug read on screen is treated as sticky residue instead of relabeling
  the dead agent "alive". This fixes the class of mislabels where a Grok pane
  was shown as Claude: the screen gates cannot tell an agent from a sentence
  about an agent, and until now they were the only identity source. (#932)

- **Detector notifications contradicted by a live agent of another kind are
  suppressed.** A screen-detected "agent finished" that disagrees with the
  pane's hook- or process-backed identity no longer notifies, and the pane's
  label self-heals on the next output burst. A banner this build cannot map to
  a known agent is not treated as a disagreement, so an unrecognised name never
  costs a pane its status updates. The 30-minute detector veto is scoped to the
  agent launch that earned it and expires when that process is seen to die, so
  a relaunched agent with broken hooks gets its completions through. (#932)

- **The file browser inserted nothing.** Clicking a file closed the popover
  before the click could take effect, so picking a path silently did nothing.
  (#937)

- **Multi Task's dialog no longer overflows its own card.** The per-task row
  squeezed the title field to a sliver and pushed the branch name outside the
  dialog; the dialog also opened against the left edge of the window instead of
  under the button, and was tall enough to cut off the repo field and the
  Launch button. Launch now stays pinned while the form scrolls. (#937)

- **New conversation asks twice.** The button sends `/clear`, which discards
  the agent's conversation, and a single stray click was enough to fire it.
  (#937)

- **⌘G opened two compose boxes at once.** (#937)

- **The toolbar no longer floats over a remote workspace view**, where its
  buttons would have typed into a local terminal you could not see. (#937)

## [3.43.0] — 2026-08-16

### Added

- A2A thread round cap: replies past 5 completed round trips — or past a per-side
  message ceiling that catches one-sided monologues — are refused with a
  `cap_reached` error so two agents cannot ping-pong unattended forever.

- `a2a_discover` responses include `elapsedMs` (measured at the MCP tool entry)
  to separate server latency from client-side stalls.

- **A glyph rail where the collapsed deck was.** Collapsing the deck leaves a
  36px column of the same icons on its edge instead of nothing at all; pressing
  one reopens the deck straight onto that tab, and the rail marks the tab it
  will return to.

- **The orchestrator can fan work out into isolated worktrees.** Its only
  worker used to be a pane split into the same checkout, so two workers editing
  at once overwrote each other and shared one branch — and with no shell, it
  could not create a worktree any other way. `fanout_start` is now on the
  commander surface: one call, N tasks, each on its own `wtask/` branch with its
  own workspace, agent pane and mission channel. The user is still asked to
  approve before anything spawns, and never auto-approved. (#891)

- **Fan-out tasks can run on different agents and models.** Each task takes an
  optional role — Builder, Reviewer, Tester, Planner — and launches on whatever
  agent and model you bound that role to in Settings. Review work can run on
  Codex, or a cheaper model, while the build tasks in the same fan-out run on
  Claude. The approval prompt now spells out what each role resolves to, so the
  text you approve is the command that runs. Available from the Multi Task
  dialog as well. (#891)

- **wmux now tells you when the plugin is the thing that is broken.** If a
  Claude Code plugin install is still running the hook that forces a prompt,
  a notice appears with the exact update command, and it stays up until you
  dismiss it. Version numbers could not answer this question — the plugin's
  version did not change across the release that introduced the permission
  gate, so `claude plugin update` reported "already at the latest version" for
  broken and healthy installs alike — so wmux runs the installed hook on a path
  that touches nothing and watches what it answers. wmux reads the plugin
  directory and never writes to it: repairing another tool's cache would leave
  content that does not match the version on the directory, and could downgrade
  a plugin newer than the app. (#898)

- **An orchestrator can wait for a pane instead of watching it.** `wmux_events_poll`
  takes `blockMs` to wait for an event rather than returning an empty page, plus
  `ptyId` and `kinds` to narrow it to one pane and one kind of signal. Until now
  the only way to notice that another agent had stopped on a question was to read
  its terminal on a timer and guess from the text — and a question an agent
  *printed* looks exactly like one it is *waiting on*, which is where most false
  "this agent is stuck" reports came from. A wait now ends the moment that pane
  actually blocks, and a nested subagent returning no longer counts as the pane
  becoming free. Existing callers are unaffected: every new parameter defaults to
  the old behavior. (#903)

### Changed

- **The deck's tabs are icons.** The deck's header used to read
  `Agent (Default) | Git | Channels` — three text labels across the top of a
  column barely 250px wide. They are 36px glyphs now; the tab's name, and the
  orchestrator's current model, are in the tooltip.

- **Agent, Git, Channels and web left the sidebar.** The deck sits on the
  opposite edge from the workspace list, so as labeled rows at that list's foot
  they cost 144px pointing the wrong way — and vanished whenever the sidebar was
  collapsed. All four are glyphs on the deck's own strip now (the first three
  select a tab, web opens its popover as before), and the workspace list got the
  space back.

- The sidebar **+ menu** and Settings (Accounts, MCP servers, Theme) now
  respect the selected locale instead of showing hardcoded English (#911).

### Fixed

- **Prefix-action labels for Rename/Kill workspace and Show cheat sheet now
  translate.** Three `settings.prefix.*` keys were missing from both `en.ts`
  and `zh.ts`, so the Settings → Shortcuts → Prefix bindings rows rendered raw
  key strings; they now show proper English and Simplified Chinese. (#886)

- A2A replies no longer fail silently: `a2a_task_send` now returns a `delivery`
  field (`stored` / `notified` / `reason` / `hint`) that says whether the other
  party was actually nudged and, if not, why and what to do about it. A reply
  whose nudge is withheld also emits the task pointer event, so a polling
  receiver still learns the thread moved.

- **The IME candidate window now anchors to where you are typing, not where the
  agent's redraw parked the cursor.** The v3.42.0 fix pinned the candidate list
  in place for a whole composition, but it pinned it to wherever the terminal
  cursor happened to sit at the instant the composition started — and while a
  TUI like Claude Code repaints, the cursor transiently rides along with the
  redraw. Start typing Chinese, Japanese, or Korean in that instant and the
  candidate list landed on the status line or the agent's streaming row instead
  of the input box. wmux now tracks the cell the cursor actually rests on
  between repaints and anchors compositions there, so the candidate list stays
  on your caret even when a composition starts mid-redraw. (#874)

- **The web popover stays on screen.** Opened from low on the rail in a short
  window it used to run past the bottom edge, taking the Stop button with it.

- Counts on the deck's glyphs (unread channels, dirty worktrees) are announced
  to screen readers again — as icons they had become badges with no spoken
  equivalent.

- **You can scroll the browser terminal with your finger.** On a phone there was
  no way to reach scrollback at all: a swipe did nothing, the thin scrollbar
  could not be dragged by touch, and a soft keyboard has no `Shift+PageUp`. The
  only history a phone ever showed was whatever was on screen when it connected.
  Swiping now scrolls, and on a pane running a full-screen app — where there is
  no scrollback to move — the swipe scrolls that app instead. (#890)

- **The mouse wheel reaches scrollback again.** One notch moved exactly one line
  in the browser terminal, so a few hundred lines of history meant a few hundred
  notches. This affects any device with a wheel, not only phones.

- The browser terminal's scrollbar is toned into the chrome again. It had been
  drawing xterm's default light bar since the terminal upgrade moved where the
  scrollbar lives.

- **The Claude Code plugin no longer asks permission for everything.** With the
  plugin installed, a session started with bypass-permissions was asked to
  approve every single tool call — even reading a file. Restarting did not help,
  changing the permission mode did not help, and turning the gate off with
  `WMUX_GATE=0` did not help either, so there was no way out short of
  uninstalling. The permission gate was answering "ask the user" whenever wmux
  had no opinion — the gate switched off, no daemon reachable, a tool wmux does
  not gate at all — on the understanding that it meant "I have no opinion".
  It does not: it forces a prompt and overrides the permission mode you chose.
  The gate now stays silent unless there is a real verdict, which is what
  actually hands the call back to Claude Code's own permission flow. (#898)

  **If you installed the plugin through Claude Code, run `/plugin update` after
  updating wmux.** The hook that was answering "ask" is a file inside the
  plugin's own directory, and updating the app does not touch it — a wmux update
  alone leaves the prompting exactly where it was. Installations made with
  `wmux setup-hooks` need nothing: that copy is refreshed the next time the app
  starts. (#898)

- **Lines no longer misalign when you resize a pane on Windows 10.** The
  terminal told xterm that every Windows machine was running a recent ConPTY,
  by passing the exact build number xterm uses as its cut-off rather than the
  build the machine is actually on. That turns on reflow and turns off the
  compensation for older ConPTY at the same time, which is the wrong half of
  both on Windows 10. wmux now reads the real build number.

  Windows 10 therefore moves onto xterm's older-ConPTY path, which is what that
  build actually needs, and reflow is off there instead of on. Reflow being on
  was also suppressing the spurious row-change events ConPTY emits on resize,
  which helped keep a drag-selection alive while the pane was being resized, so
  on Windows 10 that selection is now held by the resize guard alone. Windows 11
  is unaffected — it was already on the branch it is on now. (#897)

- **A long CJK or TUI session no longer leaves its panes permanently
  slower.** Terminals sharing a font share one WebGL glyph atlas. Once
  that atlas had to reclaim space it set a "rebuild your render model"
  flag that nothing ever cleared, so from then on every pane sharing it
  rebuilt its entire model on every frame, for the rest of the run. Each
  pane now rebuilds once per reclaim instead of once per frame.

  Two defects in the reclaim itself go with it: clearing the atlas gave up
  as soon as its first page looked untouched, so an atlas whose first page
  happened to be idle while the rest were full cleared nothing at all; and
  it could hand the shader more pages than the shader is able to sample.
  The safety net that has been covering for this still runs, and should
  now almost never have to.

- **The Anthropic 5h / 7d utilization setting now survives app restarts.**
  The toggle used to update only the running app, so every new launch silently
  turned the status-bar meter off again. wmux now remembers the explicit opt-in
  and resumes usage polling after restoring the session. Older or malformed
  session files still default safely to off. (#906)

- **The "work finished" alarm now fires only when a turn has actually ended.**
  Previously the completion toast fired on raw stop-shaped signals the moment
  they arrived — a `Stop` hook while a background build was still running, a
  subagent finishing, a TUI repaint — telling you work was done when it
  wasn't. Every alarm path now runs a verdict machine: signals are normalized
  (working / attention / stop / session boundary), pass a turn gate (did the
  agent actually work this turn?), and survive a ~1.5s provisional window that
  a follow-up tool call or new output can rebut. The hook bridge also counts
  background tasks the agent started but that have not reported completion,
  and holds the alarm while they run. (#907)

- **Subagent finishes no longer toast.** A nested subagent returning to its
  parent was indistinguishable from the pane's lead turn ending; it is now
  trace-only. (#907)

- **Resize repaints cannot swallow a real completion alarm.** A pane
  switch/split used to trigger a full TUI redraw that could cancel a pending
  completion window; repaint bursts are now flagged and excluded from the
  alarm's working-evidence feed (status dots still update as before). (#907)

- **wmux now tells you when an update is ready to install.** It downloaded
  updates in the background and then said nothing, so the only way anyone found
  out was to open Settings and press "Check for updates" — which is why it
  looked like auto-update was broken on both Windows and macOS. A notice now
  appears in the bottom-right corner the moment an update is ready, names the
  version you are on and the one you would move to, and installs with one click.
  It stays put until you act on it rather than fading away. Settings shows the
  same two versions on their own lines, and its button says what it does
  ("Install now") instead of repeating the status. Installing still ends live
  sessions, and it still only happens when you say so. (#897)

- **An install that cannot proceed says so.** Pressing "Install now" and having
  it refuse — no space, an installer already consumed, a dev build — used to
  report only into the Settings panel, which is closed by definition whenever
  the notice is what you are looking at. So the button did nothing visible,
  which is the same silence the notice exists to end. (#897)

- **The Settings update widget no longer forgets a downloaded update.** A
  background check re-announces the same release every poll, and the widget
  took that as "available again" — so a ready-to-install update turned back
  into a "Check for updates" button within the hour and stayed that way. (#897)

- **The update notice is translated.** The sentence warning that installing
  closes every pane now ships in all 23 languages rather than only English,
  Korean and Chinese. (#897)

- Chinese (zh) locale catches up with the `fanout.roleLabel` /
  `fanout.roleNone` keys added in #891 (#911).

## [3.42.0] — 2026-08-14

### Added

- **Complete Simplified Chinese (中文) locale.** `zh.ts` now translates all 1,203
  keys from `en.ts` (previously ~390 / 32%). The locale was already registered and
  selectable in Settings, so no wiring changes were needed. (#876)

### Changed

- **Browser automation now refuses a call whose workspace it cannot determine.**
  A plugin or wire client that asked wmux to drive a browser page without saying
  which workspace it was calling from used to get whichever page happened to be
  registered first — possibly one in a workspace it had nothing to do with. It
  now gets a clear, non-retryable refusal instead. Callers that already send
  their workspace are unaffected, including the bundled MCP server, the `wmux`
  CLI, and the app's own UI. Set `"mcp": { "mode": "shadow" }` in
  `~/.wmux/config.json` to restore the previous behavior. (#810)

### Fixed

- **The IME candidate window now follows the terminal cursor.** Typing Chinese,
  Japanese, or Korean in a wmux pane put the candidate list in the wrong place:
  several rows off the caret whenever the terminal had been scrolled up even
  slightly, and flying around the screen while an agent streamed output. Latin
  input showed nothing because it draws no candidate window. Both came from the
  same place — xterm anchors its hidden IME textarea at the cursor's position in
  the scrollback buffer rather than its position on screen, and re-anchors it on
  every keystroke of a composition, so the candidate list chased whatever the
  agent's TUI was redrawing. wmux now corrects the anchor to the cell the cursor
  is actually painted on, and pins it in place for the duration of a
  composition so the candidate list stays put while you pick a character. (#874)

- **Daemon events no longer disappear during the subscription handshake.** The
  daemon now preserves events emitted after accepting the app's control socket
  but before its subscription request arrives, so one-shot session and channel
  transitions reach the app instead of falling into that window. (#877)

- **Daemon push events are now limited to the desktop app without losing startup
  events.** Control-pipe clients must identify as the first-party app before
  subscribing, while bounded replay and reconnect handling preserve events
  across compatible old/new client and daemon handshakes. (#878)

- **Three labels stayed in English when wmux ran in Simplified Chinese.** The
  agent toolbar's Broadcast and Multi Task buttons and the Git panel's Pull
  Requests heading were carried over verbatim from the English locale, so they
  read as English in an otherwise translated UI. (#880)

- **Minimise wmux on Windows and your phone can finally resize the session.**
  Handing PTY geometry to a phone depends on the desktop admitting nobody is
  looking at the pane, and the desktop worked that out from the browser's
  page-visibility signal — which on Windows never changes, not when the window
  is covered and not even when it is minimised. So the phone was told the desk
  owns the size forever, and the terminal it showed stayed wrapped for a window
  nobody could see. The desktop now takes that answer from the window itself:
  minimised, hidden to the tray, or screen locked all count as nobody looking,
  and restoring the window takes the geometry back. Locking your screen releases
  the size too, which is exactly when the phone is the only screen left.
  (#882, follow-up to #766)

- **Reboot-survival demos no longer contend with the parallel unit suite.**
  The real-Git J1 and J3 checks now run in the serial runtime lane, preventing
  load-sensitive Windows timeouts while preserving both standalone demo
  commands without shell execution. (#884)

## [3.41.1] — 2026-08-13

### Changed

- **Installing an update on Windows now ends running sessions, and says so
  before you press the button.** The daemon holds the install folder open, so it
  has to go down for the installer to run. The update panel previously implied
  the opposite. (#866)

- **Terminal ownership checks stop waiting on the UI.** Every MCP call an agent
  makes — sending to a pane, polling events, resolving its own identity — used
  to ask the renderer who owns a terminal, once per check. That question was
  slowest to answer exactly when the app was busiest. Main now answers from the
  workspace snapshot the renderer already pushes it, and falls back to asking
  whenever the snapshot is stale, missing, or disagrees. Cross-workspace access
  is still refused on the renderer's word, never on a cached guess. (#870)

- **Cross-pane search reads the newest output first.** `wmux_search_panes` used
  to scan up to 20,000 lines per pane starting from the oldest, so on a long
  scrollback the recent output you were actually looking for could be the part
  that got cut. It now searches the newest 5,000 lines by default, says
  `truncated: true` when older lines went unread, and takes a new optional
  `searchTailLines` to go deeper. It also yields between panes instead of
  freezing the window for the whole sweep. The in-app search bar is unaffected
  and still covers your full configured scrollback. (#871)

### Fixed

- **Running the Windows installer while wmux is open can no longer destroy the
  installation.** Squirrel's `Setup.exe` deletes the whole install folder as its
  first step, and wmux used to start it without waiting to actually exit. With
  the app fully up its loaded libraries are locked, the delete fails outright,
  and the install stops half-finished — leaving blank shortcut icons and no
  launcher to retry from. The installer is now started by a helper that waits
  until nothing is using the folder any more, and refuses to start it at all if
  something still is, so a failed update leaves your working version alone
  instead of a broken one. The normal in-app update was not affected by this;
  the failure needed the app to be fully running, as it is when the installer is
  launched by hand. (#866)

- **A failed update now says so.** If the installer could not be started safely,
  wmux reports it the next time it opens instead of leaving you on the old
  version with no explanation. (#866)

- **The daemon no longer stalls on its own log file.** Each log line was written
  and flushed to disk synchronously, which on Windows also meant a virus-scanner
  hook per line. Routine lines are now batched; warnings and errors still write
  through immediately, after the pending lines, so `daemon.log` stays in order
  and a crash still records what happened. (#871)

- **Terminal tab strips stopped re-rendering on unrelated panes.** Any pane's
  status, label, or agent change re-rendered every tab strip in the app; each
  strip now watches only its own pane. Terminal output also skips a
  per-chunk regular-expression scan it did not need. (#871)

## [3.41.0] — 2026-08-12

### Known issues

- **Windows: consider installing this release manually rather than through the
  in-app updater.** Squirrel's `Setup.exe` deletes the whole install directory as
  its first step, and the in-app updater starts it without waiting for wmux to
  finish exiting. If anything still holds that directory open when the delete
  runs, the install stops half-finished, leaving blank shortcut icons and no
  launcher to retry from. We have reproduced that failure and are fixing it, but
  we do not yet know how often the normal update path actually hits it — the
  update path has looked like this for many releases. If you would rather not
  find out, download the installer from the release page and run it with wmux
  closed. Note that the fix cannot help *this* upgrade either way: the step at
  fault belongs to the version you are upgrading from. (#866)

### Added

- **Added browser caller-scope shadow telemetry.** Target-resolving browser RPCs now record identified calls that future caller-derived workspace enforcement would refuse, without changing current routing, parameters, responses, or enforcement behavior. (#846)

- **One-shot interface visibility presets.** Apply Minimal to hide optional chrome at once, or restore the shipped Standard visibility without entering a persistent mode. (#860)

### Changed

- **The daemon control pipe no longer pushes events at clients that never asked for
  them.** Events used to reach every connection from the moment it opened, so a tool
  that wrote a request and read one line back could read an event instead of its
  reply — and since an event frame carries no error text, report a failure with an
  empty message while quietly dropping the real answer. Events are now opt-in:
  a connection gets replies and nothing else until it calls
  `daemon.events.subscribe`. Tools that only make requests, including the wmux CLI
  and the MCP server, need no change and can no longer hit that failure. A tool that
  did rely on unsolicited events must now subscribe. See `docs/PROTOCOL.md` §2.9.
  (#856)

- **Daemon cold start is roughly two seconds faster on Windows.** The LanLink
  HMAC key was the one hardening call still running synchronously on the daemon
  boot path, and the first `powershell.exe` spawn inside an Electron process
  measured 1.8–2.3 s — 75–78 % of the entire daemon startup. The replacement
  measures around 42 ms.

### Fixed

- **Scoped CLI browser navigation to its calling workspace.** `wmux browser navigate` now uses verified pane identity inside wmux instead of potentially navigating the first globally registered browser; invocations outside wmux retain the existing active-target behavior. (#845)

- **Non-agent panes (btop, vim, plain shell) no longer misidentified as AI agents in the sidebar and Fleet View.** Two independent fixes: (1) the Fleet View selector now requires per-PTY agent identity (`surfaceAgent`) before inheriting workspace-level agent name and status for the active pane — a non-agent pane in a split can no longer borrow the real agent's "Claude Code · Needs you" badge; (2) the Claude Code agent detector now uses a compound gate (banner **and** prompt evidence, matching the Kiro CLI pattern) instead of a single banner regex, so a process monitor displaying "claude" in its process list cannot falsely open the detection gate. (#850)

- **Restored approved plugin panels in packaged builds.** The production main-window CSP now permits registered `wmux-plugin:` iframe sources without broadening script or network access, preventing the panel restore loop that followed plugin approval. (#852)

- wmux now defines its own application menu instead of inheriting Electron's default one, which had been quietly owning shortcuts wmux binds. On macOS `Cmd+Shift+R` triggered Force Reload rather than renaming a workspace, and the reload dropped every attached remote workspace; `Cmd+W` closed the window instead of the active surface, and the zoom keys resized the UI instead of the terminal font. On Windows and Linux `Ctrl+R` no longer reloads when focus sits outside a terminal.

- Settings → Shortcuts lists the built-in key bindings from one shared table, so a custom keybinding that collides with `Ctrl+Shift+A`, `Ctrl+Shift+G`, `Ctrl+M`, `Ctrl+Tab` or the zoom keys is now flagged as a conflict instead of being accepted and silently never firing.

- Directories with non-ASCII names in `PATH` now resolve in wmux terminals. A path such as `D:\软件\Python312` was being read from the registry through a code-page-encoded pipe, which replaced characters the code page could not represent and left the rest as `U+FFFD`, so the directory matched nothing on disk and commands from it resolved to a later `PATH` entry instead — for Python, the Microsoft Store stub. Accented Latin characters were affected the same way.

- **Windows token files are now hardened without PowerShell — and stay hardened
  on managed machines.** The owner-only DACL on wmux's auth tokens, the LanLink
  HMAC key and the web state file used to be rebuilt by spawning
  `powershell.exe -ExecutionPolicy Bypass -EncodedCommand`. On any machine
  running PowerShell in Constrained Language Mode — the AppLocker/WDAC default
  on managed corporate fleets — that call could not run at all, and wmux quietly
  fell back to a plain `icacls` strip. The fallback removes only four well-known
  broad groups, so an explicit entry for any other principal survived: those
  machines have been running with looser token permissions than the docs promise,
  with nothing but a console warning to show for it. Hardening now writes the
  file through a fresh, pre-locked inode instead, which drops every non-owner
  entry — inherited, well-known or custom — with no PowerShell involved.

- **Norton no longer flags wmux at startup.** Norton Behavioral Protection
  detected the `-ExecutionPolicy Bypass -EncodedCommand` shape as
  `IDP.HELU.PSE85` and blocked `powershell.exe`, in some cases quarantining
  `wmux.exe` itself. wmux no longer spawns PowerShell for this, so the detection
  has nothing to fire on. Thanks to @TarJae for the report and the diagnosis.

- **A rename collision can no longer wipe your paired phones.** Token hardening
  reported success as a single boolean, which meant "could not tighten the
  permissions" and "nothing changed, and nothing got weaker" looked identical to
  callers. The LanLink peer store treats that signal as fail-closed: it deletes
  the peer file and regenerates the machine HMAC key, which invalidates the peer
  file's MAC and drops every pairing. The two states are now distinguished — and
  the safe one is verified, not assumed: a failed swap is retried, then the
  file's actual DACL is read back (`icacls /save`) and only a confirmed
  owner-only ACL avoids the fail-closed branch. A concurrent token rotation can
  no longer be overwritten by a stale hardening snapshot either — the swap
  compares content before committing and stands down if a newer write landed.

- **A stalled event subscriber can no longer grow the daemon's write buffer
  without bound.** Broadcast delivery now drops only that client's event
  subscription after its buffered output crosses the existing safety cap. The
  RPC connection stays open, and healthy subscribers continue receiving events.
  (#862)

- **A dead shortcut can no longer blank the taskbar icon after an update.**
  Windows resolves the taskbar button's icon through the shortcut carrying the
  app's AppUserModelID, so one stale link — a pre-3.4 top-level Start Menu
  entry, or a taskbar pin recorded against a deleted `app-X.Y.Z` directory —
  blanked the icon of a perfectly healthy install. The installer hooks now
  repair such links (retargeting them to the version-stable root launcher)
  instead of leaving them behind. (#863, #865)

- **Shortcut icons no longer depend on a download at install time.** The
  installer previously fetched the shortcut icon from raw.githubusercontent.com,
  which fails on networks where that host is unreachable and left shortcuts
  with no icon at all. The icon that already ships inside the package is used
  instead. (#863, #865)

### Security

- **Restricted raw browser attachment metadata.** `browser.cdp.info` now returns `cdpPort` and `shellUrl` only to operator, validated pinned, or recognized first-party wire callers; approved third-party and legacy callers retain target metadata without the raw attach primitive. Fallback-enabled browser operations continue through the workspace-scoped, lease-covered RPC lane, while operations requiring a direct Playwright page report that attachment is unavailable. (#844)

## [3.40.2] — 2026-08-10

### Security

- **Hardened privileged RPC client recognition.** The bundled-MCP and CLI allowlists now require source-qualified wire provenance, so an approved in-process UI plugin whose manifest name collides with a recognised host identity stays on its own declared permissions instead of inheriting the first-party method set. (GHSA-x2xm-9w7w-hh6p)

## [3.40.1] — 2026-08-08

### Added

- **The whole interface is now scalable from Settings.** A new **UI scale** slider in Settings → Appearance → Layout scales the sidebar, titlebar, and every chrome surface together — not just the terminal panes — so the previously hard-coded 8–12px sidebar text can be enlarged for high-DPI displays, large monitors, and accessibility. The factor persists across restarts, applies live, and keeps the native window controls (macOS traffic lights / Windows buttons) centred in the titlebar at any size. This completes the groundwork PR #824 shipped, which added the zoom plumbing behind a prototype env var with no user-facing control. (#822)

### Fixed

- **A pane you opened by hand no longer counts as an agent that is still
  working.** Agent status is stored once per workspace, so a busy agent in a
  background pane made whichever pane you had focused look busy too — including
  a plain shell that had never run an agent. The orchestrator then refused to
  close out its work, and the only way past it was to answer a question about
  clearing a status that was never true. A pane now shows as running only when
  its own terminal produced the activity. (#838)

- **A mirrored remote pane now fits its cell instead of being cropped.** The
  mirror renders the grid the remote daemon owns, but it draws with your local
  font, so a remote pane wider or taller than the cell it sits in simply ran off
  the edge and was clipped from the top-left corner. Long lines lost their right
  half, and — because a terminal app keeps its input box on the bottom rows —
  the prompt you were typing into was cut off entirely, reappearing as a sliver
  only while you typed. The mirror now shrinks its own font until the remote's
  grid fits, and grows back when the window widens.

- **A pane running OpenClaude could lose its `(openclaude)` name suffix.** One of
  the six hand-maintained agent lists was missing that one agent, so anything
  handing wmux the slug form got back "unknown" and the pane fell back to a
  generic name. Every list now derives from a single table, so an agent cannot be
  present in five places and absent from the sixth. (#841)

- **Kiro panes went undetected when the composer shared its line with other
  text.** The fallback that reads a cursor-drawn composer — one whose spaces are
  gone by the time wmux sees it — searched from the wrong end of the line and
  could never match. Kiro is now recognised in that case too. (#841)

## [3.40.0] — 2026-08-08

### Added

- **The native window controls now follow a renderer zoom.** Scaling the UI used
  to leave the macOS traffic lights and the Windows window buttons behind — they
  are drawn by the OS and do not move with the renderer, so the custom titlebar
  grew while the controls stayed put. They are now re-placed whenever the zoom
  changes, which keeps them centred in the titlebar at any scale. Nothing in the
  app zooms yet; this is the groundwork for a configurable UI size.

- **Fan-out tasks can each get their own port.** Declare `fanout.portRange`
  (e.g. `"3000-3010"`) in your repo's `wmux.json` and every task a fan-out
  spawns is assigned one free port from that window, exported to its pane as
  `WMUX_TASK_PORT`. Before this, eight tasks that all ran `npm run dev` fought
  over one port and seven of them died on startup. Ports are probed and assigned
  before any task spawns, so no two tasks in a fan-out collide — and a port just
  handed out stays claimed for ten minutes, so a second fan-out started while
  the first one's servers are still booting doesn't reuse it either. Windows are
  capped at 512 ports; if one runs out, the remaining tasks simply start without
  the variable.

- **Worktree setup hook for fan-out.** `fanout.setup` in `wmux.json` is a shell
  command run inside each freshly created worktree *before* its agent starts —
  the `cp ../../.env .` and `npm ci` you used to type into every agent's first
  turn. It is trust-gated exactly like supervised panes: the command is shown
  verbatim in the trust dialog and runs only against `wmux.json` bytes you have
  explicitly approved, so a hook arriving via a pull request is inert until you
  review it. An edit demotes the file to stale and the hook stops running. When
  a declared hook is skipped for lack of trust the fan-out says so instead of
  quietly doing nothing, and a hook that fails leaves its task unspawned with
  the worktree preserved rather than starting an agent in a half-prepared tree —
  only that task; the rest of the fan-out continues. Output is never capped (a
  chatty `npm ci` won't be killed), and a hook that hits its five-minute ceiling
  has its whole process tree killed, so a background install can't outlive it
  and keep writing into the preserved worktree.
  See `docs/how-to/fan-out-task-environment.md`.

- **Webhook and ntfy notifications, no phone app required.** Point
  `notifySinks` in `~/.wmux/config.json` at a webhook URL or an ntfy topic and
  the daemon pings it when an agent asks for an approval or finishes a turn.
  Until now the only way to hear about a blocked agent from away from the
  keyboard was the iOS app and its push relay; this is the plain-HTTP path for
  everyone else. Off unless you configure it, outbound only — the daemon opens
  no new port — and `WMUX_NOTIFY_SINKS=0` turns it off without editing config.

  ```json
  "notifySinks": [
    { "type": "ntfy", "url": "https://ntfy.sh/my-topic", "events": ["approval"] },
    { "type": "webhook", "url": "https://hooks.example/wmux" }
  ]
  ```

  The ping is deliberately thin: the event kind, a fixed title, the agent name,
  short pane and workspace id prefixes, a derived risk tier and a timestamp. It
  never carries the agent's question, tool input, terminal output, file paths or
  any id that can address a pane — the destination is a server you chose but the
  body travels in the clear, and a shared ntfy topic is not the place for your
  terminal. On ntfy the priority follows the stakes — an approval that names a
  destructive action goes out at max, an ordinary approval at high, a
  turn-completion at default — so the two never arrive looking equally urgent.
  Approvals also get their own queue, so a busy afternoon of turn-completions
  can never push out the one notification somebody is actually blocked on.

- **Your phone stops buzzing for approvals you are already looking at.** When
  the desktop app is connected and its window was focused within the last 90
  seconds, the push notification for a new approval is held back — the request
  still lands in the in-app inbox, which is the thing you were reading anyway.
  Before this, sitting at the desk answering prompts also meant a phone
  lighting up for every one of them.

  Held, not dropped. The moment you leave — the window blurs, you lock the
  screen, the machine sleeps, the app quits, or the focus report simply ages
  out because you walked away — any still-pending approval's push is delivered.
  It carries the same collapse id as the original, so the phone replaces that
  pane's banner rather than stacking a second one. An approval you answered
  while parked is dropped instead of sent.

  Every uncertainty still sends: a daemon with no desktop attached, a version
  of the app too old to report focus, an unreadable config, or a focus report
  that has gone stale all fall back to notifying. A `critical`-risk approval is
  pushed even when you are present — a destructive action is worth the second
  channel. Only the app's own process can report presence; the CLI, the MCP
  server, and anything an agent can reach are refused, so nothing can silence
  its own approval prompts.

  Configurable via `pushPresenceSuppression` in `~/.wmux/config.json`
  (`enabled`, default `true`; `staleAfterMs`, default `90000`, capped at ten
  minutes).

### Changed

- **The terminal brain's [active-work] block goes on a diet.** An unchanged block
  collapses to a one-line reminder (id + the finish-via-deck_complete_work contract)
  instead of re-typing the full objective, follow-ups, and task list onto the
  terminal every turn. Any change to the record — or a conversation reset in the
  TUI — re-sends the block in full. (#832)

### Fixed

- **A bypass-mode session no longer stops at the permission gate.** An agent
  launched with `--dangerously-skip-permissions` has already declared that it
  should never be asked, but the remote permission gate opened an approval
  record for it anyway — on every `Bash`, `Write`, `Edit`, `MultiEdit`,
  `NotebookEdit`, `Task`, and `KillShell` call. With no phone attached, each of
  those calls paused for the full gate deadline and then fell back to exactly
  the local prompt the user had opted out of, which read as "bypass mode asks
  for approval on every tool call". The gate now reads the session's live
  permission mode and lets a bypass session straight through, while the pane's
  liveness header keeps updating as before. Sessions that do still prompt —
  `acceptEdits`, `plan`, and the default mode — keep their gates unchanged.
  (#829)

- **Mirrored remote panes running a fullscreen app no longer paint a garbled
  screen.** Attaching to a pane that had been running vim, htop or an agent CLI
  for a while showed rows interleaved over old scrollback, with fragments of
  earlier frames stuck along the left edge, and the app never took over the
  screen. The initial paint is capped to a window of recent output, and a
  fullscreen app announces itself exactly once, at startup — so hours later that
  announcement was outside the window and the terminal was still on the ordinary
  buffer while the bytes assumed the fullscreen one. The daemon now tracks which
  modes a pane's output has switched on and restores them ahead of the paint,
  including for panes restored after a restart. This affects phones and tablets
  opening the web terminal too, not only mirrored workspaces.

- **Resizing a pane no longer breaks every viewer watching it.** Geometry was
  sent once when a viewer connected, so after a resize on the machine that owns
  the pane, everything drawn afterwards was positioned for a grid the viewer no
  longer had. Viewers now follow the new size once the resize settles — and only
  the size: a viewer's scrollback and scroll position survive someone resizing
  the pane on the other machine.

- **A mirrored pane no longer types into the remote shell by itself.** Terminals
  answer certain queries automatically, and a mirror was sending its answers on
  to the remote pane's input — so a live app, or replayed scrollback containing
  such a query, injected stray characters into a shell on the other machine. A
  mirror no longer sends those answers; the machine that owns the pane is the
  one that responds. The same injection is fixed in the phone and tablet web
  terminal.

- **Attached remote workspaces survive a reload and a restart.** Pressing Cmd+R,
  or quitting and reopening wmux, silently emptied the Remote section of the
  sidebar and every mirror with it — re-attaching meant walking back through the
  picker each time. Attachments are now remembered, and are restored on launch
  with a fresh pane list fetched from the host. Every row appears immediately,
  even when a host takes its time answering. A host that is asleep or
  unreachable keeps its row, marked as stale, rather than being deleted, and
  its mirrors reconnect on their own once it comes back; detaching is still
  yours to decide.

- **Mirrors follow panes opened and closed on the remote machine.** The pane
  layout was frozen at the moment you attached: a pane closed on the other
  machine left a dead tile in the grid forever, and a pane opened there was
  invisible until you detached and attached again. The grid now follows the
  remote workspace, with surviving panes staying in place instead of shuffling
  when one comes or goes.

- **Removing a remote host clears its mirrors.** The host disappeared from the
  picker but its mirrored workspaces stayed in the sidebar for the rest of the
  session, quietly failing to refresh against a machine wmux no longer knew
  about. They now go with it.

- **The orchestrator no longer re-prints the same message while waiting on you.** A
  pending decision (deck_ask_decision) now releases the Stop gate — previously the
  gate kept refusing the turn while the decision block forbade acting, leaving the
  brain nothing to do but restate its question, up to four times per wake cycle. (#832)

- **A wake loop over unchanged fleet state no longer re-buys the same refusals every
  cycle.** When the Stop gate caps out, it remembers exactly what it was holding on
  and stays quiet until that state actually changes, you act (a message, the Wake
  button, answering a decision), or a 15-minute reminder interval passes. Only a
  state the gate actually refused can be suppressed. (#832)

- **Re-sent instructions no longer pile up in the active-work record.** Follow-up
  dedupe now checks the objective and every retained follow-up with
  whitespace-insensitive comparison, instead of only the most recent entry. (#832)

- **A pane's working directory follows `cd` again on Windows.** The per-surface
  cwd was frozen at whatever directory the pane started in, so `surface.list`
  and `pane.list` reported a stale path no matter how many times you changed
  directory — and `task.fanout.start`, which derives the repository from that
  value, refused to start with "the calling terminal's directory is not inside a
  git repository" even when the pane was sitting inside one. The shape guard on
  the cwd write resolved the host platform from `process.platform`, which does
  not exist in the renderer under context isolation; it therefore assumed a
  POSIX host and discarded every `C:\…` as impossible. It now reads the platform
  from the preload bridge. The workspace-level directory was never affected,
  which is why only agents and MCP callers saw the stale value. (#834)

## [3.39.1] — 2026-08-07

### Fixed

- **Detach on an attached remote workspace now works.** Right-clicking the
  sidebar row opened its menu, but pressing "Detach" did nothing at all. The
  menu dismissed itself on `mousedown`, which arrives before `click`, so the
  button unmounted under the pointer before its own handler could ever run —
  the action was unreachable rather than broken.

- **Mirrored remote panes use your terminal font, theme and contrast floor.**
  An attached remote workspace built its terminal without any of the app's
  visual settings, so it fell back to xterm's own defaults — `monospace` at
  15px on black, outside the theme's ANSI palette. Next to a local pane it read
  as slightly bolder and slightly larger, because it was. Changing the settings
  now updates the mirror without dropping what the remote has already sent.

  One difference remains: local panes render through WebGL and mirrors use
  xterm's DOM renderer, whose text antialiasing differs. Matching size, family
  and palette removes most of the mismatch, not all of it.

- **Mirrored panes no longer tear on Korean and other wide text.** The mirror
  re-renders a grid the remote daemon computed, but it was the one terminal in
  the app that skipped the shared Unicode width model — so every double-width
  character put the two grids one cell further apart, and rows arrived
  interleaved and torn.

- **Mirrored panes stay inside their box.** A remote pane with more rows than
  the local cell can show rendered taller than its container, and nothing in
  the chain clipped it, so terminal output painted over the composer bar and
  the sidebar. Typing made it obvious because that is when the overflowing rows
  got repainted.

  This clips rather than scales: geometry belongs to the remote daemon and the
  mirror never resizes it, so a remote grid taller than the local cell now has
  its lower rows cut off instead of drawn over the app. That is the better of
  two bad outcomes, not a good one — the cropped region is where the cursor and
  live output are. Fitting the mirror to the cell needs a geometry negotiation
  that does not exist yet.

## [3.39.0] — 2026-08-06

### Added

- **Paired devices, with a revoke button.** The Web popover now has a
  **Paired devices…** entry listing every device that holds a credential for
  this machine, by the name it was given at pair time, with when it was last
  seen. Each one can be revoked on its own: two clicks, permanent, and its
  live connections are cut immediately.

  Per-device credentials and the revoke that cuts them have existed inside
  the daemon since 3.34, but nothing an operator could reach ever called it.
  The only revocation available from the UI was `wmux web --stop`, which
  cuts every device at once — so a phone or laptop you no longer wanted to
  have access could not be retired without also cutting the ones you did.
  A device credential has no expiry, which made that the difference between
  "revocable in principle" and "revocable".

  The roster reads the device store rather than the running server, so it
  opens whether or not `wmux web` is up — which is the state you are in when
  you have just stopped sharing and want to know what still holds a key.
  A revoke whose roster write fails says so, rather than reporting success
  for a credential that will return on the next daemon restart.

  A failed revoke never overstates what happened. The daemon reporting a lost
  roster write says so and names whether any live connection was actually cut;
  a daemon that does not answer at all says the outcome is unknown rather than
  claiming the device was disconnected. If the roster cannot be read, the
  screen says so instead of showing an empty list, which on a credential
  surface would read as "nobody has access".

### Changed

- **`--allow-input` is now a ceiling, not the whole answer.** Typing — along
  with spawning and closing panes, toggling the permission gate, and approving
  a tool permission, which have always been one grant — is decided per device.
  The Web popover asks when you pair one, and the grant is a checkbox on its
  row afterwards, so a phone can be made read-only without being revoked.

  A server started without `--allow-input` still lets nothing type, from any
  device, exactly as before; the flag bounds the grants rather than being
  replaced by them. Devices paired before this existed keep the access they
  had — they were typing under the server flag, and an upgrade does not mute
  them. A newly paired device is read-only unless you say otherwise, because
  that is the mistake you can fix from the roster.

  `/api/config` now answers with the calling device's own grant instead of the
  server-wide flag, so a read-only phone no longer renders a composer that
  rejects every keystroke.

  Headless hosts are unaffected: `wmux web --allow-input` in a terminal has no
  popover to tick and no roster to grant from later, so the code it prints
  carries the server's own flag and pairing from a terminal works exactly as
  it did before. The per-device choice is what the GUI adds on top.

### Fixed

- **Pairing a remote host now actually shows you the host you just paired.**
  The Attach remote workspace modal registered the host and then sat there:
  the right-hand pane kept rendering its nothing-selected state, which was
  wired to the paste-URL placeholder, so a successful pair looked exactly
  like a no-op and told you to go paste a URL you had just avoided needing.
  A successful pair (or Add host) now selects that host and lists its
  workspaces straight away.

- **The modal's empty states say what is actually going on.** "No host
  selected" and "no hosts registered yet" are now distinct messages instead
  of a shared paste-URL instruction, and a host whose panes are all closed
  explains that the workspace list is built from panes open right now,
  instead of rendering a blank pane.

- **Enter submits the pairing and paste-URL forms.** Both were mouse-only —
  typing a host address and a pairing code and pressing Enter did nothing.
  Enter is ignored while the form is incomplete or in flight, matching the
  button's own disabled state, and mid-IME Enter still commits the
  composition rather than submitting.

## [3.38.9] — 2026-08-06

### Added

- **Scroll-to-bottom button on the terminal.** When a terminal's scrollback
  runs far ahead of the viewport, a small button now appears at the
  bottom-right; one click returns to the latest output. It shows only while
  you are scrolled up and hides again the moment you are back at the bottom.
  (#806)

- **Attach a remote machine's live panes into your local sidebar.** Run
  `wmux web --tailscale --allow-input` on the remote box, then in the app go
  Titlebar `+` → "Attach remote workspace…", paste the URL `wmux web` printed,
  and pick a workspace from its live list. The attached workspace shows up in
  its own sidebar section with a mirror grid (up to 6 concurrent panes) that
  reads scrollback and, when the remote allows it, types into the remote
  panes. Detaching never touches anything on the remote — there is no
  remote create, rename, or close from this view yet.

- **Pair with a code instead of pasting the URL.** In the same "Attach
  remote workspace…" modal, the "Pair with code" tab exchanges an 8-char
  code read from the remote's titlebar Web popover for a device-scoped
  token — no bearer token ever touches the clipboard, and the remote can
  revoke just that one device later.

### Fixed

- **Prevented slow startup reconciliation from clearing live terminal bindings.** Startup restore now measures stalled daemon stages instead of the total duration of multi-step list, promotion, and re-query work, so slow but responsive recovery no longer falls back to a blank slate. (#805)

- **Quitting and relaunching wmux no longer leaves junk like `35;9;12M` typed
  at the shell prompt.** A pane that had been running a TUI agent kept that
  agent's mouse-tracking sequences in its replay buffer. Reattaching replayed
  them into a fresh terminal, so the shell — which never asked for mouse
  reporting — received an SGR mouse report the moment the pointer crossed the
  pane, and the terminal pasted the tail of that report onto the prompt. The
  disarm already existed but only fired when the daemon itself had just booted
  into recovery, so an app-only restart (daemon still running) skipped it.
  It now also fires on panes whose shell integration reports them sitting at a
  prompt. Panes without shell integration still need a daemon restart to clear
  the modes. A running TUI's mouse tracking is left alone either way, and
  bracketed paste is only cleared on panes whose shell is known to be gone.

- **Questions answered on the PC now clear from the phone approval inbox
  right away.** The signal that reports a locally answered AskUserQuestion
  never actually fired: the hook bridge required a payload field Claude Code
  does not send, so answered questions sat as pending ghost cards until the
  agent's turn ended. The bridge now promotes the answer on the tool name
  alone (and the OpenClaude bridge, which was missing the promotion entirely,
  gained it too), so the pending card expires within seconds of the local
  answer. (#808)

- **A question answered on the PC no longer cancels a permission request
  waiting on your phone.** Clearing the answered question swept every pending
  approval on that pane, so a tool permission the same turn had asked for
  disappeared from the inbox and fell back to the local prompt. Each now
  clears only its own kind of request. (#808)

## [3.38.8] — 2026-08-05

### Added

- **The phone can show what a pane is doing right now.** The turn view carries a
  live activity header — thinking, which tool is running and for how long, waiting
  for you — instead of leaving you to guess from a conversation that has stopped
  growing. It rides its own channel rather than being read off the transcript, so
  an agent that stalls mid-turn looks different from one that is still working.

- **Code blocks and large tool outputs open on the phone.** Tapping a code chip
  fetches the body instead of showing a chip that does nothing. Oversized bodies
  arrive as a head and say they were cut, rather than pretending the block ends
  there.

- **The permission gate's state is visible and stays in sync.** A phone's gate
  toggle opens showing whether the gate is actually armed, and turning it off from
  one device updates the others immediately instead of leaving them showing the old
  position until something else makes them re-read.

### Fixed

- **Full transcript access is now visible in web help and status.** The
  `--allow-transcript` flag and its sensitive data scope are documented, and
  `wmux web --status` reports whether the permission is enabled instead of
  leaving operators unable to audit the grant. (#793)

- **The phone now gets the right pane shape when the desk isn't looking.** A
  pane the Mac app holds open used to be `attached` whether or not anyone could
  see it, so a phone rendering it always got a desk-shaped (e.g. 151×47)
  geometry and letterboxed a third of its portrait screen — every live pane
  answered `409 desk-owns-size`. Size ownership is now visibility-based: the
  renderer reports whether a pane is actually on screen (workspace + tab active
  AND the window visible), and the route only keeps the desk's geometry when the
  desk is watching. An attached-but-hidden pane (background workspace, inactive
  tab, minimized window) takes the phone's numbers, and the desk silently
  reclaims the size the moment somebody looks again. (#766)

- **The orchestrator's own conversation is no longer readable from a phone.** The
  brain pane is hidden from the pane list, but the transcript routes only checked
  that a session existed — a device holding its id could read the whole thing.

- **External MCP terminals now recover when their claimed workspace is deleted.**
  Closing an external caller's dedicated MCP workspace used to leave every later
  terminal operation targeting the dead PTY until the MCP server restarted. A
  stale route is now released so the next operation claims a fresh workspace
  automatically. (#797)

- Terminal panes no longer render scattered wrong glyphs (worst on Korean and
  other CJK text) during heavy multi-pane output. The shared-atlas guard emptied
  the glyph pool and repainted, but a repaint skips every cell whose text has not
  changed — so those cells kept pointing at glyph positions that no longer
  existed. Each pane now rebuilds its render model alongside the wipe, the way
  the renderer does it internally. The guard's speculative wipes are also rate
  limited, so a saturated glyph pool no longer means a full re-raster of every
  pane every two seconds.

- **`wmux set-status` and `wmux set-progress` work again.** Both commands failed
  every time with an internal message about an unresolvable calling pane, so
  there was no way for automation to publish a run's live status or progress
  into the workspace chrome. They now identify the calling pane the same way
  `wmux send` does, and `--pane <ptyId>` targets another pane's workspace.
  Outside a wmux pane they exit with a message that says what to do instead of
  the daemon's internal resolver text. (#801)

- **`wmux close-workspace` no longer reports closing a workspace it did not
  close.** Closing an unknown workspace, or the last remaining one (wmux always
  keeps one open), printed `Closed workspace: ws-…` and exited 0 while the
  workspace stayed open — so a cleanup script had no way to tell a real close
  from a refused one. Both cases now fail with an explanation, and the success
  receipt is only issued after the workspace is confirmed gone. (#801)

## [3.38.7] — 2026-08-04

### Added

- Phone turn (conversation) view contract: `GET /api/sessions/:id/turns` serves the same Claude Code session reflowed to phone width, stateless so it never disturbs the desktop Chat View sharing the pane. Gated behind `wmux web --allow-transcript` (default off — the transcript reads the whole session, far wider than a mirror, and the device credential never expires). A non-recording `transcript.nudge` SSE frame tells the phone to re-fetch without pushing approval events out of the bounded attention log. (#786)

- Tool permission prompts can now be answered from the phone. A `PreToolUse` hook holds the gated tool call while the daemon waits for a remote answer, so the prompt that most often stops an agent is no longer a dead end away from the desk. Which tools are gated lives in the daemon config (`wmux gate --list/--add/--remove`) rather than in the hook, so changing it needs no Claude Code restart. The gate arms only inside an interactive wmux pane, and only while a phone can actually answer it — that is, while `wmux web --allow-input` is running. With no such server up, and for `claude -p`, CI and subagents, a gated tool falls straight through to the normal local prompt instead of waiting on a card nobody can reach. It also fails open on a deadline, a dead session, a stopped web server or a daemon restart, so nothing hangs waiting for a phone that never answers. Escape hatches: `POST /api/gate/off`, `WMUX_GATE=0`, or simply waiting for the deferral. Claude Code only for now. (#789)

### Fixed

- `wmux setup-hooks` now installs the `PreToolUse`/`PostToolUse` hooks scoped to `AskUserQuestion` on the plugin-less CLI path (previously only the marketplace plugin installed them), so the in-app approval inbox works no matter how wmux was installed. `wmux setup-hooks --status` now reports each feature — conversation read, approval card, turn-end signal, permission gate — as `OK`/`OFF` with the fix command on the same line, instead of silently reporting all-clear when the approval-card hook is missing. (#785)

- **Hook feature status now reflects the active integration.** The
  `wmux setup-hooks --status` command requires the precise `AskUserQuestion`
  scope for manual approval hooks and recognizes features supplied by an enabled
  `wmux-claude-integration` plugin, instead of treating stale broad hooks as
  healthy or a plugin-managed installation as off. (#787)

- Phone turn-view responses now use `Cache-Control: no-store`, preventing browsers and intermediaries from retaining cached transcript pages after transcript access is revoked. (#788)

- `wmux setup-hooks --status` now reports the permission gate alongside the other hook-backed features, so a partial install is visible instead of reading as healthy. (#789)

- **Scattered wrong glyphs no longer survive a Korean-heavy output burst.** The
  guard that protects the shared WebGL glyph atlas was failing in three ways at
  once, and a day of logs from a real session showed the result plainly: 4657
  guard events, 6 of which were actual repairs.

  It could not reliably *see* the corruption. A page merge was detected only by
  the pool *shrinking*, but a merge is a net -2 and the very burst that causes
  it re-allocates those pages well within the guard's 2s poll — so the count
  looked unchanged, the repair never ran, and the glyphs stayed wrong until a
  new pane was opened. The guard now recognises a merge by page identity, which
  survives the regrowth, keeps that comparison alive even while its preventive
  path is firing, and additionally listens for the terminal library's own
  page-removal event, which catches merges that begin and end between two polls
  and so are invisible to any amount of sampling.

  It could not *repair* when it tried. The library skips clearing the atlas if
  its first page looks empty — but the first page is exactly the one that stays
  empty once glyph packing resumes from the end of the pool, so the clear had
  become a permanent no-op. The guard now makes sure the clear actually runs,
  and verifies afterwards that the atlas really is empty rather than assuming
  it.

  It was firing when nothing was wrong. The preventive path asked whether the
  *last* page held glyphs, which one glyph after a clear puts back — so it
  re-armed every two seconds against a pool that was 15 pages long with 1 page
  in use. It now measures how many pages are actually occupied, which is what
  brings a merge closer, so the repair runs when the atlas is genuinely full and
  stays quiet otherwise.

  The repair log now records which signal fired and whether the clear took
  effect, so a guard that is running and achieving nothing can no longer look
  identical to a healthy one. (#790)

- **Transcript reset pages retain omission receipts.** Phone clients now receive
  `budgetDropped` when a reset snapshot skips an oversized transcript entry, so
  they can render an omission seam instead of silently closing the gap. (#791)

- **A broken stdio pipe no longer floods the log file.** When the reader of an
  inherited pipe went away while wmux kept running, the write failure was
  reported to the console, and that report went straight back onto the same
  broken pipe. The loop ran at roughly 190,000 lines per second and stopped
  only when the process died — one session left an 84.9 GiB log file behind.
  The failure is now consumed where it arrives and the affected stream is
  retired, with one line in the log naming the stream and the error code so the
  quiet console is explainable. Logging continues to the file throughout.

- **Daily log files are bounded.** They are capped at 16 MiB with three
  archives, where previously the only limit was a 14-day prune. Rotation is
  safe when several wmux processes share one daily file, which an installed
  build and a development build routinely do.

## [3.38.6] — 2026-08-03

### Added

- **Native TLS for `wmux web`.** Use `--tls-cert <path>` with `--tls-key <path>` to terminate HTTPS directly when exposing panes without Tailscale. (#775)

- **Move panes around your layout.** Panes could only be created and closed, so
  getting the arrangement you wanted meant splitting in exactly the right order
  from the start. Now you can rearrange one you already have: drag the grip in a
  pane's tab strip and drop it on another pane's edge to move it there, or on
  its centre to swap the two. From the keyboard, `Ctrl+B` then `H`/`J`/`K`/`L`
  walks the active pane left/down/up/right, and `{` / `}` swap it with its
  neighbour, mirroring tmux. The command palette carries the four directional
  moves as well. Panes keep their names and their scrollback wherever they land.
  (#776)

- Settings → Claude integration now opens with a **Setup** card listing the
  hook bridge, the MCP registration, and the usage statusline — each with its
  real install state and a one-click install for whatever is missing.
  Previously the first-run wizard was the only place these were ever offered,
  and skipping it left the CLI as the only way back.

- The first-run wizard now offers the Claude Code hook bridge alongside the
  statusline, and shows it as installed when it already is.

- **Fan-out can launch in bypass mode without retyping the flag.** The Multi Task dialog now offers `--dangerously-skip-permissions` as a checkbox, shows the launch command it will fire, and prefills the command the last fan-out actually used. The checkbox appears only for Claude Code, the launcher wmux knows that flag for; users of another CLI type their own bypass flag once and it is remembered. A Claude-only flag left behind after switching launchers is called out with a one-click removal.

### Removed

- **Removed the unused MCP long-poll transport option.** `sendRpc` no longer
  carries a separate timeout-and-retry mode for a server-side wait RPC that
  does not exist; its production callers continue to use the established
  10-second timeout and three-attempt retry path. (#778)

### Fixed

- **Closing a pane no longer misaligns its neighbours.** In a row or column of
  three or more panes, closing one left the remaining panes rendering at the
  wrong widths — the sizes list still had an entry for the pane that was gone,
  so every panel after it was drawn one slot off. Two-pane splits were never
  affected, which is why this hid for so long. (#776)

- The workspace mode dropdown no longer runs off the top of the window. It
  opens toward whichever side has room and caps its height there, so `Off`
  stays reachable in a short window — autonomy can always be lowered again.

- The orchestrator's "mode is off" note in the deck composer is no longer cut
  off. The placeholder shows a one-line form; the full explanation stays on
  hover.

- The wizard's statusline offer never appeared: it looked for the preload
  bridge at the wrong path and silently hid itself when it came back empty.

### Security

- **Fail-closed HTTPS restore.** Native TLS stores certificate/key paths rather than PEM bytes, validates material before replacing a live listener, and leaves no plaintext listener if persisted TLS material becomes unavailable. Crossing the encrypted/plaintext boundary rotates the operator token and revokes paired-device credentials. (#775)

## [3.38.5] — 2026-08-03

### Added

- **The daemon can project a pane's transcript as structured turn events.**
  Each pane's scrollback can now be read as a sequence of turns (who spoke,
  what was asked, what ran) instead of raw terminal bytes. This is the daemon
  half of #655 — groundwork for clients that want to render a conversation
  view rather than a terminal mirror. (#771)

### Changed

- **The workspace list fits more of your fleet on screen.** Rows are tighter,
  and each running agent in a selected workspace now sits on a single line
  (name, pane, and status together) instead of a stacked, boxed card. When an
  agent is actually waiting on you, its question still opens on a second line
  in red so you can see what it needs at a glance.

### Fixed

- **Long branch names in the sidebar are no longer cut short.** Each
  workspace row shows its git branch under the name, and that label used to be
  capped at a fixed width, so a branch like `feat/deck-new-session` was
  truncated to `feat/deck-n…` even when the row had room to spare. The label
  now uses the full width of its line and only elides when a genuinely long
  name would overflow, keeping the git status and PR badge right beside it.
  (#767)

- **Answering an agent's question at the desk now clears it from your phone
  right away.** When Claude Code asked a question and you answered it in the
  terminal on the Mac, the phone's approval inbox kept showing it as pending —
  badge and all — until the whole turn ended, because nothing told the daemon
  the question had been answered locally. The Claude bridge now reports the
  moment an `AskUserQuestion` completes (`agent.input_answered`), and the
  daemon expires the request immediately with reason `answered-locally`. The
  completion signal is also exempt from the PostToolUse activity throttle, so
  a fast answer cannot slip through the 2.5 s window unreported. (#773)

## [3.38.4] — 2026-08-02

### Added

- **The multiview grid can be stacked vertically.** Settings → Layout now has a
  Multiview arrangement control with three choices. **Auto** keeps the old
  behavior — two workspaces side by side, four in a 2×2 grid, five or more in
  three columns. **Columns** puts every workspace in one row, and **Rows** stacks
  them in a single column, which is what you want on a tall display or when the
  tiles are agent transcripts that read better narrow. Before this, four
  workspaces were always 2×2 and there was no way to say otherwise. Arrow-key
  navigation between tiles follows the arrangement you picked, and the choice
  survives a restart. (#748)

### Changed

- Critical-action notifications now show the matched terminal line. The
  `critical` attention event carries `matchedLine` — the printed terminal
  output that tripped the pattern, sanitized and capped — so a heads-up can
  say `git push --force origin main` instead of just "git push --force". (This
  is the text the terminal displayed, which may quote a command rather than run
  one; it is not proof the command executed.)

- Documented that the critical signal is notify-only: it fires on printed
  output, not on a pending action, and is not something a remote surface can
  answer. Approvals remain the only answerable signal.

### Fixed

- **Scoped MCP browser fallbacks to their calling workspace.** Browser tools no
  longer let automation leases, CDP discovery, or RPC fallbacks select another
  workspace's webview when the intended target is missing or ambiguous. (#749)

- **Closing a workspace no longer leaves multiview in a broken state.** Closing
  members of a multiview group from the sidebar could leave the app showing a
  single tile still wrapped in multiview chrome, with no way back except
  `Ctrl+Shift+G`. The closed workspace is now dropped from the group, and the
  group disbands once fewer than two members remain. (#753)

- **Ctrl+click on the workspace you are looking at no longer closes the whole
  grid.** Removing the active workspace from a multiview group took every other
  tile with it. Focus now moves to a neighbouring tile first, the way the tile's
  own ✕ button already behaved. (#753)

- **Resizing while text is selected no longer leaves the terminal at the wrong
  size.** If you selected some output and then resized — dragging a split
  separator, toggling the sidebar, resizing the window — the terminal and the
  shell behind it stayed at the old dimensions even after you cleared the
  selection. Output wrapped at the wrong column and full-screen programs drew
  against stale dimensions until something else happened to resize the pane. The
  deferred resize now runs as soon as the selection goes away. (#754)

- **LanLink halved the disk writes a received message costs.** Each inbound record used
  to force two full rewrites of the peer file, and on Windows every rewrite shelled out
  to `whoami.exe` and `powershell.exe` to re-apply the owner-only file permissions — a
  step measured at seconds per call on machines running antivirus, and one that blocked
  the whole daemon while it ran, so a peer sending a burst of messages could stall wmux.
  The "last seen" timestamp now rides along with the write the record already needed,
  instead of forcing one of its own. The remaining write is the replay guard, which has
  to be durable; making that one cheap on Windows is still open. (#755)

- **Panes no longer flicker and settle black after a WebGL teardown.** When
  xterm's WebGL addon was disposed (pane hidden, tab switch, font reload) and
  an internal step threw mid-dispose, the addon's own "hand back to the DOM
  renderer" step was silently skipped — leaving the pane with no renderer at
  all. Every render tick after that (cursor blink, scroll, resize) threw, so
  the pane flickered and then stayed black until relaunch. Teardown now
  verifies a renderer survived and restores the DOM renderer itself when it
  did not. (#759)

- **Browser navigation no longer reports a transport timeout for a DNS
  failure.** The navigation guard's DNS lookup was unbounded, so a slow or
  unresolvable hostname outlived the caller's RPC deadline and surfaced as
  `RPC timeout: browser.navigate` — naming the pipe instead of the actual
  problem. The lookup is now bounded and reports the DNS failure itself.
  (#756)

- **`browser_navigate` returns once the page commits**, rather than after every
  subresource has finished loading, so a slow page no longer keeps the call (and
  the automation lease) open past the caller's deadline. A navigation that
  genuinely fails is now reported instead of being retried through the renderer
  bridge and answered as a success. (#756)

- **Browser tools say which kind of "no target" they hit.** `BROWSER_NOT_OWNED`
  (the surface belongs to another workspace — never retry) and
  `BROWSER_NO_TARGET` (this workspace has no browser open — open one) replace a
  single message that covered both. (#756)

- **Dead panes now reopen in their original working directory.** Renderer-
  created replacements inherit the dead session's validated spawn directory,
  fall back to its last live directory and then home, and retain any surviving
  agent resume offer. (#762)

## [3.38.3] — 2026-08-02

### Added

- Phones can reshape a pane they are the only client of. `POST /api/sessions/<id>/resize` reflows the PTY to the phone's viewport, so a 151-column desk pane stops arriving letterboxed or shrunk past reading — the wrapping happens in the PTY, before any client sees a byte, so nothing on the phone could fix it. A desk client that has the pane attached keeps ownership: the route answers `409 desk-owns-size` with the current geometry rather than starting a resize fight the desk's next layout pass would win anyway. Available without `--allow-input`, like the diff route — it delivers a SIGWINCH, not a keystroke. (#743)

### Fixed

- The Schedules panel's "Add schedule" button no longer gets clipped off the right edge of a narrow deck — the create row wraps and its time/repeat controls shrink.

- Scattered wrong glyphs across several panes at once during CJK-heavy sessions. The shared WebGL glyph atlas's page-merge path corrupts sibling panes' cached glyph references when its page pool fills (16 pages on Apple Silicon; Hangul's 11,172 distinct syllables fill it fast); a new guard now rebuilds the atlas coherently for every sharing pane just before that path would run, and repairs within seconds if it ever does. (#741)

- **Check for updates now installs the update on Apple Silicon Macs.** Pressing it downloaded
  and verified the new version and then did nothing at all: no restart, no
  error, and nothing on any press after that. Installing asks macOS to close
  every window first and only goes ahead once they are all gone, but wmux keeps
  its window alive so it can sit in the tray, so the close was cancelled and the
  installer waited forever on a wmux that was never going to quit. The signal
  that was meant to let those windows go was listening for something that is
  never sent to it, so it never arrived. wmux now says so directly and there is
  no message left to miss. If installing still fails to restart the app, wmux
  stops waiting, brings the window back and tells you what happened instead of
  going quiet, and the button works again on the next press rather than
  silently refusing for the rest of the session. Updates that were interrupted
  no longer leave their downloaded copy behind either, where they had been
  piling up at around 120 MB each. (#742)

- The lock-screen Approve button never appeared on any notification. The iOS extension has nothing but the sealed payload, so it reads an absent `risk` as "unknown" and withholds the affirmative — but the daemon only ever set `risk` on the critical branch, which is right for `/api/approvals` and wrong here. Push payloads now always state `critical` or `normal`. (#743)
- Two builds of the phone app on one tailnet took turns breaking each other's push. An APNs token does not say which stage minted it and Apple's two hosts reject each other's, so the relay's single `APNS_ENV` was one answer for every device — the symptom was a `BadDeviceToken` that traced back to nothing. The daemon now stores the stage the app reported per device and the relay routes on it, falling back to `APNS_ENV` when a device named none. (#743)

## [3.38.2] — 2026-08-01

### Added

- **You can hand a workspace a fresh orchestrator without losing anything
  else.** A **New session** control now sits with the other orchestrator
  controls at the top of the deck. It retires the current orchestrator and
  starts a new one that reads your project files again and takes a fresh look
  at your panes, which is what you want once a long conversation has drifted or
  a turn has wedged. There was no way to do this before: restarting wmux
  deliberately resumes the same conversation, quitting the orchestrator's own
  terminal just reopens it on that conversation, and deleting the workspace
  takes every pane with it. Your panes, worktrees and conversation history all
  stay, and loops and schedules keep running. It asks for a second click before
  it commits, and stays available even mid-turn — a stuck turn is usually
  exactly when you need it. (#711)

- **You can set a dependent child task loose without stopping it.** A **Detach
  from parent** action now sits in the context menu of a child workspace that a
  fan-out spun up. Detaching releases that task from its parent — the parent
  stops tracking it and its mission channel folds away into Archived — while the
  workspace itself, its worktree, branch, terminals and running agent all keep
  going, now on their own. Before this, a child task was tied to its parent for
  its whole life: the only way to end the relationship was to close it, which
  tears down the worktree and the work along with it. Detach keeps everything
  and simply cuts the leash. The cleanup scanner knows a detached worktree is
  still live, so it is never offered up for deletion, and detaching something
  twice is harmless. (#715)

### Changed

- **The orchestrator now runs on the terminal brain by default.** The Command
  Deck drives your own `claude` binary in an embedded terminal instead of the
  Agent SDK, so it needs no API key and picks up its per-workspace `CLAUDE.md`
  from disk every time it starts. The SDK brain has not gone anywhere: it stays
  selectable under Settings › Orchestrator, and wmux still falls back to it
  automatically when daemon mode is unavailable. Existing installs move over on
  the next launch. The move is reversible and costs no history — each brain
  keeps its own conversation, so switching back in Settings picks your SDK
  conversation up exactly where it was. (#710)

- **The workspace mode now says how Claude is started, not how chatty the
  orchestrator is.** The three modes never reached the Claude process at all,
  so "Off" quietly meant "wakes less often" while the orchestrator kept
  running. Now: **Off** does not start it (and stops one that is already
  running), **Assist** starts it with edits accepted automatically while every
  other permission prompt still stops and asks, and **Danger** — the mode
  previously called Auto, renamed for what it does — starts it in bypass mode.
  How often the orchestrator wakes on its own is now a separate setting, and
  every existing workspace keeps the wake behaviour it already had. (#735)

### Fixed

- **A pane running a TUI that asks the terminal about its own modes no longer
  freezes.** `opencode` probes six terminal modes the moment it starts, and each
  probe hit a miscompiled xterm handler that threw. The throw killed that pane's
  parser for good: the process kept running and its title kept updating, but the
  screen never painted again and every agent read of it came back
  `RPC timeout: input.readScreen (5000ms)` — with nothing to explain why. The
  renderer bundle is now built at a target that stops mangling the handler.
  (#708)

- **Reading a pane can no longer hang.** The read path waited on the pane's
  parser without a deadline, so a stalled pane took the whole read down with it
  and the caller got nothing. Reads now wait a bounded moment and return what
  the pane has, which is worth far more than a timeout. (#708)

- **The orchestrator model picker now applies to the terminal brain.** The
  model only ever reached the orchestrator when you typed into the deck
  composer, and the terminal brain has no composer — you type into its terminal.
  Choosing a model therefore did nothing for it, and scheduled or event-driven
  turns ran on whatever model your last typed message happened to leave behind.
  The picker now applies on every path. (#710)

- **A workspace that started without a running daemon no longer loses its
  terminal conversation.** With no daemon the deck quietly serves the SDK brain
  instead, but it filed that conversation under the terminal brain's name. The
  terminal conversation could not be resumed afterwards, the substitute brain
  was told it had no memory to write to, and the workspace stayed on the
  substitute even after the daemon came back. (#710)

- **Full-power mode no longer looks available when it cannot do anything.** It
  only applies to the SDK brain, so under the terminal and Hermes brains the
  toggle now explains that instead of silently ignoring the click. (#710)

- **A dev build no longer reads the production config to decide the CDP gate.**
  The CDP decision in the main process ran before the instance-isolation
  (`WMUX_DATA_SUFFIX`) block, so a `-dev` build consulted `~/.wmux` instead of
  `~/.wmux-dev`. Moved after the suffix block so each instance reads its own
  config. (#613)

- **A pane that finished its command no longer reports `running` forever.**
  Clearing a pane back to `idle` sat behind a 30-second window built to suppress
  a "Task may have finished" notification that had since been removed. A
  workspace switch (any `pty:resize`) inside that window made the clear vanish,
  and nothing retried it — the activity monitor consumes its state transition
  before invoking callbacks, and a quiet pane never produces another burst. For
  a plain shell, where no agent is detected, that clear is the only path there
  is, so the pane sat at an idle prompt reporting `running` until it was closed.
  The window also blocked the correction for the false `running` a resize
  redraw raises in the first place. Agent panes are unaffected: their precise
  hook and detector statuses still outrank byte silence. (#733)

- **The orchestrator can no longer close a pane to clear its status.** When a
  wedged pane held the Stop gate open, the terminal brain read "resolve these
  panes" as "end these panes" and ran `exit`, then Ctrl+D, in a live shell the
  user owned. The refusal text now names the prohibition, and session-terminating
  input is refused outright when it targets a pane the caller's own turn is
  currently blocked on. The scope is exactly that intersection — an orchestrator
  that is not gate-held closes shells as before, and even a gate-held one may
  close panes it is not blocked on. (#733)

- **A request the orchestrator was working on no longer comes back to life
  after you quit.** wmux remembers what it was asked to do so a restart does
  not lose your request — but that memory used to be permission to act, with no
  expiry. Reopening wmux could hand the orchestrator an hours-old objective and
  set it loose on your panes seconds after launch, even in a workspace set to
  Off. A request that outlives the app is now **parked**: it is still recorded,
  still shown to you, and still stops the orchestrator from claiming it
  finished — but it drives nothing on its own. On the next launch you are asked
  whether to resume it or drop it. Only your own message can wake it up again.
  (#733, #735)

- **The orchestrator is told not to close your panes in the one case where it
  used not to be.** The refusal that holds a turn open already warned it never
  to close or kill a pane to clear a status. That warning was missing from the
  refusals raised by a durable request — which is exactly the case a leftover
  request lands on. (#735)

- **What you ask for now is what the orchestrator works on.** If a request was
  already on the books, anything you typed afterwards was recorded as a note
  underneath it rather than as the thing to do — so a message sent after
  reopening wmux could end up filed under an objective from hours earlier, with
  the old one still leading. Now, speaking to an orchestrator whose request
  predates this session replaces that request with yours. A request it is
  actively working on still collects your message as a follow-up, so nothing
  running is abandoned, and answering "resume it" on the startup prompt still
  resumes the original untouched. (#733, #736)

- **Dropping a request no longer abandons the agents working on it in
  silence.** Starting a new session, or replacing a stale request, can discard
  one that still has work delegated to other agents. Those agents kept running
  with nobody waiting on them. wmux now tells you, and asks what to do about
  them, whenever a discarded request still had something outstanding. (#736)

- **The New session button no longer promises to keep the conversation it
  discards.** Its tooltip listed the conversation history among the things that
  stay, when starting a fresh session is precisely what clears it — the reverse
  of what happens, on the one control you reach for when the orchestrator is
  stuck on stale context. It now says the orchestrator forgets the conversation
  and the #commander transcript remains as the record. (#737)

- **The unread count no longer vanishes the moment you minimise wmux.** On
  Windows and Linux the tray tooltip is the only place an unread count shows
  once the window is hidden — and hiding the window was itself what erased it,
  because the "background sessions running" note and the unread badge each
  overwrote the whole tooltip. They now share it, so a hidden wmux shows both.
  A count that arrives while wmux is still starting up is no longer dropped
  either. (#729, #738)

### Security

- **The CDP remote-debugging port is now closeable from config.** Browser
  automation runs over Electron's CDP port on loopback, and unlike the other
  same-user attack surfaces it only needs a loopback socket — no filesystem or
  process access — to reach full renderer control. Set
  `browser.cdp.enabled = false` in `~/.wmux/config.json` (or export
  `WMUX_DISABLE_CDP=true`) to close it. The port stays on by default because
  browser automation depends on it; when disabled, browser tools fail with an
  actionable message instead of an opaque connection-refused. (#613)

## [3.38.1] — 2026-07-30

### Added

- **Open a workspace folder from the sidebar.** Every workspace row now carries a
  folder button that reveals its working directory in Finder or File Explorer,
  and the right-click menu gained an **Open with…** submenu listing the editors
  actually installed on the machine — VS Code, VS Code Insiders, Cursor, Windsurf,
  plus Windows Terminal on Windows and Terminal / iTerm on macOS. Before this you
  had to copy the path out of the session info and paste it somewhere else to get
  at the files.

  Detection is per-platform because the two systems hide their editors in
  different places. On Windows it probes PATH, all candidates at once so opening
  the menu never stalls the terminals, and remembers each launcher by the absolute
  path `where.exe` reported — most of these editors ship as a `.cmd` shim, which
  Windows cannot start from a bare name and which Node refuses to execute
  directly, so they are dispatched through `cmd.exe` with each argument quoted. On
  macOS PATH is useless (a Dock-launched app never sees `/usr/local/bin`), so it
  looks for the `.app` bundles in `/Applications` and `~/Applications` — no
  subprocess at all — and launches with `open -a`, which reuses a running
  instance instead of starting a second copy. A folder that cannot be opened says
  so in a toast instead of swallowing the click. (#702)

- **The terminal orchestrator will not end a turn while it still has work out there.** Its worst habit was stopping the moment it had dispatched something: delegate, say "delegated", stop — and nothing drove the fleet again until some wake event happened to fire. Now, when the orchestrator tries to finish a turn while worker panes are still running or waiting on it, the turn simply does not end: it is told which panes need it and what to do about them, and it keeps going. The gate deliberately gives up rather than trapping the brain — a missing fleet snapshot never blocks, and after three refusals in a row the turn ends anyway, so a pane nobody can resolve costs a nudge instead of a frozen dock. (#693)

- **The orchestrator ships with its own `delegate` and `approve` skills.** Its operating rules used to be preamble text, re-sent every turn and gone as soon as the turn scrolled away. They are skills now, installed into the brain's home and fired by the situation: `delegate` when it reaches for a shell it does not have, `approve` when a worker pane is waiting on it. `approve` in particular says the thing that matters — read what is actually on the pane's screen before pressing anything, and raise a decision card rather than approving something you were never asked to approve. Rewrite either file yourself and it is yours; wmux stops regenerating it. (#693)

### Changed

- **Blocked tools now explain themselves.** A tool the orchestrator may not call used to fail with a bare error code, which told it a call had failed and nothing else — so it would try again, or try something adjacent. Each block now names the boundary and the alternative: no shell, so split a worker pane; no file writes, so delegate the edit with its acceptance check. (#693)

- **`AskUserQuestion` is no longer available to the orchestrator.** It draws a question box in a terminal nobody is watching, so reaching for it stalled the whole fleet until someone happened to notice. Questions go to the deck's decision card (`deck_ask_decision`) instead, where they wait for you durably and can be answered from the app. (#693)

- **The terminal orchestrator now owns the dock.** With the `claude-pty` brain
  selected, the Orchestrator tab is the Claude Code TUI itself: one compressed
  control row on top, the terminal filling everything below it, and the turn
  reports collapsed into a footer rail you open when you want the receipt. You
  type into the terminal — the separate deck composer is gone for this vendor
  (the SDK and hermes brains keep theirs, where it is still the only way in).
  Before, the terminal was a 42vh panel pinned above a chat log that mostly
  restated it. (#689)

- **A Wake button in the terminal dock's control row.** With the composer gone,
  one click asks the orchestrator to take an ambient turn now — review the
  fleet, act on anything pending, and report. Disabled while a turn is already
  streaming. (#689)

- **A turn you start by typing into the terminal now counts as a turn.** The
  orchestrator's heartbeat, loops, and schedules wait for it to finish instead
  of pushing a second prompt into a terminal that is already working. (#689)

### Fixed

- **Channel delivery wakes idle agents again after a daemon restart.** Restart
  recovery marks every pane principal stale, and an agent that has finished and
  is waiting produces no output to refresh that flag, so the wake worker could
  leave it unwakeable indefinitely. The registry now supplies only the pane's
  PTY coordinate; the daemon's rebuilt attached/detached session table decides
  whether that target is live. Exact principal targets that cannot be verified
  are skipped rather than redirected to a sibling agent. (#705)

## [3.38.0] — 2026-07-29

### Added

- **Every production dependency's license is now checked before it can ship, and an undetermined verdict fails.** wmux distributes signed, notarized binaries, so a GPL/AGPL dependency reaching that bundle creates a source-disclosure obligation that cannot be undone after a release — and nothing was checking. The new gate is deny-by-default: a package passes only if its license is on an explicit permissive allow list. Anything else fails, *including* the cases automated tooling reports as "no license found" — `NOASSERTION`, `other`, `UNKNOWN`, empty, or npm's `SEE LICENSE IN <file>`. That is the whole point: automated detection returns "other" for projects whose LICENSE file, when a person opens it, is the GNU General Public License, so a checker that treats "could not determine" as "nothing found" waves exactly that case through green. A third check reads the LICENSE text each package actually ships and rejects a copyleft body no matter what the manifest declares, because the manifest is what lies in that failure mode. Exceptions live in `license-allowlist.json`, pinned to an exact name, version, and declared license, each with a written reason recording what a human read — a version bump retires the exception and requires a fresh reading. Runs with `npm test`; `node scripts/check-licenses.mjs` reports on demand.

- **`THIRD_PARTY_NOTICES` is now guarded against drift.** It listed 110 packages while 128 were actually shipping and had not been regenerated in two months, attributing `@modelcontextprotocol/sdk` at a version no longer installed. The generator gained a `--check` mode that the test suite runs, so the file can no longer fall behind `package-lock.json` unnoticed — the same arrangement that already keeps `docs/api/reference.md` honest.

- **An agent can now start a fan-out, not just a human.** Fan-out — one prompt split into N isolated tasks, each with its own git worktree, branch, workspace, agent pane and private mission channel — existed only behind the in-app dialog, so the MCP surface wmux exposes to other agents could not reach its flagship journey. The new `fanout_start` tool does, and `channel_mission_list` reports back what each task became: status, branch, worktree path, and the workspace it runs in.

  What a caller may ask for is deliberately narrower than what the dialog accepts, because the dialog's fields were typed by a human and a tool call's are not. The repository is **not** a parameter: it is the git top level of the calling *terminal's* own directory — the pane the request came from, not the workspace it sits in, so a pane next to the caller cannot choose the repository on its behalf — and naming one is rejected rather than quietly ignored. The same directory is derived a second time once the user approves, and the fan-out is refused if it has moved, so the repository named on the prompt is the repository that gets modified. The agent command is likewise not a parameter, because it is interpolated into a shell line. Which workspace owns the tasks — and the caller's name inside the resulting mission channels — is resolved from the caller's verified terminal, and stating one is refused, not overruled in silence. Task count and prompt and title sizes are capped where the request arrives, not only deeper in. And like the existing background-execution path, fan-out is refused outright to anything that did not arrive over the local machine's own socket.

  Spawning takes far longer than a single call can wait for, so `fanout_start` answers as soon as it has accepted the work and you follow it by calling again with the same idempotency key: it reports waiting-for-approval, then running, then the full per-task result. A repeated key never starts a second fan-out — including after a failure, and including long after the result itself has aged out of memory, since a key that has already spawned is remembered as having spawned rather than forgotten wholesale.

  Every fan-out started this way asks the user first, and that prompt is **not** covered by the existing auto-approve setting for background execution: agreeing that an agent may spawn a background agent is not agreeing that it may create N worktrees and branches in your repository. The prompt shows what each task will actually be told — the shared prompt and that task's own instructions, per task, with the byte count of anything too long to display — because an approval given to a summary of instructions is not consent to the instructions. If nobody answers the prompt, the fan-out is refused — and says so, with the reason, the next time the caller checks, rather than going quiet on an unattended machine. The in-app dialog is unchanged and still needs no prompt, since clicking it is the approval.

- **An agent can now @-mention a specific pane over MCP, and that mention actually reaches the agent sitting in it.** `channel_post` mentions accepted a workspace and a member id but had no way to say *which pane* — and pane-pinning is what the delivery path keys on, so an instruction posted to a channel by one agent for another could never be delivered automatically. It raised an unread badge and waited to be polled, which an agent that had just finished its work was not doing. Nothing errored on either side: the sender read the silence as "still working". Mentions now take an optional `pane_id` (from `a2a_discover` / `pane_list`), and a pinned mention is pasted into that pane at its next idle moment, exactly as the human composer's mentions already were. The pane must belong to the mentioned workspace — the daemon proves it against the principal registry, refuses a pin it cannot prove, and reports the refusal in `droppedMentions` as `pane_not_in_workspace` rather than dropping it quietly; the mention itself still lands as a badge. A pin naming a pane whose agent has since exited is refused the same way, as `pane_not_live`: an unrefused dead pin does not fail, it falls back to a workspace-level mention, and that fallback pastes into whichever agent the workspace still has — so an instruction addressed to a worker that left would have started a *different* worker's turn with nothing said to the sender. Unpinned mentions are unchanged and stay badge-only, which is the rule that keeps a message meant for a human out of an agent's prompt.

- **The delegation contract is now written down where both sides read it.** `channel_post`, `send_message`, and `a2a_task_send` state in their tool descriptions that a channel post is a notification and does not start an idle agent's turn, and which call does. Agents spawned by fan-out get the same paragraph appended to their opening prompt, so a worker knows before it goes idle that nothing will wake it for a workspace-level channel post. `docs/how-to/delegate-to-agents.md` is the long form.

- **Channels can now be thrown away, and taken back out.** Archiving a channel only made it read-only — the row kept its slot in the sidebar with no way to remove it or fold it out of sight, so a day of fan-out left the channel list unusable and the next day doubled it. There is now a trash: a channel you move there leaves every visible list and drops into a Trash group that is collapsed by default, so eight leftovers cost one line instead of eight. Restoring puts it back in the Archived group. The trash is a stop, not a shortcut — permanent deletion is refused on any channel that is not already in it, so nothing is destroyed without a separate, reversible step in front of it. Trashing, restoring and deleting are all reachable only from the app itself, never from an agent, for the same reason archiving and kicking already were. Trashing a channel that is still live takes two clicks — the first arms the button — because that same step also archives it, and archiving is one-way.

- **The trash empties itself after 30 days, and nothing else does.** `config.json` gains a `channels` section with two settings. `trashTtlHours` (30 days) is how long a channel waits in the trash before it is deleted for good; it is safe to have on because nothing reaches the trash except your own explicit action, so the sweep only ever finishes a deletion you started. `autoTrashArchivedHours` moves archived channels to the trash on their own after a given age, and is **off** — it is the only setting that would discard records nobody chose to discard. Turning it on is still recoverable: it only moves channels to the trash, so the full 30-day undo window applies before anything is destroyed. Set either to `0` to disable it. Both sweeps run at startup and hourly, so a daemon that stays up for weeks still tidies up. The sweep never deletes a channel an open mission still links to, and a channel in the trash is exempt from the older empty-channel reaper, so the full undo window is real rather than nominal.

- **The sidebar footer has a Channels button.** Channels were reachable only through the Agent button, which opens the deck on whatever tab it was last on, or through Settings for anyone whose Channels tab was still switched off — so the one surface that shows what the agents are saying to each other had no direct entry point. The footer cluster is now Agent / Git / Channels / web, with Channels opening the deck on its own tab and closing it again on a second press, amber with a count while anything is unread. The Channels tab defaults to off, so pressing the button switches it on rather than opening an empty tab; the Settings toggle still turns it back off. (#684)

### Changed

- **The first three MCP slices now register through a typed, immutable catalog without changing the wire contract.** Pane and surface lifecycle tools preserve their existing full/commander membership, while the full-only `browser_wait` tool preserves its automation lease, Playwright and packaged-RPC paths, timeout behavior, and exact schema order. The thirteen channel and mission tools now use the same catalog without sharing connection identity: every server still captures its own verified `senderPtyId` resolver, reads it at invocation time, and forwards the same workspace, idempotency, mention, and optional-field mappings through the daemon's authorization gates. Names, descriptions, Zod schemas, global ordering, handlers, and public bytes remain unchanged as these slices move from the deprecated `server.tool()` path to `registerTool()`. The authoring helper and registry boundary freeze descriptor containers, migrated domains share one immutable profile/context selection, and a reusable test assertion keeps commander membership aligned with the legacy manifest while both registration paths coexist. Catalog calls carry an explicit unattributed operation context that is separate from profile selection, so profile and self-declared MCP client metadata cannot silently become authority; authorization remains in the daemon. Effect, retry, lock, annotation, and output-schema claims stay deferred until behavioral tests can prove them.

- **MCP hosts now receive a short server-level map before they search the tool catalog.** The full and commander profiles explain the capabilities they expose, how to discover opaque workspace/pane/surface IDs, which returned content is untrusted, how `send_message` differs from `channel_post`, and how to handle an ambiguous mutation timeout. Both variants keep the critical rules in the first 512 characters and stay below the 2 KiB truncation boundary used by current hosts.

- **The bundled MCP protocol surface is now a checked contract.** A repo-relative probe connects through the public MCP Client and a raw-frame pass over real stdio, checks both full and commander profiles twice, and freezes their ordered tool names, raw result hashes, and instruction hashes behind 75 KB and 45 KB payload budgets. It also checks that commander preserves filtered full-profile ordering, negotiates identical descriptors with the 2025-11-25, 2025-03-26, and 2024-11-05 protocols, and rejects any non-JSON stdout, including shutdown diagnostics. CI builds the actual bundle and runs that probe, so a tool, schema, profile, ordering, instruction, framing, or handshake change must now be deliberate.

- **Diffs are now generated with git's histogram algorithm instead of the default Myers.** Agent work is movement-heavy — blocks relocated, helpers hoisted, imports reordered — and Myers, which optimises for the shortest edit script, anchors that on whatever repeated lines happen to line up (`}`, blank lines), splitting one relocation into several interleaved hunks. Histogram weights rare lines as anchors and emits the same change as fewer, more readable hunks, which matters most where a hunk is the unit you check a box next to. This covers the task diff and the workspace diff behind the diff surface (patch and the file tree's +/- counts together, so they describe the same diff) and the working-tree patch the phone reads before answering an approval. The algorithm is stated on the command line rather than read from `diff.algorithm`, so a setting in your git config cannot leave the two surfaces disagreeing about where the hunks are. Hunk numbering shifts wherever the two algorithms disagree: adoption is unaffected — hunk selections live only for as long as the panel is open, and the patch that gets applied is rebuilt from a fresh read — but a saved diff comment whose hunk header no longer matches now lists under "moved" at the bottom of the file, the same place line drift already put it.

- **`THIRD_PARTY_NOTICES` is regenerated, and its generator is now deterministic.** A drift guard is only usable if regenerating twice produces the same bytes, and two things prevented that. The header stamped the current date, so the file changed every day regardless of dependencies; that line is gone, since git history already records when it moved. More seriously, the package list came from `npm ls`, which reports what is *installed* — optional dependencies constrained by OS and CPU differ per machine, so a file generated on macOS could never match one generated on the Windows CI runner. The package set now comes from the `package-lock.json` production closure, which is identical everywhere and lists every platform variant. That is more correct as well as reproducible: we build installers for macOS, Windows, and Linux from one lockfile, so all eight platform binaries ship somewhere and all eight need attribution. Resolving through lockfile paths also fixes packages present at two versions — `debug@2.6.9` and `debug@4.4.3` now each carry their own license text instead of both collapsing onto the hoisted copy. No dependency was added, removed, or changed.

- **The event-polling contract now describes the cursor replacement that already happens during resync.** On ordinary responses, `nextCursor` is non-decreasing; a response with `resync: true` may instead return a value lower than the cursor the client supplied — including `0` for an empty ring — when it needs to re-anchor a cursor that points past the newest event. Clients must not clamp that replacement. The required resync flow still calls `pane.list` and resumes from its `asOfSeq`; a client that instead retries the poll with its previous, larger cursor repeats the same resync page indefinitely. No runtime behavior or wire shape changed.

- **The README no longer undersells diff adoption as all-or-nothing.** "Adopt hunks all-or-nothing" read as if the whole diff went across in one lump, which is the opposite of what the code does: you tick individual hunks, across files, and only that selection is adopted. The all-or-nothing part is the *apply* — the hunks you picked are combined into a single `git apply` gated by a target snapshot, so the target takes your whole selection or stays untouched. The README states the exclusions the code actually enforces rather than promising every file: renames, binaries, mode-only changes and files past the display cap are display-only and cannot be ticked, and an adoption is refused whole if the target moved, has uncommitted changes to those files, or a selected hunk no longer applies. Wording only; adoption behaviour is unchanged.

- **The built-in browser is described as integrated rather than as something only wmux has.** Driving a real browser from an agent stopped being a differentiator once the vendors shipped their own, so the browser row moved to the end of the "Why wmux?" table and now states what it is — Chrome over CDP in the same window, reachable through the same MCP surface — instead of leading with it. The feature is unchanged and still documented in full.

- **The protocol docs now state that the daemon control connection is multiplexed.** Replies and pushed events share one stream, with no subscription step, and are told apart only by whether they carry the `id` of the request you sent. Clients that wrote a request and read exactly one line back therefore worked until an event arrived at the wrong moment, then reported a failure with an empty error message and dropped the real reply — a failure mode that can invent failures but never successes, which sent two teams debugging in the wrong direction. `docs/PROTOCOL.md` §2.9 now spells out the correlation rule. No behaviour changes; correctly-written clients were never affected. (#659)

- **The MCP RPC client can hold a single call open instead of giving up after ten seconds.** `sendRpc` takes a per-call `longPollMs`, which raises that one call's ceiling (capped at 15 minutes) and — in the same option, deliberately not a second one — switches its retries off. A waiting call that retries reopens the same wait several times over, so "long timeout, keep retrying" is not expressible. Every existing call is untouched: the global timeout and retry constants are unchanged and still apply to everything that does not ask.

- **Missions disappear from the sidebar when their fan-out workspace does.** A finished mission used to sit in the MISSIONS list permanently expanded, so five fan-out tasks meant five rows that could not be dismissed or collapsed. Missions are now bound to the lifetime of the workspace they run in: when the workspace goes, so does the row. **The record is not lost** — it lives in the mission channel, which survives untouched; closing a mission archives its channel, it never deletes it. Deleting a task workspace now also closes its mission, which is what stops the channel from lingering in the live list. A mission that is finished while its workspace is still around stays reachable under a "Done" disclosure that starts collapsed, and the MISSIONS section itself can now be folded away. A mission whose workspace has not been created yet (fan-out still running) is always shown — it has no workspace yet, which is not the same as having lost one. (#683)

- **Release notes are now assembled from one file per pull request.** Every PR used to add its entry at the same line of `CHANGELOG.md` — the one directly under `### Added` — and git cannot order two insertions at the same position, so it reported a conflict. With eleven branches open, merging one of them left five others conflicted, and a conflicted PR quietly stops running CI, so the state of the queue became unreadable within a day. A PR now adds `changelog.d/<pr-number>.md` instead, and separate files cannot collide; `node scripts/collect-changelog.mjs` folds them into `CHANGELOG.md` at release time, in PR-number order. Nothing changes for readers — the published changelog keeps the same shape and the same Keep a Changelog sections.

- **`pane_not_live` now says what it does and does not promise.** It means no live terminal is behind the pane. It does not mean a live *agent*: an agent can exit back to its shell while the pane and its terminal stay perfectly alive, and a mention pinned there is still delivered — it lands at a shell prompt. The daemon also checks at send time while the receiving app re-checks at delivery time, so a pane that dies between the two still meets the old fallback. Both limits are now written into the tool description and the API contract rather than left to be discovered.

- **Every pane now identifies itself as `TERM_PROGRAM=wmux`, unconditionally.** The terminal-capability injection shipped earlier treated all three variables the same way: set them only if nothing set them first. That is right for `TERM` and `COLORTERM` — a user or profile that configures those knows better than we do — but wrong for `TERM_PROGRAM`, which is not a capability but an identity. A dev build launched from another terminal inherited that host's value (`iTerm.app`, `WezTerm`) straight through the filter, so tools that branch on `TERM_PROGRAM` saw the wrong host. It is now forced at the end of the spawn funnel, after the account and workspace-profile overlays, so neither an inherited value nor a profile entry can make a wmux pane claim to be something else. On Windows, any case-variant of the key (`Term_Program`) is removed rather than left to fight the canonical one. `TERM` and `COLORTERM` remain overridable defaults.

### Fixed

- **MCP handshakes now advertise the real wmux version instead of `0.0.0`.** Self-contained bundles receive the package version at build time, while source, unbundled dist, and stable-copy layouts have validated SemVer fallbacks; if every source is missing or malformed, the server refuses to start instead of publishing a false version. MCP shutdown diagnostics also stay on stderr so they can never be mistaken for a JSON-RPC frame on the stdio transport.

- **Saving state on Windows no longer fails just because an antivirus scanner was still looking at the file.** Real-time scanners open a handle on a file the moment it is written, and while that handle is held, the rename that commits the new copy into place fails outright. The window is a few tens of milliseconds, so it hit rarely and unpredictably — but by the time it hit, the previous copy had already been moved aside to `.bak`, meaning the failure left no current file at all. That is what turned a momentary scanner overlap into a permanently half-finished `lanlink` pairing on two Windows hosts. The commit step now waits and retries a handful of times, for at most a third of a second in total, before giving up. Only that one step retries, only on Windows, and only for the three error codes a held handle produces; every other failure is reported exactly as before, and behaviour on macOS and Linux is unchanged. (#658)

- **A `lanlink` pairing that cannot be saved no longer leaves one machine paired to a peer that has never heard of it.** If writing the peer file failed, the machine accepting the pairing had already added the peer in memory — so it went on listing a healthy peer over a file that was gone, while the same failure dropped the connection before it could confirm anything to the other side. The machine that started the pairing got `connection closed`, saved nothing, and had no way back: sending to that peer failed locally as unknown, and messages from it were dropped for lack of a secret to read them with. Reproduced by two teams across both role directions, on Windows. Saving is now all-or-nothing — if the write fails, the in-memory copy goes back with it, so neither side is left holding a pairing the other cannot honour. Revoking a peer and burning a misbehaving one deliberately keep their in-memory effect even when the write fails, because restoring those would keep delivering to a peer the user just removed. Note this fixes the *silent, permanent half-pair*, not whatever made the write fail: on a host where the peer file cannot be written, pairing still fails — but now it fails on both sides. (#658)

- **A `lanlink` peer that hangs up mid-pairing now says what that probably means.** The joiner reported a bare `connection closed`, which reads like a transport fault — so both teams that hit the bug above went looking underneath lanlink, at firewalls and MTU and the overlay network, when the peer had simply failed to save the pairing. The message now names the two real possibilities and states that neither side ended up paired. No wire format changes: the responder has no authenticated channel to send a reason on at that point, and a cleartext one would both leak whether the PIN was right and be forgeable by anyone on the network. (#658)

- **Adopting hunks from a task diff can no longer apply something other than what you ticked.** The adopt step re-read the task's diff at the moment you pressed the button and matched your selection onto that fresh read by file path and hunk position — so anything the agent wrote to its worktree between opening the diff and adopting it was silently adopted in place of what you reviewed. The same mapping dropped selections instead of refusing them: a file that had left the diff was skipped, a hunk index that no longer existed was dropped, and the adoption went ahead with whatever was left, reporting success. This is the normal path for the fan-out journey, where agents keep writing while you review. Each file in a diff read now carries a fingerprint of exactly the entry you were shown, the adopt request carries it back, and the handler refuses the **whole** adoption — never part of it — if any selected file changed, left the diff, or no longer has the hunks you picked, naming the files and hunks it refused. The three existing refusals (target moved, target file has uncommitted changes, hunk does not apply) are unchanged. A Reload keeps your ticks, which is the point of the manual reload — but only for the files that did not move. Any file the reload shows differently loses its ticks, so a selection can never be carried onto content you have not looked at. The fingerprint sent with an adoption is the one recorded when you ticked, not one read back off the entry being adopted.

- **A diff no longer comes up with file counts but no hunks if you have configured a different diff tool.** The diff panel asked git for the patch without pinning git's own engine, so a global `diff.external` — difftastic is the common one — answered with that tool's output instead, which the panel parses as no files at all. The file counts next to each path come from a separate query that never consults `diff.external`, so the tree showed additions and deletions for files whose diff was empty, with nothing saying why. The same call also let content-rewriting `textconv` drivers through, which are on by default for `git diff` and produce a patch that cannot be applied to anything — including by adopt. The patch is now always read from git's own engine. The file counts are unchanged: they were measured to be unaffected by either setting.

- **Listing missions now requires the caller to be identifiable, instead of trusting the workspace it names.** `task.mission.list` returns one owner's mission titles, branches, absolute worktree paths, pane group ids and channel ids, but it was registered as an ordinary read — so when a caller's terminal could not be resolved, the workspace it asked about was simply believed. The bundled MCP server falls back to the `WMUX_WORKSPACE_ID` environment hint when it cannot find its own terminal, and on that path it sends no terminal id at all: a process started with someone else's workspace id could list that workspace's missions, while the tool description said only your own were returned. The method is now refused without a resolvable terminal, exactly like the mission calls that change state; the in-app views are unaffected, since they read through the renderer bridge rather than the wire. The remaining limit is the one that applies to this whole surface and is documented as such: the terminal id travels in the request, so another process running as you can still present one that is not its own.

- **A pane whose agent was killed mid-run no longer comes back with its output trapped in a narrow window.** A full-screen TUI pins its input box to the bottom of the screen by arming a scroll region (`ESC[<top>;<bottom>r`), and releases it on exit. An agent that dies mid-run never gets to release it, so the sequence sits in the daemon's ring buffer — and replaying that buffer into a fresh terminal on reconnect armed the region all over again. Everything written afterwards scrolled inside those few rows while the rest of the screen stayed frozen, and scrolling up did not reach real history: it showed whatever happened to be frozen there when the region was armed. The replay now releases the region, alongside the input-mode resets it already applied. Nothing is erased in the process — releasing a scroll region only widens where future output is allowed to scroll, so restored scrollback comes back exactly as before — and the cursor is saved and restored across the reset, because releasing the region would otherwise snap it to the top-left corner and lose the position the replay had put it in. (#688)

- **A channel mention pinned to a pane whose agent had left could start a *different* agent's turn.** The daemon checks that a pinned pane still has something live behind it, but only when the sender supplied no pty of its own — and the app's own composer attaches one to every mention it sends, so for anything typed by a person the check never ran. Mention a pane, have its agent exit before the mention is delivered, and the stale coordinate rode through: the receiving side could not match it, the mention fell back to workspace level, and the fallback pasted into whichever agent that workspace still had. The instruction you addressed to one worker woke a different one, and nothing told you. The pty a mention carries now always comes from the daemon, never from the sender, so the same check runs on every path.

- **After a daemon restart, mentioning an idle agent by pane stopped working.** The daemon marks every known pane "stale" when it restarts, and only the app can mark them live again — which it does when a pane produces output. An agent that has finished its work and is waiting produces none, so it stayed marked stale indefinitely and every pane-pinned mention aimed at it was refused as `pane_not_live`. That is exactly the agent you pin a mention to. The daemon runs the terminals, so it now answers "is this pane alive?" from its own session table instead of a record only the app can refresh.

- **Browser automation no longer opens a second browser pane just because another workspace's browser registered first.** A browser target takes a moment to register after it opens, so target discovery waits a short grace period rather than reporting nothing. That wait was skipped whenever *any* target was already registered — including one belonging to a different workspace. The caller then saw an empty scoped result, concluded it owned no browser, and opened another one: two panes for one workspace, and afterwards a nondeterministic choice between them. The grace period is now decided after the caller's workspace scope has been applied, so only the caller's own targets can end the wait early — a registration that finishes inside the grace period is no longer missed because a stranger's target was already there. The wait remains bounded, so a registration slower than the grace period still reports nothing. External-browser mode, which has no builtin target by design, skips the wait entirely instead of stalling on it. (#697)

### Security

- **An agent whose workspace cannot be identified no longer reads or drives another workspace's browser.** Every browser tool that routes by workspace already refused in that situation — `browser_open` and `browser_close` fail with "Workspace identity unknown", `browser_tabs` answers `BROWSER_TABS_WORKSPACE_UNRESOLVED`, and the engine's automatic open sends no request at all — but page selection, the step behind `browser_snapshot`, `browser_evaluate`, `browser_extract_*` and the rest, quietly stayed lenient instead: with identity unavailable it fell back to "the first live browser guest anywhere", which is whichever workspace happens to own one. No spoofing was needed to reach it. An agent running under a sandbox that blocks process-tree inspection genuinely cannot resolve its own identity — that case is documented in the identity resolver itself — so a perfectly well-behaved agent could land on someone else's page under normal conditions. Page selection now refuses like its siblings, with `WORKSPACE_SCOPE_UNRESOLVED` and the specific reason (identity unresolved, the control connection down, or a wmux app too old to label browser targets by workspace), so the caller can tell a temporary failure from a permanent one instead of silently getting a page. A caller that resolves normally is unaffected; a caller that names an explicit `surfaceId` is unaffected; and against an app too old to label targets, a workspace with no browser open at all still gets one opened automatically and driven, because "nothing is open anywhere" is not ambiguous about whose page you would end up on. The consequence, stated plainly: where browser automation used to work by luck without identity, it now reports why it will not. Scope, equally plainly: this is the page-selection step. Tools that fall back to the app's own screenshot/evaluate handlers when no page is available still pick the default target the way they always have, which is a separate gap and not one this change touches.

### Contributors

- **[@snowyukitty](https://github.com/snowyukitty)** — the typed MCP tool catalog foundation (#686) and the `browser.cdp.info` workspace-scoping race fix (#697), the latest of more than twenty merged PRs spanning the browser workspace-scoping work, CI hardening, and terminal fixes going back to March. #686 in particular is a large, deliberate piece of work — a design doc, a wire-neutral migration path for the MCP tool registry, and a golden-wire probe that pins the exact bytes a host sees — reviewed independently by three separate models before merging without a single confirmed defect. Thank you for the sustained investment in this codebase.
- **[@moqing123456](https://github.com/moqing123456)** — forcing `TERM_PROGRAM=wmux` so a pane never advertises an inherited host terminal's identity (#696), a follow-up to their own #685/#681 from the terminal-capability work. Their third merged contribution.
- **[@AdgDean](https://github.com/AdgDean)** — fixed a DECSTBM scroll region left set by a dead TUI's replay bleeding into the next program (#688). Their first contribution — welcome, and thank you for finding and fixing a real terminal-emulation bug.

Maintained by [@openwong2kim](https://github.com/openwong2kim), with engineering and code-review pairing by Claude (Anthropic).

## [3.37.2] — 2026-07-28

### Changed

- **wmux describes itself as the workspace multiplexer for AI agents, not AI coding agents.** The panes, channels, worktrees, and browser wmux multiplexes were never specific to agents that write code, and the narrower line kept implying they were. README, the package description, and the Chocolatey summary now say "AI agents"; nothing about what wmux detects or how it behaves changes.

### Added

- **A phone that is too old to talk to your daemon can now say so.** The phone API had no version on it, so once a mobile build ships it is pinned to whatever HTTP surface the daemon happens to serve — and a mismatch would have surfaced as routes failing one by one with no explanation. `GET /api/config`, the call a client already makes at connect, now reports the protocol the daemon speaks, the oldest one it still accepts, and the release it was spawned from. A client below the floor can show "update the app" instead of a broken screen. Nothing that already works changes: a daemon predating this simply has no version fields, which reads as the pre-handshake protocol, and a phone that ignores them behaves exactly as it does today.

### Fixed

- **The cold-start perf gate no longer fails the build because CI got a slow machine.** The gate compared the median of three boots against a blessed baseline, and its only defence against a noisy runner was to measure again — on the same runner. That covers a spike lasting a second; it does not cover a host that is degraded for the whole job. One was on 2026-07-27: the daemon needed 2.2s just to spawn its Node process and 2.0s to take a file lock, the median landed at 2470ms against a 1207ms baseline, the re-run reproduced it exactly as designed, and main went red over a commit whose entire diff was the length of a web pairing code. The gate now reads the **fastest** of the boots, because interference is one-sided — a busy host makes a boot slower, never faster — so the fastest one is the sample least polluted by the machine. That run would have read 1442ms and passed; a real regression slows every boot and still trips both thresholds. The median is still measured, still published to the trend, and now reported on its own when it regresses while the fastest boot does not, since a slowdown only some boots hit is worth a look even though it is not worth a red build.

- **The "Serve panes to a browser" Start button no longer fails with "tailscale is not on PATH" when Tailscale is installed.** On macOS, an app launched from the Dock inherits launchd's minimal PATH, so the GUI could not find a `tailscale` CLI that worked fine in a terminal — the HTTPS option failed with `spawn tailscale ENOENT` even with the desktop app installed. The GUI now searches the way a shell would (Homebrew, `/usr/local/bin`, `~/.local/bin`) and falls back to the CLI inside `/Applications/Tailscale.app` itself, which a stock install never puts on any PATH. `wmux web --tailscale` in a terminal was never affected.

- **A pane no longer goes dead while the shell inside it keeps running.** On Windows, node-pty sometimes reports that a terminal exited when in fact only its output socket closed — the code it hands back is empty, and `powershell.exe` and whatever agent it was hosting are still very much alive. wmux believed the report, marked the pane dead, and walked away, which meant an agent kept burning memory and API quota with nothing left to reach it or shut it down, and the pane came back in your home directory instead of your project. wmux now asks the operating system whether the process is actually gone before believing any exit that arrives without a code. If it is still there, wmux shuts the whole tree down itself — the shell and everything it started — and closes the pane properly, saying so in the log. The exact report from the terminal layer is logged verbatim, which is what the underlying investigation needs. Real exits are untouched: an exit that carries a code, or a signal, still behaves exactly as before. (#646)

- **Shells orphaned by that bug are now cleaned up at startup.** Because the pane had already been written off, nothing ever reaped those processes — one report found shells still running eleven and twelve days after the daemon that spawned them had gone. On startup wmux now checks its own records of closed panes: if one still points at a running process, and the machine has not rebooted since (so the process id can't belong to something else), and it really is the shell wmux started, it is shut down and noted in the log. Anything uncertain is left alone.

### Security

- **Web pairing codes now use eight characters instead of six.** The existing unambiguous base-32 alphabet now provides 40 bits of code space while preserving the ten-minute lifetime, single-use redemption, five-attempt burn limit, and timing-safe comparison. QR pairing still requires no typing; manual pairing asks for two additional characters. (#615)

## [3.37.1] — 2026-07-27

### Fixed

- **"Check for updates" now works with auto-update switched off.** The toggle was wired through the one gate every check passes, so turning background polling off also turned the manual button into a no-op that reported "checking" and went silent — leaving reinstalling as the only way to update. The toggle now silences background polls only; pressing the button is an explicit request and always checks.

## [3.37.0] — 2026-07-27

### Added

- **Recognise another agent host without waiting for a wmux release, and find out what it is calling itself.** wmux recognised exactly three MCP clients by name, compiled into the app; anything else — Hermes, Aider, Cline — sat at `unconfirmed` forever under enforce mode, and the only escape was turning enforcement off for everything. You can now add a host in `~/.wmux/config.json` under `mcp.firstPartyClients` and restart. It changes *who* is recognised, never *what* they may call: a configured host gets exactly the same curated method set as the built-in three, an explicit `denied` still overrides it, and a malformed config adds nobody rather than everybody. Two names are refused no matter what you write. `mcp` is what the Python MCP SDK reports for any client that never named itself, so allowlisting it would recognise every anonymous client on the machine at once — and it is exactly the string you would find and copy, because that is what a real agent turned out to be reporting. `wmux-cli` is wmux's own CLI, which is deliberately allowed *less* than a first-party host, so naming it would quietly widen it. Finding the name at all used to mean reading `~/.wmux/plugin-trust.json` by hand; a blocked call now tells you which name wmux saw, and `wmux mcp clients` lists every client that has ever connected, marking the ones you cannot configure and why. It reads the file directly, so it works with wmux closed — which is when you are editing the config. (#636)

- **Run the orchestrator on Claude Code's own terminal — Settings → Orchestrator brain → "Claude Code (terminal)".** The orchestrator has always been a headless Claude session, which is the one mode a Claude subscription might one day stop covering. This adds a second way to run the exact same orchestrator: wmux launches your own `claude` binary as a real interactive session and drives it by typing, which is what a subscription unambiguously pays for. Pick it in Settings and the Orchestrator tab shows that terminal in place of the chat bubbles — you watch the orchestrator think, call tools, and finish a turn in its own interface, and the composer keeps working exactly as before. The conversation survives an app restart the same way the headless brain's does, and a saved conversation the CLI no longer knows about quietly starts a fresh one instead of failing. It keeps the same hands and the same limits as the default brain: the wmux fleet tools are pre-approved, and shell, file edits, and built-in subagents are refused outright — twice over, so a permission rule can't widen them. Switching brains never mixes threads: each one keeps its own conversation. Needs daemon mode and a `claude` install; without either, it says so and falls back to the default brain rather than sitting there dead. The default brain, and everything about it, is unchanged.

- **Each workspace's terminal orchestrator gets its own home — and its own CLAUDE.md.** The terminal brain used to run every workspace's orchestrator out of one shared directory, which meant one shared transcript namespace and nowhere to give a single workspace standing instructions. Each orchestrator now lives in `brains/<workspace-id>/` under the wmux data dir; drop a `CLAUDE.md` in there and that workspace's orchestrator reads it on every fresh conversation — per-workspace conventions with no wmux configuration involved. A conversation saved under the old shared home starts fresh after this change (the same quiet fallback as any conversation the CLI no longer knows about).

- **Send a photo from your phone into a pane.** A phone has a camera and your desk does not, and until now there was no way to get a picture of a whiteboard, an error on a screen, or a broken part in front of an agent without walking it through your Mac by hand. `wmux web` started with the new `--allow-upload` flag accepts a JPEG or PNG from a paired phone, writes it into `~/.wmux/uploads/phone/`, and hands back the path — which the phone puts in the composer for you to send, or not. Nothing is typed on your behalf. It is a separate flag from `--allow-input` on purpose: typing into a pane you are watching is a smaller thing than writing a file into your home directory, so one never grants the other. The format is decided by the file's own leading bytes rather than by whatever the client claimed it was sending, the name on disk is the server's (a client-supplied filename is a path, and nothing reads these by name), the cap is 10 MB, and files are deleted 24 hours after they are written — the sweep only ever touches its own uploads, matched against the exact name it generates, so a `photo-vacation.jpg` of your own staged in that directory is neither deleted nor counted. Two further bounds keep a misbehaving client from turning a 10 MB request cap into an unbounded cost: at most four uploads may be buffering at once (a fifth gets a retryable 429), and the directory holds at most 100 files or 200 MB of the route's own output before it answers 507 until the sweep frees room.

### Fixed

- **A successful `wmux web --stop` now means the listener is off now and stays off after a daemon restart.** If Windows refuses to delete `web-state.json`, wmux securely replaces it with a disabled record that contains no bearer token; if neither operation succeeds, it still stops the live server but reports that persisted state could not be revoked instead of acknowledging a durable stop. The popover shows that real error instead of claiming the daemon is offline, and a Tailscale front is still removed once a fresh status check confirms the listener did stop. A reusable web token is now written only after its inode has been synchronously hardened, POSIX overwrites repair mode `0600`, and boot restore no longer rewrites an identical record merely to re-harden it — existing permissions are repaired asynchronously without freezing the daemon event loop. (#620)

- **The terminal orchestrator now runs on wmux's configuration only, not yours.** Launching it passed our generated settings file to Claude Code, which *adds* a settings source rather than replacing them — so your own `~/.claude` settings came along too, including an `apiKeyHelper` that would have quietly moved the orchestrator onto metered billing, plus your hooks and plugins. It now loads project-level settings only. Your per-workspace `brains/<workspace-id>/CLAUDE.md` still applies exactly as before.

- **A terminal orchestrator whose Claude Code session ends no longer locks the composer for half an hour.** If the session exited — a sign-in that failed, a crash, a `/quit` typed in the embedded terminal — nothing told the turn, so it waited out its full 30-minute ceiling with the composer disabled. The turn now ends the moment the session does, says so, and the next message starts a fresh one. A turn that really does hit the ceiling now also stops the session it gave up on, so its late answer can never be attached to your next question.

- **The embedded orchestrator terminal survives a window reload, and disappears when it should.** After a reload the Orchestrator tab fell back to the bubble view even though the terminal was still running, because the only announcement was a one-time push it had missed; it now asks for the current terminal when it mounts. In the other direction, every teardown — a restarted conversation, a cleared conversation, a switch of brain — now retires the terminal instead of leaving the deck showing a session that no longer exists. And a startup that failed halfway can no longer leave a `claude` process running with nothing attached to it.

- **The terminal orchestrator no longer deadlocks on Claude Code's own prompts.** With permission prompts left on, the first turn hit Claude Code's folder-trust or permission dialog — which appears before the orchestrator is ready, so the turn never finished, the composer stayed disabled, and the embedded terminal was display-only. There was literally no way to answer it. The embedded terminal now takes keyboard input: click it (or just start typing on a fresh one) and the arrow keys and Enter go straight to the dialog. And if a turn does start on a dialog, it hands control back with a note telling you to answer it below, instead of sitting there for half an hour. wmux never answers those prompts for you and never edits your Claude Code settings — trusting a folder is your call.
- **The orchestrator no longer appears in its own fleet.** The terminal orchestrator's session was being reported like any other agent, so the FLEET card and the briefing listed "Claude Code — needs your input" alongside the agents it was commanding. It is now excluded everywhere a roster is built — including the pane list your phone sees over `wmux web`, where it was attachable and approvable from a device with no way to know it was the orchestrator itself.

- **The terminal orchestrator starts on Windows.** The generated launch line was quoted for a POSIX shell, and PowerShell — which is what actually runs it on Windows — reads a command beginning with a quoted path as a piece of text to print rather than a program to run, and does not treat a backslash as an escape. So it printed the path, exited, and nothing started. It is now written the way PowerShell reads it. Nothing changes on macOS or Linux.

- **The terminal orchestrator obeys the model picker and your account binding.** Choosing a model for the orchestrator did nothing when the terminal brain was selected — it always ran on whatever your `claude` defaults to. And a workspace bound to a second Claude account silently ran on the default one instead: the environment scrub that keeps a nested session from breaking transcripts was also throwing away the account you had chosen. Both now apply.

- **A terminal orchestrator whose session vanished mid-message says so immediately.** If the underlying session disappeared between turns, the keystrokes went nowhere and the turn waited out its full 30-minute ceiling with the composer locked, waiting for an answer that could never arrive. It now fails on the spot.

- **The orchestrator no longer skips your autonomy and policy rules after a failed first turn.** Those blocks are sent to a terminal orchestrator only when they change, so they don't drown the visible conversation — but they were being marked "already sent" when the message was assembled, not when the orchestrator actually received it. A first turn that stopped on Claude Code's folder-trust or sign-in dialog therefore burned them: the retry, and every turn after it, ran without them. They now count as sent only after a turn that finished cleanly.

- **The terminal orchestrator is no longer told to remember things it cannot remember.** It was given the headless brain's memory policy — "write durable facts to your memory folder at the end of each turn" — while running in a mode where writing files is refused outright, so every attempt was blocked and it believed it had saved things it had not. It is now told plainly that this mode has no durable memory, and to hand anything worth keeping to you for your workspace's `CLAUDE.md`.

- **The collapsed orchestrator terminal comes back at the right size.** Collapsing the embedded terminal left it measuring a zero-height container, so it shrank itself to nothing and stayed wrong until the next window resize.

### Security

- **The terminal orchestrator's generated config files are no longer world-readable.** Launching it writes a settings profile and an MCP config into the wmux data directory, and the MCP config carries the token that authorises that orchestrator's wmux tool calls. Both were written with default permissions, so any other account on the machine could read the token and drive your panes with it. They are now owner-only (`0600`) inside an owner-only directory (`0700`). This sits inside the same-user ceiling `docs/SECURITY.md §3` accepts; it closes the multi-user gap.

- **A repository path from the Git tab is confined before any `git`/`gh` command runs in it.** The worktree, diff, and GitHub-PR IPC handlers used to validate a renderer-supplied `repoPath`/`worktreePath`/`cwd` as a non-empty string and then hand it straight to `git -C <path>` (or `gh` in that directory). The path now passes through the same sensitive-path guard that `fs:readFile`/`fs:writeFile` and `git:status` already use — it is canonicalized with `realpath` and rejected if it resolves into a blocked location (`~/.ssh`, `~/.aws`, `~/.gnupg`, credential stores, the auth-token files, …), so a request cannot make a git command operate inside a secret directory. This sits inside the same-user ceiling `docs/SECURITY.md §3` already accepts — it is a consistency fix that brings these handlers up to the confinement the filesystem handlers had, not a new boundary. (F2, #615)

## [3.36.0] — 2026-07-26

### Added

- **See what an agent actually changed before you approve it.** An approval prompt on a phone gave you a screenful of terminal and a yes/no button — the agent asked to edit a file and the one thing you needed was what the edit was. `wmux web` now answers that from the pane's own repository: the changed file list and the full patch, staged and unstaged, read straight out of git. It works on a read-only server, because reading a diff is reading. A pane that is not in a git repository says so plainly rather than looking broken — running in a scratch directory is normal, and only git itself gets to say a directory is not a repository: a git that could not be run at all reports a failure instead of blaming your working tree. Files the agent has just created are in the patch too, which plain `git diff` never shows. Large diffs are capped at 512 KB so a phone on a train is not made to pull a generated-file commit to answer one question, and if any part of the patch could not be collected the response says so — an empty patch that silently meant "a git command failed" would read on a phone as "nothing changed", which is the one wrong answer to show someone who is about to approve an edit. Two things it deliberately does not trust. It reads the directory the pane was **spawned** in, not the one the pane says it is in now: the live directory is tracked from terminal escape sequences, which any process running in that pane can emit, so following it would let a program inside a pane point this read at any repository on the machine. And it treats the repository as hostile input, because an agent may have cloned it from anywhere — every git command runs with external diff drivers, textconv filters, filesystem monitors and the whole inherited `GIT_*` environment disabled, so none of the several config keys and `.gitattributes` entries that are *commands git will execute* can execute anything. It also never takes git's index lock, so reading a diff cannot block or break the agent's own commit. At most two diffs are collected at once daemon-wide, and simultaneous requests for the same pane share one answer.

- **Open and close panes from the phone.** `wmux web` can now spawn a new pane (optionally in a chosen workspace and directory) and close one, so a phone is no longer restricted to the panes that happened to exist when you left your desk. Both require the server to have been started with `--allow-input`: an interactive shell is arbitrary execution, and closing someone's pane ends their running build, so neither belongs on a server that promised to be read-only. A pane created this way is a real, monitored, recoverable session — it is not yet drawn in the desktop window's layout. A named workspace has to be one the daemon can actually see a live pane running in: the workspace list belongs to the desktop, and the daemon accepting an unverifiable id would have let a caller file a pane under any workspace it cared to name. The cost is stated plainly in the API docs — a real workspace with no panes open cannot be named until one is — and spawning without a workspace always works.

- **Attention events now say how much of a human they are asking for.** Every event on `/api/events` (SSE and the JSON backlog) carries `tier`: `act` when someone is blocked on a person — an approval was raised, a `critical`-risk action fired — and `info` for a notification, a `review`-risk signal, or the lifecycle echo of an approval that is already over. Clients were each re-deriving urgency from the event kind, which meant the answer lived in every app instead of in the daemon. The vocabulary is deliberately two plain words rather than one platform's notification taxonomy: the wire states the fact, the client decides what to do about it. Additive — a client that ignores the field behaves exactly as it did before, and the tier is stamped after the payload, so a pane cannot declare its own critical event unimportant.

- **An approval that names a destructive action is flagged as such.** Approval records gain an optional `risk: 'critical'`, set at creation when the question or an option label matches the same destructive-action patterns that already raise the `critical` signal (`rm -rf`, `git push --force`, `DROP TABLE`, `terraform destroy`, …), and carried through persistence, `GET /api/approvals`, and the `approval` event. It is a hint for a client that wants to step up its confirmation — Face ID, a second tap — and never a gate: the patterns are regexes over agent-authored prose, they miss and they over-fire, and answering a flagged request works exactly like answering any other. Absence means "nothing matched", not "safe".

### Fixed

- **A red perf gate is now confirmed by a re-run before it fails the build.** The gate has been red-lighting on CI without a code change to explain it: the same commit measured `coldStart.firstPtyDataMs` at 3038 ms and 1385 ms an hour apart, and one `inputLatency8` run cleared its fail line by 0.05 ms. A gate that fires at random teaches people to re-run rather than look, which is the state where a real regression walks through. When the gate fails, CI now measures the failing scenarios once more on the same runner and only keeps the red if the failure reproduces — a deterministic regression should, a shared-runner tail spike should not, and the trade is stated plainly in `bench/README.md`: a regression that only appears in half of runs now has to land twice. No baseline moves, in either direction: the thresholds are exactly what they were, and "descriptive, not aspirational" is untouched. What gets re-measured is the whole app instance the failing metric was measured on, never the single metric — the benchmark runs several scenarios in sequence on one instance and each inherits what the previous ones left behind, so a narrower retry would measure something else and its verdict would mean nothing. The first run's numbers are never overwritten: they are what gets published to the perf trend, tail sample and all, and the job summary shows the two measurements side by side so a cleared red is still visible rather than silently swallowed. Everything that is not an explicit second pass keeps the build red — a crashed re-run, an unreadable result, a failing scenario that did not run again, or a sibling scenario from the selected app instance that disappears after the first run measured it — because "could not confirm" is not "it was fine". The two correctness checks (the IME composition and the WebGL context recovery) are deliberately never re-run: they are pass/fail consistency checks rather than tail-prone measurements, and "it worked the second time" is not a reason to ship a broken one — and if one of them breaks *during* a re-run, that keeps the build red too, even though it is not what went red first. Two long-standing footguns in the same tool are closed along the way: pointing an output at `--current` or `--baseline` (which used to overwrite the input and still report the gate's verdict) and a result file that is valid JSON but not a result object (which used to pass green, because every gate read as "not measured") are both now refused outright. Costs CI time only on runs that are already red. (#570)

## [3.35.1] — 2026-07-26

### Fixed

- **The app's `web` popover can now actually connect a phone.** It offered two options and neither worked: the default served only to this machine, so the address it showed was meaningless on a phone, and "Expose to network" reached the phone but then refused to pair, because a device credential never expires and is not handed out over plain HTTP. Worse, the popover advertised a fresh pairing code every ten seconds in exactly that state — you read six characters onto a phone and only the redemption told you it was never going to work. There is now a "Serve over HTTPS (needs Tailscale)" option that sets up the same one-command Tailscale front `wmux web --tailscale` uses, and when pairing cannot succeed the popover says why and what to do instead of showing a code. If Tailscale is missing or logged out, the popover says which of those it is and links straight to the install page rather than leaving you a URL to retype. Ticking it unticks "Expose to network" and the reverse: `tailscale serve` proxies to this machine only, so a wildcard bind alongside it is a second and weaker way in, not an addition. "Expose to network" now also says plainly that it serves panes for watching but cannot pair a phone.

- **A tailnet address is no longer advertised after its front disappears.** The server remembers the HTTPS name it was started behind and puts it back after a restart, but nothing checked whether `tailscale serve` was still configured — so a `tailscale serve reset`, a logout, or a tailnet switch left the app showing an `https://` address that reached nothing. It is verified now at the moments a human is about to use it (opening the popover, turning the option on, minting a code) and dropped with an explanation when it is gone. Deliberately not checked on the background refresh: that would start a Tailscale process six times a minute for something that only changes when someone acts.

### Added

- **Devices are named before they are paired, from the desktop.** Pairing from the app produced a roster of entries all called "Unnamed device", which makes the one thing the roster is for — revoking a single lost phone — impossible six months later. The pairing code is now shown only after you name the device, and the name is asked for on the desktop, where there is a keyboard, rather than on the phone. Existing paired devices are unaffected, and pairing from the CLI already worked this way.

- **Pair a phone by scanning a QR code, with nothing to type.** The popover now shows a QR next to the pairing code, and it carries the address and the code together, so a scan finishes the pairing. The address was always the miserable part on a phone — a raw tailnet hostname gets no autocomplete and no search suggestion — so a QR that only opened the pairing screen and still wanted six characters typed would have removed the easy half. The plaintext code stays on screen for a phone that will not scan. The code is stripped from the phone's address bar the moment it is read, so it does not sit in browser history; it is single-use and expires in ten minutes either way.

## [3.35.0] — 2026-07-25

### Security

- **The `wmux web` page now ships a full Content-Security-Policy (#608).** The page previously carried only frame protection. It now declares a strict policy — every inline script is allowed by its exact hash (no `'unsafe-inline'`), and `connect-src 'self'` means that even if a rendering bug ever reintroduced an XSS, the injected script could execute but could not send the access token anywhere. The hashes are computed by the daemon from the exact page bytes it serves, so the policy can never drift out of sync with a build. Purely defense-in-depth: there is no known XSS today, and nothing changes for a working session.

### Added

- **The first-run wizard now offers to enable the Claude Code statusline.** `wmux setup-statusline` — which shows model, context usage, and 5h/7d rate limits under Claude Code's input box — existed only as a CLI command, so app-only users never discovered it. The onboarding wizard now shows an opt-in "Enable statusline" step (macOS and Windows) when Claude Code is detected and at least one settings file can accept the install. It stays strictly opt-in: nothing installs at boot, an already-installed statusline shows nothing, and a user-authored statusline is never overwritten.

- **In-app auto-update now works on macOS (Apple Silicon) (#609).** Settings → "Check for updates" did nothing on a Mac: the whole updater was gated to Windows, so the only way to move to a new version was to notice a release, download the DMG, and drag it over the old app. macOS (arm64) now follows the same flow Windows has: wmux polls for a newer release, downloads it, pins its SHA-256 against a manifest published by the release pipeline, and installs it on restart — sessions survive, because the daemon keeps running through the swap. Nothing is installed unless the download's hash matches the manifest exactly; on any mismatch or transport error the update is refused outright and the failure is shown rather than silently retried. A build that isn't code-signed (a locally-made one) can't self-update at all, and now says so with a link to the DMG instead of failing silently. Windows behavior, its release assets, and its manifest are all untouched; Linux and Intel Macs still have no in-app updater and are unaffected.

- **Pair a phone by name, and revoke that one phone.** Pairing used to hand the device the server's own access token, and since that token now survives restarts, every paired device shared one secret — losing a phone meant rotating everybody. You now name a device before pairing it, and it gets a credential of its own. The daemon stores a hash and never the secret, so the roster file is worthless if it leaks or gets mirrored by a cloud-sync engine. Revoking one device cuts its live streams immediately rather than at its next reconnect, leaves every other device alone, and is honest when the write fails: it tells you it could not save the change while still severing the connections, so you know to retry before a restart. An unknown device and a wrong secret give the same answer, so a rejection never tells a guesser which half they got right. `wmux web --new-token` still means what it always meant — it revokes every paired device along with the old token, and refuses the rotation outright rather than reporting a half-done one if the roster cannot be written. Because a long-lived secret must never sit in a URL, a device authenticates with a header and trades it for a short-lived ticket to open a stream — your browser does this on its own, and the desktop's own token path is unchanged. Pairing is refused outright over a plaintext network bind, naming both ways out rather than just saying no. And the page itself is now served under a content security policy locked to the exact hashes of the bundle inlined into it, so a script injected into that page never executes at all.

- **`wmux web --tailscale` sets up phone access in one command.** Reaching a pane from your phone used to mean installing Tailscale, running `tailscale serve`, then restarting `wmux web` with the MagicDNS name so the server would accept it. One flag now does all of it, and `wmux web --stop` tears the serve config back down. It refuses rather than half-works: an existing serve config for that port is explained and never overwritten, a failed setup rolls back only what it created, and pinning `--host` to one non-loopback address is rejected outright — `tailscale serve` proxies to loopback, so that combination would look like it worked and then fail every request.

- **A phone that reconnects no longer re-downloads the whole scrollback.** Every time a browser opened a pane it received the entire ring buffer — 8 MB by default, up to 64 MB, and a third larger again once encoded — which on a phone that reconnects at every tunnel meant pulling that each time. The first paint is now capped to a window, never cutting a character or an escape sequence in half, and says so when there is more history above.

- **Groundwork for phone notifications: a relay that cannot read them.** Delivering an alert to a locked phone means going through Apple, and Apple only accepts pushes signed with a key that can never ship inside your daemon — so those pushes will travel through one small service this project runs. It is written so the promise is checkable rather than claimed: notifications are sealed with a key derived from your device's own pairing secret before they leave your machine, the service forwards an opaque blob it has no way to open, and its logging is typed so a payload cannot reach a log line even by accident. It holds no database and no accounts, and the sealed blob hides which device an alert is even for. Nothing sends yet — this lands the relay, the sealed-message format, and the byte-exact spec the phone app will implement.

- **Answer an agent's question from your phone — even with the desktop closed.** When a Claude Code pane raises an AskUserQuestion prompt, the daemon now records it as a first-class pending request and any paired surface can answer it. `GET /api/approvals` lists what is waiting — including the question text and the option labels, sanitized and capped, so you are never offered a blind button — and `POST /api/approvals/<id>` answers it. Approve selects the highlighted option; deny sends escape; the daemon re-reads the pane first and refuses (`prompt-gone`) rather than typing into a screen that moved on. One pending request per pane (a re-prompt supersedes the old one; the pane finishing or dying expires it), racing answers settle cleanly (the loser learns who won), a daemon restart invalidates everything pending (a recovered pane is a new process — a stale approval must never type into it), and only hook-delivered signals can create a request: screen-scraping heuristics never can, which is the same bar the orchestrator already holds itself to. Deliberate and documented: answering a specific daemon-raised request is allowed on a read-only `wmux web` server, because it is a strictly narrower grant than `--allow-input` — typing stays blocked there, pinned by a paired test on the same server instance. Approval nudges ride the existing replayable `/api/events` channel for clients that watch it — the browser page does not surface them yet, so for now this is the interface the phone app will use rather than a button already sitting in your browser. A successful answer also reports whether it was written down: the keystroke reaches the terminal either way, so the call succeeds, but if the daemon could not save the record it says so (`durable: false`) rather than letting you find out after a restart that the history has no trace of the decision. Agents other than Claude Code get a clean "unsupported" instead of guessed keystrokes. Verified end-to-end by a live-daemon harness with no GUI running, including the real `❯` prompt glyph through ConPTY, under concurrent load.

- **Agent hook signals now survive the GUI being closed — the daemon receives them directly.** The hook bridge every agent CLI calls (Claude Code, Codex, OpenClaude) used to deliver its signals — "the turn ended", "the agent is waiting on you", token stamps — to the desktop app's pipe, so closing the GUI silently killed the authoritative signal path and left only the daemon's screen-scraping heuristics. The bridge now targets the always-on daemon first (reading the daemon's pipe name and token from disk) and falls back to the desktop pipe only when the daemon is unreachable; an old bridge that still calls the desktop keeps working through a one-hop relay. The hook-beats-detector arbitration (the 10-second dedup window and the authority veto) moved into the daemon with the signals, so both sources are now arbitrated in one process, and every emitted event carries the daemon's verdict — downstream consumers can tell an authoritative hook event from a heuristic one. Desktop behavior is preserved by replaying the GUI-side effects (fleet activity line, question-pending clears, the turn's closing message, per-turn accounting) off the daemon's events, with tests pinning that each signal runs its side effects on exactly one path — never zero, never two. A signal fired mid-fallback can never double-deliver: the bridge only tries the next pipe when a request provably never reached a server. `WMUX_HOOKS_TO_MAIN=1` restores the old targeting as an escape hatch. Verified end-to-end by a live-daemon harness (GUI closed): hook authority, dedup ordering, a 100-signal flood with the daemon staying responsive, and a daemon restart mid-stream. This is the foundation for remote surfaces that must act on agent signals while the desktop is closed — `wmux web` today, the planned phone app next.

### Fixed

- **"Check for updates" no longer spins forever on a platform without an in-app updater (#609).** On Linux (and, before this release, on macOS) pressing the button left the Settings row stuck on "Checking for updates…" indefinitely, because the answer came back as a direct reply the panel wasn't reading. It now settles on "Up to date" like it always should have.

- **`wmux web --expose` now says out loud that the connection is unencrypted (#607, partial).** The old warning told you the access token was "the only thing gating it" and to treat the URL as a secret — true, but it skipped the sharper point: over plain HTTP on all interfaces, anyone who can sniff the network (open Wi‑Fi, ARP spoofing, a compromised switch) can read the token *and* the full scrollback off the wire, no URL required. The exposed-bind report now states exactly that and points at `tailscale serve` for an HTTPS front. Wording only — native TLS stays tracked in #607.

## [3.34.0] — 2026-07-25

### Added

- **Choose your browser backend: built-in panes, or your real browser (#517).** A new Settings → Terminal option, "Browser backend", decides where browser opens land. The default (`Built-in`) keeps today's behavior exactly: an embedded browser pane opens inside wmux and the full automation toolset works on it. Switching to `External` routes every open — an agent's `browser_open` / `browser_navigate`, **and** your own clicks (the pane's browser button, the command palette, the keyboard shortcut, a workspace's port badge, a link clicked inside a terminal) — to your OS default browser instead. wmux spawns **no embedded Chromium at all**, so a workspace that opens pages costs wmux zero browser memory, whether the page was opened by an agent or by you. External mode is deliberately fire-and-forget: wmux gets no handle on the opened tab, so tabs aren't tracked, listed, or closable from wmux, and deep-automation tools (click, screenshot, extract, …) fail with a clear "backend is external" error instead of a confusing target-miss — agents are told exactly why and what to use instead. Opens land in your real, signed-in browser, from any workspace — that reach is the point, and the Settings copy says it plainly. The choice is read by the main process at boot (no startup race: the very first open after launch already honors it) and applies immediately when changed.

### Fixed

- **`wmux web` notifications now show the message instead of the word "Notification" (#597).** When a pane emitted a desktop notification, the banner in the phone browser read the literal string "Notification" and the actual text — "Build finished, 3 tests failed" — was dropped on the floor: the page was reading a field name the daemon never sends. The banner now renders what the pane actually said, for every notification flavor (OSC 9, which carries only a body; OSC 777 and OSC 99, which carry a title and a body), and the parsed notification travels to the browser whole — source, title, body and timestamp — so nothing is lost between the pane and your phone.

- **`wmux web` no longer loses attention events when the connection drops, or while nothing is watching (#598).** Approval requests and pane notifications were fired at whoever happened to be connected at that instant and then forgotten: lock your phone, walk through a dead spot, or simply have no browser open, and the alert was gone for good — the pane sat waiting on an answer you were never shown. The daemon now keeps a short rolling record of fleet attention events (the last 100, up to 30 minutes) and serves it on a dedicated stream that survives reconnects: your phone resumes exactly where it stopped, and events raised while you had nothing open are delivered the moment you reconnect. Reloading the page picks up from the same place. When the record can't be lined up with what you already saw — a fresh device, or a daemon restart — you get one "N events while you were away" summary and the affected panes light up in the fleet strip, instead of a stack of banners for alerts you may already have dealt with. Duplicates are suppressed, so nothing is shown twice.

- **`wmux web` now survives a daemon restart, so phone access no longer dies while you are away from the desktop (#596).** Your sessions already survived a crash, a reboot, or the one-click update flow; the server that serves them to your phone did not. Nothing recorded that you had turned it on, so the port simply stopped answering, the phone showed nothing but "reconnecting…", and the only fix was to walk back to the desktop and run `wmux web` again — in exactly the situation phone access exists for. wmux now remembers an explicit `wmux web` (the bind address, `--allow-input`, `--allow-host`, the port) and brings the server back with the daemon, with the **same access token**, so a browser you left open reconnects on its own with nobody at the keyboard. Carrying the token also fixes the smaller version of this: re-running `wmux web` to add `--allow-host` for a `tailscale serve` front no longer locks out a phone that already paired. Turning it off is remembered too — `wmux web --stop` keeps it off across restarts *and* revokes the token, and a new `wmux web --new-token` rotates the token on demand when you want to revoke every paired device without stopping the server. Nothing changes if you have never run `wmux web`: the daemon still listens on nothing until you ask, a restore is logged (loudly, when it puts a network-exposed writable terminal back), and a corrupt state file falls back to "off" rather than blocking daemon boot. On the phone, a rejected token is now told apart from a server that is merely restarting — `EventSource` reports both as the same silent retry — so an expired session lands on the pairing screen instead of spinning on "reconnecting…" forever.

- **Relaunching wmux while the daemon is still restoring your sessions no longer kills it mid-restore (#546).** When wmux starts, it looks for a daemon that is already running and reuses it. A daemon that is busy restoring a large session set can't answer that check yet — it writes its PID the moment it starts, but only opens its control channel once every session is back, which takes ~19-23 seconds for 30-35 sessions. The launcher waited 1.9 seconds for an answer, decided the daemon was wedged, and killed it. The replacement then started the same slow restore from the top, and could thrash through the respawn budget until wmux gave up and fell back to local mode, where every pane creates its own session — the duplicate-sessions symptom from #537. The daemon now leaves a "still booting" marker for exactly the span where it cannot answer, and the launcher waits it out (up to the same 90-second ceiling the spawn path already used) instead of killing a daemon that is provably making progress. The marker is trusted on the PID it names being alive, deliberately not on a freshness timestamp: recovery is one long chain of awaits, so a busy moment could delay a heartbeat and re-create the exact bug. A daemon that crashes mid-restore leaves a marker naming a dead PID, which is ignored, and a genuinely hung boot still gets killed at the ceiling. The ordinary case — a daemon that really is wedged — is untouched and pays no extra wait, because the marker isn't there at all.

- **A clean daemon handoff no longer dead-ends on machines where anti-virus slows down process checks (#545).** When wmux replaces an outdated daemon, it asks it to shut down, then confirms it's gone before starting a fresh one. That confirmation ran entirely through `tasklist`, which — by design, to prevent two daemons ever running at once — reports "unknown" rather than "dead" whenever the check itself fails or times out. On a machine where those checks are slow or blocked, "unknown" is the only answer that ever comes back, so a daemon that shut down cleanly milliseconds earlier was polled for the full 5 seconds, failed the follow-up verification for the same reason, and the whole handoff dead-ended. wmux now also accepts a second, independent proof: the daemon's control channel no longer accepting connections, which only happens after it has saved your sessions, released its lock and closed its terminals. A process that is *positively* seen running is still never treated as finished, and without a shutdown acknowledgement the new signal is ignored entirely, so nothing here can start a second daemon next to a live one. Measuring the original report along the way: the daemon leaves the process table 7-12 ms after acknowledging shutdown across 10 and 35 live terminals, so the reported multi-second linger did not reproduce; a timestamp is now logged immediately before exit so a recurrence in the field arrives with the evidence this needed.

- **Dragging your mouse across a terminal during a workspace switch no longer throws a recurring uncaught error.** Selecting text in a terminal registers document-level mouse listeners (so a drag that leaves the terminal can still be released), and on a remount — a workspace switch, a reconnect — `Terminal.dispose()` nullified xterm's internal render service before those listeners came down. A `mouseup` landing in that gap read `dimensions` off a half-torn-down instance and threw `TypeError: Cannot read properties of undefined (reading 'dimensions')`, dozens of times per session. wmux now tracks whether a drag is active on any terminal and defers only the internal `dispose()` until the mouse is released, closing the race without patching xterm internals; all PTY listeners are already torn down at that point, so no new data arrives while disposal waits. A drag that outlives a window switch (Alt+Tab mid-selection) stays guarded, a drag released outside the window is replayed to the terminal as the release it never saw (so the terminal tears its own listeners down instead of being left half-armed), and a button that never reports release is force-disposed after 30 seconds with a console warning so the rare fallback is traceable rather than silent. The redundant back-to-back reconciliation runs visible on load are now numbered in the console — so "one cycle walking four workspaces" is distinguishable from "four cycles" — and the dev-only Electron "Insecure Content-Security-Policy" warning is suppressed in development (Vite's HMR requires `unsafe-eval`; the production CSP remains strict with no `unsafe-eval`).

- **The orchestrator no longer re-reviews a finished pane on every heartbeat.** When a hook-bridged agent (Claude Code, OpenCode, …) ends a turn, its pane is marked `complete` and stays that way until genuinely new activity clears it. The level-review heartbeat scans `complete` on purpose — that is how it recovers a dropped "turn ended" signal — but on an armed (autonomy ≠ off) workspace it was re-surfacing the *same* idle-and-finished pane to the brain every interval (~3 min), spending ambient tokens re-judging a completion the orchestrator already saw. The heartbeat now surfaces a finished pane **once** — so a genuinely dropped stop is still caught — then retires it until the pane shows new activity, at which point its next completion surfaces fresh. A pane that is actually *blocked* (`awaiting_input` / `waiting` / `error`) still re-surfaces every heartbeat as before; only the informational `complete` state is retired. A pane the brain never actually reviewed stays armed and is re-read on the next heartbeat — whether the wake was refused because that workspace's brain was mid-turn or because the fleet was already running its maximum number of concurrent turns — so nothing is dropped in the wedge case. (#561)

- **The performance trend that tells a real regression from CI noise is being recorded again.** Every push to `main` is meant to append one line of benchmark numbers to a trend file, and since 2026-06-12 not one of them landed: `main` became a protected branch, the CI bot's append commit was rejected on every push, and because a lost trend line is deliberately non-fatal the rejection showed up only as a warning on an otherwise-green run — six weeks of data gone with no red mark anywhere. Two smaller faults compounded it. The publish step was skipped whenever the gate failed, so the outlier runs a noise investigation actually needs were exactly the ones never recorded. And the trend fields were a hand-copied second list of the gated metrics, so the four `hiddenFlood` gates — the noisiest family, and the one currently producing false reds — had no trend field from the day they shipped. The trend now lives on the `bench-history` branch, which the bot can actually write to; it records red runs too; a failed publish raises an error annotation and a job-summary caution instead of a warning nobody reads, and the line rides along in the run's artifacts so it can still be recovered by hand; and the trend fields are now derived from the gate tables themselves, so a gate can no longer be added without one. Lines recorded before 2026-06-12 remain readable in git history; the six-week gap itself is unrecoverable. (#602)

## [3.33.0] — 2026-07-24

### Added

- **`wmux web` — reach your terminal panes from a phone browser (read-only, local-only by default).** A new command starts a small web server, hosted inside the daemon, that serves your live panes to a browser: run `wmux web --expose`, open the printed `http://<tailnet-ip>:7681/?token=…` link on your phone (same Tailscale tailnet or LAN), pick a pane, and watch its output stream in real time. It reuses the daemon's own PTY data (initial screen from the same ring-buffer flush the desktop uses, then a live tee of terminal output), so it never fights the desktop GUI for a pane and it keeps working even after you close the desktop app — the agents are still supervised by the daemon. Safe by default on two axes: it is **read-only** (the browser can watch but cannot type — pass `--allow-input` to opt in) and it **binds loopback only** (`127.0.0.1` — pass `--expose` to bind all interfaces, or front it with `tailscale serve` for HTTPS). Even read-only, a viewer sees the selected pane's *full scrollback*, so don't serve panes showing secrets. Access is gated by a fresh random token minted on each start (the daemon's own control token never touches the network; API calls authenticate with a `Bearer` header rather than a query string, except the SSE output stream, which must carry the token as a query parameter because `EventSource` cannot set headers), and nothing listens until you run the command. The page is installable: iOS "Add to Home Screen" works over plain HTTP, and full PWA install (Android) plus offline app-shell caching work behind HTTPS. Options: `--port` (default 7681), `--expose`, `--host <addr>`, `--allow-input`, `--status`, `--stop`.

- **`wmux web` is now usable from a phone, not just viewable — and it starts from the titlebar.** The browser surface gained the things a touch device actually needs. A **key bar** puts the keys a phone keyboard cannot produce one tap away (Esc, Tab, Ctrl, Alt, arrows, `|` `/` `~` `-` `_`, Home/End/PgUp/PgDn); tap a modifier to arm it for the next key, double-tap to lock it. A second row carries the keystrokes you actually need when an agent is waiting on you — Shift+Tab, Ctrl+C, `yes`, `continue`, `/compact`, `/clear`, `/resume`. **Text size** is adjustable, with two view modes: fit-the-whole-width for a glance, or 1:1 with sideways scroll when you need to read (previously the pane was always squeezed to the viewport, which on a phone meant unreadable). **Notifications** arrive in the page: when a pane asks for approval of a sensitive action, or emits a desktop notification, a banner appears — even while you are watching a *different* pane — and tapping it jumps there. A **fleet strip** shows every pane's status at a glance, with an attention dot on panes that called for you. Pairing no longer means typing a 36-character token on a phone keyboard: the server prints a **6-character code** (`/pair`, valid 10 minutes, single use, 5 attempts) that the phone exchanges for the token. And the whole thing can be started without a terminal — a quiet **`web` control in the titlebar** opens a popover with Allow-input / Expose-to-network opt-ins, the scrollback warning, and one Start button; while running it shows the bind address, viewer count, a copyable URL, and the pairing code in large type. Read-only remains the default and is enforced server-side at the `pty.write` boundary, so a read-only server refuses input even if the page is tampered with.

- **A "welcome home" briefing when you open a workspace.** The Command Deck now greets you at the top of the orchestrator thread with a one-shot, deterministic summary of what the judgment engine already knows: what changed while you were away ("2 finished, 1 now blocked on you"), what is blocked on your decision, how the fleet stands right now ("1 needs you, 2 running"), and — the "look at this first" answer — the single pane most worth your attention, named and one click from its terminal. It deliberately doesn't repeat the Fleet roster sitting directly above it. It is a pure read of existing state: no brain turn is spent, nothing is throttled, and it stays current in every autonomy mode including `off`, where no orchestrator turn ever runs. It stays a quiet one-line affordance and only auto-expands when there is something worth surfacing (a cold start, a newly-raised decision, or a pane that just became blocked — including one that spawns straight into a permission prompt, and one that recovers and blocks again), so it never nags on an ordinary workspace switch — and once you have expanded or collapsed it by hand it stays that way, re-opening itself only when something genuinely new becomes actionable, never on the routine refreshes that fire while your agents work. The "while you were away" summary is cleared only once you have genuinely seen it — expanded, scrolled into view, in a window you are actually looking at — so a delta that lands while you are on another tab, scrolled down the thread, or away from the machine is still waiting when you come back. Only live agent panes count: a workspace holding nothing but an empty split, a browser tab or an editor has nothing to report and the card doesn't render at all. Toggle it (and its auto-expand) in Settings → Orchestrator; the toggle takes effect immediately on an already-open deck.

- **Pin an agent and model to each pane role, and wmux enforces it on the launches it assembles.** A pane role (Builder / Reviewer / Tester / Planner) used to be a soft routing hint the orchestrator could read but nothing acted on. You can now bind each role to an agent + model in Settings › Orchestrator — e.g. Reviewer → `codex` with a cheap model — and the agent launches wmux itself puts together for a pane carrying that role are transparently rewritten to use the bound model. That covers three points: launches the orchestrator issues (`terminal_send("claude")` becomes `claude --model haiku`), the seeded launch command of a project pane, and the per-pane resume command (so a bound model survives a reboot instead of silently dropping). A launcher you type into the terminal yourself is **not** rewritten — your keystrokes go straight to the shell, and the Settings copy says so. The rewrite is loud and reversible: you see the real command in the pane, a muted `agent · model` chip in the Fleet roster, and a model badge on the pane — and those two only appear when the binding really is being applied, never for one that is configured but inert. It never fights an explicit `--model` you put on the line (a manual override wins for that one launch; the binding re-asserts on the next respawn), and it only ever fires on something that is recognizably an agent invocation — a shell command, or an instruction sent to an already-running agent, comes through untouched even when its first word happens to be `claude`. A model is only injected when the role also names the agent it belongs to, since `--model` grammar is per-agent; Settings flags a row that can't do what it looks like it does. Roles are unbound by default, and agents whose model-flag grammar isn't verified (only `claude` and `codex` are today) get an advisory note rather than a guessed flag. Per-role budgets and token metering are not part of this change.

- **A `wmux.json` pane can declare its role**, so a project layout's panes launch under the binding you meant them to. Applying a layout rebuilds the pane tree from scratch, which means a pane created by it has no role to inherit — a `"role": "Reviewer"` on a layout leaf is how it gets one. The role is assigned for real (it shows in the Fleet dropdown, persists, and the orchestrator sees it), and the leaf's `command` launches under that role's binding, including a supervised (`restart`) leaf's command. Only the four built-in role names are accepted, and anything else rejects the layout rather than quietly producing a pane that looks assigned and enforces nothing. The approval screen lists a declared role next to the command it belongs to, since a bound role means the line you approve is not quite the line that runs.

  Assigning a role is the operator's, and only the operator's. Now that a role selects which agent and model a pane runs, letting agents set it would hand policy selection to the very agents the policy governs — an agent could rename its own role to something unbound and fall back to the expensive default, point your binding at a pane you didn't intend, or change a sibling pane's role so that pane launches differently. Agents can no longer assign, reassign, or erase a pane's role over the API: the key is dropped from their metadata writes (the rest of the write still applies, and the reply tells them what was refused), preserved through a wholesale replace or clear, and the refusal is logged. The Fleet dropdown is unaffected — it never used that API.

### Changed

- **When the shared MCP broker can't serve, agents fall back to the full MCP bundle instead of a dead shim.** With the broker enabled, wmux points each agent CLI at a thin shim that connects to a single resident broker process. If that broker never comes up — a missing script, a crash loop, a permissions failure — the old behavior left every agent on a shim that gives up after a few seconds and takes all wmux tools (browser, terminal, a2a, channels) down with it. Registration now waits briefly for the broker to accept a connection and, if it doesn't, registers the self-contained bundle so tools keep working. The wait is bounded and never blocks startup beyond its timeout, and this only changes behavior when the broker is enabled — the default configuration is untouched. Re-registering from the Settings screen or during first-run onboarding makes the same live check, so clicking "re-register" while the broker is down writes the working bundle rather than re-installing a shim that can't connect.

- **A stood-down broker supervisor now reclaims an orphaned pipe.** When a second wmux instance finds the broker pipe already owned (a dev hot-reload, two app windows), it stands down instead of fighting for it. Previously it stood down permanently — so if the owning broker later exited, nothing took over the pipe and every agent was stranded on a shim that couldn't connect. The supervisor now periodically checks the pipe and, once the other broker is gone, restarts its own to take over.

- **`wmux mcp register` keeps the broker topology when the broker is running.** The CLI used to always rewrite agent configs to the full MCP bundle, so running it while the broker was enabled silently reverted every agent off the shared broker — the exact command the app's own troubleshooting messages tell you to run. It now probes the broker directly and keeps the shim wiring when the broker is reachable, falling back to the full bundle otherwise; setting `WMUX_MCP_BROKER=0` still forces the full bundle as an escape hatch.
- **"Check for updates" now updates you — in one click.** Pressing the button in Settings › Updates used to only *check*: if an update was found it downloaded quietly and you had to come back and press a second "Restart to install" button. A manual check is really an "update now" intent, so it now runs the whole thing through — check, download, SHA-256 verify, and restart into the installer — from a single press. If you're already on the latest version nothing happens beyond the "Up to date" note, and if the download can't be verified the app stays open instead of quitting with nothing to install. The background 30-minute auto-check is deliberately unchanged: it still only downloads in the background and surfaces the "Restart to install" button, so wmux never restarts itself while you're working without you having asked for it. Your sessions survive the restart either way — they persist in the daemon and come back.

- **The statusline's model label is now just the model and its effort — `Opus 4.8 (xhigh)`.** The context-window size is no longer rendered. It was meant to surface as a `1M` note on `[1m]` sessions, but it never actually appeared: wmux read it from a `" (1M context)"` suffix Claude Code used to bake into `model.display_name`, and ≥2.1.218 sends the clean name and reports the window under `context_window` instead. Rather than resurrect the note, it is dropped on purpose — the window size is a property of the account's model selection that rarely differs pane to pane, while the live fill (`ctx N%`) right next to it is the part that actually moves. The legacy suffix is still stripped, so older Claude Code renders the same label instead of a stray `Opus 4.7 (1M context) (high)`. The label rendering, which had no tests at all, is now covered by cases that feed the script the exact JSON Claude Code pipes on stdin.

### Fixed

- **wmux's MCP server no longer goes missing from your agents after an app update.** wmux registers itself as an MCP server in each agent's config (`~/.claude.json`, Codex's `config.toml`) by writing the path to its bundled server script — and that path used to point straight into the versioned install directory (`…\app-3.31.0\resources\mcp-bundle\index.js` on Windows). So the moment Squirrel cleaned up the old `app-*` after an update — or, while dogfooding, a build's `out/` or a git worktree was removed — the registered path pointed at a file that no longer existed, and any agent reading that config could no longer launch the wmux MCP server: every `wmux` tool silently vanished until the app booted again and re-registered. wmux now copies its MCP bundle to a stable, version-free location under `~/.wmux/mcp/` and registers THAT path, the same cross-update durability the Codex `notify` bridge and the hook/statusline scripts already have. The whole bundle directory travels together (the server resolves its siblings relative to itself), the copy refreshes on boot gated on the app version so a warm start pays nothing, it repairs itself if the stable file is later deleted, and it fails open to the old versioned path when the copy can't be written — so registration is never worse than before. Your own MCP servers in those configs are left untouched.

- **A new pane now sees PATH changes you made after wmux started (Windows).** The environment every pane inherits is built from wmux's own `process.env` — a snapshot frozen when wmux launched. So if you installed a tool (Node, Python, a CLI) that appended itself to your PATH and then opened a new pane WITHOUT restarting wmux, the pane still ran with the old PATH and couldn't find it — unlike a freshly opened terminal, which composes PATH from the registry for every new shell. wmux launched at login and left running in the tray made this worse: its PATH could be days stale. Now, when it assembles the environment for a new pane on Windows, wmux re-reads the current machine+user PATH from the registry (via `reg.exe`, so it also works under the ConstrainedLanguage lockdown) and leads with it, while keeping any extra entries the process itself added. The read is cached for a few seconds so a burst of pane creations (session recovery) doesn't repeat it; it never drops a working path (a now-removed entry just lingers harmlessly at the end); and it falls back to the old behavior on any read failure or when `WMUX_NO_PATH_REFRESH=1` is set. This covers new panes in both local and daemon mode. Sessions restored after a reboot still replay their original create-time PATH for now — that path is a separate follow-up.

- **The `~/.wmux/hooks/` scripts now update when wmux does — both the statusline and the hook bridge.** `wmux-statusline.mjs` and `wmux-bridge.mjs` are copied to `~/.wmux/hooks/` precisely so they survive Squirrel's `app-x.y.z` swap — which also meant an app update never refreshed them: a change sat in the bundle while the stale copy kept its old behavior until the user happened to re-run `wmux setup-statusline` / `wmux setup-hooks` by hand. This bit the bridge harder than the statusline — the "30+ concurrent sessions" scaling fix (bridge-log rotation + a per-session activity-stamp throttle that tames hook storms) shipped in an app update but never reached an already-installed bridge, so on those machines the bridge log grew without bound and the throttle simply wasn't there. The app now reconciles both copies against the bundled versions shortly after boot — and reconcile means repair, not just refresh: an entry that still references a script whose file was deleted (a manual cleanup, a partial reinstall) is rewritten rather than left pointing at nothing. Neither can enroll anyone: each does nothing unless a wmux-owned entry (a `statusLine`, or hook groups referencing the bridge) is already installed, neither ever writes `settings.json`, and the bridge refresh deliberately touches only the plugin-LESS copy — the marketplace plugin's own versioned bridge under `~/.claude/plugins/cache/…` is left to Claude Code's plugin system. The "never auto-run at boot" rule is about opting a user in, not about leaving a file they already opted into broken or stale. Both writes are pid-scoped tmp+rename, so a statusline tick or a hook firing mid-update can never read a half-written script and two instances racing at boot can't collide.

- **The Perf CI gate no longer fails PRs over memory that isn't ours.** The RAM benchmark sums working set across the app's process tree, and it walked that tree by trusting every `ParentProcessId` link. Windows never clears a dead process's parent pid, so once the OS recycles that pid onto one of our processes, an unrelated orphan — and its entire subtree — starts looking like a wmux descendant. That is what tripped the gate on a tests-only PR: the run collected 157 processes instead of the usual ~25, and the extra 136 contributed 3.7 GB while wmux's own attribution buckets were indistinguishable from a passing run. The walk now enforces the one invariant a real spawn always satisfies — a child is created no earlier than its parent — and drops any edge that violates it along with the subtree behind it. On a live desktop snapshot this removed a phantom link that would otherwise have pulled 248 processes and 9.5 GB into the total, while leaving genuine multi-process Chromium trees byte-identical. The daemon pid, which enters the walk as a second root from a pid file, is now identity-checked against the snapshot for the same reason, and each RAM sample records what it rejected plus the heaviest unclassified processes, so a future anomaly is diagnosable straight from the run artifact instead of by re-deriving it. (#570)

- **Installing wmux can no longer wipe your entire user PATH.** On a machine where PowerShell runs in ConstrainedLanguage — how AppLocker/WDAC lock down enterprise Windows — the CLI shim's PATH edit could replace all of `HKCU\Environment\Path` with a single entry, the wmux `bin` directory. Every other entry was destroyed and unrecoverable: npm-global CLIs (`%APPDATA%\npm`), toolchains, everything user-scoped. The cause was an asymmetry rather than an overwrite: the script *read* the registry with a .NET method call (blocked in ConstrainedLanguage) but *wrote* it back with a cmdlet (not blocked), and with no `$ErrorActionPreference = 'Stop'` it sailed past both read errors, resolved the current PATH to empty, and persisted the bin directory as the whole thing. The edit is now fail-closed and, more importantly, actually works under ConstrainedLanguage: the raw value is read via `reg.exe`, which is immune to language mode and — unlike `Get-ItemProperty` — does not expand `%VAR%` entries and bake them in. If every read strategy fails the registry is left untouched, a structural invariant aborts any edit that would drop an entry other than the bin directory, the pre-edit value is backed up to `HKCU:\Software\wmux\UserPathBackup`, and the cosmetic `WM_SETTINGCHANGE` broadcast can no longer report a successful write as a failure. The source-build `install.ps1` path was verified unaffected. (#573)

- **`browser_tabs` can no longer enumerate, select, or close another workspace's browser.** The tool used to flatten every Playwright page in the Electron CDP connection — including the app shell, DevTools, and guests from other workspaces — then address them by a mutable numeric index. It now inventories logical wmux browser surfaces only inside the calling session's strictly resolved workspace, so discarded surfaces remain visible while shell/DevTools targets are excluded by construction. `select` and `close` re-check ownership at the renderer mutation boundary; `new` creates a real, non-yanking surface in that same workspace. Because browser tools are experimental, the unsafe numeric `tabId` input is removed in favor of the stable opaque `surfaceId` returned by `list` and `new`. (#565)

- **`browser_close` can no longer close another workspace's browser by surface id.** Closing by an explicit `surfaceId` searched every workspace, so a caller in workspace A could tear down workspace B's browser if it learned B's id (composing with the cross-workspace target ids `browser.cdp.info` still exposes — [#580](https://github.com/openwong2kim/wmux/issues/580)). An explicit `surfaceId` is now scoped to the caller's own workspace and fails closed when caller identity is absent, rather than falling back to whichever workspace is on screen — matching the boundary `browser_tabs` already enforces. The surface-id-less "close the browser pane" convenience is unchanged. This closes the destructive half of #580; scoping the `browser.cdp.info` disclosure itself is tracked separately. (#580)

- **`browser.cdp.info` no longer volunteers other workspaces' live browser targets.** The internal RPC that the browser automation engine uses to locate a guest returned every registered CDP target — with its surface id and owning workspace — to any `browser.read` caller, which is how a foreign surface id could be discovered in the first place. It now filters that list to the caller's own workspace server-side (the port and app-shell URL, which are workspace-agnostic, are unchanged). This is defense-in-depth within the same single-OS-user trust boundary, not a hard seal: anything holding the shared CDP port can still enumerate targets directly, so sealing that off is left as a larger change. Closes the disclosure half of #580. (#580)

## [3.32.0] — 2026-07-24

### Added

- **Per-pane agent memory, live in Fleet View.** Each pane's card now shows the resident memory of the agent process running in it (the CLI plus any child it spawned), attributed from the process tree and refreshed on the existing Fleet-View liveness batch — no extra polling while the panel is closed. Makes it obvious at a glance which session is the heavy one when the machine gets tight.

- **Groundwork for installing the per-account usage statusline from within the app.** The statusline setup logic (`wmux setup-statusline`) is now exposed to the renderer through IPC handlers (`statusline:bridge:status` / `statusline:bridge:install`), mirroring the hooks bridge pattern, so an upcoming Settings UI can let an app-only user (winget/Setup.exe) who never opens a terminal discover and enable it. No user-facing UI ships yet with this change. Same explicit user-click constraint as hooks: never auto-run at boot. (#555)

- **The orchestrator now resolves questions it already knows the answer to, instead of freezing on them.** In `auto` mode the Command Deck brain previously escalated *every* fork to a human decision and halted its loop — even when an operator rule it had already quoted answered the question (the real incident: it recommended the correct option, cited the rule, and still froze for a day). Three changes restore actual judgment. First, the brain's turn context now states its **decision authority per mode**: an `auto` workspace is explicitly told to resolve forks from standing rules and escalate only genuine residuals, while `assist` stays report-and-recommend and `off` gets no ambient instructions at all — previously all three modes received byte-identical guidance. Second, a new operator-editable **`deck-policy.md`** (seeded on first run in the wmux data dir) carries *binding* standing rules the brain may act on directly — unlike orchestrator memory, which deliberately remains non-executable background context; policy rules still can't grant tools or override safety, and risky/irreversible actions still require a human. Third, the escalation prompt itself now demands a **resolve-first check** (policy → conventions → memory) before raising a decision, and when the operator's answer corrects the brain's judgment, it persists that correction to memory so the same class of question isn't raised again.

- **A decision left unanswered no longer blocks the orchestrator forever.** A brain-raised decision used to freeze the workspace's autonomous loop indefinitely until a human clicked resolve. Pending decisions now have a TTL (default 30 minutes, configurable): once it elapses, the next heartbeat wakes the brain for a *re-examine* turn — re-state the question with better context, or, **in `auto` mode only**, resolve it itself via the new `deck_resolve_decision` tool by citing the standing rule that settles it, then proceed. The self-resolve path is server-enforced (auto mode + TTL actually elapsed + a substance floor on the resolution text — all three checked in the daemon-side RPC, not just the tool description; the *citing* of the rule is demanded by the prompt, while the server guarantees the resolution isn't a bare token), re-examines are debounced to once per TTL window, a decision whose timestamp was lost can never be self-resolved (human-only), the brain may replace its own *stale* question with a sharper one (a fresh pending decision still refuses a second raise), and ordinary wakes remain blocked while a decision is pending, exactly as before.

- **The orchestrator now runs a periodic level review, and caps how many brain turns run at once.** Two additions harden autonomous (Command Deck) orchestration. A *level-review heartbeat* re-reads each armed workspace's current per-pane state every few minutes and, if a pane needs attention that no live event ever surfaced (a dropped hook, an event lost during a busy stretch), wakes the brain to catch it — routed through the exact same mode/decision/budget/rate gates as an ordinary event wake, so it can never wake *more* than the live path would, only recover what it missed. Separately, a *global concurrency cap* limits the whole app to two autonomous turns in flight at once across all workspaces: a burst of activity spread over a fleet no longer spins up a pile of brain subprocesses simultaneously — the extra turns are deferred and retried, exactly like a workspace that's already mid-turn. Neither affects a turn you type yourself, which is never throttled.

- **The usage statusline now shows the model's reasoning effort.** The model label reads `Opus 4.8 (high)` instead of just `Opus 4.8`, so the effort level a pane is actually running at is visible without opening `/model`. Like the usage percentages, it costs nothing: Claude Code already pipes `effort.level` on the statusline's stdin, and it is simply omitted on models that don't expose one. The same parenthetical also absorbs the verbose `" (1M context)"` that Claude Code bakes into the display name of `[1m]` model variants — `Opus 4.7 (1M context) (high)` would have been two parentheticals and 20 extra columns, so it renders as `Opus 4.7 (1M, high)`.

### Changed

- **Hidden workspaces stop holding terminal memory.** A workspace you haven't looked at in a while (5 minutes) now has its terminals unmounted to reclaim renderer RAM, so memory no longer grows with the number of workspaces you keep open — only with the ones you're actually using. The daemon keeps every session running untouched; revealing a parked workspace remounts it and replays its screen from the daemon (fast, via the new attach snapshot below), and cross-pane search and agent screen-reads still reach parked panes by reading their content from the daemon, so nothing is silently skipped. On by default; a Settings toggle turns it off for anyone who prefers every workspace to reveal instantly.
- **Large sessions reveal instantly instead of freezing.** Revealing a pane with a big scrollback used to ship its whole raw history (up to 8 MB of terminal bytes) for the renderer to re-parse in one synchronous burst — the multi-second freeze on long-running agent panes. The daemon now parses that history once on its own side and sends back the compact final screen state instead, so a flooded pane paints in a fraction of the time; full-screen TUIs and anything the snapshot can't reproduce faithfully fall back to the exact old behavior. The parse is chunked so it never stalls output on other panes.
- **Lighter idle footprint and smoother streaming.** Several always-on costs were trimmed: four rarely-open overlays (Settings, command palette, and two others) now load only when first opened rather than at startup; the unread-notification indicator updates in constant time regardless of how many panes and notifications exist; streaming output repaints at a calmer cadence; and hidden panes release their GPU rendering contexts sooner. Under the hood, the optional shared-MCP-broker path (still off by default) no longer pays a per-connection memory cost.

- **Ambient auto-wakes are now rate-limited, and the orchestrator serves fleet state locally.** Under heavy fleet activity the orchestrator's view of the workspace tree used to require a round-trip to the renderer that a storm of hook signals could starve — main now keeps a local mirror of the last renderer-pushed snapshot and reads it directly on the hot path, so hook and terminal responsiveness no longer degrade as the fleet gets busy. On top of that, each workspace's ambient auto-wakes are capped to a sliding-window rate, so a runaway hook or detector loop can't turn the brain into a busy-loop (a running loop still iterates on its own budget). Edge wakes can now also carry a one-line fleet summary so the brain sees the wider picture without a poll.

- **Install instructions now lead with the package manager.** The README's Windows install section puts `winget install openwong2kim.wmux` front and center with a clear note that it avoids the SmartScreen warning — the direct Setup.exe download is demoted to a secondary "offline install" path with an explicit note about why the warning appears (the installer isn't Authenticode-signed yet).

### Fixed

- **The daemon reaper no longer keeps sessions with a corrupted timestamp forever.** A session record whose `lastActivity` had become malformed made its idle-time calculation `NaN`, so every TTL comparison silently failed and the record was kept indefinitely — quietly defeating the idle-session reaper for that record. Such a record now has its `lastActivity` restamped to the current time on load, so its TTL clock restarts and it can age out normally, without risking a still-live session on a single bad timestamp. (#557)

- **Browser read tools can no longer return another workspace's page.** With two workspaces each holding a live browser surface, an agent's read-side tools (`browser_snapshot`, `browser_evaluate`, `browser_extract_text` / `_data`, `browser_wait`) could return the *other* workspace's page: an agent in workspace A calling `browser_snapshot` might get workspace B's URL and content. The write path (`browser_open` / `browser_navigate`) already routed by the caller's resolved workspace, but the read path did not — when a tool was called without an explicit `surfaceId` (the common case) the page-selection heuristic just grabbed the first non-shell page globally, blind to which workspace it belonged to. Browser surfaces are now tagged with their owning workspace at CDP registration time, and read-tool page selection resolves the calling session's own workspace and scopes to its surface — never falling back to a different workspace's page (it opens the caller's own surface instead when theirs is absent). Setups with a single browser, and callers that pass an explicit `surfaceId`, are unaffected. (#554)

- **TUI agents no longer show "running" forever after finishing a turn.** A long-lived agent TUI (OpenCode, and any hook-bridged terminal agent) is a foreground command the entire time it is open, so wmux's byte-activity heuristic never sees it fall silent between turns — the pane stayed pinned to "running" indefinitely. That misled the fleet badge, told the orchestrator (via `pane_list`) the pane was still working long after it stopped, and hid the finished pane from the heartbeat level review (which only scans panes needing attention). The agent's own Stop hook already fires when a turn ends; wmux now uses it to mark the pane "complete" for fleet display, `pane_list`, and the level review while the hook bridge is live — a genuinely new turn (fresh output or an awaiting-input prompt) clears it back to running. The per-pane "Resume" chip is unaffected: its "is it safe to type here" gate still treats a live TUI as busy.

- **The `wmux` CLI launcher no longer hardcodes a version-specific path.** The `wmux.cmd` shim in `<install>/bin/` used to embed an absolute path like `app-3.31.0\wmux.exe`. Squirrel's `--squirrel-updated` handler regenerates the shim on every update, but if that handler fails to fire (crash, timeout, manual copy), the hardcoded path would silently break CLI access after the next update. The shim now dynamically discovers the latest `app-*` directory relative to its own location at runtime (`dir /b /ad /o-d`), so it always resolves to the current version regardless of whether the Squirrel event ran. (#556)

- **OpenClaude panes no longer flood the notification center with "Ready for input".** The agent detector's waiting-for-input patterns for OpenClaude were too loose: `bypass permissions on` matched the TUI's status bar, which re-renders roughly every 16 ms, so the pane was re-declared "awaiting input" continuously and every re-declaration fired a notification. Debug capture of the real TUI showed the actual prompt reduces to a bare `>` (or `> ○` while spinning) after ANSI stripping and trimming, so detection now keys off that prompt marker alone. Only OpenClaude's patterns changed; other agents are untouched. ([#539](https://github.com/openwong2kim/wmux/pull/539), thanks [@rayss868](https://github.com/rayss868))

- **Detached terminal sessions are no longer leaked forever and re-spawned on every daemon restart.** A pane you close (or a client that disconnects) leaves its shell running in a `detached` state — alive, but with no client watching. These were never garbage-collected: the reaper gave `dead` and `suspended` sessions a TTL but let `detached` live indefinitely, and because the 30 s snapshot writes them to `sessions.json` verbatim, a daemon crash or forced kill left the records on disk. Every restart then re-spawned a fresh shell for each one and reset its activity clock, so the orphans could never age out — only `maxSessions` (200) would eventually block *new* terminals instead of reaping old ones. On a long-running machine this accumulated dozens of orphaned shells (one report: 40 `powershell.exe` processes holding ~3.3 GB). Idle detached sessions now honor a `session.detachedTtlHours` TTL (default 8 h — survives a workday gap, kills overnight orphans): stale records are pruned on load *before* recovery iterates, so a restart now self-heals the fleet instead of growing it, and the hourly runtime reaper kills shells that have gone silent while detached. Activity is tracked by real PTY output, so a detached session that's actually busy (a running build, `tail -f`) is never reaped — only truly idle ones. Recovery also preserves the original `lastActivity` instead of stamping `now`, so the TTL can actually fire across restarts. (#557)

- **A crashed or Task-Manager-killed GUI no longer pins its terminal sessions alive forever.** Sessions with a client attached are deliberately exempt from every reaper — a client is watching, so the shell is in use. But that exemption trusted the `attached` state to be truthful, and nothing enforced it: when the GUI died without a clean detach (a crash, a force-kill), its sessions stayed `attached` in the daemon indefinitely, immune to the TTL and keeping the daemon itself alive. The daemon now notices when an attached client's pipe dies without a detach and, after a 60 s grace window (which absorbs renderer reloads and transient reconnects), demotes the session to `detached` so the normal 8 h detached TTL can age it out. (#557)

- **Supervised/exec panes are never reaped by the detached TTL.** Reboot-survival supervised units are long-lived unattached sessions that can legitimately sit silent for hours; they're now exempt from the new detached TTL (on both load-time prune and the hourly reaper) so supervision keeps working. Reaping a detached session now also unlinks its leftover scrollback buffer dump, matching the dead-session path. (#557)

### Contributors
Thanks to the external contributors in this release:
- **[@rayss868](https://github.com/rayss868)** — fixed the OpenClaude notification-spam detection ([#539](https://github.com/openwong2kim/wmux/pull/539)), first contribution. Root-caused it properly: captured the real TUI output to prove which pattern was firing every 16 ms, then narrowed the fix to the bare prompt marker and dropped an unreachable regex on review feedback rather than leaving it in.
- **[@snowyukitty](https://github.com/snowyukitty)** — hardened the TTL and Windows symlink test cases ([#569](https://github.com/openwong2kim/wmux/pull/569)), making the detached-session reaper suite deterministic instead of wall-clock dependent.

## [3.31.0] — 2026-07-22

### Added

- **Per-account Claude usage in Claude Code's statusline (`wmux setup-statusline`).** The global StatusBar widget shows one account's 5h/7d usage, but panes in a single workspace can run different Claude accounts — each pane needs its *own* number. A new `wmux setup-statusline` command sets Claude Code's `statusLine` to a wmux script that renders `model · account · 5h N% · 7d N%` on the line under the input box; because the statusline process inherits `CLAUDE_CONFIG_DIR` from its own claude process, every pane shows the usage of the account it actually runs on — including accounts selected by hand with `$env:CLAUDE_CONFIG_DIR`. The numbers are zero-cost: Claude Code ≥2.1 pipes the session's live `rate_limits` (5h/7d used percentage) to the statusline on stdin, so there is no extra API traffic and no token spend — the script reads stdin plus wmux's `accounts.json` (for the account name) and nothing else. Installs into the default `~/.claude` profile and every registered claude account; a user's own custom statusLine is never overwritten. `--remove` / `--status` supported.

### Changed

- **Statusline reset indicators are easier to read, and the 7d window now shows one too.** The `↺` reset marker sat flush against the time (`↺00:30`) and double-width terminal fonts could swallow the first digit — there's now a space (`↺ 00:30`). The 7d window previously showed only the percentage; since "how long until it frees up" is exactly what you want to know when it runs high, it now shows the remaining time (`7d 84% ↺ 52h`, or `↺ 2d4h` beyond 48h). Re-run `wmux setup-statusline` to update the installed script.

### Fixed

- **The per-pane "Resume" chip no longer appears while the agent session is still running.** The chip (the ↩ affordance that reveals the conversation UUID and types the exact `--resume` command) is meant to surface only once the agent has exited — typing into a live Claude/Codex TUI would land in the agent's input box. On panes without OSC 133 shell integration, though, its only "is the agent busy?" signal was a decaying activity heuristic: an agent that stayed quiet for 2 minutes (a long thinking stretch, or a finished turn waiting for your reply) read as gone, and the chip popped up mid-session. The gate is now edge-triggered on process truth: when a hook or the live banner proves the agent is running, the daemon attributes the actual agent process in the pane's process tree (one snapshot per launch, then a ride on the existing liveness batch — no new polling) and reports alive/dead alongside the session. The chip stays hidden the whole time the process lives — however quiet — and appears exactly on its exit, whatever the exit path (double Ctrl+C, `/exit`, Ctrl+D, a crash). Shell-integration panes keep their existing authoritative OSC 133 gate; panes where no process could be attributed keep the old heuristic as a last resort.

- **macOS zsh panes now percent-encode the directory they report, matching Windows.** The zsh integration hook has reported the pane's working directory (OSC 7) since v3.30.0, but it sent the raw path while wmux's parser percent-decodes what it receives — so a directory whose real name contains a percent sequence (say `build%20cache`) was silently tracked as `build cache`, and a directory name containing a raw ESC or BEL byte could cut the report short and smuggle terminal escape sequences into the pane. The zsh hook now percent-encodes the path exactly like the PowerShell/bash hooks shipped in the previous fix — spaces, Unicode, literal `%` and control bytes all round-trip byte-exact — and the encoder shields itself from user rc options (a `KSH_ARRAYS` setopt from oh-my-zsh-style configs no longer corrupts the encoding). Shell integration scripts refresh automatically (v9) on the next daemon start. (#541 follow-up)

### Added

- **Both resume affordances gained a `--dangerously-skip-permissions` toggle (Claude only, on by default).** The persistent Resume chip and the post-reboot recovery pill now each show a checkbox that forces `--dangerously-skip-permissions` onto the resume command they type — the common case for anyone who runs Claude in bypass mode, and previously a flag you had to retype by hand every time. It's checked by default; on the chip the command preview updates live as you toggle it, and on the recovery pill a checked toggle types the whole `claude --dangerously-skip-permissions --resume <id>` line in one click (no more two-step assembly). Unchecking falls back to restoring the conversation's captured permission mode (e.g. `--permission-mode acceptEdits`) on an exact resume. The flag rides both the exact `--resume <id>` and the cwd-relative `--continue` fallback, since it's a launch preference rather than something tied to one conversation. Codex, which has no equivalent flag, doesn't show the toggle. Neither affordance ever presses Enter for you — the typed command still waits for your keystroke, so bypass is never re-granted automatically.

- **OpenCode can now use the wmux MCP tools in packaged builds.** The daemon authorizes the bundled MCP server by recognizing the connecting agent host's `clientInfo.name` (a curated first-party allowlist — the server intentionally never self-declares capabilities, since part of its tool surface maps to reserved `wmux.internal` methods that no declaration can grant). OpenCode wasn't on that list, so under production enforce mode every capability-gated tool it called (`a2a_*`, `workspace_list`, `pane_*`, …) was rejected with `capability "…" was not declared by this plugin`. `opencode` (clientInfo name captured live from OpenCode 1.17.11) is now recognized alongside `claude-code` and `codex-mcp-client`, granting it the same scoped method allowlist — not a blanket bypass; an explicit user `denied` still wins. (#536)

- **Running many Claude sessions at once no longer degrades into hook storms, daemon false-restarts, and a frozen recovery dialog.** A fleet of concurrent sessions (measured at 13, designed headroom now 30+) hit several compounding bottlenecks, each fixed at its source:
  - *Hook connection storms*: every tool call in every session (and every parallel subagent) fired a PostToolUse hook that opened a fresh pipe connection — even though wmux keeps only ~1 activity signal per pane per 3s and discards the rest. The hook bridge now suppresses the discarded calls before connecting (per-pane stamp file, fail-open), so pipe traffic stays flat no matter how many agents run. The main pipe's per-second admission cap was also raised 30 → 120 (it was below legitimate hook traffic and its pre-auth rejections made the bridge retry, amplifying the storm), and `bridge.log` now rotates at 5 MB.
  - *Daemon false-restarts under load*: two hot paths wrote the growing sessions.json synchronously on the daemon's event loop (every `cd` across the fleet, plus the 30s snapshot tick's re-parse + re-write). The stalls starved the health ping exactly when the fleet was busiest, and the supervisor would force-respawn a perfectly alive daemon. Both paths now persist immediately but asynchronously through the existing coalescing write queue.
  - *Frozen "daemon recovery" dialog*: when anti-virus blocked the process probes that verify a slow-to-ping daemon, wmux popped a **synchronous** modal that froze the entire app — and offered to spawn a fresh daemon over the live one holding every session. The launcher now re-pings the daemon before ever asking (a daemon that answers is alive, whatever the blocked probes say), and the dialog, when still needed, no longer blocks the app.
  - *Per-chunk listener fan-out*: every daemon output chunk woke one listener per session (O(N²) on a busy fleet) and spammed `MaxListenersExceededWarning` from the 11th session. Output is now dispatched through a single shared listener keyed by session.
  - *Fleet-wide re-renders*: a 2s activity clock re-rendered every pane while any agent was running; the subscription now lives in the one small element that displays it, so idle panes do zero work per tick.
  - *Boot/switch storms*: the daemon's per-socket RPC cap (50/s) throttled the app against itself during a mass reconnect — all panes share one authenticated socket — and could leave panes unattached; raised to match the global cap (200/s).
  - `wmux setup-hooks` is now plugin-aware: with the wmux Claude Code plugin installed it removes (and stops writing) the duplicate settings.json hook entries that made every turn-end spawn two bridge processes.
- **Session restore after an upgrade no longer comes back with blank panes and duplicate agent sessions.** Upgrading (say 3.27 → 3.30) replaces the running daemon: the old one suspends every session to disk and a fresh daemon re-spawns them. But that fresh daemon only starts accepting connections *after* it finishes re-spawning them all, and cold-recovering a large fleet of agent panes is slow (measured ~19–23 s for 30–35 sessions). The launcher gave up waiting at a flat 15 s, decided the daemon had failed, and fell back to local mode — so every pane re-ran its workspace startup command from scratch, producing a fresh duplicate agent session next to a blank, never-reattached pane, and you had to recover each one by hand. The launcher now recognizes that a just-spawned daemon which is still alive but hasn't opened its pipe yet is *recovering, not wedged*, and keeps waiting (up to a 90 s ceiling) so the panes reattach to their real sessions instead. A daemon that actually crashes on startup still fails fast. (#537)
- **Browser screenshots no longer hang for panes that aren't on screen.** Chromium's screenshot command waits on a compositor frame that a non-visible webview guest may never produce, so `browser_screenshot` against a pane in a hidden workspace could stall for the caller's full RPC timeout (20–30 s) with no explanation — long enough that agents concluded the built-in browser was broken. Screenshot capture is now bounded: the CDP capture gets 2.5 s, an alternative capture path is tried for 1.5 s more, and if neither can produce pixels the call fails in ~4 s with an actionable error naming the likely cause (hidden workspace) and the workarounds (focus the workspace and retry, or use `browser_snapshot`/`browser_extract_text` for content without pixels). Screenshots of visible panes are unaffected (~60 ms). (#529)
- **Split panes on Windows once again open in the parent pane's directory.** wmux stops reading the working directory off the prompt text the moment any program in the pane emits an OSC 7 escape, on the assumption that the shell's own integration hook will keep reporting the directory from then on — but only the zsh (macOS) integration actually emitted OSC 7. On PowerShell and Git Bash, a single stray OSC 7 from an agent TUI or nested shell silenced the only tracking source for good: the pane's directory froze at its spawn value (usually home), and every later split inherited that stale value instead of where you actually were — the same "split lands in home" failure #515 fixed, reopened from the tracking side. The PowerShell and bash integrations now report the working directory via OSC 7 on every prompt, exactly like zsh — making the hand-off assumption true on every shell, keeping the pane's tracked directory live, and keeping the screen-text false-positive protection intact. Shell integration scripts are refreshed automatically (v8) on the next daemon start. (#540)
- **A browser opened by an agent in a background workspace no longer clones its terminal and strands a stray empty pane.** When an agent working in a workspace you weren't looking at opened a browser (the create path — that workspace had no browser pane yet), the browser was attached to the agent's own terminal pane instead of the freshly split one, and the empty split pane was left behind to sprout a stray terminal the moment you focused that workspace. The cause: a background split intentionally leaves the workspace's active-pane selection untouched (so it can't hijack the pane you're focused on), but the browser-open code read that unchanged selection as if it were the new pane. It now uses the exact pane the split created, so the browser lands where it should and no empty pane is orphaned. (#531)

## [3.30.0] — 2026-07-22

### Added

- **A browser pane's CDP target is registered as soon as the guest attaches**, instead of only after the page finishes loading, so automation can reach a pane whose page is slow or unreachable. Two related fixes: an already-attached debugger no longer aborts registration outright (the guard never matched Electron's actual error text), which previously left a reloaded guest permanently unregistered. (#517)
- **Discard hidden browsers (opt-in) — lightweight mode now has a memory lever.** Lightweight mode only capped CPU; every hidden browser pane still held its full Chromium renderer in memory. A new sub-toggle under "Lightweight background browsers" ("Discard hidden browsers", default off) unloads a browser pane after it stays invisible for 5 minutes — the guest renderer process exits and its memory is reclaimed, and the pane shows a small "suspended" placeholder. Returning to the pane (or navigating it) reloads the page; scroll position and unsaved form input are lost, which is why it's opt-in and the dwell is generous. Panes playing audio are never discarded, and automation (MCP tools, screenshots) targeting a discarded pane wakes it automatically and waits for the reload before running — so background agent flows keep working. (#517)
- **Lightweight mode for built-in browsers (opt-in).** With many workspaces open, every embedded browser pane kept its Chromium renderer running full-speed even when its workspace was hidden — that CPU was burned on purpose so background automation (MCP screenshots, `evaluate`) never stalled. A new Settings → Terminal toggle ("Lightweight background browsers", default off) CPU-throttles a browser guest only while it is *effectively* invisible — hidden workspace, pane hidden behind another pane's zoom, unselected tab, or minimized window — and any automation touching a guest takes a short-lived lease that runs it full-speed for the duration, so background automation stays correct. (Classic background-tab timer throttling turned out to be inert for these guests — Electron keeps a CSS-hidden webview in the "visible" page state — so the throttle is applied as a CDP CPU-rate override, measured at a 2–5× CPU reduction on timer-driven pages.) This reclaims CPU only; renderer memory is unchanged. (#517)

## [3.29.0] — 2026-07-21

### Fixed

- **Typing stays responsive — and Hangul/CJK composition no longer truncates — while an agent floods a visible pane.** A TUI redraw is a burst of tiny cursor-move writes, and handing each one to the terminal separately made the GPU re-rasterize the whole grid dozens of times a second; while a frame was held for paint, keystrokes and IME composition events queued behind it, so fast typing dropped characters and "했습니다" could land as "했". wmux now honors the terminal's own frame markers (DEC mode 2026 synchronized output, which Claude Code and Codex emit): it holds a frame's intermediate writes out of the renderer and releases them in one shot when the frame closes, so the GPU paints once per redraw instead of once per fragment. A frame that opened right after a keystroke is treated as latency-sensitive and released within a frame or two, so your own echo always paints ahead of an agent's autonomous output. Windows ConPTY only for now.
- **Switching workspaces no longer stutters when a hidden pane piled up a large scrollback.** A pane that streamed output while hidden handed its whole backlog to the renderer in one parse on reveal, spiking the GPU across several frames. A large backlog from a daemon-backed pane is now re-synchronized from the daemon as a bounded screen snapshot instead of replayed in full, and a backlog that can't be re-synchronized is drained over frames rather than in one burst — so a switch stays smooth without ever dropping or losing output.

### Added

- **Notifications can be muted per category instead of all-or-nothing.** Every notification now carries the kind of event that produced it — agent turn finished, subagent finished, awaiting approval, terminal (OSC 9/99/777), system/external — and Settings → Notifications has a switch per category. Before, the only knobs were global sound/toast/ring toggles, so quieting subagent chatter during parallel work also silenced the "awaiting approval" signal that actually needs you. Muted categories still land in the notification panel; only toast, sound, pane ring, and taskbar flash are suppressed, the same contract a muted workspace already had. Nothing is muted by default, and a notification whose source can't classify it is never suppressed by a category mute. The mute is honored even when wmux has no live window — the muted set is mirrored to the main process, so a category you turned off can't come back as a desktop banner while the app sits in the tray. Subagent-vs-main-agent classification comes from the Claude Code hook bridge; the text detector can only distinguish approval prompts from turn ends, and the Settings copy says so. (#516)

### Fixed

- **A single failing installer step no longer discards the platform's whole release.** Forge builds makers in sequence and stops at the first failure, so when the macOS DMG step hit a transient `hdiutil detach` error during v3.28.1, the upload step never ran — and the runner was thrown away with a perfectly good `.zip` still on it. That zip is what backs the auto-update feed, so one flaky maker silently took out both the download **and** auto-update for macOS until the job was re-run. Both the macOS and Linux upload steps now run regardless of whether the build step failed, publishing whatever artifacts did get made.
- **macOS: panes get the shell environment you actually have.** zsh was started interactive but not as a login shell, and on macOS the standard `PATH` is assembled by `/etc/zprofile` — a **login** file that runs `path_helper`. So a pane inherited whatever `PATH` the app was launched with (launchd's minimal one for a GUI launch) and lost `/opt/homebrew/bin`, `/usr/sbin`, `/sbin`, `/Library/Apple/usr/bin` and every `/etc/paths.d` entry. `.zshrc` still ran, which is why the shell looked fine right up until an unqualified Homebrew command failed. Panes now start a login shell on macOS, matching Terminal.app, iTerm2 and VS Code. The `.zprofile`/`.zlogin` stubs that delegate to your real files already existed — they were simply never read. (#519, reported by u/DauntingPrawn)
- **New and respawned terminal panes now honor the workspace's startup directory instead of landing in your home folder.** When a pane's shell had to be re-created (a recovered session, a rebind failure, or a dead-session respawn), it ignored the workspace's configured startup directory and fell back to home — and once a pane lived in home, every split off it inherited home too, so the corruption spread and never healed. A respawn now resolves its directory as `profile.startupCwd` → the pane's own tracked directory → the global startup-directory setting, with the workspace default taking priority so a pane that drifted to home is corrected the moment it respawns. New tabs (Ctrl+T, command palette), MCP-created surfaces, and Git-tab "Open worktree"/"Open conflict" now all adopt the directory the shell actually started in, and a workspace opened with a startup directory attaches it before its first pane spawns. A `[pty:create]` log line records each pane's resolved directory and why, so future reports are diagnosable from the logs. (#515)
- **`~/…` works wherever you can pass a directory.** Tilde expansion is a shell feature, so a working directory arriving through the CLI, an MCP tool or the RPC layer was never expanded by anything — `~/projects/foo` stayed literal — so the pane either opened silently in your home directory (where the code checks the path first) or came up dead and blank with no error at all (where it doesn't: the shell exits 1 immediately on an unreadable cwd). It now resolves at both spawn paths. `~otheruser` is left alone rather than silently mapped to your own home. (#520, reported by u/DauntingPrawn)

## [3.28.1] — 2026-07-21

### Fixed

- **The Git tab (worktrees + review roster) now finds the repo an agent is working in, even when the shell it runs in sits elsewhere.** Repo context used to come only from the pane's shell working directory — but for an agent pane (Claude / Codex TUI) that is typically the directory the shell was *started* in (often the home dir), while the agent works in a repo somewhere else. Result: the sidebar showed the branch just fine, yet the Git tab said "not a git repository". Repo resolution now falls back to the hook-reported agent directory (the same value the sidebar branch badge already trusts) when the shell's own directory doesn't resolve to a repo.
- **Resume no longer silently downgrades to `--continue` when the pane's tracked directory is stale.** The resume chip/pill only offers the exact `--resume <uuid>` form (with the recorded permission flag) when the conversation's origin directory matches the pane's live directory — but it compared against the shell's tracked cwd, which goes stale across `cd X; claude` one-liners (no prompt render in between, so the shell never reports the new directory). A legitimate exact resume was then downgraded to `--continue`, dropping the permission flag and possibly resuming a different conversation. The match now also accepts the hook-reported agent directory (the same value the sidebar branch badge trusts). Nothing auto-runs either way — the command is only typed, and you press Enter.
- **A pane's tracked working directory can no longer be corrupted by terminal output that looks like a shell prompt.** Two guards, observed live (a pane's directory stored as the literal token `path`, which then broke Git-tab repo resolution): once a shell has proven it runs the wmux integration hook (it emitted an OSC 7), prompt-scrape directory detection is permanently disabled for that session — the hook is authoritative, so scraping could only ever add false positives; and scraped values must now be absolute (or `~`-anchored) paths on every platform — a bare relative token is never a real working directory.
- **The orchestrator can tell a pane that finished from a pane that asked you something.** A pane's turn-end reached the orchestrator as "pane stopped" and nothing else, so the only way to learn *why* it stopped was to read the rendered terminal — where a question the agent printed looks exactly like text sitting in its input box. Orchestrators mis-read that: reporting panes as "still running" while they sat blocked on an unanswered question, and pressing Enter to "submit" a line that was never there. A turn-end now carries the agent's own closing words, lifted from its transcript rather than the screen, and a stop that ends in a question (including Korean endings that carry no `?`) is stamped **BLOCKED ON A QUESTION** with the question quoted — the same treatment reviewer comments already get. The pane's question is also published as `pendingQuestion` on `pane_list`, so an orchestrator can check whether a pane is waiting on it without reading the terminal at all. Deliberately not a new agent status: `waiting` already meant "turn ended", and what was missing was the content, not another state.
- **`terminal_send_key` no longer implies it submitted something.** Sending `enter` returned a bare success whether or not anything was committed, which is what let an orchestrator report a blocked pane as working. Enter presses now come back with an explicit note that delivery is not submission, and the tool description points callers at `terminal_send({ text, submit: true })` for answering an agent that is waiting on them.

## [3.28.0] — 2026-07-20

### Added

- **Resume a pane's agent conversation right from the pane.** After an agent (Claude / Codex) exits back to a shell, the pane header shows a quiet `↩ Resume <agent>` chip whenever wmux captured that conversation's session. Clicking it reveals the conversation UUID (with a copy button) and a preview of the exact command it will type; **Resume** types `claude --dangerously-skip-permissions --resume <id>` into that pane — the recorded permission mode is restored, and the exact-session form is used only while the pane's directory still matches the origin (otherwise it falls back to `--continue`). Nothing auto-runs; you press Enter. The chip stays hidden while an agent is actually running in the pane: OSC 133 shell state is the authoritative gate (a foreground command owns the PTY), with an agent-activity heuristic as fallback when shell integration is off — so a resume command can never land in a live agent's input. Available on any agent pane anytime, not only right after a reboot.
- **The daemon now keeps a durable log at `~/.wmux/daemon.log`.** The wmux daemon runs detached with its console output discarded, so a live daemon left no trace of what it did — which made post-reboot session-recovery failures impossible to diagnose. Every daemon line is now mirrored to a rotating file (5 MB + one backup), and the reboot-recovery pass logs how many sessions it loaded from state and how many it respawned (so "loaded 0" — a persistence failure — is distinguishable from "loaded N, respawned 0" — a spawn failure). The last-resort synchronous state save on OS shutdown, previously Windows-only, is now registered on macOS/Linux too as a clean-exit backstop.
- **Safely "merge" a worktree into your local base from the Git tab.** Each feature-worktree row gets a **Merge** button. It never touches your local main (or the repo's default branch): it performs a git-native merge in an isolated worktree branched off the base. When there are no conflicts it automatically runs a verify gate (`npm test` + `npm run lint`) and — **only if it passes** — shows a one-line summary ("N files changed · verify passed") with **Land** (fast-forward the base to the result) / **Discard** (roll back) buttons. On a conflict nothing is auto-resolved; a "Conflict — open with Claude" button opens that isolated worktree as a new workspace so you can resolve it yourself (with Claude). Pass/fail is judged solely by the real process exit code, never by "done" text, and the in-flight merge state is derived from git on disk, so Land/Discard survives an app restart.
- **Git joins the right dock as a tab, plus a git signal line and a Git button in the sidebar.** The right dock is now three tabs: Orchestrator · Git · Channels. The Git tab shows the current workspace's worktrees + PRs on top and a diff roster (the former Review, merged in from its own tab) below, in one scroll. The left sidebar footer gets a **Git button** below Agent (opens the dock straight to the Git tab; a badge shows how many workspaces have uncommitted changes), and each workspace name now carries a git signal line: alongside the branch, read state at a glance by color — green ● (clean) / amber ●N (uncommitted changes) / blue ↑N (ahead) / red ↓N (behind). The bottom diff roster (Review) now lists **only workspaces in the same repo** (including its worktrees) as the one you're looking at, matching the merge workflow's scope. Earlier layouts (top header tabs, full-screen center surface) were reverted.
- **Agent toolbar: Broadcast is back and works.** The old Broadcast prompt relied on a browser dialog that never existed in the packaged app; it now opens an inline popover that shows how many terminals it will hit, sends to every terminal pane in the current workspace, and reports how many succeeded or failed.
- **macOS: the `wmux` CLI now installs itself from DMG/ZIP installs.** On first launch the packaged app symlinks the bundled CLI to `/usr/local/bin/wmux`, falling back to `~/.local/bin/wmux` (with a PATH hint) when permissions deny it. Homebrew-owned or any foreign file at that path is never touched; only wmux-owned stale symlinks are refreshed. Attempted once, off the boot path.
- **macOS: "Start at login" works now.** The autostart toggle was a Windows-registry-only no-op on macOS; it now drives `app.setLoginItemSettings`, and the Startup section is visible in Settings on macOS.
- **macOS: the Settings font picker now lists installed fonts** via `system_profiler`, instead of always coming up empty (the enumeration was PowerShell-only).

### Changed

- **Command deck cleanup.** The orchestrator tab is now labeled **Agent (model)** — e.g. `Agent (Sonnet 5)` — and clicking it while it's already active opens an inline model picker right there, so switching the orchestrator's model no longer needs a separate chip. The Multi Task/fan-out button lives on the agent toolbar (left of New chat), next to Broadcast, so a fleet can be spawned from the terminal chrome. The deck tabs also get a lighter look (truncating labels that survive a narrow deck, rounded count badges, a steel active underline).
- **Daemon/session sockets moved from `~/.wmux-*.sock` into `~/.wmux/`.** One shared path helper now feeds the daemon, main, and CLI (they each computed the path separately before), keeps `sun_path` under the macOS 104-byte limit, and stops littering the home directory. A live pre-upgrade daemon keeps working: the control pipe rides the existing hint file, session connects fall back to the legacy path once on ENOENT, and a stored legacy default pipe name migrates in config load.
- **Terminal font fallback chain now covers macOS** (Menlo, SF Mono, Monaco, Apple SD Gothic Neo) ahead of the generic monospace it used to fall straight to; UI font stack leads with `system-ui` instead of unbundled Inter/Segoe UI.

### Fixed

- **Windows: updating no longer crashes when wmux is still running.** Running a new-version `Setup.exe` (or clicking "Restart to install" in Settings) while wmux was open collided with the live instance — locked old-version files plus a single-instance collision on relaunch — and crashed the Squirrel updater. The in-app updater now quits wmux right after launching the verified installer, and the installer hooks terminate any still-running wmux windows before doing their work, then relaunch the updated app when done. Live terminal sessions survive either way — they persist in the wmux daemon, which is deliberately left running. (#502)
- **macOS: the sidebar workspace context line (branch, ports, PR) now tracks the pane's real directory.** The zsh shell integration emitted OSC 133 (command markers) but never OSC 7 (working directory), so on macOS's default shell wmux never learned about a `cd` — the branch/git badge stayed pinned to the directory the pane was created in (usually home, where nothing shows) even after you moved into a repo. The zsh integration now emits OSC 7 on `chpwd` (immediately on any `cd`, even before a long-running command) and `precmd` (initial + every prompt). bash/PowerShell were unaffected because the daemon's prompt-scrape reads their default prompts (`user@host:…$`, `PS C:\…>`), but zsh's `host%` prompt carries no path.
- **macOS: the sidebar workspace context line is also restored after an app restart.** Reconnecting to a persisted daemon session dropped the session's working directory — and since the metadata poll skips any pane with no cwd, the whole context line collapsed to just the workspace name. The daemon already returns each session's cwd from `listSessions`; reconnect now seeds it.
- **Defensive: `git` resolves under the minimal GUI PATH on macOS.** A GUI-launched macOS app inherits only launchd's minimal PATH, not the Homebrew PATH `~/.zshrc` sets up; `execFile('git', …)` now merges in the standard Homebrew/system locations so a machine with git installed *only* via Homebrew (no Xcode Command Line Tools) can still run the sidebar sync badge and worktree/task-close git checks. (Machines with Xcode CLT already have `/usr/bin/git`, which the minimal PATH finds — so this is hardening, not the fix for the context-line bug above.)
- **macOS: clicking the Dock icon now reopens a window hidden via close-to-tray.** `activate` only created a new window when zero windows existed; a hidden-not-destroyed window still counted, so Dock reactivation was a dead click with no visible way back short of finding the menu-bar tray icon.
- **macOS: the menu-bar tray icon is no longer oversized.** It rendered the 1024px `.icns` app icon at native size instead of a ~22pt menu-bar icon; it's now resized on macOS only.
- **macOS: the menu-bar tray icon is now a legible monochrome mark, not a black blob.** Simply downscaling the full-color `.icns` app icon (a 1024px art board on an opaque black plate) collapsed it into an unreadable dark square in the menu bar. macOS now loads a dedicated template asset — `assets/trayTemplate.png` (plus an `@2x` sibling), extracted from the app icon's own `>w` artwork by `scripts/generate-tray-icon.js` — as an alpha-only image, so the system paints it white on a dark menu bar and black on a light one and highlights it while the menu is open. Windows/Linux keep the full-color app icon.
- **macOS: quitting during OS logout/restart no longer risks losing the latest session snapshot.** The synchronous session flush only existed on the Windows `session-end` path; `before-quit` now flushes synchronously on macOS before any awaits.
- **Defensive: the macOS `.dmg` is signed and notarized too, not just the `.app` inside it.** The app bundle was already signed, notarized, and stapled, which is what Gatekeeper checks on launch — so installs worked — but the disk image itself carried no signature (`spctl` reported "no usable signature" on the container). The release build now signs, notarizes, and staples the `.dmg` as well, so the image verifies at mount time and offline. Signing the container can never cost you the release: any failure along the way (missing credentials, an ambiguous certificate, an Apple outage) downgrades to a warning and ships the image unsigned — exactly what shipped before — rather than failing the build and taking the `.zip` down with it.
- **macOS: Ctrl+V passes through to the shell as quoted-insert.** Paste interception is non-mac only now — Cmd+V already owns paste on macOS.
- **macOS: terminal Ctrl+letter control bytes work again.** The xterm key handler swallowed Ctrl+D/K/I/N/T/,/\` (and Ctrl+=/-/0, Ctrl+\`) to bubble them to app shortcuts, but on macOS those shortcuts live on Cmd — so Ctrl+D (EOF), Ctrl+I (Tab), Ctrl+K (kill-line) and friends reached neither the app nor the PTY. On macOS only the literal-Ctrl bindings (Ctrl+B prefix, Ctrl+M bookmark, Ctrl+Arrow) still bubble; everything else now passes through to the shell. Windows/Linux unchanged.
- **macOS: Ctrl+C always sends SIGINT.** With a selection present, Ctrl+C was intercepted as copy even on macOS, where Cmd+C already owns copy — so you couldn't interrupt a running process while output was selected. The copy-on-selection branch is now non-mac only.
- **macOS: the WMUX logo no longer overlaps the traffic lights.** macOS 26 (Tahoe) draws larger window buttons, so the 72px left reserve left the logo touching the green button; the reserve is now 80px (mac only).

## [3.27.0] — 2026-07-18

### Added

- **A merge conflict on a pane's PR now wakes the owning workspace too.** Completing the PR-feedback trio (red CI, review comments, and now conflicts): when a pane's pull request becomes conflicting against its base, the workspace's orchestrator wakes once — `auto` may send the pane one instruction to rebase/merge its base and resolve the conflict, `assist` reports, `off` stays silent. Edge-triggered per episode (fires once, re-arms when the conflict clears) and rides the same throttled `gh` read the review-comment router already makes, so it adds no extra polling. GitHub via `gh`'s `mergeable`, GitLab via `has_conflicts`.
- **New Review tab in the deck: every workspace's diff, one screen.** The dock now has a Review tab listing every open workspace with its branch, PR badge, and uncommitted diff stat (files / +adds / −dels), dirty rows first — so when several agents work in parallel you can see at a glance who changed what and step into each review. The Diff action jumps to that workspace and opens the existing diff surface (hunk-level review/adopt unchanged); Go just switches. Pull-based (load on open + manual refresh), no polling.
- **New PR review feedback now routes to the owning workspace too.** When a reviewer leaves a comment (conversation, review verdict, or inline code comment) on a pane's pull request, the workspace's orchestrator wakes with the author and a snippet of the latest comment — under the same policy as the CI signal: `auto` may send the pane one instruction to address the feedback, `assist` reports, `off` stays silent. Watermarked per pane on comment timestamps, so checking out a branch with existing review history never wakes anyone; only strictly-new comments fire, once per batch. Rides the existing `gh` caches (30s PR-list TTL, `updatedAt`-keyed detail), throttled to one check per pane per minute.
- **A workspace's orchestrator now wakes when its PR turns red, and can drive the fix.** When a pane's pull-request CI checks flip from passing/pending to failing, wmux fires a one-shot signal that wakes the owning workspace's brain through the same event-push path as a stopped pane — so a broken build routes straight back to the agent that owns it instead of waiting for you to notice the red badge. It is edge-triggered (fires once per red transition, re-arms after the PR goes green again, never spams while it stays red) and inherits the workspace's autonomy policy exactly: `auto` may send the pane one instruction to investigate and fix the failing checks, `assist` surfaces it as a report, and `off` stays silent. The wake prompt carries the PR number and URL so the brain acts without a poll. Closes the "detect → route back to the responsible worker" loop that competing multi-agent orchestrators ship.
- **Sidebar workspaces now show git sync state next to the branch name** — `↑2 ↓1 ●3` for commits ahead/behind the upstream and uncommitted changed paths. A clean, synced checkout shows nothing (only trouble earns pixels), everything renders in the muted context color, and the tooltip spells the numbers out. Fed by one `git --no-optional-locks status` per repo per 15 s riding the existing metadata poll; a branch switch invalidates immediately.
- **Sidebar workspaces now show how long they've been idle** — a muted `· 3m` next to the name once a workspace has gone a minute without agent activity, counting up through minutes/hours/days. The status dot already said *what* a workspace is doing; this says *how long it's been waiting for you*, which is what matters when running several unattended agents. Hidden while an agent is running and until the first activity of the session. Plain terminal output also counts, not just agent activity: shell-only workspaces never tripped the agent activity gates (the daemon's byte-threshold 'running' detector needs a 2000-bytes/3s burst), so a pane you'd been using by hand used to read as idle-forever. Raw PTY output now stamps a separate per-surface clock (throttled to once per 30 s, kept apart from the agent-status derivation so a quiet `ls` can't light status dots), and the badge reads whichever clock moved last.

### Changed

- **A driving loop now proposes its own completion instead of idling to the budget.** When an autonomous (Continue) loop judges its objective met — the done-when checklist all passing, or the goal plainly achieved with no checklist — it now raises a confirm-completion decision (`Mark done` / `Keep going`) and stops, rather than continuing to auto-wake until the iteration budget runs out. Because a pending decision halts every wake, a finished overnight loop pauses for your confirmation instead of burning the rest of its budget doing nothing. You still have the final say; the brain never marks itself done.
- **The loop's iteration budget reads as "pause after N auto-wakes" now.** The bare "iterations: 25" field never said what an iteration was; it's now labeled `pause after [25] auto-wakes` with a plain-language tooltip (one wake ≈ one iteration; raise it for long unattended runs), so the number means something when you set it.
- **The loop setup dialog now shows what the loop will actually be allowed to do, and defaults to acting instead of just watching.** Because a loop's real authority is `min(workspace mode, tier)` and the approval-press capability lives on the workspace *mode* (Auto), the modal previously hid a trap: you could configure a "Continue" loop expecting unattended approvals, then it would stall on the first prompt because the workspace was only Assist. The dialog now reads the workspace mode and spells out the effective authority (`drive panes` / `press approvals`, each ✓/✗) with a one-line hint — "raise the workspace to Auto to press approvals unattended", or a warning when the mode is Off. The tier also defaults to **Continue** now (was Report-only), since "Start a loop" that only observes read as inert on first use; the dangerous caps stay gated on the mode, so the active default is safe.
- **Fan-out is now Multi Task (한국어: 병렬 작업) — and it can run N *different* jobs in parallel.** The dialog previously sent one shared prompt to every spawned task, which only covered the "same work, N attempts" scenario. Each task row now has its own prompt field: fill the shared prompt for common context, the per-task prompt for that task's actual job, or both (they're combined). A Compete/Parallel toggle makes the two use cases explicit — Compete collapses the dialog to just the shared prompt, Parallel shows per-task fields. Task count is now a row of click targets (1–8) instead of a slider. A task can also have no prompt at all: it opens with just the worktree and an idle agent pane for you to type into by hand, instead of being rejected.
- **A running loop's authority now composes with the workspace mode instead of overriding it.** Loop caps were a blanket write that forced approval-press off, so raising the workspace to `auto` and starting a loop paradoxically *lost* approval authority — the most autonomous mode plus a mission was weaker than the mode alone. Loop caps are now `min(mode ceiling, tier)`: the mode is the standing trust ceiling, the loop tier narrows it. A `report` loop only observes; a `continue` loop drives panes and — only when the workspace mode is `auto` — presses approvals, making `auto` + loop the true unattended supervisor while `assist` + loop stays notify-on-approval. The dangerous press capability now lives solely on the workspace mode (a deliberate standing choice), never on a per-loop dropdown. Changing the mode mid-loop re-narrows the new ceiling by the loop's tier rather than blowing the tier away.
- **The orchestrator's agent-mode chip is now colour-coded by state**, so the current autonomy is readable at a glance instead of a uniform grey pill. `off` stays neutral with a grey idle dot; `assist` turns warm amber (alive) with a subtle tint; `auto` gets a red outline + red dot (the destructive tier, red tint at rest — never a fill). A leading status dot carries the same meaning-class as the fleet dots.
- **macOS default launch hotkey is now Ctrl+7** (was Ctrl+F7). F7-based combos are a trap on macOS: bare F7 is consumed by the media keys, and Ctrl+F7 is the system-wide "Change the way Tab moves focus" shortcut, so the app never received either. An untouched saved F7/Ctrl+F7 default is migrated automatically on load; Windows/Linux keep F7.

### Fixed

- **A tool-heavy agent turn no longer floods the hook bridge with timeouts.** Every Claude tool call fires a hook that has to resolve which pane it came from, and that resolution used to make a round-trip to the renderer on every single hook. When the renderer was busy (parsing a large terminal buffer on attach), the round-trip blew past the bridge's 2-second cap and the hook timed out — in one dogfood, ~24% of hooks. Hooks that carry the pane's own id (the common in-pane case) now route from the last-known workspace map without touching the renderer at all, so a saturated renderer no longer starves notifications, activity, and completion signals. Workspace-scoped hooks still take the authoritative path, and the fast path is bounded: if the map is more than 10 seconds stale it falls back to a fresh lookup rather than trusting an old snapshot.
- **The session buffer snapshot no longer churns the disk when antivirus locks a file.** On Windows, a real-time AV scan (or any reader) can briefly hold a handle on a session's scrollback `.buf`, making the atomic save fail with `EPERM`/`EBUSY`. The save gave up immediately, marked the session dirty, and re-dumped the whole multi-megabyte buffer on the next tick — a churn loop that made the lag worse. The save now retries the rename with a short bounded backoff so the transient lock clears, and dumps to the same file are serialized so a retry-delayed older snapshot can never overwrite a newer one.

- **A failed legacy-state migration retry can no longer silently lose channel data.** When the daemon detected that an older daemon had written channel state directly to disk but failed to fold that state into the canonical event log, it logged a warning and kept booting — and the very first write afterwards erased the marker the promised next-boot retry depended on, silently dropping the old daemon's data. The daemon now refuses to boot in that state, leaving everything on disk intact so the next boot re-detects the condition and completes the retry.

- **The orchestrator control bar no longer strands the "Recover agents" button off to the right.** The reboot-recovery quick action was pinned with `ml-auto` in a wrapping flex row; in the narrow dock the bar wraps, so the button was shoved alone to the far right of its own line with a wide gap after Schedules. It now flows inline with the other controls.
- **In-app "Install hooks" no longer fails with "Could not locate the bundled wmux-bridge.mjs".** The bridge locator only knew the CLI's layout; when the install button called it from the packaged app's main process, it walked right past `Resources/cli-bundle/` where the bridge actually lives. The packaged path is now a search candidate, so the one-click install works.
- **macOS titlebar no longer shifts the WMUX segment 72px right.** The traffic-light reserve now lives inside the mantle segment, so the logo, + button, and segment seam line up with the sidebar edge below again.
- **Idle CPU/GPU drain from perpetual UI animations.** The sidebar status-dot breathe, unread notification ring, and completed-pane blink animated `box-shadow`/`border-color`, forcing a style recalc and repaint every frame (~86 recalcs/s measured, renderer + GPU ≈ 30% CPU while idle). The glows are now static shadows on pseudo-elements with compositor-only opacity animation — same look, near-zero main-thread cost. Reduced-motion now also stills the sidebar dots.

- **File-edit approval prompts no longer strand a pane (and the orchestrator) for hours.** The screen-reading detector only recognized Claude Code's `Do you want to proceed?` and `Allow tool use for …` prompts, so a `Do you want to overwrite <file>?` / `create` / `make this edit to` approval never emitted an awaiting-input event — in a live run a worker sat on one for 100 minutes while the orchestrator was never woken. The detector now matches the file-edit prompt family, including two rendering hazards observed in that pane: cursor-move drawing that eats the spaces between words, and narrow-pane wrapping that puts the filename on the next line.

- **The orchestrator no longer delegates pipeline routing to workers that can't route.** It used to tell a pane "hand off to the Builder when ready" — an instruction a worker pane cannot follow (panes can't see or message each other), so the first pane quietly did the whole job while the Builder and Reviewer sat as bare shells. Its standing instructions now make the brain the only router: scope each dispatch to one role's stage, wait for the result, and carry it to the next role's pane itself — launching the agent CLI there first if the pane is still a bare shell.

## [3.26.0] — 2026-07-17

### Added

- **Type `/clear` to the orchestrator to reset its context.** The brain's conversation memory (and its persisted resume session) is dropped, so the next turn starts completely fresh — useful when it has accumulated stale instructions or gone down a wrong path. The visible transcript stays as your audit trail; `/reset` works as an alias. An in-flight turn is interrupted first.

- **wmux now offers to install its Claude Code hooks — and tells you when you're missing them.** Agent completion and approval detection is hook-primary, but the hook bridge previously required knowing the `wmux setup-hooks` CLI existed; without it, every signal silently degraded to screen-reading. A prompt now appears at launch when hooks are missing, and again when you raise a workspace's agent mode — with an Install button that does the same idempotent install as the CLI. wmux still never edits your Claude settings without that explicit click.

### Changed

- **The agent mode knob is now three honest positions — Off, Assist, Auto (danger) — and the default is Off.** The previous four modes (off/manual/assist/orchestrate) collapsed into three that mean what they say: **Off** (the new default) gives the orchestrator no autonomy at all until you opt in; **Assist** wakes it only when a pane is blocked on input, to notify you — it never approves anything; **Auto (danger)** wakes it on every agent event and lets it drive work to completion on its own judgment, including pressing approval prompts. Existing workspaces keep working: a stored `manual` mode reads as Off, `orchestrate` as Auto.

- **Auto mode actually presses approvals now.** The orchestrator was told "regex-detected prompts are notify-only, never approve" while the only source of approval events *was* the regex detector — so even the most permissive mode never pressed anything, silently. In Auto mode the brain is now instructed to verify first (read the pane and confirm a real approval prompt is on screen) and then press it, so a stray "y/N" in ordinary output still can't trigger a blind keystroke. Assist mode remains notify-only.

- **The orchestrator treats your pane roles as a workflow, not just labels.** With Planner / Builder / Reviewer panes set up, non-trivial work now flows through them unprompted — plan first when the task is ambiguous, and review before reporting "done" — instead of one pane doing everything while the team you assembled sits idle.

- **The orchestrator now reuses your existing panes before spawning new ones.** Its standing instructions gained a reuse-before-spawn rule: check the pane list for an idle shell or a finished agent and send work there, spawning a fresh pane only when nothing is free or the work genuinely needs to run in parallel. Previously it happily split a new pane while a suitable one sat idle next to it.

### Fixed

- **Dropdown menus were white-on-white in dark themes.** Native `<select>` popups (like the Fleet role dropdown) rendered their option list on the OS default white background while the text inherited the theme's light color. The popup now follows your theme in both directions.

## [3.25.0] — 2026-07-17

### Added

- **The notification panel now remembers where you were.** Closing and reopening the bell panel restores the exact scroll position you left off at, instead of yanking you back to the top of the list mid-triage. If new notifications arrived while the panel was closed, it snaps to the top instead so the newest entries are immediately visible (the list is newest-first). The memory is per-session and in-memory only.

- **Codex approval prompts now raise a "needs your input" alarm, mid-turn.** When Codex CLI pauses to ask "Would you like to run the following command?" (or the edit-approval and first-boot directory-trust variants), wmux now detects it and fires an `awaiting_input` notification — previously a Codex pane waiting on approval sat silent until you happened to look, because Codex's own notify hook only fires when the whole turn completes and says nothing about mid-turn pauses. The prompt strings were transcribed from a live Codex CLI 0.145.0 session and are matched whole-line, so an agent merely *talking about* an approval prompt doesn't trigger a false alarm. Clicking the alarm jumps to the waiting pane, like every other notification.

- **Connect a different brain to the Command Deck — Hermes Agent is the first non-Claude orchestrator.** A new **Settings → Orchestrator → Orchestrator brain** picker chooses which agent runtime drives the deck: Claude Code (the default, unchanged) or Hermes Agent over ACP — the open Agent Client Protocol, so further ACP-speaking agents are a configuration entry away, not a new integration. The connected brain gets the same fleet hands (wmux tools over MCP), the same server-side guardrails (it cannot close panes or leave its workspace), streams into the same deck chat with tool-call chips, and keeps its own conversation history across restarts — each brain's thread is separate, and switching back resumes where that brain left off. wmux never touches the brain's model credentials: Hermes authenticates through its own setup on your machine, exactly like your Claude login. Requires the vendor's CLI installed; if it isn't, the first command tells you plainly instead of hanging.

- **Orchestrator full-power mode (opt-in): your Claude Code skills, CLAUDE.md and hooks, inside brain turns.** By default the Command Deck orchestrator runs "raw" — a fully explicit contract that deliberately loads nothing from your `~/.claude` setup, because personal hooks firing inside every brain tool call cost real latency and can feed events back into wmux itself. A new toggle in **Settings → Orchestrator** opts a workspace's brain into the full Claude Code ecosystem: skills become invocable, your CLAUDE.md applies, and your hooks run. The brain's *tool* guardrails do not widen with it — it still cannot close panes, spawn subagents, run shell commands, or edit files, a skill's embedded inline-shell syntax is replaced with a placeholder instead of executing, and while the toggle is ON the brain also cannot write its memory notes (`Write` is hard-blocked in this mode so that no personal permission rule can widen it — a conservative first cut; relaxing that is a separate decision). One thing to understand before opting in: **your hooks are your own code** — they run inside brain turns outside any wmux sandbox, exactly as they do in your own Claude Code sessions. The toggle applies from the next brain turn on any path — typed, scheduled, or event-woken — the conversation carries over, and a restart restores it.

### Changed

- **The orchestrator's guardrails moved into wmux itself — groundwork for connecting non-Claude brains.** Until now, "the orchestrator can't close panes or tear down workspaces" was enforced by options passed to the Claude SDK — a future non-Claude brain wouldn't have honored any of it. Three server-side layers now enforce the same contract for ANY brain runtime: the brain's tool catalog simply doesn't contain teardown tools (they're never registered, so no brain can call them), the pipe refuses teardown methods from a brain even if a future bug re-exposed one, and a brain whose session credential has gone stale has every request refused outright instead of being quietly demoted to a caller with wider powers. A brain is also confined to its own workspace when focusing panes, matching the existing terminal-routing confinement. No behavior change for today's Claude orchestrator or for regular agent panes — this is the security floor the upcoming "connect an agent" feature stands on.

- **Agent panes get ~50 MB lighter each — the browser engine now loads only when used.** Every agent pane (Claude Code, Codex, Gemini) runs a small wmux helper that exposes wmux's tools over MCP; it used to initialize the entire browser-automation library at startup, costing ~80 MB of private memory per pane whether or not the pane ever touched a browser tool. The library now ships as a separate lazy chunk that loads on the first `browser_*` call: an idle helper measures ~32 MB, and only panes that actually drive the browser pay the full cost. Nothing changes functionally — same tools, same behavior, pay for what you use.

- **Hidden panes stop rendering in the background — the CPU your invisible agents were burning comes back.** Until now, every pane in every workspace kept parsing its output byte-for-byte even while hidden behind another workspace: one busy hidden agent cost roughly a fifth of the render thread, so the app felt heavier the more workspaces you kept around. The optimization that pauses this (previously an experimental opt-in in Settings) is now **on by default**: while a pane is hidden, the daemon keeps capturing its output but the pane stops painting it — the process runs at full speed and no output is ever lost. What you may notice, once per long-hidden busy pane: **the first switch to it after updating may briefly catch up** — large backlogs restore from the daemon's snapshot, and the pane says so while it happens. That's the pane painting what it skipped, not missing output and not a regression. Daemon-backed sessions only; local-mode panes are untouched. If you'd rather pay the background CPU for always-instant reveals, one toggle in **Settings → Terminal** turns it back off — and that choice sticks permanently; no later update will flip it back on you.

- **The daemon goes quiet when you do.** At idle, wmux's background daemon used to burn a steady ~3% CPU and rewrite every session's recovery buffer to disk every 30 seconds even when nothing had changed. Four diets landed: the process-liveness sweep runs every 15 s instead of 5 s (one `tasklist` spawn per tick on Windows was the single biggest idle cost — the trade-off is that a supervised job's death is now detected within ~28 s worst case instead of ~13 s, and `wmux.json` restarts follow the same bound); recovery snapshots are **dirty-only** (a session with no new output since its last dump is skipped, with a forced dump every 10th tick as a freshness backstop — crash recovery guarantees are unchanged and the on-exit dump still always runs); per-pane metadata (cwd/branch/ports) is only re-broadcast when it actually changed, instead of every 5 s per pane; and the shell's working-directory signal is de-duplicated at the source, so an idle prompt no longer re-announces the same cwd on every redraw. Both cadences are now knobs in `~/.wmux/config.json` (`daemon.livenessIntervalSec`, `daemon.snapshotIntervalSec`) — see [docs/performance.md](docs/performance.md). Note for daemon changes generally: they apply on release-to-release upgrades; a manual revert needs a daemon restart (tray → Shut down wmux).

- **Agent torrents now reach the screen in batches, matching local mode.** Daemon-backed panes forwarded every pipe chunk to the renderer as its own IPC message; they now coalesce for 8 ms exactly like local-mode panes always have, cutting IPC wakeups under heavy output with no change to what you see — output still lands before any exit or restore marker, in order.

- **PID-reuse ghosts can't pin the daemon anymore.** If Windows recycled a watched process id onto an unrelated program, the daemon would count that ghost as a live session forever — blocking its own idle shutdown and holding the session's buffer in memory. The liveness sweep now remembers each process's image name and treats a PID that answers under a different name as the death it really is (confirmed by an independent re-probe before acting, and a probe failure still never counts as death).

- **A pane now tells you while it's catching up, and slow switches leave evidence.** A revealed pane with a large backlog shows a per-pane catching-up state instead of silently presenting stale content — what's on screen is either current or visibly refreshing. Every reveal also writes one `[wmux:reveal]` line with a mechanism code (`live` / `retained-catchup` / `dirty-snapshot` / `dirty-raw-fallback` / `resync-degraded`) to the on-disk logs, and `wmux doctor --performance` summarizes retention state, pane counts, and recent resync counters — so a "my pane looks frozen" report can arrive with its own diagnosis attached. The new [docs/performance.md](docs/performance.md) covers what keeps running while a pane is hidden, expected reveal behavior, the `~/.wmux/config.json` daemon knobs, and how to read those log lines.

### Fixed

- **macOS: three quality fixes for Mac users.** (1) **Top chrome no longer sits shifted-right in fullscreen** — the titlebar reserves 72px for the traffic-light buttons, but native fullscreen hides those buttons; the reserve now collapses on entering fullscreen and returns on exit (the same pattern VS Code and Hyper use). (2) **Pasting a file or folder copied from Finder is now instant** — resolving the real path used to shell out to AppleScript on every paste (hundreds of milliseconds, up to 2s); the path is now read straight off the pasteboard, with AppleScript kept only for the rare opaque-bookmark form, and plain-text pastes no longer pay a pasteboard format-enumeration tax either. (3) **Korean (and other composed-character) folder names no longer paste or display as broken jamo** — macOS hands out decomposed (NFD) strings for paths; wmux now normalizes them to the composed form at the paste and working-directory display boundaries, matching what VS Code does at its filesystem boundary. Execution semantics stay safe on APFS, which looks paths up normalization-insensitively.

## [3.24.1] — 2026-07-16

### Fixed

- **Typing no longer intermittently goes dead in a pane until you open a new one.** On some machines, keystrokes would sporadically stop reaching the terminal — you'd type and nothing happened, and the only way back was to split off a fresh pane. The cause was a focus tug-of-war: when the pane that should hold keyboard focus was momentarily off-screen (mid workspace-switch or a re-mounting terminal), the focus self-heal kept shoving focus at it, focus bounced straight back to nothing, and the loop spun — dropping the keystrokes caught in between. The self-heal now refuses to hand focus to a terminal that isn't actually visible and confirms focus truly landed before counting it as recovered, which breaks the loop. It also now records which element dropped focus, so any remaining cases name their own cause in the logs. (This is a distinct bug from the earlier IME "claim-storm" — the field logs ruled that out.)

## [3.24.0] — 2026-07-16

### Added

- **You can turn off "start wmux when Windows starts."** wmux registers itself to launch at login on install, but that was never optional — if you didn't want it running every boot, there was no switch. Settings → General now has a **Startup** toggle that flips it on or off live (it reads and writes the actual Windows startup entry, so it always reflects the real state). Turning it off sticks across app updates — an update no longer silently re-enables autostart behind your back. Windows only; the toggle is hidden on other platforms. (#460)

- **The orchestrator can pause and ask you a decision — and it waits, even across a restart.** When the orchestrator hits a fork it shouldn't settle on its own — an ambiguous requirement, a risky or irreversible step, a real choice between approaches — it can stop and put the question to you instead of guessing. Its working loop parks (it stops auto-advancing on agent events and scheduled ticks) and a "Decision needed" card appears in the Orchestrator thread, with your options or a free-text answer; the loop stays paused until you respond. The pending decision is saved to disk, so it survives closing and reopening wmux — come back later and the question is still waiting, and answering it resumes the orchestrator from exactly where it paused, with your answer handed to it. It's the orchestrator's own judgment to ask, not a new setting to configure.

- **The orchestrator now tells you when it hits a Claude rate limit.** When the orchestrator's own Claude session hits (or approaches) a subscription rate limit, an amber notice now appears in its conversation — naming the window (5-hour / 7-day), the account it's running on (if you've bound one), and roughly when the window resets. A hard limit reads "limit reached … new turns keep using this account until you switch"; approaching a limit is a quieter heads-up. It's read from a first-class signal the Claude SDK emits (not guessed from an error), attributed to the account the session actually launched on, and de-duplicated so a burst of retries doesn't spam the thread. This is the detection groundwork for account switching; the orchestrator doesn't switch accounts on its own yet.
- **Settings → Accounts now shows live usage per Claude account.** Each registered Claude account can display its 5-hour and 7-day quota utilization (e.g. `5h 42% · 7d 71%`) right next to its login badge, turning amber as a window crosses 80%. The number is read the moment a Claude turn ends in a pane bound to that account — not by polling on a clock — so idle accounts cost nothing and the reading is always the freshest one. It shares the existing opt-in usage toggle (off by default, since each refresh spends one small request against that account's quota), and a per-row ↻ button forces an on-demand refresh whenever you want the current number. Windows and Linux only (macOS stores Claude credentials in a shared keychain that can't be read per account); Codex accounts show login status only.

- **Every pane header now has quick action buttons.** The pane tab strip gained a small right-aligned cluster of four icon buttons — split right, split down, new browser, and maximize/zoom — so the actions that were previously keyboard-only (Ctrl+D, Ctrl+Shift+D, Ctrl+B Z) are now discoverable with the mouse, right next to the tabs and the close button. Each button drives the same store action the keyboard already does (no new behavior), carries a tooltip with its shortcut, and stays pinned to the right while the tabs scroll on narrow panes. The maximize button (divider-separated at the end of the cluster) shows a pressed/restore state while the pane is zoomed; it replaces the old hover-revealed corner maximize control, which used to overlap the cluster. The cluster can be hidden in Settings → Appearance → Layout for a minimal, keyboard-only chrome (default on) — hiding it restores the corner maximize control. (There is no header button for adding a second terminal to the same pane — one pane holds one terminal by design; Ctrl+T still adds a surface for power users.)
- **The OpenCode bridge now also flags approval prompts and ignores sub-agent chatter.** Building on the turn-completion signal, the OpenCode plugin now forwards a `permission.updated` (OpenCode asking to run something) as an "awaiting input" signal so the orchestrator can notice a pane blocked on an approval — debounced so an auto-approved permission (`"permission": "allow"`) that resolves instantly never raises a false alarm. It also only signals for the **root** session now: a sub-agent going idle no longer wakes the orchestrator, only the top-level turn does. Re-copy `integrations/opencode/plugins/wmux.js` to pick this up.

### Changed

- **The agent & channels panel now has an obvious toggle at the foot of the sidebar.** The control that reopens the right-side dock used to be a bare `#` glyph tucked into the far corner of the status bar — easy to miss once you'd collapsed the dock. It now lives at the bottom of the workspace list as a labeled **Agent** button (with a little robot icon), so getting the panel back is one clear click. Same toggle, same dock — just somewhere you can actually find it.

- **The orchestrator reads terminals on completion, not by polling.** Its guidance now says to rely on the automatic wake it gets when an agent finishes or pauses (rather than repeatedly reading a pane to check "is it done yet?"), to read the finished pane once, and to widen a read deliberately (larger `tail_lines`, then `full_scrollback`) only when the recent tail isn't enough to judge what happened. Fewer, cheaper reads — which is also what keeps the UI responsive while it works.
- **The interface now speaks two colors: warm means "alive", cool means "where you are".** Until now one amber did every job — running dots, links, focus, buttons — so nothing stood out. Each theme now splits its palette into a warm accent (things that are alive or need you: running dots, spinners, the terminal cursor, notification rings, unread badges — and the primary action button) and a quiet cool accent (things you navigate: links, jump arrows, the active tab underline, the focused pane edge, focus rings). Amber, Nightowl, Stars & Stripes and Taegeuk gained dedicated cool/warm counterparts; Catppuccin, Red Dynasty and Hinomaru already had two tones; Monochrome and Void stay deliberately colorless. A handful of latent mispaints came out in the wash — the browser loading dot, notification dots, the deck loop's running dot and the Git tab's current-worktree dot are all warm now, and running indicators no longer share a hue with warnings.

- **Buttons, inputs, menus and dialogs got a machined, modern finish.** Buttons now have a faint surface fill with a hairline edge and a subtle top highlight (and physically sink half a pixel when pressed); the important button on each surface is the one solid warm-accent fill; destructive actions are red-tinted until the final confirm. Inputs and the search bar are gently recessed and light up with a cool focus ring. Right-click menus float with soft shadows and rounded hover highlights, and paired view switches (like the editor's View/Edit) are proper segmented controls. This lands app-wide — toolbar, search, pane tabs, fan-out/rich-input/snippets dialogs, project trust and workspace profile dialogs, fleet cards, approvals, deck panels, first-run wizard.

- **The theme picker shows real miniature previews.** Instead of four abstract dots, every theme card is now a tiny mock of the app rendered in that theme's actual palette — background layers, accent glow, status dots — so you can see a theme before switching. The Custom card finally reflects your real custom colors as you edit them (it used to show a frozen sample palette forever).

- **The orchestrator's control bar is just the controls now.** The chip row above the orchestrator composer dropped the two canned-prompt buttons ("Agent status" and "PR status") — those were prewritten questions you can just type yourself — leaving the three controls that actually belong there: the agent mode, the loop, and schedules. Mode (the master off/manual/assist/orchestrate switch) now anchors the left, set off by a hairline from the two automations it governs, and the one-click fleet-recovery chip still appears on the right after a reboot when there are agents to bring back.

### Fixed

- **The `wmux` command now actually installs, so you can call it from any shell after installing.** The installer was supposed to drop a `wmux` shim into a folder on your PATH so `wmux …` works in any terminal, but on packaged builds that step silently never ran: the code that installs (and uninstalls) the shim was loaded through a dynamic `require` that the production bundler leaves unresolved, so it threw behind a best-effort `catch` and did nothing — no shim, no PATH entry, no error you'd ever see. The loader is now bundled correctly, so install/update creates the shim and uninstall removes it as intended. (Same root cause as the Windows-startup registration; a leftover shutdown-time flush was quietly failing the same way and is fixed too.) (#463)
- **"Task finished" alarms are trustworthy now: the completion hook is the boss, the screen-reader is the backstop.** The two chronic alarm complaints — an agent finishes and *nothing* fires, or an alarm fires while the agent is *still working* — traced to one inversion: wmux treated its screen-scraping heuristics as the primary signal and the agent's own completion hook as a bonus. Claude Code's status footer ("bypass permissions on", "shift+tab to cycle") is visible **mid-turn**, so every workspace switch or pane resize that repainted the TUI could re-match it and fire a stale "Ready for input" — and that false alarm also pre-claimed the internal dedup ledger, so when the real Stop hook arrived seconds later it was swallowed as a duplicate and the true completion went silent. Now, while a pane's hook bridge is alive for an agent, that agent's hook signals are canonical: the screen heuristics stop raising notifications there entirely (they still drive the sidebar status dot), and they remain fully active for agents with no hook installed. Redraw bursts right after a resize also no longer reset the "already alerted" memory, so hookless agents stop re-alerting on workspace switches too. The Claude bridge additionally reports per-tool-call activity now, so background panes read as "running" during long turns instead of drifting to idle.
- **Finished-agent alarms now reach you when you're not looking — including as a native Windows toast.** Two over-eager suppression rules could combine into total silence: the in-app layer skipped *everything* (badge included) whenever the finishing pane was the "active" one — even if the wmux window itself wasn't focused because you were on another monitor — and the OS-toast layer skipped whenever *any* wmux window had focus, no matter which pane you were watching. Suppression is now a single decision with full context: a notification is skipped only when you are *actually watching that pane* (it's the active surface AND the window has OS focus). Otherwise everything fans out — and when the window is unfocused, that now includes a native OS toast for **every** notification source; hook-reported completions (the common case on current Claude Code) previously never produced one at all. Muting a workspace now genuinely silences its OS toasts too, and the one toast toggle in Settings governs both the in-app and native variants as it always claimed to.
- **Clicking any alarm now jumps to the terminal that raised it.** The OS toast already did this; the other two surfaces didn't. Rows in the bell panel used to switch workspace at best — they now activate the exact workspace, pane and tab (with zoom handled), even if the terminal process has since restarted, via the surface id stored on every notification. The transient corner toast wasn't clickable at all — its text is now a click-through to the same jump. One contract everywhere: see an alarm, click it, land on the pane.
- **Claude Code's text no longer occasionally renders unreadably dark on dark themes (Amber and others).** Claude Code (and some other CLI tools) style parts of their own output using explicit 24-bit RGB colors rather than picking from the terminal's 16-color palette — mostly harmless, except when that RGB color happens to be a near-black gray: on a dark theme, that renders almost exactly the same shade as the background, so the text is there but effectively invisible. (The mirror-image bug — literal white text vanishing on light themes like Hinomaru — was already fixed for the same reason.) The terminal now auto-brightens a foreground color when it's too close to its background to read, on every theme, dark or light; the floor is deliberately gentle on dark themes so genuinely-subtle dimmed text (comments, timestamps, secondary labels) keeps its muted look rather than getting flattened to full brightness.
- **Picking a built-in theme and "customizing from" that same theme now render identically.** The built-in themes were drawn from two hand-maintained sources — a token table in `themes.ts` and the shipped CSS — that had quietly drifted, so a few themes looked different as a built-in than as a custom copy of themselves: Catppuccin's cursor and muted text, and Red Dynasty's / Hinomaru's link blue, were the visible cases. The token table is now the single source those built-in palettes are derived from, byte-for-byte, and a test locks the two together so they can't drift again. No theme's on-screen appearance changes.

- **Starting a loop now actually starts it.** Clicking "Start a loop" (or resuming a paused one) used to just write the loop down and then wait — the orchestrator only woke on the next agent event or scheduled tick, so with the default "Events only" cadence and no agent already churning, nothing happened at all: the loop sat at "running" while the orchestrator stayed silent. Now starting or resuming a loop immediately kicks off the first iteration — the orchestrator takes a turn right away, sizes up the fleet against your objective, and takes the first step — and its own action produces the activity that wakes it for the next iteration, so the loop keeps going on its own.
- **Orchestrator mode stays smooth even while it observes a busy fleet.** Reading a pane's text (`terminal_read`) used to walk the terminal's *entire* backlog — up to 10,000 lines — synchronously on the render thread, every call, and an explicit line cap only trimmed the result *after* the full walk. The orchestrator reads panes in bursts, so those reads pinned the render thread and starved typing, switching, and paint — the "everything lags when the orchestrator is working, especially when it's reading terminals" symptom. Now a read returns a bounded recent tail by default (read in proportion to the lines returned, not the whole scrollback), an explicit `tail_lines` is genuinely cheap, and the full backlog is an opt-in (`full_scrollback`) for the rare case the tail isn't enough. A 10,000-line pane now costs the same to read as a fresh one.
- **The orchestrator now knows when an OpenCode agent finishes a turn.** The orchestrator wakes on agents' completion signals; Claude Code and Codex send them (hook / notify bridges), but OpenCode had no bridge, and its full-screen TUI matches none of the fallback detectors — so work handed to an OpenCode pane looked like it never finished. A new OpenCode plugin (`integrations/opencode/`) forwards OpenCode's `session.idle` event to wmux as a completion signal, on the same deterministic path Claude and Codex use. Install it from `integrations/opencode/README.md`.
- **First-run onboarding shows real text, and the sample task launches Claude instead of pasting into PowerShell.** On a fresh install the welcome tour printed its internal key names (`onboarding.step1.title` and friends) instead of copy — its five steps referenced translation strings that were never added, so each one fell through to showing its own key. They read as intended now ("Your terminal", "Add a workspace", and so on). Separately, "Try sample task" splits the window into a 2×2 grid and types a command into the top-left pane to show Claude working — but that pane is a plain shell, and PowerShell's own prompt-ready signal was mistaken for Claude's, so the bare prompt ran as a shell command and the text just landed in the PowerShell session. It now runs `claude` with the sample prompt, so Claude actually opens and performs the sample web search.

## [3.23.0] — 2026-07-14

### Changed

- **Settings categories reorganized so General isn't a catch-all.** The old General tab mixed language, terminal behavior, A2A, agent toolbar, MCP, updates, tutorial, and reset all in one place. Now: **General** keeps just language/updates/tutorial/reset; a new **Terminal** tab holds shell, startup directory, split cwd, IME guard, hidden-pane retention, and scrollback; a new **Agents** tab groups the orchestrator model/auto-wake, A2A execution, the agent toolbar, and MCP together (the orchestrator settings moved out of Claude integration, which now focuses on the plugin, usage meter, and accounts). First-run setup folded into About.
- **Settings opens full-bleed instead of a small floating dialog.** The Settings panel now fills the whole area under the titlebar — no dim scrim, no rounded floating card — so it reads as an app screen rather than a modal stacked on top of your terminals. Content stays centered at a readable width so full-width doesn't stretch every toggle description across the screen.

### Added

- **Manage multiple AI subscription accounts as first-class, and bind one per workspace.** If you keep more than one Claude (or Codex) subscription — a work seat and a personal Max, say — you no longer hand-edit `CLAUDE_CONFIG_DIR` into a profile. Settings → Claude Integration → Accounts lets you add named accounts through a guided flow: it provisions an isolated config directory (your MCP servers, skills, and plugins are shared from your default account so you don't reinstall anything; only the login stays separate), hands you a one-line command to log in there, and registers the account automatically once login lands — wmux never sees or stores your token. Then right-click any workspace → *Claude account* / *Codex account* to bind an account to it: new terminals in that workspace launch on that account (a manually set `CLAUDE_CONFIG_DIR` in the workspace profile still wins). Binding applies to newly opened terminals; already-running ones keep the account they started with. Windows and Linux (macOS reads its credential from the keychain, which can't be partitioned per account).

- **Give each agent a role, and the orchestrator routes work by it.** Every agent in the Fleet roster (the orchestrator's Orchestrator tab) now has a small role dropdown — Builder, Reviewer, Tester, or Planner. Pick one and the orchestrator sees it in its workspace snapshot and prefers to send matching work to the matching pane (build work to a Builder, reviews to a Reviewer) instead of spawning a fresh pane for it. It is a preference, not a lock: an explicit instruction from you always wins, and the orchestrator falls back to any pane when none fits. Roles persist with the pane and are the operator's to set — the orchestrator reads them but never changes them. A role only matters on a pane that is actually running an agent; setting one on a plain shell is harmless and simply inert until an agent runs there.

## [3.22.0] — 2026-07-13

### Fixed

- **Typing and switching stay smooth even when several terminals are actively producing output.** Before, a visible terminal's output was handed to the screen immediately with no shared budget — so when multiple visible panes (a split, or a workspace with several terminals) were all streaming at once (agents printing, logs tailing), they competed for the renderer thread and starved keystrokes and workspace switches. The result was lag exactly when terminals were busy, and smoothness when they were idle. Now only keystroke echo and input-driven redraws keep the zero-latency immediate path (via a short interactive window right after you type); streaming output with no recent input is coordinated through the shared output scheduler under an 8ms frame budget with a higher catch-up rate, so no busy terminal can pin the renderer. Byte order and total output are unchanged.

- **Switching between workspaces is smooth again, even with many open.** v3.21.3 stopped terminal churn from re-rendering the whole app, but *switching* workspaces was a separate path it didn't cover: every switch still re-rendered the entire ~1300-line window chrome (titlebar, sidebar, dock, toolbar). The direct cause was subtle — the chrome no longer subscribed to the active-workspace id directly, but a focus hook it hosted did (to move keyboard focus onto the newly active pane), and that hook re-rendering dragged the whole chrome with it. Measured on a live 5-workspace app: the chrome re-rendered on 12/12 switches before, 0/12 after. Now a switch only re-renders the pane viewport (which genuinely changed) and two tiny logic-only components, never the chrome. Focus-follows-switch and empty-pane shell auto-creation are unchanged (verified 5/5).

- **Big responsiveness fix with several workspaces open: switching and typing are smooth again.** With more than one workspace open, any small status update on one terminal (its title, working directory, or "running" indicator changing) re-rendered the *entire* app, plus every open workspace's terminal view, not just the one that changed. Since those updates fire constantly while a terminal is active, the cost piled up in direct proportion to how many workspaces you had open, so five workspaces felt roughly five times heavier than one, and even switching between them dragged. On a live 5-workspace app a single title change was pushing CPU past 50%, half of it React re-rendering the whole window chrome. This is fixed on two levels: each workspace's panes only re-render when that workspace actually changes, and the main window chrome (titlebar, sidebar, dock, toolbar) no longer re-renders on terminal churn at all. Now an update only touches the workspace it affects.

### Changed

- **Agents no longer run a helper process on every single tool call.** The Claude integration used to fire a small background process after each tool use, only to keep the "running" dot lit in the fleet view — on a tool-heavy turn that added up to seconds of overhead per turn and a lot of process churn. The running dots now come from the daemon watching each pane's output directly (which it already did), so background agents still show as working with zero per-tool overhead. One tradeoff: the fleet card's one-line "what tool just ran" label goes away for Claude (the daemon can't see the tool name), falling back to the terminal's last line instead. Existing installs pick this up when the plugin/hooks are next updated.

## [3.21.2] — 2026-07-13

### Added

- **Per-workspace agent modes — one knob for how autonomous the agent is.** Each workspace gets a mode chip (next to the loop and schedule chips) with four levels. **Off**: no autonomy at all, and it stops any running loop and schedule for that workspace (you can still type to it). **Manual**: replies only when you type, never wakes itself on agent events. **Assist** (the default): wakes only when a pane is actually blocked waiting for input, or to drive a loop you started — a plain "a turn finished" no longer triggers a summary, which is the token-burning spam this removes. **Orchestrate**: wakes on every agent event and may drive panes and press approvals. The current mode is always visible, so "why is it quiet?" and "why is it talking?" are both answered on screen. The global auto-wake switch from 3.21.1 stays as a master override on top of the per-workspace modes.

### Changed

- **The default agent posture is now "assist with a value filter" instead of "summarize every turn".** Existing workspaces that had the old report-on-every-event default move to assist, so the summary spam stops for them too without losing useful wakes (you still get pinged when a pane needs input). Stopping or pausing a loop now returns the agent to its workspace mode's baseline rather than a fixed floor.

## [3.21.1] — 2026-07-13

### Added

- **Auto-wake is now a switch you own.** The orchestrator's event-push wakes (the automatic "here's what your agents just did" summaries) each spend a real model turn — and until now there was no way to turn them off. Settings grows an "Auto-wake on pane events" toggle: switch it off and unrequested summary turns stop entirely, saving the tokens. Loops are unaffected — a running loop keeps waking through its own iteration budget, because you explicitly started it. The switch lives next to the orchestrator's other settings and applies immediately, no restart needed.

### Fixed

- **The new-workspace layout menu opens under the + button again — not across the window.** Since the + button moved into the titlebar, its layout dropdown (Empty / Horizontal Split / …) kept its old sidebar anchoring and opened at the far right edge of the window, floating over the orchestrator dock. It now anchors directly beneath the + button, clamped to stay inside the window.

- **The orchestrator no longer re-fires your own hooks on every tool call — a major source of background CPU churn.** The orchestrator's turns silently loaded your user-level Claude settings, including the wmux plugin's own hooks — so each tool call inside an orchestrator turn spawned an extra bridge process (~110ms of CPU each), and the orchestrator's turn-end looked like a phantom agent event. With auto-wake summaries running, this compounded into a steady process storm that could make the whole app stutter. Orchestrator turns now load no filesystem settings at all; their behavior was always defined explicitly in code, so nothing else changes.

### Changed

- **Korean UI: "오케스트레이터" is now just "agent".** The transliterated word overflowed tabs and labels; the Korean locale now uses the untranslated term "agent" everywhere the orchestrator is named (pane agents remain "에이전트").

## [3.21.0] — 2026-07-13

### Added

- **The loop setup grew into a real editor — in a dialog that actually fits, with steps that can pick from your agent's skills.** "Start a loop" now opens a proper setup dialog instead of a cramped inline form (whose Start button could overflow right off the dock at narrow widths — that's fixed by design now). The dialog adds a third axis to a loop: alongside the objective (why) and the done-when checklist (when to stop), you can now write **steps** — the procedure the orchestrator should follow on each iteration. Type `/` in a step and it autocompletes from your project's and your user-level Claude skills and commands (`.claude/skills`, `.claude/commands`), with project entries shadowing user ones — running a skill step means the orchestrator types that command into the pane, same as you would. Steps ride into every loop turn as numbered, trusted context, and loops saved before this release keep working unchanged. The dock keeps only the compact status card once a loop runs.

- **GitLab works in the Git tab too — including your company's self-hosted instance.** The Pull Requests section now speaks both hosts: repos with a GitHub origin keep using `gh`, and any other origin (gitlab.com or a self-hosted GitLab like `gitlab.yourcompany.com`) routes through the GitLab CLI (`glab`). Merge requests list with draft/merged state and freshness, expanding one shows its discussion (system noise like "added 1 commit" filtered out), and authentication is checked per host — if `glab` isn't logged into that instance, the section tells you the exact `glab auth login --hostname …` to run. One caveat v1: CI status dots are GitHub-only for now (GitLab's list API doesn't carry pipeline rollups).

- **Ask the orchestrator about any hunk — straight from the diff view.** Every hunk in the diff surface (task review and workspace diff alike) gets an **Ask** action: type your question and it lands in the orchestrator's chat as one message with the hunk's repo, branch, file, header, and body attached as fenced data — so the question and its evidence live together in the transcript, and the deck flips to the Orchestrator tab so you watch the answer stream in. Oversized hunks attach paths and header only (never a silently half-cut diff).

- **Pull requests and their comments, live in the Git tab — no more alt-tabbing to the browser to see if review feedback landed.** The Git tab grows a Pull Requests section listing every open PR of the repo behind your active pane: CI status at a glance (green/red/pending dot), draft/merged state, review decision, and how fresh it is. Expand a PR to read its comments and reviews (markdown rendered, approvals and change-requests labeled) — refreshed roughly every 30 seconds while the tab is open, with a manual refresh when you can't wait. Everything deep-links to the browser in one click. Works through the GitHub CLI you already have; if `gh` is missing or logged out the section says exactly that (and GitLab is a planned provider, not a dead end).

- **A Git tab in the right dock: see, create, open, and remove worktrees without leaving the keyboard.** The Command Deck grows a Git tab (next to Orchestrator) showing every worktree of the repo behind your active pane — branch, folder, and whether it's locked or stale. Type a branch name to spin up a new worktree in a sibling `<repo>-worktrees/` folder (the convention you'd use by hand), click **Open** to drop it into a fresh workspace with its terminal already there, and **Remove** when you're done — git itself refuses to remove a dirty worktree and the tab tells you why, so you can't lose uncommitted work (there is deliberately no force option). Hide the tab in Settings if you want minimal chrome.

- **See what changed in any workspace — a read-only git diff view, one palette command away.** "Show Git Diff" in the command palette opens a diff tab for the repo behind your active pane: every staged, unstaged, and untracked change against HEAD, with the same file tree and unified diff view the task-review surface already uses. It's deliberately read-only — no editing, no hunk adoption, no syntax-highlighting IDE creep — and refreshes each time you come back to the tab (plus a manual Reload). Works from a subdirectory (the repo root is resolved for you), from linked worktrees, and survives a restart like any other tab. Non-git panes get a polite toast instead of an error.
- **The loop setup grew into a real editor — in a dialog that actually fits, with steps that can pick from your agent's skills.** "Start a loop" now opens a proper setup dialog instead of a cramped inline form (whose Start button could overflow right off the dock at narrow widths — that's fixed by design now). The dialog adds a third axis to a loop: alongside the objective (why) and the done-when checklist (when to stop), you can now write **steps** — the procedure the orchestrator should follow on each iteration. Type `/` in a step and it autocompletes from your project's and your user-level Claude skills and commands (`.claude/skills`, `.claude/commands`), with project entries shadowing user ones — running a skill step means the orchestrator types that command into the pane, same as you would. Steps ride into every loop turn as numbered, trusted context, and loops saved before this release keep working unchanged. The dock keeps only the compact status card once a loop runs.

- **The orchestrator now wakes itself when your agents finish or get stuck — no more polling, no more "is it done yet?".** Previously the orchestrator only learned what your agents were doing when you typed something (or a schedule fired) and it went looking. Now the moment an agent finishes its turn or blocks on an approval prompt, that event wakes the workspace's orchestrator into a fresh turn that reports what happened. It's bounded and safe by default: a per-workspace budget caps consecutive auto-wakes (typing anything resets it), rapid events coalesce into one wake instead of a storm, and out of the box the woken orchestrator only *reports* — it touches nothing. Per-workspace settings can additionally allow it to send follow-up instructions to panes; pressing approval prompts on your behalf is not offered in this release. Terminal-derived event text is fenced as untrusted data so pane output can't smuggle instructions to the orchestrator.

- **Start a loop: one click puts a workspace's orchestrator on an objective, and it keeps working toward it.** New "Start a loop" control in the orchestrator panel: give it an objective ("keep CI green on this branch"), optionally a done-when checklist and a check-in cadence ("also check every 30 min"), pick how much autonomy it gets (Report only / Continue), and start. From then on every orchestrator turn — woken by an agent event, fired by the cadence, or typed by you — carries the loop's objective, checklist, and recent progress, so the orchestrator always knows what it's driving toward, even across app restarts (the loop lives in a file, not a conversation). Stopping or pausing the loop is one click and fails closed: autonomy drops back to report-only and the cadence schedule is cleaned up, so a stopped loop never leaves a self-driving orchestrator behind. Progress is visible where you'd look: the loop chip counts checklist items passing, the status card shows the live auto-wake budget ("wake 7/25") and lets you tick done-when items off yourself (the orchestrator never self-scores its own homework), and auto-woken turns render as a compact "woken by agent events" marker with expandable details instead of a wall of machine text in the chat. (Concept adopted, with attribution, from the MIT-licensed "Ralph" loop technique and the loop-engineering pattern family — LangGraph, OpenAI Agents SDK.)

### Fixed

- **Quitting no longer permanently freezes wmux (macOS).** If any step in the quit teardown (daemon disconnect, tray/pipe cleanup, etc.) threw, the app got stuck with zero windows and stopped responding to the Dock icon, relaunching, or `⌘⇥`-style activation — the only fix was `kill -9`. The teardown is now wrapped so a failure in one step can't block the rest of quitting.
- **The hairline across the top of the window now lines up.** The pane tab strip's bottom border used a slightly different (more opaque) tone than the deck tabs beside it, and sat 1px lower — so the thin line under the tabs looked like it changed color and broke where the terminal meets the orchestrator panel. Both now share the same soft hairline at the same height (and a redundant double-line under each pane's top edge is gone); the focused pane still gets its amber underline on top.

- **When the orchestrator types an instruction into an agent's pane, Enter now actually gets pressed.** Sending a longer instruction to a CLI running in a pane (Claude Code's input box, for example) could leave the text sitting in the composer, unsent — the terminal read the text and its trailing Enter as one pasted block, so the newline landed as a soft line-break instead of submitting, and your command just sat there until something pressed Enter for it. The orchestrator now sends the text and the Enter as two separate writes, so even a long instruction submits the first time.

- **The orchestrator can address agents by task again.** Delegating an A2A task from the orchestrator failed with "Workspace identity unknown" — its tools couldn't tell which workspace it spoke for, because the orchestrator runs as the workspace's brain rather than inside a terminal pane, so the usual pane-based identity lookup found nothing. It now resolves its own home workspace, so handing a task to an agent works instead of erroring out.

### Changed

- **Color-discipline pass across the shell: one amber, and it only ever means "here."** The status lights now speak one consistent language everywhere (sidebar, pane tabs, Fleet roster): amber = running, green = done, **red = needs you** (this last one was wrongly amber before), gray = idle — and a running agent is no longer the same green as a finished one. Amber stopped leaking onto things that aren't "live or focused": notification/unread counts, the git-branch glyph, the orchestrator's name label, fan-out and reply chips, and the reboot "resume" pill are all quiet now, with the accent appearing on hover instead. A couple of stray emoji in the chrome (the 🔔 on a workspace's last-notification line, the ⚙ settings button) became crisp monochrome icons, and popover corners were tightened to match the design system. The result is calmer: on a busy multi-agent screen, the few amber marks left are the ones that actually tell you where to look.

### Fixed

- **The orchestrator chat now behaves like a chat.** Pressing Enter clears the composer instantly and your message appears in the thread right away — previously the typed text sat locked in the input box until the orchestrator finished its entire turn (the send call only resolves when the turn ends). And the thread now sticks to the newest message: it auto-scrolls as replies stream in, stays put if you've scrolled up to read history, and snaps back to the bottom when you return or switch workspaces.

- **The Orchestrator can no longer fake "your agent is running" — launching an agent now means a real CLI in a real pane.** Asked to start Claude in bypass mode, the orchestrator could previously spin up an internal side-conversation (a built-in subagent tool that slipped past the permission system), report the agent as running, and even type a fake ready-prompt into an empty terminal. Those built-in subagent tools are now hard-disabled for the orchestrator — along with its own shell and file tools, which the permission system was already blocking, now made structural — and it is explicitly instructed that launching an agent means typing the agent's actual command (e.g. `claude --dangerously-skip-permissions`) into a real pane and confirming it started. An agent either really runs in a pane, or the orchestrator says plainly that it doesn't.

- **The sidebar workspace light now actually tells the truth about your agents — and the nagging "task may have finished" popups are gone.** The little status dot on each workspace row used to read only the *active* pane's state and never self-corrected, so an agent waiting for you in a background split, or one that finished while you were looking elsewhere, left the dot wrong or dark. It now reflects the whole workspace — the most urgent state across every pane — the same source that powers the Fleet roster and the titlebar "N running / N need you" chips, so all three finally agree. Separately, the toast that fired "Task may have finished / output stopped after active period" whenever any terminal went quiet for a few seconds is removed: it fired mid-turn (while an agent was just running a tool or a web search) and even for plain shell commands. Genuine completions still notify precisely (the Claude Code Stop hook fires once when a turn really ends); the reliable dot carries everything else, quietly. And "running" is now driven by the agent's actual tool activity, not just terminal output: an agent that goes quiet while it thinks mid-turn (or runs a long tool with no output) stays lit as running instead of falsely dropping to idle after a few seconds — the light only settles once the turn genuinely ends or the agent has been silent for a couple of minutes. This also means an agent working in a background split now lights its workspace, not only the one you're looking at.

### Added

- **Your orchestrator's model is now visible — and switchable — right in its header.** A small chip next to the Orchestrator name shows which model the brain is running (Default / Opus 4.8 / Sonnet 5 / Haiku 4.5); click it for an inline picker to switch, applied on the next turn, without opening Settings. And the deck header gains a collapse button, so you can fold the whole orchestrator/channels dock away and give your terminals the full width from the tab you're actually on — reopen it from the status bar toggle as before.

- **The Orchestrator can now write down what it learns — memory that survives reboots.** Beyond reading the memory files you seed, the orchestrator can now persist durable facts itself: when it learns something worth keeping — an operator preference, a project convention, a standing instruction, a mistake worth not repeating — it saves a small markdown file to its memory. Writing is strictly sandboxed to its own memory folders (the shared `memory/_global/` and its workspace's `memory/<workspaceId>/`) and to `.md` files only — it cannot write anywhere else on disk, and its shell and file-editing tools stay disabled. Workspace-specific facts land in that workspace's partition; operator-wide facts in the shared one. Like the seeded files, what it writes survives reboots and app updates.

- **Teach your Orchestrator durable facts — memory that survives reboots.** Drop markdown files into `<wmux data dir>/memory/_global/` and the orchestrator reads them at the start of its first turn: who you are, project conventions, standing instructions — anything you're tired of re-explaining every session. The memory rides along within a token budget (truncation is always announced, never silent), a broken file can never break a live turn, and because it's plain files on disk it survives reboots and app updates. Memory is framed to the model as background context, not instructions, so a fact file can't be used to smuggle in commands.

- **Per-project memory: each workspace's Orchestrator now has its own memory partition.** Alongside the shared `memory/_global/` store, drop markdown files into `<wmux data dir>/memory/<workspaceId>/` and only that workspace's orchestrator reads them — layered on top of the global memory so project-specific facts stay with their project instead of bleeding into every workspace. Both partitions share one token budget (truncation still announced, never silent), the files still survive reboots and app updates, and a broken file in either partition can never break a live turn.

- **The Orchestrator now speaks wmux natively.** It knows what a workspace, pane, and surface are — the words you actually use — instead of asking "what is a workspace?". It also understands that permission/bypass modes are a legitimate wmux feature: asking it to run agents in bypass mode gets a straight answer (or honest "the spawn tool can't set that yet — here's how to do it yourself") instead of a refusal on security grounds.

- **Mission control: your agents, the orchestrator, and their vitals now live in one place.** The Orchestrator tab opens with a **Fleet roster** pinned above the thread — one row per live terminal pane showing a status dot (amber running, red needs-input, gray idle), the pane's name, and what it's doing right now (the same hook-driven activity line the cockpit cards use); click any row to jump straight to that pane. And the window frame itself now carries the fleet's vitals: when agents are actually working, an amber "N running" chip appears in the titlebar's status area, and an agent blocked on you shows a red "N need you" chip — visible from any workspace, any tab, and one click jumps to the most urgent pane. When nothing needs attention, the chips disappear entirely — no dead gauges.

- **wmux finally looks like an app, not a webpage in an OS window.** The native File/Edit menu strip is gone (Alt still reveals it, every shortcut keeps working) and the window opens with a slim custom titlebar instead: the app mark and current workspace name on the left — tinted to fuse with the sidebar below it — an empty center you can grab anywhere to drag the window, and the native Windows minimize/maximize/close buttons drawn right on top (snap layouts and all), restyled to the active theme so they never clash. The window's first paint also matches the amber theme's dark graphite, so launching no longer flashes a foreign color. The status strip moved into the titlebar too — branch, channels toggle, notification bell, memory, clock, and the settings gear now sit at the top-right of the window frame instead of on their own separate row, so there's one less strip of chrome between you and your terminals. This is the first slice of the Bridge redesign (see the new `DESIGN.md` for the full design system it establishes).

- **Schedule your Orchestrator — and the schedules survive reboots.** The Orchestrator tab grows a **Schedules** chip next to the quick actions: give it a prompt ("check my PRs and summarize what needs me"), a first run time, and an optional repeat (30 min / hourly / 6 hours / daily), and the orchestrator runs it on time as a normal turn in the same thread — visibly, with its usual tool chips. Schedules persist on disk, so a reboot doesn't lose them: when wmux comes back, anything that came due while the machine was off fires once (no catch-up storm — a repeating schedule that missed ten slots runs once and re-arms at the next future slot). A schedule that comes due while you're mid-command politely waits its turn and retries. One-shots stay listed after firing so you can re-arm or delete them; Pause/Resume and Delete are one click.

- **Pick the model your Orchestrator runs on.** Settings → Claude integration grows an **Orchestrator model** picker: Default (your subscription's model), Opus, Sonnet, or Haiku. Changes apply from your next command — no restart, and the conversation carries over (the orchestrator resumes the same thread on the new model). The value is sanitized before it ever reaches the underlying CLI, and a change made while a command is running never interrupts it: the new model takes over on the next turn.

- **Quick-action chips above the Orchestrator composer: the commands you run ten times a day are now one click.** The Orchestrator tab grows a small row of chips right above the composer — **Agent status** asks the orchestrator to read every agent pane's screen and report, per pane, what it's working on and whether it needs your attention; **PR status** has it check your open pull requests (the orchestrator has no shell of its own, so it delegates — it runs `gh pr status` through one of your panes and reads the result back, keeping the evidence in a terminal you can jump to); and after a reboot a **Recover agents** chip appears alongside the greeting card, so the one-click recovery stays reachable even if you dismissed the card. Chips disable while a turn is streaming, same as the composer.

- **One click brings all your agents back after a reboot.** When wmux comes back up after a reboot (or any shutdown that interrupted running agents), the Orchestrator tab now greets you with a recovery card: "*N* agent panes were running before the last shutdown and can be recovered", listing the panes. One click on **Recover agents** hands the orchestrator a precise per-pane recovery plan — it types each pane's exact resume command (`claude --resume <session>` when the original conversation is known, the safe fallback otherwise), restores each agent's recorded permission mode (a `--dangerously-skip-permissions` setup comes back in bypass mode, not stuck on prompts — your click on the button is the explicit consent), confirms each agent came back, and reports what every one of them was working on. Typing "recover my agents" into the composer works too. The per-pane resume pills are still there if you prefer to bring agents back one at a time.

- **The Orchestrator now remembers your conversation across app restarts.** Closing wmux (or rebooting) no longer wipes the orchestrator's memory: its session is persisted on disk, and the next time you send it a message it resumes the same conversation — everything you told it, what it did with your agents, and how it named things all carry over. Its session storage is also pinned to a stable location, so updating wmux to a new version doesn't break the thread either. If the saved session can't be resumed (e.g. its transcript was cleaned up on the Claude side), the orchestrator quietly starts a fresh conversation instead of erroring on every message.

- **The Orchestrator tab now has a brain: tell it what you want and it runs your agents for you.** The Command Deck's Orchestrator tab is no longer only a fan-out composer — write a plain message with *no* `@`-mention and it goes to an orchestrator that can see all your agents and act on them: it lists and reads your panes, spawns new ones, sends them instructions, and coordinates them over channels/A2A, then streams a running summary back into the thread. Its prose streams in live, and every tool it uses shows up as a chip (green when it succeeded, red when it failed) — chips that touched a specific pane are clickable, so one click jumps you straight to the evidence. A **Stop** button interrupts a turn mid-flight. The orchestrator runs on your Claude subscription (no API key needed) and drives your agents through the same wmux tools any agent gets, so wmux itself holds no orchestration policy — the model does. `@`-mentioning panes still does the direct Phase 1 fan-out exactly as before. (This first cut can spawn and drive panes but not close them — cleanup stays a manual step for now; inline approval for destructive actions was still to come at this point.)

- **The right dock is now a Command Deck: command all your agents from one thread instead of typing pane-to-pane.** The dock opens on a new **Orchestrator** tab (the channel list moved one tab over to **Channels**). There you write one message, `@`-mention as many agent panes as you want — the same autocomplete the channel composer uses, so `@` lists every live agent pane across all your workspaces — and hit send. The message fans out to every mentioned pane at once (delivered by the existing plumbing: a running Claude pane gets it immediately, others on their next turn), and each pane's reply lands back in the *same* thread, grouped under the message you sent — no more clicking into each terminal to type the same thing and hunting for answers. The dispatch shows a chip per targeted pane and each reply's author is clickable, so one click jumps you to that pane. Under the hood it's an ordinary private `#commander` channel (it also appears in the Channels tab), so its history is durable and survives restarts like any other channel.

- **Private agent channels now show up in your dock automatically, read-only (operator observation).** A private channel that agents create among themselves used to be invisible to you until you explicitly went looking for it under "All channels" and joined. Now every such channel appears in your normal channel list the moment it's created — tagged with a small "observed" badge — and you can read its full history and watch new messages arrive live, without joining. It stays read-only: the composer is replaced by a "You're observing this channel (read-only)" note with a **Join** button, so speaking or appearing in the roster still takes a deliberate join (which, as before, leaves a visible record in the channel). Public channels were already fully watchable, so this only widens visibility of *private* channels, and only to you (the local human operator) — agents cannot obtain this view: alongside this change, a pipe/MCP client that merely *claims* the human's identity on channel reads is now rejected outright (previously such a claim could read the channels the human was a member of), so the observer view is reachable only from the app itself.

### Changed

- **The Channels tab now stays out of your way — hidden by default, one Settings toggle away.** With the orchestrator as the single interface, the human channel UI earns its screen space only when you actually want to inspect raw agent messages. The dock now opens with just the Orchestrator tab; flip **Settings → Orchestrator → Show Channels tab** to bring the classic channel list + conversation back (it returns exactly as it was, unread counts and all). Nothing behind the scenes changes either way: agents keep talking to each other over channels, the orchestrator keeps coordinating through them, and @-mention fan-out keeps working — this only hides the viewer.

- **The Orchestrator's replies now render as formatted text instead of raw markdown.** Headings, bullet and numbered lists, **bold**/*italic*, inline `code`, fenced code blocks, and links all display properly in the chat bubble (links show their URL on hover and never navigate). Your own messages stay exactly as you typed them. The renderer is a small built-in subset — model prose never touches an HTML pipeline, so there's no injection surface.

- **Every workspace now gets its own Orchestrator — "my assistant per project" instead of one assistant for the whole app.** The Orchestrator tab is now bound to the active workspace: switching workspace tabs switches the conversation, and each workspace's thread (and its resumed session) is its own — project talk no longer mixes. The big everyday win is parallelism: while one workspace's orchestrator is deep in a long turn, every other workspace's composer stays open and answers immediately — no more "a command is already running" because a *different* project was busy. Each orchestrator can also only see and drive the panes of its own workspace (other workspaces appear by name only), so a misjudging orchestrator is structurally confined to its own project. Schedules now belong to the workspace they were created in and show a workspace chip in the panel; schedules made before this change pause until you adopt them into a workspace with one click. Two one-time notes: the previous app-wide orchestrator conversation does not carry over (it belonged to no particular workspace), and the post-reboot recovery card now recovers the active workspace's agents — visit each workspace's tab to recover the rest.

- **The window now reads as one piece of chrome, not three apps taped together.** The panel surfaces unify: the right dock, pane tab strips, and the bottom toolbar all sit on the same warm panel tone, separated by quiet hairlines. The focused pane dropped its loud full-color border — focus is now a slim amber underline under the pane's tab strip (the design system's single focus signal), so a busy grid stays calm and the one amber line tells you where you are. Toolbar buttons went text-first (no boxes until hover), so the toolbar reads as part of the frame instead of a row of widgets competing with your terminals.

- **@-mentioning a busy Claude pane now delivers the mention immediately instead of waiting for its turn to end.** A channel mention aimed at a pane whose agent was mid-turn used to sit queued until that agent's next Stop — on a long-running turn that meant minutes of "the agent is ignoring me". Current Claude Code safely queues input typed while it works and reads it at its next tool boundary, so for Claude panes the mention nudge is now pasted the moment it arrives (measured end-to-end: under 1.5 s from post to paste, consumed within the same turn, with the original task unharmed). Guardrails unchanged: an agent sitting on a permission prompt or menu (`awaiting_input`) still never gets pasted into, other agents (Codex, OpenCode, unknown) keep the turn-end delivery until their mid-turn behavior is proven, and the per-pane rate cap and dedupe still apply. Note that immediate delivery applies to pane-pinned mentions (the composer pins a pane when you mention an agent pane); workspace-level mentions stay badge-only by design.

- **Revealing a stale hidden pane now repaints from a compact daemon-side snapshot instead of replaying the raw session history.** With "Skip hidden pane rendering" on, revealing a pane whose backlog overflowed used to tear down its data socket and replay up to 8 MB of raw bytes for the renderer to re-parse — a visible multi-second repaint (and a brief input dead-zone) at the exact moment you switch to the pane. The daemon now parses the session history itself in a headless terminal and re-flushes a serialized screen — typically dozens of times smaller — **over the live socket**, so input keeps flowing throughout and the pane paints its true current state (scrollback, colors, cursor, and input modes like bracketed paste included) near-instantly. Anything a snapshot cannot reproduce faithfully — full-screen TUIs on the alternate screen, active scroll margins, a pathologically slow parse — automatically falls back to the old raw replay, and legacy daemons fall back to the old reconnect: worst case is the previous behavior, never a wrong screen. Revealing a *dead* session's stale pane now also paints its final screen (read-only snapshot) instead of leaving whatever was last drawn.

## [3.20.0] — 2026-07-10

### Added

- **Experimental: hidden panes can skip output parsing (Settings → "Skip hidden pane rendering").** Even with the shared output scheduler, hidden agents' output was still *parsed* eventually — and measurement showed that parsing total is what drags the visible pane once several background agents stream at once (4 hidden flooders pulled the visible pane down to ~10–20fps). With this toggle on (daemon sessions only, default off), hidden panes' output is queued but never parsed: the renderer does no parsing work for panes you aren't looking at. A pane whose backlog outgrows its cap is marked stale and transparently re-synchronized from the daemon's session buffer when revealed — the daemon replays the authoritative bytes onto a reset terminal, so what you see on reveal is the pane's true current state, never a duplicate or a half-parsed frame. Agent-facing buffer reads (`wmux_search_panes`, `terminal_read`) hydrate a stale pane before reading so orchestrating agents never see old output. If a re-sync can't complete (dead session, legacy daemon), the pane degrades to its last-known screen instead of sticking or losing its identity.

- **Diff comments now wake the task agent (J4).** Commenting on a hunk in a fan-out task's diff surface no longer just records a note — it @-mentions the task's agents on the mission-channel post, so the existing mention→wake loop nudges them to read and act on the feedback. Every non-human member of the mission channel (excluding you, the commenter) is mentioned at the workspace level, so multiple agent panes sharing one workspace all get woken; if every agent has left the channel the comment still posts, just without a mention. The post's body also carries a `[diff: <file> @ <hunk>] <comment>` prefix so an agent reading the channel over the CLI or MCP (which don't render the structured anchor) still sees which file and hunk the comment is about. The success message reports how many agents were pinged.

- **Fleet cards surface an agent's completion evidence.** A fleet card now shows a small `✓ evidence n/m` badge when the pane's most recently completed A2A task carries structured completion evidence — `n` is how many of the `m` evidence items are actually verified (a passed command, or a verified inspection/artifact). It's the "trust it ran unattended" proof made legible on the card: the check reads green once at least one item is verified and stays muted when nothing is (verified is a grade, not a claim), and the task title plus the evidence summary live in the badge's tooltip so the on-card text stays a single compact token. The badge reads existing task state only (no new store or round-trip), is addressed per-pane (a pane-pinned task shows on exactly that pane; a workspace-level task shows on the workspace's active pane), and simply isn't drawn when there's no such task.

### Fixed

- **Multiple workspaces full of busy agents no longer stutter the visible terminal.** Every pane used to push its PTY output straight into its own terminal the moment it arrived over IPC — including panes in hidden workspaces — so a fleet of background agents ran that many independent parse/render pipelines on the one renderer thread, and the pane you were actually typing into starved between them. Terminal output now flows through a single shared scheduler: the visible pane keeps the exact direct-write path it always had for ordinary output (zero added latency), while hidden panes' output is batched and drained cooperatively under a hard per-tick time budget, so no amount of background agent chatter can pin the UI. Even the visible pane's own output floods are chunked through that budget rather than parsed in one blocking pass, so watching a chatty agent stays responsive too. Nothing is dropped — a hidden pane's backlog is handed over in full when it becomes visible (before its reveal repaint), when a reconnect replay needs it, or if it ever exceeds the scheduler's memory cap (which simply restores the old behavior for that pane).

- **Diff-panel comments now actually post to the mission channel.** The diff comment post omitted the `sender` identity the daemon requires, so every comment was rejected with a "코멘트 발사 실패" authorization error instead of being recorded. The comment now posts as the diff's owner workspace (its own mission-channel member row), which is also what lets the new @-mention wake the agent.

### Security

- **`events.poll` no longer lets an agent eavesdrop on another workspace's channels (audit B3).** The event-poll RPC previously scoped its results by a caller-supplied `workspaceId`, so a same-user pipe/MCP client could live-subscribe to any workspace's private channel messages, channel lifecycle, and A2A task pointers just by naming that workspace's id — no pane identity required. Those confidentiality-sensitive event types are now scoped to a **server-resolved** workspace derived from the caller's verified `senderPtyId` (the same identity anchor the `a2a.channel.*` mutations already use), and the caller-supplied `workspaceId` is ignored for them; an unresolvable caller receives none of these events (fail-closed). The bundled MCP `wmux_events_poll` tool forwards its own PID-walked `senderPtyId`, so a legitimately-placed agent still sees its own channels and tasks unchanged. The first-party operator surface (the app's own renderer/plugin host) keeps scoping across the local workspaces it names. Ordinary lifecycle events (pane/process/agent/workspace metadata) are unaffected — their all-workspace firehose was already reachable by any `events.subscribe` subscriber, so their workspace scope was never a confidentiality boundary and external lifecycle subscribers keep working.

## [3.19.0] — 2026-07-10

### Added

- **Task lifecycle: close, one-click PR, and a cleanup list (J3).** A fan-out task's diff surface now carries **닫기 (Close)** and **PR** buttons, so you can finish a harvested task without touching the terminal. **Close** runs in a deliberate order — it removes the task's git worktree first and only commits the close (and archives the mission channel) once the worktree is gone, so you can never end up with a "closed" task whose output still litters disk. If the worktree is dirty, close is *held*: the task stays open, the output is preserved, and a toast tells you to review the diff and commit/PR or discard it. If there are committed-but-unpushed commits, close warns instead of silently dropping them. **PR** is one click (with a single confirm that names the branch and warns a pre-push hook may run): it gates on `gh` being installed *and* authenticated, refuses if the worktree is dirty (uncommitted work wouldn't be in the PR), pushes the branch, and opens a PR against the repo's default branch — and it's idempotent, so a second click after a half-finished attempt recovers the existing PR URL instead of erroring. The PR URL is recorded on the task and the PR-status cache is refreshed immediately. A new **"태스크 정리 목록" (Task Cleanup List)** command in the palette scans the dedicated worktree root against live tasks and surfaces four kinds of leftovers — unmaterialized-open, disk-missing, dirty-preserved, and orphaned directories (reverse-mapped by an on-disk `task.json` stamp so they're identifiable even after a closed task ages out of memory) — with an inline Close for the ones that are still open tasks. If a fan-out agent pane comes up but its prompt never fired, you now get a **"프롬프트 미발사"** toast with a **재발사 (re-fire)** action that re-sends the task's original startup command (agent launch + prompt together, same sanitization as the normal path) after checking the prompt file still exists — it never pastes the raw prompt into a bare shell. Finally, a task workspace whose pane wanders outside its worktree boundary gets a small **⚠ 이탈** badge in the sidebar (best-effort, warning only — nothing is blocked).

- **Operators can now join private agent-made channels.** The channels panel grows a collapsed discovery section listing every channel on the daemon — including private rooms agents created without inviting the human, and archived rooms for audit visibility — with a one-click join. Joining seats the operator as a regular member with full history, and appends a server-published, viewpoint-neutral system marker ("Operator joined this channel") to the channel as an audit row; the marker consumes a sequence number but owes no member an unread, so agents are not nudged by it. The join surface is strictly human-side: the RPC methods are unreachable from agent transports (pipe router unregistered, first-party MCP exclusion), pinned by boundary tests.

- **Fan-out missions are now visible in the sidebar and fleet panel.** Workspaces created by a J1 fan-out now show up under a "Missions" group at the top of the sidebar (title, open/closed status, and a link into the mission's channel) — the group only appears when a workspace has fanned out, so ordinary workspaces are unaffected. The fleet panel's cards also grow a mission line when they belong to a fan-out task. The existing worktree badge (⊕) is untouched — it marks the low-level "this is a git worktree" fact, while the new Missions section marks the higher-level "this is a fan-out task" fact, and a workspace can carry both. Mission data is read-only and pulled (mount + workspace-set changes + a 15s background poll for status drift + an immediate refetch right after a fan-out completes), since the daemon doesn't push mission updates.

### Changed

- **Fleet view is now always-on chrome instead of a full-screen modal.** `Ctrl+Shift+A` still toggles it, but it now mounts as a fixed-width panel alongside the workspace sidebar and channel dock (mirroring the channel dock's existing flex-sibling layout) rather than a `fixed` overlay with a backdrop — other panes stay visible and interactive while it's open, and closing it no longer drops keyboard focus into `<body>`: the element that had focus when it opened is restored. The fleet/approvals/remote tabs, keyboard row-navigation, and approve/deny shortcuts are unchanged; the card grid narrows to fit the panel's width instead of a full-screen layout. Two focus bugs found in review were fixed before this landed: opening the panel now lands real DOM focus on the active card/row (not just the panel container, which used to leave keyboard users unable to reach any card when only one was present), and row shortcuts (Enter=approve, Backspace/Delete=deny) now only fire when the option row itself is focused — previously an auto-approve checkbox could steal focus and cause those keys to mis-fire as an approval/denial.
- **Type scale: apply the wave-1 semantic tokens to the always-visible chrome.** The sidebar (`WorkspaceItem`, `MiniSidebar`), channel dock (`ChannelsPanel`, `ChannelView`, `ChannelMembers`), and fleet panel (`FleetCard`) now use `.text-caption`/`.text-body` instead of hardcoded `text-[11px]`/`text-[13px]` — swapped only where the token's actual size (caption=11px, body=13px) matches the literal exactly, so there is no size change. Elements that already carried an explicit `font-*`/`leading-*` utility are unaffected (utilities win over the token's own weight/line-height); a handful of small mono labels that had no explicit weight now pick up the caption token's weight 500 instead of the browser default 400 — a deliberate, disclosed exception, not a bug. `8px`/`9px`/`10px`/`12px` literals in these six files are left untouched (no matching token without a size change) for a later pass.

- **Design tokens: promote hardcoded modal shadows, z-index literals, link accent, and typography to named tokens (visual-invariant).** Internal design-system cleanup with no visual change: the six-way-duplicated `0 25px 60px rgba(0,0,0,0.75)` modal shadow and the `rgba(0,0,0,0.6)` backdrop are now `--shadow-modal`/`--backdrop-modal`; eight ad-hoc `z-[…]` literals map to a named `--z-*` stacking scale (values and relative order unchanged); the link accent gains an `accentSecondary` token wired to the existing accent value across all eight built-in themes (a hook for future differentiation, currently identical); and a four-tier typography scale (`--text-display/-title/-body/-caption`) is defined with three representative applications. All values are byte-identical to the originals — verified against the pre-change literals by a three-model review — so themes render exactly as before. The sidebar's two bespoke "Copied!" DOM toasts (workspace-info copy and cwd copy), which each hand-built a bottom-center element and bypassed the canonical toast surface, now route through the shared `toastSlice`/`ToastContainer` so copy feedback is styled by one token-driven container instead of duplicated inline CSS (they adopt the app-wide bottom-right/5s presentation as a result). Four dark-only hardcoded hex values that broke the light themes are tokenized: the browser title bar and URL-bar resting state (`#11111b` → `var(--bg-mantle)`) and the browser-close / palette-item hovers (`#3b1e1e`/`#2a2a3d` → `var(--bg-overlay)`) now read correctly under hinomaru/taegeuk — these four spots intentionally normalize to the sibling components' tokens, so dark themes see a subtle shade shift there (e.g. `#11111b` → `#181825`, and the two outlier hover tints join the twenty sibling hovers already on `--bg-overlay`) rather than staying byte-identical. The custom-theme-editor, contrast-warning, and color-inspect chrome keep their fixed high-contrast hex by design (they must stay legible while the live theme is being edited/broken), and the webview inspector overlay keeps self-contained hex because it is injected into arbitrary guest pages that have no wmux theme variables.

### Fixed

- **UI responsiveness: clicks no longer contend with a background re-render storm.** Interaction latency ("every button feels sluggish") had two dominant causes, both fixed. (1) *Renderer re-render fan-out:* seventeen always-mounted components (sidebar, status bar, channels panel, composer, palette, fleet view, …) subscribed to the entire `workspaces` tree, which is replaced on every agent-output metadata tick — and the renderer had zero `React.memo` barriers, so agent activity re-rendered large components continuously and clicks landed on an already-busy render thread. Subscriptions are now minimal derived selectors backed by a reference cache (unchanged projections return the same array/element references, so components only commit when a field they actually display changes), workspace list items self-subscribe by id behind `React.memo`, title/cwd/git-branch metadata writes are coalesced to one store write per frame, and the 1-second status-bar clock is isolated into its own tiny component. A new re-render regression suite (React Profiler commit counting + selector reference-contract tests) pins the fix: unrelated workspace churn now produces zero commits in unrelated components. (2) *Main-process stall:* the 5-second periodic session autosave performed a synchronous atomic write on the main event loop, delaying whatever IPC a click had just issued. The periodic path is now an async atomic write with a write-epoch guard **and post-write recovery** — if an in-flight async write races a newer event-driven synchronous save (the reboot-survival path), the newer snapshot is re-committed immediately, so the final on-disk state matches the latest save under any interleaving (crash-loss window unchanged at ≤5s; exit paths still flush synchronously).

### Added

- **Diff review & hunk adoption: harvest a fan-out task's output (J2).** Fan-out tasks now have a fourth surface type — a **diff surface** — that reads a task worktree's uncommitted changes against its merge-base and lets you review, comment, and cherry-pick them into the target repo. Fan-out's result toast gains a **"diff 열기"** action that opens the diff for that task's workspace. The panel shows a file tree (numstat), a unified diff (+/- coloring only — no full IDE editor, by design), per-hunk checkboxes, and an adopt button. **Adoption is all-or-nothing**: the selected hunks are reassembled into a single patch (file headers and hunk bodies preserved byte-for-byte, only hunk line-counts recomputed) and applied with one `git apply` — the target is either fully changed or fully untouched, never half-applied. Adoption is gated hard: a **target snapshot** (HEAD/branch/dirty set) is captured at read time and re-verified at apply time (rejects if the target moved), any selected file that is dirty in the target is refused (conflict avoidance), a **combined pre-apply `--check`** is the gate (so hunks that only apply together aren't wrongly blocked), and hunks already applied to the target are surfaced as an explicit failure so you can deselect them. Untracked files are synthesized into proper new-file patches (regular files only — symlinks/FIFOs are labeled unsupported so a symlink can't leak a file from outside the repo); rename/copy/mode/binary changes and files over the 512KB/2MB caps are display-only (adoption refused, double-checked). File names with spaces, non-ASCII, or quotes are handled correctly (`-z` porcelain, quotepath off). Comments post to the task's mission channel with a `diff-comment` anchor (file + hunk header) and render inline under the matching hunk on reload; comments whose hunk header no longer matches the current diff drop into a "위치 이동됨" group (v1 anchor precision is hunk-header granularity — line-level anchors are deferred). The whole path is backed by a validation rig that proves adoption atomicity under a mid-apply kill and catches a re-serialization corruption (dropped no-newline marker) as a shipping blocker.

- **Perf harness: N-pane instrumentation + boolean consistency gates (W2, dev/CI-facing).** Extends the existing A1 app benchmark (`scripts/perf-bench.mjs` + `scripts/perf-compare.mjs`, driven by `.github/workflows/perf.yml`) rather than adding a new harness, turning the B2 engine-resume decision from an undefined "feels blocked" call into recorded numeric + pass/fail gates. Four scenarios now run by default on a dedicated bench instance (isolated from the coldStart/input/RAM numbers): (1) **N-pane concurrent-streaming frame budget** — the 8-pane split loop is generalized to `spawnPanes(client, page, n)`, and at N=4/8/16 every pane's PTY is flooded with continuous output while the renderer's rAF cadence is sampled; each N is gated independently (`scenarios.frameBudget.N{n}.frameDeltaMs.p95`, ratio 2.0 = the strategy doc's "budget 2×"). (2) **Korean IME composition** — since CDP/playwright-core cannot drive a real IME, the scenario synthesizes the DOM composition contract xterm's CompositionHelper consumes (`compositionstart`/`compositionupdate`/`compositionend` + `input` + textarea.value diff) on the focused pane's hidden helper-textarea and verifies the PTY echoes the composed string (`안녕하세요`) back byte-for-byte; self-validating (a non-equivalent synthesis would echo nothing and fail). (3) **Long scrollback** — reuses the existing `--scrollback-lines` flag as a run combination (no new logic). (4) **WebGL context-loss/restore** — forces `WEBGL_lose_context.loseContext()`/`restoreContext()` on the focused pane's canvas and measures recovery via the `webglcontextrestored` event + `!isContextLost()` (plus a live-canvas re-count), recording `recoveryMs`. `perf-compare` gains a `BOOL_GATES` array (baseline-independent: `scenarios.ime.pass` / `scenarios.webglContextLoss.pass` FAIL immediately when present-but-not-true) alongside the three new numeric frame-budget gates; both stay record-only until an owner blesses a CI baseline (existing `bench/baseline-ci.json` convention). New CLI flags: `--frame-budget-panes 4,8,16`, `--skip-frame-budget`, `--skip-ime`, `--skip-webgl-recovery`. Pure logic (frame-stat summary, IME echo comparison, gate judgment) is factored into `scripts/perf-scenarios.mjs` and unit-tested; the CDP-driven scenario bodies are validated on the Windows CI target only (this being a macOS worktree, they cannot run locally — an honest, documented limitation). No product-code (`src/`) changes.

- **Fan-out: one prompt → N isolated agent tasks (J1).** The AgentToolbar gains a fan-out entry that spawns up to 8 `WorkTask` missions from a single prompt, each with **worktree isolation by default**: a dedicated git worktree under `{wmux home}/worktrees/{repoHash}/{taskSlug}` on a fresh `wtask/{slug}` branch, a dedicated task workspace (agent pane + shell pane, `startupCwd` pinned to the worktree), an auto-opened private mission channel (task workspace invited as a member), and the prompt delivered via a file-backed `initialCommand` (prompt body lives outside the worktree so task diffs stay clean; the path is shell-quoted for POSIX and PowerShell). The whole call is idempotency-keyed end to end — double-clicks and IPC retries can never mint duplicate worktrees — and a global preflight validates the repo and **every** task's slug/branch before any task or channel is created (unfit input rejects the batch with zero side effects). Per-task failures compensate individually (mission closed, channel archived, any created worktree preserved — never deleted) and surface in a per-task result report (materialization / channel-link state). Worktree operations are serialized per repo (no index.lock races), dirty worktrees refuse removal (preserve-and-list; no force-delete API exists), and bare/submodule/LFS repos fail closed. The daemon activates the reserved `task.update` materialization path (`branch`/`worktreePath`/`paneGroupId`, write-once monotonic, owner-or-CEO gated) and enforces the canonical-worktree-path exclusivity invariant. A separate broadcast-only action (send text to every terminal pane in the current workspace) is deliberately kept apart from fan-out — non-isolated "fan-out" does not exist. Includes a reboot-survival demo script (single task round-trip: daemon restart → projection restored, worktree intact on disk).

- **WorkTask mission channels: durable task canon + minimal mission-channel lifecycle (J0, dev-facing).** Introduces `WorkTask` — the worktree-mission unit (`domain:'task'` in the append-only event log) that J1 fan-out and J2 diff will build on — as a projection-first daemon service (`daemon/worktask/WorkTaskService`), kept deliberately distinct from the A2A `Task` (different lifecycle + transition graph). Two new pipe RPCs plus their thin MCP tools (`channel_mission_start` / `channel_mission_close`) create a WorkTask AND a bound private mission channel in one call, and close flips the task to `closed` while archiving the channel. Ownership is server-constructed and born-owned (`owner = createdBy`, never caller-supplied); close authz is a task-level gate (owner OR CEO), the first line of defense over the channel gate. Identity rides the same `senderPtyId → verifiedWorkspaceId` server stamp as `a2a.channel.*` mutations (fail-closed on unresolvable identity). Crash-safety is enforced end-to-end: mission channels carry a `wmux:mission:{taskId}` topic anchor, boot runs a fixed `replay → bidirectional reconcile → closed-GC` order (an orphan channel from a crash between channel-create and task-append is archived; a closed task whose channel is still active is re-archived — both idempotent no-ops when already settled), and an append-failure on start triggers an immediate compensating archive (the empty-channel reaper cannot reap it — the creator remains a member). Start/close are idempotency-keyed so a lost-response retry never creates a duplicate mission + channel, and re-closing an already-closed mission is a no-op success. Closed tasks are GC'd from the projection after 7 days (log untouched — a view bound only), with archive-unconfirmed tasks exempt. J1+ materialization fields (`branch`/`worktreePath`/`paneGroupId`/`prUrl`) and the §6.M `lease` / born-pending contract are schema-reserved but not yet active; `task.mission.list` is pipe-only in J0 (MCP exposure deferred to J1). Renderer unchanged.

- **E0 conformance harness: recorder + corpus + differential runner (§6.A M1/M2, dev-facing).** Introduces the terminal-emulator conformance harness under top-level `core/harness/`, the measurement scaffolding for the future clean-room VT core. **M1 (recorder + corpus):** a script-driven recorder (`recorder.ts`) spawns a real PTY via node-pty to exercise initial geometry + resize, then emits a deterministic `recording.bin` (raw bytes), `events.jsonl` (init/resize/reflow_mode trail with monotonic byte offsets), and `meta.json` (seed + workload-script sha256). PTY spawn, resize, and abnormal-exit failures are escalated (thrown) rather than swallowed, so a broken geometry-exercise path fails the gate instead of silently no-op'ing. The committed corpus (`corpus/`) is six deterministic synthetic workloads only — scroll flood, resize roundtrip (80→79→80, an explicit **non-reflow control** at 40 chars where no wrap occurs), resize **reflow** (120 chars that wrap into two rows, so the 80→79→80 roundtrip actually exercises the rewrap path — its golden pins xterm.js's *observed* deterministic post-roundtrip state, not an idealized restoration), alt-screen enter/exit, CJK/emoji/VS16/ZWJ width cases, and the SGR spectrum (16/256/truecolor + attribute flags) — each carrying ≥3 golden assertions next to its definition. A companion miner (`miner.ts`) scrubs `{stateDir}/buffers/*.buf` dumps (multi-layer: api-key/token/secret key=value, AWS uppercase-snake credential envs, URL userinfo, JSON `"key": "…"` credentials, PEM private-key blocks, known token prefixes `sk-`/`ghp_`/`gho_`/`xox…`, Bearer headers, OSC 52 payloads, and a base64 high-entropy heuristic) to a local-only, git-ignored output whose write root is pinned to `core/harness/corpus-local/` (an isolation guard rejects any in-repo non-ignored path) — `.buf` preserves only the ring tail (no geometry), so mined output is for mid-stream robustness and fuzzer seeds, never the deterministic corpus. **M2 (differential runner):** `differ.ts` feeds a recording into `@xterm/headless@6` (with `@xterm/addon-unicode11` pinned to Unicode 11 as the baseline width model) behind a `Subject` interface (our E1 core and a third reference plug in later), extracts a full-cell grid snapshot (char, width, fg/bg + portable color booleans, 9 style flags, cursor, active buffer), and diffs two snapshots cell-by-cell into a report whose classification schema encodes the four-way ledger (our-bug / xterm-bug / spec-ambiguous / intended) — where **intended** is admitted only via an explicit approval list (`intended-diffs.json`, loaded onto the diff path via `loadIntendedDiffs`), never implicitly. The diff compares the active buffer (normal vs alternate) before cell comparison and excludes xterm.js's non-portable raw color-mode integers from cross-subject comparison; before replay, the event stream is validated (first event is init, byte offsets are monotonic non-decreasing in original order and within range) and violations throw rather than being hidden by sorting; reflow_mode events encountered during replay are honestly recorded on the result. The **four-part baseline gate** ships as tests: determinism (two xterm.js runs identical) — including a chunk-boundary robustness check that feeds each recording one byte at a time and requires an identical layout to whole-buffer feed (a narrow, documented ZWJ-joiner-at-write-boundary char difference is the only tolerated exception; widths/cursor/colors/flags must match) — no-crash full-corpus completion, golden-assertion pass, and record→replay round-trip stability that reads the committed corpus into memory first and regenerates into a separate temp dir (the gate never writes the repo corpus, so the drift check is no longer a self-comparison). Throughput is recorded as the xterm.js baseline (steady-state feed MB/s + full-cell extraction time). Wired as a fourth vitest lane (`vitest.harness.config.ts`, `tsconfig.harness.json`, `npm run test:harness`). Zero product-code changes; existing test lanes and typecheck unaffected.

### Added

- **Append-only event log: crash-safe primitives (envelope PR1).** Introduces the segmented NDJSON append-only log (`daemon/eventlog/AppendOnlyLog`) and the shared event-envelope schema (`shared/eventlog`) — the foundation for rewiring the channels and A2A canonical state to a crash-safe commit log (§6.L). Key properties: fsync coalescing (group-commit batches), single-`ftruncate` per-batch rollback, boot-time forward-scan recovery (trim at the first corrupt byte, no partial promotion), Lamport/seq high-watermark resume (reuse forbidden, gaps permitted), and fail-stop on truncation failure rather than silently diverging coordinates. Includes `machine-id` minting and recovery, and a `durable` option for `atomicWrite` (fsync sequence). No service is wired to this log yet — that lands in subsequent PRs.

- **Event log migration engine (envelope PR2).** Adds the zero-downtime boot gate (`daemon/eventlog/migrateToEventLog`) that promotes legacy `channels.json` to log mode, plus the durable-only `EventLogManifest` (atomic migration-complete marker) and `SnapshotStore` (latest → `.bak` → reseed → genesis fallback chain). Detection uses three branches: inexplicable state is quarantined under `quarantine/` and retried rather than silently accepted. Conversion failures leave the legacy file intact and are idempotent on retry. Downgrade detection uses a Lamport + state-hash watermark — a record of an older daemon's writes triggers a reseed snapshot. Compaction safety: no truncation before durable confirmation; genesis and reseed snapshots are never truncated. Not wired into daemon boot yet.

- **A2A tasks are now durable in the daemon event log (envelope PR4).** Canonical A2A task state moves from the renderer's in-memory store (30-min GC, lost on restart) into `A2aTaskService` in the daemon, persisted as `domain:'a2a'` envelopes in the append-only log. Create, transition, and cancel all reach the log under fsync commits; tasks survive restarts via projection replay. `VALID_TRANSITIONS` is enforced daemon-side — out-of-graph transitions are rejected at the canonical source. Background `ClaudeWorker` transitions (working / completed / failed) now route through the daemon rather than writing directly to the renderer, carrying completion evidence along. The renderer `a2aSlice` is demoted to a read cache that applies daemon commits verbatim without re-validation; when the daemon is unavailable the existing renderer validation path is the automatic fallback (no degraded behavior). Workspace close force-fails in-flight tasks in the log so they do not resurrect on restart; completed tasks are periodically pruned. Daemon canonical state wins over a stale cache on reconnect, including immediately after restart.

- **A2A event authContext is now server-stamped; daemon.ping exposes the active log format generation (envelope PR5).** The `authContext.principalId` in every A2A task event (create, transition, cancel) is now derived by the daemon from stored task coordinates rather than accepted from the caller's claim — actor pane for transitions (`to.paneId`), caller-side pane for cancel/create, workspace fallback for headless workers or unpinned tasks. `principalId` and `trustTier` are display/routing/audit fields only; the authorization anchor remains the server-pinned `verifiedWorkspaceId` invariant. `trustTier` is always `'semi-trusted'`, resolved unilaterally by the server (the temporary caller-override field from PR4 is removed — callers cannot claim a trust tier). `daemon.ping` responses now carry `eventLogFormatVersion` additively: present when log mode is active (value = the active format version integer), absent in the legacy fallback. Absence signals a pre-envelope daemon to the auto-replacement logic, which treats unknown format generations fail-closed.

- **A2A completion evidence: schema and pure validator (§6.M P1).** Introduces the `CompletionEvidence` schema and a pure, side-effect-free validator (`shared/completionEvidence.ts`). Gate = structure: non-empty `summary`, well-formed items, sanitized paths, DoS caps on body lengths and item counts. `verifiedItemCount` is derived honestly — an all-unverified completion is accepted at grade 0 rather than rejected (grade is observability, not a gate requirement). Path sanitization rejects colons, leading separators, `..`, and C0 control characters (undecoded literals enforced). Untrusted-wire normalization: plain-object check, `hasOwn` gating, fresh-object copy to prevent prototype pollution. Not wired to any transition at this point — gate activation is the next PR, after envelope PR4.

- **A2A completion evidence: production and transport wiring (§6.M P1).** `ClaudeWorker` now produces structured completion evidence from its Claude run results. Both success and failure paths emit `inspection` + `unverified` self-report — run-success is never promoted to `verified` (no laundering). MCP `a2a_task_update` transports evidence via a dedicated `evidence` parameter; the contract is fixed in the tool description and coexists with the existing artifact channel. The renderer bridge normalizes untrusted wire shapes before they reach the store: a poisoned shape is stored as `completion_evidence_malformed` (additive-inert — no task state change at this stage), and server-only stamps like `recordedBy` are stripped on ingestion. No rejection gate yet — that is the next PR.

- **A2A completion-evidence gate activated (§6.M P1).** `completed`/`failed` A2A task transitions now require structured completion evidence: `completed` needs a non-empty summary plus at least one well-formed item (`command`/`inspection`/`artifact`), and `failed` needs a summary (the failure reason). The daemon `A2aTaskService.transition` is the single enforcement point; the renderer fallback writer applies the same gate for pane-pinned tasks driven by a pane-identity caller or when the daemon is unavailable. Rejections return actionable reason codes (`completion_evidence_missing`, `completion_evidence_no_items`, `completion_evidence_empty_summary`, `completion_evidence_invalid_item`, `failure_reason_missing`) and leave task state unchanged with no log append. `verifiedItemCount` remains an honest grade rather than a gate requirement — an all-unverified completion is still accepted (grade 0). Workspace-teardown force-fail and verbatim application of daemon commits intentionally bypass the gate to prevent split-brain.

- **Completion evidence grade is now observable in A2A task events (§6.M P1).** `a2a.task` events received via `wmux_events_poll` now carry `verifiedItemCount` (count of independently-verified evidence items; `0` = unverified completion) on `completed` and `failed` transitions. Event pollers can now distinguish an unverified completion (grade 0) from a graded one without querying the task separately. The count is derived from `task.status.evidence` at terminal transitions only — non-terminal transitions such as `working` carry no count. The renderer's primary publisher emits it; workspace-teardown force-fails emit a separate grade-0 event. The trust boundary admits only non-negative integers (forged or out-of-range values are dropped silently). `created` and `cancelled` pointers carry no grade field.

- **Validation rig: harness core + SIM smoke (§6.G, dev-facing).** Introduces the self-verifying harness under top-level `rig/`. Components: run isolation (`isolation.ts` — fresh temp home per run, 4-env wipe of HOME/USERPROFILE/APPDATA/LOCALAPPDATA, `WMUX_DATA_SUFFIX='-rig-{runId}'`), headless daemon wrapper (`daemon.ts` — `dist/daemon-bundle` spawn with a detached process group, `daemon.ping` ready-poll, group tree-kill, respawn, explicit error on missing bundle), daemon pipe client (`pipe.ts` — persistent-socket JSON-RPC, dual-ok-layer unwrap, G6 honest-main discipline: one `workspaceId` binding per persona, throws on cross-workspace impersonation or reserved identity claims), state assertion helpers (`assert.ts` — seq integrity, full-body cross-check, unread counts, canonical coordinate comments), and deterministic seed (`seed.ts`). SIM scenario S1 (flood ×8 concurrent senders → `getMessages` full cross-check: all-delivered, seq-continuous, no-duplicate) lands as a third vitest lane (`vitest.rig.config.ts`, `npm run test:rig:sim`, requires `npm run build:daemon` first). Zero product-code changes; existing two test lanes unaffected.

- **Validation rig: simulator scenarios S2–S8 + SIM regression-detection evidence (§6.G, dev-facing).** Completes the synthetic multi-agent simulator on top of the R1 harness. The persona framework (`rig/harness/persona.ts`) handles identity assignment, channel preamble, seed wiring, and member lifetime; behavioral scripts are owned by each scenario. Deterministic scenarios S2–S8 each run against an isolated daemon: **S2** channel integrity under ping-pong load; **S3** dead-member expiry — unread, membership, and message-ledger remnants asserted against the client-side cursor only (avoids cursor-circular derivation from `lastReadSeq`); **S4** hung-member: `post` commits immediately with no infinite hold, unread stays accurate; **S5** `deliveryStatus` receipt contract pinned at current behavior (ack-only `pending→delivered`); **S6** cap-boundary ±1 at the wire level (body 8192 B, mention cap 64, evidence item count 64 / item string 4096 B — string overflow is `too_large` at the gate, item-count overflow is `malformed` at wire normalization); **S7** SIGKILL mid-flood → respawn → one-way subset assertion `{ok-commits} ⊆ replay` (at-least-once tail promotion: "no uncommitted resurrection" is intentionally NOT asserted); **S8** full A2A lifecycle (send→working→completed, gate-rejection→retry, idempotent resend) plus detection of the #354 idempotency-authz ordering bug (non-participant key-replay is blocked after authz, not before). EPERM chaos: `chmod 000` on the Unix socket → client isolation, daemon survival, and recovery confirmed; skipped under root (DAC bypass). CL7 early gate opened via stage-1 detection evidence (`rig/EVIDENCE.md`): #354 fix reverted on a scratch branch → S8 red confirmed → main green restored. Dogfood script catalog (`rig/CATALOG.md`): 29 scripts triaged — absorb 4, keep 24, retire 1 (zero physical deletions). Zero product-code changes.

## [3.17.0] — 2026-07-06

### Added

- **wmux now updates its own background daemon — no manual restart.** When an upgraded app reconnects to a daemon left running by an older version, it replaces it automatically: the old daemon suspends every session durably (scrollback, running commands, agent conversations), a current-version daemon starts, and your panes restore themselves — scrollback replayed, supervised commands relaunched, agents resumed. Same session preservation as a full quit-and-restart, without the quit. A brief "Updating the background daemon" toast explains the pause. The 3.16.0 stale-daemon banner remains as the fallback for the cases the replacement deliberately refuses (a NEWER daemon is never downgraded; a daemon that won't shut down cleanly is left running rather than force-killed pre-save).
- **Every agent in a channel now has one honest name — owned by the server, not typed by the agent.** Channel display names are derived by the daemon from its pane registry (the same auto-names you see on panes, like `w26-1(claude)`), so an agent can no longer post under an arbitrary label and two Claude panes can never collapse into one indistinguishable "Claude Code". Names even follow agent swaps: replace claude with codex in a pane and its next message posts under the new name automatically.
- **Recovered agents show up as invite and @-mention candidates right after launch.** Previously a workspace you hadn't visited yet contributed nothing to the "Add an agent pane" picker until you clicked into it once; the app now asks the daemon which panes are running agents at startup.

### Changed

- Quitting the app during a daemon replacement now does the right thing for both quit flavors: a normal Quit leaves the fresh daemon running with your restored sessions (tmux-style persistence), while "Shut down wmux completely" guarantees no daemon survives — including one spawned mid-replacement.
- While the daemon is shutting down for a replacement (or full shutdown), new pane creation is rejected with a clear error instead of silently creating a pane that would be lost in the handover.

### Fixed

- **Agents no longer get re-nudged about their own messages.** A CLI/MCP agent posting under a stale member id matched no roster seat, so its own post counted as its own unread and the wake worker kept poking it. Posts are now mapped onto the workspace's actual seat (when unambiguous) — and when a workspace has several seats and none match, the sender gets an explicit warning instead of a silent identity fork, including on idempotent retries.
- **The same pane can no longer hold two channel seats.** Joining once via the GUI and once via the CLI (or joining before and after agent detection) used to create duplicate roster rows — double nudges, double delivery entries. Joins now converge onto the pane's canonical seat and name the existing seat when they collide.
- **CLI agents stopped colliding on the shared "agent" identity.** Panes are spawned with a unique `$WMUX_MEMBER_ID`, `wmux channel join` requires an identity instead of silently defaulting, and the join reply reports the seat you actually got.
- Channel mention nudges are no longer typed into a plain shell terminal. When a member's agent pane was busy (its real Claude pane owned by the on-screen window), the wake worker could auto-submit its `wmux channel read …` hint into an agent-less shell, where it ran as a stray command; it now stays silent there and leaves delivery to polling.

## [3.16.0] — 2026-07-05

### Added

- **You are ONE person in channels now — everywhere.** Your channel identity is a single app-wide seat instead of one seat per workspace: the roster shows just "Me" (no more "Me · Workspace 2"), your channel list / memberships / unread badges are identical no matter which workspace is open, and joining or creating a channel no longer stamps whichever workspace happened to be active. The daemon merges your previously scattered per-workspace rows into the one seat at boot (deterministic, crash-safe, keeps your earliest join date and furthest read position).
- **Upgrades can't silently wipe your channels anymore.** wmux keeps the background daemon alive across app restarts by design, so an upgraded app could attach to an old daemon and channels would look missing (posts failed with no explanation). The channels panel now detects the stale daemon and shows a "quit wmux fully and start it again" banner; it clears itself after the restart.

### Changed

- **The unread badge is honest now.** Agent posts from the workspace you're looking at used to be silently muted (workspace-level self-mute); with the unified seat, only YOUR OWN posts stay quiet — an agent posting from any workspace counts as unread, because it's news to you.
- Adding a whole workspace as a channel member is retired — you are already in your channels as one seat, and agents join as individual panes.

### Fixed

- **Private agent-only channels no longer leak into your dock.** A private channel between agents whose workspace happened to be active could bump your unread badge for a channel you can't even open (phantom badge). Display is now scoped to channels you are actually in.
- The channel wake worker no longer sweeps the virtual human seat every tick (it owns no terminal, so the sweep was pure CPU drift that grew with history).

### Security

- The reserved human seat cannot be invited, claimed, or targeted from the agent pipe — an agent could previously seed a phantom "human" member row that force-injected its channel into your always-on view. Rejected at both the pipe router and the daemon, so a direct-socket caller cannot bypass it either.

## [3.15.0] — 2026-07-05

### Added

- **You can now tell agents apart in a channel.** Every message shows the sender's pane identity chip (`Claude Code · w26-1(claude)`) plus a per-workspace color badge (round = a human seat, square = an agent pane); human posts read "Me · <workspace>", and the roster labels only YOUR row "Me" (another workspace's human seat reads as its workspace name). Previously every Claude pane rendered as an identical "Claude Code" and every workspace's human row read "Me".
- **Hand-typed @mentions now deliver.** Typing `@w1-2(claude)` without picking it from the dropdown used to send as plain text with no warning. Typed tokens that match a live agent pane are promoted to real mentions — including when typed flush against Korean text or punctuation (`확인요@…`, `cc:@…`) — and tokens that match nobody get an inline "didn't match anyone" warning instead of a silent drop. An empty @-dropdown now says "No agents to mention" (dismissible with Escape) instead of rendering nothing.
- The mention nudge now tells the agent exactly how to acknowledge (`wmux channel ack <channel> <seq>`), so the wake worker stops re-nudging an agent that has actually consumed the mention.

### Fixed

- **Mentioning an agent no longer delivers twice.** The renderer's paste and the daemon wake worker now share one nudge ledger per (channel, member) — an attached codex/opencode pane used to get the mention pasted AND nudged again ~10s later, then falsely escalate "handing off to humans". One paste covering several queued mentions debits the ledger once.
- **Agent greeting loops are cut at the source.** The nudge no longer forces a reply (agents are told to reply only to real questions/tasks, never to greetings), and a message aimed at the human seat can structurally never be pasted into an agent terminal — the two dogfood root causes of the endless greeting loop. Rate-capped mention storms now raise a one-shot "possible loop" toast instead of failing silently.
- **A mention no longer vanishes when its target agent restarts.** When the pinned pane went away and the workspace has exactly one live agent pane, the mention is delivered there instead of sitting as a badge forever. Genuinely workspace-level mentions stay badge-only.
- **A mention held while you reload the app is no longer lost.** Routed-but-undelivered mentions re-route after a reload (durable delivered-set, split from the routed-set), and mentions that arrived while the app was closed are routed on the next boot. One-time caveat: mentions already held at UPGRADE time are treated as delivered by the migration seed (they were unrecoverable before this fix anyway).
- **A hung agent can no longer hold a mention hostage forever.** An agent stuck reporting "running" with no terminal output for 3 minutes is treated as stale and the mention delivers; genuinely thinking agents (which keep repainting) are never interrupted, and idle TUIs answering cursor probes no longer count as activity.

## [3.14.0] — 2026-07-05

### Added

- **Channel mentions now reach agents in any workspace, not just the one you're looking at.** A mention addressed to a pane in a background workspace used to sit undelivered until you switched to that workspace. The renderer now polls the event stream across all local workspaces in a single request (union scope), so a cross-workspace mention lands on its target pane immediately and the agent answers without you having to switch.

### Fixed

- **Reattaching no longer floods a reused shell with cursor-position replies (CPR feedback storm).** On reattach the daemon replayed persisted scrollback verbatim and xterm re-executed the one-shot terminal queries (DSR/CPR, DA, DECRQM, OSC color, DCS) a prior TUI had emitted, each firing a live auto-reply into the fresh shell. A pane left running while detached could accumulate thousands; reattach answered them all at once, pinning zsh and the daemon near 100% CPU. Query sequences are now stripped from the replay before xterm sees them; live output is untouched.
- **A mention to an idle background agent now delivers instead of hanging until an unrelated repaint.** An agent idle since its pane attached never re-emits a status pattern, so its status stayed unknown and the paste gate held it busy forever. Unknown status is now held only for a short grace window, then delivered, guarded so a genuinely running-but-quiet agent is never pasted mid-turn (an output-quiet check plus a hard hold ceiling).
- **Splitting a pane no longer crashes zsh on macOS.** The zsh shell-integration prompt marker (OSC 133;B) was appended without a `%{...%}` zero-width guard, so zsh's line editor miscounted the prompt width and could crash (SIGBUS in zle) during the resize sweep a split triggers. The marker is now width-guarded, matching the bash and PowerShell integrations.

## [3.13.0] — 2026-07-04

### Added

- **Agent panes are now first-class channel members (R2 Principal registry).** The channel roster lets you add a specific agent pane (e.g. `w8-1(claude)`) as a member directly, not just a workspace. The roster reads as "you + agent panes", each agent showing a live/stale dot for whether its pane is alive. Previously every member was an anonymous `local-ui` row, which caused the "I added it as a member — why doesn't it hear me?" confusion.
- New daemon Principal registry (`principals.json`) that unifies every actor (human / pane-agent) under one address space. On daemon restart, pane-agents are backfilled to `stale` (the daemon cannot prove a pane is still alive) and only a renderer re-registration flips them back to `live` — this structurally blocks the stale-read-as-live class of state drift.

### Changed

- The channel wake worker now targets a member's pane PTY directly via its principal coordinate. This fixes a defect where the auto-name memberId (`w8-1(claude)`) never matched the old agent-slug heuristic, so per-pane mentions now reach the exact pane.
- Removed the internal `local-ui` token from message senders and the roster — it now renders as "you" (the on-disk schema stays backward compatible).

### Fixed

- Added a channel-membership cleanup hook on workspace/pane deletion — dead-workspace member rows no longer linger in the channel roster forever.

## [3.12.4] — 2026-07-04

### Fixed

- **Dev only:** `npm start` no longer opens to a blank, flickering window on macOS. Electron loaded the renderer from `http://localhost:5173`, which macOS resolves to IPv6 (`::1`) first, while the Vite dev server listens on IPv4 (`127.0.0.1`) — so the load failed and Electron retried in a loop. The dev-server URL is now normalized to `127.0.0.1`. No effect on packaged builds.
## [3.12.3] — 2026-07-04

### Fixed

- **Splitting panes no longer randomly kills shells.** Splitting a pane (or reattaching after a reboot) could kill a pane's shell with a bus error, leaving "[process exited]" — seemingly at random. The real trigger: during a split or layout transition the pane is momentarily only a few characters wide, and resizing zsh below 7 columns crashes it outright (a macOS zsh 5.9 bug, reproduced 100%). wmux now never applies a terminal size below a safe floor (10 columns), and skips resize signals that don't change the size. Verified: the same narrow-resize test kills 5/5 shells on the old build and 0/5 on this one.
## [3.12.2] — 2026-07-04

Headline: you can now @-mention an agent running in your own workspace from a channel — the mention reaches that exact pane, while an agent still never pings its own pane in a loop.

### Added

- **Same-workspace @-mentions now deliver.** Before, a channel message could only mention agents in *other* workspaces — your own workspace's agent panes were hidden from the @-picker and any mention of them was dropped. Now the composer offers same-workspace agent panes as mention targets, and a mention routes to that specific pane as an inbox task. A human mentioning their own workspace's agent, and an agent mentioning a sibling pane, both work.

### Changed

- **Channel messages carry the sender's pane identity (`senderPtyId`).** This lets the receiving side tell a legitimate sibling mention (pane 1 → pane 2 in the same workspace) apart from a true self-loop (an agent mentioning its own pane). Self-loops are dropped; a workspace-level mention with no specific pane on a self-authored post stays conservative and is not routed. Older messages without the field degrade safely.

## [3.12.1] — 2026-07-03

Headline: the built-in F7 shortcut that launches Claude now works out of the box on a Mac, instead of doing nothing until you dug into macOS keyboard settings.

### Fixed

- **The default "launch Claude" shortcut works on macOS without touching system settings.** macOS treats F1–F12 as media keys by default, so a bare F7 press never reached wmux — the shipped F7 keybinding looked dead on a Mac. macOS now uses **Ctrl+F7** (a modifier makes macOS deliver it as a function key), while Windows and Linux keep the single-tap F7. Existing macOS users are migrated automatically on next launch: an untouched default F7 is upgraded to Ctrl+F7, but a keybinding you deliberately changed (different command) is left exactly as-is.

### Added

- **Custom-keybinding settings warn when a bare F-key won't fire on macOS.** If you bind a lone F-key (like F7) on a Mac, the settings panel now explains that macOS is intercepting it as a media key and how to reach it (hold Fn, or turn on "Use F1, F2, etc. keys as standard function keys"). The hint only appears for bare F-keys — a modifier combo like Ctrl+F7 is left alone because it already works.

## [3.12.0] — 2026-07-02 — Sessions survive a reboot

Headline: panes that were mid-conversation before an OS reboot now come back exactly as they were — same session id, same scrollback, same permission mode — instead of resetting to a blank terminal. Alongside that, an opt-in unattended supervisor lets a trusted pane restart itself after a crash and, with explicit consent, resume without stalling at a permission prompt.

### Added

- **Unattended supervisor: opt-in crash restart + consent-gated permission restore.** A layout leaf can declare `unattended: true` in `wmux.json`, which restarts it on failure (a clean exit is treated as "task finished," not a crash to relaunch) and, only with a separate explicit consent given in the trust dialog, restores the permission mode it was running under before a restart. Fleet View surfaces each pane's supervision state — armed with a restart count, or a guard-tripped marker when the runaway guard stopped it.
- **Daemon liveness moves to a three-state probe.** Replaces the old "probe failed → assume dead" pattern (the same anti-pattern behind earlier false-death and duplicate-daemon reports) with an explicit unknown/alive/dead classification, shared between the daemon and the launcher, so a slow OS probe can no longer make one daemon reclaim another live daemon's lock.

### Fixed

- **Terminal sessions survive an OS reboot instead of resetting.** Windows kills the daemon's PTY children before the daemon itself during a shutdown/reboot, and the daemon couldn't tell that apart from a user typing `exit` — it tombstoned the session as dead, and recovery skips dead sessions, purging exactly the ones that were in use. The daemon now recognizes the Windows shutdown-teardown exit code and suspends those sessions instead, so recovery replays them under the same id after reboot.
- **session.json no longer loses the latest layout on shutdown.** The Windows session-end handler used to reload the on-disk snapshot and save it straight back, which never captured the renderer's newest layout. Session data is now persisted the instant a pane's terminal id changes (not just every 5 seconds), so a reboot can no longer land in the gap between a new pane and the next periodic save.
- **A recovered session's scrollback replay no longer dismisses its own resume prompt.** Replaying a dead agent's buffered output could re-arm mouse tracking in the terminal, so simply moving the mouse toward the "resume" prompt looked like the user typing and silently dismissed it. Leaked input-reporting modes are now reset after a replay.
- **Claude Code's permission mode is read reliably from long transcripts.** The extractor only recognized permission-mode stamps on user turns, which a large attachment record could push out of the read window; it now also recognizes the dedicated permission-mode record Claude Code writes near the end of every prompt.

## [3.11.1] — 2026-06-29

### Fixed

- **Copy from full-screen TUI apps reaches the clipboard (OSC 52) ([#314](https://github.com/openwong2kim/wmux/pull/314)).** Full-screen TUI apps (Claude Code, vim, tmux, neovim) take over the mouse, so a drag no longer lands an xterm-native selection. On copy they emit an OSC 52 escape asking the terminal to set the clipboard, but xterm disables OSC 52 by default and wmux never registered a handler. The app showed "copied" while the system clipboard never changed, which looked like a corporate clipboard lockdown. wmux now honors OSC 52 for writes (clipboard reads, clears, oversized, and malformed payloads are refused) and routes the text through the existing clipboard path.

## [3.11.0] — 2026-06-29 — Channels become a two-way agent surface

Headline: v3.10.0 gave channels a place a **human** can read; v3.11.0 closes the loop on the **agent** side. An agent can now *read* a channel instead of only posting into it, *discover* and join public rooms, *invite* another workspace into a private one, and get *pulled in by an @-mention* that arrives as an inbox task and a one-line nudge in its terminal. The conversation view grows up alongside: markdown rendering, a scrollback window that pages older history in from the daemon, and in-channel search. Plus more accurate MCP agent identity and a batch of macOS keyboard and appearance fixes.

### Added

- **Channels become a two-way agent surface — read, discover, invite ([#305](https://github.com/openwong2kim/wmux/pull/305)).** Until now an agent could only *post* into a channel; it never saw what was already there. `channel_read` lets an agent pull a room's recent history (capped so it doesn't blow the context window), `channel_list` surfaces the public rooms it can *discover* and join, and `channel_invite` lets any member add another workspace — the only way into a private channel. The conversation view gains markdown rendering (with HTML injection stripped), a "load earlier" scrollback that pages older messages in from the daemon, and in-channel message search. Panes also self-name as `w<ws>-<pane>(<agent>)` so a roster of agents reads clearly, with a GUI rename.

- **@-mentions pull an agent into a channel ([#304](https://github.com/openwong2kim/wmux/pull/304), [#305](https://github.com/openwong2kim/wmux/pull/305)).** Typing `@` in the composer autocompletes the live agents in the channel; a mention of your workspace highlights the message, bumps a dock badge, and routes into the a2a task inbox. When the mentioned pane goes idle, a one-line nudge is pasted into its terminal pointing at `a2a_task_query` — so calling an agent in a channel actually reaches it instead of sitting unread.

- **Archive a channel from the header ([#302](https://github.com/openwong2kim/wmux/pull/302)).** A two-click arm-then-commit archive button in the conversation header, gated to the channel's creator (the daemon enforces the same authz).

- **MCP resolves agent identity by walking the process tree ([#301](https://github.com/openwong2kim/wmux/pull/301)).** The bundled MCP server identifies which workspace and pane a call came from by walking the caller's process tree to its owning PTY, so `a2a_whoami` and channel sender attribution work even when environment hints are stripped.

### Changed

- **Agent toolbar uses line icons instead of emoji ([#309](https://github.com/openwong2kim/wmux/pull/309)).** The per-agent toolbar swaps its emoji glyphs for consistent line icons that match the rest of the UI.

- **Channel roster shows added members and restores archive tooltips ([#303](https://github.com/openwong2kim/wmux/pull/303)).** An invited workspace now appears in the roster immediately, and the archive control's tooltips are back.

### Fixed

- **Ctrl+C copies the terminal selection even when the channel composer holds focus ([#311](https://github.com/openwong2kim/wmux/pull/311)).** With a channel open the composer could swallow the copy shortcut; the terminal selection now copies regardless of which surface holds focus.

- **macOS: Cmd drives clipboard, multiview, and shortcuts ([#307](https://github.com/openwong2kim/wmux/pull/307)).** Clipboard and multiview shortcuts now use Cmd on macOS instead of Ctrl, matching platform convention.

- **macOS: native button appearance stripped ([#308](https://github.com/openwong2kim/wmux/pull/308)).** Buttons no longer pick up the default macOS control styling that clashed with the app theme.

- **MCP recovers a pane's ptyId from `WMUX_PTY_ID` when the identity walk misses ([#299](https://github.com/openwong2kim/wmux/pull/299)).** A weak environment fallback restores pane identity when the process-tree walk can't resolve it, so same-workspace A2A still addresses the right pane.

## [3.10.1] — 2026-06-25

### Fixed

- **Channel dock and conversation no longer show raw i18n keys ([#297](https://github.com/openwong2kim/wmux/pull/297)).** The channels dock and the conversation view are pure presentational components that fell back to an identity translator when one wasn't passed in, surfacing raw keys (`CHANNELS.TITLE`, the empty-state message) instead of translated copy. They now receive the live translator, so the dock header, empty state, and labels render correctly.

## [3.10.0] — 2026-06-24 — Channels grow a human UI

Headline: the A2A channels that agents post into now have a **place a human can read and join.** v3.9.0 made channels multi-party with a server-verified sender; this release gives them a UI — a collapsible **right-side dock** that sits beside your terminals, a **member roster** to see who's in a room and join or leave it, and **recent history that loads when you open a channel** instead of a blank pane. Alongside the channel UI: copy/paste that survives a CJK IME, live channel delivery that survives a daemon reconnect, and a fail-closed gate on private-channel joins.

### Added

- **Channels move into a right-side dock you can read beside your terminals ([#287](https://github.com/openwong2kim/wmux/pull/287)).** A2A channels were agent-only plumbing; now there's a place for a human to watch and join them. The channel list and the active conversation live in a collapsible dock on the opposite edge from the workspace sidebar — a flex column that *reflows* the panes instead of the old overlay that floated over them, so opening a channel narrows the terminals rather than covering them. Toggle it from the StatusBar `#`, and it persists across restart. Decoupled from in-app Company mode, so it works without setting up a company first.

- **Channel member roster — see who's in a room, join and leave ([#291](https://github.com/openwong2kim/wmux/pull/291)).** The conversation header shows a member count that opens a roster popover: the workspaces currently in the channel, a self-only leave (the ✕ next to your own row), and an add-a-workspace picker for public channels. Fully keyboard-accessible — no drag-only paths. Leaving the channel you're viewing returns you to the list.

- **Opening a channel loads its recent history ([#293](https://github.com/openwong2kim/wmux/pull/293)).** Channels used to stay blank until a new message arrived in the current session — open a room with a backlog and you'd see nothing. Opening a channel now hydrates its recent messages from the daemon, and a daemon reconnect re-hydrates, so the conversation is there when you look.

- **Pane + surface lifecycle as MCP tools ([#285](https://github.com/openwong2kim/wmux/issues/285)).** Five new first-class MCP tools — `pane_split`, `pane_close`, `pane_focus`, `surface_new`, `surface_close` — so an external/headless orchestrator (e.g. a Claude Code supervisor that spawns a worker pane per task and reaps it once committed) can manage its panes through the official MCP instead of dropping down to the raw daemon JSON-RPC. They mirror the workspace-scoped lifecycle RPCs hardened in the #236 family (#238/#256/#257): the create tools (`pane_split`/`surface_new`) take an optional `workspaceId` and default to the caller's *own* workspace (never the on-screen one), failing closed on an explicit unknown id; the address tools (`pane_close`/`pane_focus`/`surface_close`) take a globally-unique id resolved across all workspaces, and `pane_focus` is non-yank (it won't steal the user's screen). No new daemon RPC or capability — the methods existed; this surfaces them and grants them to the bundled MCP server's first-party allowlist. Requested by @zhenzoo.

### Changed

- **Channel dock polish — one header, responsive width ([#295](https://github.com/openwong2kim/wmux/pull/295)).** The dock shipped with a duplicate "Channels" title (its own header plus the list panel's section header) and a hard 320px width that crushed the terminals to per-character wrapping on narrow windows. The title now renders once with the collapse control merged into it, and the width clamps (248–320px) so the dock yields space when the window is small and grows back when there's room.

### Fixed

- **Private channels are join-gated on the daemon ([#292](https://github.com/openwong2kim/wmux/pull/292)).** A same-machine caller that knew a private channel's id could join it directly through the daemon and read its history — `join()` had no visibility check. It now fails closed: a non-member can't join (or read) a private channel it wasn't invited to. Same-machine, same-user only; never remotely reachable.

- **Live channel delivery survives a daemon reconnect ([#290](https://github.com/openwong2kim/wmux/pull/290)).** A leaked `rpc:invoke` handler registration meant that after the daemon respawned or reconnected, the main process stopped teeing channel messages (and other daemon→main events) to the renderer until a manual reload — so a channel only updated when you reopened it. The handler is now removed correctly on reconnect, so messages keep flowing live.

- **Copy and paste survive a CJK IME ([#294](https://github.com/openwong2kim/wmux/pull/294)).** With a Korean/Japanese/Chinese IME mid-composition, the key event reports `keyCode` 229 / `key` "Process", so Ctrl+C and Ctrl+V silently did nothing while composing. wmux now falls back to the physical key code (`KeyC`/`KeyV`), so copy and paste work regardless of IME state.

## [3.9.0] — 2026-06-23 — Agent channels, with a verified sender on every message

Headline: **A2A channels** grow up. The multi-party half (U2) lands, so several agents in one workspace can talk in a shared, named room instead of only the one-to-one task messages A2A started with — and every channel message now carries a **server-verified sender** an agent cannot forge. Building on the channel domain types and persistence from U1 ([#269](https://github.com/openwong2kim/wmux/pull/269)), agents create, join, leave, post, and archive channels; the daemon pins each message's sender, each membership, and each channel's authorship to a workspace identity that the main process resolves from the *actual sending pane* rather than trusting a tag the caller put on the wire. A forged `verifiedWorkspaceId` is rejected outright — never attributed to the workspace it tried to impersonate — and private channels stay readable only to their members. Alongside it, the bundled CLI takes a stable identity so the legacy permission grandfather can start closing.

### Added

- **A2A channels — multi-party rooms with a server-verified sender (U2 + D5, [#280](https://github.com/openwong2kim/wmux/pull/280)).** Channels are Slack-style rooms for the agents in a workspace: a shared, named thread several agents post into, rather than the one-to-one task messages A2A began with. This release lands the multi-party operations on top of U1's domain types and persistence ([#269](https://github.com/openwong2kim/wmux/pull/269)) — create, join, leave, post, and archive — and makes **caller identity server-verified** end to end. Every mutating channel call is stamped with the workspace identity the main process resolves from the sender's real pane (`senderPtyId`), not a `verifiedWorkspaceId` the caller supplied:
  - the daemon's `ChannelService` pins the sender on each post, the member on each join/leave, and `createdBy` on each channel to that resolved identity, so a forged sender, member, or author is impossible;
  - the main process strips any client-supplied workspace tag and re-derives it from the owning pane, failing closed on a mutating call it can't attribute;
  - a forged `verifiedWorkspaceId` aimed at another workspace is **rejected**, never silently attributed to the victim;
  - channel reads are membership-scoped, so a non-member can't read a private channel's messages, and message bodies are length-clamped so an oversized post can't stall the pipe.

  Channel access stays gated behind the existing `a2a.channel.read` / `a2a.channel.send` capabilities, so this widens no trust boundary. Channels contributed by @AnandSundar; the verified caller-identity hardening (D5) by the wmux team.

### Changed

- **The bundled `wmux` CLI now reports a stable client identity, so the legacy permission grandfather can begin closing ([#282](https://github.com/openwong2kim/wmux/pull/282)).** The permission enforcer historically let any caller that sent no client name through unchecked (`if (!clientName) allow`) — a grandfather clause the bundled CLI, the one steady-state envelope-less caller, rode on. The CLI now identifies itself as `wmux-cli`, and the enforcer grants that identity *exactly* the narrow set of methods the CLI actually calls — a separate, tighter allowlist than the bundled MCP's first-party set, pinned by a source-level test so a new CLI command can't silently fall outside it. This is **additive**: nothing changes for callers today and the grandfather still admits envelope-less callers — it's the groundwork for a later release to close that grandfather behind the existing `enforcementMode` shadow→enforce switch.

## [3.8.0] — 2026-06-22 — LanLink: local-first cross-PC agent messaging

Headline: **LanLink** lets two wmux machines on the same LAN pair once with a 6-digit PIN, then exchange read-only agent messages over an authenticated, encrypted channel — no cloud, no account, off by default. The epic is built so that **running commands across machines is physically impossible**: the background daemon imports none of the agent-spawning code, a remote message can only ever surface as a read-only card in the renderer (never pasted into a terminal), and every internal RPC now carries a required trust-origin so the execute path fails closed for anything not provably local. Also lands A2A channels U1 (the rooms half of a future cross-PC group chat), a Fleet View sort toggle, a quieter zoom-restore button, and a keyboard-focus self-heal.

### Added

- **LanLink — local-first cross-PC agent messaging, off by default.** Two machines on the same LAN pair with a 6-digit PIN and then exchange read-only text messages over a ChaCha20-Poly1305 channel with per-connection fresh keys. Built across five PRs, with execute excluded by construction at every layer:
  - **Durable inbox + cursor-pull delivery ([#271](https://github.com/openwong2kim/wmux/pull/271)).** A daemon-side append-only inbox persists inbound remote messages and survives a renderer or main crash; the renderer pulls by cursor on reconnect, so nothing is lost and nothing replays twice. A dedicated IPC channel keeps a remote message structurally unable to reach the terminal-paste path.
  - **Control plane + Settings ([#272](https://github.com/openwong2kim/wmux/pull/272)).** An enable toggle and NIC picker in Settings, config persisted across daemon restarts, with the NIC stored as a name+MAC identity (re-resolved to a live IP at bind time, never a stale address). No listener yet — this is the network-0 control surface.
  - **LanLinkServer core ([#273](https://github.com/openwong2kim/wmux/pull/273)).** The network surface: an isolated `net.Server` bound only to a real external IPv4 on the chosen NIC (fail-closed bind guard, Windows Private-profile firewall), PIN-EKE pairing (X25519 + scrypt over the PIN, which never travels on the wire; ≤2-minute window; fail-burn after 5 wrong attempts), the AEAD channel, an allow-list router that admits only text/state messages (never execute/spawn), an ingress sanitizer, and a fail-closed per-peer store with live revoke. Per-peer random UUIDs and long-term secrets under an owner-only DACL.
  - **Renderer + pairing UX ([#275](https://github.com/openwong2kim/wmux/pull/275)).** A read-only **remote-peer card** in a new Fleet View *Remote* tab — untrusted off-machine text rendered as plain React text, never a terminal escape — plus a Settings **pairing section** (generate a PIN with a live countdown, join another machine, list and revoke peers), and the main-process bridge that exposes the daemon's pairing RPCs to the UI with the daemon itself untouched.
  - **Review follow-ups.** The pairing screen shows this machine's `host:port` next to the PIN so a peer can join from one screen ([#277](https://github.com/openwong2kim/wmux/pull/277)).

- **A2A channels — domain types + persistence (U1, [#269](https://github.com/openwong2kim/wmux/pull/269)).** The first half of channels — Slack-style rooms for agents: the channel domain types and a durable persistence layer, contributed by @AnandSundar. Converges with LanLink at a shared delivery seam toward a local-first cross-PC group chat.

- **Fleet View situational sort toggle ([#268](https://github.com/openwong2kim/wmux/pull/268)).** The cockpit grid can now toggle between attention-first (blocked agents float to the top) and pure workspace order.

### Changed

- **The A2A execute path is hardened against off-machine callers ([#270](https://github.com/openwong2kim/wmux/pull/270)).** Every internal RPC now carries a required trust-origin tag (`local` vs `remote`), and the agent-spawning `a2a.task.send` path only runs when the call provably came from this machine — a positive-allow gate that fails closed for anything else, pinned by a source-level test that the background daemon can never even import the code that spawns agents. Nothing changes for same-machine multi-agent use; this is the foundation that makes cross-PC execute impossible.
- **`system.capabilities` advertises only methods that are actually callable over the wire ([#276](https://github.com/openwong2kim/wmux/pull/276)).** Control-pipe-only RPCs (`daemon.*`, `lanlink.*`) are dispatched by the daemon pipe and never registered on the RPC router, so they're no longer listed — a wire client gets an honest capability list instead of methods that would just return unknown-method.
- **The zoom restore button is now a quiet, minimal control that matches the maximize button ([#274](https://github.com/openwong2kim/wmux/pull/274)).** When a pane is zoomed, the toggle that returns it to the grid was a bold red `ZOOM` badge — reusing the cursor accent, a strong red in several themes. It's now styled identically to the hover-revealed `⤢` maximize button (neutral surface, subtle border) with a `⤡` restore glyph, so maximize and restore read as a matched pair. It still stays visible while zoomed so the way back out is always obvious ([#258](https://github.com/openwong2kim/wmux/pull/258) follow-up).

### Fixed

- **Self-heal orphaned keyboard focus ([#267](https://github.com/openwong2kim/wmux/pull/267)).** Closing an overlay (search, palette, notifications, toolbar) could drop DOM focus to `<body>`, leaving the terminal unable to receive input until you opened multiview. A central guard now detects orphaned focus and reasserts it onto the active pane, so input keeps working after any overlay closes.

### Documentation

- **The README foregrounds the A2A multi-agent moat ([#260](https://github.com/openwong2kim/wmux/pull/260))**, and the contributor onramp gained issue templates plus an honest i18n status ([#261](https://github.com/openwong2kim/wmux/pull/261)).

## [3.7.0] — 2026-06-20 — A2A execute approval hardened, and remote RPC that lands in the right workspace

Headline: the A2A execute gate — the path that lets a remote agent spawn a `bypassPermissions` Claude CLI in your workspace — is reworked into a renderer-driven approval flow with `execute` as its own dedicated capability (no longer bundled with ordinary send), an `executeApproved` receipt the worker can't forge, fail-closed YOLO hydration, and a queue so concurrent requests don't clobber each other. Alongside it, the #236 RPC workspace-scoping sweep is finished: `surface.new`, `pane.close`, `pane.focus`, and `surface.focus` now all act on the workspace the caller names instead of whatever happens to be on screen — so a multi-agent orchestrator's "do this in MY workspace" finally lands where it should. Plus a per-pane activity line on Fleet View cards, and a browser-pane keyboard-focus fix.

### Added
- **Fleet View terminal cards now show a per-pane activity line — what each agent is doing right now, at zero extra API cost ([#251](https://github.com/openwong2kim/wmux/pull/251)).** wmux already receives a `PostToolUse` (`agent.activity`) hook payload for every tool an agent runs, and was discarding it at the emit-kind early-return. That payload is now summarized into a short, scannable line per pane — `✎ file` for an edit, `→ file` for a read, `$ cmd` for a bash run, `⌕ pattern` for a search, `srv:tool` for an MCP call — and rendered as an accent line on the pane's Fleet card, with the raw scrollback tail kept as the fallback when there's no activity (the `awaiting_input` affordance still takes priority). It's derived through a pure, never-throwing helper that guards every field of the untrusted tool input, strips control characters, caps the raw input at 1 KB before any regex runs (so a multi-megabyte tool argument can't stall the main thread), and hard-truncates the result to 80 chars; delivery is a per-pane 3-second leading-edge throttle on the existing metadata funnel — no EventBus tee, no notification, no new daemon round-trip. The activity string is transient and never persisted. Now a glance at the cockpit tells you not just *who is blocked* but *what everyone is doing*.
- **A2A execute approval is now a renderer-driven gate with `execute` as its own dedicated capability ([#254](https://github.com/openwong2kim/wmux/pull/254)).** The A2A execute path — `a2a_task_send` with `execute:true`, which spawns a `bypassPermissions` background Claude worker in the target workspace, i.e. remote code execution — was reworked into a stronger approval flow. `execute` is now a **separate capability** (`a2a.execute`) resolved per-call: a task send requires `a2a.execute` only when `execute:true` and the ordinary `a2a.send` otherwise, so granting an agent the ability to *message* you no longer implicitly grants it the ability to *run code* in your workspace. The worker is spawned only when the renderer returns `executeApproved===true` with a resolved target workspace — a receipt the caller cannot forge, replacing the old main-side confirm round-trip — and a denied request creates no task, pastes nothing, and emits no event. Concurrent execute requests are held in a keyed approval queue (each its own dialog, the inbox owning exactly one visible surface) so two agents asking at once can't clobber each other's prompt. A persisted "YOLO" auto-approve flag is available for trusted setups but **hydrates fail-closed** — only an explicit boolean `true` enables it, so a malformed persisted value (e.g. the string `"false"`) can never silently turn on `bypassPermissions` auto-approval — and the approval label is localized. Internal follow-up cleanup ([#255](https://github.com/openwong2kim/wmux/pull/255)) removed the now-dead confirm-execute plumbing and extracted the approval gate into a standalone, unit-tested module (YOLO short-circuit, approve, deny, 30 s auto-deny, and concurrent-request independence all covered).
- **A pane now has a discoverable maximize button ([#258](https://github.com/openwong2kim/wmux/pull/258)).** Hovering an un-zoomed pane reveals a quiet `⤢` button in its top-right corner; clicking it zooms that pane to fill the window — the same toggle as the tmux-style prefix + `z`, which was previously keyboard-only and undocumented. The keyboard cheat sheet (`?` in prefix mode) gained a **Maximize pane** entry. Surfaced after Reddit feedback that there was no visible fullscreen/maximize control to find ([#182](https://github.com/openwong2kim/wmux/issues/182) follow-up).

### Fixed
- **The #236 RPC workspace-scoping sweep is complete — `surface.new`, `pane.close`, `pane.focus`, and `surface.focus` all act on the workspace the caller names, not the one on screen ([#256](https://github.com/openwong2kim/wmux/pull/256), [#257](https://github.com/openwong2kim/wmux/pull/257)).** After [#238](https://github.com/openwong2kim/wmux/pull/238) made `pane.split` honor an explicit `workspaceId`, its sibling RPCs still didn't, so a multi-agent orchestrator working in a background workspace couldn't reliably operate on its own panes. **`surface.new`** dropped all of its params main-side and pinned the renderer to the *active* workspace, so "open a terminal in my workspace" always landed in whichever workspace the user was viewing; it now forwards `workspaceId`/`shell`/`cwd`, honors the target, fails **closed** on an explicit-but-unknown id (no active-workspace fallback), and eager-spawns the PTY into the target workspace. **`pane.close`** is a new RPC (panes carry globally-unique ids, so it's resolved across all workspaces like `surface.close`, disposing every PTY under the pane), filling the gap that left a worker pane created via `pane.split` with no way to be cleaned up — and it rejects root/non-leaf targets, since closing the root pane is a no-op that would otherwise orphan live surfaces with dead PTYs. **`pane.focus`/`surface.focus`** acted only on the on-screen workspace — `pane.focus` silently no-op'd while returning a false `{ok:true}`, and `surface.focus` errored "not found" — so a background-workspace agent couldn't focus its own pane; a dedicated `focusPaneSurface` store action now resolves the workspace by explicit id (no self-search, no active fallback), rejects non-leaf panes, sets the active pane and surface in one transaction, emits `pane.focused` honestly for a background or multiview workspace (events stay workspace-scoped, no cross-workspace leak), and surfaces a real `{error}` on a miss instead of the false success. Bringing a workspace on-screen remains the separate, opt-in `workspace.focus` RPC — these handlers never yank the user's screen.
- **A browser pane now takes keyboard focus when its own pane is active, so typing into it works ([#252](https://github.com/openwong2kim/wmux/pull/252), [#253](https://github.com/openwong2kim/wmux/pull/253)).** The embedded browser webview wasn't being focused when its pane became active, so keystrokes had nowhere to land and the browser pane felt dead to the keyboard. The webview is now focused whenever its pane is the active one.
- **Ctrl+Enter now inserts a newline instead of submitting, inside in-pane TUIs like Claude Code and codex ([#258](https://github.com/openwong2kim/wmux/pull/258)).** xterm sends a bare carriage return for Ctrl+Enter — byte-identical to plain Enter — so a TUI couldn't tell the two apart and treated Ctrl+Enter as submit. wmux now emits a line feed for the Ctrl+Enter chord, matching the existing Shift+Enter and Ctrl+J newline keys. Surfaced after Reddit feedback.

## [3.6.0] — 2026-06-17 — A reply finds the exact agent that asked

Headline: same-workspace agents now reply to the *exact* pane that asked. A task's reply returns to its originating pane instead of the workspace's active one, same-workspace history finally tells the two agents apart (sender vs receiver, per pane), and a status update is restricted to the addressed pane — completing the pane-level multi-agent mesh that #239 and #242 began. Plus a fix for the terminal+browser split that blanked its unfocused side.

### Added
- **A2A symmetric reply — a reply returns to the exact pane that sent the task, and same-workspace history is told apart per pane (S-C2, [#248](https://github.com/openwong2kim/wmux/pull/248)).** Follow-up to same-workspace agent messaging ([#239](https://github.com/openwong2kim/wmux/pull/239)). The task address model was asymmetric: `to` carried a pane anchor ([#235](https://github.com/openwong2kim/wmux/pull/235)) but `from` did not — so a reply had no pane to return to (it fell back to the workspace's active pane, or was suppressed same-workspace), and same-workspace history role collapsed to `user` for both parties, making the two panes' messages indistinguishable. The hardening in [#242](https://github.com/openwong2kim/wmux/pull/242) already captured and validated the sender's pane id on the send path, then discarded it; persisting it into `metadata.from` opens three things with no new trust surface. **(1) Symmetric reply pinning** — a reply destined for the original sender now returns to that exact pane instead of the active-pane fallback, so a sender workspace running more than one agent gets the reply on the right pane (fail-closed if that pane has since closed — never a wrong-agent paste). **(2) Per-pane history role** — the role is computed from the caller's verified pane (`user` for the sender pane, `agent` for the receiver pane) instead of collapsing same-workspace. **(3) Pane-granular status authz** — a status update (`a2a_task_update`) on a pane-addressed task is restricted to the addressed receiver *pane*, not any pane in its workspace. A same-workspace reply is delivered as a one-line nudge to the addressed sibling — never a full-body paste into a live agent's prompt — and is suppressed entirely when it can't be proven a non-self target, so the [#239](https://github.com/openwong2kim/wmux/pull/239) self-loop guard is preserved. The headless `execute:true` worker (which carries no sender pane id) is never locked out: an absent caller pane always falls back to workspace-level authz. Cross-workspace delivery and role are unchanged.

### Fixed
- **Terminal + browser split no longer blanks the unfocused side ([#247](https://github.com/openwong2kim/wmux/pull/247)).** A pane holding both a terminal and a browser surface renders them in a side-by-side split, but each surface gated its visibility on the pane's single active-surface id — so focusing one side hid the other (`display:none`) and the unfocused pane went blank, toggling as you switched. Visibility is now decoupled from focus: both sides stay rendered, and the active-surface id only drives keyboard focus.

## [3.5.1] — 2026-06-17

### Fixed
- **`surface_list`/`pane_list` caller-scoping hardening ([#245](https://github.com/openwong2kim/wmux/pull/245)).** An omitted-workspace `surface_list`/`pane_list` now revalidates a stale cached workspace id after a re-mint (daemon respawn / session restore) and prefers a confirmed-external caller's pinned workspace over the UI-active fallback — so a fail-soft read reports the caller's own workspace instead of an empty list or whatever the user has focused. Follow-up to the codex review on [#242](https://github.com/openwong2kim/wmux/pull/242) ([#243](https://github.com/openwong2kim/wmux/issues/243)).

## [3.5.0] — 2026-06-17 — Multi-agent workspaces that talk to each other

Headline: a workspace full of agents that can finally coordinate. Same-workspace agents now message each other directly (#239), every pane is individually addressable (#235), and the identity layer is hardened (#242) so a message never loops into the wrong pane or silently routes to a duplicate-named workspace. The A2A task inbox moved onto the EventBus so cross-agent delivery no longer corrupts a live terminal (#232), and Fleet View gained a unified approval inbox to clear every blocked agent from one list (#234).

### Added
- **Same-workspace agent-to-agent messaging ([#239](https://github.com/openwong2kim/wmux/pull/239)).** Two agent panes in the *same* workspace can now message each other with `a2a_task_send` — previously hard-rejected as "cannot send to yourself". Addressed by pane/surface id; a true self-send (your own pane) and an ambiguous no-address send are still refused, and the cross-workspace fail-closed boundary is unchanged. The data-suffix that isolates a sandbox instance now propagates to child PTYs so an isolated instance never leaks onto the production pipe.
- **Multi-agent identity & addressing hardening ([#242](https://github.com/openwong2kim/wmux/pull/242)).** Closes the adjacent bug cluster that made a multi-agent workspace fragile. `terminal_send`/`terminal_send_key` now refuse an agent's own omitted-`ptyId` call instead of looping the paste into its own (or a non-deterministic sibling) pane. `a2a_whoami` answers per-pane — *which agent am I*, not the workspace's single aggregate label — so siblings are told apart. A duplicate workspace name is refused with both ids instead of silently routing to whichever came first. `surface_list`/`pane_list` report the caller's own workspace. A rejected A2A task transition explains the allowed next states. And a mis-propagated `WMUX_DATA_SUFFIX` fails loud instead of silently booting an isolated instance onto production data.
- **Pane-level A2A identity & addressing, plus multi-target MCP registration ([#235](https://github.com/openwong2kim/wmux/pull/235)).** A workspace running several agents exposes each pane as an individually addressable A2A target.
- **A2A task inbox on the EventBus — pollable cross-agent delivery that no longer corrupts a live terminal (S-C2 ②).** When one workspace's agent hands a task to another, the task is now teed onto the shared event ring, so the receiving agent can discover it by polling `wmux_events_poll` instead of having the message force-pasted into its terminal (which used to corrupt a running TUI's input box). The sender gets the status receipt — created → updated → cancelled — the same way. Delivery is strictly dual-party: only the two workspaces involved in a task ever see its events; a third workspace, and any workspace-less poll, see nothing. A receiver that is already running a live agent now gets a one-line nudge (a pointer to run `a2a_task_query`) instead of the full message body, so its prompt is never flooded — a receiver with no live agent still gets the full paste, so nothing regresses for peers that don't poll.
- **`a2a_discover` liveness hint (③).** Peers returned by `a2a_discover` now carry an advisory live/idle signal so an orchestrator can prefer an agent that is actually running. Advisory only — it never gates delivery.
- **Unified approval inbox in Fleet View — clear every blocked agent's out-of-band prompt from one keyboard-driven list (S-C2).** Fleet View's stubbed "Approvals" tab (`Ctrl+Shift+A`, then the Approvals tab) is now a single inbox of every approval currently holding the fleet hostage, each resolved through its own real path: MCP plugin permission prompts (an unconfirmed plugin requesting capabilities under enforce mode — several can stack at once, keyed distinctly, each row showing the declared capabilities with a per-row risk badge), and the A2A execute gate (a remote agent asking to spawn a `bypassPermissions` Claude CLI in your workspace, shown with its live 30-second auto-deny countdown and the sender→receiver context). Arrow to a row and press `Enter` to approve, `Backspace`/`Delete` to deny — except a row carrying a critical capability (e.g. terminal-content), which `Enter` will *never* grant: those require clicking the explicit Approve button, so scrolling a dense list can't blind-grant a dangerous permission. It's the same surface the old approval modal drove, kept in lock-step: resolving a prompt in the inbox or the modal clears it in the other, and a removal signal retires the row no matter how it was answered — through the old modal, by a coalesced sibling, or by a plugin disconnecting — so there are no phantom rows. While the Approvals tab is open it is the single surface (the modal is suppressed underneath it). Only the two out-of-band-resolvable sources appear here; an approval that can only be answered by typing into the pane stays jump-only rather than growing a dead Approve button.
- **Live output tail on Fleet View terminal cards.** Each terminal card now shows its pane's last ~3 output lines, so you can read what an agent is actually doing — and triage which blocked one to jump to first — without leaving the cockpit. It's a pure renderer derivation off state the store already holds (no new daemon traffic), and it works for background panes too — the ones rendered off-screen, which was the subtle part: a card for a pane you've never had on screen still shows its live tail.
- **`pane.split` honors an explicit `workspaceId` ([#238](https://github.com/openwong2kim/wmux/pull/238)).** A multi-agent orchestrator can split a specific (non-active) workspace's pane, with the new pane eagerly spawning its PTY rather than waiting to be focused.

### Fixed
- **Right-click paste yields to the app when it owns the mouse ([#241](https://github.com/openwong2kim/wmux/pull/241)).** A terminal app that has taken over the mouse (e.g. a TUI) now receives the right-click instead of having wmux intercept it for paste.

## [3.4.0] — 2026-06-15 — Fleet View, and Claude conversations that survive a reboot

Headline: two ways to lose less time on a multi-agent day. **Fleet View** is the cockpit — every agent across every workspace on one screen, the blocked ones floated to the top, one click to jump to where you are needed. And **X6 resume** closes the loop on reboot survival: a Claude pane no longer just comes back as a shell, it comes back offering to resume the *exact* conversation it was running — on every pane, not just the one you were watching, with the permission mode you had set. Plus an agent toolbar, and fixes for the Windows taskbar icon and the PowerShell 5.1 prompt hook. Thanks to [@matdac6](https://github.com/matdac6) (#228, #229) and [@snowyukitty](https://github.com/snowyukitty) (#227).

### Added
- **Fleet View — every agent across every workspace on one screen (S-C1).** Press `Ctrl+Shift+A` (or run "Open Fleet View" from the command palette) and the whole fleet snaps into one full-screen cockpit: a card for every pane across every workspace, sorted so the agents that want you float to the top. An agent paused mid-turn on a confirmation prompt — `awaiting_input`, the unattended-loop money state — sorts first, gets a yellow outline and a "needs your input" affordance, and a header chip tells you how many are waiting on you ("2 need you"). Idle terminals sink to the bottom and dim. Click a card — or arrow to it and press `Enter` — and you are there: it switches workspace, pane, and surface in one step and lands focus exactly where the agent is, reusing the same hardened jump the OS-toast notifications use (zoom coherence included). This is the screen you keep open while loops run unattended: walk away from six agents, glance once, jump straight to the blocked one.
- **Built as a pure derivation, not a new subsystem.** The grid reads state the renderer already holds — every workspace's full pane tree lives in the store — so there is no new daemon round-trip and no second copy of the truth to go stale; it reflects live agent status the moment the daemon detects it. Status resolves per-PTY first and scans *all* of a pane's tabs, so an agent waiting for you in a background tab is never silently shown as idle. The overlay traps keyboard focus (no stray keystrokes leak into the terminal underneath it) and is fully keyboard- and screen-reader-navigable (`role="dialog"`, roving `role="option"` cards). Output preview is status + workspace + path for now; a live output tail and the unified A2A + MCP approval inbox (the stubbed "Approvals" tab) are next.
- **`claude --resume <id>` after a reboot — the exact conversation, on every pane (X6 ③).** The resume pill now restarts the *exact* Claude session it was bound to (`claude --resume <session-id>`), with the permission mode you had set (so a `--dangerously-skip-permissions` workflow survives the reboot), instead of the cwd-relative `--continue` that could resume the wrong conversation when several panes share a directory. The binding — the pane's Claude conversation id, captured live from the hook — is persisted on the daemon session record and survives a hard SIGKILL. Crucially it works for *every* pane that ran Claude, not just the one whose startup banner the daemon happened to catch live: a captured hook now also lights the pill (so a pane whose banner was missed still offers a resume), each pane is attributed by its own daemon session id (so two panes in the same directory each resume their own conversation, never each other's), and a capture that couldn't reach the daemon at the moment it fired is spooled to disk and reconciled on the next boot. A purged transcript or a moved working directory degrades safely to `--continue` rather than a dead `--resume`.
- **A supervised agent pane resumes its conversation on restart and reboot (X6 ①).** When the daemon's pane supervisor (X8) re-creates a declared agent pane after a crash, a daemon restart, or a full reboot, it now relaunches the agent in *resume* form so the conversation continues where it left off, rather than starting a fresh agent in the same pane. The original launch command stays on the record; only the replay is rewritten, and the conversation binding is carried onto the recreated pane so a second crash before the next hook still resumes the exact session.
- **Agent toolbar — Attach, File explorer, Snippets, Rich Input, New** ([#228](https://github.com/openwong2kim/wmux/pull/228), thanks [@matdac6](https://github.com/matdac6)). A toolbar above the terminal with one-click access to attaching context, a file explorer, snippets, a rich-input composer, and opening a new pane.

### Fixed
- **The "Resume Claude" pill now survives a real reboot — even right after you start an agent.** A pane where you'd just typed `claude` could come back from an OS reboot with no resume pill. The daemon persisted the detected-agent marker (`lastDetectedAgent`) on a 30s debounce, and a real reboot is a hard SIGKILL — no graceful flush runs — so a reboot inside that window dropped the marker and recovery had nothing to offer. The single idle agent pane, exactly the reboot-survival headline case, was the one most likely to hit it. Agent detection now persists immediately (`saveImmediate`), bounded to one write per agent transition by the existing slug guard. The same gap affected live working-directory changes, and was strictly worse: the `session:cwd` handler persisted *nothing*, so a reboot could restore a pane to a stale directory and make the cwd-scoped `claude --continue` resume the wrong conversation. Working directory now persists immediately on an actual `cd` (guarded so a per-prompt OSC 7 re-report doesn't amplify writes). The previous offer dogfood seeded the marker straight into the snapshot, bypassing the detect→persist path entirely, which is why the race went unseen; a new kill-real dogfood drives real agent detection and then SIGKILLs the daemon inside the window to prove the fix end to end. A follow-on GUI dogfood then surfaced a **second, independent cause** on the renderer: even with the marker persisted and delivered to the renderer, a recovered pane's xterm focus-tracking report (`CSI I` / `CSI O`) arrives through `terminal.onData` on mount and was mistaken for the user typing, so `clearResumeHint` retracted the pill the instant it hydrated — meaning the pill had effectively never rendered after a reboot at all. Focus reports are now excluded from the retract path (real keys, pastes, and IME commits still retract as intended). Both fixes are required for the pill to actually appear.
- **The prompt hook now works on Windows PowerShell 5.1** ([#227](https://github.com/openwong2kim/wmux/pull/227), thanks [@snowyukitty](https://github.com/snowyukitty)). The OSC 7 / 7727 sequences that drive working-directory tracking and the prompt markers are now emitted with `[char]27`, which PowerShell 5.1 passes through correctly — previously the escape was mangled on 5.1, so the hook silently did nothing and cwd/branch tracking never updated on that shell.
- **The Windows taskbar icon is back** ([#229](https://github.com/openwong2kim/wmux/pull/229), thanks [@matdac6](https://github.com/matdac6)). The app icon had stopped rendering in the taskbar; `icon.ico` is now re-encoded with BMP frames so Windows draws it again.

## [3.3.0] — 2026-06-13 — supervised agent panes, 74% faster cold start, and a lighter idle footprint

Headline: a `wmux.json` pane can now declare a restart policy and the daemon supervises it like an init system — auto-restarted with backoff across process exits, daemon restarts, and full reboots, with a runaway guard so a crash-loop burns backoff instead of tokens (X8). Cold start is **74% faster** on the dev machine (5570 → 1176 ms; first contentful paint 5.2 → 0.65 s) after moving the auth-token ACL hardening off the boot critical path, loading the renderer in parallel with the daemon bootstrap, and adaptive readiness polling — with a new `wmux doctor` to diagnose a slow boot in one command. Plus a lighter idle footprint (lazy buffer allocation, visibility-gated metadata polling, pruned native prebuilds), a refined-terminal sidebar pass, and an awaiting-input signal for Claude Code's `AskUserQuestion` prompt. Thanks to [@matdac6](https://github.com/matdac6) for three contributions this cycle (#212, #218, #219).

### Added
- **wmux now signals when Claude Code is waiting on an `AskUserQuestion` prompt** ([#212](https://github.com/openwong2kim/wmux/pull/212), thanks [@matdac6](https://github.com/matdac6)). When Claude Code shows its multi-line boxed question UI inside a wmux pane, the pane's sidebar dot turns yellow and the awaiting-input sound fires — the same signal you already get for single-line approval prompts. Previously "awaiting input" was detected only by the regex `AgentDetector`, which is anchored to single-line prompts (`Do you want to proceed?`) and never matched the boxed `AskUserQuestion` layout, so a user who looked away got no cue that the agent was blocked on them. The fix is signal-based, not another regex: a `PreToolUse` hook scoped to the `AskUserQuestion` tool maps to the existing `awaiting_input` status (guarded on `tool_name` so a future broad matcher can't tunnel spurious signals). The dot clears automatically when you answer and the agent resumes. No new UI — it reuses the existing status, sound, and dot.
- **Cold-start boot-phase instrumentation (S-A).** The main process now emits one cheap `[boot-trace]` line per boot milestone (process spawn → module eval → app-ready → plugin load → daemon bootstrap with spawn/pipe/ping sub-phases → ready end), plus a JSON summary that lands in the daily log file; the daemon exposes its own boot marks through `daemon.ping`. The perf bench collects both and prints a derived phase-attribution table, so a cold-start regression now points at the guilty phase instead of a single opaque number. First run of the new table immediately attributed ~70% of the measured cold start to the auth-token ACL hardening's synchronous PowerShell shell-outs (one in the main process, one in the daemon) — the optimization target for the follow-up PR. Zero telemetry: stderr and local log files only.
- **`wmux doctor` — one-command diagnostics** ([#216](https://github.com/openwong2kim/wmux/pull/216)). A new CLI command that turns the boot-trace instrumentation into a user-facing health check: environment (version, pipes, auth token, data suffix, app-pipe reachability), daemon status over its **own** control pipe (pid, uptime, sessions, event-loop lag — diagnosable even when the main process is dead), the same boot-phase attribution table the perf bench prints (main + daemon-internal phases, parsed from the daily log's boot summary with a bounded tail read), an antivirus-tax hint when a cold-rescan phase exceeds 1.5 s, and today's error/warn counts for both log files. `--json` for scripts; exit 1 only when something actually failed. "wmux feels slow / won't start" reports can now begin with one command instead of log archaeology.
- **RAM attribution in the perf bench** ([#217](https://github.com/openwong2kim/wmux/pull/217)). The bench's flat RAM number now ships with a per-category breakdown (main / renderer / gpu / utility / daemon / conhost / user shells), a `--scrollback-lines` A/B seed, and a WebGL-context occupancy probe — all additive, nothing gated. First verdict from the data, recorded in `bench/README.md`: **about half the 8-pane footprint is the user's own shells**, the scrollback A/B delta on near-empty terminals is ~0 (xterm's buffer is lazily populated), and the GPU process is a single fixed cost — so the planned RAM-diet code work was cancelled by measurement before any code was written.
- **Pane supervision — the daemon keeps declared panes alive as exec-style units (X8).** A `wmux.json` pane can now declare `restart: on-failure | always` (with an optional `restartLimit`), and the daemon supervises that pane the way an init system supervises a service: when the process exits it is auto-restarted with exponential backoff, and a runaway guard halts supervision after N consecutive short-lived runs (it must be manually rearmed) so a tight crash-loop burns backoff instead of tokens. Because the supervisor is the daemon — which already survives app crashes and machine reboots — supervision is sticky: a supervised loop is restarted across daemon restarts and across a full reboot, so an unattended overnight loop comes back on its own after the machine cycles. Nothing supervises until you trust the file (same `wmux.json` trust gate); plain panes are unaffected.

### Changed
- **Cold start: the renderer now loads in parallel with the daemon bootstrap (S-A Step 1)** ([#215](https://github.com/openwong2kim/wmux/pull/215)) — **measured 1436 → 1176 ms (-18%) locally, 1441 → 989 ms (-31%) on CI; first contentful paint 1.08 s → 0.65 s.** Since the v2.13 first-keystroke race fix, the boot tail ran strictly serialized: wait for the daemon to spawn and connect, then start loading the renderer — stacking the two longest boot legs (~625 ms renderer, ~464 ms daemon bootstrap) back to back, with the window sitting on a blank background frame the whole time. The bootstrap is now kicked without awaiting and the renderer loads immediately, so the daemon spawn hides behind the renderer load. The race that forced the serialization (a renderer mounting mid handler-swap could mint a local-mode pty id and have its writes silently dropped — "first keystroke doesn't register" on fresh installs) is closed structurally rather than by ordering: the renderer's first ready-state query parks until the daemon-vs-local decision is final, and the pane gate keeps every terminal-create path shut until the startup reconcile completes. The one listener those defenses didn't cover (the late-reconcile trigger on `daemon:connected`, which previously could not fire before the renderer existed) is now gated on the pane gate, extracted, and unit-tested. Verified against the original regression scenario: 10/10 isolated cold boots with a keystroke fired the instant the terminal mounts, zero drops.
- **Cold start: adaptive daemon readiness polling (S-A C1)** ([#214](https://github.com/openwong2kim/wmux/pull/214)). After spawning the daemon, the launcher polled for readiness on a fixed 200 ms interval — boot traces showed ~93–199 ms of pure poll quantization between "daemon wrote its pipe file" and "launcher noticed" on every cold start. The poll is now an immediate first check followed by a 40 ms cadence for the first 2 s, backing off to the original 200 ms for slow-machine tails; the same span now measures 6–44 ms per cold run. The zombie-pipe guard, auth-token gate, 15 s budget, and the already-running-daemon yield path are preserved, and the loop is extracted behind a dependency-injected helper with fake-timer tests (it previously had none).
- **Cold start: auth-token ACL hardening moved off the boot critical path (S-A) — measured 5570ms → 1436ms (-74%) on the dev machine, first contentful paint 5.2s → 1.1s.** The boot traces attributed ~70% of cold start to the token-file ACL hardening's synchronous whoami + PowerShell shell-outs — once in the main process (PipeServer constructor, 2015ms median) and once in the daemon (3465ms, directly on the path the launcher polls). Three changes, none of which weaken the hardening guarantees:
  - **Re-hardening an existing token is now deferred and fully asynchronous.** The token VALUE doesn't change on re-harden, so an attacker who could exploit the brief deferred window could equally have read the file at any point of its prior on-disk lifetime under the same ACL — and the RPC surface is protected by the token value (timing-safe compare), not by the file ACL. The deferred path uses async `execFile`/`spawn` exclusively, so the multi-second shell-out can no longer stall the daemon's event loop either. Verified to converge to the same owner-only DACL (including removal of explicit `Everyone` ACEs) by the extended `scripts/issue-124-acl-dynamic.mjs` harness.
  - **Freshly created token files are hardened via icacls (~120ms) instead of PowerShell (~1-2s).** The #124 objection to icacls — it cannot remove a pre-existing explicit broad ACE — is unreachable on a file that did not exist before the write (it carries only inherited ACEs, which `/inheritance:r` strips). Overwrites of an existing file (token rotation, empty-file repair) keep the PowerShell-first DACL rebuild. Fail-closed semantics unchanged: if both primitives fail, the un-hardenable token is deleted and the write throws.
  - **McpRegistrar no longer rewrites an identical token file** at the end of the ready handler (the PipeServer constructor had just written the same value through the same secure path).
- **Lighter idle/background footprint — RAM, CPU, and package size** ([#219](https://github.com/openwong2kim/wmux/pull/219), thanks [@matdac6](https://github.com/matdac6)). Three independent reductions, all transparent to consumers: the daemon's per-session `RingBuffer` now allocates 64 KB up front and doubles toward the configured ceiling (default 8 MB) on demand instead of committing the full ceiling per session — idle/quiet sessions hold ~64 KB, chatty ones still grow to the ceiling with no scrollback lost; the 5 s per-PTY metadata poll (git / `gh` / `/proc` work that only feeds cosmetic UI) is now gated on `shouldPollMetadata()` and skipped while the window is destroyed, loading, hidden, or minimized, with the next visible tick refreshing within ≤5 s so staleness stays bounded; and `postPackage` prunes the non-target `node-pty` prebuilds (the win32-x64/arm64 ConPTY binaries are ~30 MB each), reclaiming ~28 MB+ per build across both node-pty copies, while defensively keeping everything if the target dir is missing.
- **Refined-terminal sidebar aesthetics** ([#218](https://github.com/openwong2kim/wmux/pull/218), thanks [@matdac6](https://github.com/matdac6)). A visual pass over the sidebar: the glyph icons (`⚙ ⧉ ✕ ▸`) across workspace rows, the mini-sidebar, and settings are replaced by a shared stroke-icon SVG module (`icons.tsx`) so every control scales crisply; the agent-status indicator now routes through `AGENT_STATUS_ICON`'s `dotVar`/`glowClass`/`mark` fields as a colored status dot with an animated glow plus a right-aligned play/pause mark; and token-derived depth, softened popover borders (`rounded-lg` + `color-mix`), row/popover enter animations, and a shared focus-ring helper round it out — every motion effect gated behind `prefers-reduced-motion`. Spec and plan under `docs/superpowers/`.

### Fixed
- **Token ACL hardening silently degraded to icacls when wmux was launched from PowerShell 7 (Store install).** The inherited `PSModulePath` leads with pwsh 7's Core-edition Modules directory, so the Windows PowerShell 5.1 child failed to auto-load its own `Microsoft.PowerShell.Management`/`Security` modules (`CommandNotFoundException` on `Get-Item`), and the #124 DACL rebuild — the only primitive that removes pre-existing explicit broad ACEs — never ran, falling back to icacls on every boot. The 5.1 child now gets `PSModulePath` stripped from its environment so it reconstructs its own default module path regardless of which shell spawned wmux. Found via the new boot traces: the measured "hardening cost" on a pwsh7-launched dev box was actually a failing PowerShell plus the fallback.

### Contributors
- **[@matdac6](https://github.com/matdac6)** — three contributions this cycle, on top of the workspace Rename context-menu item (#184): the `AskUserQuestion` awaiting-input notification ([#212](https://github.com/openwong2kim/wmux/pull/212)) — a clean signal-based fix with a root-cause writeup, a `tool_name` guard against spurious signals, and tests on the wmux side; the refined-terminal sidebar aesthetics pass ([#218](https://github.com/openwong2kim/wmux/pull/218)); and the lighter idle footprint across RAM, CPU, and package size ([#219](https://github.com/openwong2kim/wmux/pull/219)). Thank you!

## [3.2.0] — 2026-06-12 — wmux CLI on your PATH, wmux.json project config, click-to-jump notifications, perf gate

Headline: every shell — inside or outside wmux — gets a `wmux` command with verified self-pane identity; a repo-root `wmux.json` turns "open this repo" into a fully arranged workspace (custom commands + declarative pane layout) behind a byte-exact trust gate; clicking a desktop toast now jumps straight to the pane that fired it; and a benchmark harness with a CI regression gate puts real numbers behind the performance story (echo p95 29.2 ms, no degradation at 8 panes). Plus cross-workspace browser-close routing, a multi-image paste fix, and Smart App Control install guidance.

### Added
- **Clicking an OS toast now jumps to the pane that fired it (X2).** Desktop notifications — agent turn-ends, OSC 9/777/99 terminal notifications, process-exit errors, and external `wmux notify` calls — carry their originating pane context. Clicking the toast restores and focuses the window, switches to the owning workspace, activates the pane and the exact surface (tab) that produced the notification, marks its unread notifications read, and clears the attention ring. Toasts from `wmux notify --workspace <id>` jump to that workspace; if the source terminal closed between toast and click, the click degrades to the old focus-the-window behavior.
- **`wmux setup-hooks` — install Claude Code hooks without the marketplace plugin.** The plugin-less path to the deterministic agent-signal bridge: `wmux setup-hooks` installs the same 4 hook entries (`Stop`, `SubagentStop`, `SessionStart`, `PostToolUse`) directly into Claude Code's user settings (`~/.claude/settings.json`) and copies the bridge to a stable, update-proof location (`~/.wmux/hooks/wmux-bridge.mjs`) that the settings reference — never the versioned install dir, so it survives app updates. The merge is idempotent and surgical: it preserves all your existing hooks and every other settings key, and a corrupted settings.json aborts rather than clobbering your config. `--status` reports which events are wired, whether the copied bridge is stale (byte-compared against the bundled source), and warns if the marketplace plugin is *also* installed (which would double-fire signals); `--remove` deletes only the wmux-owned entries.
- **A1 performance benchmark harness + CI perf gate.** `scripts/perf-bench.mjs` measures what users feel against the packaged app: input latency (key→echo and key→frame, instrumented inside the renderer so CDP transport never pollutes the numbers; at 1 pane and 8 panes), cold-start milestones (spawn → pipe ready → renderer → first PTY data), and full-process-tree RAM including the detached daemon. Each run spawns the app in an isolated data namespace (`WMUX_DATA_SUFFIX`), so it can run alongside a live wmux, and shuts the daemon down cleanly afterwards. `scripts/perf-compare.mjs` gates regressions against blessed baselines (double-condition: ratio AND absolute margin) and `.github/workflows/perf.yml` runs the gate on PRs and appends a trend line to `bench/history.ndjson` on main. First measured numbers on the dev machine (i5-13420H): echo p95 29.2 ms, key→frame p95 44.1 ms, with no measurable degradation at 8 panes — baselines are descriptive measurements, never aspirational targets. See `bench/README.md`.
- **Project configuration via `wmux.json` (X5).** Drop a `wmux.json` at your repo root and wmux turns it into a per-project workspace: **custom commands** (`{"id": "dev", "title": "Dev server", "command": "npm run dev"}`) appear in the command palette and the sidebar's project dialog, and a **declarative pane layout** (nested `panes` with per-pane startup `command`, project-relative `cwd`, or a `url` for an embedded browser pane) is applied automatically when you open a fresh workspace in that repo — "open this repo → Claude Code + dev server + browser, arranged" with zero clicks. Discovery walks up from the workspace's live cwd and stops at the repo boundary. **Nothing executes until you trust the file**: wmux.json is checked into the repo, so the first discovery only *displays* — a review dialog shows every shell command verbatim, and the trust grant is bound to a hash of the exact bytes reviewed. Any later edit (e.g. a malicious PR changing a command) demotes the project to display-only until re-approved; "deny" is sticky until explicitly cleared.
- **`wmux` CLI on your PATH, with verified self-pane identity (X4).** The installer now drops a `wmux` command onto the user PATH (regenerated on every update, removed on uninstall), so any shell — inside or outside wmux — can script the app: `wmux send "npm test" --submit`, `wmux read-screen`, `wmux notify "Done" "Build finished"`, `wmux open http://localhost:3000`, `wmux split`, `wmux list-workspaces --json`. Run inside a wmux pane, terminal commands target **the pane you typed them in** — identity is resolved by walking the CLI's own process tree against the PID map (the same verified identity the MCP terminal tools use, never the spoofable/stale env hint), and the zero-spawn fast path covers the common shell-direct case. `--pane <ptyId>` targets another pane explicitly, `--active` keeps the old UI-focused-pane behavior, and notifications/browser opens route to the calling workspace automatically. The CLI client also gained the TCP-localhost fallback for Windows named-pipe ACL edge cases.

### Documentation
- **Smart App Control (SAC) install guidance** (#200, reported with a full diagnostic timeline by @alphabeen). On Windows 11 devices with SAC enforcing, the unsigned installer can be blocked outright — no SmartScreen dialog, no "Run anyway" — and the block can be transient (cloud reputation): the same binary may install successfully hours later with zero local changes. README (install section + FAQ) and `install.ps1` now explain how to confirm SAC is the cause (`Get-MpComputerStatus | Select-Object SmartAppControlState`, Code Integrity Event ID 3077) and the workarounds: winget/Chocolatey, retry later, or build from source.

### Changed
- **`a2a.resolve.identity` now returns pane-level `entries`** (`pid` + `ptyId` + `workspaceId`) alongside the existing `mappings` — additive; existing MCP clients are unaffected.

### Fixed
- **Pasting multiple images in a row no longer invalidates the earlier ones** (#201). Each image paste deleted the previous `wmux-paste` temp file, so pasting several screenshots into Claude Code left only the most recent path readable. Temp files now survive the session (a startup sweep removes stale ones older than 24h) and get a random suffix so rapid pastes can't collide.
- **`browser_close` / `wmux browser close` can no longer tear down a browser pane the user is viewing in another workspace.** `browser.open` was pinned to the caller's workspace in #193, but `browser.close` kept resolving "the browser pane" inside the UI-active workspace — an agent in workspace A issuing a close took down whatever browser the user happened to be looking at in workspace B, or got a spurious "not found" when B had none. Close now routes the same way open does: MCP resolves the calling workspace (fail-closed), the CLI uses its verified self-pane identity (with a `--workspace` override), and an explicit `surfaceId` — which is globally unique — is found across all workspaces. `surface.close` with an explicit id likewise no longer fails with "surface not found" when the surface lives outside the active workspace. Callers that pass no workspace at all keep the active-workspace behavior.

### Contributors
- **[@alphabeen](https://github.com/alphabeen)** — Smart App Control installation investigation ([#200](https://github.com/openwong2kim/wmux/issues/200)): a complete diagnostic timeline (registry state, Code Integrity 3077 events, the transient cloud-reputation behavior, and why v2.x was unaffected) that became the new SAC install guidance verbatim. Exemplary report — thank you!

## [3.1.1] — 2026-06-12 — browser pane wired into the workflow, IME input self-healing

Headline: the embedded browser pane is now reachable from where you actually work — terminal URLs route smartly, sidebar port badges open localhost in one click, and browser panes restore on the page you last visited. And the field-reported "keyboard input dies until you toggle multiview" IME failure on Korean Windows now self-heals: the suspect textarea-clearing is off by default and a storm guard detects the dead-input signature and resyncs the IME automatically.

### Added
- **The embedded browser pane is now wired into the terminal workflow (X3).** Clicking a URL printed in a terminal routes smartly: localhost / 127.0.0.1 URLs open in the workspace's embedded browser pane (reusing the existing pane and navigating it), external URLs open in the system browser, and Ctrl/Cmd+click inverts the choice. The sidebar's listening-port badges (X1) are now clickable — one click shows `http://localhost:<port>` in that workspace's browser pane, un-zooming any pane that would hide it. `target="_blank"` links inside the browser pane now work and open in the same pane (popup windows stay blocked). `Ctrl+Shift+L` and the palette's "Open Browser" keep their always-create-a-new-pane behavior.
- **Browser panes restore on the page you last visited.** Every navigation — toolbar, in-page links, agent-driven CDP navigations alike — is persisted per surface, so a session restore reopens each browser pane on its last URL instead of the one it was created with.

### Fixed
- **Keyboard input no longer dies until the terminal is remounted (Korean/CJK IME "claim storm").** Field report on v3.0.0: typing and arrow keys stopped reaching the terminal — clicking didn't help, only forcing multiview on and off (which remounts the terminal) recovered it. Mechanism: when the Windows IME's state desyncs from xterm's hidden textarea, it claims every keydown (`keyCode 229`) and xterm drops all of them. Two-part fix: (1) the v3.0.0 idle IME-textarea clearing (#167 protection for field-replacing voice injectors) is now **off by default** — its programmatic wipe of the IME-owned textarea is the prime suspect for the desync; it remains available under Settings → Terminal for AutoGLM-style tool users. (2) A new always-on storm guard detects the claim-storm signature (consecutive 229 keydowns across distinct keys with zero composition activity) and resyncs the IME with a blur/refocus — the remount cure, automated — surfacing a toast and a console diagnostic so the trigger can be confirmed in the field.
- **Session restore no longer leaves keyboard focus on nothing.** Restored terminals register for focus only after their async scrollback load, but the focus driver gave up after ~10 animation frames and the boot-time focus target never changes again — so on slower restores the app came up with DOM focus on `<body>` (typing went nowhere until a pane/workspace switch). Terminal registration now pushes a notification the focus driver subscribes to, one-shot, so late registrations still receive focus and later re-registrations can't steal it.
- **`browser.open` on an existing browser surface now actually navigates the webview.** The reuse path only rewrote store state, which the mounted webview never re-reads — the MCP call reported success while the page stayed put.
- **`browser.open` no longer resets an unspecified partition to the default.** The forced reset remounted the webview (the partition is part of its render key) and dropped the login session.

## [3.1.0] — 2026-06-12 — UI plugin host, workspace context sidebar, terminal notifications

Headline: wmux panes and sidebars are now extensible by third-party UI plugins running in sandboxed iframes under the same permission stack as MCP plugins; the workspace sidebar shows live zero-config context (git branch, PR status, process-scoped listening ports, latest notification); and standard terminal notification escape sequences (OSC 9/777/99) are parsed into first-class events. Plus a batch of rendering and MCP-routing fixes. All features dogfood-verified on a live build.

### Added
- **Workspace context sidebar (X1): live git branch, PR status, scoped listening ports, and latest notification per workspace — zero config.** The sidebar now shows each workspace's git branch via an `fs.watch` on `.git/HEAD` (no polling; linked worktrees detected and marked), the current branch's PR number/state/CI checks from a 5-minute `gh` cache (silently absent when `gh` isn't installed; click opens the PR), listening TCP ports matched against each pane's own process tree (previously the port list was machine-global — every workspace showed the same first-20 ports), and a one-line summary of the latest terminal notification. All context flows through the existing `workspace.metadata.changed` event, so MCP clients and plugins see the same data the sidebar does.
- **UI plugin host: sandboxed sidebar panels, status-bar widgets, pane badges, and palette commands.** Drop a bundle in `~/.wmux/plugins/<name>/` with a `manifest.json` and wmux hosts its UI in a sandboxed iframe (opaque origin, no network — the postMessage bridge is the only channel out). Plugin RPCs dispatch through the same permission stack as MCP plugins (trust DB, capability enforcement, approval prompts), with new capabilities `ui.sidebar` / `ui.statusbar` / `ui.pane-decoration` / `ui.commands` / `notifications.read`. Includes a reference plugin under `examples/plugins/hello-panel`. Verified end-to-end on a live build (approval flow → mount → bridge RPC → pane badge).
- **Terminal desktop notifications (OSC 9 / OSC 777 / OSC 99) are now parsed and surfaced as events.** Programs that emit the standard notification escape sequences — iTerm2-style OSC 9, urxvt `OSC 777;notify`, and the kitty OSC 99 desktop-notification protocol (including chunked and base64 payloads) — produce a new `notification.received` event on the event bus (pollable via `wmux_events_poll`) in both daemon and local PTY modes. ConEmu's OSC 9 progress subcommands no longer trigger spurious toasts, and notification text is sanitized and length-capped. Groundwork for the attention-ring / toast-routing notification system.

### Fixed
- **`surface_list` / `pane.list` no longer report a stale, workspace-wide cwd for every surface.** Each surface's own live working directory (OSC 7 / prompt scrape) is now authoritative; the workspace-level metadata cwd — which is just whichever active surface last changed directory — is only a fallback. Previously that single path was stamped onto every surface in the workspace.
- **Panes no longer turn into X-boxes or blank out after splitting / tab-switching through many content-heavy panes in a long session.** xterm's `WebglAddon.dispose()` detaches the renderer but never frees the underlying WebGL2 context, so split/tab churn accumulated zombie contexts past Chromium's ~16-context cap, force-evicting a *live* pane's context. Every addon teardown now force-releases its GL context immediately via `WEBGL_lose_context.loseContext()`. ([#199](https://github.com/openwong2kim/wmux/pull/199), resolves [#197](https://github.com/openwong2kim/wmux/issues/197))
- **Non-selected panes no longer render garbled or blank glyphs when switching pane selection.** After long use with content-heavy panes, switching the selected pane could corrupt the *other* panes. xterm's WebGL addon shares one glyph texture atlas across every same-config terminal (`CharAtlasCache`); the focus/visible defensive repaint called `clearTextureAtlas()`, which empties that **shared** atlas and rebuilds only the newly-focused pane — the siblings kept stale per-cell texture coordinates and sampled an emptied/repositioned atlas. The repaint now does a full-range `refresh()` only and never touches the shared atlas; the earlier "garbled glyphs after a burst" case ([#166](https://github.com/openwong2kim/wmux/issues/166)) was already covered by the burst-path refresh, which never cleared the atlas. ([#196](https://github.com/openwong2kim/wmux/pull/196), resolves [#191](https://github.com/openwong2kim/wmux/issues/191))
- **MCP workspace-identity resolution no longer blocks the event loop.** The identity PID-tree walk used a synchronous `execFileSync` per ancestor; it now walks the tree with async `execFile`, preserving the resolution result and the source invariant. ([#195](https://github.com/openwong2kim/wmux/pull/195), resolves [#194](https://github.com/openwong2kim/wmux/issues/194))
- **Playwright auto-open is pinned to the calling session's workspace.** `browser.open` without an explicit workspaceId opened the browser in whichever workspace happened to be active; the engine now resolves the calling session's workspace and fails closed instead of falling back to the active one. ([#193](https://github.com/openwong2kim/wmux/pull/193), resolves [#190](https://github.com/openwong2kim/wmux/issues/190))
- **Esc now reaches the terminal under a CJK IME.** While a CJK IME composition was active (keyCode 229), xterm dropped the Esc keystroke; wmux now matches the physical key code and injects Esc directly, the same class of fix as the Ctrl+J newline issue. ([#189](https://github.com/openwong2kim/wmux/pull/189))

### Contributors
- **[@zer0ken](https://github.com/zer0ken)** — WebGL context-leak fix ([#199](https://github.com/openwong2kim/wmux/pull/199)), shared-atlas pane-corruption fix ([#196](https://github.com/openwong2kim/wmux/pull/196)), non-blocking MCP identity walk ([#195](https://github.com/openwong2kim/wmux/pull/195)), and Playwright workspace pinning ([#193](https://github.com/openwong2kim/wmux/pull/193)).
- **[@snowyukitty](https://github.com/snowyukitty)** — CJK IME Esc fix ([#189](https://github.com/openwong2kim/wmux/pull/189)).

## [3.0.0] — 2026-06-10 — external-tooling foundation, PowerShell 7 by default, terminal UX, cross-workspace hardening

Milestone release. Headline: a reference plugin and workflow-friendly APIs that make wmux a foundation external tools build on, PowerShell 7 chosen as the default shell wherever it's installed (including Store builds), a batch of terminal UX (font zoom, configurable start directory, split CWD inheritance), and the close of the cross-workspace terminal read/write isolation gap. No breaking changes — this is a milestone version bump, not a wire-format or config break; existing sessions, profiles, and configs carry over untouched. All dogfood-verified on a live build before tagging.

### Added
- **Terminal starting directory + split CWD inheritance.** New panes can inherit the active pane's working directory on split, with a global/per-profile setting for the default startup directory and a toggle for inheritance — a priority chain that leaves the main process and daemon untouched. ([#177](https://github.com/openwong2kim/wmux/pull/177), resolves [#173](https://github.com/openwong2kim/wmux/issues/173) / [#174](https://github.com/openwong2kim/wmux/issues/174) / [#175](https://github.com/openwong2kim/wmux/issues/175))
- **Keyboard zoom for terminal font size.** `Ctrl+=` / `Ctrl+-` / `Ctrl+0` grow, shrink, and reset the terminal font, resolved from the physical key code so it's IME-safe, clamped to 12–24px. ([#172](https://github.com/openwong2kim/wmux/pull/172), resolves [#171](https://github.com/openwong2kim/wmux/issues/171))
- **Rename a workspace from the right-click menu.** A Rename entry on the workspace context menu, reusing the existing inline-rename flow (same as double-click). ([#184](https://github.com/openwong2kim/wmux/pull/184))
- **Substrate reference plugin and restructured docs.** A reference MCP plugin, Diátaxis-organized documentation, a drift fix, API codegen, and a performance characterization pass — closing the external-tooling API request and giving integrators a worked example to build against. ([#165](https://github.com/openwong2kim/wmux/pull/165), closes [#15](https://github.com/openwong2kim/wmux/issues/15))

### Changed
- **PowerShell 7 is preferred over Windows PowerShell 5.1 as the default shell** wherever it's installed — including Microsoft Store builds exposed only through the WindowsApps App Execution Alias. The alias is both detected (via reparse-point resolution; `existsSync` alone misses the 85-byte symlink stub) and actually launchable (the stub can't be spawned directly by node-pty, so wmux resolves it to the real package target). Shell resolution is now single-sourced between the main process and the daemon, so the two can't drift. ([#178](https://github.com/openwong2kim/wmux/pull/178), [#180](https://github.com/openwong2kim/wmux/pull/180), [#181](https://github.com/openwong2kim/wmux/pull/181), [#186](https://github.com/openwong2kim/wmux/pull/186); resolves [#176](https://github.com/openwong2kim/wmux/issues/176), [#179](https://github.com/openwong2kim/wmux/issues/179), [#183](https://github.com/openwong2kim/wmux/issues/183), [#185](https://github.com/openwong2kim/wmux/issues/185))

### Security
- **Cross-workspace terminal read/write via spoofable workspace identity is closed.** A token-holding external MCP client could spoof `WMUX_WORKSPACE_ID` to a victim workspace and, naming that workspace's ptyId, read or write its terminal — the main-side ownership assert only verified that the ptyId belonged to the (attacker-supplied) workspaceId, not that the caller was entitled to that workspace. **Part 1** gave `input.readScreen` the `assertWorkspaceOwnsPty` check its sibling handlers already had (it was the one terminal-IO handler that skipped it). **Part 2** removed the spoofable identity the assert trusts: terminal tools (`terminal_read` / `terminal_read_events` / `terminal_send` / `terminal_send_key`) now resolve their workspace from verified PID-mapped identity only, never the env hint — a genuine external caller gets a dedicated claimed workspace, an explicit foreign ptyId fails closed, and a boot-reconcile grace keeps a first-party caller from being misclassified during a daemon respawn. ([#164](https://github.com/openwong2kim/wmux/pull/164) + [#188](https://github.com/openwong2kim/wmux/pull/188), resolves [#163](https://github.com/openwong2kim/wmux/issues/163))

### Fixed
- **Prefix-mode Toggle Zoom now actually zooms.** The tmux-style prefix Toggle Zoom toggled internal state but no rendering code read it, so the keystroke was consumed with no visible change. The zoomed pane is now rendered full-bleed (siblings hidden) and exactly restored on toggle-off, with split/close coherence and a ZOOM badge. ([#187](https://github.com/openwong2kim/wmux/pull/187), resolves [#182](https://github.com/openwong2kim/wmux/issues/182))
- **Garbled glyphs clear without a manual resize.** Panes could render corrupted glyphs until a border drag forced a repaint; wmux now repaints defensively. ([#168](https://github.com/openwong2kim/wmux/pull/168), resolves [#166](https://github.com/openwong2kim/wmux/issues/166))
- **IME input no longer wipes the typed line.** xterm's hidden IME textarea is cleared when idle, so a voice/IME input method (e.g. AutoGLM) no longer discards the already-typed line. ([#170](https://github.com/openwong2kim/wmux/pull/170), resolves [#167](https://github.com/openwong2kim/wmux/issues/167))
- **Sidebar hide/expand controls mirror correctly when docked on the right.** ([#160](https://github.com/openwong2kim/wmux/pull/160))
- **The `@electron/asar` header cache is dropped after the postPackage repack**, so the packaged asar can't be stale. ([#161](https://github.com/openwong2kim/wmux/pull/161))
- **Restored the bench B3 drop-tracking variables** lost in an earlier refactor and refreshed the perf numbers. ([#169](https://github.com/openwong2kim/wmux/pull/169))

### Contributors
Thanks to the external contributors and reporters in this release:
- **[@matdac6](https://github.com/matdac6)** — workspace Rename context-menu entry ([#184](https://github.com/openwong2kim/wmux/pull/184)), first contribution.
- **[@zer0ken](https://github.com/zer0ken)** — PowerShell 7 default-shell fixes ([#178](https://github.com/openwong2kim/wmux/pull/178), [#181](https://github.com/openwong2kim/wmux/pull/181)) and the issues behind the shell-resolution and CWD work ([#176](https://github.com/openwong2kim/wmux/issues/176), [#173](https://github.com/openwong2kim/wmux/issues/173) / [#174](https://github.com/openwong2kim/wmux/issues/174) / [#175](https://github.com/openwong2kim/wmux/issues/175), [#183](https://github.com/openwong2kim/wmux/issues/183), [#185](https://github.com/openwong2kim/wmux/issues/185)).
- **[@Dzirik](https://github.com/Dzirik)** — Toggle Zoom bug report ([#182](https://github.com/openwong2kim/wmux/issues/182)).
- **[@arcqiufeng](https://github.com/arcqiufeng)** — terminal zoom shortcut report ([#171](https://github.com/openwong2kim/wmux/issues/171)).
- **[@zhenzoo](https://github.com/zhenzoo)** — garbled-glyph ([#166](https://github.com/openwong2kim/wmux/issues/166)) and IME line-wipe ([#167](https://github.com/openwong2kim/wmux/issues/167)) reports.
- **[@alphabeen](https://github.com/alphabeen)** — external-tooling API request ([#15](https://github.com/openwong2kim/wmux/issues/15)).

## [2.18.0] — 2026-06-09 — terminal fonts, color customization, settings polish

Headline: pick any installed terminal font (and ship the recommended ones so they work everywhere), a point-and-style color inspect mode for theming, and a settings UI polish pass. All dogfood-verified on a live build before tagging.

### Added
- **Pick any installed terminal font.** The font setting is now a combobox over every font installed on the machine — click to browse the full list (each option rendered in its own face), type to filter, with a live Latin+Hangul preview so you can confirm a mixed-mono font has fixed-width CJK glyphs before committing. A separate "custom" entry mode takes any family name by hand for not-yet-installed fonts. Fixes a silent `powershell.exe` ENOENT (a bare-name spawn that failed to resolve under Electron) which had made the installed-font enumeration return nothing — so the feature never actually worked before this. ([#155](https://github.com/openwong2kim/wmux/pull/155), resolves [#147](https://github.com/openwong2kim/wmux/issues/147))
- **Bundled terminal fonts.** JetBrains Mono, Fira Code, and JetBrainsMonoHangul now ship with the app (alongside the existing Cascadia Code/Mono), so the recommended fonts — including fixed-width Hangul — work on every machine without a manual install. All under the SIL Open Font License 1.1; license texts are bundled and listed in THIRD_PARTY_NOTICES. ([#158](https://github.com/openwong2kim/wmux/pull/158))
- **Point-and-style color inspect mode.** Click a chrome region to recolor it by theme token, with contrast-safety checks so a custom palette stays readable. ([#156](https://github.com/openwong2kim/wmux/pull/156))

### Changed
- **Settings tabs use SVG line icons** in place of the dated unicode glyphs. ([#148](https://github.com/openwong2kim/wmux/pull/148))
- **Settings design-system pass** — shared primitives, accessibility fixes, and tab-label i18n. ([#150](https://github.com/openwong2kim/wmux/pull/150))
- **i18n:** Claude integration and first-run setup tab bodies are now translated across 21 locales ([#152](https://github.com/openwong2kim/wmux/pull/152)); the color customization strings across 22 locales ([#157](https://github.com/openwong2kim/wmux/pull/157)).

### Fixed
- **Ctrl+J inserts a newline even with a CJK IME active.** Inside in-pane TUIs (codex, Claude Code) Ctrl+J intermittently failed to add a newline — it worked with the IME off and broke with a Chinese / Japanese / Korean IME on. The byte pipeline below xterm is transparent to `\n`; the keystroke was lost at xterm's keyboard layer, which derives Ctrl+&lt;letter&gt; from the deprecated `KeyboardEvent.keyCode`. With the IME enabled the keydown reports `keyCode === 229` ("Process") with `key !== 'j'`, so xterm's `65–90` branch never matched and emitted nothing. wmux now resolves the newline keys (Shift+Enter, Ctrl+J) from the physical `event.code` and writes the byte itself — the same IME-safe approach already used for the split shortcuts — so Ctrl+J sends `\n` regardless of IME state. It defers while an IME composition is active (so a preedit is never split) and when the user has bound Ctrl+J to a custom keybinding. xterm 6 has no kitty/modifyOtherKeys path, so the emitted byte matches its legacy output when no IME is active. ([#153](https://github.com/openwong2kim/wmux/pull/153))
- **`--squirrel-firstrun` no longer becomes a never-quitting zombie.** On Windows the Squirrel first-run hook was misclassified, so the process neither initialized nor quit, leaving an idle GPU/network process behind after install. ([#154](https://github.com/openwong2kim/wmux/pull/154))

### Contributors
Thanks to the external contributors in this release:
- **[@zer0ken](https://github.com/zer0ken)** — SVG settings-tab icons ([#148](https://github.com/openwong2kim/wmux/pull/148)) and the font picker proposal ([#147](https://github.com/openwong2kim/wmux/issues/147)).
- **[@snowyukitty](https://github.com/snowyukitty)** — Ctrl+J newline fix under CJK IME ([#153](https://github.com/openwong2kim/wmux/pull/153)).

Bundled fonts under the SIL Open Font License 1.1: JetBrains Mono (The JetBrains Mono Project Authors), Fira Code (The Fira Code Project Authors), and JetBrainsMonoHangul (Janghyub Seo).

## [2.17.1] — 2026-06-08 — MCP pane-lifecycle fixes

Two small MCP fixes on top of v2.17.0, both dogfood-verified on a live build before tagging.

### Fixed
- **`browser_close` no longer leaves an empty pane behind.** The UI close path removes a pane when its last surface is closed, but the MCP mirror only closed the surface — leaving an empty leaf that the "auto-create initial surface" effect backfilled with a fresh terminal. A `browser_open`/`browser_close` loop accreted blank PowerShell panes. The handler now snapshots whether the closed surface was the pane's last one *before* removing it, then cascades into `closePane` to mirror the UI path. A browser sharing a split pane with a terminal still only loses the surface; a browser that is a workspace's only (root) pane still gets an auto-terminal, matching the UI exactly. ([#144](https://github.com/openwong2kim/wmux/pull/144))
- **Stale pid-map anchors are pruned on workspace/pane close.** The pid→ptyId anchor that backs MCP workspace-identity resolution was only pruned on `session:died`, so closing a workspace or pane through the UI (the `destroySession` path) leaked its anchor. Over time those stale entries could mis-resolve a ghost workspace identity. Closing now prunes the anchor immediately, in lockstep with the session teardown. ([#142](https://github.com/openwong2kim/wmux/pull/142))

## [2.17.0] — 2026-06-07 — security hardening sweep, packaged browser fixes, workspace UX

The big batch since v2.16.2. Headline: a security-hardening sweep across the daemon, MCP, A2A, release pipeline, and browser surfaces — most of it surfaced by an external codex security scan, with each finding triaged and adversarially verified before merge (a chunk turned out to be false-positives or duplicates and were closed rather than merged). Plus a set of fixes that make the embedded browser tools work on packaged builds, per-workspace environment/startup profiles, and the workspace-management UX that profiles implied (duplicate, per-terminal working directories). No config changes required — defaults are unchanged.

### Added
- **Per-workspace process profiles.** Each workspace can define environment variables and an optional startup command, applied to **new panes only** — existing and recovered daemon PTYs keep their create-time environment. Right-click a workspace → "Configure profile…". Generic by design (no provider hardcoding): point `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, SSH wrappers, etc. at different accounts per workspace. This is environment separation, not an OS-level security sandbox. See [docs/workspace-profiles.md](docs/workspace-profiles.md) for setup and multi-account recipes. ([#101](https://github.com/openwong2kim/wmux/pull/101), [#103](https://github.com/openwong2kim/wmux/pull/103))
- **Workspace management actions.** Right-click a workspace to **duplicate** it — the layout (fresh pane/surface ids, cleared ptyIds so new panes spawn their own PTYs) and the profile (re-normalized through the secret-name policy) are cloned as `<name> (copy N)`. A new **Working directories** menu lists each terminal's live cwd with copy; every terminal now **tracks its own cwd** (shown in the tab tooltip), terminal tabs can be **renamed** (double-click), and an accidental workspace close is **guarded by a confirmation**. New-pane semantics throughout, consistent with the profile contract. ([#141](https://github.com/openwong2kim/wmux/pull/141))

### Security
- **Token-file ACL grants by the labeled SID.** `getCurrentUserSid` parsed the first SID-shaped substring of `whoami` output, so a SID-shaped account or machine name (e.g. `S-1-1-0` = Everyone) could be granted the auth-token ACL instead of the real owner, leaving the token world-readable. It now parses the explicit `SID:` field. ([#118](https://github.com/openwong2kim/wmux/pull/118))
- **Token-file DACL is rebuilt owner-only, even on the upgrade path.** The shipped `icacls /grant:r … /inheritance:r` only replaced the named principal's ACE and stripped *inherited* ACEs, so a pre-existing **explicit** broad ACE (e.g. `Everyone:(R)` from a redirected/roamed/MDM profile) survived and left the token world-readable. The DACL is now rebuilt with a .NET DACL-only primitive (no owner/group/SACL writes, so it needs no privilege and succeeds on the upgrade-from-icacls state), with icacls as a fail-closed fallback when PowerShell is blocked. ([#140](https://github.com/openwong2kim/wmux/pull/140))
- **MCP approvals bind to the reviewed capability snapshot.** A plugin could redeclare broader capabilities while an approval prompt was pending and get trusted for a set the user never saw (a TOCTOU between consent and call). The approval now pins the exact capabilities shown in the dialog. ([#122](https://github.com/openwong2kim/wmux/pull/122))
- **Terminal drops are restricted to wmux drag sources.** Text dragged from a browser or another app no longer routes straight into a terminal PTY (where embedded newlines could auto-run at a shell prompt); only internal wmux drags — sidebar, surface tabs, file tree — write to the pane. ([#123](https://github.com/openwong2kim/wmux/pull/123))
- **Default MCP terminal resolution fails closed.** A spoofable `WMUX_WORKSPACE_ID` env hint or a failed workspace claim could fall back to the user's active pane, i.e. cross-workspace keystroke injection/read. Terminal tools now require a verified, PID-mapped identity and refuse the env hint, throwing rather than touching the focused pane. ([#125](https://github.com/openwong2kim/wmux/pull/125))
- **A2A sender identity is authoritative.** Company A2A `send`/`broadcast` no longer accept a caller-supplied `from`; the sender is derived from the authenticated workspace, so one agent can't impersonate another (or the CEO) when delivering a message into a peer's terminal. ([#129](https://github.com/openwong2kim/wmux/pull/129))
- **Inter-agent PTY delivery is bracketed-paste wrapped.** A2A messages written into a peer's terminal are bracketed and ESC-sanitized so an embedded newline can't submit a command in the receiving shell. ([#132](https://github.com/openwong2kim/wmux/pull/132))
- **Remote SOUL prompt loading is disabled.** Company agent personas were fetched from a third-party URL at spawn and written verbatim into the agent's instruction file — a remote prompt-injection / supply-chain path into command-capable agents. Spawning now uses the built-in role prompts only. ([#131](https://github.com/openwong2kim/wmux/pull/131))
- **RPC browser profile switching is scoped.** An RPC caller could mount an arbitrary Electron persistent partition or the human's pre-seeded `login` session store (reading its cookies over CDP). Profile names are now validated and RPC selection is restricted to a safe allowlist. ([#133](https://github.com/openwong2kim/wmux/pull/133))
- **IPv6 navigation SSRF hardening.** The navigation URL validator now un-brackets and bit-masks IPv6 literals (unique-local, link-local, IPv4-mapped), closing a bracket bypass that reached internal addresses through the `browser_tabs` new-tab path. ([#137](https://github.com/openwong2kim/wmux/pull/137))
- **Bundled first-party MCP server runs under enforce mode.** Under packaged enforce mode the bundled server was denied because it never went through declare/approve, so wmux's own tools were locked out. A name-recognized, scoped allowlist lets the first-party tools run without opening the gate to third-party servers. ([#109](https://github.com/openwong2kim/wmux/pull/109))
- **Release pipeline hardening.** The release tag is passed through `env:` instead of being interpolated into a shell `run:` block (Actions script-injection); the SignPath token is scoped to the signing step instead of the whole job; third-party release actions are pinned to immutable commit SHAs; WinGet publishing moved to a least-privilege job; and the installer fails closed when the checksum manifest is missing or invalid. ([#119](https://github.com/openwong2kim/wmux/pull/119), [#120](https://github.com/openwong2kim/wmux/pull/120), [#121](https://github.com/openwong2kim/wmux/pull/121), [#126](https://github.com/openwong2kim/wmux/pull/126), [#135](https://github.com/openwong2kim/wmux/pull/135))
- **Recursive IPC error-log redaction.** The structured IPC error logger now redacts sensitive keys at any depth, redacts startup-command values, and summarizes env maps to a key count — so workspace-profile env/commands flowing through `pty:create` can never leak into `args_summary`. Profile env is also kept out of the copy-session-info / drag-export markdown, and reserved `WMUX_*` keys are rejected so a profile can't spoof workspace identity. ([#103](https://github.com/openwong2kim/wmux/pull/103))
- **Child shells never inherit a stale wmux identity.** A wmux launched from inside a wmux pane (e.g. `npm start` while dogfooding) inherited the parent pane's `WMUX_WORKSPACE_ID` / `WMUX_SURFACE_ID` / `WMUX_SOCKET_PATH` in its own environment, which could survive into freshly created child shells. The whole reserved `WMUX_*` namespace is now cleared from the spawn baseline before identity is forced, so a child's identity is only ever what wmux explicitly sets — the spoofing guarantee is now unconditional, not profile-only. ([#141](https://github.com/openwong2kim/wmux/pull/141))

### Fixed
- **Embedded browser tools work on packaged builds.** On packaged builds `getPage()` can't surface the `<webview>` guest as a Playwright `Page`, so a swath of browser tools failed with `No browser page available`. They now fall back to the main-process CDP/RPC channel: DOM tools read the real webview instead of the wmux app shell ([#104](https://github.com/openwong2kim/wmux/pull/104)), extraction/snapshot ([#105](https://github.com/openwong2kim/wmux/pull/105)), console/network/response-body capture ([#106](https://github.com/openwong2kim/wmux/pull/106)), `browser_extract_data` field mapping ([#110](https://github.com/openwong2kim/wmux/issues/110)), cookies/storage/emulate/resize ([#111](https://github.com/openwong2kim/wmux/issues/111)), geolocation grants + reset semantics ([#112](https://github.com/openwong2kim/wmux/pull/112)), and `browser_wait` ([#114](https://github.com/openwong2kim/wmux/pull/114)). `browser_open`/`session_start` route through `requireWorkspaceId` so the browser opens in the calling workspace, not the active one ([#96](https://github.com/openwong2kim/wmux/pull/96)).
- **Memory-leak audit survivors.** Three real leaks found in a leak audit are now bounded: the MCP capture buffer (a Page-keyed WeakMap), the A2A GC hard cap, and PTY listener cleanup. ([#102](https://github.com/openwong2kim/wmux/pull/102))
- **Per-terminal working directory is reported correctly (local and daemon mode).** The tab tooltip and the workspace "Working directories" menu showed each shell's startup home directory (e.g. `C:\Users\me`) for every PowerShell regardless of where it had `cd`'d. Two compounding parser bugs are fixed: OSC 7 left Windows paths as `/C:/Users/me` (leading slash, forward slashes), and prompt detection matched the stale echoed prompt and froze the reported cwd at startup. Parsing is extracted into a unit-tested `cwdDetect` module (shared by both spawn paths) that normalizes the OSC 7 URI to a native path — including UNC shares — and reads the live (last) prompt. Daemon mode additionally never forwarded its detected cwd to the renderer; a new `session:cwd` event now closes that gap so daemon-backed panes live-update like local ones. ([#141](https://github.com/openwong2kim/wmux/pull/141))
- **Tighter workspace right-click menu.** The context menu was pinned to a fixed minimum width, leaving a wide blank gutter beside short items (and an oversized gap before the "Working directories" submenu arrow); it now sizes to its content. ([#141](https://github.com/openwong2kim/wmux/pull/141))

### Contributors

This release leaned on the community — two external contributors landed real features and fixes, not just reports.

**[@junbeom09](https://github.com/junbeom09) (조준범)** carried forward the packaged-build hardening he started in 2.16.2. Dogfooding the packaged app, he found the browser DOM tools were silently reading the wmux app shell instead of the embedded `<webview>` — a bug that never reproduces in a dev build — and contributed the runtime shell-detection fix (#104). He then verified the CDP capture and geolocation fallbacks (#108/#112) on a real install, confirming the exact paths CI can't prove. Fixes and reports from real-world setups a single maintainer never sees are how wmux gets more robust.

**[@snowyukitty](https://github.com/snowyukitty)** had the busiest release of anyone. He built per-workspace process profiles end to end (#101), then followed up after review with path-pointer credential-var allowlisting and non-destructive profile loading so an existing profile is never clobbered on load (#103). He shipped the workspace-management UX that profiles implied — duplicate workspace, the working-directories menu, per-terminal cwd tracking, tab rename, and close confirmation — and fixed the OSC 7 / prompt-detection cwd bugs and the child-shell identity-inheritance leak along the way (#141). He also split the Vitest runtime lane (#97) so timing-sensitive tests run serially instead of flaking under parallel load.

The security-hardening sweep (#118–#137) was surfaced by an external codex security scan; each of the 20-plus findings was triaged and adversarially verified before landing, with false-positives and duplicates closed rather than merged. The token-file ACL rebuild (#118 plus the DACL-only primitive in #140) was additionally dogfooded against a real `%USERPROFILE%\.wmux` descriptor — a directory that grants SYSTEM and Administrators inherited FullControl — to confirm the hardened token comes out owner-only with no self-lockout.

Maintained by [@openwong2kim](https://github.com/openwong2kim), with engineering and code-review pairing by Claude (Anthropic). Thanks to everyone filing issues and dogfooding. 🙏

## [2.16.2] — 2026-06-03 — daemon hardening: security, split-brain fix, configurable lifecycle

Bundles everything merged since v2.16.1: a token-file permission hardening (security), the duplicate-daemon / split-brain fix behind the "relaunch resets my terminals" bug, configurable daemon lifecycle thresholds, and idle-reap diagnostics. No config changes are required — defaults are unchanged.

### Security
- **Token-file ACL is applied by owner SID, not username.** The daemon auth-token file's ACL was tightened by passing the account name to `icacls`, which mojibakes under the OEM codepage for non-ASCII (e.g. Korean) usernames and could lock the owner out of their own token. The ACL is now keyed by the owner's SID, with an ASCII-only fallback guard. (#90)

### Fixed
- **No more duplicate daemon / split-brain on relaunch.** "Quit (keep sessions) → relaunch" could spawn a second daemon that fell back to a `-N`-suffixed pipe, leaving the first daemon's session pipe in `EADDRINUSE` and the UI unable to reattach — terminals appeared to reset. A three-defect chain is closed: `isProcessAlive` swallowing its probe error into `false`, the canonical-pipe reclaim conflating a live owner with a zombie, and the `-N` fallback itself. A confirmed live owner on the canonical pipe now makes the redundant daemon exit cleanly so the launcher reconnects to the existing one. (#93)
- **`maxSessions` counts only live sessions.** Dead tombstones no longer occupy slots against the cap, so a low `maxSessions` won't be exhausted by sessions that have already exited. (#92)
- **Recovered sessions keep their saved dead-TTL.** A recovered session preserves the dead-session TTL it was created with instead of silently inheriting the current default. (#92)

### Added
- **Configurable lifecycle thresholds.** Five daemon limits became config keys with the former hardcoded values as defaults: `maxSessions` (200), the memory `warn`/`reap`/`block` triple (500/750/1024 MB), and `suspendedTtlHours` (7d). Out-of-range or malformed values are clamped per-field — not whole-file reset — with a startup warning, so a single bad value can't brick the daemon. `maxRecoverSessions` is derived from `maxSessions` rather than configured separately. Documented in PROTOCOL.md §7–§8. (#92)
- **Idle-shutdown diagnostics.** When the daemon is held alive past its grace window, the watchdog now logs which signal is keeping it up (active connections vs. live sessions) or that it is counting down to self-terminate, so a daemon that fails to reap an empty session set can be diagnosed from its log instead of a live-process inspection. (#95)

### Contributors

Special thanks to **[@junbeom09](https://github.com/junbeom09) (조준범)** for the token-file ACL hardening (#90). He hit the non-ASCII-username lockout firsthand: a Korean account name turned the `icacls` principal into mojibake under the Windows OEM codepage and locked the owner out of their own auth token. He traced the root cause and contributed the SID-based fix that makes the hardening codepage-proof for every user. Reports like this, from real-world setups a single maintainer never sees, are exactly how wmux gets more robust. 🙏

Maintained by [@openwong2kim](https://github.com/openwong2kim), with engineering and code-review pairing by Claude (Anthropic). Thanks as always to everyone filing issues and dogfooding the daemon-lifecycle work.

## [2.16.1] — 2026-06-01 — daemon false-death fix, resize console-spam fix

A stability patch. The headline: on slow or loaded machines the daemon's process monitor could mistake a probe timeout for a dead process and reap a session that was actually alive, so sessions appeared to close on their own. That's fixed. It also quiets an `Uncaught (in promise)` console flood on relaunch and adds session-death logging so future "why did my session close" reports are diagnosable.

### Fixed
- **Live sessions are no longer killed on a probe timeout.** ProcessMonitor treated a slow or timed-out `tasklist` probe as proof the process had died and reaped the still-alive session — the cause behind sessions closing by themselves under CPU contention or a Defender scan. It now reaps only on positive confirmation of death; a probe that fails or times out defers instead of killing.
- **No more `Uncaught (in promise)` flood on relaunch.** A burst of terminal resizes during reconnect could exceed the daemon's per-socket rate limit, and the renderer never caught the rejection, spamming the console. Resize calls now swallow the transient rejection and re-send the live geometry once after the rate window clears, so a resize dropped during the burst self-heals instead of leaving the terminal stuck at the wrong size.

### Added
- **PTY session-death logging.** When a session dies the daemon now logs its exit code, signal, and idle time, so an unexpected session close can be diagnosed from the log instead of guessed at.

## [2.16.0] — 2026-05-30 — tmux-style persistence, blank-relaunch fix, multiline-paste fix, stability batch

Bundles everything merged since v2.15.0 (#81, #84). The headline is tmux-style persistence — closing the window now keeps your daemon and sessions alive and reattaches them on next launch — plus the fix for recovered sessions rendering blank on relaunch, a multiline-paste fix for PowerShell, and a batch of dogfood-driven stability and UX changes.

### Added
- **Quit keeps your sessions running.** The tray now offers "Quit (keep sessions running)" — it detaches the UI while the daemon and all PTYs survive, and the next launch reattaches them — plus a separate "Shut down wmux (close all sessions)" for a full teardown. This is the tmux model the README always described.
- **`Ctrl+Shift+Arrow` moves focus** between panes (and between grid tiles in multiview) in all four directions. Bare `Ctrl+Arrow` is intentionally unbound.
- **Completion blink.** A pane whose agent just finished (or is waiting / awaiting input) blinks its border, and its background tab shows a status dot, so you can see which terminal needs you without hunting. Clears on focus; respects `prefers-reduced-motion`.

### Changed
- **Quit now detaches instead of killing the daemon.** `before-quit` previously tried to shut the daemon down on every quit (the opposite of tmux), and a hung handler could orphan it. The default quit now only detaches; full shutdown is explicit and guaranteed to exit.
- **RAM readout is real RSS** (`app.getAppMetrics` working-set sum) instead of the renderer's JS heap, so the StatusBar number reflects actual process memory.
- **Removed the token-usage chip.** The regex-scraped per-pane token estimate was unreliable and is gone, along with its IPC and tracker. The measured 5h / 7d usage-percentage widget stays.
- **Right-click copy keeps the selection** and no longer collides with the paste gesture (a fast second right-click used to paste over a just-copied selection).
- **Multiline paste into PowerShell** inserts a clean multiline command instead of injecting whitespace at every line break (see Fixed).

### Fixed
- **Recovered sessions no longer render blank on relaunch (#81).** Daemon reattach ran inside the terminal-creation effect behind an `isCurrent` guard evaluated before the effect assigned the terminal ref, so `pty.reconnect` never fired (live daemon sessions, zero attach). Reattach moved to a dedicated effect that runs after the ref is set and also fires on `daemon:connected` (late-connect / respawn).
- **Orphan daemon on quit.** A hung `before-quit` pipe-close could leave `wmux.exe` running after the window closed; full shutdown now force-exits within a bounded timer.
- **Multiline paste injected whitespace in PowerShell (#84).** `normalizePasteText` collapsed every newline to a lone CR, but inside a bracketed-paste body PSReadLine treats CR as Enter and misplaces the cursor (PSReadLine #3939, #417, which both recommend LF). It now emits LF as the in-body separator when bracketed (CR otherwise), fixing all four paste paths (Ctrl+V, Ctrl+Shift+V, right-click, Shift+Insert / `onData`). Verified against real pwsh 7.6 / PSReadLine 2.4.5.
- **`prefix` + arrow keys.** Session load now merges the saved prefix config over the defaults instead of replacing it wholesale, so arrow-key pane-focus bindings survive a reload.
- **WebGL context thrash.** An LRU pool (max 12) caps live WebGL terminal contexts, preventing the "too many contexts" eviction that could blank panes when 16+ are visible at once.

### Security
- **Paste-injection guard (#84).** The bracketed-paste body sanitizes a raw ESC to `U+241B`, so pasted text can no longer forge the `ESC[201~` close marker and run trailing bytes as a command.

### Docs
- Dropped the removed `Ctrl+Up/Down` scroll-bookmark jump shortcut from the README. `Ctrl+M` marking and the gutter indicators still work.

## [2.15.0] — 2026-05-29 — Hook-RPC flood fix, view-switch perf, install/updater hardening

Fixes the user-reported "freezing under load" and view-switch lag found via a dogfood-log RCA, finishes the remaining session-reliability hardening from the v2.14.0 RCA, makes the installer and auto-updater integrity-safe, and wires (inert) OSS code signing.

### Fixed — hook-RPC timeout floods / UI freezes (Issue A1, A2)
- `hooks.signal` no longer does a renderer `workspace.list` round-trip on every signal. A 2s-TTL coalescing cache collapses a tool-heavy turn's bursts into ~1 round-trip and serves the last-known list when the renderer is throttled — stopping the `PostToolUse` timeout floods that froze the UI and, at worst, blocked the daemon event loop into a forced respawn.
- The Claude Code bridge retries *transient* connect-errors within its 2s budget (and never re-fires a request it already wrote), so a brief main-process restart window no longer drops hooks.

### Fixed — session reliability (RCA A1/A9, A4, A6)
- Partial-list reconcile now re-queries the daemon before clearing a live `ptyId` absent from a non-empty session list (2-strike guard), closing the last destructive-session-loss path the v2.14.0 RCA left open.
- The daemon health probe tolerates a busy-but-responsive daemon — `daemon.ping` reports event-loop lag, thresholds raised to 5 strikes / 5s — instead of mistaking load for a hang and force-respawning.
- `DaemonClient.connect` retries transient named-pipe errors (EPERM/ECONNRESET) with backoff; ENOENT still fails fast.
- Session-pipe bind retries on `EADDRINUSE`, so a pane no longer dies when a prior pipe has not yet released its name.

### Fixed — view-switch / multiview performance
- WebGL terminal contexts are no longer disposed the instant a pane is hidden. A short grace period (cancelled on re-show) eliminates the GPU-context create/destroy thrash behind workspace-switch and multiview→single-view lag.

### Added — auto-update integrity (fail-closed)
- The updater downloads the `Setup.exe` and verifies a CI-published SHA-256 (`update-manifest.json`) before launching it; a tampered or unverifiable artifact is never run. Previously it opened an unverified URL.

### Added — hook-RPC flood observability
- A rolling 30s summary of slow/failed `workspace.list` resolutions is logged (escalating to a warning on a flood), so degradation is visible without hand-tallying `bridge.log`.

### Changed — install funnel
- `install.ps1` now downloads the prebuilt, SHA-256-verified `Setup.exe` by default instead of always compiling from source. Build-from-source is opt-in (`-FromSource` / `WMUX_FROM_SOURCE=1`).

### Changed — docs & security accuracy
- Corrected the README "RunAsNode disabled" claim and reconciled `SECURITY.md` / `PROTOCOL.md` with the actual code (token entropy, `icacls` behavior, intentionally-disabled asar-integrity fuse). Removed the permanently-disabled EditorPanel "Save" affordance.

### Added — code-signing pipeline (inert until configured)
- `release.yml` is wired for SignPath Foundation (OSS) Authenticode signing of the installer, gated on a signing secret so it is a no-op until configured. Binaries remain unsigned (SmartScreen "unknown publisher") until the certificate is provisioned.

## [2.14.0] — 2026-05-29 — Session-replacement fix + lifecycle observability + token ACL hardening

Fixes the reported instability where, while running several Claude Code windows, "the daemon resets and sessions get replaced by new empty windows." Root-caused via a multi-expert review (see `plans/RCA-daemon-session-replacement-2026-05-29.md`): the daemon process never actually dies (uptime is monotonic). The renderer's reconnect/reconcile path could not distinguish a *transient* failure from a *permanent* one and destructively cleared live `ptyId`s, making Terminal self-create empty sessions while the daemon still held the originals.

### Fixed — live sessions replaced on reconnect (RCA A1/A2)
- `pty.reconnect` now tags failures `transient` (pipe-not-writable / RPC threw during handler swap) vs permanent (session dead). `useTerminal` retries transient failures with short backoff instead of immediately clearing the surface — a live session no longer gets discarded on a momentary blip.
- `AppLayout` reconcile preserves all `ptyId`s when the daemon returns an empty session list (almost always "not ready yet", not "all dead"). The late-reconnect (`daemon:connected`) path is now abort/timeout/catch guarded and never falls through to `clearAllPtyState`.
- `RECONCILE_TIMEOUT_MS` is now derived from `DAEMON_RPC_TIMEOUT_MS` in `shared/timeouts.ts` (15s > 10s), removing the asymmetry that let a slow-but-successful `pty.list` trip the destructive startup fallback.

### Added — daemon/main lifecycle observability (RCA A8)
- Structured `[lifecycle]` logging on daemon `attachSession`/`detachSession`, main `daemon:connected` emit, `DaemonClient.connect` error codes (EPERM etc.), `pty.list` live-session count, and the renderer's destructive `ptyId`-clear decisions (mirrored into the main log). Reconnect/session-replacement events are now diagnosable post-hoc instead of invisible.

### Security — token file ACL re-hardening (RCA A12)
- `secureWriteTokenFile` only locked permissions when a token was freshly written; a token loaded from disk kept whatever (possibly broad, inherited) ACL it had. New `reHardenTokenFileAcl()` re-applies a restrictive ACL (Windows `icacls`) / `chmod 0600` (POSIX) on the existing `daemon-auth-token` and `~/.wmux-auth-token` at load time. Best-effort: never crashes a live daemon.

### Fixed — session config merge + prefix mode
- Merge session config against defaults on load and harden prefix mode handling.
- Skip keybinding back-fill on key collision.

## [2.13.0] — 2026-05-29 — OSC 133 EventBus tee + agent.awaiting_input lifecycle

Extends the `agent.lifecycle` event in `wmux_events_poll` with two new substrate signals so orchestrator SDKs and any MCP consumer can react to shell command lifecycle and agent approval prompts without polling `terminal_read_events`. Both signals are wired BOTH on the local-mode PTYBridge path AND on the daemon-mode DaemonNotificationRouter path (the default production path).

Minor version bump (v2.12.0 → v2.13.0) because the `AgentLifecycleEvent` payload gains a new `source: 'osc133'` enum value, a new `kind: 'agent.awaiting_input'` enum value, a nullable `agent` field (only null when `source === 'osc133'`), and an optional `exitCode` field. The `AgentStatus` union also gains `'awaiting_input'`. All additive — existing v2.12.x consumers that switch on the previous enum values keep working unchanged.

### Two new lifecycle signals (#76)

- **`source: 'osc133'`** — every OSC 133 D shell-integration marker (e.g. from PowerShell, bash with VS Code shell integration, Ghostty, any CLI wrapped with prompt instrumentation) now tees onto the EventBus as `kind: 'agent.stop'` with the parsed `exitCode`. Latency-zero, shell-agnostic: orchestrators waiting on `npm install` / `pytest` / `make` / any CLI no longer need a heuristic detector. `agent` is set to the AgentDetector last-known slug when one is gated, otherwise `null`. OSC 133 events bypass the `HookSignalRouter` dedup ledger (always `decision: 'emit'`) — they represent shell command lifecycle, not agent-turn boundaries.

- **`kind: 'agent.awaiting_input'`** — `AgentDetector` now emits a distinct lifecycle kind when an agent surfaces a y/N or approval prompt mid-turn (Claude Code patterns `Do you want to proceed?` and `Allow tool use for <Tool>`). Distinct from `agent.stop`: orchestrators that auto-approve trusted operations can react to this kind to feed pre-approved answers without waiting for the turn to end. Routed through the same dedup ledger used for `agent.stop`.

### Added

- **`AgentLifecycleEvent.source` enum** — `'hook' | 'detector' | 'osc133'`.
- **`AgentLifecycleEvent.kind` enum** — `'agent.stop' | 'agent.subagent_stop' | 'agent.awaiting_input'`.
- **`AgentLifecycleEvent.exitCode?: number | null`** — present on `source: 'osc133'` events; absent on hook / detector sources.
- **`AgentStatus = … | 'awaiting_input'`** — sidebar renders the new state as a yellow dot with the `workspace.agentAwaitingInput` label (en + ko translated; 21 other locales fall through `Partial<TranslationMap>` to en).
- **`AgentSignalKind = … | 'agent.awaiting_input'`** — detector-only kind today; hook bridges are not expected to emit it but the union now admits it so dedup ledger entries share one shape.
- **`scripts/osc133-awaiting-input-dynamic.mjs`** — end-to-end verification that spawns the packaged Electron app, exercises the **daemon-mode** path (the default production path), and asserts the new EventBus tee signals show up via `wmux_events_poll`. Result on this branch: 15/15 checks pass with a `daemon-`-prefixed `ptyId`, confirming the daemon-path emit reaches the main process EventBus.

### Fixed

- **Daemon-mode OSC 133 + awaiting_input mirror** — the first cut wired the tee only on `PTYBridge` (the local-mode path). Daemon-backed PTYs — the default production path — parsed OSC 133 markers in `DaemonPTYBridge` and appended them to `PromptEventLog` but never forwarded them up to the main process, so consumers saw `source: 'osc133'` events in tests but never in real-world sessions. `DaemonNotificationRouter` now subscribes to a new `session:prompt` daemon broadcast and emits the EventBus tee from the production path. The `awaiting_input` lifecycle had the same gap; both are fixed together. Caught by Codex round-1 P1 review and verified end-to-end against the packaged build.
- **OSC 133 agent-attribution race** — `emitOsc133Lifecycle` now snapshots the cached agent slug **before** awaiting `workspace.list`. The shell can emit `OSC 133;D` and then redraw the prompt in the same burst (firing a new `session:agent` event); without the pre-await snapshot, the OSC 133 emit would carry the **next** turn's agent slug. Matches the PTYBridge local-mode case 133 path, which reads `agentDetector.getLastAgent()` synchronously before any emit. Caught by Codex round-2 P2.
- **Approval-prompt regex tightened to whole-line anchors** — `Do you want to proceed?` and `Allow tool use for <Tool>` are now anchored at both ends of the line, with only whitespace and Claude TUI box-drawing glyphs (`│ ║ ┃ ═ ━ ─ ┄ ┅ ┆ ┇ ┈ ┉ ╭ ╮ ╯ ╰ ╔ ╗ ╝ ╚ ┌ ┐ ┘ └ ·`) admitted as padding. Conversational mentions in agent output such as `Answer Do you want to proceed? with caution` or `Please click Allow tool use for Bash` no longer emit `agent.awaiting_input` — false positives are costly here because orchestrators may auto-feed approval responses. Codex rounds 1 → 5 progressively tightened this from an unanchored phrase match to a full-line anchor with canonical MCP tool-name grammar `mcp__<server>__<tool>` (two `__` separators required, hyphens permitted, single-underscore identifiers rejected).

### Changed

- `WmuxEventType` is **unchanged**; `agent.lifecycle` was already present in v2.12.x. Only the payload shape grows.
- `wmux_events_poll` MCP tool description updated to enumerate the three sources, new kind, and `exitCode` field so MCP-aware orchestrators discover the surface from introspection alone.
- `DaemonEvent.type` gains a `'prompt.event'` variant — the daemon-side broadcast carrying parsed OSC 133 PromptEvents to the main process.

### Test

- New `DaemonNotificationRouter.lifecycle.test.ts` (10 cases) covering detector `awaiting_input` emit, regression on `waiting` / `complete`, OSC 133 exitCode parsing, missing-suffix path, non-D ignore, agent slug cache, `HookSignalRouter` bypass for OSC 133, and `session:died` cache invalidation. Plus a race-fix test that mocks a deferred `workspace.list` and verifies the OSC 133 emit carries the **pre-await** snapshot, not the post-burst cache value.
- New cases in `PTYBridge.lifecycle.test.ts` covering local-mode OSC 133 (exit code 0 / 1, no-suffix, A/B/C ignore, workspaceId gate, gated agent slug, dedup bypass), local-mode `awaiting_input` detection, regex false-positive immunity for mid-line `Do you want to proceed?` and `Allow tool use for`, regex true-positive on boxed prompts including corner glyphs (`╮`, `─`), canonical MCP tool name matching (`mcp__github__create_issue`, `mcp__context7__get-library-docs`), and rejection of non-canonical single-underscore names.
- Full suite: 2003/2004 (the one failure is `StateWriter.test.ts:102` — the known cross-OS runner-load timeout flake first observed during v2.12.0 ship, independent of this PR; passes cleanly on rerun).
- 5 rounds of Codex independent review: round 1 caught the two daemon-path P1 architectural gaps, rounds 2 – 5 progressively tightened detector regex correctness. All rounds passed the merge gate.

## [2.12.0] — 2026-05-28 — MCP plugin permission enforcement + daemon lifecycle hardening

Lands the active enforcement layer for the Phase 2.1 MCP plugin substrate (PR #71) alongside a wave of lifecycle, identity, and UX hardening (PR #72/#74/#75). Plugins now have their declared capabilities verified on every RPC; the daemon self-shuts when idle and recovers from AV-blocked PID verification; a frozen `WMUX_WORKSPACE_ID` env can no longer leave in-pane MCP servers permanently stuck on a stale identity; xterm light themes are now WCAG-AA legible for true-color RGB white output; and keyboard pane/surface navigation finally moves DOM focus along with the visual marker.

Minor version bump (v2.11.0 → v2.12.0) because Phase 2.2 adds the `RpcRejection` discriminated union to `RpcResponse`'s failure arm, the `daemon.idleShutdownMinutes` config, and the `mcp.mode` config flag. All additive; existing v2.11.x callers keep working.

### Daemon lifecycle hardening (#72)

Closes four gaps in the wmux daemon lifecycle: an orphan daemon that survives forever in RAM after a forced wmux quit, a boot-block when anti-virus prevents PID verification, an opaque "daemon could not start" error after the respawn budget exhausts, and a transient first-ping race during cold-boot. Combined effect: the "1 wmux ≙ 1 daemon" invariant is now self-healing instead of relying on the next clean shutdown.

### Added

- **Daemon idle self-shutdown** — the daemon now terminates itself after 5 minutes with zero RPC clients and zero live PTY sessions (configurable via `daemon.idleShutdownMinutes` in `~/.wmux/config.json`; set to `0` to keep the legacy "alive forever" behavior). Routes through the same `shutdown()` body used by SIGTERM / SIGINT / `daemon.shutdown` RPC, so the existing phase instrumentation and re-entry guard apply. Logs `[shutdown.phase] idle.timeout idleMs=… cfgMs=…`.
- **`DaemonPipeServer.getConnectionCount()` / `getLastDisconnectAt()`** — public accessors for the Watchdog idle predicate. The disconnect anchor is stamped only on the 0-edge (last socket closing), so a flapping reconnect cycle resets the idle deadline forward instead of accumulating stale idle time.
- **`Watchdog` idle-check hook** — opt-in callbacks `onIdleCheck` / `onIdleShutdown` evaluated on every health tick. Decision logic exposed as `evaluateIdle()` so unit tests drive it without timers. Single state machine: `idleMs = now − (lastDisconnectAt ?? startTime)`. Grace window and idle window are independently configurable.
- **`scripts/daemon-idle-shutdown-dynamic.mjs`** — end-to-end verification that spawns the bundled daemon in an isolated tmp `WMUX_DIR` with `WMUX_IDLE_SHUTDOWN_MS` / `WMUX_IDLE_GRACE_MS` / `WMUX_WATCHDOG_TICK_MS` env overrides, connects, disconnects, and asserts the daemon exits cleanly with the `idle.timeout` breadcrumb. Runs in ~5s.

### Fixed

- **Launcher ping retry** — `ensureDaemon` now retries the first `daemon.ping` once with a 250ms delay before declaring the existing daemon unresponsive. Absorbs the cold-boot race where Defender realtime scan, ConPTY cold-init, or a large recovery loop makes the daemon miss the first 3-second ping window. Total worst case 6.25s, still well under the 15s spawn budget.
- **Unverified-live PID is now recoverable** — when anti-virus blocks `tasklist.exe` / `Get-CimInstance` and the launcher cannot confirm what owns `daemon.pid`, it now prompts the user with an Electron dialog offering "Clean up and start fresh" instead of refusing to boot. Cancel re-throws the legacy error, now annotated with the exact elevated-PowerShell `taskkill /F /PID …` command for manual recovery.
- **Respawn-exhausted is no longer silent** — `DaemonRespawnController` now captures the latest error message from the bootstrap or respawn loop and ships it on the `respawn-exhausted` event. `main` surfaces it via a native `dialog.showErrorBox` plus the existing renderer IPC channel, with concrete recovery steps. `lastError` is cleared on successful install so future exhaustions don't echo stale diagnostics.
- **SIGKILL-failure throw now embeds the recovery command** — when the OS refuses to terminate a verified-stale daemon (typically EPERM under AV / different-user scenarios), the thrown error now includes the exact `taskkill /F /PID …` invocation the user needs in an elevated PowerShell. No silent `taskkill` fallback because `process.kill('SIGKILL')` already walks the same `TerminateProcess` path with the same user token; embedding the hint is more honest than retrying.

### Changed

- `DaemonRespawnController.RespawnEvent` — the `respawn-exhausted` variant now carries an optional `lastError` field. Additive change; existing consumers that ignore the field still type-check.
- Suppression env var `WMUX_NO_DIALOG=1` bypasses both the launcher recovery dialog and the respawn-exhausted dialog for automated runs.

### Test

- New `idleShutdown.test.ts` (source-level invariants for the daemon main wiring), new idle-flow test cases in `Watchdog.test.ts`, new `getConnectionCount` / `getLastDisconnectAt` lifecycle test in `DaemonPipeServer.test.ts`, new `lastError` propagation test in `DaemonRespawnController.test.ts`, and `scripts/daemon-idle-shutdown-dynamic.mjs` for the end-to-end path.

### Workspace identity drift fix (#72)

Fixes a serious multi-agent bug: an in-pane MCP server (e.g. Claude Code) could get permanently stuck reporting a workspace id that no longer exists — `a2a.whoami` returning `no workspace found for ws-…` and `terminal_send` rejecting with `not owned by workspace … (actual owner: …)`. Every identity-gated MCP call (A2A, `terminal_*`, browser routing) failed until the MCP server was restarted. Triggered when a workspace id is re-minted (daemon respawn / session restore) while the shell process — and its frozen `WMUX_WORKSPACE_ID` env — lives on.

### Fixed

- **Workspace-identity is now anchored to the immutable `ptyId`, not a frozen workspace id.** The on-disk PID map (`~/.wmux/pid-map/<pid>`) stores the ptyId; `a2a.resolve.identity` resolves the **current** owning workspace live from the renderer (`input.findOwnerWorkspace`) on every call. A re-minted workspace id can no longer produce a stale identity. The map is also re-anchored on `pty.reconnect`, so a surviving shell re-adopted after a respawn resolves correctly without a restart.
- **MCP resolvers (`src/mcp`, `src/company/mcp`) no longer permanently trust the env hint.** `WMUX_WORKSPACE_ID` is demoted to a last-resort fallback behind the live PID-walk; an RPC that reports a stale identity (`no workspace found` / `not owned by workspace`) invalidates the in-process cache so the next call self-heals.

### Changed

- `a2a.resolve.identity` returns PID → **current** workspaceId (resolved live), legacy `ws-`-prefixed pid-map entries pass through for one cycle, and ptyIds with no live owner are omitted (no phantom mappings).
- `docs/PROTOCOL.md §6.1` reordered: path B (live PID-walk) is now preferred over path A (stale-prone env hint); added the `ptyId`-anchor and self-heal notes.

### Phase 2.2 MCP plugin permission enforcement (#71)

Lands the active enforcement layer on top of the Phase 2.1 record-only identity + grammar substrate (PR #48) and the spec-side default rules (PR #68). Plugins that declare a capability set via `mcp.declarePermissions` now have those declarations verified against every RPC they issue; mismatches return a structured `RpcRejection` describing the per-path failure, and unconfirmed declarations surface a user-approval prompt before the call can proceed.

### Added

- **`PermissionEnforcer` substrate (`src/main/mcp/PermissionEnforcer.ts`)** — pure-function permission gate. Given a method, params, request context, and trust record, returns `allow`, `reject`, or `partial`. Same function runs in both shadow and enforce modes; only the dispatcher's reaction changes.
- **Single declarative `methodCapabilityMap`** — `Record<RpcMethod, RequiredCapability>` covering the full 96-method RPC surface. `tsc --noEmit` enforces totality so a new method without a gate entry fails the build. Identity bootstrap (`mcp.identify`, `mcp.declarePermissions`, `system.identify`, `system.capabilities`) is `capability: null`. Internal surfaces (daemon, company, surface, hooks) map to the reserved `wmux.internal` capability that no plugin can declare.
- **Structured `RpcRejection` discriminated union** on `RpcResponse`'s failure arm — `capability-not-declared`, `path-not-allowed`, `paths-partially-allowed` (with `{allowed, rejected[]}`), and `identity-status` (with optional `pendingApproval.promptId`). Additive on the existing `{ok:false; error}` arm; every `switch (r.ok)` site keeps narrowing.
- **`ShadowRejectionLogger` + JSONL audit log at `~/.wmux/shadow-rejections.log`** — discriminated entries (`rejection` / `legacy-traffic`). 1 MiB cap with single-generation rotation. Sync writes wrapped in try/catch — telemetry must never affect RPC throughput.
- **`LegacyTrafficCounter`** — per-method milestones (1st / 10th / 100th / 1000th / 10000th call) for envelope-less RPCs, flushed to the shadow log. Replaces the previous process-once trust-DB write for accurate v3.1 surfacing data.
- **`ApprovalQueue`** — `(clientName, hash(declaredCapabilities))` dedupe key, synchronous promptId minting + async resolution. On approve/deny, writes through `PluginTrustStore.setUserDecision`. Multiple inflight RPCs from the same plugin during a prompt coalesce onto one modal.
- **`PermissionApprovalDialog`** — risk-class-grouped capability list with asymmetric wording. Terminal-content (`terminal.read`, `pane.search`) and terminal-input (`terminal.send`) get critical-severity copy that names the concrete privilege ("can read what's on your screen, including secrets"); metadata / events / pane-lifecycle / workspace get neutral copy. Browser and A2A get caution.
- **`mcp.mode` config flag** in `~/.wmux/config.json` — `shadow` or `enforce`. Production wmux defaults to `enforce`; dev (`electron-forge start` / `NODE_ENV=test`) defaults to `shadow` for dogfood rollback safety.
- **`PluginTrustStore.setUserDecision(name, 'trusted' | 'denied')`** — explicit user-decision write path. Seeds a fresh record when a prompt fires before `mcp.identify` lands.
- **Spec §4.4 "Enforcement contract"** — documents the wire shape, retry idiom, mode flag, and worked glob example (`meta.write:custom.foo` ≠ `custom.foo.bar` without trailing `*` or `**`).
- **`inventory.md` Phase 2.2 capability map** — per-method capability + path-source + risk-class column.

### Changed

- `RpcRouter.dispatch` now calls the enforcer before invoking the handler. In `shadow` mode, the would-be rejection is logged and the handler still runs (no behavior change for v2.x callers). In `enforce` mode, a non-allow outcome returns the RpcResponse failure WITHOUT calling the handler. `legacy` callers (no `clientName` envelope) and identity-bootstrap RPCs are always allowed.
- `ApprovalQueue.requestApproval` returns `{ promptId, resolution }` — the promptId is available synchronously so the dispatcher can thread it into the rejection without awaiting the user's decision.

### Fixed

- **Keyboard pane/surface navigation now moves keyboard focus, not just the active border** (`src/renderer/hooks/useActivePaneFocus.ts`). Switching panes with the tmux prefix arrows, `Alt+Ctrl+Arrow`, `Ctrl+Tab`, the RPC `pane.focus` bridge, or keyboard tab-switching moved the red active border (driven by `ws.activePaneId`) but left DOM focus on the previously focused pane's xterm — so keystrokes still landed in the old pane. xterm routes input from whichever textarea holds DOM focus, and no navigation path ever called `terminal.focus()`. A central `useActivePaneFocus` hook now pulls DOM focus onto the resolved active terminal whenever the target workspace/pane/surface changes, covering every state-only switch path in one place. Mouse clicks were unaffected (the click focuses the target xterm for free) and remain so.

### Notes for plugin authors

- Plugins SHOULD retry on `rejection.pendingApproval.promptId` with 1–5 s backoff. The substrate doesn't pin a socket waiting for the user (50-connection cap; OAuth `authorization_pending` precedent).
- `meta.write:custom.foo` matches the EXACT path `custom.foo`. Declare `meta.write:custom.foo.*` or `meta.write:custom.foo.**` to cover the subtree.
- `events.poll` is `partial`-mode multi-path: subscribing to mixed-allowed topics returns the allowed subset with a `paths-partially-allowed` rejection on the failure arm carrying both `allowed` and `rejected` lists. `pane.setMetadata` and `pane.clearMetadata` are `all-or-nothing`.

### Light xterm theme contrast (#74)

Claude Code (and several other TUI apps) emit foreground text as true-color RGB white (`#FFFFFF`). Those escape sequences bypass our `sandstone-light` / `paper-light` xterm palettes, so the literal white rendered directly on hinomaru's cream background (`#FAF8F5`) and read as invisible — users could not see Claude Code's output at all on hinomaru/taegeuk.

### Fixed

- **xterm `minimumContrastRatio` set to `4.5` (WCAG AA) on light themes.** Detected via `isLight(background)` on the resolved palette; covers built-in light themes and any custom palette a user configures to a light tone. Dark themes keep the default ratio of `1` so intentionally subtle dimmed foregrounds (e.g. catppuccin-mocha's `text-muted`) remain unmodified.
- Applied at both the initial `new Terminal({...})` site **and** the runtime theme-switch effect, so toggling between themes inside a live session takes effect without remounting the terminal.

### Keyboard pane navigation DOM focus (#75)

Switching panes with the keyboard moved the red active border but typing still landed in the previously focused pane. xterm routes keystrokes from whichever `<textarea>` currently holds DOM focus; navigation paths (`focusPaneDirection`, `cyclePane`, surface-tab switches, RPC `pane.focus`) only updated state, never called `terminal.focus()`. Mouse clicks were unaffected because the click focuses the target xterm DOM for free — so only keyboard paths were broken.

### Fixed

- **`useActivePaneFocus` central hook (`src/renderer/hooks/useActivePaneFocus.ts`)** — subscribes to the resolved active terminal (workspace + pane + surface) and pulls DOM focus onto that xterm whenever the target changes, closing every state-only switch path in one place rather than patching four call sites. Retries across a few animation frames so a freshly split pane's xterm still gets focus once `useTerminal` registers it. Declines non-terminal surfaces (browser/editor).

### Test

- New `src/renderer/hooks/__tests__/useActivePaneFocus.test.ts` — 11 cases on the pure resolution logic (`resolveActivePanePtyId`), including pane-switch and same-pane tab-switch coverage that directly pins this bug, plus browser/editor/empty-ptyId rejection. The DOM-focus application half (`terminal.focus()` + rAF retry) needs a browser harness the node-env vitest lacks and is verified by dogfood.

## [2.11.0] — 2026-05-26 — Orchestrator substrate + Claude Code hook plugin

Lands the substrate piece that the new [`@wmux/orchestrator`](https://github.com/openwong2kim/wmux-orchestrator) npm SDK consumes, plus the Claude Code hook plugin integration that delivers sub-200ms agent-completion signals (vs the heuristic regex detector). Minor version bump because the new `agent.lifecycle` event type is additive — no breaking changes vs v2.10.x clients.

### Added

- **`agent.lifecycle` EventBus tee from hook + detector sources (#63).** New `WmuxEventType` `agent.lifecycle` streams whenever a supported inner agent (Claude Code today; others via the `integrations/<slug>` bridge later) finishes a turn or subagent span. Tee sites:
  - `hooks.rpc.ts` — Claude Code Stop / SubagentStop hooks fire RPCs that emit the event with `source: 'hook'`. Sub-200ms, deterministic. Both `emit` and `dedup` decisions stream so observers can compare.
  - `PTYBridge.ts` AgentDetector — regex-based fallback for any agent, emits with `source: 'detector'` (~1-2s lag).
  - `DaemonNotificationRouter.emitDetectorLifecycle` — daemon-backed PTYs (the default production path) — sync `recordDetector` call before async workspace.list resolution so dedup timing matches local-mode.
  Carries `ptyId`, `kind` (`agent.stop` | `agent.subagent_stop`), `source`, `agent` slug, `decision` (`emit` | `dedup`). Polled via the existing `wmux_events_poll` MCP tool with the type filter extended.

- **Claude Code hook plugin Phase 1 integration backbone (#60).** Adds the `integrations/claude-code/hook-plugin/` directory that bridges Claude Code's hook events into wmux's signal pipeline. Foundation for the structured agent observability surface.

- **Phase 1.5 signal-health + Phase 2 usage-meter + env-first routing (#61).** Per-pane signal-health plumbing (~140 LOC across substrate only — proxy metric layers like cumulative / percent / banner were dropped after the Codex review). 5-hour and 7-day usage windows. Env-first hook routing fix so `WMUX_HOOK_TARGET` overrides config-derived destinations.

### Fixed

- **NOTICE files preserved for Apache 2.0 §4(d) compliance (#62).** Bundled third-party NOTICE files now survive the electron-forge pack step, satisfying the Apache 2.0 attribution clause for the dependencies that ship one.

### Documentation

- README: SmartScreen install guidance for the unsigned installer (#66).
- README: pointer to the new `@wmux/orchestrator` SDK in the MCP integration section (#67).

### Compatibility

- No breaking changes vs v2.10.x. Existing MCP clients keep working.
- New `agent.lifecycle` event type is additive — clients that don't filter for it won't see it.
- `@wmux/orchestrator` v0.1.x requires wmux ≥ 2.11.0 (the version this `agent.lifecycle` tee actually ships in — the SDK README mention of "≥ 2.10" was off by one).

## [2.10.2] — 2026-05-22 — First-launch input race fix + helper-orphan cleanup

Two prod-only bugs surfaced during fresh-PC dogfood of v2.10.1. Neither
reproduced under dev (`npm start`) because the vite dev-server load delay
hides the underlying daemon-bootstrap timing.

### Fixed

- **First-launch keystroke loss on fresh installs.** v2.10.1's
  `DaemonRespawnController` introduced a race between renderer mount and
  the LOCAL→DAEMON IPC handler swap. On cold-start PCs the daemon spawn
  stretches into hundreds of ms (Defender realtime scan + ASAR cold cache
  + ConPTY cold start), wide enough for the renderer to mount and reach
  handler-swap mid-startup. Any `pty.write` that carried a LOCAL-prefix
  id (`pty-N`) into the DAEMON handler was silently dropped because
  `sessionPipes.get('pty-N')` is undefined — manifesting as "the first
  keystroke does not register" or "only the first keystroke registers"
  on the very first session. Fix splits renderer navigation out of
  `createWindow()` into a standalone `loadMainRenderer()` export and
  defers the call until after `bootstrap()` returns and
  `markDaemonReady()` has unblocked `daemon.whenReady()`. Every
  `pty.create` from the renderer now hits a stable handler topology and
  produces a correctly-prefixed id. The macOS `app.on('activate')`
  re-open path keeps the immediate-load default because the daemon is
  already healthy by then.

- **Helper-orphan zombies on quit.** `before-quit` has five awaits
  (renderer save, sleep, daemon shutdown race up to 8s, disconnect,
  cleanup) before `app.quit()`. Any hang (stuck `pipeServer.stop()`,
  detached webview blocking `will-quit`, ConPTY/OSC 7 finalization
  stall) leaves Electron's renderer / GPU / utility helpers as orphans.
  On Windows the dev `npm start` Ctrl+C path also leaks helpers because
  SIGINT only reaches `npm.exe`, not the electron tree. Reproduced
  locally as 20-helper orphan buildup spanning days. Add a 1.5s
  `setTimeout` after `app.quit()` that calls `app.exit(0)` if the
  graceful path has not finalized; `unref()` keeps the timer
  non-blocking so a normal sub-second quit isn't held open. The
  graceful path is unchanged — this only fires on hang.

### Internal

- `.team/` added to `.gitignore` so worktree coordination metadata
  cannot leak into future commits — matches the existing `.claude/` /
  `.gstack/` exclusions (Codex `/codex review` P2 finding).

## [2.10.1] — 2026-05-22 — Notification system expansion + CI hardening

Five-surface notification system (StatusBar bell, pane border ring, Windows
taskbar flash, in-app toast, sidebar dot) with per-workspace mute, four new
user settings, and a pure-function policy refactor of the notification
dispatcher. Two CI hardening fixes also land.

### Added

- **NotificationBell on StatusBar.** The existing `● {unreadCount}` element is
  now a clickable accessible button (native `<button>`, dynamic `aria-label`,
  focus-visible outline, 24x24 minimum click area, 999+ clipping). Click opens
  the notification panel.
- **Pane NotificationRing.** Per-pane state machine: flash 500ms → glow steady
  → cleared on focus or read. Honors `prefers-reduced-motion` (instant
  transitions) and `forced-colors: active` (Windows high-contrast 2px border).
- **Auto-markRead on pane focus.** Clicking a pane marks its notifications read
  and clears the ring entry — but only if at least one notification was
  actually marked, so plain focus clicks don't wipe a fresh flash.
- **Relative time format in NotificationPanel.** Replaces `hh:mm` with
  `just now` / `Xm ago` / `Xh ago` / `Xd ago` / local date. Future-skew safe.
- **Taskbar flashFrame on Windows.** Window unfocused + new notification
  arrives → taskbar flashes for attention. Auto-clears on window focus.
  `BrowserWindow.isDestroyed()` guard prevents Electron throw.
- **Per-workspace mute.** Each workspace can be muted from SettingsPanel.
  Muted workspaces still record notifications in the panel; bell badge
  excludes them; toast/sound/ring/flashFrame are suppressed.
- **Four new settings toggles.** Pane ring on/off, pane flash on/off,
  taskbar flash on/off, notification sound choice (default/none).
- **`markAllRead()` global + `jumpToUnread()` selector.** Global mark-all
  button in NotificationPanel (separate from the existing per-workspace one).
  `jumpToUnread` navigates to the most recent unread workspace without
  marking read.
- **NotificationPanel a11y.** `role="dialog"`, initial focus on first unread,
  Esc closes, Tab cycles, screen-reader announces "{type}, {title},
  {timeAgo}, {read|unread}" per row.

### Fixed

- **Notification ring lifecycle.** Ring entries are now cleared on every
  user-action read path (`Pane.handleClick`, `markAllRead`,
  `setActiveWorkspace`, `removeWorkspace`) so panes can no longer get stuck
  in 'glow' after the user already handled the notification.
- **Listener refactor.** `useNotificationListener` is now a thin IPC
  dispatcher that delegates decisions to `useNotificationPolicy` (pure
  function, testable in isolation). Replaces the module-scope mutable
  `lastSoundTime` map with `createThrottler(ms)` closures (per-NotificationType
  for sound, global 500ms for flashFrame burst protection).
- **`runSnapshotOnce` test 7-day time bomb.** The test used a hardcoded
  `lastActivity: '2026-05-15T00:00:00Z'` for a suspended session, which
  `SUSPENDED_TTL_HOURS = 168` pruned exactly 7 days later. Test now uses a
  dynamic `Date.now() - 1h` so the fixture never expires.
- **`ProcessMonitor` CI flake.** `watch()` left the first probe to the first
  `setInterval` tick; under CI CPU contention two `tasklist` execs could
  exceed the test's 5s timeout. `watch()` now triggers an immediate first
  probe (production benefit: dead-PID detection is no longer up-to-5s
  delayed). Test timeout bumped to 20s with documented latency reasoning.

### Internal

- 12 IRON-RULE regression tests lock down previously untested but correct
  behavior in the notification stack (cap eviction, throttle, target
  resolution, active-surface skip, toggle plumbing).
- Test suite total: 1665 tests, 136 files. Five consecutive stable
  full-suite runs verified post-fix.

## [2.10.0] — 2026-05-18 — tmux prefix expansion + 16 new locales

This release rounds out the tmux-style prefix layer with pass-through and three new
bindings, fixes a long-standing dead-event handler on the workspace rename shortcut,
and ships UI translations for 16 additional locales.

### Added

- **tmux pass-through.** Pressing the prefix combo twice (`Ctrl+B Ctrl+B` by default)
  now forwards a literal Ctrl+B byte to the active terminal, so a nested tmux/screen
  session running inside a wmux pane receives its own prefix instead of being
  swallowed by wmux.
- **Three new prefix bindings.** `,` opens inline rename for the active workspace,
  `&` closes the workspace (disposing every PTY in its tree first), `?` redisplays
  the keyboard cheat sheet even after it has been permanently dismissed.
- **16 new UI locales:** Arabic, Bosnian, Danish, German, Spanish, French, Hindi,
  Indonesian, Italian, Malay, Norwegian Bokmål, Polish, Brazilian Portuguese, Russian,
  Thai, Turkish, Ukrainian, Vietnamese, and Traditional Chinese. Switch from
  **Settings → Appearance → Language**.

### Fixed

- **Workspace rename actually works now.** Both the new `Ctrl+B ,` prefix action and
  the existing `Ctrl+Shift+R` shortcut previously dispatched a custom event that no
  component was listening for, so neither path opened the inline rename input. The
  sidebar's `WorkspaceItem` now subscribes to the event on the active workspace.
- **`?` prefix re-opens the cheat sheet after permanent dismissal.** The `AppLayout`
  mount gate previously prevented the cheat sheet from rendering at all once the user
  clicked "Don't show again", so the one-shot force-show flag had nothing to react to.
  The gate now honors the override.
- **`?` prefix works after a previous cheat sheet auto-expired.** The 30-second
  countdown now clears the force-show flag when it hits zero, so the next `?` press
  flips the selector and re-triggers the show effect.

### Changed

- **`createPrefixActions` factory.** The prefix-mode action registry in
  `useKeyboard.ts` is now an exported factory taking `{store, electronAPI, doc}`, so
  unit tests can drive every action with mocks instead of needing a DOM harness.
  32 new unit tests cover every action plus the `ctrlByteForKeyCode` pass-through
  helper.

## [2.9.1] — 2026-05-17 — Scrollback restore hotfix

v2.8.x 이후 silently broken 이었던 scrollback restore 를 살리는 hotfix release. tray Quit → restart 시 모든 pane 이 fresh empty terminal 로 뜨던 증상의 진짜 root cause 3개를 모두 잡았다 (다층 race). 사용자 dogfood 로 end-to-end 검증 완료.

업그레이드 영향:

- 모든 변경은 v2.9.x backwards-compatible. 새 wire contract / disk schema 없음.
- 새 설정 한 개: **Settings → Terminal → "시작 시 복원"** (Restore on launch, default ON). 끄면 매 launch fresh 시작.
- 누적된 session.json ↔ daemon dump mismatch 가 있어 복원 안 보이는 사용자를 위해 `scripts/scrollback-reset.mjs` 한방 cleanup util 제공 (백업 후 정리, 비파괴).
- 로그 파일이 자동으로 14일 retention 으로 정리됨 (이전엔 무제한 누적, 일부 사용자에서 ~700MB 까지 부풀었던 사례).

### Added

- **Scrollback restore 토글** (`uiSlice.scrollbackRestoreEnabled`, default `true`) — Settings → Terminal 에서 끌 수 있음. OFF 시 startup 에 `clearAllPtyState()` 로 모든 pane fresh 시작. daemon 은 ringBuffer dump 계속 (renderer 가 안 읽어서 orphan `.buf` 는 다음 launch `cleanOrphanedBuffers` 가 청소). en/ko/ja/zh i18n.
- **Log auto-prune** (`main/util/logSink.ts`, `daemon/util/logSink.ts`) — 14일 이상 된 daily log 파일 startup 시 자동 삭제. 이전엔 retention 정책 없어 무제한 누적.
- **`scripts/scrollback-reset.mjs`** — 비파괴 cleanup util. `~/.wmux/buffers/`, `sessions.json*`, `%APPDATA%/wmux/session.json*` 를 `~/.wmux/backup-<timestamp>/` 로 이동 (삭제 아님). 사용자가 session.json ↔ daemon dump mismatch 누적된 상태를 한 번에 청소할 수 있음.
- **`scripts/scrollback-restore-test.mjs`** — bundled daemon subprocess + RPC probe 기반 dynamic test. recovery + flush bytes contract regression 가드.

### Fixed

- **L1 — `workspaceSlice.loadSession` ptyId wipe 제거**. 매 startup 마다 모든 `surface.ptyId` 를 `""` 로 force-clear 하던 코드가 reconcile 의 reconnect 경로 진입 자체를 막고 있었다. saved ptyId 는 이제 보존된다. 대신 `AppLayout` 이 `paneGate` (`'pending' | 'ready'`) render gate 로 PaneContainer mount 를 reconcile 완료 이후로 미뤄서 옛 propagation race 를 원천 봉쇄한다. 추가로 `clearAllPtyState` cross-slice atomic clear action 이 reconcile 실패/timeout 시 explicit fallback.
- **L2 — `BEFORE_QUIT_TIMEOUT_MS` 4s → 8s** (cherry-picked from `fix/daemon-shutdown-phase-instrumentation` #45). 50-pane daemon 에서 4초로는 buffer dump 가 못 끝나 다음 launch 가 recovery 할 게 없던 상태. 동시에 daemon-side `logSink` (`daemon/util/logSink.ts`) + `[shutdown.phase]` per-phase 지표 + `[recovery] session X bytes=N` 가시화 도구 도입 — 이게 없었으면 다음 layer 진단 자체가 불가능했다.
- **L3 — `pty.reconnect` race-free 재구성**. `AppLayout.reconcilePtys` 는 이제 sync liveness check 만 (dead ptyId clear, live 는 그대로). 실제 reconnect 호출은 `useTerminal` mount 안에서 모든 listener 등록 *후* 발생. 이전 구조는 daemon SessionPipe replay (10KB+) 가 `win.webContents.send(PTY_DATA, …)` 로 forward 됐을 때 renderer `ipcRenderer.on(PTY_DATA)` listener 가 아직 없어 Electron IPC 가 silently drop 하던 게 진짜 사용자 가시 root cause 였다.
- **`pty.reconnect` failure 처리** — `{success: false}` 응답을 더 이상 swallow 하지 않는다 (`useTerminal` 가 `clearSurfacePtyIdByPty` 호출 → Terminal self-create fallback). 이전엔 dead session 이 stale ptyId 로 input-mute 영구 유지될 수 있었음 — 정확히 Fix 0 이 없애려던 클래스.
- **`daemonMode` flag race** — `isDaemonModeActive` 를 startup IIFE 안에서 paneGate 가 ready 로 바뀌기 *전* 에 명시 set. 이전엔 별도 effect 가 set 해서 Terminal 이 `daemonModeAtMount=false` 로 mount 되고 reconnect 자체를 안 부르던 케이스 가능.
- **Startup IIFE outer try/finally** — `session.load()` rejection 이 `.then` 안의 try 를 우회해서 `paneGate` 가 영구 pending 으로 갇히던 edge 봉쇄.
- **`useRpcBridge` startup-window 가드** — external RPC (MCP, A2A) 가 startup 중에 stale `ptyId` 로 write 들어오는 걸 `{error: 'wmux is still starting', retryable: true}` 로 차단.
- **`main/util/logSink.ts` stdout tee** — 이전엔 `stderr` 만 tee 해서 `console.log` 결과가 disk 에 안 남았다 (`console.warn`/`error` 만 capture). renderer 진단 라인이 main log file 에 같이 누적되도록 console-message `level<2 return` 필터도 제거.

### Out of scope (다음 PR 후보)

- **Fix B** (cap-aware suspended-session promote) — 50-pane 이상에서 `MAX_RECOVER_SESSIONS=40` 초과 session 은 여전히 복원 못 함. design doc `docs/internal/scrollback-restore-design.md` §5 에 spec. TODOS.md 에 항목 등록. 50-pane thundering herd (codex P1#3) 와 함께 처리.
- **Substrate Phase 2+ Fix C** — 2-storage 통합. weeks 단위 작업. 별도 트랙.
- **`AppLayout.gate` integration test** — vitest config 가 현재 `environment: 'node'` 라 jsdom + RTL setup 필요. follow-up.

### 외부 협의 / Reviews

- **Codex outside-voice** — plan 단계에서 13 holes 지적 → plan v2 resolution map 에 모두 매핑. 최종 pre-merge review 에서 추가 P1 3 + P2 3 — P1 + red test 는 fix, P1#3 (thundering herd) 와 P2#6 (session-end timeout) 은 known limitation 으로 명시 + 다음 PR 로 deferred.

PR: **#46** (path-D inventory, docs), **#45** (daemon instrumentation + before-quit timeout 8s), **#47** (Fix 0 — three-layer race fix + toggle + log prune).

## [2.9.0] — 2026-05-14 — Substrate 3.0 — Phase 0 + M0

wmux의 substrate identity 를 v3.0 으로 끌고 가기 위한 첫 번째 ship unit. v2.8.x 에서 이미 ~50% 가 출하돼 있던 substrate 표면 (PaneMetadata, EventBus, bootId, asOfSeq, `system.capabilities`, MCP host, `mcp.claimWorkspace`) 위에 (a) 그 표면의 contract 를 명문화한 Phase 0 문서, (b) main process 측 metadata authority 인 `MetadataStore` 와 그 wire 통합 (M0-a~f), (c) v2.8.x dogfood 중 노출된 스크롤백 손상 + reconcile race + logSink durable write 안정성 픽스를 한꺼번에 ship. **메인 PR 은 #34** (Substrate 3.0 — Phase 0 + M0, v2.9.0 ship unit) 이고 후속 마이그레이션 도구는 **#35** (chopped-dump recovery tool) 로 따라간다. 외부 RFC 협의는 **#15 (@alphabeen)** 에서 진행됐고 그 OCC + `mergeMode` 디자인이 코드로 착지.

업그레이드 영향:

- 와이어 contract 는 v2.x 와 backwards-compatible 이다 (`expectedVersion`, `mergeMode`, `pane.metadata.changed` 의 `version` 모두 additive optional).
- 디스크에 새로 등장하는 폴더: `userData/wmux/scrollback/corrupted/` 와 `scrollback/*.txt.bak[.1..3]` 회전 슬롯. 둘 다 자동 관리.
- v2.8.x 사용자가 첫 부팅 때 일부 패널 스크롤백이 비어 보일 수 있다 — 이미 디스크에 chopped 형태로 저장돼 있던 dump 가 v2.9.0 detector 에 의해 격리되기 때문. 데이터는 격리 폴더에 보존되며 `scripts/recover-scrollback.mjs` 로 사람이 읽을 수 있는 텍스트로 복원 가능. 자세한 가이드는 `docs/upgrade-v2.9.0.md` 참조.

### Added

- **Substrate 3.0 contract documentation** — `docs/PROTOCOL.md` (substrate wire contract: layered status, namespacing, optimistic concurrency, `mergeMode`, cursor opaqueness, snapshot reconciliation, permission enforcement sketch, Named Pipe token security model), `docs/api/{inventory,versioning,stability}.md` (모든 RPC/MCP/event 의 stability tier + semver + 자동 업데이트 호환 정책), `docs/internal/{m0-design,paneSlice-callsite-inventory}.md` (M0 race specs + paneSlice 변경 blast-radius).
- **`MetadataStore` 모듈 (M0-a)** — main process 의 `PaneMetadata` authority. `get` / `set` / `clear` / `snapshot` / `hydrate` / `serialize` / `migrate` / `onPaneDeleted`, per-pane monotonic `version`, `expectedVersion` 기반 OCC, 세 가지 `mergeMode` (`merge` / `replace` / `replaceShared`). 31 unit test 가 CRUD + version + mergeMode 트랜잭션 + OCC + 검증 + snapshot + persistence + EventBus emission 을 cover, codex full-stack review 가 catch 한 3건 (`replaceShared` 의 custom 보호, 누적 size cap, `updatedAt` 추가 후 cap 적용) regression test 포함.
- **`pane.resolveActiveLeaf` IPC 채널 (M0-b)** — caller 가 `paneId` 를 생략하면 main 이 renderer 에 active leaf id 를 query (read-only, paneSlice 쓰기 0) 한 뒤 MetadataStore 에 commit. codex P1 review 가 잡은 split-store read-after-write 구멍 닫힘.
- **`MetadataStore.snapshot()` ↔ `pane.list` 통합 (M0-c)** — `pane.list` envelope 가 store snapshot 으로 anchored, `asOfSeq` 가 snapshot lineage 를 반영. renderer 가 더 이상 metadata 를 자체 합성하지 않음.
- **`SessionManager.saveMetadataSync` 와이어 (M0-e)** — MetadataStore 의 persist callback 이 `metadata.json` 에 atomic write, launch 시 store 가 그 파일에서 hydrate. codex P2 review 가 잡은 strict field validation 포함.
- **Wire format 추가 (M0-f)** — `pane.setMetadata` 가 optional `expectedVersion` + `mergeMode`, reply / event / list 가 optional `version` 필드. v2.x subscriber 영향 없음 (모두 additive).
- **Optional `version` 필드** on `pane.metadata.changed` events.
- **PR template** with CHANGELOG + stability-tier sections.
- **`atomicWriteText` / `atomicReadText`** (sync + async) — `core.ts` 의 JSON 변종과 짝이 되는 텍스트 변종. rotation chain + quarantine 파이프라인 공유. JSON 변종이 parseable payload 를 전제하기 때문에 raw-bytes contract 가 필요한 스크롤백을 위해 sibling 으로 분리.
- **Cols-collapse corruption detector** (`src/main/scrollback/corruption.ts`) — chopped dump 의 on-disk 시그니처 (median 비공백 행 길이 ≤ 3자, CRLF 바이트 비율 ≥ 0.3) 휴리스틱 검출기. 단일 패스 스캔, allocation 최소. 15 unit test 가 production v2.8.4 fixture (median=1, max=60 까지 outlier 살아남은 chopped 파일) 와 false-positive 저항 (정상 출력, sparse 세션, narrow pane, ANSI-rich 로그, 단일 긴 줄) cover.
- **`scrollbackDump` util 모듈** (`src/renderer/utils/scrollbackDump.ts`) — renderer 의 dump serializer 를 `AppLayout.tsx` 에서 분리. eligibility 가드 (cols < 12 / rows ≤ 0 / `terminal.element.offsetWidth === 0` / detached) 가 unit-testable. 13 test 가 각 가드 branch + happy path 를 pin.
- **`scripts/recover-scrollback.mjs` (#35)** — read-only 마이그레이션 CLI. v2.8.x → v2.9.0 첫 부팅에서 `corrupted/` 로 격리된 chopped dump 를 reverse-reflow 로 사람이 읽을 수 있는 텍스트로 복원. `node:util` `parseArgs` 기반, dry-run / verbose / 입출력 dir 오버라이드 지원. 19 unit test (detector parity + 순수 transform + processFile e2e + CLI plumbing). 출력은 별도 폴더로만 쓰고 격리 원본은 절대 수정하지 않음.
- **`docs/upgrade-v2.9.0.md` (#35)** — v2.8.x → v2.9.0 사용자 마이그레이션 가이드. `corrupted/` 폴더의 의미, 첫 부팅 시 무엇을 보게 되는지, 복원 스크립트 사용법, 복원 한계, 롤백 절차, FAQ.

### Changed

- **README** opening 이 LSP-for-terminals substrate 프레이밍 으로 시작 (AI agent 가치 제안과 tmux 대체 키워드는 보존).
- **`pane.{set,get,clear}Metadata` 핸들러 (M0-b)** 가 `MetadataStore` 로 라우팅. paneSlice 는 더 이상 RPC metadata path 에 의해 mutate 되지 않음.
- **paneSlice 가 mirror-only (M0-d)** — 컴파일-타임 write protection 추가. M0-b 가 이미 모든 write path 를 우회시켜 M0-d 는 거의 no-op.
- **`pane.list` envelope (M0-c)** 가 `MetadataStore.snapshot()` 으로 anchored. snapshot lineage 를 `asOfSeq` 가 반영.
- **`SessionManager` (M0-e)** 가 `metadata.json` 을 `MetadataStore` persist callback 으로 atomic write, launch 시 store 를 그 파일에서 hydrate.
- **`SCROLLBACK_DUMP` IPC 핸들러** 가 직접 `writeFileSync` 대신 `atomicWriteTextSync` 사용. rotation chain (.bak / .bak.1 / .bak.2 / .bak.3) 활성화. pre-write corruption 시그니처 검출 시 payload 거부 (defense in depth — renderer 가드 회귀 대비).
- **`SCROLLBACK_LOAD` IPC 핸들러** 가 `atomicReadTextSync` + validate hook 으로 load. chopped 시그니처 매칭 시 primary 를 `corrupted/{ts}.bak` 으로 격리 후 `.bak` 체인 fallback 으로 시도. 구조화 `CORRUPT_FILE` 로그를 stderr 로 emit. 손상 파일이 fresh xterm 에 복원돼서 다음 5초 dump 가 chopped 상태를 다시 디스크에 쓰는 자기증식 루프를 끊음.
- **`vitest.config.ts`** 가 `scripts/__tests__/**/*.test.mjs` 도 include — 운영 도구 (마이그레이션 스크립트 등) 가 같은 test runner 아래에서 회귀 보호됨.

### Fixed

- **`replaceShared` mergeMode 가 caller 의 `custom` patch 를 덮어쓰던 결함** (codex full-stack review P2) — `patch.custom` 을 silently ignore 해 tool-namespace clobber 방지. substrate 의 namespace boundary guarantee.
- **MetadataStore size cap (`PANE_METADATA_MAX_BYTES`) 이 `updatedAt` 추가 전에 검증되던 결함** (codex P2) — 최종 저장 shape (`updatedAt` 포함) 에 대해 검증. boundary 안전.
- **MetadataStore `custom` entry cap 이 patch 에만 적용되던 결함** (codex P2) — 누적 merge 가 cap 을 우회하지 못하도록 post-merge shape 에 대해 검증.
- **Split-store read-after-write hole (M0-b codex P1)** — paneId 없이 write 한 뒤 paneId 있는 read 가 stale 을 반환할 수 있던 구멍. 3 개의 metadata 핸들러 모두 `pane.resolveActiveLeaf` 로 통일.
- **`workspaceId ?? ''` 가 기억된 scope 를 덮어쓰던 결함** (M0-b codex P2) — coercion 제거; MetadataStore 의 기존 fallback 이 정상 동작.
- **스크롤백 손상 자기증식 루프 (P0 layered defense)** — hidden / zero-width 컨테이너에 대한 `fit()` 이 `cols` 를 ~2 로 collapse 시키면, renderer 의 5초 autosave 가 그 reflowed 버퍼를 캡처해 column-of-chars 로 디스크에 dump. 다음 부팅에 fresh xterm 에 복원되고 또 다시 5초 후에 dump 되며 영구적 손상 루프. 픽스는 네 층: (a) dump-time eligibility 가드 (`cols < 12` / `rows ≤ 0` / `offsetWidth === 0` / detached element), (b) font/theme-change `fit()` 의 visibility 가드 (마지막 unguarded fit 사이트 닫힘), (c) IPC `SCROLLBACK_DUMP` 의 시그니처 거부, (d) IPC `SCROLLBACK_LOAD` 의 시그니처 검출 + 격리 + `.bak` 회전 체인 fallback. 시각 증상은 "재부팅하면 일부 패널 스크롤백이 비어 보임". 자세한 forensic 은 PR #34 참조.
- **부팅 직후 일부 패널이 input-mute 였던 결함 (reconcile race)** — `daemon.whenReady()` 와 `daemon.onConnected` 가 첫 연결에 같은 reconcile 을 동시에 trigger, 두 walk 가 같은 session 에 대해 race 하면서 한쪽이 ptyId 를 clear. 사용자 증상: 부팅 후 워크스페이스 전환을 한 번 해야 일부 패널이 살아남. 픽스: `reconcileInFlightRef` 가 중복 trigger 를 drop, workspace snapshot 을 walk 마다 다시 읽어 동시 spawn 이 frozen view 에 가려지지 않음.
- **`pty:resize` 가 recovery PTY mute race 를 유발하던 결함** — daemon 이 아직 session 을 publish 하기 전에 renderer 가 보낸 `pty:resize` 가 "session not found" 로 실패하고 recovery PTY 가 muted 상태로 남던 결함. 50 × 20ms retry budget + 진단 로그 추가.
- **IPC `session` + `scrollback` 핸들러가 daemon-connect handler-swap cycle 의 unregister 윈도우에 떨어지던 결함** — cold boot 시 `scrollback:load` 가 "No handler registered" 로 거부되고 다음 5초 autosave 가 빈 버퍼를 디스크에 덮어쓰던 결함. session + scrollback 핸들러를 swap cycle 밖으로 이동.
- **logSink 의 EPIPE 무한 루프** — stdout 이 닫힌 상태에서 console.error 가 logSink 를 호출하고 logSink 가 다시 console.error 를 호출하던 reentrancy 루프. reentrancy 가드 + `orig()` try/catch 추가. `appendFileSync` 사용으로 로그가 디스크에 durable.

### Migration Notes

- **자동 마이그레이션**. 사용자 액션 불필요한 부분: substrate wire 변경 (모두 additive optional), MetadataStore 통합 (paneSlice consumer 영향 없음), atomic write + .bak rotation (v2.7.x 부터 이미 다른 파일에 적용된 패턴).
- **v2.8.x 의 chopped 스크롤백**: 첫 부팅에서 자동 격리된다. **데이터를 v2.9.0 이 버린 게 아니라 v2.8.x 시점에 이미 chopped 형태로 저장돼 있던 것을 v2.9.0 이 검출만 한 것**. 사람이 읽을 수 있는 텍스트로의 회수는 `node scripts/recover-scrollback.mjs --verbose` 로 가능 (자세한 가이드는 `docs/upgrade-v2.9.0.md`).
- **`corrupted/` 폴더**: 30 일 / 폴더당 10 파일까지 자동 정리. 수동 삭제도 안전.
- **`pane.metadata.changed` event subscriber**: optional `version` 필드가 추가됐다. 무시해도 v2.x 와 동일 동작.

## [2.8.4] — 2026-05-12 — Agent Notification Pipeline Restoration

사용자가 보고한 "Claude 가 작업을 끝내도 사이드바 dot, unread 배지, OS 토스트 — 3가지 신호 전부 안 뜬다" 결함을 root-cause 수준에서 복구. main 의 감지 레이어 (PTYBridge, AgentDetector, ActivityMonitor) 가 emit 하는 신호를 renderer UI 까지 연결하는 wiring 이 4 군데 끊겨 있었고, **wmux production 인 daemon mode 에서는 PTYBridge 가 아예 우회되어 본 fix 가 0 효과** 라는 더 큰 결함도 포함. 메인은 PR #30 (4 commits, +1579/-141, 29 files) 이고, 같은 릴리즈에 두 개의 다른 PR — **#28 (@dev-minggyu, workspace drag reorder 복구 — 외부 기여 첫 컨트리뷰션)** 과 **#29 (multiview sticky group + MiniSidebar feature parity)** — 도 함께 ship 됐다.

### Fixed

- **Workspace 드래그 정렬이 동작하지 않던 결함 (#28, @dev-minggyu — 외부 기여 첫 컨트리뷰션)** — 좌측 사이드바의 전역 파일-드롭 핸들러가 내부 워크스페이스 드래그 이벤트까지 OS 파일 드롭처럼 처리하면서 `move` 드래그가 충돌해 정렬이 막혀 있었다. 신규 `src/shared/dragDrop.ts` 헬퍼가 `DataTransfer` 가 실제 OS 파일 드래그인지 판별, 전역 드롭 핸들러와 오버레이가 파일 드래그에만 반응하도록 제한. 내부 `text/plain` 드래그 회귀 테스트 21 라인 추가.
- **Multiview sticky group + MiniSidebar feature parity (#29)** — 사용자가 보고한 multiview 3개 결함을 묶어 수정. (a) Ctrl-click 순서 무시되고 grid 가 항상 workspace 배열 순서로 렌더되던 결함 → `AppLayout` 이 `multiviewIds` 자체를 iterate 해서 Ctrl-click 순서 보존. (b) 그룹 밖 workspace 를 plain-click 하면 그룹이 통째로 사라지던 결함 → `setActiveWorkspace` 가 `multiviewIds` clear 안 함 + `activeWorkspaceId ∈ multiviewIds` 일 때만 grid 렌더 (그룹 외부 클릭 시엔 단일 view, 멤버 재클릭 시 grid 복구). (c) 접힌 사이드바 (MiniSidebar) 가 multiview indicator / drag-reorder / W1·W2 라벨 / unread 배지 / agent dot 전부 없던 결함 → 펼친 사이드바와 동일 기능 부여, `AGENT_STATUS_ICON` 을 `Sidebar/agentStatusIcon.ts` 로 추출해 두 사이드바 lockstep. Codex review 가 잡은 reseed 결함 (stale 그룹에서 새 multiview 시작 시 Ctrl-click 무반응) 도 함께 수정. +5 multiview 회귀 테스트.
- **AgentDetector status event 가 아무에게도 listen 되지 않던 결함** — `src/main/pty/PTYBridge.ts:207` 가 `agentDetector.onCritical` 만 구독하고 `onEvent` 는 dead code. Claude/Codex/Aider 의 "esc to interrupt" / "shift+tab to cycle" / "Applied edit to" 같은 정확한 prompt 패턴은 감지되어 emit 되었지만 호출되는 콜백이 0 개라 사이드바 dot 이 영영 켜지지 않았다. PTYBridge 가 `onEvent` 도 구독하도록 추가, `IPC.METADATA_UPDATE` 로 `agentStatus`/`agentName` broadcast + `sendNotification` 호출.
- **`IPC.NOTIFICATION` payload shape 가 sender 마다 달라서 외부 RPC 알림이 깨지던 결함** — `PTYBridge` 는 `(channel, ptyId, notification)` 3-arg, `notify.rpc.ts` 는 `(channel, { title, body, type })` 1-arg. preload `notification.onNew` 는 3-arg signature 라 RPC path 의 첫 인자가 ptyId 자리로 들어가 payload 가 silent 하게 깨졌다. 새 `sendNotification` utility (`src/main/notification/sendNotification.ts`) 가 단일 `(window, ptyId|null, payload)` contract 로 통일.
- **`IPC.METADATA_UPDATE` 가 두 sender 사이에 shape 불일치였던 결함** — `metadata.handler` 는 `(ptyId, data)` 2-arg, `meta.rpc` 는 `(payload)` 1-arg 로 같은 채널에 송신. 한 path 가 정상 동작하는 동안 다른 path 가 silent 하게 깨졌다. `MetadataUpdatePayload` (`src/shared/types.ts`) 를 단일 discriminated payload 로 정의, `broadcastMetadataUpdate` utility 로 모든 sender 통일. meta.rpc 의 `{kind: 'status'|'progress'}` discriminator 폐기, workspace-level field 로 직접 매핑.
- **WorkspaceMetadata.agentStatus 가 자동으로 'idle' 로 복귀하지 않던 결함** — `'waiting'`/`'complete'`/`'running'` 이 한 번 set 되면 lifecycle reset 없음. 사용자 입력 후 agent 가 다시 실행되어도 dot 은 `'waiting'`, PTY 가 죽어도 dot 은 `'running'` 으로 남는 거짓말 발생. ActivityMonitor 의 새 `onActive` 콜백이 burst 진입 시점에 `'running'` 설정, `PTYBridge.onExit` 가 `'idle'` broadcast, `cleanupInstance` 도 dispose path 에서 동일하게 broadcast (idempotent). renderer 의 `AppLayout` 가 session restore 직후 모든 workspace 의 stale agentStatus 를 sanitize.
- **Daemon mode 에서 알림 wiring 이 통째로 빠져 있던 결함 (production blocker)** — wmux 의 production normal 은 daemon mode. PTY output 은 `DaemonPTYBridge` 를 통과하고 `PTYBridge` 는 우회된다. `DaemonPTYBridge` 가 이미 `'agent'`/`'critical'`/`'idle'` event 를 emit 하고 있었지만 `DaemonSessionManager` 는 `'idle'` 만 forward, `daemon/index.ts` 는 `'activity.idle'` 만 broadcast, `DaemonClient` 는 `'session.died'` 만 specific emit. 즉 local mode fix 만으로는 사용자 환경에서 0 효과. 신규 `DaemonNotificationRouter` (`src/main/notification/DaemonNotificationRouter.ts`) 가 daemon broadcast event 5 종 (`session:agent`/`active`/`critical`/`idle`/`died`/`destroyed`) 을 listen 해서 PTYBridge 와 동일한 로직 실행. `DaemonEvent` type 에 `'activity.active'` + `'session.destroyed'` 추가, `daemon/index.ts` 가 신규 type 모두 broadcast, `DaemonClient` 가 specific emit. daemon 측 `AgentDetector` 의 dedup state 도 onActive burst 시점에 in-process 로 reset (main 에서 daemon process 의 detector 에 접근 불가하기 때문).
- **PTY echo / SIGWINCH redraw 가 false-positive idle 알림을 유발하던 결함 (사용자 발견)** — 7-round review pipeline (CEO + Eng + Codex × 4 + Claude subagent) 가 catch 못 한 케이스. ActivityMonitor 는 byte count 휴리스틱이라 "agent task ending" 과 "외부 상태 변화로 인한 PTY redraw" 를 구분 못 함. (a) 사용자 keystroke 가 PTY echo 로 돌아와 active threshold 를 넘기고 잠시 멈추면 "Task may have finished" 가 사용자 입력 중에 발화. (b) workspace 전환 시 `FitAddon.fit()` → `IPC.PTY_RESIZE` → SIGWINCH → TUI agent 의 full-screen redraw 가 active 진입 → 5s 후 idle timer 발화. 신규 `idleSuppression` 모듈 (`src/main/notification/idleSuppression.ts`) 이 `lastResizeAt`/`lastUserWriteAt` 을 per-ptyId 로 추적, 30 s window 내면 activity-fallback 알림 suppress. AgentDetector 의 precise event 는 gate 안 함 (정확한 신호이므로). `pty.handler.ts` 의 4 path (write × 2 + resize × 2) 가 `markResize`/`markUserWrite` 호출. 사용자가 보고한 "타자 치는 중 알람" + "워크스페이스만 눌렀다가 다른 곳 가면 +1" 두 시나리오 모두 해결.
- **사용자가 보고 있는 surface 에도 알림이 누적되던 결함** — `useNotificationListener` 가 active workspace 의 active surface 일치 여부 체크 없이 무조건 `addNotification` + `pushToast` 호출. 사용자가 직접 보고 있는 곳은 알림 의미 0 인데 unread 배지가 계속 올라갔다. 알림 발생 직전 `isActivePtySurface` 체크 → 일치하면 in-app surface (`addNotification` + `pushToast`) skip. OS toast 는 `ToastManager` 가 자체 focus gate 가지고 있어 변경 없음.
- **workspace 전환만으로는 unread 가 read 처리 되지 않던 결함** — 사용자 보고: "워크스페이스만 눌러서 들렀다가 다른 곳 가면 unread 가 +1." Pane click 만이 markRead 트리거였고 sidebar 의 workspace 타일 click 은 read 영향 0. `workspaceSlice.setActiveWorkspace` action 이 해당 workspace 의 모든 unread 를 read 로 자동 처리하도록 변경. `Array.isArray(state.notifications)` 가드로 workspaceSlice 단독 테스트 호환.
- **pushToast 가 사용자 toast 설정 무시하던 결함** — `useNotificationListener` 가 settings 의 `toastEnabled` 무시하고 매번 in-app overlay 띄움. 사용자가 "Toast notifications" 끄면 OS toast 만 suppress, in-app 은 그대로 표시되던 결함. `state.toastEnabled` gate 추가 (sound playback 패턴과 동일).
- **AgentDetector 의 Claude `esc to interrupt` 가 false-positive 'waiting'** — 실제로는 "지금 response 가 진행 중, ESC 로 중단 가능" 힌트이지 idle 신호가 아니다. 패턴 제거. mid-turn 에 잘못된 알림 fire 차단.
- **AgentDetector enum 명명 불일치** — `AgentEvent.status: 'completed'` vs `WorkspaceMetadata.agentStatus: 'complete'`. `AgentStatus` enum 으로 통일 (Aider 패턴 `'completed'` → `'complete'` 텍스트 변경 포함). 외부 consumer 없어 안전.
- **AgentDetector dedup 이 turn N+1 의 같은 prompt 를 영영 차단하던 결함** — `lastEmittedKey` 가 single global string 이라 한 번 emit 한 prompt 는 다시 emit 안 됨 → 사용자가 추가 입력해도 사이드바 dot 갱신 0. `lastEmittedFor` Map 으로 per-(agent:status) 분리 + `resetEmissionState()` method 추가, ActivityMonitor 의 새 active burst 시점에 reset (turn boundary). local mode 는 PTYBridge 가 직접 호출, daemon mode 는 `DaemonPTYBridge.onActive` 콜백이 in-process 에서 호출.
- **AgentDetector 의 ANSI strip 이 private-mode prefix 를 못 잡던 결함** — `\x1b[?25h` 같은 cursor visibility 시퀀스 (`?` 포함) 가 `[0-9;]*[a-zA-Z]` regex 와 안 맞아 `clean` 에 잔존, gate 매칭 실패 가능. `[0-9;?<=>]*[a-zA-Z@]` 로 확장.
- **AgentDetector 가 lone `\r` redraw 를 한 라인으로 처리하던 결함** — Claude/Codex TUI footer 는 CR 단독으로 redraw. `split(/\r?\n/)` 가 통째로 묶어 line-anchored regex 가 매칭 실패. `split(/\r?\n|\r(?!\n)/)` 로 확장.
- **AgentDetector.onEvent/onCritical 이 unsubscribe 안 돌려주던 결함** — `void` 반환이라 PTY recycle 시마다 listener 누적. v2.7.2 의 PlaywrightEngine CDP 세션 누수와 동일 카테고리. unsubscribe 함수 반환으로 변경, PTYBridge `cleanupInstance` + DaemonPTYBridge `cleanup` 에서 호출. ActivityMonitor 의 `onActiveToIdle`/`onActive` 도 같은 패턴.
- **AgentDetector callback 내부 throw 가 후속 라인 감지를 죽이던 결함** — PTYBridge middleware 패턴과 일치시켜 onEvent/onActive 콜백 본문에 try/catch 가드 추가. 한 callback 의 실패가 PTY stream 전체를 죽이지 않게 격리.
- **`AGENT_EVENT_SUPPRESSION_MS` 로 ActivityMonitor 의 fallback 알림 dedup** — AgentDetector 가 precise event emit 직후 ActivityMonitor 가 또 idle 발화하면 같은 turn 에 알림 2 회. PTYBridge / DaemonNotificationRouter 가 `lastAgentEventAt` 추적, 10 s 이내면 fallback skip.
- **`notify` RPC 가 workspaceId 없이는 깨지던 결함** — preload signature 가 `ptyId: string` 강제, `addNotification` 이 `surfaceId` 강제. RPC path 는 ptyId 가 없어 silent drop 되거나 type error. workspaceId optional 로 변경 (CLI `wmux notify` backward compat 유지), `Notification.surfaceId` optional, useNotificationListener 가 `null` ptyId 면 workspaceId 로 active surface resolve (or active workspace fallback).

### Added

- **`sendNotification` utility** (`src/main/notification/sendNotification.ts`) — 모든 `IPC.NOTIFICATION` 송신의 단일 entry point. window null/destroyed 가드 + `(ptyId | null, payload)` 시그니처 통일. PTYBridge 4 호출 지점 + notify.rpc + DaemonNotificationRouter 모두 import.
- **`broadcastMetadataUpdate` utility** (`src/main/ipc/handlers/metadata.handler.ts`) — 모든 `IPC.METADATA_UPDATE` 송신의 단일 entry point. MetadataUpdatePayload 단일 shape.
- **`idleSuppression` 모듈** (`src/main/notification/idleSuppression.ts`) — per-PTY resize/user-write 시점 추적. 30 s suppression window 로 ActivityMonitor 의 byte-count heuristic false-positive 차단.
- **`DaemonNotificationRouter`** (`src/main/notification/DaemonNotificationRouter.ts`) — daemon mode 에서 PTYBridge 의 알림 라우팅 역할 대체. `DaemonClient` event 5 종 listen → `sendNotification` + `broadcastMetadataUpdate` + toast.
- **AgentDetector 의 in-process API 확장** — `getActiveAgents()` / `getLastAgent()` / `resetEmissionState()` public method 추가. PTYBridge 가 lastAgent name 을 onActive metadata 에 채워 넣을 수 있게.
- **37 신규 unit test** — `AgentDetector.test.ts` (18, enum/unsubscribe/dedup/`\r` split/ANSI strip/getters/critical), `ActivityMonitor.test.ts` (+4, onActive cycle dedup), `sendNotification.test.ts` (4, null/destroyed/ptyId 분기), `PTYBridge.notify.test.ts` (5, METADATA_UPDATE + NOTIFICATION + try/catch + cleanup unsub), `notify.rpc.test.ts` (6, workspaceId optional + MCP path + type fallback + toast). IRON RULE 7 regression 중 6 cover, R7 (pushToast in renderer) 는 jsdom 필요해 manual.

### Migration Notes

- 자동. 사용자 액션 불필요.
- `Notification.surfaceId` 를 optional 로 변경 — `Pane.tsx` 의 `surfaceIds.has(n.surfaceId)` 에 undefined guard 추가됨. 다른 consumer 없음.
- `AgentEvent.status` enum 변경 (`'completed'` → `'complete'`) — wmux 내부에서 PTYBridge `onCritical` 만 consume 했고 onEvent 는 dead code 였으므로 외부 영향 없음.
- `IPC.METADATA_UPDATE` payload shape 통일 — preload `metadata.onUpdate` 시그니처가 `(payload)` 단일 인자로 변경. renderer 의 `useNotificationListener` 가 호환 처리. 외부 MCP / CLI consumer 영향 없음.
- `notify` RPC 의 `workspaceId` 는 optional 신규 param. CLI `wmux notify --title X --body Y` 는 그대로 동작. MCP 클라이언트가 `mcp.claimWorkspace` 의 workspaceId 를 함께 보내면 precise routing (active surface auto-select).

### Deferred (follow-up issues)

- `DaemonNotificationRouter` regression test suite — manual verification 으로 cover, daemon IPty pipeline mock 은 별도 작업.
- session-restore sanitize regression test — session fixture builder 필요.
- `onExit` elapsed=0 cosmetic (cleanupInstance 가 ptyCreatedAt 먼저 wipe 하는 path) — purely message-text, behavioural 영향 0.
- `DaemonClient.removeAllListeners` on disconnect — pre-existing, 본 PR 범위 외.
- `TODOS.md` 에 cherry-picked deferral 추가: E3 (transient dot flash animation, P3), E4 (per-workspace notification mute, P2), E5 (tray icon unread badge — cross-platform, P2), Phase 2 Eureka (Claude Code stop-hook → OSC 9 BEL emit, P3).

### Review Trail

| Pass | Reviewer | Findings | Status |
|---|---|---|---|
| Plan 1 | `/plan-ceo-review` | 5 proposals | SELECTIVE_EXPANSION, 2 accepted |
| Plan 1 | Codex round 1 | 10 | all addressed |
| Plan 1 | `/plan-eng-review` | 11, 1 critical | all addressed |
| Plan 1 | Codex round 2 | 8 | all addressed (daemon mode wiring 6 파일 추가) |
| Code 2 | Codex round 3 | 2 (P1+P2) | all addressed in `5aee27f` |
| Code 3 | Codex round 4 | 3 (P2+P2+P3) | all addressed in `cddd3bd` |
| Code 3 | Claude subagent | 7 (P2+P2+P3×5) | 2 addressed, 5 deferred |
| Code 4 | 사용자 manual test | 2 (resize/typing FP) | addressed in `42f5bd3` |

7-round review pipeline 의 한계: AI review 가 PTY echo / SIGWINCH redraw 같은 **runtime 동작** 은 코드만 보고 모델링하기 어렵다. 사용자 manual test 가 마지막 안전망이 됐다는 점이 기록 가치 있음.

## [2.8.3] — 2026-05-11 — License Bundling + Third-Party Notices Attribution

wmux 빌드 산출물에 부족했던 attribution 의무를 정리한 patch. `THIRD_PARTY_NOTICES` 가 Playwright 하나만 적혀 있었지만 실제 runtime 번들은 **110 packages** (16 직접 deps + Electron + ~93 transitive) 를 포함하고 있었다. MIT/ISC/BSD/Apache-2.0 의 "all copies or substantial portions" 조항을 모두 충족하도록 재구성. 코드 동작 변경 없음 — 사용자 가시 변경은 tray 메뉴에 라이선스 진입점 3 개 신설.

### Added

- **자동 생성 스크립트 `scripts/generate-notices.mjs`** — `npm run notices` 로 production deps tree 전체를 walk 해서 `THIRD_PARTY_NOTICES` 를 재생성한다. 외부 의존성 0 개 (`npm ls --prod --all --json` + `node:fs` 만 사용). 추가 install 없이 CI 에서도 그대로 실행 가능. dependency 변경 시 즉시 갱신.
- **Tray 컨텍스트 메뉴 라이선스 진입점 3 개** — `About wmux` (네이티브 About 패널), `License (wmux)` (MIT 본문 직접 열기), `Third-party licenses` (`THIRD_PARTY_NOTICES` 직접 열기). `shell.openPath` 로 OS 기본 텍스트 앱에서 열고, 연결된 앱 없으면 `showItemInFolder` fallback. 그동안 wmux 는 application menu 자체가 없어서 사용자가 라이선스 파일에 도달할 경로가 0 이었다.
- **`app.setAboutPanelOptions`** — 네이티브 About 다이얼로그에 wmux 버전 / MIT copyright pointer / project URL metadata 설정. macOS 는 앱 메뉴에서 자동 표시, Windows/Linux 는 신규 tray 항목 "About wmux" 가 트리거.

### Fixed

- **`THIRD_PARTY_NOTICES` 의 109 packages 누락** — 이전 파일은 Playwright 1 개만 적혀 있어 사실상 MIT/ISC/BSD/Apache-2.0 attribution 의무 (carry copyright notice in "all copies") 가 부분 미준수 상태였다. 자동 생성으로 110 packages 모두 채움. 라이선스 분포: 98 MIT, 7 ISC, 2 Apache-2.0 (electron-squirrel-startup, playwright-core), 2 BSD-3-Clause, 1 BSD-2-Clause. **Zero copyleft, zero unknown** — 재배포 권리 위험 0.
- **wmux 자체 `LICENSE` 가 빌드 산출물에 누락** — `forge.config.ts` 의 `extraResource` 에 `./LICENSE` 추가. 빌드 후 `<install>/resources/LICENSE` 에 위치하여 wmux 의 MIT 본문도 exe distribution 과 함께 carry. (Electron 본체 LICENSE — Chromium / V8 / Node 커버 — 는 electron-packager 가 install root 의 `wmux.exe` 옆에 자동 emit, 이미 충족됨.)

### Migration Notes

- 자동. 사용자 액션 불필요. 외부 MCP 통합 측에 변경 없음. 빌드 자체에 영향 없는 데이터 + UI 보조 작업.

## [2.8.2] — 2026-05-11 — Session Cap Headroom + Silent-Failure Fix

@alphabeen 이 v2.8.1 출시 직후 PR #25 로 보고한 두 문제를 한 patch 에 묶는다. v2.8.1 의 startup brick 픽스 이후에도 **runtime accumulation** 시나리오 (X close 후 daemon 이 유지하는 detached 세션이 며칠에 걸쳐 누적) 에서는 hard cap 50 에 다시 도달했고, 더 나쁜 건 cap throw 가 renderer 의 `Ctrl+T` 핸들러에서 silent 하게 묻혀 단축키가 무반응처럼 보이던 결함이다. v2.8.1 사용자는 즉시 업그레이드 권장.

### Fixed

- **데몬 세션 hard cap 50 → 200 상향** — #25, @alphabeen. v2.8.0 의 세션 영속화 이후 cap 의 의미가 "한 세션 동안 최대 동시 PTY" → "lifetime 누적 detached PTY 총합" 으로 바뀐 결과, multi-workspace + 빈번한 split 사용자는 며칠 내 50 에 재도달. 50 자체는 [commit 989dd8a](https://github.com/openwong2kim/wmux/commit/989dd8a) 의 보안 하드닝 단계에서 정한 DoS 휴리스틱이었고 200 도 같은 카테고리 안. soft cap 40 (recovery) / 7-day suspended TTL 정책은 무변경. 헤드룸 10 → 160. 근본 해결 (orphan detached GC) 은 v2.9 트랙으로 별도 검토. 구현: `src/daemon/DaemonSessionManager.ts`, `src/daemon/index.ts` 주석 동기화.
- **`pty.create` rejection 이 묻혀 단축키 무반응처럼 보이던 회귀** — @alphabeen 이 PR #25 description 에서 짚어준 두 번째 문제. cap 도달 시 daemon 이 actionable 에러 (`Cannot create new terminal: 200 active sessions already running. Close some panes (or restart wmux) and try again.`) 를 throw 하는데 renderer 의 세 호출 지점 (`useKeyboard` Ctrl+T 핸들러 / `AppLayout` empty-leaf 자동 PTY / `FloatingPane` 첫 열림) 모두 `.then()` 만 달고 `.catch()` 누락 (또는 silent catch) 이라 rejection 이 묻히고 단축키가 무반응처럼 보였다. v2.8.1 Bug 1 의 actionable error 의도가 무력화되던 결함.
  - **신규 IPC 에러 코드 `RESOURCE_EXHAUSTED`** — `wrapHandler` 의 `classifyError` 가 cap 메시지 패턴 (`cannot create new terminal` + `active sessions already running`) 을 감지해 분류. 메시지에 `[RESOURCE_EXHAUSTED]` prefix 가 stamp 되어 renderer 가 분기 가능.
  - **`useIpc` 매핑** — `DEFAULT_MESSAGES['RESOURCE_EXHAUSTED']` = "터미널 세션 한도에 도달했습니다. 일부 pane을 닫거나 wmux를 재시작한 뒤 다시 시도해주세요.", level `'warn'`. UNKNOWN 으로 매핑되어 generic "알 수 없는 오류" 토스트가 뜨던 path 차단.
  - **세 호출 지점 모두 `ipcInvoke` wrap 으로 통일** — `useKeyboard` Ctrl+T (ref 패턴으로 once-on-mount effect 안에서 사용), `AppLayout` empty-leaf 자동 PTY effect, `FloatingPane` 첫 PTY 생성. 모두 `result.ok` 분기 + 실패 시 toast 자동 게재.
  - **Electron invoke envelope wrap 처리** — codex P2 review 에서 잡힌 결함. `ipcRenderer.invoke` 가 main side 에러를 renderer 로 전달할 때 메시지를 `Error invoking remote method 'X': Error: <orig>` 형태로 감싸서, `useIpc` 의 `MESSAGE_CODE_PREFIX` 가 `^` anchor 였던 탓에 `[RESOURCE_EXHAUSTED]` stamp 가 envelope 뒤로 밀려 매칭 실패 → 모든 coded error 가 다시 UNKNOWN 으로 떨어지던 path 차단. renderer regex 만 anchor 제거 (main side 는 자기 raw output 매칭이라 anchor 유지). 알phabeen 이 PR #25 description 에서 짚어준 결함이 두 번 일어나지 않도록 회귀 테스트 추가.
  - 구현: `src/main/ipc/wrapHandler.ts`, `src/renderer/hooks/useIpc.ts`, `src/renderer/hooks/useKeyboard.ts`, `src/renderer/components/Layout/AppLayout.tsx`, `src/renderer/components/Terminal/FloatingPane.tsx`. 6 unit tests 추가 (wrapHandler RESOURCE_EXHAUSTED classification + message prefix stamping + useIpc default 매핑 + Electron-wrapped envelope classification).

### Migration Notes

- 자동. 클라이언트 / 외부 MCP 통합 측에 변경 없음. 신규 `RESOURCE_EXHAUSTED` 코드는 내부 IPC 경계 안쪽에서만 사용 (renderer ↔ main).

## [2.8.1] — 2026-05-10 — Session Recovery Stability Hotfix

@alphabeen 이 v2.8.0 출시 직후 보고한 세 가지 회귀 — 시간이 갈수록 wmux 가 사용 불가 상태로 빠지던 critical, recovered pane 출력이 깨지던 high, 매 시작마다 generic 에러 토스트가 뜨던 medium — 을 한 릴리스에 묶어 수정한다. v2.8.0 사용자는 즉시 업그레이드 권장 — 자동 마이그레이션이 누적된 `sessions.json` 을 첫 실행 시 정리한다.

### Fixed

- **세션 누적으로 인한 brick 상태 (Critical)** — v2.8.0 에서 도입된 데몬 세션 영속화는 사용자가 X 로 종료한 모든 live pane 을 `suspended` 로 저장하고 다음 시작 시 복구한다. 그런데 (1) 복구 횟수에 상한이 없었고, (2) 종료 시점에 사용자가 명시적으로 닫지 않은 세션은 영원히 `sessions.json` 에 남아 누적됐다. 4–5 회 재시작이면 데몬의 하드 PTY 캡 (`MAX_SESSIONS=50`) 을 모두 소진하여 startup recovery 가 새 pane 슬롯을 못 만들고, UI 는 `Ctrl+T` 도 안 먹히고 generic "알 수 없는 오류" 토스트만 도배되는 상태에 빠진다. 자가복구 불가능 (재시작해도 같은 시나리오 반복).
  - **Suspended 7-day TTL** — `StateWriter.load` 가 이제 dead 세션뿐 아니라 7 일 이상 inactive 한 suspended 도 함께 prune. v2.8.0 에서 누적된 기존 `sessions.json` 도 첫 v2.8.1 실행 시 자동 정리된다.
  - **Recovery soft cap 40** — 신규 `MAX_RECOVER_SESSIONS=40`. 복구 후보를 `lastActivity` 내림차순 정렬해 상위 40 개만 PTY 로 재생성하고 나머지는 그대로 suspended 로 남는다. 다음 launch 에서 활성 카운트가 줄면 자동으로 복구 후보에 다시 들어오며, 7 일 TTL 이 그래도 정체된 것을 reap. 이로써 hard cap 50 에 도달해도 항상 신규 pane 헤드룸 10 슬롯이 보장된다.
  - **`createSession` 에러 메시지 사용자 친화적 변경** — `Maximum session limit (50) reached` → `Cannot create new terminal: 50 active sessions already running. Close some panes (or restart wmux) and try again.`. RPC 응답으로 그대로 노출되어 향후 토스트가 generic 이 아닌 actionable 메시지로 보임.
  - 구현: `src/daemon/StateWriter.ts`, `src/daemon/index.ts`, `src/daemon/DaemonSessionManager.ts`, `src/daemon/recoverySelector.ts` (신규 — pure 함수로 cap 정책을 분리해 unit-test 가능). 9 unit tests 추가.

- **복구된 pane 출력 interleave (High)** — v2.8.0 은 종료 시점의 PTY cols/rows 를 저장하고 복구 시 그 값으로 ConPTY 를 spawn 한다. 사용자가 윈도우 사이즈를 바꾸고 재시작하면 ConPTY 는 옛 geometry 로 출력하는데 xterm 은 새 geometry 로 그려서 같은 줄에 두 paint 의 문자가 interleave 된다 (예: `Accessing workspace:` → `Accessingwworkspace:`).
  - **Deferred output mode** — `DaemonPTYBridge` 에 `setMuted(bool)` 추가. recovery 경로에서 `createSession({deferOutput: true})` 면 bridge 가 muted 로 시작하여 PTY 데이터 path 가 ring buffer 에 쓰지 않는다 (exit 알림은 muted 와 무관하게 정상 동작). renderer 가 첫 `daemon.resizeSession` 을 호출하면 PTY 가 진짜 geometry 로 resize 되고 `DEFERRED_UNMUTE_DELAY_MS=100` 후 자동 unmute. ConPTY 가 옛 geometry 에서 큐잉했던 출력은 100 ms 동안 drain 되고 버려진다. 저장된 scrollback (buffer dump) 은 ring buffer 에 직접 pre-fill 되므로 muted path 와 무관하게 보존된다.
  - 구현: `src/daemon/DaemonPTYBridge.ts`, `src/daemon/DaemonSessionManager.ts`, `src/daemon/index.ts` (recoverSessions 의 createSession 호출 3 곳 모두 `deferOutput: true`). 5 unit tests 추가 (drop while muted / scrollback 보존 / resize-then-unmute / 비-deferred regression / muted 중 exit 발화).

- **시작 시 generic 에러 토스트 폭주 (Medium)** — main process 가 daemon connect 를 비동기로 시도하는 동안 renderer 가 이미 IPC 호출을 던져, handler swap (`cleanupHandlers()` → `registerAllHandlers(...)`) 의 sub-millisecond 무등록 윈도우에 떨어진 호출이 `No handler registered for ...` 로 실패해 `useIpc` 가 `UNKNOWN` → "알 수 없는 오류가 발생했습니다." 토스트를 5–10 회 띄우던 문제.
  - main 이 단일 IPC handler `daemon:get-ready-state` 를 등록 (registerAllHandlers swap cycle 바깥이라 무등록 race 불가). connect 시도가 끝나면 `markDaemonReady()` 가 그동안 큐잉된 invoke 를 해제. 이후 invoke 는 즉시 현재 `daemonClient` 상태로 응답.
  - preload 의 `electronAPI.daemon.whenReady()` 가 `ipcRenderer.invoke('daemon:get-ready-state')` 를 호출 (one-shot event 가 아니라 query). renderer crash recovery 의 `mainWindow.reload()` 로 새로 로드된 preload 인스턴스도 정상 응답을 받아 deadlock 안 됨 (codex review fix — 초기 event-based 설계의 P2 결함 보강).
  - `AppLayout` 의 첫 reconcile 이 `daemon.whenReady()` 를 await 하여 handler 가 안정된 뒤에야 `pty.list` / `pty.reconnect` 를 호출. 토스트 폭주 사라짐.
  - 구현: `src/main/index.ts`, `src/preload/preload.ts`, `src/renderer/components/Layout/AppLayout.tsx`.

- **Split 후 빈 pane 이 영구 placeholder 로 남던 문제** — `AppLayout` 의 auto-PTY effect 가 `activeWorkspace.id` 만 deps 로 가져 split 으로 추가된 새 leaf 가 `surfaces=[]` 인 채 effect 재실행을 유발하지 못했다. 결과적으로 분할된 새 pane 이 "빈 창" placeholder 로 굳어 PTY 가 영영 안 붙었다. `collectEmptyLeaves` 를 effect 바깥으로 끌어올리고 빈 leaf id 들의 join 키를 deps 에 추가해 split 이 즉시 PTY 생성을 트리거하도록 수정. paneSlice 에 회귀 테스트 추가 (`src/renderer/stores/slices/__tests__/paneSlice.test.ts`).

- **한글 IME 상태에서 Ctrl+D / Ctrl+Shift+D split 단축키 미작동** — Hangul 레이아웃에서 `e.key` 가 `'ㅇ'` 또는 `'Process'` 가 되어 useKeyboard 의 `key === 'd'` 매칭이 빗나가고, useTerminal 의 xterm allowlist 도 같은 이유로 빠져 단축키가 xterm 에 흘러갔다. 두 곳 모두 `e.code === 'KeyD'` (물리 키 코드) 도 함께 매칭하도록 수정 — 기존 Ctrl+B / Ctrl+M 등의 cross-layout 패턴과 일관. 구현: `src/renderer/hooks/useKeyboard.ts`, `src/renderer/hooks/useTerminal.ts`.

- **분할 pane 을 키보드/마우스로 닫을 수 없던 문제** — Ctrl+W 가 `closeSurface` 만 호출해 마지막 surface 닫혀도 pane 이 collapse 안 되고, 단일 surface pane 에서는 `SurfaceTabs` 가 strip 자체를 숨겨 X 버튼도 없었다. (1) Ctrl+W 가 마지막 surface 닫힐 때 `closePane` cascade 호출 (Pane.tsx X-button 동작 미러), (2) `SurfaceTabs` 가 surfaces.length === 1 이어도 strip 렌더, (3) 신규 Ctrl+Shift+Q (tmux kill-pane equivalent) 추가 + `BUILTIN_KEYS` 로 보호, (4) SettingsPanel 의 Ctrl+W 라벨이 실제 동작과 어긋났던 것을 closeSurface / closePane 두 줄로 분리해 i18n 4개 로케일 (en/ko/ja/zh) 모두 수정. 구현: `src/renderer/hooks/useKeyboard.ts`, `src/renderer/components/Pane/SurfaceTabs.tsx`, `src/renderer/components/Settings/SettingsPanel.tsx`.

- **Reconnect 후 출력이 두 줄로 중복되던 문제** — `pty.handler.ts` 의 `PTY_CREATE` 와 `PTY_RECONNECT` 가 매번 새 `daemonClient.on('session:data', listener)` 를 등록하면서 이전 listener 를 떼지 않아 누적됐다. 한 세션을 reconnect 한번만 해도 두 listener 가 같은 chunk 를 두 번 forward 해 renderer xterm 에 중복 출력. per-session listener map 으로 분리하여 같은 ptyId 의 이전 listener 를 항상 정리한 뒤에만 새 listener 등록. 구현: `src/main/ipc/handlers/pty.handler.ts`.

### Migration Notes

- 자동. 첫 v2.8.1 실행 시 `StateWriter.load` 가 7 일 이상 묵힌 suspended 세션을 prune 한다. 추가 액션 불필요. v2.8.0 에서 이미 brick 된 사용자도 업그레이드 후 첫 실행에서 정상 복구된다 (alphabeen 이 가이드한 수동 `sessions.json`/`daemon-pipe`/`daemon.lock`/`daemon.pid` 삭제 절차는 더 이상 필요 없음).
- 외부 MCP 통합 측에 변경 없음 — 모든 변경은 daemon 내부 + main↔renderer IPC 가드.

## [2.8.0] — 2026-05-09 — External Tooling Surface + Cross-Pane Search

외부 AI 도구(Claude Code, 서드파티 MCP)가 wmux 위에 워크플로우를 빌드할 수 있도록 세 개의 신규 surface를 동시 도입한 minor 릴리스다. @alphabeen 의 RFC #15 가 직접적인 트리거이며, 그 결과로 (1) pane 단위 metadata API, (2) cursor 기반 JSON-RPC event bus, (3) cross-pane search 가 묶음으로 들어온다. 모든 신규 필드는 optional 이라 기존 클라이언트는 영향 없으며, `system.capabilities().features` 의 새 키 (`paneMetadata`, `events`) 로 신규 표면을 감지할 수 있다.

릴리스 본문이 큰 만큼 데이터 마이그레이션은 없다. 다만 외부 MCP 통합 코드를 작성한 사람은 "Migration Notes" 의 `bootId` / `asOfSeq` 항목을 한 번 읽고 캐시 무효화 경로를 확인할 것.

### Added

- **Pane metadata API** — #16. `PaneLeaf` 에 optional `PaneMetadata { label?, role?, status?, custom?: Record<string,string>, updatedAt? }` 부착. RPC 3 개 (`pane.setMetadata`/`getMetadata`/`clearMetadata`) + MCP tool 2 개 (`pane_set_metadata`, `pane_get_metadata`). 8 KB 직렬화 캡, label ≤ 64, role ≤ 64, status ≤ 128, custom ≤ 32 entries × 64-char keys. 외부 MCP 의 cross-workspace 하이재킹은 `workspaceId` 자동 스코프 + slice 레벨 검증으로 차단 (v2.7.2 `mcp.claimWorkspace` fix 와 같은 클래스 패턴). `custom` 맵은 `merge=true` 일 때 1 단계 deep-merge — 협력하는 두 MCP 가 서로의 키를 덮어쓰지 않는다.
  구현: `src/shared/types.ts`, `src/shared/rpc.ts`, `src/main/pipe/handlers/pane.rpc.ts`, `src/renderer/stores/slices/paneSlice.ts`, `src/renderer/hooks/useRpcBridge.ts`, `src/mcp/index.ts`.

- **JSON-RPC event bus** — #21 (resubmit of #17, base-deleted artifact). `WmuxEventType` union: `pane.created` / `pane.closed` / `pane.focused` / `pane.metadata.changed` / `workspace.metadata.changed` / `process.started` / `process.exited`. In-memory ring (1024 events) + monotonic `seq` cursor. RPC `events.poll({cursor, types?, workspaceId?, max?})` + MCP tool `wmux_events_poll`. 외부 도구는 자기 워크스페이스 이벤트만 자동 스코프. `bootId` (UUIDv4 / EventBus 인스턴스마다 변경) 가 `events.poll` / `system.capabilities` / `pane.list` 응답에 모두 노출되어 데몬 재시작 시 클라이언트 캐시(pane id, pty id, cursor) 를 깨끗이 무효화할 수 있다. `pane.list` 는 envelope `{asOfSeq, bootId, panes}` 로 변경되어 resync 후 reconcile 의 frame of reference 를 명확히 한다. polling 만 — push/SSE 는 stdio MCP transport 와 안 맞아 deferred.
  구현: `src/shared/events.ts`, `src/main/events/EventBus.ts`, `src/main/pipe/handlers/events.rpc.ts`, `src/renderer/events/publisher.ts`, `src/renderer/stores/slices/searchSlice.ts`.

- **Cross-pane search** — #20. wmux 의 첫 cross-pane primitive. `Ctrl+F` 의 "All Panes" 토글로 현재 워크스페이스 모든 live pane 의 xterm.js 버퍼를 on-demand grep 한다. 결과 ≤ 10 개는 search bar dropdown, > 10 개는 하단 panel 자동 확장 (progressive disclosure UX with hysteresis: open at > 10, close at ≤ 5, sticky bit until session reset). 결과 클릭 → 해당 pane focus + `scrollToLine(physicalBaseY)` 로 wrapped line 까지 정확히 jump. regex 모드 + 잘못된 패턴 visual error (red border + tooltip, no toast). MCP tool `wmux_search_panes(query, regex?)` 로 외부 AI 도 자율 추론 가능 ("JWT 에러 단 pane" 같은). 200-result cap, 20k lines/pane scan cap, 500-char line truncation. cross-workspace 검색은 v2 deferred (RPC-layer caller-identity gate 추가 설계 필요).
  구현: `src/renderer/utils/searchEngine.ts`, `src/renderer/components/Terminal/SearchBar.tsx`, `src/renderer/components/Search/SearchResultsPanel.tsx`, `src/renderer/stores/slices/searchSlice.ts`, `src/mcp/index.ts`. i18n: en/ko/ja/zh 4 locale 모두 신규 키 추가.

### Changed

- **`pane.list` 응답 형태** — `PaneListEntry[]` → `{asOfSeq: number, bootId: string, panes: PaneListEntry[]}` envelope. resync 시 클라이언트가 "이 스냅샷 이후 events" 를 정확히 결정할 수 있다. `panes[]` 는 기존 키 그대로 + 새 `metadata?: PaneMetadata` 필드 추가. 기존 클라이언트는 envelope unwrap 후 `.panes` 만 사용하면 되며, `metadata` 는 optional 이라 무시해도 됨.

- **`system.capabilities` 응답 확장** — `methods: RpcMethod[]` 만 있던 응답에 `features: { paneMetadata: true, events: { types, maxRingSize, bootId } }` 추가. 기존 `methods` 배열은 변경 없이 신규 method 들이 자동 추가된다 (`'pane.setMetadata'`, `'pane.getMetadata'`, `'pane.clearMetadata'`, `'pane.search'`, `'events.poll'`).

### Security

- **Cross-workspace pane.search 누출 차단** — RPC handler 가 caller 가 보낸 `workspaceId` 를 우선 사용하고 fallback 으로만 active workspace 를 쓴다. 외부 MCP 가 자기 ws 컨텍스트로 검색 호출 시, 사용자가 다른 ws 를 보고 있어도 caller 의 ws 결과만 받는다. v2.7.2 `mcp.claimWorkspace` fix 와 동일 클래스의 보안 게이트.
- **Pane metadata cross-ws 하이재킹 차단** — `pane.setMetadata` / `pane.clearMetadata` 도 `workspaceId` 스코프 강제. 외부 MCP 가 사용자 보는 ws 에 임의 metadata 작성 불가.

### Fixed

- **Clipboard selection 잔존 fix** — #19. v2.7.4 에서 도입한 selection-preserving fit 가드가 `isVisible` useEffect 와 `document.fonts.ready` 콜백 두 곳에 누락돼 워크스페이스 전환 직후나 폰트 로드 직후 selection 이 wipe 되던 문제. 또 selection 후 명시적 Ctrl+C 사이에 PTY 출력으로 selection 이 자연 클리어되어 SIGINT 가 가던 문제. fix: 두 가드 추가 + `terminal.onSelectionChange` 기반 자동 복사 (150 ms debounce, main-IPC 경유로 1 MB cap·Win32 lock retry·error toast 모두 보존). 해당 layer 9 unit tests 추가.
  구현: `src/renderer/hooks/useTerminal.ts`, `src/renderer/utils/autoSelectionCopy.ts` (신규).

### Migration Notes

- **외부 MCP 통합 코드** 는 `wmux_search_panes` / `wmux_events_poll` / `pane_get_metadata` 등 신규 도구를 즉시 사용할 수 있다. 신규 surface 감지는 `system.capabilities().features.paneMetadata` 와 `features.events` 키로.
- **`pane.list` 호출자** 는 응답이 envelope 으로 바뀐 점을 반영해야 한다. 기존 코드가 `panes[0].id` 처럼 직접 인덱싱했다면 `result.panes[0].id` 로. 단, MCP `pane_list` tool 은 envelope 그대로 반환하므로 AI 에이전트는 자연어로 처리 가능.
- **이벤트 폴링 클라이언트** 는 매 응답의 `bootId` 를 비교하고, 변경됐다면 cached pane id / pty id / cursor 를 모두 폐기하고 `pane.list` 로 reconcile. `cursor > latestSeq()` 또는 `resync: true` 도 동일하게 처리.

### v1 deferred → v2 candidates

다음 항목들은 본 릴리스 범위 밖으로 명시 deferred — 트래킹 #18 :

- Cross-workspace search 및 metadata write (현재 caller ws 만 — explicit setting + RPC-layer caller-identity gate 설계 필요)
- Push / SSE event delivery (stdio MCP 와 어울리지 않음, 폴링 latency 가 UX 문제 될 때 재검토)
- Dead session scrollback dump 검색 (live pane 만 v1)
- Optimistic concurrency (`expectedVersion`) on `meta.set` — 다중 도구 contention 시 last-writer-wins 를 깨끗이 분리

## [2.7.4] — 2026-05-07 — Terminal Stability (4-bug Fix)

v2.7.0 의 UI 확장 후 누적된 터미널 안정성 4 건을 묶은 patch. 모두 사용자 가시 회귀라 우선 ship. 데이터 마이그레이션 없음.

### Fixed

- **Hang / CPU 풀가동 (큰 출력)** — `PTYBridge.ts` onData 에 8 ms micro-batch 도입. `OscParser.ts` 가 slice 기반(O(n²) → O(n)). `ActivityMonitor.ts` 가 100 ms 타임스탬프 가드.
- **Ctrl+V paste 일부 누락** — `useTerminal.ts` 의 Ctrl+V / Ctrl+Shift+V 핸들러에 4096 청킹 추가 (우클릭 path 와 동일). `pty.handler.ts` 100 K silent drop backstop 은 유지하되 `console.warn` 추가.
- **Copy 완전 안 됨** — `clipboard.handler.ts` silent return 3 건을 typed throw (`CLIPBOARD_INVALID_TYPE` / `CLIPBOARD_TOO_LARGE` / `CLIPBOARD_WRITE_FAILED`) 로 변환. 4 호출부 (useTerminal ×3 + Terminal.tsx) 가 await + try/catch, 실패 시 selection 유지 + `showCopyErrorToast` (i18n 4 locale).
- **마지막 문단만 복사** — `useTerminal.ts` ResizeObserver / font-theme effect 에 `hasSelection()` 가드 + `windowsPty: { backend: 'conpty', buildNumber: 21376 }` 옵션으로 ConPTY reflow 활성화 (xterm.js 6 의 SelectionService unconditional clear 우회).

### Changed

- `IPC.CLIPBOARD_WRITE` invoke 가 실패 시 throw — renderer 는 await + try/catch 필수.
- `IPC.PTY_DATA` 송신 빈도가 청크 단위 → 8 ms batch 단위 (데이터 내용 / 순서 동일).
- `IPC.PTY_WRITE` 100K 초과 silent drop backstop 은 유지 — renderer 가 청킹으로 회피해야 함.

### Migration Notes

스키마 변경 없음. `clipboardAPI.writeText` 를 호출하는 신규 코드는 await + try/catch 필수.

## [2.7.3] — 2026-04-28 — A2A Execute Approval Gate

외부 MCP 호출자가 `a2a_task_send` 의 `execute:true` 한 줄로 사용자의
워크스페이스에서 `--permission-mode bypassPermissions` 모드의 Claude
CLI 를 무인 실행할 수 있던 표면을 차단한 보안 patch. 단일 항목이지만
RCE 급 표면이라 즉시 출하한다. 데이터 마이그레이션 없음.

### Security

- **A2A `execute:true` 사용자 승인 게이트** — 1cd5ab3. 신규 task 가
  `execute:true` 로 들어오면 ClaudeWorker spawn 직전에 사용자에게
  확인 다이얼로그를 띄운다 — 발신/수신 워크스페이스, 작업 cwd, 메시지
  500 자 미리보기, 30 초 자동 거부 카운트다운. 거부 또는 타임아웃 시
  task 가 `canceled` 로 마크되어 발신자가 `a2a_task_query` 로 거부를
  확인할 수 있다. `cancelTask` 권한이 발신자에서 발신자/수신자로
  완화돼, 수신자가 들어오는 task 를 deny 할 수 있다.
  구현: `src/main/pipe/handlers/a2a.rpc.ts`,
  `src/main/pipe/handlers/_bridge.ts`,
  `src/renderer/components/A2a/ExecuteApprovalDialog.tsx`,
  `src/renderer/utils/executeApproval.ts`,
  `src/renderer/hooks/useRpcBridge.ts`,
  `src/renderer/stores/slices/a2aSlice.ts`.

### Migration Notes

스키마 변경 없음. 자동 마이그레이션 없음. `execute:true` 를 사용하는
기존 자동화는 이제 사람의 승인 없이는 실행되지 않으므로, 신뢰된
caller 가 무인 실행을 기대했다면 향후 도입될 `autoApproveExecute`
설정 토글을 기다리거나 `execute` 없이 호출하도록 조정한다.

## [2.7.2] — 2026-04-25 — Stability & MCP Hardening

v2.7.1 이후 누적된 안정성·보안 하드닝을 묶은 patch 릴리스다. 신규
사용자 대상 UI 기능은 없고, 데이터 마이그레이션도 필요 없다. MCP
통합을 사용하는 외부 클라이언트는 워크스페이스 점유 동작이 바뀌었으니
"Changed" 항목을 한 번 확인할 것.

### Fixed

- **Daemon mass-kill cascade** — fb65626. 한 PTY 가 비정상 종료될 때
  같은 워크스페이스의 다른 PTY 들까지 연쇄 종료되던 문제. 종료 사유를
  per-PTY 로 분리해 cascade 트리거를 차단했다.
  구현: `src/daemon/SessionManager.ts`, `src/daemon/PtySupervisor.ts`.
- **PlaywrightEngine CDP 메모리 누수** — df37e97. `mcp__wmux__browser_*`
  툴 호출 후 CDP 세션이 detach 되지 않아 장시간 사용 시 RAM 이 단조
  증가하던 문제. 페이지 lifecycle 에 detach 를 묶었다.
  구현: `src/main/browser/PlaywrightEngine.ts`.
- **PWSH non-zero exit code 보고** — 83d584e. OSC 133 hook 이 항상 0 을
  보고해 shell-integration 이 실패한 명령을 성공으로 표기하던 회귀.
  `$LASTEXITCODE` 폴백을 추가했다.
  구현: `src/main/pty/shell-hooks/pwsh.ps1`.
- **Multiview 자동 종료** — 77e4d58. 멀티뷰에 포함되지 않은 워크스페이스로
  전환할 때 멀티뷰가 그대로 유지되어 잘못된 팬이 화면에 남던 문제. 전환
  시점에 멀티뷰 상태를 자동 해제한다.
  구현: `src/renderer/store/uiSlice.ts`.
- **우클릭 이미지 붙여넣기** — d071b08 + 889c6d8. (1) 우클릭 컨텍스트
  메뉴에서 이미지 붙여넣기를 지원하고 (2) 공백이 포함된 임시 경로를
  올바르게 quoting + bracketed paste 로 래핑해 셸이 명령을 즉시 실행하지
  않도록 한다. 큰 텍스트 chunk 의 분할 전송 경로도 정리됐다.
  구현: `src/renderer/hooks/useTerminal.ts`,
  `src/main/clipboard/ImagePaste.ts`.
- **Ultrareview 6 건 일괄 수정** — b79115c. SoulLoader RCE/Windows
  비호환 경로(POSIX heredoc → IPC `fs.writeFile`), A2A CR/LF/ANSI 인젝션
  (`safeName`/`safeBody` 가 ESC CSI 와 개행을 strip), StateWriter
  saveImmediate race(immediateEpoch 스냅샷 보존), Squirrel 설치 파일명
  pin (`wmux-{version}.Setup.exe`) 등.
  구현: `src/company/core/SoulLoader.ts`,
  `src/main/a2a/envelope.ts`, `src/daemon/StateWriter.ts`,
  `forge.config.ts`.
- **SoulLoader fs 가드** — `window.electronAPI.fs` 가 옵셔널인데 가드
  없이 접근하던 부분으로 strict TS 체크가 깨져 CI 가 레드였던 문제.
  fs 가 없으면 false 를 반환하도록 정리.
  구현: `src/company/core/SoulLoader.ts`.

### Changed

- **MCP 워크스페이스 claim** — 9db0b25. 외부 MCP 호출자가 사용자의 active
  pane 을 hijack 하지 않고 전용 워크스페이스를 점유한다 (`mcp.claimWorkspace`).
  다중 MCP 클라이언트가 한 wmux 인스턴스에 붙는 시나리오에서 키 입력
  충돌을 제거한다. 기존 클라이언트는 자동 폴백.
  구현: `src/mcp/server.ts`, `src/daemon/WorkspaceClaim.ts`.
- **PTY env filter 일원화** — b19f25a. spawn 직전 env 화이트리스트가
  여러 곳에 흩어져 있던 것을 한 모듈로 모으고, browser export 경로도
  같은 sanitizer 를 거치도록 정리해 환경변수 누설 surface 를 줄였다.
  구현: `src/main/pty/envFilter.ts`,
  `src/main/browser/exportPaths.ts`.

### Internal

- 릴리스 워크플로우에 winget publishing step 추가 (#5, 825f4ee).
- README/SEO 정리 — `cmux for Windows` 포지셔닝 강화, 설치 가이드에
  winget·choco 명령 추가 (0fbbe43, 5f89c0e).

### Migration Notes

스키마 변경 없음. 자동 마이그레이션도 필요 없다. MCP 통합을 사용하는
외부 클라이언트만 워크스페이스 점유 동작 변화를 확인할 것.

## [2.7.1] — 2026-04-20 — Constrained Language Mode Hotfix

PowerShell Constrained Language Mode (AppLocker / WDAC가 적용된 회사·학교 PC)
환경에서 v2.7.0 사용 시 `사용자 지정 키 처리기에서 예외가 발생했습니다`
오류가 매 Enter / 매 prompt 렌더마다 발생하던 회귀를 수정한다. 다른
변경 사항은 없으며 데이터 마이그레이션도 필요 없다.

### Fixed

- **Shell integration script (OSC 133)** — `Set-PSReadLineKeyHandler`의
  Enter 핸들러가 `[Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()` /
  `[Console]::Write()`를 호출하던 부분이 Constrained Mode에서 메서드 호출
  금지 정책에 걸려 PSReadLine이 매 키스트로크마다 예외를 노출했다. 이제
  init 스크립트가 시작 시 `$ExecutionContext.SessionState.LanguageMode`를
  검사해 `FullLanguage`가 아니면 통합 자체를 건너뛰고, 핸들러 본문도
  try/catch로 감싸 런타임 실패 시 plain `AcceptLine`으로 폴백한다.
  구현: `src/daemon/shell-integration.ts`, `INTEGRATION_VERSION` 1 → 2로
  bump하여 디스크에 캐시된 옛 스크립트가 자동으로 재생성된다.
- **PWSH prompt hook (OSC 7 / 7727)** — `[System.Net.Dns]::GetHostName()`
  과 `[Console]::Write()`가 Constrained Mode에서 매 prompt 렌더 시 예외를
  던지던 문제. 이제 LanguageMode 게이트 + try/catch + `$env:COMPUTERNAME`
  치환으로 안전하다.
  구현: `src/main/pty/shell-hooks/pwsh.ps1`.
- **Terminal 우클릭 UX** — 항상 Copy/Paste 모달이 뜨던 동작을 Windows
  Terminal 스타일로 정리. 선택 영역이 있으면 즉시 복사 + 선택 해제, 없으면
  즉시 붙여넣기, 링크 위에서만 작은 컨텍스트 메뉴(Open Link / Copy Link)가
  뜬다. 모달 인터럽트 제거.
  구현: `src/renderer/hooks/useTerminal.ts`,
  `src/renderer/components/Terminal/ContextMenu.tsx`.
- **타입 부채 정리** — `companySlice`에 `taskHistory` / `waitGraph` /
  `createCompany`의 `workDir` 누락, `IPC.FS_WRITE_FILE` 상수 미정의,
  `OnboardingOverlay`의 옛 필드명 참조 등 27건의 TypeScript 오류를 해결해
  PR CI가 다시 녹색이 된다. 런타임 동작 변화는 없다.

## [2.7.0] — 2026-04-19 — Terminal UX Expansion

Terminal 사용성에 집중한 피처 릴리스다. 데몬/세션 영속성 계층 변경은 없으며,
업그레이드 시 추가 조치는 필요 없다. 키 바인딩 기본값이 추가·변경되었으므로 기존
커스텀 바인딩과 충돌이 없는지 한 번 확인해 두면 좋다.

### Added

- **Floating pane (Quake 스타일 드롭다운 터미널)** — 전역 핫키로 메인 레이아웃과
  독립된 터미널 팬을 띄우거나 숨긴다. 첫 호출 시 전용 PTY를 생성해 세션 유지.
  구현: `src/renderer/components/Terminal/FloatingPane.tsx`, `uiSlice`의
  `floatingPaneVisible`/`floatingPanePtyId`.
- **우클릭 컨텍스트 메뉴** — 복사·붙여넣기·링크 열기·링크 복사 항목. 선택 영역 및
  커서 아래 링크 감지에 따라 메뉴 항목이 동적으로 변경된다. ESC·바깥 클릭으로 닫힘,
  뷰포트 밖으로 넘어가지 않도록 위치 클램핑.
  구현: `src/renderer/components/Terminal/ContextMenu.tsx`.
- **스크롤 북마크** — 현재 스크롤 위치를 북마크로 찍고 이후 해당 라인으로 즉시
  점프한다. 컨테이너 좌측에 북마크 인디케이터가 뜨며, 스크롤에 따라 뷰포트 내에
  들어온 북마크만 렌더링된다.
  구현: `BookmarkIndicator.tsx`, `paneSlice`의 `bookmarks` 필드.
- **tmux 스타일 prefix 모드** — `Ctrl + <prefix key>` 입력 후 다음 단일 키로 동작을
  발동. 분할(가로/세로), 팬 닫기, 워크스페이스 순회, 포커스 이동, 팔레트 호출,
  플로팅 팬 토글 등 13종의 액션을 제공하며 사용자 바인딩 커스터마이즈 및 기본값
  초기화 지원.
  구현: `useKeyboard.ts`, `SettingsPanel` prefix 섹션, `uiSlice` prefix 상태.
- **레이아웃 템플릿** — 현재 분할 레이아웃을 저장해 재사용. 명령 팔레트에서 "레이아웃:"
  항목으로 빠르게 적용하고 "최근" 카테고리에서 직전 사용 항목을 바로 호출.
  구현: `CommandPalette`, `workspaceSlice` / `paneSlice`.
- **정규식 검색 토글** — 터미널 검색 바에서 regex 모드를 on/off 할 수 있다. xterm
  `SearchAddon`의 regex 옵션 전달.
- **xterm Unicode 11 width tables** — `@xterm/addon-unicode11` 추가 후
  `terminal.unicode.activeVersion = '11'` 활성화. CJK/이모지 width 산정을 v11 기준으로
  맞춰 TUI 앱(특히 Claude Code)의 cursor positioning과 한글 glyph 폭이 일치한다.

### Changed

- `useTerminal` hook — scrollback 복원·컨텍스트 메뉴 이벤트·right-click paste
  fallback 경로가 정리되었고, WebGL 컨텍스트 수명관리(가시성 기반 dispose/reload)
  로직이 명확해졌다.
- Preload 계층 — `window.electronAPI.shell.openExternal` / 클립보드 IPC 노출 경로가
  컨텍스트 메뉴와 링크 오픈 플로우에 맞춰 소폭 확장되었다.
- i18n 4개 언어(한국어·영어·일본어·중국어)에 prefix 모드, 컨텍스트 메뉴, 플로팅 팬,
  검색 regex, 레이아웃 저장, 북마크 문자열 40여 키 추가.

### Fixed

- **한글·CJK 프레임 겹침 (Claude Code TUI 렌더링 깨짐)** — xterm 기본 Unicode v6이
  한글의 display width를 잘못 계산해 ANSI CUP(cursor position) 시퀀스를 쓰는 TUI
  애플리케이션의 프레임이 겹쳐 그려지던 문제. Unicode 11 활성화로 해결.
  (재현: Claude Code 실행 중 한글 입력 후 thinking 애니메이션이 돌아갈 때 상태바가
  프롬프트 위에 겹쳐 쓰이는 증상.)

### Migration Notes

스키마 변경은 없다. 기존 데이터·세션·워크스페이스는 그대로 로드된다. 기본 prefix
키는 비활성 상태로 출발하므로 사용자가 활성화하기 전까지는 기존 단축키 동작에 영향이
없다.

## [2.6.0] — 2026-04-17 — Stability & Persistence Hardening

이번 릴리스는 daemon 안정성과 세션 영속성을 강화하는 방어·복원 작업이다.
사용자 데이터 파일 포맷 자체는 동일하되, 저장 경로와 에러 처리에 내부 변화가 있다.
업그레이드 시 추가로 할 일은 없다. 자동 마이그레이션으로 처리된다.

### Added

- `src/daemon/util/atomicWrite/` — 공통 atomic-write 모듈. tmp→bak→rename 순서와
  `__proto__`/`constructor`/`prototype` sanitizer를 한 곳에서 관리한다. SessionManager와
  StateWriter의 중복 구현이 이 모듈로 통합된다.
- `src/daemon/util/AsyncQueue.ts` — 30~50줄 수준의 자체 Promise 큐. `saveDebounced`
  경로에서 concurrent write 경합을 제거한다. `flushSync()` 메서드로 종료 시점의
  synchronous drain을 보장한다.
- `src/main/ipc/wrapHandler.ts` — `ipcMain.handle` 전용 래퍼. 핸들러 예외를
  구조화 JSON 로그(`{ts, level, event, channel, error_code, stack}`)로 메인 프로세스
  stderr에 기록하고, 에러에 `code` 속성을 부여한다.
- `.bak` rotation chain — save 성공 시 `.bak.2→.bak.3`, `.bak.1→.bak.2`, `.bak→.bak.1`
  rename 체인이 실행되어 최근 3개 스냅샷이 유지된다. 읽기 경로는
  primary → .bak → .bak.1 → .bak.2 → .bak.3 순서로 fallback한다.
- Lazy 마이그레이션 프레임워크 — `src/daemon/migrations/`. load 시점에 스키마 버전을
  확인하고 메모리에서만 체이닝 변환한다. 새 포맷 기록은 다음 save에서 이루어진다.
  프로덕션 레지스트리는 `CURRENT_VERSION=1`로 identity 유지 상태다.
- 손상 파일 격리 — validate 실패 시 파일을 `{userData}/corrupted/` 서브디렉토리로
  이동하고 `CORRUPT_FILE` 이벤트를 JSON 로그로 남긴다. 30일 경과 또는 10개 초과 시
  오래된 격리 파일이 자동 정리된다.
- Premigrate 스냅샷 — 스키마 업그레이드가 발생하는 load 경로에서 원본을
  `{basename}.v{N}.premigrate.bak`로 일회성 보존한다. 롤백 자료로 사용된다.

### Changed

- IPC 에러 포맷이 통일된다. 이전에는 핸들러 예외가 renderer로 그대로 promise
  rejection 되어 stack이 불분명했다. 이번 릴리스부터 메인 프로세스 stderr에 JSON
  line으로 기록되고, 에러 객체에 `code` 속성이 붙는다. 사용 가능한 코드는
  `DAEMON_DISCONNECTED`, `VALIDATION_ERROR`, `NOT_FOUND`, `PERMISSION_DENIED`,
  `UNKNOWN`이다. renderer 호출부의 응답 값 자체는 그대로 raw value를 반환한다
  (정규화는 후속 작업인 T4 `useIpc` 훅에서 수용 예정).
- `StateWriter`와 `SessionManager`의 내부 구조 — atomic-write 중복 경로를 공통
  모듈 호출로 치환했다. 외부 API 시그니처는 변경 없다. `saveImmediate`는 기존 동기
  시그니처를 유지한다(shutdown/suspend emergency sync 경로 호환).
- Rotation allowlist regex가 `^sessions\.json\.bak(\.[123])?$` 패턴에 한정된다.
  `corrupted/` 디렉토리와 `*.premigrate.bak` 파일은 rotation 대상에서 제외된다.

### Fixed

- StateWriter/SessionManager의 concurrent save race — AsyncQueue coalescing
  (같은 key 재진입 시 마지막 값만 실행, key 간은 FIFO 보장)로 해결.
- IPC 핸들러에서 던진 예외가 메인 로그에 남지 않는 문제 — `wrapHandler`가 전 핸들러
  공통 try/catch 경로로 흡수하고 stderr JSON 로그로 기록한다.
- validate 실패 시 무음으로 빈 세션이 출발하던 문제 — 손상 파일을 corrupted/로
  격리하고, .bak 체인에서 fallback을 시도한다. 복구에 성공하면 즉시 승격 save.

### Migration Notes

사용자 데이터 손실은 발생하지 않는다. 업그레이드 절차에서 수동 작업은 없다.
다만 `{userData}` 디렉토리 내부에 다음 두 종류의 새 경로가 등장한다.

- `{userData}/corrupted/` — validate 실패로 격리된 파일의 보관소. 30일 경과 또는
  10개 초과 시 자동 정리된다.
- `{basename}.premigrate.bak` — 스키마 업그레이드 load 시점에 생성되는 원본
  스냅샷. 자동 정리 대상이 아니다. 수동 삭제 가능(향후 릴리스에서 자동 정리 검토).

플랫폼별 `{userData}` 경로와 롤백 절차는
[`docs/upgrade-2026-04-17.md`](docs/upgrade-2026-04-17.md)를 참고한다.
