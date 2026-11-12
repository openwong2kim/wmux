# Rust terminal core C experiment — 2026-10-13

## Decision

The native text snapshot is faster and uses less peak memory in the measured
synthetic workloads. xterm remains the default. The experiment now has an opt-in
[text delivery path with fallback](rust-text-backend.md). (A shadow comparison
mode was used during the experiment and has since been removed.) ANSI remains on xterm. Team-mode CLI/MCP memory is a
separate workstream delegated to Claude; these results do not predict its savings.

## Implemented

`core/wmux-term` has an optional `native-core` N-API feature containing:

- `NativeTerminal`: Alacritty 0.26.0 with wmux Unicode 11 and cursor-paragraph
  resize compatibility patches, raw-byte feed, text and ANSI snapshots, alternate
  screen, geometry changes, and explicit disposal.
- `NativeRing`: lazy 64 KiB bounded storage, growth, wrap, oversized-write
  truncation and readback. Production geometry journals and sequence counters
  are not implemented.
- `NativePty`: portable-pty 0.9.0, spawn, input/output, resize, exit, asynchronous
  kill and immediate-child cleanup. Output uses a bounded 16 × 16 KiB channel.
  Writes are synchronous, limited to 4 KiB, and can block on a stalled child.
  This is not yet a complete node-pty adapter or process-tree supervisor.

The real PTY → ring → terminal path runs in the native smoke test. Default S-A1
and WASM builds exclude this feature. Native outputs live in `dist/native-core`
inside the crate. No RPC or WebSocket schema changed, and no extra daemon process
was added. Fork provenance and maintenance obligations are recorded in
[WMUX-PATCH.md](../core/wmux-term/vendor/alacritty_terminal/WMUX-PATCH.md).

The `WMUX_RUST_SNAPSHOT=shadow` comparison mode (xterm authoritative, Rust
compared on the same input) has been removed. A daemon started with that value
now selects the default snapshot backend for its terminal engine. Parity is
checked by the Rust parity suites (`src/daemon/__tests__/Rust*Parity.test.ts`)
and `bench/rust-snapshot-parity.ts`.

## Correctness

Text differential checks invoke production `generateTextSnapshot`: **31/31
fixtures match**, including all six public synthetic corpora, Unicode 11 emoji,
resizes, dim filtering, alternate screens, live drains and chunked input.

ANSI checks compare restored xterm cell contents, widths, colors, style flags,
wraps, cursor, public modes and buffers; then feed live continuation bytes and
return from the alternate screen where applicable. **52 cases match; one case
explicitly refuses ANSI serialization** because resizing leaves a clipped
fullwidth glyph in the last column. Replaying that cell as ANSI would introduce
an extra wrap. The refusal requires raw replay or the existing xterm result.
The runner's 53 successful checks include this expected refusal, not 53 supported
native restorations.

The suite includes 22 hand-written cases, six recorded corpus cases, 24 seeded
resize cases and an incomplete UTF-8 case. It covers incomplete CSI and
synchronized output, alternate screens, styles, cursor state and continuation.
This finite coverage is not a proof of complete terminal equivalence: private
parser state, saved cursors, hyperlink metadata and extended underline details
are not all represented in the fingerprint. Native blink support remains a
known mismatch. Integration tests deliberately trigger it and verify that
xterm's blinking output still reaches the caller.

Backend selection tests (`TextSnapshotBackend.test.ts`, `AnsiSnapshotBackend.test.ts`)
cover fallback, live-drain routing and missing-module handling. This is not a
full packaged-daemon RPC or multi-client soak test.

PTY checks cover UTF-8, resize via `stty size`, exit status 7, lossless delayed
consumption of 2 MiB, kill/reap, close/reap, twenty spawn/exit cycles, missing
commands, and ring growth/wrap against a byte oracle. Test children are cleaned
up in `finally`.

## Measurement

Apple M5, macOS arm64, Node 24.15.0; three fresh workers per combination,
alternating engine order. Each parses approximately 1 or 8 MiB into a 120 × 40
grid with 5,000 scrollback lines, yielding after 256 KiB slices. No persistent
per-session headless terminal is assumed.

Medians from `out/rust-terminal-core/compat-performance.json`:

| Input | xterm text | Rust text | xterm peak RSS | Rust peak RSS |
| --- | ---: | ---: | ---: | ---: |
| 1 MiB colored log | 34.3 ms | 11.3 ms | 86.8 MiB | 74.2 MiB |
| 1 MiB cursor redraw | 29.4 ms | 7.3 ms | 67.4 MiB | 57.5 MiB |
| 8 MiB colored log | 132.9 ms | 58.5 ms | 103.6 MiB | 93.9 MiB |
| 8 MiB cursor redraw | 162.2 ms | 56.3 ms | 88.1 MiB | 77.1 MiB |

Text snapshots were approximately **2.3–4.0× faster**, with **9.7–12.6 MiB lower
whole-worker peak RSS**. All benchmark text hashes matched. Peak RSS includes
Node, both libraries, input allocations and temporary copies; it is not retained
daemon memory or native allocation size. Raw results also include CPU, GC and
event-loop measurements. Host activity affects short cold-process timings.
These measurements do not cover ANSI serialization, interactive latency,
production PTY transport or team-mode memory.

A subsequent [real-daemon RPC measurement](rust-daemon-memory.md) compares one
and six synthetic PTY sessions with a benchmark-only text snapshot substitution.
Its whole-daemon results must be evaluated separately from this microbenchmark.

## Reproduce

```sh
mkdir -p out/rust-terminal-core
node scripts/rust-terminal-core-bench.mjs out/rust-terminal-core/new-run.json
node scripts/rust-terminal-core-bench.mjs out/rust-terminal-core/new-verify.json --verify-only
node scripts/rust-snapshot-verify.mjs out/rust-terminal-core/new-ansi.json
node_modules/.bin/electron core/wmux-term/spike/native-electron.cjs
npx tsc -p tsconfig.daemon.json --noEmit
npx vitest run src/daemon/__tests__/TextSnapshotBackend.test.ts src/daemon/__tests__/HeadlessSnapshot.test.ts src/daemon/__tests__/RingBuffer.test.ts
cargo clippy --manifest-path core/wmux-term/Cargo.toml --features native-core --lib -- -D warnings
cargo test --manifest-path core/wmux-term/Cargo.toml --no-default-features
cargo check --manifest-path core/wmux-term/Cargo.toml --target wasm32-unknown-unknown
```

Use a new output filename each time: reports are exclusive-create. Native builds
check the generated Unicode table against the installed xterm source. Current
checks pass: TypeScript, ESLint for new daemon modules, 42 daemon unit tests,
seven original Rust grid tests, clippy and WASM compilation. The Electron smoke
loads the Node-built binary without rebuilding for Electron.

## Remaining adoption gates

1. Resolve unsupported ANSI attributes/states and broaden restoration plus live
   continuation coverage, including saved cursors and parser state.
2. Build the complete production PTY adapter: nonblocking backpressured writes,
   callbacks, flow control, signals, environment and process-tree lifecycle.
3. Preserve ring geometry/sequence contracts and native memory accounting.
4. Test a packaged isolated daemon over RPC, client reconnects and long-running
   workloads; validate signed packaging and supported platforms beyond macOS arm64.
5. Measure retained daemon RSS and latency before choosing any replacement flag
   or default. Shadow mode itself increases work.

See [bot-memory.md](bot-memory.md) for the independent CLI/MCP memory findings.
