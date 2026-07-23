// Pure, side-effect-free helpers for the W2 N-pane instrumentation scenarios
// (frame budget / Korean IME / WebGL context-loss).
//
// WHY A SEPARATE MODULE (not inside perf-bench.mjs):
//   perf-bench.mjs runs a top-level bench IIFE on import AND process.exit(2)s
//   at module load when the packaged Windows app is missing. Importing it from
//   a unit test would launch the whole bench. This module has ZERO import-time
//   side effects, so scripts/__tests__/*.test.mjs can import and exercise the
//   pure logic on any platform (the CDP/Playwright-driven scenario BODIES that
//   consume these helpers live in perf-bench.mjs and are NOT unit-tested — they
//   need the real packaged Windows app; see the design doc §5 honest-limits).

// --- numeric summary --------------------------------------------------------

// Nearest-rank percentile on an ascending-sorted array (matches perf-bench.mjs
// summarize()). Returns null for an empty array.
export function percentileAsc(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

const round3 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);

// Summarize raw samples (e.g. rAF frame deltas in ms) into the same shape
// perf-bench.mjs summarize() emits, so the gate dot-paths (…frameDeltaMs.p95)
// line up. Non-finite entries are dropped before ranking.
export function summarizeSamples(values) {
  const nums = (Array.isArray(values) ? values : []).filter(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );
  const s = [...nums].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    p50: round3(percentileAsc(s, 50)),
    p95: round3(percentileAsc(s, 95)),
    p99: round3(percentileAsc(s, 99)),
    min: round3(s[0] ?? null),
    max: round3(s[s.length - 1] ?? null),
    mean: s.length ? round3(sum / s.length) : null,
  };
}

// --- IME echo comparison ----------------------------------------------------

// Strip the terminal control noise a real shell wraps its echo in (PSReadLine
// paints the input line with SGR colour + cursor moves, and the shell emits an
// OSC title/cwd report) so the comparison sees only the printable text the PTY
// echoed. Hangul syllables are all >= U+AC00, so no stripped control byte can
// be a false positive against the composed string.
//   - CSI:   ESC [ … final-byte          (colour, cursor, erase)
//   - OSC:   ESC ] … (BEL | ESC \)        (title / cwd / hyperlink)
//   - other 2-byte ESC escapes            (ESC ( B, ESC = , …)
//   - lone C0/DEL control chars
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function sanitizeTerminalEcho(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_RE, '')
    .replace(C0_RE, '');
}

// Did the PTY echo the exact composed string back? A Korean IME commit reaches
// the shell as UTF-8 and the line editor echoes it; we require the expected
// codepoint sequence to appear CONTIGUOUSLY in the sanitized echo (a byte/
// codepoint-exact substring match — a mangled composition would drop or reorder
// a syllable and fail here). Returns a structured verdict recording WHY.
export function compareImeEcho(expected, echoedRaw) {
  const exp = typeof expected === 'string' ? expected : '';
  const sanitized = sanitizeTerminalEcho(echoedRaw);
  if (exp.length === 0) {
    return { pass: false, expected: exp, echoedSanitized: sanitized, reason: 'empty expected string' };
  }
  const match = sanitized.includes(exp);
  return {
    pass: match,
    expected: exp,
    echoedSanitized: sanitized,
    reason: match
      ? 'echo contains the composed string byte-for-byte'
      : `composed string not found in echo (got ${JSON.stringify(sanitized.slice(0, 64))})`,
  };
}

// --- frame-stall judgment ---------------------------------------------------

// A workload window is "stalled" when its during-window frame p95 exceeds the
// calm-baseline p95 by `factor` (design §2.2: "exceed 2× budget"). Guarded so a
// tiny/absent baseline can't trip on ordinary jitter: an absolute floor
// (minStallMs) must also be crossed. Missing baseline OR during → not stalled
// (we cannot assert a regression without both numbers).
export function judgeFrameStall({ baselineP95, duringP95, factor = 2, minStallMs = 50 }) {
  const okNum = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!okNum(baselineP95) || !okNum(duringP95)) {
    return { stalled: false, factor, ratio: null, reason: 'insufficient samples' };
  }
  const ratio = baselineP95 > 0 ? duringP95 / baselineP95 : null;
  const overFactor = ratio != null && ratio > factor;
  const overFloor = duringP95 > minStallMs;
  const stalled = overFactor && overFloor;
  return {
    stalled,
    factor,
    ratio: ratio == null ? null : round3(ratio),
    reason: stalled
      ? `during p95 ${round3(duringP95)}ms > ${factor}x baseline ${round3(baselineP95)}ms`
      : 'within budget',
  };
}
