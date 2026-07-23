// E0 harness M3 — esctest PTY adapter (spec: engine-core-decision-2026-07-09.md §5-3)
//
// Spawns esctest2 (GPL-2.0, vendor/ — unmodified execution) as a PTY child; feeds query/sequence
// bytes emitted by that process into the subject-under-test (@xterm/headless), then writes the
// subject's responses back to the PTY master. The adapter **only routes bytes** — query responses
// are produced by the subject-under-test.
//
// ── I/O model (vendor escio.py usage verified, logic not read) ────────────────────────
//   - esctest.escio.Init(): tty.setraw(stdin) — esctest stdin must be a PTY for raw setup to succeed.
//   - esctest.escio.Write(s): sys.stdout.write — queries/sequences flow to the PTY master.
//   - esctest.escio.ReadCSI/ReadOSC/ReadDCS: sys.stdin.read(1) blocking — waits for responses.
//   ⇒ Spawn python3 esctest.py via node-pty (child = PTY slave). master.onData = bytes esctest wrote
//     → feed subject. Subject responses (term.onData) → master.write = written to esctest stdin.
//
// ── Response routing rules (§5-3) ───────────────────────────────────────────────────
//   (a) xterm.js native emissions (CPR·DA·DA2·XTERM_WINOPS, etc.): term.onData callback bytes are
//       written to master **unmodified**. The adapter does not construct formats.
//   (b) DECRQCRA (xterm.js unimplemented): adapter bridge **computes checksum from subject grid
//       snapshot** and builds the DCS response. Grid is the adjudication target, so verification
//       power is preserved. Bridge usage is recorded in the report. — Checksum algorithm derived
//       from DEC STD 070 / xterm ctlseqs (vendor source checksum logic not referenced — clean-room
//       rule. See computeRectChecksum).

import { spawn, type IPty } from 'node-pty';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { existsSync } from 'node:fs';
import path from 'node:path';
// Adapter uses request parsers (tryParse*) in the routing loop; response builders/checksum
// (computeRectChecksum·buildDecrqcraReply·buildWinopsSizeReply) inside XtermBridge.
import {
  computeRectChecksum,
  buildDecrqcraReply,
  buildWinopsSizeReply,
  tryParseDecrqcra,
  tryParseWinopsSizeQuery,
  tryParseWinopsResize,
} from './decrqcra';
import type { EsctestCaseResult, EsctestReport, DecrqcraBridgeUse } from './report-types';

/**
 * Vendor path (fetch-esctest.sh clones here). Default is vendor/ beside this file, but
 * WMUX_ESCTEST_VENDOR env var can override (bundle runs, CI location customization).
 */
export const VENDOR_ROOT = process.env.WMUX_ESCTEST_VENDOR
  ? path.resolve(process.env.WMUX_ESCTEST_VENDOR)
  : path.join(__dirname, 'vendor');
export const ESCTEST_DIR = path.join(VENDOR_ROOT, 'esctest');
export const ESCTEST_ENTRY = path.join(ESCTEST_DIR, 'esctest.py');

/** Whether vendor was fetched (tests explicitly skip if absent). */
export function esctestVendorPresent(): boolean {
  return existsSync(ESCTEST_ENTRY);
}

export interface EsctestRunOptions {
  /**
   * Test selection to run. esctest matches --include=regex against full_name (e.g.
   * "CUPTests.test_CUP_...") via `re.search`. Passing a filename (e.g. 'cup') makes the adapter
   * add a case-insensitive flag ((?i)) so it matches uppercase class names (CUPTests) — esctest
   * regex is case-sensitive, so lowercase filenames would miss uppercase classes; this absorbs
   * that trap. If already starting with (?i), it is used as-is.
   */
  readonly include: string;
  /** Initial grid geometry. Most esctest cases assume 80x25. */
  readonly cols?: number;
  readonly rows?: number;
  /** Response timeout (seconds). Passed to esctest --timeout (default 1 is tight in CI → 3). */
  readonly timeoutSec?: number;
  /** VT level (DECRQCRA requires VT4). Default 4. */
  readonly maxVtLevel?: number;
  /** Overall run watchdog (ms). Guards against unresponsive deadlock. */
  readonly hardTimeoutMs?: number;
  /** python3 executable. Default 'python3'. */
  readonly python?: string;
}

/**
 * Subject-under-test bridge. Holds the xterm.js grid; when a DECRQCRA query arrives, checksum
 * is computed from a snapshot. Responses xterm.js emits itself (CPR/DA…) are not touched by
 * this class (unmodified routing).
 */
class XtermBridge {
  readonly term: Terminal;
  private readonly bridgeUses: DecrqcraBridgeUse[] = [];
  private winopsBridgeCount = 0;

  constructor(cols: number, rows: number) {
    // scrollback 0 — verify viewport state only (same policy as differ.ts).
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    // Baseline width model = Unicode 11 fixed (aligned with main renderer — same as differ.ts).
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = '11';
  }

  /** DECRQCRA bridge usage records (report field). */
  get decrqcraBridgeUses(): readonly DecrqcraBridgeUse[] {
    return this.bridgeUses;
  }

  /** WINOPS size-report bridge usage count (report field — path not captured in decision doc §5-3). */
  get winopsBridgeUses(): number {
    return this.winopsBridgeCount;
  }

  /**
   * Handle one DECRQCRA request and build response bytes. Checksum from subject grid snapshot.
   * rect(top,left,bottom,right) are 1-based screen coordinates. Pid is echoed from the request.
   */
  handleDecrqcra(pid: number, top: number, left: number, bottom: number, right: number): Uint8Array {
    const checksum = computeRectChecksum(this.term, top, left, bottom, right);
    this.bridgeUses.push({ pid, rect: { top, left, bottom, right }, checksum });
    return buildDecrqcraReply(pid, checksum);
  }

  /**
   * Respond to WINOPS size report (CSI 18 t / CSI 19 t). Path where xterm.js is silent —
   * adapter responds with current grid geometry (term.cols/rows). reportCode 8=18t, 9=19t.
   */
  handleWinopsSize(reportCode: 8 | 9): Uint8Array {
    this.winopsBridgeCount += 1;
    return buildWinopsSizeReply(reportCode, this.term.rows, this.term.cols);
  }

  /**
   * Apply WINOPS character resize (CSI 8;rows;cols t) to subject grid (review feedback —
   * without this, subsequent CSI 18 t stays at initial geometry and bridge freshness breaks).
   */
  applyWinopsResize(rows: number, cols: number): void {
    this.term.resize(cols, rows);
  }
}

/**
 * Run one esctest file (include) unmodified and collect adjudications.
 *
 * Flow:
 *  1) Spawn python3 esctest.py via node-pty (child = PTY slave). CWD = vendor esctest dir
 *     (esctest finds relative imports and tests dir from that location).
 *  2) master.onData: buffer bytes esctest wrote; intercept DECRQCRA requests and respond via
 *     bridge; feed all other bytes to subject (term). When subject emits its own responses
 *     (term.onData), write those bytes to master (unmodified).
 *  3) Wait until esctest exits (onExit) or hard timeout → exit code + stdout log parsing.
 *
 * Why intercept DECRQCRA: xterm.js does not implement DECRQCRA; feeding it to term yields no
 * response and esctest fails on timeout. Per §5-3, explicitly use "checksum-from-grid-snapshot
 * bridge" to preserve grid verification power. CPR/DA etc. are emitted by xterm.js, so not
 * intercepted.
 */
export async function runEsctestCase(opts: EsctestRunOptions): Promise<EsctestCaseResult> {
  if (!esctestVendorPresent()) {
    throw new Error(
      `[esctest-adapter] vendor missing: ${ESCTEST_ENTRY} — run bash core/harness/esctest/fetch-esctest.sh first`,
    );
  }
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 25;
  const timeoutSec = opts.timeoutSec ?? 3;
  const maxVtLevel = opts.maxVtLevel ?? 4;
  const hardTimeoutMs = opts.hardTimeoutMs ?? 30000;
  const python = opts.python ?? 'python3';

  const bridge = new XtermBridge(cols, rows);

  // esctest args (vendor README usage): --expected-terminal=xterm (session dialect),
  // --include=regex (file selection), --max-vt-level, --timeout (response wait), turn off
  // --no-print-logs (keep logs on stdout for parsing), --logfile is temporary.
  // include normalization: add (?i) so lowercase filenames match uppercase class names (CUPTests).
  // Respect if already starting with inline flags like (?i).
  const includeArg = opts.include.startsWith('(?') ? opts.include : `(?i)${opts.include}`;
  const args = [
    ESCTEST_ENTRY,
    '--expected-terminal=xterm',
    `--include=${includeArg}`,
    `--max-vt-level=${maxVtLevel}`,
    `--timeout=${timeoutSec}`,
    '--force', // Run to completion even on assertion failure (collect per-case adjudication from log).
    '--v=2',
  ];

  let child: IPty;
  try {
    child = spawn(python, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: ESCTEST_DIR,
      env: { ...process.env } as { [key: string]: string },
    });
  } catch (e) {
    throw new Error(`[esctest-adapter] python3 esctest spawn failed: ${String(e)}`);
  }

  // Write subject's native responses (CPR·DA…) back to master (unmodified routing).
  const writeBackToEsctest = (data: string): void => {
    try {
      child.write(data);
    } catch {
      /* Ignore write failure on exit race (onExit finalizes result). */
    }
  };
  bridge.term.onData(writeBackToEsctest);

  // Collect full esctest stdout (for log parsing).
  let stdoutLog = '';
  // DECRQCRA request framing may span chunk boundaries; carry unconsumed bytes forward.
  let pending = '';

  const onDataFromEsctest = (chunk: string): void => {
    stdoutLog += chunk;
    // From bytes esctest wrote, intercept DECRQCRA requests only; feed the rest to subject.
    // DECRQCRA request form: CSI Pid ; Pp ; top ; left ; bottom ; right * y
    // (tryParseDecrqcra finds complete requests in pending+chunk and reports consumed range.)
    pending += chunk;
    let feedable = '';
    let idx = 0;
    // Apply feedable to subject and clear (used to refresh grid before bridge response).
    const flushFeed = (): void => {
      if (feedable.length > 0) {
        bridge.term.write(feedable);
        feedable = '';
      }
    };
    while (idx < pending.length) {
      // ① DECRQCRA (xterm.js unimplemented — grid checksum bridge).
      const dec = tryParseDecrqcra(pending, idx);
      if (dec === 'incomplete') break; // Wait for completion — carry forward.
      if (dec !== null) {
        flushFeed(); // Refresh grid before checksum.
        const reply = bridge.handleDecrqcra(dec.pid, dec.top, dec.left, dec.bottom, dec.right);
        writeBackToEsctest(Buffer.from(reply).toString('binary'));
        idx = dec.end;
        continue;
      }
      // ② WINOPS size report (xterm.js silent — geometry bridge).
      const win = tryParseWinopsSizeQuery(pending, idx);
      if (win === 'incomplete') break; // Wait for completion — carry forward.
      if (win !== null) {
        flushFeed(); // geometry read from term.cols/rows after prior resize applied.
        const reply = bridge.handleWinopsSize(win.reportCode);
        writeBackToEsctest(Buffer.from(reply).toString('binary'));
        idx = win.end;
        continue;
      }
      // ③ WINOPS character resize (CSI 8;r;c t) — apply to subject+PTY so later size queries stay fresh
      //    (review feedback). Also feed sequence to subject (harmless — xterm.js ignores).
      const rsz = tryParseWinopsResize(pending, idx);
      if (rsz === 'incomplete') break;
      if (rsz !== null) {
        flushFeed();
        bridge.applyWinopsResize(rsz.rows, rsz.cols);
        try {
          child.resize(rsz.cols, rsz.rows);
        } catch {
          /* Ignore on exit race. */
        }
        idx = rsz.end;
        continue;
      }
      // ④ Not an intercepted query → one byte to subject.
      feedable += pending[idx];
      idx += 1;
    }
    // Carry unconsumed tail (possible start of interceptable request). Guard (review feedback):
    // if incomplete CSI grows abnormally long (4KiB, far beyond realistic CSI limit), treat as
    // not an interceptable request and force first byte to subject for re-parse — blocks infinite
    // accumulation and O(n²) re-parse blowup.
    pending = pending.slice(idx);
    while (pending.length > 4096) {
      bridge.term.write(pending[0]);
      pending = pending.slice(1);
      const again = tryParseDecrqcra(pending, 0);
      if (again !== 'incomplete') break;
    }
    flushFeed();
  };
  child.onData(onDataFromEsctest);

  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    child.onExit(({ exitCode, signal }) => resolve({ exitCode, signal }));
  });

  // Hard watchdog: guard against unresponsive deadlock. On timeout kill → grace then SIGKILL
  // escalation (review feedback — ensures return even if child ignores default signal), cap exited itself via race.
  let timedOut = false;
  let killEscalation: ReturnType<typeof setTimeout> | undefined;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      /* Ignore if already exited. */
    }
    killEscalation = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* Ignore. */
      }
    }, 2000);
  }, hardTimeoutMs);

  // Even if SIGKILL fails to produce onExit in extreme race — function always returns.
  const { exitCode, signal } = await Promise.race([
    exited,
    new Promise<{ exitCode: number; signal?: number }>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve({ exitCode: -1 });
      }, hardTimeoutMs + 5000),
    ),
  ]);
  clearTimeout(watchdog);
  if (killEscalation) clearTimeout(killEscalation);

  bridge.term.dispose();

  // Live debugging: commit artifact (report.json) omits logs (review feedback — exclude GPL-derived
  // text); dump full stdout to stderr via env when needed.
  if (process.env.WMUX_ESCTEST_DEBUG_LOG) {
    process.stderr.write(`\n===== esctest stdout (include=${opts.include}) =====\n${stdoutLog}\n`);
  }

  const cases = parseEsctestLog(stdoutLog);
  const passCount = cases.filter((c) => c.status === 'pass').length;
  const failCount = cases.filter((c) => c.status === 'fail').length;
  const errorCount = cases.filter((c) => c.status === 'error').length;
  const knownBugCount = cases.filter((c) => c.status === 'known-bug').length;
  const skippedCount = cases.filter((c) => c.status === 'skipped').length;
  // esctest's own summary line — independent cross-check for parser aggregation (review feedback).
  // Cross-check: esctest counts skips in "passed" (observed) → pass+skipped == passed.
  const esctestSummary = parseEsctestSummary(stdoutLog);
  const reconciled =
    !timedOut &&
    exitCode === 0 &&
    esctestSummary !== null &&
    passCount + skippedCount === esctestSummary.passed &&
    knownBugCount === esctestSummary.knownBugs &&
    failCount === esctestSummary.failed;
  return {
    include: opts.include,
    exitCode,
    signal,
    timedOut,
    cases,
    passCount,
    failCount,
    errorCount,
    knownBugCount,
    skippedCount,
    decrqcraBridgeUses: bridge.decrqcraBridgeUses.length,
    winopsBridgeUses: bridge.winopsBridgeUses,
    esctestSummary,
    reconciled,
    // rawLogTail removed from commit artifact (review feedback — do not put GPL-derived log text in
    // report.json). Live debugging: WMUX_ESCTEST_DEBUG_LOG=1 dumps full stdout to stderr.
  };
}

/**
 * Parse esctest final summary line: "*** N tests passed, M known bugs, K tests failed ***"
 * (vendor observed format — output usage only, GPL logic not read).
 */
export function parseEsctestSummary(
  log: string,
): { passed: number; knownBugs: number; failed: number } | null {
  const m = log.match(/\*\*\*\s*(\d+) tests passed, (\d+) known bugs?, (\d+) tests? failed\s*\*\*\*/);
  if (!m) return null;
  return { passed: Number(m[1]), knownBugs: Number(m[2]), failed: Number(m[3]) };
}

/**
 * Parse per-case adjudication from esctest stdout log. Vendor observed format (esctest.py RunTest):
 *   - Case start:  "Run test: <ClassName.test_name>"
 *   - Pass:        "Passed."
 *   - known-bug expected fail: "Fails as expected: ..."  → counted as pass (normal in esctest view)
 *   - capability skip:         "Skipped because terminal lacks requisite capability: ..."
 *   - Fail:        "*** TEST <name> FAILED:"  (traceback follows)
 * This parser uses esctest **output usage** only (GPL logic not read).
 *
 * Status priority: within a case block, first definitive signal (Passed/FAILED/Skipped/Fails as
 * expected) settles it. "Timeout waiting to read" in traceback after FAILED is failure cause for
 * that case, not a separate error (avoids double counting).
 */
export function parseEsctestLog(log: string): EsctestCaseResult['cases'] {
  const cases: { name: string; status: 'pass' | 'fail' | 'error' | 'known-bug' | 'skipped' }[] = [];
  const lines = log.split(/\r?\n/);
  const startRe = /Run test:\s*(\S+)/;
  const failRe = /\*\*\*\s*TEST\s+(\S+)\s+FAILED/;
  let currentName: string | null = null;
  let settled = false; // Whether current case received a definitive signal.

  const settle = (name: string, status: 'pass' | 'fail' | 'error' | 'known-bug' | 'skipped'): void => {
    cases.push({ name, status });
    settled = true;
  };

  for (const line of lines) {
    const start = line.match(startRe);
    if (start) {
      // If prior case advanced without signal (abnormal abort), close as error.
      if (currentName && !settled) settle(currentName, 'error');
      currentName = start[1];
      settled = false;
      continue;
    }
    const fail = line.match(failRe);
    if (fail) {
      // FAILED is a complete signal even without case start (includes name).
      settle(fail[1], 'fail');
      currentName = null;
      continue;
    }
    if (!currentName || settled) continue;
    if (/^Passed\.\s*$/.test(line)) {
      settle(currentName, 'pass');
    } else if (/^Fails as expected:/.test(line)) {
      // known-bug expected fail — normal in esctest view but counted separately from pass (review: purity audit).
      settle(currentName, 'known-bug');
    } else if (/^Skipped because terminal lacks requisite capability:/.test(line)) {
      // capability skip — not verified. Do not add to pass; separate status (review feedback).
      settle(currentName, 'skipped');
    }
  }
  // If last case ended unsettled, close as error (unresponsive deadlock, etc.).
  if (currentName && !settled) settle(currentName, 'error');
  return cases;
}

/** Bundle multiple include runs into one report (report.json output). */
export function buildReport(caseResults: readonly EsctestCaseResult[]): EsctestReport {
  const sum = (f: (c: EsctestCaseResult) => number): number =>
    caseResults.reduce((s, c) => s + f(c), 0);
  return {
    subject: 'xterm.js@6 (+Unicode11)',
    generatedAt: new Date().toISOString(),
    esctestPin: '664be3cf2c1e3f06bc93a8bafb48a0db83c607db',
    results: [...caseResults],
    totals: {
      pass: sum((c) => c.passCount),
      fail: sum((c) => c.failCount),
      error: sum((c) => c.errorCount),
      // Review feedback — purity split + surface abnormal runs so they do not leak outside totals.
      knownBug: sum((c) => c.knownBugCount),
      skipped: sum((c) => c.skippedCount),
      timedOutRuns: caseResults.filter((c) => c.timedOut).length,
      nonzeroExitRuns: caseResults.filter((c) => c.exitCode !== 0).length,
      unreconciledRuns: caseResults.filter((c) => !c.reconciled).length,
      decrqcraBridgeUses: sum((c) => c.decrqcraBridgeUses),
      winopsBridgeUses: sum((c) => c.winopsBridgeUses),
    },
  };
}
