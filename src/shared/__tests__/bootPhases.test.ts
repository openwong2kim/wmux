import { describe, it, expect } from 'vitest';
import {
  span,
  parseBootSummary,
  rebaseDaemonMarks,
  MAIN_PHASES,
  DAEMON_PHASES,
  DAEMON_MARK_ORDER,
} from '../bootPhases';

describe('span', () => {
  it('computes the delta between two marks', () => {
    expect(span({ a: 100, b: 350 }, 'a', 'b')).toBe(250);
  });

  it('treats the sentinel "spawn" as zero origin', () => {
    expect(span({ 'js-start': 120 }, 'spawn', 'js-start')).toBe(120);
  });

  it('returns null when the start mark is missing', () => {
    expect(span({ b: 350 }, 'a', 'b')).toBeNull();
  });

  it('returns null when the end mark is missing', () => {
    expect(span({ a: 100 }, 'a', 'b')).toBeNull();
  });

  it('rounds fractional deltas', () => {
    expect(span({ a: 100.2, b: 350.9 }, 'a', 'b')).toBe(251);
  });

  it('matches the perf-bench inline span semantics for spawn→end', () => {
    // perf-bench: span(marks, 'spawn', X) == marks[X] (origin 0).
    expect(span({ 'imports-done': 42 }, 'spawn', 'imports-done')).toBe(42);
  });
});

describe('parseBootSummary', () => {
  // The exact line format emitted by src/main/util/bootTrace.ts emitBootSummary.
  const realSummary =
    '[2026-06-13T09:00:00.000Z] [info] [main] [boot-trace] summary=' +
    JSON.stringify({
      procCreateEpochMs: 1000,
      jsStartEpochMs: 1400,
      preJsMs: 400,
      marks: { 'js-start': 0, 'imports-done': 60, 'module-eval-end': 120, 'ready-end': 900 },
    });

  it('parses a real-format summary line', () => {
    const s = parseBootSummary(`some noise\n${realSummary}\nmore noise`);
    expect(s).not.toBeNull();
    expect(s?.jsStartEpochMs).toBe(1400);
    expect(s?.preJsMs).toBe(400);
    expect(s?.marks['imports-done']).toBe(60);
  });

  it('returns null when no summary line is present', () => {
    expect(parseBootSummary('[info] just a log line\nanother line')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(parseBootSummary('')).toBeNull();
  });

  it('picks the LAST summary when a log spans multiple boots', () => {
    const older =
      '[boot-trace] summary=' +
      JSON.stringify({ procCreateEpochMs: 1, jsStartEpochMs: 1, preJsMs: 0, marks: { 'js-start': 0 } });
    const newer =
      '[boot-trace] summary=' +
      JSON.stringify({ procCreateEpochMs: 2, jsStartEpochMs: 5000, preJsMs: 999, marks: { 'js-start': 0 } });
    const s = parseBootSummary(`${older}\n${newer}`);
    expect(s?.jsStartEpochMs).toBe(5000);
    expect(s?.preJsMs).toBe(999);
  });

  it('falls through a corrupt latest line to the previous valid one', () => {
    const good =
      '[boot-trace] summary=' +
      JSON.stringify({ procCreateEpochMs: 1, jsStartEpochMs: 7, preJsMs: 1, marks: { 'js-start': 0 } });
    const corrupt = '[boot-trace] summary={not valid json';
    const s = parseBootSummary(`${good}\n${corrupt}`);
    expect(s?.jsStartEpochMs).toBe(7);
  });

  it('rejects a summary missing required fields', () => {
    // No jsStartEpochMs / marks → not a usable summary.
    const bad = '[boot-trace] summary=' + JSON.stringify({ foo: 'bar' });
    expect(parseBootSummary(bad)).toBeNull();
  });

  it('tolerates a null preJsMs (procCreateTime unavailable)', () => {
    const line =
      '[boot-trace] summary=' +
      JSON.stringify({ procCreateEpochMs: null, jsStartEpochMs: 100, preJsMs: null, marks: { 'js-start': 0 } });
    const s = parseBootSummary(line);
    expect(s?.preJsMs).toBeNull();
    expect(s?.procCreateEpochMs).toBeNull();
  });
});

describe('rebaseDaemonMarks', () => {
  it('rebases absolute epoch marks to deltas from js-start', () => {
    const rebased = rebaseDaemonMarks(
      { 'main-start': 10_000, 'lock-acquired': 10_050, ready: 10_300 },
      10_000,
    );
    expect(rebased['main-start']).toBe(0);
    expect(rebased['lock-acquired']).toBe(50);
    expect(rebased['ready']).toBe(300);
  });

  it('produces a marks map that span() consumes directly', () => {
    const rebased = rebaseDaemonMarks(
      { 'pre-pipe-start': 5_100, 'pipe-listening': 5_180 },
      5_000,
    );
    expect(span(rebased, 'pre-pipe-start', 'pipe-listening')).toBe(80);
  });
});

describe('phase tables', () => {
  it('MAIN_PHASES mark names exist in the documented boot-trace vocabulary', () => {
    // Guards against a typo silently producing all-n/a rows. These names are
    // the markBoot() call sites in src/main (index.ts + daemon/launcher.ts).
    const known = new Set([
      'js-start', 'imports-done', 'module-eval-end', 'construction-start',
      'pre-pipe-server-ctor', 'pipe-server-ctor-done', 'ready-fired',
      'plugins-loaded', 'window-created', 'daemon-bootstrap-start',
      'daemon-bootstrap-end', 'daemon-ensure-start', 'daemon-spawned',
      'daemon-pipe-file-seen', 'daemon-first-ping-ok', 'renderer-load-triggered',
      'ready-end',
    ]);
    for (const p of MAIN_PHASES) {
      expect(known.has(p.from), `from=${p.from}`).toBe(true);
      expect(known.has(p.to), `to=${p.to}`).toBe(true);
    }
  });

  it('DAEMON_PHASES mark names are a subset of DAEMON_MARK_ORDER', () => {
    const known = new Set(DAEMON_MARK_ORDER);
    for (const p of DAEMON_PHASES) {
      expect(known.has(p.from), `from=${p.from}`).toBe(true);
      expect(known.has(p.to), `to=${p.to}`).toBe(true);
    }
  });
});
