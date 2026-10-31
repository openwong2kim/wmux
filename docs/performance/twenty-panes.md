# 20 terminals for 30 minutes

A soak benchmark for the question "does wmux stay responsive and bounded with
20 terminals open for half an hour?". It drives a packaged wmux in an isolated
instance, keeps 20 panes open (6 streaming, 14 idle shells by default,
optionally some running Claude Code), and samples input latency, lost input,
output stalls and memory every 10 seconds. It can pin the terminal engine
(`--engine node|rust`), so the same scenario serves as a node vs rust A/B.

Script: `scripts/twenty-pane-stability.mjs` (measurement core in
`scripts/lib/twenty-pane-stability.mjs`, unit-tested by
`scripts/__tests__/twentyPaneStability.os.test.mjs`).

## Method

**Instance.** The harness launches the packaged app (`--app`: an `npm run
package` build, an extracted release `wmux.exe`, or a macOS `.app`) with:

- a fresh temporary `HOME`/`USERPROFILE`/`APPDATA`;
- a unique `WMUX_DATA_SUFFIX`, which re-keys every pipe, token, data
  directory and the single-instance lock.

A running wmux on the same machine is not touched. The harness also:

- drives the app over CDP only after the app logs `CDP listening on port N`
  (its own port-ownership check);
- drives only renderer pages served from the launched app's directory;
- before launch, refuses to start if the run's pipes are already in use;
- writes `run.json` (suffix, sandbox paths, pids, pipes) to the output dir at
  the start, so an interrupted run can be cleaned up by hand;
- never uses a `wmux` CLI, global or bundled: it talks to its own pipes.

**Teardown**, in this order:

1. Kill the app and wait for it to exit. While the app runs, its daemon
   respawn controller treats a closed daemon socket as a crash and starts a
   new daemon that restores every session.
2. Send `daemon.shutdown` on the run's own daemon pipe.
3. Wait until that pipe is gone.
4. Wait up to 30 s for the daemon **process** to exit. A daemon can log its
   exit, close its pipe and still live on, holding files. The harness watches
   both the pid the daemon last reported over its pipe and the pid in its pid
   file (read before shutdown), so a daemon respawned after the last ping is
   not missed. With no pid known, the exit cannot be confirmed and the
   teardown is not clean.
   - A daemon still alive (or one whose pipe never closed) is recorded as
     `daemonLingering: { pid, seconds, pipeGone, … }` in `summary.json`, with
     threads, handles and working set on Windows (`Get-Process`), or RSS and
     state on macOS and Linux.
   - Then it is killed only when one process lookup proves it is this run's:
     started after the harness, and its command line runs the launched app.
     On any doubt, no kill. The installed app's daemon can never match.
     Windows often reports no command line for the daemon; such a daemon is
     not killed.
5. One process pass (CIM on Windows, `ps` elsewhere) kills anything started
   after the harness whose command line names the run's sandbox paths.
6. Remove the sandbox, only once the daemon pipe is gone **and** its process
   has exited. Otherwise the sandbox and its token are kept for manual
   cleanup.

`summary.json` gets the teardown report under `teardown`, and
`daemonLingering` at the top level. `teardown.clean` is true only when the
sandbox was removed and no daemon lingered; anything else is flagged. A
second Ctrl+C during a slow teardown exits at once and leaves the cleanup to
[Manual cleanup](#manual-cleanup).

On macOS it passes `--use-mock-keychain`. Without a login keychain under the
sandbox `HOME`, Chromium's Safe Storage request blocks startup behind a
keychain dialog.

The run's `WMUX_DATA_SUFFIX` is `-s<harness pid in base 36>`; it is in
`run.json`.

**Terminal engine.** `--engine node|rust` writes `terminal-core.json` in the
instance's data directory before launch: `{"engine": "rust"}`. That is the
file **Settings › Terminal › Performance › Terminal engine** writes
(`src/shared/terminalCoreSettings.ts`). The daemon reads it once at start; a
changed setting needs a daemon restart. The sandbox's daemon has not started
yet, so no restart is needed.

After launch the harness asks the daemon what it actually runs:
`daemon.ping {includeTerminalCore}` returns `terminalCore.requested` and
`terminalCore.effective`. The run aborts before setup when any of these hold:

- the daemon does not report an engine (an older build);
- `--engine rust` on a build without the Rust module (`rustAvailable` is
  false). A node run works on such a build;
- `WMUX_TERMINAL_CORE` overrides the setting;
- the requested engine differs from what the daemon started with;
- the requested engine differs from what is effective, for example Rust when
  the native module is missing.

The harness asks again at the end, recording without aborting. Both answers,
and the daemon pid at start and end, go into `summary.json` under `engine`.
The summary is flagged if the engine changed, the daemon was replaced, or the
end check could not read the engine.

**Layout.** 20 panes in 4 workspaces of 5. The first workspace is the boot
workspace; the others come from `mcp.claimWorkspace`. Each workspace is filled
with `pane.split`, always splitting its largest pane, so panes form a grid
rather than a spiral of slivers. Every workspace is shown once with the real
`Alt+ArrowDown` shortcut before the run, and the run starts only when every
pane reports a started terminal. Most panes therefore sit in hidden
workspaces, which matches real use and exercises hidden-pane retention and
reveal catch-up.

**Workload.** Every shell gets a two-character prompt (`> `) so markers never
wrap, and PowerShell 7 inline prediction is turned off. Panes get one of three
classes, spread across the workspaces:

- **Streaming** (`--streaming`, default 6) runs a synthetic Node producer,
  started by typing its command into the shell:
  - every 100 ms it repaints a status row (cursor save, row 1, reverse video,
    restore), like a TUI;
  - it appends colored log lines with Korean text and a symbol, up to
    `--rate-kib` (default 16) thousand characters per second, about 16 KiB/s;
  - it honors stdout backpressure: when a write reports a full buffer it
    skips ticks until `drain`. On Windows, console writes are synchronous, so
    the "skipped" count it prints at the end is always 0 there;
  - stdin is raw and edits a one-line input box on row 2, repainted whole on
    every key, as agent TUIs do.
- **Claude** (`--claude`, default 0) runs Claude Code on a light prompt loop.
  These panes are their own class: no keystroke or probe marker is ever
  written into them, so they never count as dropped input. See
  [Claude Code panes](#claude-code-panes).
- **Idle**: all other panes are idle shells.

Writes stay small: markers are about 7 bytes and are paced 20 ms apart. A
single multi-MiB write has stalled ConPTY before.

**Each sample** (every `--sample-sec`, default 10 s):

1. **Focus moves.**
   - Every third sample switches workspace with `Alt+ArrowDown`. The harness
     reads `workspace.current` before and after; a switch that leaves the same
     workspace active counts as a switch miss.
   - Every sample then focuses the next non-Claude pane of the current
     workspace with `pane.focus`. Typing starts only when `pane.list` names
     that pane as active and a terminal holds DOM focus; otherwise the harness
     tries `pane.focus` once more.
   - If focus still did not land, the sample records a focus miss and types
     nothing. There is no clicking, which could land in a Claude pane.
2. **Focused keystrokes** (`--keys`, default 4). The harness types a unique
   marker such as `qz7k2aj` with CDP keyboard events, then erases it with
   Backspace. Latency is measured inside the renderer, from the keydown of the
   marker's last key to the first `pty.onData` chunk that completes the
   marker, with control sequences stripped. It also records the next
   animation frame. The first marker after the focus move is reported
   separately as "afterSwitch".
   - A marker that is lost or echoes from another pane ends that sample's
     typing, since focus may sit in another pane. Dropped keystrokes
     therefore count at most one per sample.
3. **Pane probes.** A marker is written to every non-Claude pane with
   `electronAPI.pty.write`, matched in `pty.onData`, then erased. This covers
   hidden and idle panes, which a keyboard test cannot reach.
4. **Stalls.** One `pty.onData` subscriber records, per pane, the time of the
   last output. A pane that should be producing output and stops for
   `--stall-ms` (default 5000) is a stall episode, recorded with its length
   when output resumes. A pane still silent at sample time is listed as
   silent.
   - Streaming panes should always be producing output.
   - Claude panes should only while one of their turns runs.
5. **Window cadence.** 20 rAF intervals; a median above 50 ms marks the
   sample throttled (occluded window or locked screen).
6. **Memory.**
   - `daemon.ping {includeMemory}`: daemon RSS, JS heap, ring bytes,
     socket/resync queue bytes, session states, event-loop lag.
   - `perf.status {includeMemory}`: Electron working sets per process type.
   - Every `--tree-every` samples (default 3), an OS process-tree sample of
     the app and daemon, including shells, producers and Claude Code.
     - Windows uses CIM and the pid-reuse-guarded tree walk from
       `perf-process-tree.mjs` and `perf-process-classify.mjs`
       (`OpenConsole.exe`, the bundled ConPTY host, counts as conhost). It
       records working set and commit (`PageFileUsage`) for the tree and the
       daemon. Windows trims working sets; commit shows growth that trimming
       hides.
     - macOS and Linux use `ps` RSS.
     - A daemon pid read from the pid file is used only if the process looks
       like this app's daemon.
7. **Claude loop step.** This runs after the probes, so no marker sits in an
   input box when a prompt is submitted.

Each sample is appended to `samples.ndjson` as soon as it is taken, so a run
that dies early keeps its data. The summary is written at the end, on Ctrl+C,
and on a fatal error.

### Claude Code panes

`--claude <n>` starts Claude Code in n panes, inside a tiny fixture repo in
the sandbox (`README.md` and a project `.claude/settings.json`).

**Profile.** Claude Code runs with your real profile, for the `claude`
process only, so its own login works.

- The pane's launch line sets `USERPROFILE` and `HOME` back to their real
  values on Windows, or `HOME` on macOS.
- Every wmux path stays suffixed and sandboxed. Claude Code's own hooks in
  your profile (for example wmux's) run with the real home and this run's
  suffix, so they may create `~/.wmux<suffix>` paths. The suffix is unique
  to the run, so the harness removes exactly those names afterwards and
  lists them in `claude-profile-diff.json`.
- No credentials are copied or passed through the environment.
- The harness strips `CLAUDE*` variables (except `CLAUDE_CODE_GIT_BASH_PATH`)
  from the instance's environment, so the panes do not inherit the identity
  of a Claude session the harness may itself run in.
- `--claude-config-dir <dir>` (optional) points Claude Code at another config
  directory you chose instead of the default one.
- With `--claude 0`, nothing touches the real profile.

The real profile also brings your global `CLAUDE.md`, MCP servers and hooks,
and your default model. That is fine for the engine A/B, where both runs see
the same profile. For any other run, use a separate logged-in config and a
small model:

```sh
--claude-config-dir <separate logged-in config> --claude-cmd "claude --model haiku"
```

The harness prints a warning at start when `--claude` is used without
`--claude-config-dir`.

Claude panes add realistic terminal load but do not exercise wmux's own
Claude Code hook and status path. Your wmux hook bridge looks for the run's
suffix under your real home, finds no auth token and exits; any
`~/.wmux<suffix>` path it leaves on the way is removed afterwards (see above).

Claude Code records the sandbox repo in that profile. Before the Claude
panes start and after teardown, the harness snapshots the names, never the
contents, of:

- `~/.claude/projects` entries;
- `~/.claude.json` keys and project keys.

The changes go to `claude-profile-diff.json` in the output dir:

- New project entries that are exactly the fixture repo's path or slug. You
  can remove these afterwards. Entries your other sessions add during the run
  are left out.
- Top-level `~/.claude.json` keys added or removed, listed by name and
  unfiltered, because they cannot be tied to one session.

The first start in the fixture folder shows Claude Code's folder-trust
prompt. The harness answers "Yes" only when that prompt is on the pane's
screen. It types the keys through the renderer's `pty.write`, as the probes
do, because `input.sendKey` is refused while an approval-like prompt is on
screen.

`pty.write` does not report dropped bytes, so the answer is confirmed from
the screen. If the prompt is still there, or nothing new appears, the harness
sends Escape so no half-answered prompt is left. That pane's loop then stops
(`trust-refused`, flagged in the summary), and the run goes on.

**Turn tracking.** The project settings add two hooks, `UserPromptSubmit` and
`Stop`, that append the turn start and end to a per-pane status file. That
file is how the harness knows when a turn runs.

**The loop.** One prompt, *"Read README.md and reply with its first line
only."*, at most every `--claude-interval-sec` (default 60) seconds. The loop
always waits for the previous turn to end.

**Hard caps.**

| Cap | Default | What happens |
| --- | --- | --- |
| `--claude-max-turns` | 20 per pane | No more prompts after that |
| `--claude-turn-timeout-sec` | 120 | A turn running longer is interrupted with Escape, and that pane's loop stops for good |
| Unstarted prompt | `--claude-turn-timeout-sec` | A submitted prompt whose turn never starts within that time also stops the loop |
| End of the run | | No new prompts are sent |

For stall detection, a Claude pane counts only while one of its turns runs.
Only the part of an output gap inside the turn counts, so a reply followed by
the idle wait for the next prompt is not a stall. An interrupted turn ends
when the harness interrupts it, since Escape fires no `Stop` hook.
The summary's `claude` section reports turns submitted and completed, turn
durations, and why each loop stopped.

**`--claude-cmd <cmd>`** is the command typed after the environment is set.
The default is `claude`.

- Add flags here, for example `claude --model haiku`.
- On macOS or Linux, environment assignments in front point Claude Code at a
  fake model, so the run needs no account:

  ```sh
  --claude-cmd "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ANTHROPIC_BASE_URL=http://127.0.0.1:8791 ANTHROPIC_API_KEY=<fake key> claude --model haiku"
  ```

  The server at that URL must answer `POST /v1/messages` in the Messages API
  streaming format. Pair it with `--claude-config-dir` pointing at a config
  dir whose `.claude.json` has finished onboarding and approved that key, so
  the real profile is not touched at all.
- PowerShell has no `VAR=value cmd` form; on Windows set such variables
  before starting the harness.
- `config.json` records only whether `--claude-cmd` and `--claude-config-dir`
  were set, not their values.

## Metrics

| Metric | Source | Meaning |
| --- | --- | --- |
| Keyboard echo p50/p95/max | renderer keydown → `pty.onData` | Full keyboard → main → daemon → PTY → shell or TUI → renderer round trip for the focused pane |
| First key after a switch | same, first marker per sample | Echo right after a pane or workspace focus change |
| Next frame p50/p95 | rAF after the echo | Approximates the frame that draws the glyph. It is not a GPU present timestamp |
| Probe echo, streaming / idle | `pty.write` → `pty.onData` | Round trip for every non-Claude pane, hidden ones included |
| Dropped | marker not echoed within 3 s | Lost or badly delayed input. Echoes arriving after the timeout are counted as late |
| Wrong pane | keyboard marker echoed by another pane | Focus went somewhere other than the pane `pane.focus` selected |
| Stall episodes | output gap ≥ 5 s on a streaming pane, or a Claude pane during a turn | The pane stopped updating, at the renderer's IPC input. Counted only up to a daemon respawn, see below |
| Daemon respawned | `daemon.ping` pid differs from the previous sample | The daemon died and another took its place mid-run; `daemonRespawned` lists the time and pids |
| Claude turns | hook start/end | Turns completed and their duration, with each loop's stop reason |
| Terminal engine | `daemon.ping` `terminalCore` | Requested and effective engine at start and end, and the daemon pid |
| Daemon RSS, Electron working sets, process tree | RPC and OS samples | First, last, max and growth per hour, from a least-squares fit. Growth is reported only for runs of 10 minutes or more |
| Commit, process tree and daemon (Windows) | CIM `PageFileUsage` | Same trend. Unlike the working set, the OS does not trim it |
| Workspace switch misses | `workspace.current` before and after | `Alt+ArrowDown` left the same workspace active |
| Throttled samples | rAF median > 50 ms | Frame numbers in those samples are not trustworthy |

Caveats:

- **A daemon respawn invalidates stall metrics after it.** The streaming
  producers die with the old daemon's sessions, so from then on the
  "streaming" panes are plain shells and their silence is not a stall. The
  harness does not restart the producers: a respawn is itself the finding,
  and a restarted workload would make the rest of the run a different
  experiment. Stall episodes count up to the old daemon's last answered
  `daemon.ping` (`stalls.validUntilSec`). Stalls that ended between that
  ping and the first ping of the new daemon cannot be attributed; they are
  listed in `stalls.aroundRespawn` but not counted, since the one leading
  into a crash may be the most telling. Later ones only count in
  `stalls.ignoredAfterRespawn`. The summary is flagged. Latency, probe and
  memory samples are kept; after a respawn the streaming-class probes measure
  shells.

- RSS, working sets, heap, ring and queue counters overlap. Do not add them
  up. See [Memory diagnostics](../performance.md#memory-diagnostics).
- Probe latency includes the shell or TUI handling a 7-byte write in one
  piece. That costs zsh about 10 ms on macOS and differs from per-key typing.
  Compare probes across time, engines and pane classes, not against keyboard
  echo.
- A stall is measured where output reaches the renderer over IPC. Painting
  of hidden panes is deferred by design and is not measured. A stall in the
  producer, the PTY, the daemon or main all show up the same way.
- Claude turn durations depend on the model service as much as on wmux. Use
  them to confirm the load was there, not as a wmux metric.
- This is a soak with a fixed synthetic workload, not a p99 latency study and
  not a model of any particular agent.

## Engine A/B (node vs rust)

To compare engines, run the same scenario once per engine on the same
machine, with the same app build and the same flags. Only `--engine` and
`--out` change.

1. Run `--engine node` first, then `--engine rust`.
2. Wait about a minute between runs, so the first instance's daemon and
   shells are gone.
3. If time allows, run a second pair in the opposite order (rust, then node).
   A difference that holds in both orders is not warm-up or machine drift.

Each run verifies its own engine at start and end; a run that could not
verify it aborts instead of producing numbers. Before comparing, check that
`summary.json` shows `engine.start.effective` and `engine.end.effective`
equal to the requested engine, and that it has no flags about the daemon or
engine changing.

Windows (PowerShell; the extracted release build; Claude Code uses your own
login):

```powershell
node scripts/twenty-pane-stability.mjs --app D:\test\wmux-4.11.0\wmux.exe --engine node --claude 4 --streaming 8 --panes 20 --out out\twenty-pane-stability\ab-node
node scripts/twenty-pane-stability.mjs --app D:\test\wmux-4.11.0\wmux.exe --engine rust --claude 4 --streaming 8 --panes 20 --out out\twenty-pane-stability\ab-rust
```

macOS (the unzipped release `.app`; a fake model on port 8791 with its own
config dir). Clear the download quarantine first with
`xattr -dr com.apple.quarantine <app>`.

```sh
node scripts/twenty-pane-stability.mjs --app ~/test/wmux.app --engine node --claude 4 --claude-config-dir ~/test/claude-fake-config --claude-cmd "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ANTHROPIC_BASE_URL=http://127.0.0.1:8791 ANTHROPIC_API_KEY=<fake key> claude --model haiku" --streaming 8 --panes 20 --out out/twenty-pane-stability/ab-node
```

Then run the same command with `--engine rust --out out/twenty-pane-stability/ab-rust`.

Linux runs on CI: **Actions › Twenty-pane engine A/B (Linux) › Run workflow**
(`.github/workflows/twenty-pane-ab-linux.yml`). One ubuntu-22.04 runner
packages the app with the Rust module, then runs the default scenario with
`--claude 0` under Xvfb, node first and then rust, for the minutes you enter
(1 to 140; 120 by default, about 4.5 hours in all). Each run must have
completed on its engine, at start and at end, with one daemon throughout,
recorded daemon and process-tree memory, and be torn down cleanly before the
next starts (`scripts/twenty-pane-ab-check.mjs`),
or the job fails. The job summary has a table of both runs' headline numbers,
and the `twenty-pane-ab-linux` artifact has both output directories.

## How to run

Prerequisites:

- a packaged build or an extracted release;
- Node;
- an unattended desktop session that stays unlocked, with the wmux window
  not minimized. A locked screen or a minimized window throttles rAF; the run
  still completes, but frame numbers are flagged.

Windows (PowerShell, from the repo root):

```powershell
npm run package
node scripts/twenty-pane-stability.mjs
```

The defaults are `--minutes 30 --panes 20 --streaming 6 --claude 0
--per-workspace 5 --sample-sec 10`. Setup takes about a minute before the 30
minutes start, plus up to a minute for Claude panes.

A smaller check:

```sh
node scripts/twenty-pane-stability.mjs --panes 4 --streaming 1 --per-workspace 2 --minutes 1 --sample-sec 5
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--app <exe or .app>` | `out/wmux-win32-x64/wmux.exe`; on macOS a packaged `out/` build, else `/Applications/wmux.app` | The app to run |
| `--engine node\|rust` | the app's default, recorded but not enforced | The terminal engine, verified after launch |
| `--minutes`, `--panes`, `--streaming`, `--per-workspace`, `--sample-sec` | 30, 20, 6, 5, 10 | Scenario size and sampling |
| `--claude <n>` | 0 | Claude Code panes |
| `--claude-config-dir <dir>` | none (your default Claude Code profile) | Another Claude Code config dir |
| `--claude-cmd <cmd>` | `claude` | The command typed to start Claude Code |
| `--claude-max-turns` | 20 | Prompts per Claude pane |
| `--claude-interval-sec` | 60 | Seconds between prompts |
| `--claude-turn-timeout-sec` | 120 | A longer turn stops that pane's loop |
| `--keys` | 4 | Keystroke markers per sample |
| `--workspace-switch-every` | 3 | Samples between workspace switches; 0 never switches |
| `--tree-every` | 3 | Samples between process-tree samples |
| `--stall-ms` | 5000 | Output gap that counts as a stall |
| `--rate-kib` | 16 | Producer output per streaming pane |
| `--probe-timeout-ms`, `--key-timeout-ms` | 3000 | Echo wait |
| `--out <dir>` | `out/twenty-pane-stability/<timestamp>/` | Must not exist |
| `--keep-app` | off | Leave the instance running at the end |

Output goes to `out/twenty-pane-stability/<timestamp>/` (gitignored). An
existing directory is never overwritten.

- `config.json`: platform, CPU count, memory, flags, pane layout and classes;
- `samples.ndjson`: one JSON object per sample;
- `summary.json` and `summary.txt`;
- `run.json`: suffix, sandbox paths, pids and pipes, plus the teardown report;
- `claude-profile-diff.json` (with `--claude`): profile entries Claude Code
  added.

`config.json`, `samples.ndjson` and the summaries hold counters, pty ids,
synthetic markers and the engine report only: no terminal contents, command
lines or paths. `run.json` and `claude-profile-diff.json` hold local paths;
keep them out of anything you publish.

### Manual cleanup

Use this when a run was killed before its teardown, or when the teardown
kept the sandbox because the daemon survived. `run.json` names everything.
Stop that instance's daemon with the CLI bundled in the same app, run
against the run's sandbox profile and suffix.

On Windows, use PowerShell. Never use the global `wmux.cmd`, which targets
your real instance:

```powershell
$run = Get-Content out\twenty-pane-stability\<stamp>\run.json | ConvertFrom-Json
$env:USERPROFILE = $run.home; $env:HOME = $run.home; $env:WMUX_DATA_SUFFIX = $run.suffix
$env:ELECTRON_RUN_AS_NODE = '1'
& D:\test\wmux-4.11.0\wmux.exe D:\test\wmux-4.11.0\resources\cli-bundle\index.js daemon stop
```

Do this in a separate PowerShell window, since it changes that session's
profile variables. Then delete `$run.home` and the `userDataDirs` it lists.

On macOS the same applies with `HOME`, `WMUX_DATA_SUFFIX`, and
`<app>/Contents/MacOS/wmux <app>/Contents/Resources/cli-bundle/index.js`.

## Results

Pending Windows run.

| Date | Platform | Build | Engine | Keyboard echo p50 / p95 / max (ms) | First key after switch p95 (ms) | Probe p95 streaming / idle / Claude (ms) | Dropped (key / probe) | Stalls | Daemon RSS first → last (MiB/h) | Electron first → last (MiB/h) | Throttled samples |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pending Windows run | | | node | | | | | | | | |
| pending Windows run | | | rust | | | | | | | | |

The 5-minute windows in `summary.json` (`windows[]`) show whether latency or
memory drifts over the run. Quote them when a single row hides a trend.
