// E0 harness M3 — esctest report schema (spec: engine-core-decision-2026-07-09.md §5-3)
//
// Canonical types for report.json. Per-case verdicts + DECRQCRA bridge usage scope.
// Review feedback (2026-07-09): status split (known-bug/skipped separated from pass), rawLogTail removed
// (exclude GPL-derived log text from committed artifacts — aggregates/summary counts only), cross-check
// fields against esctest's own summary line (reconciled), abnormal run visibility (timeout · nonzero exit).

/** One DECRQCRA bridge response record (§5-3: report records bridge usage). */
export interface DecrqcraBridgeUse {
  readonly pid: number;
  readonly rect: { readonly top: number; readonly left: number; readonly bottom: number; readonly right: number };
  readonly checksum: number;
}

/**
 * Verdict for one case (test method) (review feedback — status split):
 * pass=pure pass / known-bug=esctest expected failure ("Fails as expected" — normal from esctest's view but
 * split for purity audit) / skipped=capability skip (not verified — must not count toward pass).
 */
export interface EsctestCase {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'error' | 'known-bug' | 'skipped';
}

/** Result of one include (one file) run. */
export interface EsctestCaseResult {
  readonly include: string;
  readonly exitCode: number;
  readonly signal?: number;
  readonly timedOut: boolean;
  readonly cases: EsctestCase[];
  readonly passCount: number;
  readonly failCount: number;
  readonly errorCount: number;
  /** known-bug (expected fail) · capability skip — split from pass (review feedback). */
  readonly knownBugCount: number;
  readonly skippedCount: number;
  /** DECRQCRA bridge response count in this run (xterm.js unimplemented fallback path usage). */
  readonly decrqcraBridgeUses: number;
  /**
   * WINOPS size report bridge response count (CSI 18 t / CSI 19 t). Path not captured in decision doc §5-3 —
   * xterm.js is silent on WINOPS so adapter geometry bridge is required (spike observation).
   */
  readonly winopsBridgeUses: number;
  /**
   * Counts from esctest's own summary line ("*** N tests passed, M known bugs, K tests failed ***") —
   * independent baseline to cross-check parser aggregates (review feedback). null if not found (abnormal exit signal).
   */
  readonly esctestSummary: {
    readonly passed: number;
    readonly knownBugs: number;
    readonly failed: number;
  } | null;
  /**
   * Whether parser aggregates match esctest summary (review feedback — detect misclassification · denominator shrink).
   * Check: pass+skipped == passed (esctest counts skips in passed) · knownBug == knownBugs ·
   * fail == failed. false if summary missing · timeout · nonzero exit.
   */
  readonly reconciled: boolean;
}

/** Full report.json. */
export interface EsctestReport {
  readonly subject: string;
  readonly generatedAt: string;
  /** Vendor commit pin (reproducibility). */
  readonly esctestPin: string;
  readonly results: EsctestCaseResult[];
  readonly totals: {
    readonly pass: number;
    readonly fail: number;
    readonly error: number;
    /** Review feedback — pass purity audit split + abnormal run visibility. */
    readonly knownBug: number;
    readonly skipped: number;
    readonly timedOutRuns: number;
    readonly nonzeroExitRuns: number;
    readonly unreconciledRuns: number;
    readonly decrqcraBridgeUses: number;
    readonly winopsBridgeUses: number;
  };
}
