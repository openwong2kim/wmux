import { describe, expect, it } from 'vitest';
import { killProcessTreePosix, type TreeKillDeps } from '../treeKill';

function fake(scans: Array<Array<[number, number]>>) {
  const signals: Array<[number, NodeJS.Signals]> = [];
  let i = 0;
  const deps: TreeKillDeps = {
    listProcesses: async () => scans[Math.min(i++, scans.length - 1)],
    signal: (pid, sig) => { signals.push([pid, sig]); },
  };
  return { deps, signals };
}

describe('killProcessTreePosix', () => {
  it('freezes, rescans for a child forked after the first scan, then kills all plus the group', async () => {
    const { deps, signals } = fake([
      [[100, 1], [101, 100]],
      [[100, 1], [101, 100], [102, 101]],
      [[100, 1], [101, 100], [102, 101]],
    ]);
    await killProcessTreePosix(100, deps);
    const killed = signals.filter(([, s]) => s === 'SIGKILL').map(([p]) => p);
    expect(killed).toEqual([102, 101, 100, -100, 100]);
    expect(signals.filter(([, s]) => s === 'SIGSTOP').map(([p]) => p)).toEqual([100, 101, 102]);
  });

  it('still kills the process group and root when ps fails', async () => {
    const { signals } = fake([]);
    const deps: TreeKillDeps = {
      listProcesses: async () => { throw new Error('ps missing'); },
      signal: (pid, sig) => { signals.push([pid, sig]); },
    };
    await killProcessTreePosix(200, deps);
    expect(signals).toEqual([[-200, 'SIGKILL'], [200, 'SIGKILL']]);
  });
});
