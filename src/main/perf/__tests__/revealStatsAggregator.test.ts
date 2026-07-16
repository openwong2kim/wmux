import { describe, it, expect } from 'vitest';
import {
  RevealStatsAggregator,
  REVEAL_WINDOW_MS,
} from '../revealStatsAggregator';

// Real emitter shapes, verbatim from src/renderer/hooks/useTerminal.ts.
const DIRTY_SNAPSHOT_LINE =
  '[wmux:reveal] ptyId=abc mechanism=dirty-snapshot recoveredBytes=1234 buffered=0 chunks=0';
const RETAINED_CATCHUP_LINE =
  '[wmux:reveal] ptyId=pty-2 mechanism=retained-catchup queuedChars=512';
const DEGRADED_LINE =
  '[wmux:reveal] ptyId=pty-3 mechanism=resync-degraded reason=snapshot-timeout (stays dirty, retry after cooldown)';
const COOLDOWN_LINE =
  '[wmux:reveal] ptyId=pty-3 mechanism=resync-degraded (cooldown, trigger=read)';

/** Aggregator with an injectable, manually-advanced clock. */
function makeAgg(startAt = 0): { agg: RevealStatsAggregator; tick: (ms: number) => void } {
  let now = startAt;
  const agg = new RevealStatsAggregator(() => now);
  return { agg, tick: (ms: number) => (now += ms) };
}

describe('RevealStatsAggregator — parsing', () => {
  it('parses a reveal line: mechanism counted, ptyId + fields + raw on last', () => {
    const { agg } = makeAgg();
    expect(agg.ingest(DIRTY_SNAPSHOT_LINE)).toBe(true);

    const stats = agg.getStats();
    expect(stats.last5m).toEqual({ 'dirty-snapshot': 1 });
    expect(stats.sinceBoot).toEqual({ 'dirty-snapshot': 1 });
    expect(stats.last).not.toBeNull();
    expect(stats.last?.ptyId).toBe('abc');
    expect(stats.last?.mechanism).toBe('dirty-snapshot');
    expect(stats.last?.raw).toBe(DIRTY_SNAPSHOT_LINE);
    expect(stats.last?.fields).toMatchObject({
      ptyId: 'abc',
      mechanism: 'dirty-snapshot',
      recoveredBytes: '1234',
      buffered: '0',
      chunks: '0',
    });
  });

  it('parses key=value pairs inside a free-text paren suffix without the ")"', () => {
    const { agg } = makeAgg();
    expect(agg.ingest(COOLDOWN_LINE)).toBe(true);
    const stats = agg.getStats();
    expect(stats.last?.mechanism).toBe('resync-degraded');
    expect(stats.last?.fields['trigger']).toBe('read');
  });

  it('ignores non-matching console lines', () => {
    const { agg } = makeAgg();
    expect(agg.ingest('[Main] Window created: true')).toBe(false);
    expect(agg.ingest('useTerminal mount ptyId=abc mechanism=fake')).toBe(false);
    // Prefix must be at the START of the line, not embedded mid-string.
    expect(agg.ingest('noise before [wmux:reveal] ptyId=x mechanism=dirty-snapshot')).toBe(false);
    // Reveal-prefixed line without a mechanism= pair is dropped defensively.
    expect(agg.ingest('[wmux:reveal] ptyId=x something went sideways')).toBe(false);

    const stats = agg.getStats();
    expect(stats.last).toBeNull();
    expect(stats.last5m).toEqual({});
    expect(stats.sinceBoot).toEqual({});
  });
});

describe('RevealStatsAggregator — 5-minute window', () => {
  it('prunes events older than the window on read; sinceBoot keeps them', () => {
    const { agg, tick } = makeAgg(1_000);
    agg.ingest(DIRTY_SNAPSHOT_LINE);
    tick(REVEAL_WINDOW_MS / 2);
    agg.ingest(RETAINED_CATCHUP_LINE);

    // Both still inside the window.
    expect(agg.getStats().last5m).toEqual({
      'dirty-snapshot': 1,
      'retained-catchup': 1,
    });

    // Advance so only the second event remains in the window.
    tick(REVEAL_WINDOW_MS / 2 + 1);
    let stats = agg.getStats();
    expect(stats.last5m).toEqual({ 'retained-catchup': 1 });
    expect(stats.sinceBoot).toEqual({ 'dirty-snapshot': 1, 'retained-catchup': 1 });

    // Advance past the window entirely — rolling counters empty, totals stay.
    tick(REVEAL_WINDOW_MS);
    stats = agg.getStats();
    expect(stats.last5m).toEqual({});
    expect(stats.sinceBoot).toEqual({ 'dirty-snapshot': 1, 'retained-catchup': 1 });
  });

  it('an event exactly at the window edge is pruned (strictly-newer survives)', () => {
    const { agg, tick } = makeAgg(0);
    agg.ingest(DIRTY_SNAPSHOT_LINE); // at t=0
    tick(REVEAL_WINDOW_MS); // cutoff == event time → pruned
    expect(agg.getStats().last5m).toEqual({});
  });
});

describe('RevealStatsAggregator — last-event tracking', () => {
  it('tracks the most recent event and its age', () => {
    const { agg, tick } = makeAgg(0);
    agg.ingest(DIRTY_SNAPSHOT_LINE);
    tick(10_000);
    agg.ingest(DEGRADED_LINE);
    tick(5_000);

    const stats = agg.getStats();
    expect(stats.last?.mechanism).toBe('resync-degraded');
    expect(stats.last?.ptyId).toBe('pty-3');
    expect(stats.last?.at).toBe(10_000);
    expect(stats.last?.ageMs).toBe(5_000);
    expect(stats.last?.fields['reason']).toBe('snapshot-timeout');
  });

  it('the last event survives window pruning (it is "since boot" state)', () => {
    const { agg, tick } = makeAgg(0);
    agg.ingest(RETAINED_CATCHUP_LINE);
    tick(REVEAL_WINDOW_MS * 3);
    const stats = agg.getStats();
    expect(stats.last5m).toEqual({});
    expect(stats.last?.mechanism).toBe('retained-catchup');
    expect(stats.last?.ageMs).toBe(REVEAL_WINDOW_MS * 3);
  });

  it('accumulates repeated mechanisms in both counters', () => {
    const { agg, tick } = makeAgg(0);
    for (let i = 0; i < 3; i++) {
      agg.ingest(DIRTY_SNAPSHOT_LINE);
      tick(1_000);
    }
    agg.ingest(DEGRADED_LINE);
    const stats = agg.getStats();
    expect(stats.last5m).toEqual({ 'dirty-snapshot': 3, 'resync-degraded': 1 });
    expect(stats.sinceBoot).toEqual({ 'dirty-snapshot': 3, 'resync-degraded': 1 });
  });
});
