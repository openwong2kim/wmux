import { describe, expect, it } from 'vitest';
import {
  cpuPercentBetween,
  parseMemorySize,
  parseTasklistWslMemory,
  parseWslConfigMemory,
  SystemStatsSampler,
} from '../SystemStatsSampler';

describe('SystemStatsSampler helpers', () => {
  it('computes CPU utilization from cumulative counters', () => {
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 125, total: 300 })).toBe(75);
  });

  it('parses WSL memory sizes and the wsl2 config section', () => {
    expect(parseMemorySize('20GB')).toBe(20 * 1024 ** 3);
    expect(parseMemorySize('1.5 GB')).toBe(1.5 * 1024 ** 3);
    expect(parseWslConfigMemory('[other]\nmemory=2GB\n[wsl2]\nmemory = 20GB # workflow cap\n')).toBe(20 * 1024 ** 3);
  });

  it('parses VmmemWSL working set from locale-independent tasklist CSV', () => {
    const output = [
      '"vmmemWSL.exe","8120","Services","0","12,345,678 K"',
      '"vmmem.exe","8121","Services","0","1,000 K"',
    ].join('\r\n');
    expect(parseTasklistWslMemory(output)).toBe(12_345_678 * 1024);
  });

  it('ignores tasklist output when the WSL VM is absent', () => {
    expect(parseTasklistWslMemory('INFO: No tasks are running which match the specified criteria.')).toBeNull();
  });

  it('samples an existing Windows VM process without invoking WSL', async () => {
    let calls = 0;
    const sampler = new SystemStatsSampler(
      async () => {
        calls++;
        return 10 * 1024 ** 3;
      },
      20 * 1024 ** 3,
    );
    const snapshot = await sampler.sample(0);
    expect(calls).toBe(1);
    expect(snapshot.wsl?.memory.usedBytes).toBe(10 * 1024 ** 3);
  });

  it('preserves VM overhead above the configured cap while clamping percentage', async () => {
    const sampler = new SystemStatsSampler(
      async () => 21 * 1024 ** 3,
      20 * 1024 ** 3,
    );
    const snapshot = await sampler.sample(0);
    expect(snapshot.wsl?.memory.usedBytes).toBe(21 * 1024 ** 3);
    expect(snapshot.wsl?.memory.percent).toBe(100);
  });
});
