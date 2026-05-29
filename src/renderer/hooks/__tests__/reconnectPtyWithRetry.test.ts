import { describe, it, expect, vi } from 'vitest';
import { reconnectPtyWithRetry, RECONNECT_BACKOFFS_MS } from '../reconnectPtyWithRetry';

// RCA A1 regression suite. The bug: any pty.reconnect failure immediately
// cleared the ptyId, replacing a live session with an empty one. These tests
// lock in the non-destructive contract.

const noSleep = () => Promise.resolve();
const alwaysCurrent = () => true;
const noLog = () => { /* silent in tests */ };

describe('reconnectPtyWithRetry (RCA A1 non-destructive contract)', () => {
  it('success on first try → never clears the ptyId', async () => {
    const clearPtyId = vi.fn();
    const reconnect = vi.fn(async () => ({ success: true }));
    await reconnectPtyWithRetry('pty-1', alwaysCurrent, { reconnect, clearPtyId, sleep: noSleep, log: noLog });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(clearPtyId).not.toHaveBeenCalled();
  });

  it('permanent failure (transient:false) → clears immediately, no retry', async () => {
    const clearPtyId = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, transient: false, error: 'Session not found or dead' }));
    await reconnectPtyWithRetry('pty-dead', alwaysCurrent, { reconnect, clearPtyId, sleep: noSleep, log: noLog });
    expect(reconnect).toHaveBeenCalledTimes(1); // no retry on permanent
    expect(clearPtyId).toHaveBeenCalledWith('pty-dead');
  });

  it('transient failure then success → retries and PRESERVES the session (never clears)', async () => {
    const clearPtyId = vi.fn();
    let calls = 0;
    const reconnect = vi.fn(async () => {
      calls++;
      return calls === 1
        ? { success: false, transient: true, error: 'Session pipe not writable after reconnect' }
        : { success: true };
    });
    await reconnectPtyWithRetry('pty-live', alwaysCurrent, { reconnect, clearPtyId, sleep: noSleep, log: noLog });
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(clearPtyId).not.toHaveBeenCalled(); // the whole point: live session survives a transient blip
  });

  it('a thrown RPC is treated as transient → retried, not cleared on first failure', async () => {
    const clearPtyId = vi.fn();
    let calls = 0;
    const reconnect = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('handler swap: no handler registered');
      return { success: true };
    });
    await reconnectPtyWithRetry('pty-swap', alwaysCurrent, { reconnect, clearPtyId, sleep: noSleep, log: noLog });
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(clearPtyId).not.toHaveBeenCalled();
  });

  it('transient failures exhaust all retries → clears as last resort', async () => {
    const clearPtyId = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, transient: true, error: 'still not writable' }));
    await reconnectPtyWithRetry('pty-stuck', alwaysCurrent, { reconnect, clearPtyId, sleep: noSleep, log: noLog });
    // initial attempt + one per backoff slot
    expect(reconnect).toHaveBeenCalledTimes(RECONNECT_BACKOFFS_MS.length + 1);
    expect(clearPtyId).toHaveBeenCalledWith('pty-stuck');
  });

  it('terminal unmounts mid-retry → bails without clearing', async () => {
    const clearPtyId = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, transient: true }));
    let alive = true;
    const isCurrent = () => alive;
    // After the first failed attempt, simulate unmount before the next loop turn.
    const sleep = vi.fn(async () => { alive = false; });
    await reconnectPtyWithRetry('pty-unmount', isCurrent, { reconnect, clearPtyId, sleep, log: noLog });
    expect(clearPtyId).not.toHaveBeenCalled(); // never mutate a torn-down terminal
  });
});
