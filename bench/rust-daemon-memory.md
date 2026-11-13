# Rust snapshot memory in a real daemon — 2026-10-13

## Results

In this run, the Rust text-snapshot candidate had lower daemon peak RSS in all
three workload groups. The largest median difference was 128.3 MiB for six
terminals with 1 MiB each. This is an observed short-run result under substantial
host memory pressure, not a guaranteed idle-memory or whole-team saving.

Each cell is the median across three runs, followed by the run range. Peak is
process lifetime high-water RSS through the final read. Settled RSS is the
median of the following two seconds. A read batch requests all listed terminals
and includes RPC transport, JSON parsing, hashing and fixture validation.

| Sessions × output each | Text backend | Peak RSS MiB | Settled RSS MiB | Read batch ms |
| --- | --- | ---: | ---: | ---: |
| 1 × 1 MiB | xterm | 209.1 (205.8–227.6) | 108.2 (57.1–166.3) | 71.0 (40.0–108.4) |
| 1 × 1 MiB | rust | 155.5 (138.2–160.0) | 98.8 (92.1–160.0) | 33.5 (29.6–66.8) |
| 6 × 1 MiB | xterm | 329.9 (322.2–330.3) | 145.6 (90.5–306.1) | 545.3 (418.9–557.2) |
| 6 × 1 MiB | rust | 201.6 (175.5–214.8) | 79.5 (75.7–90.5) | 463.5 (366.4–551.6) |
| 6 × 8 MiB | xterm | 383.2 (354.7–399.5) | 367.5 (254.1–388.7) | 1556.6 (1220.8–1632.7) |
| 6 × 8 MiB | rust | 319.8 (313.4–321.3) | 154.9 (57.5–160.9) | 1489.4 (1461.5–1539.9) |

The peak median differences are 53.6, 128.3 and 63.4 MiB respectively. They do
not scale linearly with session count: the daemon uses one shared snapshot
queue, and allocation/GC history matters. Settled RSS varied sharply; no stable
idle-memory reduction is established. Read timings also varied substantially;
the 8 MiB × six-session batch was similar between engines.

All **18 daemon runs / 780 read RPCs** completed; hashes matched between
backends, sessions and rounds. The 156 retained first/last response fixtures
contain no UTF-8 replacement characters. Every run verified fixture-process
cleanup and a zero daemon exit code. No failed or UTF-8-corrupted harness run
is included in the table.

Raw evidence: `out/rust-terminal-core/daemon-memory-v3.json`; derived medians:
`out/rust-terminal-core/daemon-memory-summary.json`. Producer processes used
approximately 36 MiB for one and 204–223 MiB in total for six; they are kept
separate from the daemon figures above. They are synthetic Node producers, not
Claude workers, and their RSS is not credited as a Rust saving.

A real AI team still adds the agent CLI/MCP processes measured in
[bot-memory.md](bot-memory.md). This substitution does not remove those
processes. Full Rust PTY/ring replacement and a production AI team before/after
comparison remain unmeasured here.

## Scope and method

This experiment launches the real daemon entry point, bundled from the dirty
working checkout, in a new isolated data suffix for every sample. It uses real
PTY sessions and the existing `daemon.createSession`, `daemon.readSessionText`,
`daemon.destroySession` and `daemon.shutdown` RPCs. No user session is changed.

The historical measurement above used an esbuild hook to substitute **only text
snapshot generation** in a benchmark bundle. The Rust candidate replaced the xterm call; it did
not run both engines side by side (the later shadow mode did; it has since been removed). Production files and backend defaults
are not changed by the runner. PTY transport, ring buffers, ANSI reconnect
snapshots and the daemon's other services remain the existing implementation.

The current runner uses the [production text selection flag](rust-text-backend.md)
instead of that substitution. Its smoke mode also tests a missing module and
verifies backend diagnostics. The historical performance table has not been
remeasured with the new fallback/ABI/budget policy.

Workloads:

- One terminal with approximately 1 MiB of colored log output.
- Six terminals with approximately 1 MiB per terminal.
- Six terminals with approximately 8 MiB per terminal.

Six terminals represent a team-sized terminal load, **not six real LLM agents**.
They use deterministic Node fixture producers which stay alive after emitting
their log. Electron/renderers, model requests, CLI agents and MCP processes are
not included in daemon RSS. Actual bots/worker measurements remain documented
separately in [bot-memory.md](bot-memory.md).

Each combination uses three fresh daemons per backend, alternating backend
order. After startup and filling the buffers, ten rounds read every session
concurrently over RPC; the production snapshot queue serializes the jobs.
Responses are hashed and must match across engines, sessions and rounds. A
marker checks that terminal output reached the daemon before comparison.

The daemon reports its own RSS and heap statistics every 20 ms over a private
benchmark IPC channel. This can miss short peaks, so process lifetime high-water
RSS is also retained. Idle and settled values use each run's median samples;
the summary uses medians across three runs. Settled means two seconds after the
last read, without forced GC. It does not mean all temporary allocations have
been returned to the OS. Allocator reuse, GC and other host activity cause noise.

Fixture child RSS is recorded separately using `ps` without command arguments.
Every created session is destroyed through RPC; the runner checks that its
fixture processes are gone, then shuts down the isolated daemon. A private
node-pty copy restores the macOS spawn helper's executable bit when necessary,
without changing the checkout's installed dependency.

## Reproduce

```sh
bash core/wmux-term/build-native-core.sh
node scripts/rust-daemon-memory-bench.mjs out/rust-terminal-core/daemon-new.json
# One- and six-session checks, including deliberate native-load failure:
node scripts/rust-daemon-memory-bench.mjs out/rust-terminal-core/daemon-smoke-new.json --smoke
```

Reports are exclusive-create. Bundles, fixture source and daemon logs remain in
the reported ignored `out/rust-daemon-memory-*` directory. The driver currently
targets macOS. This is a short repeated-snapshot experiment, not a leak test or
a measurement of the complete Rust C replacement.


## Host conditions

The host was busy during the final run: 16 GiB physical RAM, approximately
12.6 GiB swap used, and load averages 15.60 / 10.45 / 8.51 at a mid-run sample
(`out/rust-terminal-core/daemon-host-context.json`). RSS excludes compressed or
swapped-out pages. Large timing and RSS variation must not be treated as a
stable Rust capacity improvement. No other user processes were stopped to make
the numbers look cleaner.

The initial harness decoded socket chunks independently and corrupted UTF-8
characters at chunk boundaries. Its output-hash gate correctly failed; those
runs are excluded. The corrected client uses the socket's incremental UTF-8
decoder, and retained response fixtures are checked for replacement characters.
