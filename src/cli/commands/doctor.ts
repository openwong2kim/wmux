/**
 * `wmux doctor [--json] [--performance]` — one-shot diagnostic for a wmux
 * install.
 *
 * Prints section-by-section health (OK / WARN / FAIL / SKIP) covering the
 * environment, daemon liveness, the boot-phase breakdown, an antivirus-tax
 * hint, and pointers to the on-disk logs. Designed to run even when the
 * daemon is dead: the environment and log sections need no RPC, so a user
 * whose app won't start still gets actionable output.
 *
 * `--performance` (P0-5c) appends a reveal-mechanism section sourced from
 * the main process's `perf.status` RPC: the last reveal event plus 5-minute
 * and since-boot per-mechanism counters aggregated from the renderer's
 * `[wmux:reveal]` diagnostics. Degrades gracefully — a dead main process or
 * a pre-P0 build (unknown method) prints an "unavailable" line instead of
 * failing the doctor run.
 *
 * Testability: `buildDoctorReport()` is a pure function over an injected
 * `DoctorDeps` bundle (RPC sender, file readers, path resolvers, env, clock).
 * The CLI entry point `handleDoctor()` wires the real implementations and
 * renders the result. Unit tests construct deps with `vi.fn` mocks and assert
 * the section verdicts without spawning a daemon or touching the real FS.
 */

import { readFileSync, readdirSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { join, dirname } from 'path';
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
import { handleDoctorDetect } from './doctorDetect';
import { newestHangDump } from '../../daemon/hangEvidence';
import {
  isAppMemoryDiagnostics, isDaemonMemoryDiagnostics,
  type AppMemoryDiagnostics, type DaemonMemoryDiagnostics,
} from '../../shared/memoryDiagnostics';
import { collectProcessMemory, renderMemoryDiagnostics } from '../memoryDiagnostics';
import { readAllTargetStatuses, type TargetRegStatus } from '../../shared/mcpRegistration';
import { NATIVE_SELF_TEST_LINE } from '../../shared/mcpLauncher';
import { fileSha256, probeKey, recordedProbe } from '../../shared/probedNative';
import { BROKER_TOOL_NAME_RE, type McpSessionsSummary } from '../../shared/mcpSessions';
import { homeRelative } from '../../shared/homeRelative';
import { EDGE_SIGNED_IN_HINT, edgeAccountSignedIn, edgeProfileDirs } from './edgeProfileSignin';
import { claudeHookRuntimeReport, defaultPaths as defaultHooksPaths, type ClaudeHookRuntimeReport } from './setupHooks';
import { claudeSelfTestLine, selfTestClaudeCopy, type ClaudeSelfTestResult } from '../../shared/hooks/claudeNativeHook';

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
    memory?: DaemonMemoryDiagnostics;
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
  /** Present when the run was given MCP deps (the CLI always is). */
  mcp?: { verdict: Verdict; lines: CheckLine[] };
  /** How the Claude hook entries run; present when the run was given it. */
  hooks?: { verdict: Verdict; lines: CheckLine[] };
}

// --- injected dependencies (the seam unit tests substitute) ------------------

export interface DaemonPingResult {
  memory?: DaemonMemoryDiagnostics;
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
  /** The newest file a stuck daemon left (src/daemon/hangWatchdog.ts), if any. */
  newestHangDump?: () => { path: string; writtenAt: number } | null;
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
  /**
   * wmux's own browser profile folders (the dedicated profile and each named
   * one), as `[name, dir]`. Each one's `Default/Preferences` is read with
   * readTextFile to tell whether Edge signed it in to an account. Absent: no check.
   */
  browserProfiles?: (env: Record<string, string | undefined>) => Array<[name: string, dir: string]>;
  /** The MCP section's inputs; the section is left out without them. */
  mcp?: McpDoctorDeps;
  /** How the Claude hook entries run (setupHooks' claudeHookRuntimeReport). */
  hooks?: () => ClaudeHookRuntimeReport;
  /** Runs the copy native entries name once (`--self-test`) against this
   *  build's line; null when that line cannot be read. Doctor alone runs it. */
  hookSelfTest?: (copy: string) => Promise<ClaudeSelfTestResult | null>;
}

export interface McpDoctorDeps {
  /** The user's home, shown as `~` so pasted output names no account. */
  home: string;
  /** Registration state per agent config, read from disk (works with the app down). */
  targets: () => TargetRegStatus[];
  /** The app's recorded self-test verdict for a native launcher's bytes. */
  recordedVerdict: (binary: string) => 'pass' | 'fail' | undefined;
  /** The main pipe's `mcp.sessions.summary`. */
  sessions: () => Promise<RpcResponse>;
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
  const mcp = deps.mcp ? await buildMcpSection(deps.mcp, appPipeReachable) : undefined;
  const hooks = deps.hooks ? await buildHooksSection(deps.hooks(), deps.hookSelfTest) : undefined;

  const overall = worst([
    environment.verdict,
    daemon.verdict,
    bootPhases.verdict,
    avHint.verdict,
    logs.verdict,
    ...(mcp ? [mcp.verdict] : []),
    ...(hooks ? [hooks.verdict] : []),
  ]);

  return { overall, environment, daemon, bootPhases, avHint, logs, ...(mcp ? { mcp } : {}), ...(hooks ? { hooks } : {}) };
}

const HOOK_RUNTIME_VERDICT: Record<ClaudeHookRuntimeReport['severity'], Verdict> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };

async function buildHooksSection(
  report: ClaudeHookRuntimeReport,
  selfTest?: (copy: string) => Promise<ClaudeSelfTestResult | null>,
): Promise<{ verdict: Verdict; lines: CheckLine[] }> {
  const lines: CheckLine[] = [{ label: 'claude hook runtime', value: report.state, verdict: HOOK_RUNTIME_VERDICT[report.severity], hint: report.detail }];
  // A recorded pass says nothing about today (a home turned noexec): run the
  // copy once, here and nowhere else.
  if (selfTest && report.copy && report.state !== 'copy-missing') lines.push(selfTestLine(await selfTest(report.copy)));
  return { verdict: worst(lines.map((l) => l.verdict)), lines };
}

const REPROBE = 'run `wmux setup-hooks --reprobe`';

function selfTestLine(result: ClaudeSelfTestResult | null): CheckLine {
  const label = 'claude hook self-test';
  if (!result) return { label, value: 'not run', verdict: 'SKIP', hint: 'no bridge could be read, beside the copy or in this build' };
  switch (result.outcome) {
    case 'pass': return { label, value: 'passed', verdict: 'OK' };
    case 'other-pin': return { label, value: 'runs, pins another bridge', verdict: 'WARN', hint: 'each run hands over to node; `wmux setup-hooks` brings the copy and the bridge in step' };
    case 'fail': return { label, value: 'failed', verdict: 'FAIL', hint: `the copy printed ${JSON.stringify(result.printed)}, not the expected line; ${REPROBE}` };
    case 'unstartable': return { label, value: 'failed', verdict: 'FAIL', hint: `the copy could not start (${result.error}); ${REPROBE}` };
    case 'timeout': return { label, value: 'no answer in 5 s', verdict: 'WARN', hint: 'a slow antivirus scan is no evidence; run `wmux doctor` again' };
  }
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

  // Shown only when a profile is signed in: profile names, never the account.
  // Every profile folder of each user-data-dir (Local State's info_cache), not only Default.
  const signedIn = (deps.browserProfiles?.(deps.env) ?? [])
    .filter(([, dir]) => edgeProfileDirs(deps.readTextFile(join(dir, 'Local State')))
      .some((folder) => edgeAccountSignedIn(deps.readTextFile(join(dir, folder, 'Preferences')))))
    .map(([name]) => name);
  if (signedIn.length > 0) {
    lines.push({
      label: 'Edge profile account',
      value: `signed in (${signedIn.join(', ')})`,
      verdict: 'WARN',
      hint: EDGE_SIGNED_IN_HINT,
    });
  }

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

  return {
    verdict: worst(lines.map((l) => l.verdict)), lines, recovery: [],
    ...(isDaemonMemoryDiagnostics(ping.memory) ? { memory: ping.memory } : {}),
  };
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

  const dump = deps.newestHangDump?.();
  if (dump) {
    lines.push({ label: 'daemon hang dump', value: `${dump.path} — ${new Date(dump.writtenAt).toISOString()}`, verdict: 'OK' });
  }

  return { verdict: worst(lines.map((l) => l.verdict)), lines };
}

// --- mcp section ----------------------------------------------------------------

function launcherKind(registered: string): 'native' | 'node-shim' | 'bundle' | 'other node script' {
  const base = registered.split(/[\\/]/).pop() ?? '';
  if (/^wmux-native(?:\.exe)?$/.test(base)) return 'native';
  if (base === 'shim.js') return 'node-shim';
  if (base === 'index.js') return 'bundle';
  return 'other node script';
}

function registeredLine(t: TargetRegStatus, deps: McpDoctorDeps, verdictOf: (binary: string) => 'pass' | 'fail' | undefined): CheckLine {
  const label = `registered (${t.id})`;
  // An agent without wmux registered is a choice, not a fault.
  if (!t.wmux.registered || !t.wmux.path) return { label, value: 'not registered', verdict: 'OK' };
  const kind = launcherKind(t.wmux.path);
  const where = kind === 'other node script' ? null : homeRelative(t.wmux.path, deps.home);
  const value = `${kind}, ${t.wmux.profile ?? 'full'}${where ? ` (${where})` : ''}`;
  if (kind === 'native' && verdictOf(t.wmux.path) === 'fail') {
    return {
      label,
      value,
      verdict: 'WARN',
      hint: 'This copy is recorded as failing its self-test; the app registers the Node launcher on its next start.',
    };
  }
  return { label, value, verdict: 'OK' };
}

function isSessionsSummary(v: unknown): v is McpSessionsSummary {
  const o = v as { broker?: Record<string, unknown>; bundle?: Record<string, unknown> } | null;
  const b = o?.broker;
  const n = o?.bundle;
  if (!b || typeof b !== 'object' || !n || typeof n !== 'object') return false;
  const nums = (rec: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof rec[k] === 'number');
  return typeof b.enabled === 'boolean' && typeof b.running === 'boolean' && typeof b.standingDown === 'boolean'
    && (b.downReason === null || typeof b.downReason === 'string')
    && nums(b, ['connections', 'crashExits', 'spawnFailures', 'standDowns'])
    && (b.pid === null || typeof b.pid === 'number')
    && (b.uptimeS === null || typeof b.uptimeS === 'number')
    && typeof n.capped === 'boolean' && nums(n, ['recent', 'ttlS']);
}

/** The tool calls the broker's last crash cut off, names only, as a hint sentence. */
function lastCrash(b: McpSessionsSummary['broker']): string | undefined {
  const names = (Array.isArray(b.lastCrashTools) ? b.lastCrashTools : [])
    .filter((n): n is string => typeof n === 'string' && BROKER_TOOL_NAME_RE.test(n));
  return names.length > 0 ? `Last crash during: ${names.join(', ')}.` : undefined;
}

/** What each kind of registered agent does while the broker is down. */
function downConsequences(kinds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (kinds.has('native')) out.push('Agents on the native launcher start the full bundle themselves meanwhile.');
  if (kinds.has('node-shim')) out.push('Agents on the Node shim cannot start a session until it runs.');
  return out;
}

/**
 * The broker line. A down broker is described only as far as its state is
 * known: a restart is promised only when one is scheduled, and a state this
 * doctor cannot name gets no hint at all.
 */
function brokerLine(b: McpSessionsSummary['broker'], kinds: ReadonlySet<string>): CheckLine {
  if (!b.enabled) return { label: 'broker', value: 'off', verdict: 'OK' };
  if (b.running) {
    return {
      label: 'broker',
      value: `running pid ${b.pid}, up ${formatUptime(b.uptimeS ?? undefined)}, connections ${b.connections}, ` +
        `crash exits ${b.crashExits}, spawn failures ${b.spawnFailures}, stand-downs ${b.standDowns}`,
      verdict: 'OK',
    };
  }
  if (b.standingDown) {
    return { label: 'broker', value: `served by another wmux instance's broker (stand-downs ${b.standDowns})`, verdict: 'OK' };
  }
  const known: Record<string, { value: string; next?: string }> = {
    restarting: {
      value: `not running: restarting after an exit (crash exits ${b.crashExits}, spawn failures ${b.spawnFailures})`,
      next: ['The app restarts it with a backoff.', lastCrash(b)].filter(Boolean).join(' '),
    },
    'crash-loop': {
      value: `not running: it kept failing (crash exits ${b.crashExits}, spawn failures ${b.spawnFailures}), off until wmux restarts`,
      next: lastCrash(b),
    },
    'script-missing': { value: 'not running: this build has no broker script', next: 'It will not start in this session.' },
    stopped: { value: 'not running: stopped by the app' },
  };
  const state = typeof b.downReason === 'string' ? known[b.downReason] : undefined;
  if (!state) return { label: 'broker', value: 'not running', verdict: 'WARN' };
  const hint = [state.next, ...downConsequences(kinds)].filter(Boolean).join(' ');
  return { label: 'broker', value: state.value, verdict: 'WARN', ...(hint ? { hint } : {}) };
}

/**
 * The self-test verdict the app recorded for the launcher at `binary`, read
 * under the key approvedInstalledNative uses: these bytes and the self-test
 * line (shared/probedNative.ts).
 */
export function recordedNativeVerdict(binary: string): 'pass' | 'fail' | undefined {
  const hash = fileSha256(binary);
  return hash ? recordedProbe(dirname(binary), probeKey(hash, NATIVE_SELF_TEST_LINE)) : undefined;
}

export async function buildMcpSection(
  deps: McpDoctorDeps,
  appPipeReachable = true,
): Promise<{ verdict: Verdict; lines: CheckLine[] }> {
  const targets = deps.targets();
  // Agents usually share one native copy: hash it once per run.
  const verdicts = new Map<string, 'pass' | 'fail' | undefined>();
  const verdictOf = (binary: string) => {
    if (!verdicts.has(binary)) verdicts.set(binary, deps.recordedVerdict(binary));
    return verdicts.get(binary);
  };
  const lines = targets.map((t) => registeredLine(t, deps, verdictOf));
  const kinds = new Set(targets.flatMap((t) => (t.wmux.registered && t.wmux.path ? [launcherKind(t.wmux.path)] : [])));
  let summary: McpSessionsSummary | null = null;
  let skipReason = 'the app is not running';
  // The probe reached the app, so a failure here is the app's answer, or its
  // silence, not its absence. Only an unknown method means an older app.
  const notAnswered = (why: string) => `the app did not answer: ${why.replace(/\s+/g, ' ').slice(0, 120)}`;
  if (appPipeReachable) {
    try {
      const resp = await deps.sessions();
      if (!resp.ok) {
        skipReason = /^Unknown method\b/.test(resp.error) ? 'this app version does not report them' : notAnswered(resp.error);
      } else if (isSessionsSummary(resp.result)) {
        summary = resp.result;
      } else {
        skipReason = 'the app answered in a shape this doctor does not read';
      }
    } catch (err) {
      skipReason = notAnswered(err instanceof Error ? err.message : String(err));
    }
  }
  if (summary) {
    lines.push(brokerLine(summary.broker, kinds));
    const minutes = Math.round(summary.bundle.ttlS / 60);
    lines.push({
      label: `bundle sessions (last ${minutes} min)`,
      value: summary.bundle.capped ? `≥${summary.bundle.recent}` : String(summary.bundle.recent),
      verdict: 'OK',
    });
  } else {
    lines.push({ label: 'live sessions', value: `unavailable (${skipReason})`, verdict: 'SKIP' });
  }
  return { verdict: worst(lines.map((l) => l.verdict)), lines };
}

// --- performance section (--performance, P0-5c) -------------------------------

/** Wire shape of the `perf.status` RPC result (src/main/pipe/handlers/perf.rpc.ts). */
export interface PerfStatusRetention {
  last: { ageMs: number; ptyId: string | null; mechanism: string } | null;
  last5m: Record<string, number>;
  sinceBoot: Record<string, number>;
}

export interface PerformanceSection {
  /** false = main unreachable or pre-P0 build (unknown method / bad shape). */
  available: boolean;
  retention?: PerfStatusRetention;
  memory?: AppMemoryDiagnostics;
}

/** Canonical render order for the reveal mechanism codes (docs/performance.md);
 *  mechanisms outside this list are appended alphabetically so a new code
 *  still shows up without a CLI update. */
export const REVEAL_MECHANISM_ORDER = [
  'retained-catchup',
  'dirty-snapshot',
  'dirty-raw-fallback',
  'resync-degraded',
  'dead-snapshot',
] as const;

/**
 * Fetch + validate the perf.status result. Every failure mode — main pipe
 * unreachable, RPC error envelope (e.g. "Unknown method: perf.status" from a
 * pre-P0 main), or an unexpected result shape — collapses to
 * `{ available: false }`; the performance section must never break doctor.
 */
export async function fetchPerformanceSection(
  send: () => Promise<RpcResponse>,
): Promise<PerformanceSection> {
  try {
    const resp = await send();
    if (!resp.ok) return { available: false };
    // Strict shape validation: `typeof null === 'object'`, so a malformed
    // payload like { last5m: null } would otherwise crash Object.keys() in
    // the renderer instead of degrading to unavailable (CodeRabbit, PR #470).
    const isCounterMap = (value: unknown): value is Record<string, number> =>
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value).every(
        (count) => typeof count === 'number' && Number.isFinite(count) && count >= 0,
      );
    const retention = (resp.result as { retention?: unknown } | null)?.retention;
    const memory = (resp.result as { memory?: unknown } | null)?.memory;
    if (
      retention !== null &&
      typeof retention === 'object' &&
      !Array.isArray(retention) &&
      isCounterMap((retention as PerfStatusRetention).last5m) &&
      isCounterMap((retention as PerfStatusRetention).sinceBoot) &&
      (() => {
        const last = (retention as PerfStatusRetention).last;
        return last === null || (typeof last === 'object' && last !== null && !Array.isArray(last));
      })()
    ) {
      return {
        available: true, retention: retention as PerfStatusRetention,
        ...(isAppMemoryDiagnostics(memory) ? { memory } : {}),
      };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

/** `mech=N mech=N ...` in canonical order, unknown mechanisms appended. */
function formatMechanismCounts(counts: Record<string, number>): string {
  const known: string[] = REVEAL_MECHANISM_ORDER.map((m) => `${m}=${counts[m] ?? 0}`);
  const extra = Object.keys(counts)
    .filter((m) => !(REVEAL_MECHANISM_ORDER as readonly string[]).includes(m))
    .sort()
    .map((m) => `${m}=${counts[m]}`);
  return [...known, ...extra].join(' ');
}

export function renderPerformanceSection(perf: PerformanceSection): string {
  const out: string[] = ['Performance (reveal mechanisms)'];
  if (!perf.available || !perf.retention) {
    out.push('  performance stats unavailable (app not running or pre-P0 build)');
    return out.join('\n');
  }
  const { last, last5m, sinceBoot } = perf.retention;
  if (last) {
    const age = Math.round(last.ageMs / 1000);
    out.push(`  last reveal: ${last.mechanism} ptyId=${last.ptyId ?? '?'} ${age}s ago`);
  } else {
    out.push('  last reveal: none since app start');
  }
  out.push(`  last 5 min:  ${formatMechanismCounts(last5m)}`);
  out.push(`  since boot:  ${formatMechanismCounts(sinceBoot)}`);
  return out.join('\n');
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
/**
 * Electron's userData for this instance: productName `wmux` plus
 * WMUX_DATA_SUFFIX, under APPDATA (Windows), Application Support (macOS) or
 * XDG_CONFIG_HOME (elsewhere). An empty variable counts as unset, as in
 * resolveMainLogPath.
 */
export function resolveUserDataDir(env: Record<string, string | undefined>, platform: string, home: string): string {
  const name = `wmux${env.WMUX_DATA_SUFFIX || ''}`;
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), name);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', name);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), name);
}

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

/**
 * wmux's browser profile folders under the app's userData (main's
 * ChromeLauncherRegistry): `chrome-agent-profile` is the default profile and
 * `chrome-profiles/<name>` the named ones.
 */
function wmuxBrowserProfiles(env: Record<string, string | undefined>): Array<[string, string]> {
  const userData = resolveUserDataDir(env, process.platform, os.homedir());
  const out: Array<[string, string]> = [['default', join(userData, 'chrome-agent-profile')]];
  try {
    for (const entry of readdirSync(join(userData, 'chrome-profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) out.push([entry.name, join(userData, 'chrome-profiles', entry.name)]);
    }
  } catch { /* no named profiles */ }
  return out;
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

  if (report.mcp) section('mcp', report.mcp.verdict, report.mcp.lines);
  if (report.hooks) section('hooks', report.hooks.verdict, report.hooks.lines);
  section('antivirus tax hint', report.avHint.verdict, report.avHint.lines);
  section('logs', report.logs.verdict, report.logs.lines);

  return out.join('\n').replace(/\n+$/, '\n');
}

// --- CLI entry point ---------------------------------------------------------

export async function handleDoctor(args: string[], jsonMode: boolean): Promise<void> {
  if (args[0] === 'detect') {
    await handleDoctorDetect(args.slice(1), jsonMode);
    return;
  }
  const performanceMode = args.includes('--performance');
  const date = todayUtc();

  // Resolve the app version: prefer a live daemon.identify-equivalent (the ping
  // does not carry version), so fall back to package.json. Cheap + offline.
  const version = getFallbackVersion();

  const deps: DoctorDeps = {
    // Direct daemon-pipe connection — `daemon.ping` lives ONLY on the daemon
    // pipe, and a direct connect lets the doctor diagnose the daemon even when
    // the main process is dead. NOT `sendRequest` (that targets the main pipe,
    // which returns "Unknown method: daemon.ping").
    ping: () => sendDaemonRequest('daemon.ping', performanceMode ? { includeMemory: true } : {}),
    // Main-pipe liveness probe — system.identify is registered on the main
    // pipe and is always permitted (null capability).
    appPipeReachable: () => sendRequest('system.identify', {}),
    version,
    platform: process.platform,
    pipeName: getPipeName(),
    authTokenPath: getAuthTokenPath(),
    mainLogPath: resolveMainLogPath(date),
    daemonLogPath: resolveDaemonLogPath(date),
    newestHangDump: () => newestHangDump(join(getWmuxHomeDir(), 'logs')),
    readTextFile: readTextFileSafe,
    tailReadTextFile: tailReadTextFileSafe,
    env: process.env,
    browserProfiles: wmuxBrowserProfiles,
    mcp: {
      home: os.homedir(),
      targets: () => readAllTargetStatuses(os.homedir()),
      recordedVerdict: recordedNativeVerdict,
      sessions: () => sendRequest('mcp.sessions.summary', {}),
    },
    hooks: () => claudeHookRuntimeReport(defaultHooksPaths()),
    // Held to the bridge beside the copy, the one its runs hand over to;
    // this build's when none is there.
    hookSelfTest: async (copy) => {
      const line = claudeSelfTestLine(join(dirname(copy), 'wmux-bridge.mjs')) ?? claudeSelfTestLine(defaultHooksPaths().bridgeSource);
      return line ? selfTestClaudeCopy(copy, line) : null;
    },
  };

  const report = await buildDoctorReport(deps);

  // --performance: query the main process for reveal-mechanism counters.
  // Rides the same main-pipe client the app-pipe probe uses; a dead main or a
  // pre-P0 build renders an "unavailable" line rather than failing doctor.
  const perf = performanceMode
    ? await fetchPerformanceSection(() => sendRequest('perf.status', { includeMemory: true }))
    : null;
  const processMemory = performanceMode ? await collectProcessMemory(perf?.memory, report.daemon.memory) : null;

  if (jsonMode) {
    const payload = perf ? { ...report, performance: { ...perf, processMemory } } : report;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderReport(report));
    if (perf) console.log(renderPerformanceSection(perf));
    if (processMemory) console.log(renderMemoryDiagnostics(perf?.memory, report.daemon.memory, processMemory));
  }

  // Exit code reflects health so scripts can gate on it. FAIL → 1; WARN/SKIP/OK
  // stay 0 (a warning is informational, not a failure of the command itself).
  if (report.overall === 'FAIL') process.exit(1);
}
