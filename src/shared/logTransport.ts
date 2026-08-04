/**
 * Shared transport primitives for the main and daemon log sinks.
 *
 * Both sinks tee `process.stdout.write` / `process.stderr.write` into a
 * daily-rotated file, and both are exposed to the same failure: when the
 * inherited stdio pipe's reader goes away, the pass-through write fails with
 * EPIPE, the global uncaughtException handler reports it with `console.*`, and
 * that lands right back on the broken pipe. This module owns the two pieces
 * that stop it — `createResilientTee` and `BoundedLogWriter` — so the daemon
 * gets the same protection as main without importing `electron` (the daemon
 * must not, it would pull in a second copy of the runtime on Windows).
 */

import fs from 'node:fs';

/** Each daily file is capped at 16 MiB with three archives (64 MiB/day max). */
export const MAX_LOG_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_LOG_ARCHIVES = 3;

/**
 * A rotation lock older than this is treated as abandoned by a crashed
 * process. Rotation is a handful of renames, so anything approaching a second
 * means the holder died mid-sequence.
 */
const ROTATION_LOCK_STALE_MS = 10_000;

/**
 * A file this far past the cap did not get there by a concurrent append — it
 * predates the cap entirely (the storm this module exists to stop left an
 * 84.9 GiB one behind). Only those are truncated; see `boundOversizedFile`.
 */
const LEGACY_OVERSIZE_FACTOR = 4;

/**
 * Synchronous bounded writer used by the tee. Small writes rotate as a unit so
 * normal log lines are never split. A single oversized write is chunked across
 * generations.
 *
 * Several wmux processes legitimately share one daily file — the log path is
 * derived from the log directory alone, so an installed build and a dev build
 * interleave in it. Two rules follow:
 *
 *   - The size is never cached, and is re-read before every append. An
 *     in-process byte counter drifts as soon as another process appends, and a
 *     drifted counter either rotates early (shredding the file into archives)
 *     or never rotates at all.
 *   - Rotation runs under an exclusive lock file and re-checks the size once it
 *     holds the lock. Without it, two processes crossing the threshold together
 *     both run the rename chain and the second one shifts a generation that the
 *     first already shifted, discarding a whole archive.
 *
 * That bounds the file without serialising the appends themselves. It does not
 * make the cap exact: `appendFileSync` opens with O_APPEND so no write is ever
 * torn or lost, but two processes can still read the same under-cap size and
 * both append, and an append can land in an inode another process is renaming.
 * The overshoot is one write per racing process, and it is deliberately
 * preferred over the alternatives — taking the lock per line would let one
 * process stall another's logging, and treating an over-cap file as junk to
 * truncate would discard log data to defend a number. Overshoot is carried into
 * the archive intact instead.
 */
export class BoundedLogWriter {
  constructor(
    private readonly maxBytes = MAX_LOG_FILE_BYTES,
    private readonly maxArchives = MAX_LOG_ARCHIVES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxArchives) || maxArchives < 0) {
      throw new Error('maxArchives must be a non-negative safe integer');
    }
  }

  append(filePath: string, chunk: string | Uint8Array): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    if (data.length === 0) return;
    this.boundOversizedFile(filePath);

    let offset = 0;
    while (offset < data.length) {
      // Re-read rather than carrying a running total: another process may have
      // appended or rotated since the previous iteration, and a local total
      // would silently describe a file that no longer looks like that.
      let size = this.sizeOf(filePath);
      const remaining = data.length - offset;
      // Preserve ordinary log lines as one unit. Only a pathological single
      // write larger than the whole file cap is split across generations.
      const wanted = Math.min(remaining, this.maxBytes);

      if (size > 0 && size + wanted > this.maxBytes) {
        size = this.rotate(filePath, size);
      }

      const room = this.maxBytes - size;
      if (room <= 0) {
        // Another process holds the rotation lock. Spinning here would block a
        // log write indefinitely, so append the remainder in one piece and let
        // the next append (or the lock holder) restore the cap.
        fs.appendFileSync(filePath, data.subarray(offset));
        return;
      }
      const length = Math.min(room, remaining);
      fs.appendFileSync(filePath, data.subarray(offset, offset + length));
      offset += length;
    }
  }

  private sizeOf(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Upgrade safety: do not rotate a pre-cap multi-gigabyte file into an equally
   * oversized archive. Retain its newest bytes, then let the caller rotate that
   * bounded tail normally.
   *
   * Only files far past the cap are treated this way. A file a little over the
   * cap is the ordinary outcome of two processes appending at once, and
   * truncating it would discard log data that belongs in the next archive — so
   * that case is left alone and rotated intact by the caller.
   */
  private boundOversizedFile(filePath: string): void {
    const threshold = this.maxBytes * LEGACY_OVERSIZE_FACTOR;
    if (this.sizeOf(filePath) < threshold) return;

    this.withRotationLock(filePath, () => {
      const current = this.sizeOf(filePath);
      if (current < threshold) return; // another process already bounded it
      const tail = Buffer.allocUnsafe(this.maxBytes);
      const fd = fs.openSync(filePath, 'r');
      let bytesRead: number;
      try {
        bytesRead = fs.readSync(fd, tail, 0, tail.length, current - this.maxBytes);
      } finally {
        fs.closeSync(fd);
      }
      // Close the read handle before replacing the file; Windows does not
      // guarantee that a second open can truncate a file with a live handle.
      fs.writeFileSync(filePath, tail.subarray(0, bytesRead));
    });
  }

  /**
   * Rotate if the file is still at least `minSize` bytes once the lock is held.
   * Returns the authoritative post-rotation size — still large when another
   * process owns the lock, which the caller treats as "skip rotation".
   */
  private rotate(filePath: string, minSize: number): number {
    this.withRotationLock(filePath, () => {
      if (this.sizeOf(filePath) < minSize) return; // another process rotated first
      this.rotateGenerations(filePath);
    });
    return this.sizeOf(filePath);
  }

  private rotateGenerations(filePath: string): void {
    if (this.maxArchives === 0) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    }

    const oldest = `${filePath}.${this.maxArchives}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let generation = this.maxArchives - 1; generation >= 1; generation--) {
      const from = `${filePath}.${generation}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${filePath}.${generation + 1}`);
    }
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
  }

  /**
   * Run `fn` holding an exclusive `<file>.lock`. `wx` fails when the lock
   * exists, which is the whole mutual-exclusion primitive — it is a single
   * atomic syscall on every platform we ship. A lock left behind by a crashed
   * process is broken once it goes stale. Returns false when the lock could not
   * be taken, in which case `fn` never ran.
   *
   * Releasing checks that the file at the path is still the one we created.
   * Staleness is a guess: a live holder that ran long can be declared stale and
   * have its lock taken, and it must not then delete the new owner's lock on
   * the way out — that would put two processes inside the rotation at once,
   * which is the race the lock exists to prevent. (Windows may report `ino` as
   * 0 for both, in which case the check passes and behaviour is unchanged.)
   */
  private withRotationLock(filePath: string, fn: () => void): boolean {
    const lockPath = `${filePath}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs < ROTATION_LOCK_STALE_MS) return false;
        fs.unlinkSync(lockPath);
        fd = fs.openSync(lockPath, 'wx');
      } catch {
        return false;
      }
    }
    let owned: fs.Stats | null;
    try {
      owned = fs.fstatSync(fd);
    } catch {
      owned = null; // cannot identify it; fall back to unconditional release
    }
    try {
      fn();
      return true;
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try {
        const current = fs.statSync(lockPath);
        if (!owned || (current.ino === owned.ino && current.dev === owned.dev)) {
          fs.unlinkSync(lockPath);
        }
      } catch { /* already reaped */ }
    }
  }
}

export interface TeeStream {
  write(chunk: unknown, ...rest: unknown[]): boolean;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export interface ResilientTeeOptions {
  /** Stream name used in the one-line notice, e.g. `stdout`. */
  label?: string;
  /**
   * Write a diagnostic line straight to the file sink. Must not route through
   * `console.*` or the stream being teed — it is called precisely because that
   * stream just failed.
   */
  notice?: (line: string) => void;
}

/** True for host-pipe failures that must never be logged back to stdio. */
export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'EBADF';
}

/**
 * Mirror a stream to the file sink while forwarding to the original target.
 *
 * Writable pipe failures are normally delivered through an asynchronous
 * `error` event, after `write()` has returned. A synchronous try/catch and a
 * synchronous reentrancy flag cannot catch that event. Disable this one
 * pass-through target as soon as it errors; file mirroring remains available
 * and the global uncaughtException handler never receives an EPIPE to log back
 * into the same broken pipe.
 */
export function createResilientTee(
  stream: TeeStream,
  mirror: (chunk: unknown) => void,
  options: ResilientTeeOptions = {},
): (chunk: unknown, ...rest: unknown[]) => boolean {
  const orig = stream.write.bind(stream);
  const label = options.label ?? 'stream';
  let forwarding = true;
  let writing = false;

  /**
   * Any stream error makes the inherited host target unsafe to reuse, including
   * codes we have no specific handling for — narrowing the set risks a code we
   * failed to anticipate restarting the storm. Record why console output went
   * quiet, straight to the file, exactly once: without a trace, a disabled
   * pass-through is indistinguishable from a process that stopped logging.
   */
  const disable = (reason: string): void => {
    if (!forwarding) return;
    forwarding = false;
    if (!options.notice) return;
    const ts = new Date().toISOString();
    try {
      options.notice(
        `[${ts}] [warn] [logSink] ${label} pass-through disabled (${reason}) — this process now logs to file only\n`,
      );
    } catch { /* the notice is best-effort too */ }
  };

  const describe = (error: unknown): string => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code ? `code=${code}` : 'write failed';
  };

  stream.on('error', (error) => { disable(describe(error)); });

  const completeWithoutForwarding = (rest: unknown[]): true => {
    const callback = rest.length > 0 ? rest[rest.length - 1] : undefined;
    if (typeof callback === 'function') queueMicrotask(() => { callback(); });
    return true;
  };

  return (chunk: unknown, ...rest: unknown[]): boolean => {
    if (writing) return completeWithoutForwarding(rest);
    writing = true;
    try {
      try { mirror(chunk); } catch { /* file logging is best-effort */ }
      if (!forwarding) return completeWithoutForwarding(rest);
      try {
        // A write callback receives async failures before some stream
        // implementations emit `error`. Disable forwarding before invoking the
        // caller so a callback that logs the failure cannot start the loop.
        const forwardedRest = [...rest];
        const callbackIndex = forwardedRest.length - 1;
        const callback = callbackIndex >= 0 ? forwardedRest[callbackIndex] : undefined;
        if (typeof callback === 'function') {
          forwardedRest[callbackIndex] = (error?: NodeJS.ErrnoException): void => {
            if (error) disable(describe(error));
            callback(error);
          };
        }
        return orig(chunk, ...forwardedRest);
      } catch (error) {
        // Some hosts throw synchronously instead of emitting `error`.
        disable(describe(error));
        return completeWithoutForwarding(rest);
      }
    } finally {
      writing = false;
    }
  };
}
