import { describe, expect, it, vi } from 'vitest';
import { createStartupRecovery } from '../startupRecovery';

describe('startup recovery state (#2393)', () => {
  it('is not done until the background pass is tracked, and done at once when it started nothing', () => {
    const r = createStartupRecovery();
    expect(r.done()).toBe(false);
    r.track([]);
    expect(r.done()).toBe(true);
  });

  it('is done once every promotion settled, a failed one included', async () => {
    let succeed!: () => void;
    let fail!: (err: Error) => void;
    const ok = new Promise<void>((res) => { succeed = res; });
    const bad = new Promise<void>((_, rej) => { fail = rej; });
    const log = vi.fn();
    const r = createStartupRecovery({ log, setTimer: () => undefined });
    r.track([ok, bad]);
    succeed();
    await ok;
    await Promise.resolve();
    expect(r.done()).toBe(false);
    fail(new Error('the distribution did not answer'));
    await bad.catch(() => undefined);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.done()).toBe(true);
    expect(log).toHaveBeenCalledWith('[recovery] background recovery settled (2 pane(s))');
  });

  it('a promotion that never settles is not waited on past the ceiling', () => {
    let fire: (() => void) | null = null;
    const log = vi.fn();
    const r = createStartupRecovery({ ceilingMs: 1_000, log, setTimer: (fn) => { fire = fn; return undefined; } });
    r.track([new Promise(() => undefined)]);
    expect(r.done()).toBe(false);
    (fire as unknown as () => void)();
    expect(r.done()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
