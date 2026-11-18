// @wmux-lane unit
// "win32" here is a platform argument and the module load is injected:
// nothing is loaded from disk, so the OS cannot change the result.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brokerHostsSessionsHere, brokerNativePipe, NATIVE_PIPE_RETRY_MS, resetBrokerNativePipeForTests } from '../brokerNativePipe';
import type { NativePipeModule } from '../../../mcp/nativePipe';

// Whether the broker can host sessions in this app: the platform rule plus,
// on Windows, the native pipe listener: a load kept once it worked, tried
// again after a while when it failed.

afterEach(() => resetBrokerNativePipeForTests());

const MODULE = { NativePipeListener: class {}, nativePipeOwnedByUs: () => 'none' } as unknown as NativePipeModule;

describe('brokerNativePipe', () => {
  it('keeps a failure for the retry interval, then loads again', () => {
    let clock = 1_000_000;
    const now = () => clock;
    const load = vi.fn<() => NativePipeModule | null>(() => { throw new Error('Native terminal core lacks pipe-listener-v2'); });
    expect(brokerNativePipe(load, now)).toEqual({ module: null, error: 'Native terminal core lacks pipe-listener-v2' });
    clock += NATIVE_PIPE_RETRY_MS - 1;
    expect(brokerNativePipe(load, now)).toEqual({ module: null, error: 'Native terminal core lacks pipe-listener-v2' });
    expect(load).toHaveBeenCalledTimes(1);
    clock += 1;
    load.mockImplementation(() => MODULE);
    expect(brokerNativePipe(load, now)).toEqual({ module: MODULE, error: null });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps a module that loaded for the whole run', () => {
    let clock = 0;
    const load = vi.fn(() => MODULE);
    expect(brokerNativePipe(load, () => clock)).toEqual({ module: MODULE, error: null });
    clock += 10 * NATIVE_PIPE_RETRY_MS;
    expect(brokerNativePipe(load, () => clock)).toEqual({ module: MODULE, error: null });
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('brokerHostsSessionsHere', () => {
  it('is true off Windows whatever the module', () => {
    brokerNativePipe(() => null);
    expect(brokerHostsSessionsHere('darwin')).toBe(true);
    expect(brokerHostsSessionsHere('linux')).toBe(true);
  });

  it('on Windows follows whether the native pipe listener loaded', () => {
    brokerNativePipe(() => MODULE);
    expect(brokerHostsSessionsHere('win32')).toBe(true);
    resetBrokerNativePipeForTests();
    brokerNativePipe(() => { throw new Error('no core'); });
    expect(brokerHostsSessionsHere('win32')).toBe(false);
  });
});
