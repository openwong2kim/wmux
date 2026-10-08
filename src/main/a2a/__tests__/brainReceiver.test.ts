import { describe, expect, it } from 'vitest';
import { brainReceiverReady, type BrainReceiverState } from '../brainReceiver';

const READY: BrainReceiverState = { moaEnabled: true, runtimeStarted: true, coalescerReady: true, hqWorkspaceId: 'ws-hq', hqPresent: true };

describe('brainReceiverReady', () => {
  it('only when Moa is on, its runtime and coalescer are up, and the HQ is there and the one the link names', () => {
    expect(brainReceiverReady(READY, 'ws-hq')).toBe(true);
    expect(brainReceiverReady({ ...READY, moaEnabled: false }, 'ws-hq')).toBe(false); // Moa off
    expect(brainReceiverReady({ ...READY, hqWorkspaceId: null, hqPresent: false }, 'ws-hq')).toBe(false); // no HQ
    expect(brainReceiverReady(READY, 'ws-old-hq')).toBe(false); // HQ mismatch
    expect(brainReceiverReady({ ...READY, coalescerReady: false }, 'ws-hq')).toBe(false); // coalescer not ready
    expect(brainReceiverReady({ ...READY, runtimeStarted: false }, 'ws-hq')).toBe(false);
    expect(brainReceiverReady({ ...READY, hqPresent: false }, 'ws-hq')).toBe(false);
  });
});
