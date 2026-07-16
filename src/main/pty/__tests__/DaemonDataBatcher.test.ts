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

  it('coalesces chunks within the window into one in-order send', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'a');
    b.push('s1', 'b');
    b.push('s1', 'c');
    expect(sent).toEqual([]); // nothing until the window closes
    vi.advanceTimersByTime(8);
    expect(sent).toEqual([['s1', 'abc']]);
  });

  it('keeps sessions independent (per-session buffers and timers)', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'x');
    b.push('s2', 'y');
    vi.advanceTimersByTime(8);
    expect(sent).toHaveLength(2);
    expect(new Map(sent).get('s1')).toBe('x');
    expect(new Map(sent).get('s2')).toBe('y');
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
    b.push('s1', '123456');
    expect(sent).toEqual([]);
    b.push('s1', '7890X'); // 11 chars total ≥ cap
    expect(sent).toEqual([['s1', '1234567890X']]);
  });

  it('drop discards without sending', () => {
    const b = new DaemonDataBatcher(send, 8);
    b.push('s1', 'doomed');
    b.drop('s1');
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([]);
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
