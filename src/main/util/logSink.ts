/**
 * Persistent log sink for the main process.
 *
 * Why this exists: wmux historically wrote logs only to stderr. In packaged
 * Windows builds stderr has no parent console, so structured error traces
 * (wrapHandler IPC errors, daemon disconnects, scrollback restore failures)
 * vanished. When a user reports a bug after a reboot, there is no postmortem
 * artifact to inspect.
 *
 * This sink:
 *   - tees process.stderr.write to a daily-rotated log file in
 *     `app.getPath('logs')` (Windows: %APPDATA%\wmux\logs\main-YYYY-MM-DD.log)
 *   - caps each file at 16 MiB and keeps three numbered archives
 *   - exposes `logLine(level, source, message)` for explicit instrumentation
 *
 * Best-effort: every write is wrapped in try/catch. The sink must never
 * crash the main process.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

type Level = 'info' | 'warn' | 'error';

let currentLogPath: string | null = null;
let currentDate = '';
let initialised = false;
let logDirCreated = false;

/** Each daily file is capped at 16 MiB with three archives (64 MiB/day max). */
export const MAX_LOG_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_LOG_ARCHIVES = 3;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function logPath(date: string): string {
  return path.join(app.getPath('logs'), `main-${date}.log`);
}

/**
 * Resolve the current daily log file path. Lazily creates the parent
 * directory once. Returns null only if directory creation fails (which
 * we silently swallow so logging never crashes the main process).
 *
 * NOTE: we deliberately do NOT use fs.createWriteStream here. Stream
 * writes are buffered up to the default 16KB high-water-mark and only
 * flush to disk on stream end/drain. For a long-lived main process that
 * emits small, infrequent log lines, this leaves the file at 0 bytes on
 * disk for the entire session — defeating the whole point of a
 * postmortem log sink. fs.appendFileSync writes immediately, fsyncs,
 * and returns, so every log line is durably on disk before the call
 * returns. The synchronous cost is acceptable for diagnostic-rate
 * logging (a few writes per second at peak) and is mandatory if we
 * want the file to survive a crash that bypasses Node's stream-shutdown
 * flush.
 */
function resolveLogPath(): string | null {
  const today = todayUtc();
  if (currentLogPath && currentDate === today) return currentLogPath;

  const filePath = logPath(today);
  if (!logDirCreated || currentDate !== today) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      logDirCreated = true;
    } catch {
      return null;
    }
  }
  currentLogPath = filePath;
  currentDate = today;
  return currentLogPath;
}

/**
 * Synchronous bounded writer used by the tee. Small writes rotate as a unit so
 * normal log lines are never split. A single oversized write is chunked across
 * generations, keeping every individual file within the configured cap.
 */
export class BoundedLogWriter {
  private activePath: string | null = null;
  private activeBytes = 0;

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
    this.activate(filePath);

    // Preserve ordinary log lines as one unit. Only a pathological single
    // write larger than the whole file cap is split across generations.
    if (data.length <= this.maxBytes && this.activeBytes > 0 && this.activeBytes + data.length > this.maxBytes) {
      this.rotate(filePath);
    }

    let offset = 0;
    while (offset < data.length) {
      if (this.activeBytes >= this.maxBytes) this.rotate(filePath);
      const length = Math.min(this.maxBytes - this.activeBytes, data.length - offset);
      fs.appendFileSync(filePath, data.subarray(offset, offset + length));
      this.activeBytes += length;
      offset += length;
    }
  }

  private activate(filePath: string): void {
    if (this.activePath === filePath) return;
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      this.activePath = filePath;
      this.activeBytes = 0;
      return;
    }

    // Upgrade safety: do not rotate a legacy multi-gigabyte file into an
    // equally oversized archive. Retain its newest bytes, then let the next
    // append rotate that bounded tail normally.
    if (size > this.maxBytes) {
      const tail = Buffer.allocUnsafe(this.maxBytes);
      const fd = fs.openSync(filePath, 'r');
      let bytesRead: number;
      try {
        bytesRead = fs.readSync(fd, tail, 0, tail.length, size - this.maxBytes);
      } finally {
        fs.closeSync(fd);
      }
      // Close the read handle before replacing the file; Windows does not
      // guarantee that a second open can truncate a file with a live handle.
      fs.writeFileSync(filePath, tail.subarray(0, bytesRead));
      size = bytesRead;
    }
    this.activePath = filePath;
    this.activeBytes = size;
  }

  private rotate(filePath: string): void {
    if (this.maxArchives === 0) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      this.activeBytes = 0;
      return;
    }

    const oldest = `${filePath}.${this.maxArchives}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let generation = this.maxArchives - 1; generation >= 1; generation--) {
      const from = `${filePath}.${generation}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${filePath}.${generation + 1}`);
    }
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
    this.activeBytes = 0;
  }
}

interface TeeStream {
  write(chunk: unknown, ...rest: unknown[]): boolean;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/** True for host-pipe failures that must never be logged back to stdio. */
export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
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
): (chunk: unknown, ...rest: unknown[]) => boolean {
  const orig = stream.write.bind(stream);
  let forwarding = true;
  let writing = false;

  // Do not log from this handler: doing so would write to the failing stream.
  // Any stream error makes the inherited host target unsafe to reuse. The file
  // sink is independent and continues accepting subsequent writes.
  stream.on('error', () => { forwarding = false; });

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
            if (error) forwarding = false;
            callback(error);
          };
        }
        return orig(chunk, ...forwardedRest);
      } catch {
        // Some hosts throw synchronously instead of emitting `error`.
        forwarding = false;
        return completeWithoutForwarding(rest);
      }
    } finally {
      writing = false;
    }
  };
}

const boundedLogWriter = new BoundedLogWriter();

function mirrorToFile(chunk: unknown): void {
  const filePath = resolveLogPath();
  if (!filePath) return;
  const data = typeof chunk === 'string'
    ? chunk
    : (chunk instanceof Uint8Array ? chunk : String(chunk));
  boundedLogWriter.append(filePath, data);
}

/**
 * Append a structured log line. Writes to stderr only — the file write is
 * handled automatically by the stderr tee installed in `initLogSink()`,
 * which calls `appendFileSync` for immediate disk durability.
 */
export function logLine(level: Level, source: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${source}] ${message}\n`;
  try { process.stderr.write(line); } catch { /* ignore */ }
}

/**
 * Initialise the sink. Idempotent. Must be called after `app` is ready
 * enough to resolve `app.getPath('logs')` — i.e. after Electron has parsed
 * its userData path. Calling from inside `app.on('ready')` is always safe;
 * calling earlier works in practice because we only resolve the path on
 * first `ensureStream()`.
 *
 * After init, any direct `process.stderr.write(...)` (from wrapHandler,
 * console.error, etc.) is also mirrored into the log file, so we capture
 * pre-existing instrumentation without rewriting every call site.
 */
export function initLogSink(): void {
  if (initialised) return;
  initialised = true;

  function makeTee(stream: NodeJS.WriteStream): typeof stream.write {
    return createResilientTee(stream as unknown as TeeStream, mirrorToFile) as typeof stream.write;
  }

  // Tee BOTH stdout and stderr to the log file. Pre-this-change only
  // stderr was teed, which meant console.log() (which writes to stdout)
  // never made it to disk — invisible postmortem for the most common
  // logging call. console.warn / console.error / process.stderr.write
  // still go through stderr as before.
  process.stderr.write = makeTee(process.stderr);
  process.stdout.write = makeTee(process.stdout);

  // Auto-prune old daily log files. Bounded sync I/O at startup; errors
  // swallowed so logging can never crash the main process.
  pruneOldLogs(LOG_RETENTION_DAYS);

  logLine('info', 'logSink', `started — version=${app.getVersion()}, pid=${process.pid}, platform=${process.platform}`);
}

/** Days to retain daily log files. Older files are deleted at app
 *  startup. 14 days = typical sprint + a weekend, the realistic
 *  postmortem window for renderer/main bugs. */
const LOG_RETENTION_DAYS = 14;

function pruneOldLogs(retentionDays: number): void {
  try {
    const dir = app.getPath('logs');
    if (!fs.existsSync(dir)) return;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(dir)) {
      if (!/^main-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/.test(file)) continue;
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoffMs) {
          fs.unlinkSync(full);
        }
      } catch { /* skip file on stat/unlink failure */ }
    }
  } catch { /* swallow — never break logging */ }
}
