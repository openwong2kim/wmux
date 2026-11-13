import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_BROKER_READY_TIMEOUT_MS, startBrokerAndRegister } from '../brokerBoot';

/** A supervisor whose broker never becomes ready until `settle` is called. */
function neverReady() {
  let settle: (ready: boolean) => void = () => undefined;
  const supervisor = {
    start: vi.fn(),
    whenReady: vi.fn((timeoutMs: number) => new Promise<boolean>((resolve) => {
      settle = resolve;
      setTimeout(() => resolve(false), timeoutMs);
    })),
  };
  return { supervisor, settle: (ready: boolean) => settle(ready) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('startBrokerAndRegister', () => {
  it('flag off: registers at once and starts no broker', async () => {
    const { supervisor } = neverReady();
    const register = vi.fn(() => Promise.resolve());
    await startBrokerAndRegister({ brokerEnabled: false, packaged: true, supervisor, register });
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.whenReady).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith();
  });

  it('packaged, flag on, a broker that never becomes ready: starts it and registers without waiting', async () => {
    const { supervisor } = neverReady();
    const register = vi.fn(() => Promise.resolve());
    // Resolves with no timer advanced: nothing waits on the broker.
    await startBrokerAndRegister({ brokerEnabled: true, packaged: true, supervisor, register });
    expect(supervisor.start).toHaveBeenCalledTimes(1);
    expect(supervisor.whenReady).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith();
  });

  it('dev, flag on: waits for the broker and registers the shim when it answers', async () => {
    const { supervisor, settle } = neverReady();
    const register = vi.fn(() => Promise.resolve());
    const done = startBrokerAndRegister({ brokerEnabled: true, packaged: false, supervisor, register });
    await vi.advanceTimersByTimeAsync(100);
    expect(register).not.toHaveBeenCalled();
    settle(true);
    await done;
    expect(supervisor.whenReady).toHaveBeenCalledWith(DEV_BROKER_READY_TIMEOUT_MS);
    expect(register).toHaveBeenCalledWith({ useShim: true });
  });

  it('dev, flag on, a broker that never becomes ready: registers the bundle after the timeout', async () => {
    const { supervisor } = neverReady();
    const register = vi.fn(() => Promise.resolve());
    const done = startBrokerAndRegister({ brokerEnabled: true, packaged: false, supervisor, register });
    await vi.advanceTimersByTimeAsync(DEV_BROKER_READY_TIMEOUT_MS - 1);
    expect(register).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(register).toHaveBeenCalledWith({ useShim: false });
  });
});
