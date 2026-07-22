import { describe, expect, it } from 'vitest';
import { cpuPercentBetween, parseWslMeminfo } from '../SystemStatsSampler';

describe('SystemStatsSampler helpers', () => {
  it('computes CPU utilization from cumulative counters', () => {
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 125, total: 300 })).toBe(75);
  });

  it('parses WSL memory and swap pressure', () => {
    const stats = parseWslMeminfo(
      'MemTotal:       20480000 kB\nMemAvailable:   5120000 kB\nSwapTotal:      16384000 kB\nSwapFree:       2048000 kB\n',
      'Ubuntu',
    );
    expect(stats?.distro).toBe('Ubuntu');
    expect(stats?.memory.percent).toBe(75);
    expect(stats?.swap.percent).toBe(88);
  });

  it('rejects incomplete meminfo', () => {
    expect(parseWslMeminfo('SwapTotal: 1024 kB\n', 'Ubuntu')).toBeNull();
  });
});
