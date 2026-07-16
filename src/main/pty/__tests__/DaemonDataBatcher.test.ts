import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DaemonDataBatcher } from '../DaemonDataBatcher';

// app-weight P1-3 — the daemon twin of PTYBridge.batch.test.ts. The ordering
// contract matters more than the coalescing: a flush-complete / exit /
// restarted marker must never overtake batched data (eng F3 / codex #14 on
// the reviewed plan), so flushSession() has to deliver synchronously.
describe('DaemonDataBatcher', () => {
  let sent: Array<[string, string]>;
  let send: (id: string, text: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    send = (id, text) => sent.push([id, text]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leading-edge: a chunk on an idle session is delivered immediately', () => {
    // Interactive keystroke echo must not pay the batch window — the CI
    // bench caught the always-trailing version adding the full 8 ms to
    // echoMs.p95 (13.9 → 21.5 ms).
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'k');
    expect(sent).toEqual([['s1', 'k']]);
    // Typing cadence (> window between keys): every echo is immediate.
    vi.advanceTimersByTime(50);
    b.push('s1', 'e');
    expect(sent).toEqual([['s1', 'k'], ['s1', 'e']]);
  });

  it('coalesces burst chunks after the leading edge into one in-order send', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'a'); // leading edge — immediate
    b.push('s1', 'b');
    b.push('s1', 'c');
    expect(sent).toEqual([['s1', 'a']]); // rest waits for the window
    vi.advanceTimersByTime(8);
    expect(sent).toEqual([['s1', 'a'], ['s1', 'bc']]);
  });

  it('keeps sessions independent (per-session buffers and timers)', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'x'); // leading edge each — immediate, per session
    b.push('s2', 'y');
    expect(sent).toHaveLength(2);
    expect(new Map(sent).get('s1')).toBe('x');
    expect(new Map(sent).get('s2')).toBe('y');
    // Follow-ups inside each window coalesce per session.
    b.push('s1', 'x2');
    b.push('s2', 'y2');
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(8);
    expect(sent).toHaveLength(4);
  });

  it('flushSession delivers synchronously — data always precedes a marker', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'final output');
    // Simulate the exit/flushComplete forwarder contract:
    b.flushSession('s1');
    sent.push(['s1', '<MARKER>']);
    expect(sent).toEqual([['s1', 'final output'], ['s1', '<MARKER>']]);
    // The timer must not double-send later.
    vi.advanceTimersByTime(20);
    expect(sent).toHaveLength(2);
  });

  it('bounds per-session memory: exceeding the cap flushes immediately', () => {
    const b = new DaemonDataBatcher(send, 8, 10 /* tiny cap */);
    b.push('s1', 'lead'); // leading edge — immediate, bypasses the buffer
    b.push('s1', '123456');
    expect(sent).toEqual([['s1', 'lead']]);
    b.push('s1', '7890X'); // 11 buffered chars ≥ cap
    expect(sent).toEqual([['s1', 'lead'], ['s1', '1234567890X']]);
  });

  it('drop discards buffered data without sending', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'lead'); // leading edge — already delivered
    b.push('s1', 'doomed'); // buffered
    b.drop('s1');
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([['s1', 'lead']]);
  });

  it('dispose flushes everything pending, and late pushes are DROPPED (old generation)', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'tail');
    b.dispose();
    expect(sent).toEqual([['s1', 'tail']]);
    // A pipe read racing the handler swap: the daemon ring is the byte SSOT
    // and the new generation replays it — delivering here could interleave
    // old-generation bytes after the new generation's resync markers.
    b.push('s1', 'late');
    expect(sent).toEqual([['s1', 'tail']]);
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([['s1', 'tail']]);
  });

  it('empty text is a no-op', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', '');
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([]);
  });
});
