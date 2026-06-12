/**
 * `wmux doctor [--json]` — one-shot diagnostic for a wmux install.
 *
 * Prints section-by-section health (OK / WARN / FAIL / SKIP) covering the
 * environment, daemon liveness, the boot-phase breakdown, an antivirus-tax
 * hint, and pointers to the on-disk logs. Designed to run even when the
 * daemon is dead: the environment and log sections need no RPC, so a user
 * whose app won't start still gets actionable output.
 *
 * Testability: `buildDoctorReport()` is a pure function over an injected
 * `DoctorDeps` bundle (RPC sender, file readers, path resolvers, env, clock).
 * The CLI entry point `handleDoctor()` wires the real implementations and
 * renders the result. Unit tests construct deps with `vi.fn` mocks and assert
 * the section verdicts without spawning a daemon or touching the real FS.
 */

import { readFileSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { sendRequest, sendDaemonRequest } from '../client';
import {
  getPipeName,
  getAuthTokenPath,
  getWmuxHomeDir,
  dataSuffix,
} from '../../shared/constants';
import {
  span,
  parseBootSummary,
  rebaseDaemonMarks,
  MAIN_PHASES,
  DAEMON_PHASES,
  DAEMON_MARK_ORDER,
  type BootSummary,
  type PhaseDef,
} from '../../shared/bootPhases';
import type { RpcResponse } from '../../shared/rpc';

// --- public report model -----------------------------------------------------

export type Verdict = 'OK' | 'WARN' | 'FAIL' | 'SKIP';

export interface CheckLine {
  /** Short label printed left of the value, e.g. "auth token file". */
  label: string;
  /** Human value, e.g. "present" / "127ms" / "down". */
  value: string;
  /** Per-line verdict; section verdict is the worst of its lines. */
  verdict: Verdict;
  /** Optional remediation / context line printed under the value. */
  hint?: string;
}

export interface PhaseRow {
  label: string;
  ms: number | null;
  indent: 0 | 1 | 2;
}

export interface DoctorReport {
  /** Overall verdict — the worst section verdict. */
  overall: Verdict;
  environment: { verdict: Verdict; lines: CheckLine[] };
  daemon: {
    verdict: Verdict;
    lines: CheckLine[];
    /** Recovery steps, only populated when the daemon is down. */
    recovery: string[];
  };
  bootPhases: {
    verdict: Verdict;
    /** null when no summary was found (SKIP). */
    main: PhaseRow[] | null;
    /** null when the daemon is down or carried no bootTrace. */
    daemon: PhaseRow[] | null;
    /** Compact "ms since start" daemon anchor row, name=value pairs. */
    daemonAnchors: Array<{ name: string; ms: number | null }> | null;
    preJsMs: number | null;
    note?: string;
  };
  avHint: { verdict: Verdict; lines: CheckLine[] };
  logs: { verdict: Verdict; lines: CheckLine[] };
}

// --- injected dependencies (the seam unit tests substitute) ------------------

export interface DaemonPingResult {
  status?: string;
  pid?: number;
  uptime?: number;
  sessions?: number;
  eventLoopLagMs?: number;
  bootTrace?: { jsStartEpochMs: number; marks: Record<string, number> };
}

export interface DoctorDeps {
  /**
   * Resolves to the `daemon.ping` result, or rejects if the daemon is down.
   *
   * MUST connect to the DAEMON control pipe directly, not proxy through the
   * main process pipe: `daemon.ping` is only registered on the daemon pipe
   * (src/daemon/index.ts), so a main-pipe proxy always returns "Unknown
   * method" and reports a live daemon as down. A direct connect also lets the
   * doctor diagnose the daemon when the main process is dead. The real wiring
   * is `sendDaemonRequest('daemon.ping', {})` (src/cli/client.ts).
   */
  ping: () => Promise<RpcResponse>;
  /**
   * Probe the MAIN process pipe (`system.identify`) once. Resolves to the
   * raw RPC response on a reachable main process, rejects when the pipe is
   * unreachable. Lets the report distinguish "main down + daemon alive" from
   * "both down" — informational only (a dead main process is not a doctor
   * failure when the daemon answers).
   */
  appPipeReachable: () => Promise<RpcResponse>;
  /** App version (from package.json), already resolved. */
  version: string;
  platform: string;
  pipeName: string;
  authTokenPath: string;
  /** Resolved absolute path to today's main log file. */
  mainLogPath: string;
  /** Resolved absolute path to today's daemon log file. */
  daemonLogPath: string;
  /** Reads a file's full text, or returns null if it does not exist / errors. */
  readTextFile: (path: string) => string | null;
  /** Reads at most the trailing `maxBytes` of a file as UTF-8 text (or null if
   *  it does not exist / errors). Used for log files, which can grow unbounded
   *  (a log-flood incident produced a 692MB main log) — the boot summary and
   *  the recent error/warn lines live near the tail, so a bounded tail read is
   *  both sufficient and safe against OOM on a runaway log. The first returned
   *  line may be a partial fragment when the file exceeds `maxBytes`. */
  tailReadTextFile: (path: string, maxBytes: number) => string | null;
  /** Process env snapshot — only WMUX_DATA_SUFFIX is consulted today. */
  env: Record<string, string | undefined>;
}

// --- thresholds (single source so tests assert the exact boundary) -----------

/** daemon.ping eventLoopLagMs above this → WARN (busy/contended event loop). */
export const EVENT_LOOP_LAG_WARN_MS = 100;
/** A single daemon-boot phase above this → AV-tax hint (cold image rescan). */
export const AV_TAX_PHASE_WARN_MS = 1500;
/** Bytes of trailing log to read for the boot-summary + error/warn scan. The
 *  `[boot-trace] summary=` line is emitted at ready-end (near the file tail),
 *  and error/warn counts only need recency, so 256KB is ample while capping
 *  memory against a runaway log (cf. the 692MB log-flood incident). */
export const MAIN_LOG_TAIL_BYTES = 256 * 1024;

// --- verdict algebra ---------------------------------------------------------

const RANK: Record<Verdict, number> = { OK: 0, SKIP: 1, WARN: 2, FAIL: 3 };

/** Worst verdict wins. SKIP is "absent, not broken" — ranks below WARN/FAIL
 *  but above OK so a section that is entirely skipped surfaces as SKIP, while
 *  a section mixing OK + SKIP stays OK. */
export function worst(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return 'OK';
  return verdicts.reduce((acc, v) => (RANK[v] > RANK[acc] ? v : acc), 'OK' as Verdict);
}

// --- report builder (pure) ---------------------------------------------------

export async function buildDoctorReport(deps: DoctorDeps): Promise<DoctorReport> {
  // Probe the main process pipe once (system.identify). This is independent of
  // the daemon ping below — the two are SEPARATE servers — so a dead main
  // process is reported as an informational WARN without masking a live daemon.
  let appPipeReachable = false;
  try {
    const resp = await deps.appPipeReachable();
    appPipeReachable = resp.ok;
  } catch {
    appPipeReachable = false;
  }

  const environment = buildEnvironment(deps, appPipeReachable);

  // Ping the daemon once; reuse the result for the daemon + boot-phase sections.
  let ping: DaemonPingResult | null = null;
  let pingError: string | null = null;
  try {
    const resp = await deps.ping();
    if (resp.ok) {
      ping = resp.result as DaemonPingResult;
    } else {
      pingError = resp.error;
    }
  } catch (err) {
    pingError = err instanceof Error ? err.message : String(err);
  }

  const daemon = buildDaemon(ping, pingError);
  const bootPhases = buildBootPhases(deps, ping);
  const avHint = buildAvHint(bootPhases);
  const logs = buildLogs(deps);

  const overall = worst([
    environment.verdict,
    daemon.verdict,
    bootPhases.verdict,
    avHint.verdict,
    logs.verdict,
  ]);

  return { overall, environment, daemon, bootPhases, avHint, logs };
}

function buildEnvironment(
  deps: DoctorDeps,
  appPipeReachable: boolean,
): DoctorReport['environment'] {
  const lines: CheckLine[] = [];

  lines.push({ label: 'app version', value: deps.version, verdict: 'OK' });
  lines.push({ label: 'platform', value: deps.platform, verdict: 'OK' });
  lines.push({ label: 'control pipe', value: deps.pipeName, verdict: 'OK' });

  // Liveness of the MAIN process pipe, separate from the daemon. A reachable
  // app pipe is OK; an unreachable one is an informational WARN, not a FAIL —
  // the daemon section below carries the real health gate, and the daemon can
  // be alive while the app window is closed (or vice versa). This line is what
  // lets a user tell "app down, daemon up" apart from "everything down".
  lines.push({
    label: 'app (main process) pipe reachable',
    value: appPipeReachable ? 'yes' : 'no',
    verdict: appPipeReachable ? 'OK' : 'WARN',
    hint: appPipeReachable
      ? undefined
      : 'The wmux app (main process) is not answering on its control pipe — it may be closed. ' +
        'The daemon is diagnosed independently below.',
  });

  const tokenPresent = deps.readTextFile(deps.authTokenPath) !== null;
  lines.push({
    label: 'auth token file',
    value: tokenPresent ? `present (${deps.authTokenPath})` : 'missing',
    // Absent token is expected when the app has never run; not a hard failure
    // because the daemon section reports the actual connection result.
    verdict: tokenPresent ? 'OK' : 'WARN',
    hint: tokenPresent
      ? undefined
      : 'No auth token on disk — wmux has not run yet, or its state dir was cleared.',
  });

  const suffix = deps.env.WMUX_DATA_SUFFIX;
  lines.push({
    label: 'WMUX_DATA_SUFFIX',
    value: suffix ? suffix : '(unset — packaged default)',
    verdict: 'OK',
    hint: suffix
      ? 'Instance-isolation suffix is set; this is a dev/isolated build, not the packaged install.'
      : undefined,
  });

  return { verdict: worst(lines.map((l) => l.verdict)), lines };
}

function buildDaemon(
  ping: DaemonPingResult | null,
  pingError: string | null,
): DoctorReport['daemon'] {
  if (!ping) {
    const lines: CheckLine[] = [
      {
        label: 'daemon',
        value: 'down',
        verdict: 'FAIL',
        hint: pingError ?? 'daemon.ping did not return a result',
      },
    ];
    return {
      verdict: 'FAIL',
      lines,
      recovery: [
        'Start (or restart) the wmux app — the daemon is spawned on launch.',
        'If the app is already running, fully quit it (tray → Shut down wmux) and relaunch.',
        'Check the daemon log (see the logs section below) for a spawn/lock error.',
        'If a stale lock is suspected, removing ~/.wmux*/daemon.lock and relaunching is safe — live sessions are re-recovered.',
      ],
    };
  }

  const lines: CheckLine[] = [];
  lines.push({
    label: 'daemon',
    value: `up (pid ${ping.pid ?? '?'})`,
    verdict: 'OK',
  });
  lines.push({
    label: 'uptime',
    value: formatUptime(ping.uptime),
    verdict: 'OK',
  });
  lines.push({
    label: 'sessions',
    value: String(ping.sessions ?? 0),
    verdict: 'OK',
  });

  const lag = ping.eventLoopLagMs;
  if (typeof lag === 'number') {
    const lagWarn = lag > EVENT_LOOP_LAG_WARN_MS;
    lines.push({
      label: 'event-loop lag',
      value: `${lag}ms`,
      verdict: lagWarn ? 'WARN' : 'OK',
      hint: lagWarn
        ? `Lag exceeds ${EVENT_LOOP_LAG_WARN_MS}ms — the daemon event loop is contended (heavy I/O, many sessions, or CPU pressure).`
        : undefined,
    });
  }

  return { verdict: worst(lines.map((l) => l.verdict)), lines, recovery: [] };
}

function buildBootPhases(
  deps: DoctorDeps,
  ping: DaemonPingResult | null,
): DoctorReport['bootPhases'] {
  // --- main process: parse the last summary line from today's main log ---
  // Tail-read only the trailing window: the summary line is emitted at
  // ready-end so it lives near the file end, and bounding the read protects
  // against a runaway log. parseBootSummary already tolerates a truncated
  // leading line (JSON.parse failure on a partial fragment → skip).
  const mainLogText = deps.tailReadTextFile(deps.mainLogPath, MAIN_LOG_TAIL_BYTES);
  const summary: BootSummary | null = mainLogText ? parseBootSummary(mainLogText) : null;

  let main: PhaseRow[] | null = null;
  let preJsMs: number | null = null;
  if (summary) {
    main = phaseRows(MAIN_PHASES, summary.marks);
    preJsMs = summary.preJsMs;
  }

  // --- daemon: rebase ping bootTrace marks, build the same phase table ---
  let daemonRows: PhaseRow[] | null = null;
  let daemonAnchors: Array<{ name: string; ms: number | null }> | null = null;
  if (ping?.bootTrace?.marks && typeof ping.bootTrace.jsStartEpochMs === 'number') {
    const rebased = rebaseDaemonMarks(ping.bootTrace.marks, ping.bootTrace.jsStartEpochMs);
    daemonRows = phaseRows(DAEMON_PHASES, rebased);
    daemonAnchors = DAEMON_MARK_ORDER.map((name) => ({
      name,
      ms: typeof rebased[name] === 'number' ? rebased[name] : null,
    }));
  }

  // SKIP (not FAIL) when we have nothing to show — a missing summary means the
  // app predates the instrumentation or never reached emitBootSummary, which
  // is informational, not a defect.
  const verdict: Verdict = main === null && daemonRows === null ? 'SKIP' : 'OK';
  const note =
    main === null
      ? 'No [boot-trace] summary in today\'s main log — boot-phase table for the main process is unavailable.'
      : undefined;

  return { verdict, main, daemon: daemonRows, daemonAnchors, preJsMs, note };
}

function buildAvHint(bootPhases: DoctorReport['bootPhases']): DoctorReport['avHint'] {
  // The AV tax concentrates in the cold image-scan phases: pre-JS, module
  // imports/eval, and (for the daemon) the spawn→pipe-file span. We look for
  // any single daemon-boot phase that blew past the threshold.
  const candidates: Array<{ label: string; ms: number | null }> = [];
  if (bootPhases.preJsMs != null) candidates.push({ label: 'pre-JS', ms: bootPhases.preJsMs });
  for (const row of bootPhases.main ?? []) {
    if (row.label === 'daemon boot' || row.label === 'module imports') {
      candidates.push({ label: row.label, ms: row.ms });
    }
  }

  const hot = candidates.filter((c) => c.ms != null && c.ms > AV_TAX_PHASE_WARN_MS);

  if (hot.length === 0) {
    return {
      verdict: 'OK',
      lines: [
        {
          label: 'antivirus tax',
          value: 'no abnormal boot phases',
          verdict: 'OK',
        },
      ],
    };
  }

  const worstPhase = hot.reduce((a, b) => ((b.ms ?? 0) > (a.ms ?? 0) ? b : a));
  return {
    verdict: 'WARN',
    lines: [
      {
        label: 'antivirus tax',
        value: `${worstPhase.label} = ${worstPhase.ms}ms (> ${AV_TAX_PHASE_WARN_MS}ms)`,
        verdict: 'WARN',
        hint:
          'A boot phase dominated by cold image scanning suggests Windows Defender real-time ' +
          'scanning is taxing startup. For a one-off LOCAL diagnosis you can temporarily add a ' +
          'Defender exclusion for the install dir, re-measure, then remove it. See ' +
          'bench/README.md → "Antivirus tax on cold start". Never ship or automate exclusions.',
      },
    ],
  };
}

function buildLogs(deps: DoctorDeps): DoctorReport['logs'] {
  const lines: CheckLine[] = [];

  for (const [label, path] of [
    ['main log', deps.mainLogPath],
    ['daemon log', deps.daemonLogPath],
  ] as const) {
    // Tail-read: the error/warn count only needs recent lines, and a bounded
    // read guards against a runaway log (cf. the 692MB log-flood incident).
    const text = deps.tailReadTextFile(path, MAIN_LOG_TAIL_BYTES);
    if (text === null) {
      lines.push({
        label,
        value: `${path} (not found)`,
        verdict: 'SKIP',
      });
      continue;
    }
    const { errors, warns } = countErrorWarn(text);
    lines.push({
      label,
      value: `${path} — ${errors} error / ${warns} warn`,
      verdict: errors > 0 ? 'WARN' : 'OK',
      hint: errors > 0 ? `${errors} error line(s) in today's log — inspect the tail for the cause.` : undefined,
    });
  }

  return { verdict: worst(lines.map((l) => l.verdict)), lines };
}

// --- helpers -----------------------------------------------------------------

function phaseRows(defs: readonly PhaseDef[], marks: Record<string, number>): PhaseRow[] {
  return defs.map((d) => ({ label: d.label, ms: span(marks, d.from, d.to), indent: d.indent }));
}

/** Count `[error]` / `[warn]` level lines across BOTH log line formats:
 *   - main logSink:  `[<iso>] [<level>] [<source>] <message>`  → `[error]`
 *   - daemon logger: `[<iso>] [daemon/<level>] <message>`      → `[daemon/error]`
 *     (see src/daemon/index.ts `log()` — `[${ts}] [daemon/${level}] ${msg}`).
 *  The level token may carry an optional `<source>/` prefix; we match the level
 *  word as the final segment inside the bracket. Case-insensitive on the level. */
export function countErrorWarn(text: string): { errors: number; warns: number } {
  let errors = 0;
  let warns = 0;
  for (const line of text.split('\n')) {
    if (/\[(?:[^\][/]*\/)?error\]/i.test(line)) errors++;
    else if (/\[(?:[^\][/]*\/)?warn(?:ing)?\]/i.test(line)) warns++;
  }
  return { errors, warns };
}

function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'unknown';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// --- path resolution (real deps) ---------------------------------------------

function getFallbackVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Resolve today's main-process log file path WITHOUT Electron (`app` is not
 * available in the CLI process). Mirrors `app.getPath('logs')`:
 *   - Windows: %APPDATA%\<appName><suffix>\logs\main-YYYY-MM-DD.log
 *     (logs default to userData/logs, and userData = APPDATA\appName; the
 *     WMUX_DATA_SUFFIX isolation appends the suffix to userData — see
 *     src/main/index.ts setPath('userData')).
 *   - macOS:   ~/Library/Logs/<appName>/main-YYYY-MM-DD.log
 *   - Linux:   ~/.config/<appName><suffix>/logs/main-YYYY-MM-DD.log
 * The Windows path is the dogfood-verified one; the others are best-effort.
 */
export function resolveMainLogPath(date: string): string {
  const appName = 'wmux';
  const suffix = dataSuffix();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
    return join(appData, `${appName}${suffix}`, 'logs', `main-${date}.log`);
  }
  if (process.platform === 'darwin') {
    // macOS derives the logs path from the app name, not userData, so the
    // suffix does not apply here.
    return join(os.homedir(), 'Library', 'Logs', appName, `main-${date}.log`);
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config');
  return join(configHome, `${appName}${suffix}`, 'logs', `main-${date}.log`);
}

/** Today's daemon log file: <wmuxHome>/logs/daemon-YYYY-MM-DD.log.
 *  The daemon writes to `getWmuxDir()/logs` (= ~/.wmux<suffix>/logs), which
 *  `getWmuxHomeDir()` resolves identically. */
export function resolveDaemonLogPath(date: string): string {
  return join(getWmuxHomeDir(), 'logs', `daemon-${date}.log`);
}

/** UTC date in YYYY-MM-DD — matches logSink's `todayUtc()`. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function readTextFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read at most the trailing `maxBytes` of a file as UTF-8 text, without
 * loading the whole file. Returns null if the file is absent / unreadable.
 *
 * Reads from `max(0, size - maxBytes)` to EOF so a multi-hundred-MB runaway
 * log never lands fully in memory (the 692MB log-flood incident). When the
 * file exceeds the window, the first decoded line is a partial fragment — that
 * is acceptable for both consumers: `parseBootSummary` skips lines whose JSON
 * fails to parse, and the error/warn scanner only over/under-counts a single
 * boundary line at worst.
 */
function tailReadTextFileSafe(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const readLen = Math.min(size, Math.max(0, maxBytes));
    if (readLen === 0) return '';
    const start = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    let got = 0;
    while (got < readLen) {
      const n = readSync(fd, buf, got, readLen - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.toString('utf-8', 0, got);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

// --- rendering ---------------------------------------------------------------

const VERDICT_TAG: Record<Verdict, string> = {
  OK: '[ OK ]',
  WARN: '[WARN]',
  FAIL: '[FAIL]',
  SKIP: '[SKIP]',
};

function fmtMs(ms: number | null): string {
  return ms == null ? 'n/a' : `${ms}ms`;
}

export function renderReport(report: DoctorReport): string {
  const out: string[] = [];
  out.push(`wmux doctor — overall ${VERDICT_TAG[report.overall]}`);
  out.push('');

  const section = (title: string, verdict: Verdict, lines: CheckLine[]) => {
    out.push(`${VERDICT_TAG[verdict]} ${title}`);
    for (const l of lines) {
      out.push(`  ${VERDICT_TAG[l.verdict]} ${l.label}: ${l.value}`);
      if (l.hint) out.push(`         ${l.hint}`);
    }
    out.push('');
  };

  section('environment', report.environment.verdict, report.environment.lines);

  section('daemon', report.daemon.verdict, report.daemon.lines);
  if (report.daemon.recovery.length > 0) {
    out.push('  recovery:');
    for (const step of report.daemon.recovery) out.push(`    - ${step}`);
    out.push('');
  }

  // boot phases
  out.push(`${VERDICT_TAG[report.bootPhases.verdict]} boot phases`);
  if (report.bootPhases.note) out.push(`  ${report.bootPhases.note}`);
  if (report.bootPhases.preJsMs != null) {
    out.push(`  pre-JS (spawn→js-start)                ${fmtMs(report.bootPhases.preJsMs)}`);
  }
  if (report.bootPhases.main) {
    out.push('  main process:');
    for (const row of report.bootPhases.main) {
      const pad = '  '.repeat(row.indent + 1);
      out.push(`${pad}${row.label.padEnd(34 - row.indent * 2)} ${fmtMs(row.ms)}`);
    }
  }
  if (report.bootPhases.daemonAnchors) {
    out.push('  daemon (ms since start): ' +
      report.bootPhases.daemonAnchors.map((a) => `${a.name}=${a.ms == null ? 'n/a' : a.ms}`).join(' '));
  }
  if (report.bootPhases.daemon) {
    for (const row of report.bootPhases.daemon) {
      const pad = '  '.repeat(row.indent + 1);
      out.push(`${pad}${row.label.padEnd(34 - row.indent * 2)} ${fmtMs(row.ms)}`);
    }
  }
  out.push('');

  section('antivirus tax hint', report.avHint.verdict, report.avHint.lines);
  section('logs', report.logs.verdict, report.logs.lines);

  return out.join('\n').replace(/\n+$/, '\n');
}

// --- CLI entry point ---------------------------------------------------------

export async function handleDoctor(_args: string[], jsonMode: boolean): Promise<void> {
  const date = todayUtc();

  // Resolve the app version: prefer a live daemon.identify-equivalent (the ping
  // does not carry version), so fall back to package.json. Cheap + offline.
  const version = getFallbackVersion();

  const deps: DoctorDeps = {
    // Direct daemon-pipe connection — `daemon.ping` lives ONLY on the daemon
    // pipe, and a direct connect lets the doctor diagnose the daemon even when
    // the main process is dead. NOT `sendRequest` (that targets the main pipe,
    // which returns "Unknown method: daemon.ping").
    ping: () => sendDaemonRequest('daemon.ping', {}),
    // Main-pipe liveness probe — system.identify is registered on the main
    // pipe and is always permitted (null capability).
    appPipeReachable: () => sendRequest('system.identify', {}),
    version,
    platform: process.platform,
    pipeName: getPipeName(),
    authTokenPath: getAuthTokenPath(),
    mainLogPath: resolveMainLogPath(date),
    daemonLogPath: resolveDaemonLogPath(date),
    readTextFile: readTextFileSafe,
    tailReadTextFile: tailReadTextFileSafe,
    env: process.env,
  };

  const report = await buildDoctorReport(deps);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }

  // Exit code reflects health so scripts can gate on it. FAIL → 1; WARN/SKIP/OK
  // stay 0 (a warning is informational, not a failure of the command itself).
  if (report.overall === 'FAIL') process.exit(1);
}
