// @wmux-lane unit
// "win32" here is a platform argument and the module load is injected:
// nothing is loaded from disk, so the OS cannot change the result.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brokerHostsSessionsHere, brokerNativePipe, resetBrokerNativePipeForTests } from '../brokerNativePipe';
import type { NativePipeModule } from '../../../mcp/nativePipe';

// Whether the broker can host sessions in this app: the platform rule plus,
// on Windows, the native pipe listener, loaded once per app run.

afterEach(() => resetBrokerNativePipeForTests());

const MODULE = { NativePipeListener: class {}, nativePipeOwnedByUs: () => 'none' } as unknown as NativePipeModule;

describe('brokerNativePipe', () => {
  it('loads once and keeps the answer, a failure included', () => {
    const load = vi.fn(() => { throw new Error('Native terminal core lacks pipe-listener-v2'); });
    expect(brokerNativePipe(load)).toEqual({ module: null, error: 'Native terminal core lacks pipe-listener-v2' });
    expect(brokerNativePipe(load)).toEqual({ module: null, error: 'Native terminal core lacks pipe-listener-v2' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a module that loads is kept', () => {
    expect(brokerNativePipe(() => MODULE)).toEqual({ module: MODULE, error: null });
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
