import { describe, expect, it } from 'vitest';
import { agentLaunchAt } from '../agentLaunchAt';

describe('agentLaunchAt', () => {
  it('takes the later of the command start and the current agent process start', () => {
    expect(agentLaunchAt(1_000, [{ pid: 7, startedAt: 2_000 }], 7)).toBe(2_000);
    expect(agentLaunchAt(3_000, [{ pid: 7, startedAt: 2_000 }], 7)).toBe(3_000);
  });

  it('a shell that reports no command start still has the process start', () => {
    expect(agentLaunchAt(undefined, [undefined, { pid: 7, startedAt: 2_000 }], 7)).toBe(2_000);
  });

  it('a record of another pid is a previous agent and counts for nothing', () => {
    expect(agentLaunchAt(undefined, [{ pid: 6, startedAt: 2_000 }], 7)).toBeUndefined();
    expect(agentLaunchAt(undefined, [{ pid: Number.NaN, startedAt: Number.NaN }], undefined)).toBeUndefined();
    expect(agentLaunchAt(1_000, [{ pid: 6, startedAt: 2_000 }], 7)).toBe(1_000);
  });
});
