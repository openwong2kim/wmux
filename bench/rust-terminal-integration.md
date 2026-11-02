# Opt-in Rust PTY and ring integration

The C path runs inside the existing Node daemon and local Electron PTY manager.
There is no additional service or terminal RPC, WebSocket or dump-format change. Ordinary
sessions and team panes use the same backend selection. AI CLI/MCP worker memory
is outside this change. This is experimental, not an all-platform release gate pass.

## Repeated validation — 2026-10-14

### Follow-up: newline diagnosis and cross-platform failures

The one-code-unit mismatch described below has now been reproduced as an extra
CR in the **raw PTY stream before decoding**. A throttled native read saw
530,015 bytes instead of 530,014; the native decoder and Node StringDecoder
agreed. A control using Python `os.openpty` and `subprocess`, with neither Rust
nor node-pty, reproduced CR duplication on its first cycle (530,034 bytes).
With output postprocessing disabled in the synthetic child, the Python control
passed 13 cycles / ten seconds. A separate node-pty cooked-output control passed
30 cycles without reproducing it; reproduction depends on queue pressure.

This matches Darwin's non-atomic ONLCR expansion: `ttyoutput` enqueues CR before
LF and can ask the caller to retry LF when the queue fills between those writes.
See [Apple's ttyoutput implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/tty.c)
and the [retained diagnostic summary](results/pty-newline-diagnosis-20261014.json).
The original failed soak did not preserve its location; this identifies the
subsequently reproduced mismatch class, not the exact lost historical sample.

The verifier now uses `output-raw` (`stty -opost`, explicit CRLF) for byte-exact
bulk/soak assertions and retains a cooked-output smoke. Production PTY defaults,
bytes and decoder behavior are unchanged: legitimate CRs are never stripped.
Reproduce the independent control with:

```sh
python3 bench/fixtures/pty-newline-probe.py --mode cooked --report out/pty-cooked.json
python3 bench/fixtures/pty-newline-probe.py --mode raw --report out/pty-raw.json
```

The first hosted run passed macOS. Windows stopped at the generated Unicode
table check because of checkout line endings; the generator now normalizes
CRLF for comparison and source hashing, with tests that still reject changed
width data. Linux passed the native verifier but failed Electron spawning:
portable-pty closed Chromium-owned descriptors in `pre_exec`. Unix cleanup now
marks descriptors close-on-exec, preserving both Chromium ownership until exec
and Rust Command's exec-error pipe. Linux uses `close_range(CLOEXEC)` where
available. A broken-interpreter regression checks that an actual exec failure
reaches the caller without replaying the command. Hosted reruns are required
before treating Windows/Linux as qualified.

The Windows resize fixture now starts raw console input before announcing READY,
as required for Node's resize notifications, and exercises bundled and inbox
ConPTY. Input integrity still checks the full 4 MiB payload; Windows records
received-byte progress and permits five minutes for console key-event processing.
The independent node-pty control on Windows Server 2022 / Node 24.21.0 reached
3,933,184 of 4,194,304 bytes after about 117 seconds, then exceeded the former
120-second deadline. This demonstrates ongoing slow consumption in that control,
not a Rust-only loss. Both backends still need the final full-payload hash; the
native report records input elapsed time separately from lifecycle checks.
A longer node-pty control completed all 4 MiB with the expected hash and exit 0
in 129,437 ms; see [the complete control report](results/windows-input-complete-control-20261014.json).

Disposal must also keep draining discarded Windows output until EOF. Stopping
the reader before `ClosePseudoConsole` returns can deadlock older ConPTY versions;
see [Microsoft's close contract](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole).
The native verifier fills the output queue while paused, disposes without
resuming, and requires every worker to exit, including both Windows backends.

On macOS arm64 / Node 24.15.0, the combined Rust PTY/ring/text backend reduced
peak daemon RSS and text-read latency in this synthetic snapshot workload.
Each cell below is a median across three fresh daemons; backend order alternated.
Read time is the median batch time per run, then the median across runs. A batch
reads all sessions, including RPC transport and response validation.

| Sessions × output each | Peak RSS MiB, Node → Rust | Settled RSS MiB, Node → Rust | Read batch ms, Node → Rust |
| --- | ---: | ---: | ---: |
| 1 × 1 MiB | 241.8 → 163.0 | 235.5 → 158.2 | 31.9 → 19.6 |
| 6 × 1 MiB | 361.7 → 200.5 | 354.5 → 200.2 | 119.5 → 84.4 |
| 6 × 8 MiB | 395.5 → 296.7 | 373.3 → 275.8 | 694.8 → 293.5 |

This is a snapshot-heavy advantage, not a general idle-memory reduction. Before
text reads, buffered-idle RSS was 143.0 → 146.8, 155.5 → 157.8 and 218.8 →
231.2 MiB respectively. Empty daemons were about 121 MiB with either backend.
Settled means two seconds after reads, without forced GC. These are daemon-only
figures for detached synthetic sessions; they exclude Electron and AI CLI/MCP
workers and do not establish whole-team savings or interactive latency.

A separate 18-daemon comparison kept Rust PTY/ring/text enabled and changed only
legacy JS output versus native output chunks. Peak RSS medians were 162.9 →
162.9, 202.0 → 202.0 and 285.0 → 292.0 MiB; read batch medians were 20.1 →
19.9, 85.8 → 85.9 and 298.8 → 302.0 ms. Thus the latest output-path change
does **not** establish an additional RSS or snapshot-speed improvement. Its
verified benefit is eliminating JS retention copies: 6,359,172 bytes at six
1 MiB sessions and 51,148,932 bytes at six 8 MiB sessions move directly into
native rings. No output-byte delivery buffers were created in these detached
sessions. This does not measure streaming throughput or attached renderers.

Both comparisons passed: **36 isolated daemons / 1,560 text RPCs**, matching
response hashes, no surviving fixture process trees, all daemon exit codes zero.
Reports, raw samples, ranges and per-run values:

The [committed measurement summary](results/rust-terminal-macos-20261014.json)
contains medians, ranges and per-run values. These measurements were collected
on the prototype before transplanting it onto this PR's newer main base; they
are not performance qualification of the rebased PR head. Full raw reports remain
local at the paths below.

- `out/rust-validation-combined-20261014.json`
- `out/rust-validation-output-ab-20261014.json`
- `out/rust-validation-summary-20261014.json`

The first strengthened soak failed an
exact-output assertion: observed output was one UTF-16 code unit longer than
expected. That run did not preserve a useful mismatch location, so the cause
cannot be assigned to decoding, PTY behavior or the fixture. The verifier now
persists the complete actual/expected output and first mismatch location before
failing. Subsequent two-minute / 3,593-cycle and five-minute / 9,498-cycle runs
passed with native bridge/ring retention checked on every cycle, threads 7 → 7,
and zero native workers remaining. Those passes alone did not resolve the
failure; the later raw-byte/control diagnosis above explains the reproduced
failure class and corrects the exact-byte fixture. Full release qualification
still requires the remaining OS, package, real-team and long-soak gates.

The soak also records RSS/heap/external samples every two seconds. RSS fell from
757.6 to 272.0 MiB and from 743.6 to 258.1 MiB in the successful runs, after
allocation-heavy ring fuzzing in the same process. Peaks were 885.1 and 765.2
MiB respectively. These samples show allocator/GC effects and are not proof of
leak freedom. A separate Node PTY output control aborted on `posix_spawnp failed`
(437 completed cycles in its recorded retry), so no completed long-run Node
control comparison is claimed. Part of the extended soak overlapped that control
and the small ANSI/Electron checks; it is correctness evidence, not a controlled
memory-performance measurement.

Successful soak reports are `out/rust-validation-native-soak-20261014.json` and
`out/rust-validation-native-soak-extended-20261014.json`. ANSI conformance passed
60/60 (59 supported restores plus one deliberate refusal), and the staged native
module passed the Electron 41.10.6 transport check. These are macOS runtime checks;
no new Windows/Linux runtime evidence, eight-hour soak, packaged-app switch or
real AI-team trial is claimed. Installed preferences and user sessions were left
intact.

```sh
node scripts/rust-daemon-memory-bench.mjs out/combined-repeat-new.json --terminal-core
node scripts/rust-daemon-memory-bench.mjs out/output-repeat-new.json --output-compare
WMUX_NATIVE_SOAK_MS=300000 node scripts/native-core-verify.mjs --skip-build --report=out/native-soak-new.json
```

## Build and select

```sh
npm run build:terminal-core
npm run build:daemon
WMUX_DATA_SUFFIX=-rust-test WMUX_TERMINAL_CORE=rust node dist/daemon-bundle/index.js
```

The desktop picker lives in **Settings → Terminal → Performance → Terminal engine**.
It saves `engine: "node" | "rust"` in `~/.wmux{suffix}/terminal-core.json`, shared
by the daemon and local Electron PTY host. With nothing saved, Rust is the
default on Windows, macOS and Linux when the module loads, and Node otherwise
(`defaultTerminalEngine`). The picker
shows the current host's effective backend separately from the saved choice,
disables Rust when the combined native module cannot load, and displays load
fallbacks. Settings search also finds Rust, Node, PTY and memory.

Each host reads the preference once at startup. Changing it leaves ordinary and
team sessions intact. After finishing sessions, quit wmux, run `wmux daemon stop`
with the same instance/profile suffix, then reopen wmux. Reopening the app alone
can reconnect to its existing daemon. In local mode, restarting the app applies
it. There is no automatic restart or session teardown on selection.

An explicit `WMUX_TERMINAL_CORE` environment variable takes precedence and locks
the picker until removed from both app and daemon launches. No saved setting is
copied into the launch environment, so a respawn reads the latest file. The
existing `daemon.ping` gains an opt-in `includeTerminalCore` diagnostic; older or
unreachable daemons display an unknown current engine rather than guessing.

Use a new isolated daemon for benchmarks. Without a saved Rust choice or
`WMUX_TERMINAL_CORE=rust`, node-pty and the JS ring remain selected.
`WMUX_TERMINAL_CORE_MODULE` can name an absolute module path; otherwise the
loader looks only where wmux installs it: packaged `wmux-native` resources, or
beside the bundle (the server runtime, and the `dist/wmux-native` that
`npm run build:terminal-core` stages for `dist/` bundles). A checkout's
`core/wmux-term/dist/native-core` build is used only when named. The older
`WMUX_RUST_SNAPSHOT_MODULE` remains available for snapshot-only experiments.

`WMUX_RUST_SNAPSHOT` independently overrides snapshot selection: `text`, `shadow`,
`off`, and the separately experimental `ansi`/`all` modes. The combined Rust flag
alone selects eligible immutable text requests; ANSI and live tee requests keep
xterm. ANSI delivery refuses known unsupported state: overline, OSC, saved
cursors, character-set/tab configuration, clipped wide-character edges and margins.

Load/ABI/capability failures before spawn fall back to node-pty. A failed native
spawn is never retried through node-pty. The existing Windows ConPTY policy can
retry a pre-spawn bundled-DLL failure or use inbox ConPTY. Runtime faults terminate
the affected session; commands are never replayed.

## Settings verification

- Eight focused test files / 72 tests pass, covering persistence across process
  startup, instance isolation, environment precedence, IPC validation, unavailable
  native modules, failed writes, UI pending state, reversal and reconnect refresh,
  plus the existing PTY, snapshot, ring and Settings search contracts.
- An isolated macOS daemon was started without `WMUX_TERMINAL_CORE`: Node → saved
  Rust → restart → Rust → saved Node → restart → Node. Each write left the live
  host unchanged. The Rust phase created real transport workers and returned the
  expected PTY marker through `daemon.readSessionText`. All test hosts were stopped;
  no running user app or sessions were restarted.

## Native output-path follow-up

The Rust selection now uses optional `output-chunk-v1`: the transport drains into
an owned native chunk, normalizes UTF-8 in Rust, then exposes a synchronous chunk
callback. `DaemonPTYBridge` still chooses whether to retain output (including the
recovery mute/held-output rules), but `NativeRing.writeChunk` borrows the native
bytes directly. It no longer re-encodes a JS string into a Buffer and passes that
Buffer back to Rust. Older ABI-1 modules keep the existing string/byte path.

Mode, OSC, agent and approval analysis remain in JS. Their strings and event
ordering remain part of the contract; this is not a full parser port. The activity
timestamp subscribes to the byte-free `outputActivity` event, so it does not
force a delivery Buffer into existence. Detached sessions with no `data` consumers
need no JS output-byte Buffer. Live clients and snapshot tees share one lazily
materialized Buffer; the native chunk is disposed after synchronous listeners
return, even when a listener throws. Muted output is held as before and replayed
through the existing query sanitizer.

UTF-8 checks compare both text and emission boundaries with Node StringDecoder,
including structurally incomplete invalid prefixes and final EOF. The remaining
u16 cell flag now retains SGR 5 blink (SGR 6 is ignored, matching xterm), without
increasing the 24-byte cell layout. ANSI requests require the optional `ansi-v2`
capability; older serializers fall back before replay. Blink now passes delivery
and shadow parity. The eligibility scan distinguishes color operands from SGR
commands, so RGB/palette values 53 and 55 no longer cause false overline refusals. ANSI remains separately opt-in; live drains and unqualified
state retain the reference backend.

Validation on macOS arm64:

- `out/native-output-chunks-macos-v2.json`: 10 native verification groups pass,
  including 5,000 malformed UTF-8 streams plus split fixtures, real bridge/ring
  capture, 32 concurrent PTYs and 100 lifecycle cycles. Threads return 7 → 7 and
  no native workers remain. The staged module also passes in Electron main.
- `out/ansi-output-chunk-parity-v3.json`: 60/60 checks, comprising 59 supported
  cases and one verified clipped-wide-edge refusal. Both snapshot restoration
  and subsequent terminal output are compared against xterm.
- `out/native-output-daemon-ab.json`: four isolated real daemons, legacy Rust
  output path versus native chunks, one/six detached synthetic sessions. All
  140 text RPC results match and all fixture processes exit. In six sessions,
  6,359,172 retained bytes move from the JS round trip to native writes; native
  output-byte delivery to JS is zero because there are no output subscribers.
- RSS is inconclusive: one-session peak 152 → 164 MiB; six-session peak
  155 → 140 MiB. Settled RSS is 151 → 161 and 100 → 108 MiB respectively.
  This single ordered smoke run proves byte-path removal, not a general memory
  or speed improvement. Text RPC timing does not measure PTY output throughput.

Reproduce the isolated A/B (macOS runner):

```sh
node scripts/rust-daemon-memory-bench.mjs out/output-ab-new.json --smoke --output-compare
```

The shared native implementation also compiles for Linux x64 and Windows x64.
New runtime evidence here is macOS only; the three-OS CI verifier includes the
new chunk tests. No user's running daemon, preferences or sessions were changed.

## Ownership and bounds

- Blocking reads, writes and child wait run on dedicated Rust threads. Output
  queues at most 16 x 16 KiB chunks. A wake callback carries no terminal bytes;
  JS drains at most 256 KiB per turn.
  Unix uses nonblocking descriptors with an owned poll-cancellation socket so
  closing a session also interrupts a writer blocked by a full terminal input
  queue. Idle readers wait on readiness without a periodic timer.
- Input has an 8 MiB limit including in-flight writes. Direct writes reject
  atomically with `PTY_BACKPRESSURE`. Attached input sockets pause at their
  high-water mark and retain one rejected chunk (maximum 256 KiB) for retry.
  RPC callers receive the existing error response for rejected writes.
- UTF-8 decoding spans output chunks. EOF and child exit are distinct; final
  output precedes exactly one exit. Paused output drains after child exit.
- Unix uses a fresh PTY session. Wait-without-reap prevents root-PID reuse during
  signaling. Forced close and root exit terminate processes in the owned SID,
  including background groups. Services creating a new SID are separate.
- Windows assigns the suspended child to a kill-on-close Job Object before
  resuming it. DLL loading uses absolute paths and excludes CWD/PATH lookup.
  ClosePseudoConsole runs off Node. Killing a WSL Windows host is not evidence
  of cleanup of Linux descendants inside a distro.
- Rings grow from 64 KiB to the configured ceiling, up to 256 MiB. Clear retains
  lifetime offsets and geometry semantics. The bridge remains the sole capture
  writer, preserving mute/unmute and prompt-offset ordering.
- Queued text reads freeze bytes/geometry inside the global snapshot slot and
  feed that immutable Rust allocation directly to the native terminal. A full
  JS copy is made only for fallback. Frozen copies and grids are disposed after
  each request; removed sessions explicitly release ring storage.
- Existing atomic dump rename, destination serialization, Windows retry and
  synchronous shutdown helpers still operate on `readAll()` bytes.

## Packaging

The build script targets macOS arm64, Linux x64 GNU or Windows x64 MSVC. It stages
an adjacent-only loader, binary, target/ABI/hash manifest and dependency license
notices in `dist/wmux-native`. Original S-A1 and WASM paths remain separate.

Set `WMUX_PACKAGE_TERMINAL_CORE=1` for a local Forge package after building
the module. The desktop release workflow builds and includes it on all three
targets, including non-publishing `workflow_dispatch` rehearsals. The v4.4.0
workflow omitted this step; its official installers therefore leave Rust disabled
in the picker. Installing a subsequent build containing the module is required.

Forge checks the copied resource's target, ABI, binary hash, loader and notices
before signing (signing changes Mach-O bytes). After signing, it runs the packaged
executable in the daemon's Electron-as-Node mode to load the shipped module,
exercise snapshots and output interpretation, and drain a real PTY into a frozen
ring. Windows uses the package's ConPTY DLL. Failure stops packaging before makers
create installers. This smoke never starts a daemon or changes user settings.

Including the module is what makes Rust the default on Windows, macOS and Linux
(`defaultTerminalEngine`); a saved choice still wins, and switching takes a host
restart. The packaging smoke
does not replace interactive signed-app, team-session or long-soak qualification.

## Reproduce validation

```sh
npm run test:terminal-core
node scripts/native-core-verify.mjs --skip-build
node scripts/rust-snapshot-verify.mjs out/ansi-check-new.json
node scripts/rust-daemon-memory-bench.mjs out/combined-new.json --smoke --terminal-core
npx electron core/wmux-term/spike/native-transport-electron.cjs
```

The verifier runs 6,000 seeded ring operations against JS, geometry churn,
immutable snapshot parity, real PTY input/output hashes, backpressure, resize,
owned-descendant cleanup, 1/6/32 concurrent sessions and 100 lifecycle cycles.
It checks worker-thread reclamation on macOS/Linux. Windows additionally exercises
cmd and PowerShell with bundled and inbox ConPTY. `WMUX_NATIVE_WSL_DISTRO` selects
a distro for a basic command/exit probe, not full WSL lifecycle qualification.

For a continuous eight-hour local soak:

```sh
WMUX_NATIVE_SOAK_MS=28800000 node scripts/native-core-verify.mjs --skip-build
```

The native CI workflow has macOS, Windows and Linux runtime jobs without
`continue-on-error`. Its optional hosted soak is four hours and does not replace
the eight-hour gate. Branch-protection settings have not been changed.

## Local evidence and remaining gates

- macOS arm64 real PTY verification passed; worker threads returned from 7 to 7.
  The staged module loaded and ran the production PTY in Electron 41.10.6 main.
- Strict TypeScript passed all eight slices. Session manager, persistence,
  bridge, input, snapshot, local PTY and replay tests passed. This host's socket
  tests require `TMPDIR=/tmp` to avoid its long default Unix socket path.
- Windows x64 and Linux x64 Rust checks passed; the original WASM target still
  checks. Compilation alone is not an OS runtime qualification.
- Linux x64 was also built and executed in an isolated Debian Bookworm container
  on OrbStack (x64 emulation). All eight native verification groups passed and
  the runner exited successfully. Threads returned from 7 to 7 and the explicit
  native worker counter reached zero. The first run exposed a blocked Unix
  writer after child exit; the cancellable I/O change fixes that regression.
  This is functional evidence, not native-x64 performance or Linux desktop QA.
- ANSI conformance passed 52 supported restores and one deliberate wide-edge
  refusal in the initial integration. The output-path follow-up below adds
  blink parity. Full private parser-state equivalence is not claimed.
- Six isolated daemon runs (node/Rust/missing module, each with one and six
  synthetic sessions) returned identical results for 210 text RPCs. No fixture
  processes survived destruction; all daemons exited cleanly. Evidence:
  `out/rust-terminal-combined-final.json` (repeated after the Unix cancellation
  fix); the earlier comparison is `out/rust-terminal-combined-smoke-v2.json`.

The final smoke run observed maximum daemon RSS of 206 -> 163 MiB for one session
and 320 -> 194 MiB for six. An earlier run measured 181 -> 113 MiB and 322 ->
187 MiB respectively, but **settled RSS was higher in Rust in that earlier run**
(six sessions: 62 -> 186 MiB; final run: 311 -> 171 MiB). The host was under memory
pressure and run order was not randomized. This establishes no reliable idle
memory improvement or real AI-team savings.
Allocator retention, GC visibility of native allocations and quiet-host repeats
need investigation.

Remaining default/release gates: Windows 10/11 and WSL runtime/descendant cleanup,
actual Linux desktop/Electron packaging, signed packaged-app QA, continuous
eight-hour soak, and real AI teams. Full ANSI replacement is not complete.

### Normal macOS packaged UI qualification (2026-10-14)

The unsigned arm64 package was launched as a normal Electron desktop app with
a unique suffix and short temporary HOME. Settings' native select saved Rust
while the live daemon continued using Node and displayed restart guidance.
After stopping both isolated hosts and relaunching, Settings and daemon RPC
reported Rust. Six panes created through split buttons each ran a shell command
and returned the expected Korean/emoji output. An app-only restart retained the
same daemon PID and restored all six output markers; another command succeeded
after reconnect. Selecting Node likewise kept the live Rust host unchanged until
daemon restart, then reported Node and ran another command successfully.

All recorded test app/daemon/shell processes exited, and the installed CLI shim
was unchanged. `bench/results/rust-terminal-macos-ui-20261014.json` records the
claim, observations, limits and hashes of local UI evidence. The verification
driver now supports native-select interaction and an owned app-only restart.
Its seven existing isolation/helper tests pass; the new paths were exercised
against this package.

This build disables the company/team UI (`COMPANY_MODE_ENABLED=false`). Six
ordinary shell panes qualify terminal concurrency and reconnection, not actual
AI-team orchestration or its memory footprint. Windows/Linux desktop packages,
WSL and signed distribution remain unverified. The eight-hour soak started
separately; a running soak is not a pass. Its runner allows 16 MiB of report
output because eight hours of two-second memory samples exceed the default
1 MiB child-output limit.

### Output interpretation follow-up (roadmap stage 2)

Rust-backed daemon PTYs now use the additive `output-interpreter-v1` capability
for DEC mode tracking, replay preambles and OSC extraction. `feedChunk` reads the
normalized native chunk directly. Only mode carry (256 UTF-16 units) and partial
OSC payloads (64 Ki UTF-16 units) are retained. OSC codes cross N-API in one typed
array per batch, with payload strings alongside; the daemon receives the same
ordered `{ code, data }` callbacks. Node PTYs and older native modules retain the
existing JS interpreter. This choice is per bridge, tied to the actual PTY
backend; it does not add another daemon or replay a spawn.

Ring writes still precede mode updates, then OSC callbacks, agent interpretation
and output delivery. Recovered history seeds modes without replaying old OSC
events. Muted output does not enter the interpreter; an explicitly held/replayed
chunk is interpreted once after capture. Ring offsets remain JS-safe byte
counters, including values beyond 4 GiB. Cleanup clears native OSC callbacks but
keeps the last mode state readable by an in-flight screen render. The N-API
finalizer frees the interpreter after its last mode reference is released.
Completed or overflowed OSCs release allocations larger than 2,048 UTF-16 units;
small payload storage is reused. Initial history seeding borrows the input when
there is no previous mode carry.

This is a compatibility port of `OutputModeTracker` and `OscParser`, not a claim
of complete VT parsing. It deliberately retains the reference OSC contract:
the two-byte introducer and ESC-backslash terminator must each arrive in one
decoded chunk. Fixing arbitrary split introducers/terminators requires a shared
reference change and separate qualification. Title/CWD sanitation, notification
policy, OSC 133 subcommand interpretation/timestamps, prompt logs and agent
status stay in Node. The local Electron PTY bridge also retains JS interpretation.
Full ANSI/private-parser-state parity remains a later stage-2 item.

Validation runs the same corpus through both `feed(text)` and `feedChunk`, for
8,846 differential feeds against both JS references, including
every code-point split of a mixed stream, seeded mixed chunks, OSC overflow,
Unicode carry, resets and replay-window offsets. A real native-chunk bridge
fixture checks mode-only recovery, mute/discard/replay, prompt offsets, callback
order and mode references held across cleanup. The held-reference regression
fails with `Output interpreter disposed` against the original adapter and passes
with the fix. These run inside the three-OS native verifier alongside its
existing PTY lifecycle and snapshot checks. The native CI matrix also runs the
Rust interpreter/grid unit tests, including OSC allocation release on BEL, ST
and overflow.

Reproduce parser-only measurements after building the native module:

```sh
node scripts/rust-output-interpreter-bench.mjs out/interpreter-new.json
```

The initial, pre-review macOS arm64 sample uses the production adapter and callbacks,
roughly 4 MiB per workload, one warm-up and five alternating-order repeats in
one process. Median JS → Rust elapsed times were 3.46 → 1.07 ms for plain logs,
5.19 → 2.88 ms for colored logs and 30.88 → 26.82 ms for an intentionally dense
mode/OSC stream. Event counts matched. These are small parser microbenchmarks
on a host also running the preceding core's soak; they do not establish daemon
RSS savings, interactive latency or real-team performance. Raw measurements:
`bench/results/rust-output-interpreter-macos-20261014.json`.

The earlier eight-hour run is pinned to the preceding PTY/buffer implementation;
it does not qualify this new interpreter. This follow-up needs its own adoption
and cross-platform evidence before default/release promotion.

The initial short-soak and daemon-smoke artifacts are development-stage evidence:
`rust-output-interpreter-short-soak-20261014.json` used the earlier 4,420-feed
verifier, and `rust-output-interpreter-daemon-smoke-20261014.json` measured an
uncommitted implementation. Their source notes identify those limits; neither
qualifies the review fixes. The review also reported a 10,923-feed randomized
comparison without mismatches; that external result is separate from the
reproducible corpus committed here. Callback exceptions and disposal during an
OSC batch retain the existing native adapter behavior: parser state is already
updated before callbacks, and disposal suppresses remaining native callbacks.

Review-fix evidence at `480ba5c89` is recorded in
`bench/results/rust-output-interpreter-review-conformance-20261014.json`:
8,846 differential feeds across both entry points, 14 native verification groups,
7 → 7 threads and zero remaining native workers. Local validation also passed
296 JS tests, 11 Rust tests, daemon/verifier TypeScript checks and the Electron
41.10.6 native smoke. Clippy passed with the pre-existing transport constructor's
`too_many_arguments` lint allowed.

The refreshed parser sample is
`bench/results/rust-output-interpreter-review-macos-20261014.json`.
Median JS → Rust times were 5.72 → 1.62 ms (plain), 8.82 → 5.02 ms (colored),
and 66.41 → 64.63 ms (dense mode/OSC). Event counts still matched. This run
shared the machine with Electron/Clippy validation and other work: the dense
case showed only a small difference and the results do not establish a stable
speedup. The original pre-review sample is retained as historical evidence.
