/**
 * Persistent log sink for the daemon process.
 *
 * Why this exists: the daemon is spawned by `src/main/daemon/launcher.ts`
 * with `stdio: 'ignore'`, so every `console.log` / `console.error` and
 * every `log()` call inside the daemon vanishes into the void. That makes
 * the per-phase `[shutdown.phase]`, `[recovery]`, and PTY-spawn-retry
 * instrumentation useless: it fires but is never read.
 *
 * This sink solves that by tee-ing both `process.stdout.write` and
 * `process.stderr.write` to a daily-rotated file at
 * `~/.wmux/logs/daemon-YYYY-MM-DD.log`, capped at 16 MiB with three numbered
 * archives. After `initDaemonLogSink(baseDir)` runs, every existing console.*
 * call site is captured without rewriting them.
 *
 * This mirrors `src/main/util/logSink.ts` but has zero Electron dependency
 * — the daemon must not import `electron` (it would pull in a second copy
 * of the runtime on Windows).
 *
 * Best-effort: every write is wrapped in try/catch. The sink must never
 * crash the daemon.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BoundedLogWriter, createResilientTee, type TeeStream } from '../../shared/logTransport';

export { isBrokenPipeError } from '../../shared/logTransport';

type Level = 'info' | 'warn' | 'error';

let currentLogPath: string | null = null;
let currentDate = '';
let initialised = false;
let baseLogDir: string | null = null;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function logPath(date: string): string {
  if (!baseLogDir) throw new Error('daemon logSink not initialised');
  return path.join(baseLogDir, `daemon-${date}.log`);
}

/**
 * Resolve the current daily log file path. Lazily creates the parent
 * directory once per day-rollover. Returns null only if directory creation
 * fails (silently swallowed so logging never crashes the daemon).
 *
 * Uses `fs.appendFileSync` rather than a write stream — see
 * `src/main/util/logSink.ts` for the full rationale. Short version:
 * stream writes buffer up to 16KB and only flush on stream end. For a
 * long-lived daemon emitting small infrequent log lines that leaves the
 * file at 0 bytes on disk for the entire session, defeating the whole
 * postmortem purpose. appendFileSync writes through immediately.
 */
function resolveLogPath(): string | null {
  if (!baseLogDir) return null;
  const today = todayUtc();
  if (currentLogPath && currentDate === today) return currentLogPath;

  const filePath = logPath(today);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    return null;
  }
  currentLogPath = filePath;
  currentDate = today;
  return currentLogPath;
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
 * Append a structured log line. Goes through stderr so the tee installed
 * in `initDaemonLogSink()` mirrors it into the file. Mostly redundant
 * with the daemon's own `log()` helper, but exposed for parity with the
 * main-side sink in case future call sites want to bypass `log()`.
 */
export function logLine(level: Level, source: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${source}] ${message}\n`;
  try { process.stderr.write(line); } catch { /* ignore */ }
}

/**
 * Initialise the sink. Idempotent. Must be called early in daemon boot —
 * before any meaningful console.* output you want captured. The `baseDir`
 * is typically `wmuxDir` from `config.getWmuxDir()`; the sink writes to
 * `<baseDir>/logs/daemon-YYYY-MM-DD.log`.
 *
 * After init, any direct `process.stdout.write` / `process.stderr.write`
 * (including every console.log / console.error / console.warn) is also
 * mirrored into the log file. The existing chokepoint `log()` in
 * `src/daemon/index.ts` writes via console.log, so the in-process
 * `[recovery]`, `[shutdown.phase]`, and PTY retry lines start landing on
 * disk automatically.
 */
export function initDaemonLogSink(baseDir: string): void {
  if (initialised) return;
  initialised = true;
  baseLogDir = path.join(baseDir, 'logs');

  // Same transport as the main sink. A synchronous try/catch and a synchronous
  // reentrancy flag — what this used to have — cannot see the failure that
  // actually storms: on POSIX a broken stdio pipe is delivered as an
  // asynchronous `error` event after write() has already returned, so it
  // escapes as an uncaughtException whose handler logs it straight back onto
  // the same pipe. `createResilientTee` listens for that event and retires the
  // pass-through instead. This is the pattern that grew a main-process log file
  // to 84.9 GiB in one session.
  //
  // The daemon is normally the *less* exposed of the two: the launcher spawns
  // it with `stdio: 'ignore'`, which opens /dev/null for fds 0-2, and writes to
  // /dev/null cannot fail with EPIPE. A daemon started in the foreground (a
  // terminal, a CLI run) inherits real pipes and is exposed exactly like main.
  const wrap = (stream: NodeJS.WriteStream, label: string): void => {
    stream.write = createResilientTee(stream as unknown as TeeStream, mirrorToFile, {
      label,
      // The notice bypasses logLine()/console entirely — it exists to explain a
      // stream that just failed, so it must not be routed through that stream.
      notice: mirrorToFile,
    }) as typeof stream.write;
  };

  wrap(process.stdout, 'stdout');
  wrap(process.stderr, 'stderr');

  // Auto-prune old daily log files. Without this the logs/ directory
  // accumulates indefinitely (no rotation cap, no retention policy).
  // Best-effort + sync at startup — bounded I/O against a directory that
  // is normally <50 entries. Errors are swallowed; logging must never
  // crash the daemon.
  pruneOldLogs(LOG_RETENTION_DAYS);

  logLine(
    'info',
    'logSink',
    `daemon sink started — pid=${process.pid}, platform=${process.platform}, file=${resolveLogPath() ?? '<unresolved>'}`,
  );
}

/** Number of days to retain daily log files. Older files are deleted at
 *  daemon startup. 14 covers a typical sprint cycle plus a weekend, which
 *  is the realistic postmortem window for daemon bugs. */
const LOG_RETENTION_DAYS = 14;

function pruneOldLogs(retentionDays: number): void {
  if (!baseLogDir) return;
  try {
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(baseLogDir)) {
      if (!/^daemon-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/.test(file)) continue;
      const full = path.join(baseLogDir, file);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoffMs) {
          fs.unlinkSync(full);
        }
      } catch { /* skip file on stat/unlink failure */ }
    }
  } catch { /* dir missing — fine */ }
}
