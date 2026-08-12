// Buffered writer for the daemon's durable log file (daemon.log).
//
// WHY: log() used to appendFileSync on EVERY line. Each sync append is a
// write(2) + flush the calling thread waits on — and on Windows with EDR
// filter drivers each one is also a scan hook, which is exactly the
// environment where the daemon's hot paths (session churn, recovery, RPC
// bursts) turned logging into measurable stall time. Buffering info/debug
// lines and flushing every FLUSH_MS (or at the byte cap) collapses N syscalls
// into one while keeping the file byte-identical in content and order.
//
// DURABILITY CONTRACT (deliberate, reviewed):
//   - warn/error lines NEVER buffer. They first drain any pending info lines
//     (so the file stays in true chronological order — the log exists for
//     post-hoc causal reconstruction) and then append synchronously, so the
//     last thing a dying daemon said is on disk before the crash propagates.
//   - A clean exit flushes the tail via the process 'exit' hook (wired in
//     index.ts). A hard kill (SIGKILL / supervisor force-respawn) can lose at
//     most the last FLUSH_MS window of info lines — accepted: even the old
//     per-line sync write lost the line that never got to execute, and the
//     error-level record of whatever went wrong is already durable.
//   - The existing postmortem sinks (src/daemon/util/logSink.ts,
//     src/main/util/logSink.ts) are untouched: their all-sync behavior is
//     their contract, not an accident.
//
// Best-effort throughout: a logging failure must never crash the daemon.

import * as fs from 'fs';

export interface DaemonLogWriterOptions {
  /** Durable log file path (daemon.log). */
  path: string;
  /** Rotation cap: when the file would exceed this, rename to `<path>.1`. */
  maxBytes: number;
  /** Coalescing window for buffered (info/debug) lines. */
  flushMs: number;
  /** Force-flush threshold so a burst can never grow the buffer unbounded. */
  bufferMaxBytes: number;
}

export interface DaemonLogWriter {
  /** Queue (info/debug) or write-through (warn/error) one already-formatted line. */
  write(level: string, line: string): void;
  /** Drain any buffered lines synchronously. Safe to call from an 'exit' hook. */
  flush(): void;
}

export function createDaemonLogWriter(opts: DaemonLogWriterOptions): DaemonLogWriter {
  // In-memory byte counter so we don't statSync on every flush. -1 =
  // uninitialised (seeded from the existing file size on first use).
  let fileBytes = -1;
  let pending: string[] = [];
  let pendingBytes = 0;
  let flushTimer: NodeJS.Timeout | null = null;

  function rotateIfNeeded(): void {
    if (fileBytes < 0) {
      try { fileBytes = fs.statSync(opts.path).size; } catch { fileBytes = 0; }
    }
    if (fileBytes > opts.maxBytes) {
      try { fs.renameSync(opts.path, `${opts.path}.1`); } catch { /* ignore */ }
      fileBytes = 0;
    }
  }

  function appendNow(chunk: string): void {
    rotateIfNeeded();
    fs.appendFileSync(opts.path, chunk);
    fileBytes += Buffer.byteLength(chunk);
  }

  function flush(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0) return;
    const chunk = pending.join('');
    pending = [];
    pendingBytes = 0;
    try {
      appendNow(chunk);
    } catch {
      // Logging must never crash the daemon.
    }
  }

  function write(level: string, line: string): void {
    try {
      if (level === 'warn' || level === 'error') {
        // Drain buffered lines FIRST so the file stays chronological, then
        // write through synchronously — the error must be durable now.
        flush();
        appendNow(line);
        return;
      }
      pending.push(line);
      pendingBytes += Buffer.byteLength(line);
      if (pendingBytes >= opts.bufferMaxBytes) {
        flush();
        return;
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, opts.flushMs);
        // Never let a pending log flush pin the process alive.
        (flushTimer as unknown as { unref?: () => void }).unref?.();
      }
    } catch {
      // Logging must never crash the daemon.
    }
  }

  return { write, flush };
}
