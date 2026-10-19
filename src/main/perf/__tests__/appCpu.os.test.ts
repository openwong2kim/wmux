import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  metrics: [] as { pid: number; cpu: { cumulativeCPUUsage?: number; percentCPUUsage: number } }[],
}));
vi.mock('electron', () => ({ app: { getAppMetrics: () => electronMock.metrics } }));

import {
  cpuPercentBetween,
  cumulativeTimesFromMetrics,
  resetAppCpuSampleForTests,
  sampleAppCpuPercent,
} from '../appCpu';
import { tryProcessTreeCpuTimes } from '../../pty/winSnapshotNative';

const UNITS_PER_SECOND = 10_000_000n; // 100 ns FILETIME units

describe('cpuPercentBetween', () => {
  it('reports percent of the whole machine', () => {
    // One core fully busy for 1 s on a 4-core machine → 25%.
    const prev = new Map([[1, 0n]]);
    const next = new Map([[1, UNITS_PER_SECOND]]);
    expect(cpuPercentBetween(prev, next, 1000, 4)).toBeCloseTo(25, 5);
  });

  it('sums every process present in both samples', () => {
    const prev = new Map([[1, 0n], [2, 0n]]);
    const next = new Map([[1, UNITS_PER_SECOND / 2n], [2, UNITS_PER_SECOND / 2n]]);
    expect(cpuPercentBetween(prev, next, 1000, 2)).toBeCloseTo(50, 5);
  });

  it('ignores a process that appeared or exited between the samples', () => {
    const prev = new Map([[1, 0n], [3, 5n * UNITS_PER_SECOND]]);
    const next = new Map([[1, 0n], [2, 9n * UNITS_PER_SECOND]]);
    expect(cpuPercentBetween(prev, next, 1000, 2)).toBe(0);
  });

  it('is 0 for a zero interval and never exceeds 100', () => {
    const prev = new Map([[1, 0n]]);
    const next = new Map([[1, 100n * UNITS_PER_SECOND]]);
    expect(cpuPercentBetween(prev, next, 0, 2)).toBe(0);
    expect(cpuPercentBetween(prev, next, 1000, 1)).toBe(100);
  });
});

describe('cumulativeTimesFromMetrics', () => {
  it('converts cumulative CPU seconds to 100 ns units per pid', () => {
    const times = cumulativeTimesFromMetrics([
      { pid: 1, cpu: { cumulativeCPUUsage: 1.5, percentCPUUsage: 0, idleWakeupsPerSecond: 0 } },
      { pid: 2, cpu: { cumulativeCPUUsage: 0.0000001, percentCPUUsage: 0, idleWakeupsPerSecond: 0 } },
    ]);
    expect(times).toEqual(new Map([[1, 15_000_000n], [2, 1n]]));
  });

  it('is null when a process has no cumulative reading', () => {
    expect(cumulativeTimesFromMetrics([
      { pid: 1, cpu: { cumulativeCPUUsage: 1, percentCPUUsage: 0, idleWakeupsPerSecond: 0 } },
      { pid: 2, cpu: { percentCPUUsage: 40, idleWakeupsPerSecond: 0 } },
    ])).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('sampleAppCpuPercent (macOS/Linux)', () => {
  beforeEach(() => {
    resetAppCpuSampleForTests();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('measures CPU over the whole poll interval, not since the last getAppMetrics() call', () => {
    const cores = os.cpus().length || 1;
    electronMock.metrics = [{ pid: 1, cpu: { cumulativeCPUUsage: 10, percentCPUUsage: 0 } }];
    expect(sampleAppCpuPercent(null)).toBeNull(); // first call is only a baseline

    // 5 s later the process has used 2.5 s of CPU. percentCPUUsage reads 0 —
    // the memory handler's getAppMetrics() just reset it — and must not matter.
    vi.setSystemTime(5000);
    electronMock.metrics = [{ pid: 1, cpu: { cumulativeCPUUsage: 12.5, percentCPUUsage: 0 } }];
    expect(sampleAppCpuPercent(null)).toBeCloseTo(Math.min(100, 50 / cores), 5);
  });

  it('gives no reading when Electron lacks cumulative CPU times', () => {
    electronMock.metrics = [{ pid: 1, cpu: { percentCPUUsage: 80 } }];
    expect(sampleAppCpuPercent(null)).toBeNull();
    vi.setSystemTime(5000);
    expect(sampleAppCpuPercent(null)).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('native process-tree CPU times (Windows)', () => {
  it('reads this process and its first sample has no baseline', () => {
    const times = tryProcessTreeCpuTimes([process.pid]);
    expect(times).not.toBeNull();
    expect(times!.has(process.pid)).toBe(true);
    expect(times!.get(process.pid)!).toBeGreaterThan(0n);
    expect(sampleAppCpuPercent(null)).toBeNull();
    expect(typeof sampleAppCpuPercent(null)).toBe('number');
  });
});
