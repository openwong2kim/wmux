// E0 harness M3 — esctest report generator (spec: engine-core-decision-2026-07-09.md §5-3)
//
// Run representative includes through unmodified esctest, collect per-case verdicts, write report.json.
// Executable entry point for verdict collection (tests are pass-criteria gates; this produces artifacts).
//
// Usage:
//   npx tsx core/harness/esctest/gen-report.ts            # default representative set
//   INCLUDES="cup,cuf,ed" npx tsx core/harness/esctest/gen-report.ts
// Explicit error if vendor missing (fetch-esctest.sh instructions). GPL source lives only in vendor/ (gitignored).

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runEsctestCase, buildReport, esctestVendorPresent, ESCTEST_ENTRY } from './adapter';
import type { EsctestCaseResult } from './report-types';

// Representative set. **All use class-prefix anchors ((?i)^<Class>Tests\.)** — short bare names (cha·ed·hpa)
// cause esctest re.search partial matches (e.g. (?i)cha → ChangeColorTests too) and color-query suites hang.
// Anchors isolate each file precisely (spike lesson). Class names are not 1:1 with filenames
// (ed.py→EDTests, xterm_winops.py→XtermWinopsTests) — anchor vendor class names as-is.
const CLASS = (name: string): string => `(?i)^${name}Tests\\.`;
const DEFAULT_INCLUDES = [
  // CPR-based (cursor moves) — xterm.js completes by emitting CPR itself.
  CLASS('CUP'),
  CLASS('CUF'),
  CLASS('CUB'),
  CLASS('CUU'),
  CLASS('CUD'),
  CLASS('CHA'),
  CLASS('VPA'),
  CLASS('HPA'),
  // DECRQCRA-based (rect content verification) — bulk bridge round-trip proof.
  CLASS('DECCRA'),
  CLASS('DECFRA'),
  CLASS('ED'),
  CLASS('EL'),
  CLASS('ICH'),
  CLASS('DCH'),
  // Device attributes (xterm.js emits DA/DA2 itself).
  CLASS('DA'),
  CLASS('DA2'),
];

// report.json output path. Defaults beside this file; override via WMUX_ESCTEST_REPORT
// (bundle runs · CI location customize — same pattern as adapter's WMUX_ESCTEST_VENDOR).
const REPORT_PATH = process.env.WMUX_ESCTEST_REPORT
  ? path.resolve(process.env.WMUX_ESCTEST_REPORT)
  : path.join(__dirname, 'report.json');

async function main(): Promise<void> {
  if (!esctestVendorPresent()) {
    console.error(
      `[gen-report] vendor missing: ${ESCTEST_ENTRY}\n` +
        `prepare: bash core/harness/esctest/fetch-esctest.sh`,
    );
    process.exit(2);
  }
  const includes = process.env.INCLUDES
    ? process.env.INCLUDES.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_INCLUDES;

  const results: EsctestCaseResult[] = [];
  for (const inc of includes) {
    process.stdout.write(`[gen-report] running include=${inc} ... `);
    try {
      const r = await runEsctestCase({
        include: inc,
        timeoutSec: 3,
        maxVtLevel: 5,
        hardTimeoutMs: 45000,
      });
      // Zero-match guard (review feedback): anchor typo · class rename must not hide as "0 cases = quiet denominator shrink" —
      // record zero matches as synthetic error result.
      if (r.cases.length === 0) {
        results.push({ ...r, cases: [{ name: `${inc} (zero-match)`, status: 'error' }], errorCount: 1, reconciled: false });
        console.log('ZERO-MATCH (recorded as error)');
        continue;
      }
      results.push(r);
      console.log(
        `pass=${r.passCount} fail=${r.failCount} err=${r.errorCount} ` +
          `known=${r.knownBugCount} skip=${r.skippedCount} ` +
          `decrqra=${r.decrqcraBridgeUses} winops=${r.winopsBridgeUses}` +
          (r.reconciled ? '' : ' [UNRECONCILED]') +
          (r.timedOut ? ' [TIMED OUT]' : ''),
      );
    } catch (e) {
      // Record exceptions in report too (review feedback — block hole where console-only print loses totals).
      console.log(`THREW: ${String(e)}`);
      results.push({
        include: inc,
        exitCode: -1,
        timedOut: false,
        cases: [{ name: `${inc} (spawn/run threw)`, status: 'error' }],
        passCount: 0,
        failCount: 0,
        errorCount: 1,
        knownBugCount: 0,
        skippedCount: 0,
        decrqcraBridgeUses: 0,
        winopsBridgeUses: 0,
        esctestSummary: null,
        reconciled: false,
      });
    }
  }

  // Count integrity (review feedback): exactly one result per include — otherwise report itself fails.
  if (results.length !== includes.length) {
    console.error(`[gen-report] FATAL: results(${results.length}) != includes(${includes.length})`);
    process.exit(1);
  }

  const report = buildReport(results);
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n[gen-report] wrote ${REPORT_PATH}`);
  console.log(`[gen-report] totals: ${JSON.stringify(report.totals)}`);
  // Expose abnormal signals via exit code too (review feedback — block green disguise).
  const t = report.totals;
  if (t.unreconciledRuns > 0 || t.timedOutRuns > 0 || t.nonzeroExitRuns > 0) {
    console.error('[gen-report] WARNING: abnormal runs present (see totals) — exit 3');
    process.exit(3);
  }
}

main().catch((e) => {
  console.error('[gen-report] fatal:', e);
  process.exit(1);
});
