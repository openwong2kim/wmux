# Measured terminal-prompt keys

Captured 2026-09-27 by driving each TUI in a PTY with a headless xterm, in an
isolated HOME, and reading the grid after every key. Each fixture records the
TUI version, the grid size, the terminal modes the TUI had enabled, the key
bytes sent to reach that screen (`keysSent`) and the screen text. Paths are
rewritten to `/private/tmp/demo/proj` (same length, so wraps are unchanged) and
the banner's model and plan names are replaced.

Versions: Claude Code 2.1.283, codex-cli 0.157.1, opencode 1.18.30.
openclaude was not installed on the capture machine; it is a Claude Code fork
and is assumed to share Claude's keys.

All three TUIs enable bracketed paste (`?2004h`) and run in the alternate
screen (`?1049h`) with mouse reporting on. Claude Code 2.1.283 draws its
dialogs unboxed: a `────` rule, then the dialog, no `│` frame.

## Claude Code — AskUserQuestion

| Screen | Key | Effect |
| --- | --- | --- |
| One single-select question | digit `N` | Selects option N **and submits**. No Enter |
| | `↑`/`↓` | Moves the `❯` cursor only |
| | `Enter` | Selects the row under the cursor |
| | `Esc` | Cancels the tool (no PostToolUse, no Stop hook) |
| "Type something." row (single-select) | its digit | Moves the cursor into the row's inline text field; nothing submitted |
| | typed text or a bracketed paste | Echoed into the row (paste markers not shown) |
| | `Enter` | Submits the typed text as the answer |
| Several questions (tab bar `← ☐ A ☐ B ✔ Submit →`) | digit on a single-select question | Selects and **advances to the next tab** |
| | `Tab` / `→` | Next tab; `←` previous tab |
| Multi-select question (`[ ]` rows) | digit `N` | **Toggles** row N; the cursor does not move |
| | `Space` / `Enter` on an option row | Toggles the row under the cursor |
| | "Type something" digit | Only toggles its checkbox; the field gets focus only with the cursor on it (`↓`) |
| | `↓` past the last option | Lands on an in-question `Submit` row (no digit); `Enter` there advances |
| Review screen ("Ready to submit your answers?") | `1` | Submit answers |
| | `2` | Cancel |

Measured live on Claude Code 2.1.288 (#1658), answering through the phone
routes: one multi-select question also draws the tab bar with a `✔ Submit`
tab (`←  ☐ Fruit  ✔ Submit  →`), and `Enter` on its Submit row draws the
review screen. A multi-select question that is not the last one labels the
in-question row `Next` instead of `Submit`; `Enter` there moves to the next
tab. One single-select question still draws ` ☐ Color` with no Submit tab.
A long option label wraps onto the description's indent (` ` × 5), and under
the bottom rule the picker draws only `N. Chat about this` and its key hint.
The screens are in `claude-2.1.288/` (an 80×24 pane in the main buffer, not
the alternate screen, so they sit apart from the fixtures above).

Measured on Claude Code 2.1.292 (captured 2026-10-07 in an 80- and a 60-column
pane): a question whose text wraps draws a `│ ` gutter on each of its rows; a
one-row question draws none, and option rows and their (wrapped) descriptions
draw none either. The review screen draws ` │ ` before each row of a wrapped
`● question` entry; the answered block draws no gutter. Keys are unchanged.
The screens are in `claude-2.1.292/` (main buffer).

## Claude Code — ExitPlanMode ("Would you like to proceed?")

Options measured (default start): `1. Yes, and use auto mode`,
`2. Yes, manually approve edits`, `3. Tell Claude what to change`. Started with
`--allow-dangerously-skip-permissions`, option 1 reads
`Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session`.
There is no "No, keep planning" row in this build.

| Key | Effect |
| --- | --- |
| `1` / `2` | Approve immediately (no Enter) |
| `3` | Moves the cursor into the feedback text row; nothing submitted |
| text / bracketed paste, then `Enter` | Rejects the plan with that feedback; Claude re-plans and asks again |
| `3`, `Enter` with no text | Rejects the plan, ends the turn, stays in plan mode (text is optional) |
| `shift+tab` on row 3 | Approves with the typed feedback (hint shown, not exercised) |
| `Esc` | Rejects the plan ("User rejected Claude's plan"), ends the turn, stays in plan mode (measured through the phone `/decline`, 2026-09-28) |

## Claude Code — permission dialogs (Bash, Edit, Write)

| Dialog | Options | Keys |
| --- | --- | --- |
| Write (create) / Edit | `1. Yes`, `2. Yes, and switch to accept edits … for this session (shift+tab)` (wraps to two rows), `3. No` | `1`, `3` act immediately. `3` (No) rejects with no text prompt. `Tab` turns the focused row into an amend field (`1. Yes, and tell Claude what to do next`); `Tab` again restores it |
| Bash | `1. Yes`, `2. Yes, and always allow access to <dir> from this project`, `3. Yes, and switch to auto mode …`, `4. No` | Digits act immediately. `4` (No) interrupts the turn ("What should Claude do instead?") |
| Bash, grid too short | Command top scrolled off; option list windowed with a `↓` marker (`4. No` not drawn at 80x11) | A digit still works for an option that is not drawn |
| Fetch (WebFetch, 2.1.292) | `1. Yes`, `2. Yes, and don't ask again for <host>`, `3. No, and tell Claude what to do differently (esc)` | `1` fetches at once. `3` and `Esc` both reject and interrupt the turn ("What should Claude do instead?"). No footer is drawn |
| Read file (Read outside the project, 2.1.292) | `1. Yes`, `2. Yes, allow reading from <dir> during this session`, `3. No` | Footer `Esc to cancel · Tab to amend`, as Bash |

The Fetch and Read screens were captured on Claude Code 2.1.292 in manual mode
(`--permission-mode default`), in a pane of an isolated wmux daemon
(`WMUX_DATA_SUFFIX`), read with `daemon.readSessionText` and padded to the
grid height; the narrow variants are the same dialog after a pane resize. They
are in `claude-2.1.292/` (alternate screen).

## Claude Code — other menus

The startup Bypass Permissions warning (`❯ No, exit` / `Yes, I accept`) has no
digits: `↓`/`↑` then `Enter`. Text typed at it is swallowed. Its fixture's
mode set is not reliable (the first launch had typed text land on it).

## Codex CLI

The isolated HOME has no Codex login, so the first capture reached only the
first-run sign-in menu (`codex-login-menu.json`): a `>` cursor on numbered rows,
`↓` moves it.

The approval overlays were captured on 2026-09-28 (phone-decision PR0) without
any login: `codex app-server --listen unix://…` in a scratch `CODEX_HOME` with a
loopback fixture model provider, the TUI attached with `--remote` through
`createCodexTuiRelay`, `approval_policy = "on-request"`, `sandbox_mode =
"read-only"` (0.157.1 rejects `"untrusted"`). The project was pre-trusted in
config, so the trust prompt was not shown.

| Overlay | Options drawn | Key | What the TUI sends |
| --- | --- | --- | --- |
| Command (`codex-approval-exec-01.json`) | `› 1. Yes, proceed (y)`, `2. Yes, and don't ask again for commands that start with …` (p), `3. No, and tell Codex what to do differently (esc)` | `Enter` on row 1 | `{"decision":"accept"}` |
| | | `Esc` | `{"decision":"cancel"}`; the turn is interrupted |
| File change (`codex-approval-patch-01.json`) | `› 1. Yes, proceed (y)`, `2. Yes, and don't ask again for these files (a)`, `3. No, and tell Codex what to do differently (esc)` | `Esc` | `{"decision":"cancel"}`; the turn is interrupted |

The `y`/`p`/`a` letters are drawn but were not exercised. Codex approvals are
answered over the app-server protocol, never by keys: once the request is
answered, the server sends `serverRequest/resolved` and the TUI closes the
overlay by itself (measured with an answer injected on the TUI's own upstream
connection). Both fixtures are reference only and must stay unparsed. Request
and response shapes: `src/daemon/web/__tests__/fixtures/codex-server-requests.json`.

## OpenCode

Reached with the free default model and `"permission": {"bash": "ask"}` in the
project `opencode.json`.

| Key | Effect |
| --- | --- |
| `←` / `→` | Move the selection across `Allow once` · `Allow always` · `Reject` |
| `Enter` | Confirm the selected button |
| digits | Ignored |

The selected button is shown only by colour (background 215 vs 234), so the
text fixtures cannot show which one is selected. `Reject` closes the dialog
immediately with no text prompt.
