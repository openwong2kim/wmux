import { describe, it, expect, vi } from 'vitest';
import { reconnectPtyWithRetry, RECONNECT_BACKOFFS_MS, RATE_LIMIT_EXTRA_BACKOFFS_MS, RECONNECT_JITTER } from '../reconnectPtyWithRetry';

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

  it('success hands back the session geometry the daemon reported (#1847)', async () => {
    const reconnect = vi.fn(async () => ({ success: true, cols: 283, rows: 81 }));
    const got = await reconnectPtyWithRetry('pty-1', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), sleep: noSleep, log: noLog });
    expect(got).toEqual({ cols: 283, rows: 81 });
  });

  it('a reconnect that lands after its terminal was replaced hands back no geometry (#1852)', async () => {
    // The pane swapped to another session while this RPC was in flight; the
    // stale result must not resize whatever terminal is current now.
    let current = true;
    const reconnect = vi.fn(async () => {
      current = false;
      return { success: true, cols: 283, rows: 81 };
    });
    const got = await reconnectPtyWithRetry('pty-old', () => current, { reconnect, clearPtyId: vi.fn(), sleep: noSleep, log: noLog });
    expect(got).toBeNull();
  });

  it('permanent failure (transient:false) → clears immediately, no retry', async () => {
    const clearPtyId = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, transient: false, error: 'Session not found or dead' }));
    await reconnectPtyWithRetry('pty-dead', alwaysCurrent, { reconnect, clearPtyId, sleep: noSleep, log: noLog });
    expect(reconnect).toHaveBeenCalledTimes(1); // no retry on permanent
    expect(clearPtyId).toHaveBeenCalledWith('pty-dead', undefined);
  });

  it('passes dead-session recovery metadata into the clear path', async () => {
    const clearPtyId = vi.fn();
    const recovery = { spawnCwd: 'D:\\repo', cwd: 'D:\\live' };
    const reconnect = vi.fn(async () => ({
      success: false,
      transient: false,
      error: 'Session is dead',
      recovery,
    }));

    await reconnectPtyWithRetry('pty-dead', alwaysCurrent, { reconnect, clearPtyId, sleep: noSleep, log: noLog });

    expect(clearPtyId).toHaveBeenCalledWith('pty-dead', recovery);
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

  it('a rate-limited daemon never costs the live PTY: longer retries, then pending instead of clearing', async () => {
    const clearPtyId = vi.fn();
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, transient: true, error: 'rate limited (global)' }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    await reconnectPtyWithRetry('pty-busy', alwaysCurrent, { reconnect, clearPtyId, onRecoveryError, sleep, log: noLog, random: () => 0.5 });
    expect(reconnect).toHaveBeenCalledTimes(RECONNECT_BACKOFFS_MS.length + RATE_LIMIT_EXTRA_BACKOFFS_MS.length + 1);
    expect(clearPtyId).not.toHaveBeenCalled();
    // The pane stays attach-pending behind the Retry banner.
    expect(onRecoveryError).toHaveBeenLastCalledWith(expect.stringMatching(/busy/), { rateLimited: true });
    const total = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    // Bounded: the whole wait stays under ~10s (random 0.5 = no jitter here).
    expect(total).toBe([...RECONNECT_BACKOFFS_MS, ...RATE_LIMIT_EXTRA_BACKOFFS_MS].reduce((a, b) => a + b, 0));
    expect(total).toBeLessThanOrEqual(10_000);
  });

  it('a rate limit earlier in the run still blocks the clear when a later attempt fails differently', async () => {
    const clearPtyId = vi.fn();
    let calls = 0;
    const reconnect = vi.fn(async () => {
      calls++;
      return calls === 1
        ? { success: false, transient: true, error: 'rate limited' }
        : { success: false, transient: true, error: 'Session pipe not writable after reconnect' };
    });
    await reconnectPtyWithRetry('pty-mixed', alwaysCurrent, { reconnect, clearPtyId, sleep: noSleep, log: noLog });
    expect(clearPtyId).not.toHaveBeenCalled();
  });

  it('a rate-limited run recovers once the daemon has room again', async () => {
    const clearPtyId = vi.fn();
    const onRecoveryError = vi.fn();
    let calls = 0;
    const reconnect = vi.fn(async () => {
      calls++;
      return calls <= 5 ? { success: false, transient: true, error: 'rate limited' } : { success: true };
    });
    await reconnectPtyWithRetry('pty-burst', alwaysCurrent, { reconnect, clearPtyId, onRecoveryError, sleep: noSleep, log: noLog });
    expect(reconnect).toHaveBeenCalledTimes(6);
    expect(clearPtyId).not.toHaveBeenCalled();
    expect(onRecoveryError).toHaveBeenLastCalledWith(null);
  });

  it('jitters each backoff slot within ±RECONNECT_JITTER', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const reconnect = vi.fn(async () => ({ success: false, transient: true, error: 'still not writable' }));
    await reconnectPtyWithRetry('pty-j', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), sleep, log: noLog, random: () => 0 });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(RECONNECT_BACKOFFS_MS.map((ms) => Math.round(ms * (1 - RECONNECT_JITTER))));
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

 it('retains a failed WSL recovery and reports the error until an explicit retry succeeds', async () => {
   const clearPtyId = vi.fn(); const onRecoveryError = vi.fn();
   const reconnect = vi.fn().mockResolvedValueOnce({ success: false, recoveryPending: true, error: 'Distro unavailable' }).mockResolvedValueOnce({ success: true });
   const deps = { reconnect, clearPtyId, onRecoveryError, sleep: noSleep };
   await reconnectPtyWithRetry('saved-pane', alwaysCurrent, deps);
   expect(reconnect).toHaveBeenCalledTimes(1);
   expect(clearPtyId).not.toHaveBeenCalled();
   // #1305 — an ordinary pending recovery is NOT a missing directory: Retry is
   // the only offer, and the banner must not grow a second action for it.
   expect(onRecoveryError).toHaveBeenLastCalledWith('Distro unavailable', { cwdMissing: false });
   await reconnectPtyWithRetry('saved-pane', alwaysCurrent, deps);
   expect(onRecoveryError).toHaveBeenLastCalledWith(null);
   expect(clearPtyId).not.toHaveBeenCalled();
 });

 // #1305 — the one pending failure Retry cannot clear. The flag rides the
 // result rather than being read out of the message: that text is the
 // distro's, and parsing it would be wrong in every language but one.
 it('reports a missing WSL directory so the banner can offer a fresh start', async () => {
   const clearPtyId = vi.fn(); const onRecoveryError = vi.fn();
   const reconnect = vi.fn(async () => ({
     success: false,
     recoveryPending: true,
     cwdMissing: true,
     error: 'The directory "/home/dev/gone" no longer exists in Ubuntu.',
   }));
   await reconnectPtyWithRetry('saved-pane', alwaysCurrent, { reconnect, clearPtyId, onRecoveryError, sleep: noSleep });
   expect(onRecoveryError).toHaveBeenLastCalledWith(
     'The directory "/home/dev/gone" no longer exists in Ubuntu.',
     { cwdMissing: true },
   );
   // Still non-destructive: the pane keeps its id and its scrollback, which is
   // the whole point of offering the fresh start instead of a close.
   expect(clearPtyId).not.toHaveBeenCalled();
 });
