# EPIPE log storm fix report

- Branch: `fix/log-epipe-storm`
- Base: `origin/main` at `af99b857`
- Scope: main-process persistent log sink only
- Push: not performed
- PR: not created

## 1. Root cause

The runaway files were not primarily produced by ordinary verbose logging. The retained samples show the same pair repeated millions of times:

```text
[Main] Uncaught exception: Error: write EPIPE
  code: 'EPIPE',
```

The exact feedback loop is:

1. `initLogSink()` replaces both `process.stdout.write` and `process.stderr.write` with a tee.
2. Each tee write first appends the message to `main-YYYY-MM-DD.log`, then calls the original inherited stream's `write()`.
3. The existing inner `try/catch` only catches a synchronous throw. Node writable pipes normally report a broken pipe later through the stream's asynchronous `error` event.
4. By the time that event is delivered, the old synchronous `writing` reentrancy flag has already been reset to `false`.
5. With no stream `error` listener, EPIPE reaches the process-level `uncaughtException` handler in `src/main/index.ts`.
6. That handler calls `console.error`, which enters the same stderr tee, appends another EPIPE report to the file, forwards to the same broken fd, and schedules the next EPIPE.

The old comment in `logSink.ts` correctly described the incident but incorrectly assumed that synchronous `try/catch` plus a synchronous reentrancy flag covered the failure. They do not cover an error event delivered after `write()` returns.

This matches the field evidence:

- 2026-07-20 full extraction: 7,211,714 repeated EPIPE pairs.
- 2026-07-31 sampled windows: 3,354,467 repeated pairs; whole-file estimate above 120 million.
- The log remains writable because file mirroring happens before every attempt to use the broken host stream, so every recursion adds another record.

## 2. Changes

### A. Break the EPIPE feedback loop

`src/main/util/logSink.ts` now exposes and uses `createResilientTee()`:

- Installs an `error` listener on each concrete pass-through target independently (`stdout` and `stderr`).
- Disables only the host-stream forwarding path after that stream emits an error.
- Continues mirroring later writes to the persistent file; loss of a parent console does not remove postmortem logging.
- Disables forwarding on synchronous throws as well.
- Wraps write callbacks so a callback-delivered failure disables forwarding before caller code can log the error again.
- Never logs from the stream error handler itself.
- Preserves the existing synchronous reentrancy guard for nested writes inside one call stack.

`src/main/index.ts` adds an independent early-boot guard:

- `uncaughtException` and `unhandledRejection` do not print `EPIPE` or `ERR_STREAM_DESTROYED` back to stdio.
- This protects the interval before `app.ready`, when `initLogSink()` has not installed stream listeners yet.
- All unrelated exceptions and rejections retain the existing `console.error` reporting behavior.

### B. Add a hard size cap and rotation

`BoundedLogWriter` replaces unbounded `appendFileSync` calls in the main sink.

- Active daily file cap: **16 MiB**.
- Archives: **3** (`main-DATE.log.1` through `.3`).
- Maximum retained data per UTC day: **64 MiB** across the active file and three archives.
- Normal writes rotate before append and remain intact; a single write larger than 16 MiB is split across bounded generations.
- The oldest archive is deleted when a fourth rotation occurs.
- A legacy daily file already above the cap is reduced to its newest 16 MiB before normal rotation, so upgrading does not merely rename a 91 GB file into an equally oversized archive.
- Startup retention pruning now includes numbered rotation files.
- Rotation remains synchronous and best-effort, matching the existing crash-oriented sink behavior.

## 3. Regression tests

Added `src/main/util/__tests__/logSink.test.ts` with six tests:

1. An original stream write schedules asynchronous EPIPE after returning. After that event, 100 simulated uncaught-exception reports mirror to file but call the broken fd zero additional times (`original writes = 1`).
2. A synchronous EPIPE also disables the pass-through after one attempt.
3. The global-handler classifier accepts `EPIPE` / `ERR_STREAM_DESTROYED` and rejects unrelated errors such as `ENOSPC`.
4. Rotation keeps only the configured generations and every file remains within its cap.
5. One oversized write is split across rotations without any oversized file.
6. A pre-existing oversized daily file is bounded before it becomes an archive.

Target result:

```text
Test Files  1 passed (1)
Tests       6 passed (6)
```

## 4. Gates

### Vitest

- Target log-sink suite: **6 passed, 0 failed**.
- Full non-runtime suite, final run: **682 files passed / 2 skipped; 10,046 tests passed / 24 skipped; 0 failed**.
- Runtime suite: **8 files passed / 3 skipped; 138 tests passed / 14 skipped; 0 failed**.

One earlier full non-runtime run had one unrelated failure in `TranscriptProjector.test.ts`. The failing file immediately passed alone (**39/39**), and the complete suite then passed on the next run. No log-sink test failed. This consumed one of the requested three allowed gate failures; the stop threshold was not reached.

### TypeScript

```text
npx tsc --noEmit
PASS
```

This was run repeatedly during implementation and again as a final gate. No TypeScript failure occurred.

### Build/package

```text
npm run package
PASS
```

The production path completed daemon, MCP, CLI, Electron Forge main/preload/renderer builds, and unsigned macOS arm64 packaging. This verifies the actual `src/main/index.ts` bundle, not only a standalone Vite default entry.

### Additional checks

- ESLint on `logSink.ts` and its new test: pass.
- `git diff --check`: pass.
- Running ESLint against the entire pre-existing `src/main/index.ts` still reports its existing `require()` rule violations; none are in the changed lines and lint was not one of the requested gates.

## 5. Files changed

- `src/main/util/logSink.ts`
- `src/main/util/__tests__/logSink.test.ts`
- `src/main/index.ts`
- `FIX_REPORT.md`

FIX-DONE
