// Pure-logic tests for the W2 N-pane instrumentation helpers
// (scripts/perf-scenarios.mjs). No packaged app, no CDP, no pipes — safe on
// every CI runner. The CDP/Playwright scenario BODIES in perf-bench.mjs are not
// unit-tested (they need the real Windows packaged app; design §5).
import { describe, it, expect } from 'vitest';
import {
  percentileAsc,
  summarizeSamples,
  sanitizeTerminalEcho,
  compareImeEcho,
  judgeFrameStall,
} from '../perf-scenarios.mjs';

describe('percentileAsc', () => {
  it('nearest-rank on a sorted array', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileAsc(s, 50)).toBe(5);
    expect(percentileAsc(s, 95)).toBe(10);
    expect(percentileAsc(s, 100)).toBe(10);
  });
  it('returns null for empty / non-array', () => {
    expect(percentileAsc([], 50)).toBeNull();
    expect(percentileAsc(null, 50)).toBeNull();
  });
});

describe('summarizeSamples', () => {
  it('produces the perf-bench summary shape', () => {
    const out = summarizeSamples([10, 20, 30, 40]);
    expect(out.count).toBe(4);
    expect(out.min).toBe(10);
    expect(out.max).toBe(40);
    expect(out.mean).toBe(25);
    expect(out.p50).toBe(20);
    expect(out.p95).toBe(40);
  });
  it('drops non-finite entries before ranking', () => {
    const out = summarizeSamples([16, NaN, 17, Infinity, 18, null, 'x']);
    expect(out.count).toBe(3);
    expect(out.min).toBe(16);
    expect(out.max).toBe(18);
  });
  it('empty input yields null stats but count 0', () => {
    const out = summarizeSamples([]);
    expect(out.count).toBe(0);
    expect(out.p95).toBeNull();
    expect(out.mean).toBeNull();
  });
});

describe('sanitizeTerminalEcho', () => {
  it('strips CSI colour/cursor escapes but keeps Hangul', () => {
    // PSReadLine-style: SGR colour around the text + a cursor move.
    const raw = '\x1b[38;5;12m안녕하세요\x1b[0m\x1b[5;1H';
    expect(sanitizeTerminalEcho(raw)).toBe('안녕하세요');
  });
  it('strips OSC title/cwd reports (BEL and ST terminated)', () => {
    expect(sanitizeTerminalEcho('\x1b]0;pwsh\x07안녕')).toBe('안녕');
    expect(sanitizeTerminalEcho('\x1b]7;file:///c\x1b\\녕')).toBe('녕');
  });
  it('drops NUL/BEL/DEL control chars (newlines + tab are intentionally kept)', () => {
    // A composed Hangul string never contains \r\n\t, so keeping them is safe
    // and .includes() still matches; stripping the truly-noisy C0 bytes is the
    // point. Verify the noisy ones go and Hangul survives across a newline.
    expect(sanitizeTerminalEcho('\x00안\x07녕\x7f')).toBe('안녕');
    expect(sanitizeTerminalEcho('안녕\r\n하세요')).toContain('안녕');
  });
  it('non-string is empty', () => {
    expect(sanitizeTerminalEcho(null)).toBe('');
    expect(sanitizeTerminalEcho(undefined)).toBe('');
  });
});

describe('compareImeEcho', () => {
  it('passes when the sanitized echo contains the composed string', () => {
    const raw = 'PS> \x1b[93m안녕하세요\x1b[0m';
    const v = compareImeEcho('안녕하세요', raw);
    expect(v.pass).toBe(true);
    expect(v.echoedSanitized).toContain('안녕하세요');
  });
  it('fails on a dropped syllable (mangled composition)', () => {
    const v = compareImeEcho('안녕하세요', '안녕세요'); // missing ha
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/not found/);
  });
  it('fails on empty echo', () => {
    expect(compareImeEcho('안녕', '').pass).toBe(false);
  });
  it('fails on empty expected', () => {
    const v = compareImeEcho('', '안녕');
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/empty expected/);
  });
});

describe('judgeFrameStall', () => {
  it('flags a stall past factor AND the absolute floor', () => {
    const v = judgeFrameStall({ baselineP95: 30, duringP95: 120 }); // 4x, > 50ms
    expect(v.stalled).toBe(true);
    expect(v.ratio).toBe(4);
  });
  it('does not flag when over factor but under the floor (tiny baseline)', () => {
    const v = judgeFrameStall({ baselineP95: 2, duringP95: 10 }); // 5x but 10ms < 50
    expect(v.stalled).toBe(false);
  });
  it('does not flag within budget', () => {
    const v = judgeFrameStall({ baselineP95: 40, duringP95: 60 }); // 1.5x
    expect(v.stalled).toBe(false);
  });
  it('honours a custom factor', () => {
    const v = judgeFrameStall({ baselineP95: 30, duringP95: 100, factor: 4 }); // 3.3x < 4
    expect(v.stalled).toBe(false);
  });
  it('not stalled when samples are missing', () => {
    expect(judgeFrameStall({ baselineP95: null, duringP95: 100 }).stalled).toBe(false);
    expect(judgeFrameStall({ baselineP95: 30, duringP95: null }).reason).toMatch(/insufficient/);
  });
});
