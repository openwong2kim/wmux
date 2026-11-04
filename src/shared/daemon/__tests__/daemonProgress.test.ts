import { describe, expect, it } from 'vitest';
import {
  DaemonProgressTracker,
  waitOutProgressingDaemon,
  parseProcStatCpuMs,
  parsePsCpuTime,
  type DaemonProcessSample,
} from '../daemonProgress';

const cfg = { noProgressMs: 30_000, pressureFactor: 4, maxUnansweredMs: 15 * 60_000 };
const at = (cpuMs: number | null, underPressure = false): DaemonProcessSample => ({ alive: true, cpuMs, underPressure });

describe('DaemonProgressTracker', () => {
  it('a daemon whose CPU time keeps rising is progressing, however long it goes unanswered (up to the cap)', () => {
    const t = new DaemonProgressTracker(cfg);
    for (let s = 0; s <= 120; s += 10) expect(t.observe(42, at(1000 + s), s * 1000)).toBe('progressing');
  });

  it('no CPU time for the budget is stalled', () => {
    const t = new DaemonProgressTracker(cfg);
    expect(t.observe(42, at(500), 0)).toBe('progressing');
    expect(t.observe(42, at(500), 20_000)).toBe('progressing');
    expect(t.observe(42, at(500), 30_000)).toBe('stalled');
  });

  it('under memory pressure the budget is longer', () => {
    const t = new DaemonProgressTracker(cfg);
    t.observe(42, at(500, true), 0);
    expect(t.observe(42, at(500, true), 60_000)).toBe('progressing');
    expect(t.observe(42, at(500, true), 120_000)).toBe('stalled');
  });

  it('CPU time that stops rising counts from its last rise', () => {
    const t = new DaemonProgressTracker(cfg);
    t.observe(42, at(100), 0);
    t.observe(42, at(200), 10_000);
    expect(t.observe(42, at(200), 39_000)).toBe('progressing');
    expect(t.observe(42, at(200), 40_000)).toBe('stalled');
  });

  it('past the cap a daemon is stalled even while it burns CPU', () => {
    const t = new DaemonProgressTracker(cfg);
    t.observe(42, at(0), 0);
    expect(t.observe(42, at(1), 15 * 60_000 - 1)).toBe('progressing');
    expect(t.observe(42, at(2), 15 * 60_000)).toBe('stalled');
  });

  it('a read that fails after earlier ones counts from the last rise, as a sample that shows none', () => {
    const t = new DaemonProgressTracker(cfg);
    t.observe(42, at(100), 0);
    t.observe(42, at(200), 10_000);
    expect(t.observe(42, at(null), 20_000)).toBe('progressing');
    expect(t.observe(42, at(null), 40_000)).toBe('stalled');
  });

  it('a missing process is gone, an unreadable one unknown, and a new pid or a reset starts over', () => {
    const t = new DaemonProgressTracker(cfg);
    expect(t.observe(42, { alive: false, cpuMs: null, underPressure: false }, 0)).toBe('gone');
    expect(t.observe(42, at(null), 0)).toBe('unknown');
    t.observe(42, at(500), 0);
    expect(t.observe(43, at(500), 40_000)).toBe('progressing');
    t.reset();
    expect(t.observe(43, at(500), 80_000)).toBe('progressing');
  });
});

describe('CPU time parsers', () => {
  it('reads ps time in each of its shapes', () => {
    expect(parsePsCpuTime('0:01.23')).toBe(1230);
    expect(parsePsCpuTime(' 12:05.5\n')).toBe(725_500);
    expect(parsePsCpuTime('1:02:03')).toBe(3_723_000);
    expect(parsePsCpuTime('2-01:00:00')).toBe(176_400_000);
    expect(parsePsCpuTime('')).toBeNull();
  });

  it('reads utime and stime from /proc/<pid>/stat, past a name with spaces and parentheses', () => {
    const stat = '1234 (node (wmux) d) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 75 0 0 20 0 11 0 100 0 0';
    expect(parseProcStatCpuMs(stat)).toBe(3250);
  });
});

describe('waitOutProgressingDaemon (the launcher, before a kill)', () => {
  const progress = { noProgressMs: 10_000, pressureFactor: 4, maxUnansweredMs: 15 * 60_000 };
  /** A clock the sleeps move. */
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };
  const wait = (sample: (pid: number) => Promise<DaemonProcessSample>, ping: () => Promise<boolean>, ceilingMs = 90_000) => {
    const c = clock();
    return waitOutProgressingDaemon({ pid: 7, sample, ping, sleep: c.sleep, now: c.now, intervalMs: 2000, ceilingMs, progress });
  };

  it('a daemon still using CPU is waited on, and kept once it answers', async () => {
    let cpu = 0;
    let pings = 0;
    expect(await wait(async () => at((cpu += 30)), async () => ++pings === 5)).toBe('answered');
    expect(pings).toBe(5);
  });

  it('one that stops using CPU is given up on after the budget, not at once', async () => {
    let pings = 0;
    expect(await wait(async () => at(100), async () => { pings++; return false; })).toBe('stalled');
    expect(pings).toBe(5);
  });

  it('one that keeps using CPU without answering is given up on at the ceiling', async () => {
    let cpu = 0;
    expect(await wait(async () => at((cpu += 30)), async () => false, 20_000)).toBe('ceiling');
  });

  it('a gone process, or CPU time it cannot read from the start, ends the wait at once', async () => {
    let pings = 0;
    const ping = async () => { pings++; return false; };
    expect(await wait(async () => ({ alive: false, cpuMs: null, underPressure: false }), ping)).toBe('gone');
    expect(await wait(async () => at(null), ping)).toBe('unknown');
    expect(pings).toBe(0);
  });
});
