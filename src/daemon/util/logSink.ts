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
 * `~/.wmux/logs/daemon-YYYY-MM-DD.log`. After `initDaemonLogSink(baseDir)`
 * runs, every existing console.* call site is captured without rewriting
 * them.
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

  const wrap = (
    stream: NodeJS.WriteStream,
  ): void => {
    const orig = stream.write.bind(stream);

    // Reentrancy guard. Without this, an EPIPE thrown by `orig()` below
    // becomes an `uncaughtException`, the registered handler logs via
    // console.error, which routes back through *this* override — and
    // EPIPE re-throws on the same broken pipe. Same incident pattern as
    // main/logSink.ts (which grew a log file to 692 MB in ~17 min). The
    // daemon is even more exposed because it always runs with detached
    // / 'ignore' stdio from the launcher, so its inherited stdout/stderr
    // are guaranteed-closed pipes from the OS's point of view.
    let writing = false;

    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (writing) {
        // Recursive entry — drop silently. The outer call already wrote
        // the original chunk to the file and is mid-orig() pass-through.
        return true;
      }
      writing = true;
      try {
        try {
          const filePath = resolveLogPath();
          if (filePath) {
            const str = typeof chunk === 'string'
              ? chunk
              : (chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf-8') : String(chunk));
            fs.appendFileSync(filePath, str);
          }
        } catch { /* swallow — never break logging */ }

        // Pass through to the original stream. Wrapped in its own
        // try/catch because the daemon's inherited stdout/stderr from
        // a `stdio: 'ignore'` spawn is a closed handle — orig() then
        // throws EPIPE, which becomes uncaughtException without this.
        try {
          // @ts-expect-error - spread re-applies original signature
          return orig(chunk, ...rest);
        } catch {
          return true;
        }
      } finally {
        writing = false;
      }
    }) as typeof stream.write;
  };

  wrap(process.stdout);
  wrap(process.stderr);

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
      if (!/^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
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
