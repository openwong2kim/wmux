import { describe, it, expect } from 'vitest';
import { HookFloodMeter, describeHookFlood } from '../HookFloodMeter';

describe('HookFloodMeter', () => {
  it('flush() returns null when no signals were recorded (idle window stays silent)', () => {
    const m = new HookFloodMeter();
    expect(m.flush(30_000)).toBeNull();
  });

  it('tallies total, degraded, maxFetch, and fast-pathed then resets on flush', () => {
    const m = new HookFloodMeter();
    m.record({ degraded: false, fetchMs: 2 });
    m.record({ degraded: true, fetchMs: 1500 });
    m.record({ degraded: false, fetchMs: 40 });

    const s = m.flush(30_000);
    expect(s).toEqual({ windowMs: 30_000, total: 3, degraded: 1, maxFetchMs: 1500, fastPathed: 0 });

    // Window reset — a subsequent idle flush is null.
    expect(m.flush(30_000)).toBeNull();
  });

  it('counts fast-pathed signals so a green meter during a flood is explainable (GLM P2)', () => {
    const m = new HookFloodMeter();
    // A flush storm: most ptyId hooks are served from the cache (fetchMs 0, not
    // degraded, fastPathed) while the renderer is pegged. Without this counter
    // the window would read "10 signals, 0 degraded" and hide the saturation.
    for (let i = 0; i < 8; i++) m.record({ degraded: false, fetchMs: 0, fastPathed: true });
    m.record({ degraded: true, fetchMs: 1600 }); // a workspaceId-only hook that still fetched
    m.record({ degraded: false, fetchMs: 30 });

    const s = m.flush(30_000);
    expect(s).toEqual({ windowMs: 30_000, total: 10, degraded: 1, maxFetchMs: 1600, fastPathed: 8 });
    // fastPathed resets with the rest of the window.
    expect(m.flush(30_000)).toBeNull();
  });

  it('accumulates across records within a window', () => {
    const m = new HookFloodMeter();
    for (let i = 0; i < 5; i++) m.record({ degraded: i % 2 === 0, fetchMs: i });
    const s = m.flush(10_000);
    expect(s?.total).toBe(5);
    expect(s?.degraded).toBe(3); // i = 0,2,4
    expect(s?.fastPathed).toBe(0); // none marked fast-pathed
  });
});

describe('describeHookFlood', () => {
  it('info level for a healthy window (mostly fresh cache hits)', () => {
    const { level, message } = describeHookFlood({ windowMs: 30_000, total: 100, degraded: 2, maxFetchMs: 30, fastPathed: 0 });
    expect(level).toBe('info');
    expect(message).toContain('100 signals');
    expect(message).toContain('2 degraded');
    expect(message).toContain('2%');
  });

  it('surfaces the fast-pathed count in the message', () => {
    const { message } = describeHookFlood({ windowMs: 30_000, total: 60, degraded: 1, maxFetchMs: 20, fastPathed: 55 });
    expect(message).toContain('55 fast-pathed');
  });

  it('warn level when ≥10% of a non-trivial sample is degraded (flood)', () => {
    const { level, message } = describeHookFlood({ windowMs: 30_000, total: 50, degraded: 20, maxFetchMs: 1900, fastPathed: 0 });
    expect(level).toBe('warn');
    expect(message).toContain('flood');
    expect(message).toContain('40%');
  });

  it('stays info for a tiny sample even if proportionally degraded (avoid one-off noise)', () => {
    // 2/3 degraded but total < 10 → not a pattern worth warning.
    const { level } = describeHookFlood({ windowMs: 30_000, total: 3, degraded: 2, maxFetchMs: 800, fastPathed: 0 });
    expect(level).toBe('info');
  });
});
