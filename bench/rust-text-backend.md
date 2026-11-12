# Opt-in Rust text snapshot delivery

`WMUX_RUST_SNAPSHOT=text` selects the native candidate for eligible daemon text
snapshots used by screen reading and search. This is experimental, disabled by
default, and currently validated on macOS arm64. ANSI reconnect serialization,
PTY transport, ring buffers and renderer terminals retain their existing paths.

## Enable or disable

Build the native module, then supply these variables to a **newly started**
experimental daemon (or an app instance that starts that daemon):

```sh
bash core/wmux-term/build-native-core.sh
export WMUX_RUST_SNAPSHOT=text
export WMUX_RUST_SNAPSHOT_MODULE="$PWD/core/wmux-term/dist/native-core/index.cjs"
```

The regular daemon build must also contain the new selector. The native module
is an external, absolute path; release packaging does not install or select it
automatically. Changing an app's environment does not reconfigure a daemon that
is already running. Use an isolated `WMUX_DATA_SUFFIX` when evaluating; no
running user instance was restarted or opted in during this work.

Unset the variable or set it to `off` before starting the daemon to use xterm
exclusively. Unknown mode values also leave the xterm path selected, except the
removed comparison mode `shadow`, which reads as unset (the default for the
terminal engine).

## Fallback contract

- Immutable history requests can select Rust. Requests carrying a destructive
  `drainQueue` go directly to xterm: a failed attempt never consumes their live
  output. The original buffer and geometry are reused for fallback without a
  second retained input copy.
- Native attempts are limited to 8 MiB input, 2–1,000 columns, 1–1,000 rows,
  and one million configured grid cells including scrollback at every recorded
  geometry. Other requests use xterm. Text output must match the required shape
  and account for every input byte.
- The native loader requires snapshot ABI version 1. Missing files, unsupported
  binaries, stale ABI versions, malformed outputs and catchable native errors
  fall back to xterm. A module error disables further native attempts for that
  module path for the daemon lifetime. Restart or select a different module
  path to retry a repaired build. Ordinary request-budget failures do not
  disable the module.
- Both attempts share the caller's original wall-clock budget. Rust receives
  half, reserving time for fallback; xterm receives only the time remaining.
  If the total budget is exhausted, the existing `{ ok: false, reason: 'budget' }`
  outcome is returned. There is no promise of successful fallback after deadline
  exhaustion. Synchronous parse slices can overshoot a deadline slightly.
- Native and fallback work run inside the existing global snapshot queue.
  Concurrent readers cannot multiply native grids. No second process or changed
  RPC/WebSocket schema is introduced.

The fallback handles reported errors, not an undetected semantic mismatch or a
fatal native process crash. The finite parity corpus remains an
important adoption gate; this is not a default-on release decision.

`getTextSnapshotBackendDiagnostics()` exposes internal success, fallback and
skip counters, the last backend/reason and the current module failure state.
It contains no terminal text or credentials. It is used by the isolated daemon
runner; no new public diagnostics RPC has been added.

## Validation

- 51 unit tests across text selection, loader ABI, shadow and headless text/ANSI
  behavior; strict daemon TypeScript and ESLint pass.
- 31 differential text fixtures pass. The production flag is also checked for
  every fixture: immutable requests must actually use Rust, live-drain requests
  must use xterm, and both must equal the reference.
- Existing ANSI restoration checks remain 52 supported cases plus one explicit
  refusal; native PTY smoke and Electron loading pass.
- The real bundled daemon runner uses the production flag with no backend
  substitution. Its smoke mode compares xterm, Rust and a deliberately missing
  native module for both one and six PTY sessions: **6 daemon runs, 210 read
  RPCs**, identical output hashes, verified process cleanup and clean exits.
  In each missing-module daemon only the first call attempts fallback; later
  calls use xterm directly. Native-mode diagnostics prove Rust served all its
  eligible read requests.

Evidence is in `out/rust-terminal-core/text-flag-{daemon,parity,ansi}.json`.
Reproduce the daemon test with:

```sh
node scripts/rust-daemon-memory-bench.mjs out/rust-terminal-core/text-flag-new.json --smoke
```

This validates the built daemon and Electron native loading, not a packaged GUI
end-to-end test, real AI team soak test, signed distribution, or new memory
performance claim. Those remain subsequent validation steps.
