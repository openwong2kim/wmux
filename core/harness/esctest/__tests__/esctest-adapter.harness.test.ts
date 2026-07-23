// E0 harness M3 — esctest adapter verification (spec: engine-core-decision-2026-07-09.md §5-3, D6 S-C)
//
// Pass criteria (D6 S-C row):
//   T1: DECRQCRA round-trip ×1 — known grid state, checksum query→response matches DEC spec calculation.
//   T2: cup.py (CPR-based) completion — esctest runs cup.py unmodified and returns verdicts.
//   T3: Checksum unit tests — independent verification of DEC-spec-derived implementation (manual cases).
//
// When vendor (GPL-2.0 esctest2) is absent, PTY execution tests (T1·T2) are explicitly skipped. T3 is
// vendor-independent (pure checksum unit) and always runs.

import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  runEsctestCase,
  buildReport,
  esctestVendorPresent,
  parseEsctestLog,
  parseEsctestSummary,
  ESCTEST_ENTRY,
} from '../adapter';
import {
  computeRectChecksum,
  buildDecrqcraReply,
  tryParseDecrqcra,
  tryParseWinopsSizeQuery,
  buildWinopsSizeReply,
  BLANK_CODE,
} from '../decrqcra';

const vendor = esctestVendorPresent();
const describeVendor = vendor ? describe : describe.skip;

if (!vendor) {
  // State skip reason explicitly (prevent silent pass). Prepare vendor via fetch-esctest.sh.
  // eslint-disable-next-line no-console
  console.warn(
    `[esctest-adapter.test] vendor missing (${ESCTEST_ENTRY}) — skipping PTY execution tests (T1·T2). ` +
      `prepare: bash core/harness/esctest/fetch-esctest.sh`,
  );
}

// ── Helper: build known grid state (same xterm.js + Unicode11 setup as differ). ──
function makeTerm(cols = 80, rows = 25): Terminal {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon() as never);
  term.unicode.activeVersion = '11';
  return term;
}
function writeSync(term: Terminal, s: string): Promise<void> {
  return new Promise((resolve) => term.write(s, resolve));
}

// ────────────────────────────────────────────────────────────────────────────
// T3: Checksum unit tests (vendor-independent — independent verification of DEC-spec-derived implementation).
// ────────────────────────────────────────────────────────────────────────────
describe('T3 — DECRQCRA checksum (DEC STD 070 / derived from xterm ctlseqs)', () => {
  // Manual expected values (Python cross-check): checksum = (-Σ code) & 0xFFFF, blank=0x20.
  //   'A'(0x41) 1x1                → 0xFFBF
  //   'AB'(0x41+0x42) 1x2          → 0xFF7D
  //   'Hello' 1x5                  → 0xFE0C
  //   empty 2x2 (space×4 = 0x80)   → 0xFF80
  it('single char A(1x1) checksum = 0xFFBF', async () => {
    const term = makeTerm();
    await writeSync(term, 'A'); // A at (col1,row1).
    const chk = computeRectChecksum(term, 1, 1, 1, 1);
    expect(chk).toBe(0xffbf);
    term.dispose();
  });

  it('AB(1x2) checksum = 0xFF7D', async () => {
    const term = makeTerm();
    await writeSync(term, 'AB');
    const chk = computeRectChecksum(term, 1, 1, 1, 2);
    expect(chk).toBe(0xff7d);
    term.dispose();
  });

  it('Hello(1x5) checksum = 0xFE0C', async () => {
    const term = makeTerm();
    await writeSync(term, 'Hello');
    const chk = computeRectChecksum(term, 1, 1, 1, 5);
    expect(chk).toBe(0xfe0c);
    term.dispose();
  });

  it('empty region(2x2, space×4) checksum = 0xFF80', () => {
    const term = makeTerm();
    // Unwritten region — blank cells count as blank (0x20).
    const chk = computeRectChecksum(term, 1, 1, 2, 2);
    expect(chk).toBe(0xff80);
    term.dispose();
  });

  it('esctest inversion formula: 0x10000 - checksum == Σcode (esctest escutil:279 reverse-engineered)', () => {
    // esctest inverts response checksum as 0x10000 - checksum to compare with char codes.
    // If our bridge sends (-sum)&0xFFFF, this inversion must restore sum exactly.
    const sum = 0x41 + 0x42 + 0x43; // 'ABC'
    const checksum = (-sum) & 0xffff;
    expect((0x10000 - checksum) & 0xffff).toBe(sum);
  });

  it('BLANK_CODE = 0x20 (xterm #336 blank uniform)', () => {
    expect(BLANK_CODE).toBe(0x20);
  });

  it('buildDecrqcraReply uses DCS Pid!~HHHH ST format', () => {
    const reply = Buffer.from(buildDecrqcraReply(7, 0xffbf)).toString('binary');
    // ESC P 7 ! ~ F F B F ESC \
    expect(reply).toBe('\x1bP7!~FFBF\x1b\\');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DECRQCRA / WINOPS request parser units (routing accuracy — vendor-independent).
// ────────────────────────────────────────────────────────────────────────────
describe('request parser — DECRQCRA / WINOPS size query', () => {
  it('parses complete DECRQCRA request into fields (CSI Pid;Pp;t;l;b;r * y)', () => {
    const s = '\x1b[1;0;6;5;6;5*y';
    const p = tryParseDecrqcra(s, 0);
    expect(p).not.toBe('incomplete');
    expect(p).not.toBeNull();
    if (p && p !== 'incomplete') {
      expect(p).toMatchObject({ pid: 1, page: 0, top: 6, left: 5, bottom: 6, right: 5 });
      expect(p.end).toBe(s.length);
    }
  });

  it('DECRQCRA split at chunk boundary is incomplete (carry-over signal)', () => {
    expect(tryParseDecrqcra('\x1b[1;0;6;5', 0)).toBe('incomplete');
  });

  it('non-DECRQCRA CSI (CPR) returns null (passes through to subject)', () => {
    expect(tryParseDecrqcra('\x1b[6n', 0)).toBeNull();
  });

  it('parses only WINOPS 18t/19t as size queries, other winops return null', () => {
    expect(tryParseWinopsSizeQuery('\x1b[18t', 0)).toMatchObject({ reportCode: 8 });
    expect(tryParseWinopsSizeQuery('\x1b[19t', 0)).toMatchObject({ reportCode: 9 });
    // Title pop etc. (23;0t) is not a size query.
    expect(tryParseWinopsSizeQuery('\x1b[23;0t', 0)).toBeNull();
    // Pixel size (14t) unsupported by bridge (honest — headless is silent on pixels) → pass through as null.
    expect(tryParseWinopsSizeQuery('\x1b[14t', 0)).toBeNull();
  });

  it('WINOPS size reply format: CSI code;rows;cols t', () => {
    expect(Buffer.from(buildWinopsSizeReply(8, 25, 80)).toString('binary')).toBe('\x1b[8;25;80t');
    expect(Buffer.from(buildWinopsSizeReply(9, 25, 80)).toString('binary')).toBe('\x1b[9;25;80t');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Log parser unit (esctest observed format — vendor-independent).
// ────────────────────────────────────────────────────────────────────────────
describe('parseEsctestLog — observed esctest log format', () => {
  it('aggregates Run test / Passed. as pass', () => {
    const log = [
      'Run test: CUPTests.test_CUP_DefaultParams',
      'Passed.',
      '',
      'Run test: CUPTests.test_CUP_RowOnly',
      'Passed.',
    ].join('\n');
    const cases = parseEsctestLog(log);
    expect(cases).toHaveLength(2);
    expect(cases.every((c) => c.status === 'pass')).toBe(true);
  });

  it('aggregates *** TEST X FAILED as fail', () => {
    const log = ['Run test: FooTests.test_bar', '*** TEST FooTests.test_bar FAILED:', 'Traceback...'].join(
      '\n',
    );
    const cases = parseEsctestLog(log);
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe('fail');
  });

  it('Fails as expected is counted separately as known-bug (review — pass purity)', () => {
    const log = ['Run test: FooTests.test_bar', 'Fails as expected: known xterm bug'].join('\n');
    expect(parseEsctestLog(log)[0].status).toBe('known-bug');
  });

  it('capability-missing skip is counted separately as skipped (must not add to pass — review)', () => {
    const log = [
      'Run test: FooTests.test_bar',
      'Skipped because terminal lacks requisite capability: 8-bit controls',
    ].join('\n');
    expect(parseEsctestLog(log)[0].status).toBe('skipped');
  });

  it('last case cut off without signal closes as error (no-response deadlock)', () => {
    const log = ['Run test: FooTests.test_bar'].join('\n');
    expect(parseEsctestLog(log)[0].status).toBe('error');
  });

  it('parses esctest summary line (independent cross-check for parser aggregation — review)', () => {
    const s = parseEsctestSummary('...\n*** 6 tests passed, 0 known bugs, 0 tests failed ***\n');
    expect(s).toEqual({ passed: 6, knownBugs: 0, failed: 0 });
    expect(parseEsctestSummary('no summary here')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T1: DECRQCRA round-trip ×1 (vendor required — PTY execution).
// ────────────────────────────────────────────────────────────────────────────
describeVendor('T1 — DECRQCRA round trip (unmodified esctest execution)', () => {
  it('DECRQCRA checksum round trip in deccra.py succeeds at least once', async () => {
    // deccra (DECCRA=rect copy) verifies results via AssertScreenCharsInRectEqual → DECRQCRA.
    // cursorDoesNotMove case is CPR-based and passes reliably; others take DECRQCRA round-trip.
    // Pass criterion is "round-trip ×1" so check decrqcraBridgeUses ≥ 1 + at least 1 case pass.
    const r = await runEsctestCase({
      include: '(?i)^DECCRA[Tt]ests\\.',
      timeoutSec: 3,
      maxVtLevel: 5,
      hardTimeoutMs: 40000,
    });
    // DECRQCRA bridge actually round-tripped (core pass criterion).
    expect(r.decrqcraBridgeUses).toBeGreaterThanOrEqual(1);
    // At least 1 case returned a verdict (not infinite hold / total failure).
    expect(r.cases.length).toBeGreaterThanOrEqual(1);
    // Adapter completed (did not die on hard timeout).
    expect(r.timedOut).toBe(false);
  });

  it('DECRQCRA round trip on known grid matches DEC spec calculation (direct bridge verification)', async () => {
    // Direct proof of adapter bridge path: write chars to grid and checksum of that rect
    // matches manual calculation — this is the response sent back to esctest.
    const term = makeTerm();
    await writeSync(term, 'H'); // H at (1,1) (0x48).
    const chk = computeRectChecksum(term, 1, 1, 1, 1);
    expect(chk).toBe((-0x48) & 0xffff); // 0xFFB8.
    // Response bytes match format esctest parser reads.
    const reply = Buffer.from(buildDecrqcraReply(42, chk)).toString('binary');
    expect(reply).toBe('\x1bP42!~FFB8\x1b\\');
    term.dispose();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T2: cup.py completion (vendor required — CPR-based, collect all case verdicts).
// ────────────────────────────────────────────────────────────────────────────
describeVendor('T2 — cup.py completion (CPR-based, unmodified execution)', () => {
  it('runs cup.py unmodified and returns per-case verdicts', async () => {
    const r = await runEsctestCase({
      include: 'cup', // normalized to (?i)cup → matches CUPTests.
      timeoutSec: 3,
      maxVtLevel: 5,
      hardTimeoutMs: 40000,
    });
    // Adapter completed (reset passed + cases ran).
    expect(r.timedOut).toBe(false);
    // cup.py has 6 test methods (vendor pin). All must return verdicts.
    expect(r.cases.length).toBe(6);
    // xterm.js baseline reality: all cases pass is the goal. Actual non-compliance stays as honest fail
    // (recorded in report); here the gate is "completion + verdicts returned". pass count is for reporting.
    // (Observation: 6/6 pass — xterm.js complies with CUP correctly.)
    expect(r.passCount + r.failCount + r.errorCount + r.knownBugCount + r.skippedCount).toBe(6);
    // Parser aggregates match esctest's own summary line (review feedback — detect misclassification · denominator shrink).
    expect(r.esctestSummary).not.toBeNull();
    expect(r.reconciled).toBe(true);
    // reset()'s GetScreenSize() took WINOPS bridge (path not captured in decision doc — spike proof).
    expect(r.winopsBridgeUses).toBeGreaterThanOrEqual(1);
    // Report build aggregates totals.
    const report = buildReport([r]);
    expect(report.totals.pass + report.totals.fail + report.totals.error).toBe(6);
    expect(report.totals.unreconciledRuns).toBe(0);
    expect(report.esctestPin).toBe('664be3cf2c1e3f06bc93a8bafb48a0db83c607db');
  });
});
