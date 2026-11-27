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

  it('transient failures exhaust all retries → keeps the id unconfirmed, never clears (#2398)', async () => {
    const clearPtyId = vi.fn();
    const setUnconfirmed = vi.fn();
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, transient: true, error: 'still not writable' }));
    await reconnectPtyWithRetry('pty-stuck', alwaysCurrent, { reconnect, clearPtyId, setUnconfirmed, onRecoveryError, sleep: noSleep, log: noLog });
    // initial attempt + one per backoff slot
    expect(reconnect).toHaveBeenCalledTimes(RECONNECT_BACKOFFS_MS.length + 1);
    // No attempt said the session is gone: clearing here self-created a fresh
    // shell beside a session that was still alive.
    expect(clearPtyId).not.toHaveBeenCalled();
    expect(setUnconfirmed).toHaveBeenCalledWith('pty-stuck', true);
    // Retry banner, and the flag useTerminal arms its slow reattach on.
    expect(onRecoveryError).toHaveBeenLastCalledWith(expect.stringMatching(/reattach/), { unconfirmed: true });
  });

  it('marks the binding confirmed again once a reattach succeeds (#2398)', async () => {
    const setUnconfirmed = vi.fn();
    const reconnect = vi.fn(async () => ({ success: true }));
    await reconnectPtyWithRetry('pty-1', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), setUnconfirmed, sleep: noSleep, log: noLog });
    expect(setUnconfirmed).toHaveBeenCalledWith('pty-1', false);
  });

  it('a rate-limited give-up keeps the binding unconfirmed too (#2398)', async () => {
    const setUnconfirmed = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, transient: true, error: 'rate limited (global)' }));
    await reconnectPtyWithRetry('pty-busy', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), setUnconfirmed, sleep: noSleep, log: noLog });
    expect(setUnconfirmed).toHaveBeenCalledWith('pty-busy', true);
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

// #2398 — after a failed startup reconcile, a pane's own reattach must not
// clear a binding the reconcile never looked at: the surface's session may
// live on under another id, which only the reconcile can rebind.
describe('reconnectPtyWithRetry — an unconfirmed binding reported gone (#2398)', () => {
  const gone = async () => ({ success: false, transient: false, error: 'Session not found or dead' });

  it('is handed to the reconcile, kept, and waits without a banner', async () => {
    const clearPtyId = vi.fn();
    const onRecoveryError = vi.fn();
    const requestReconcile = vi.fn(() => true);
    await reconnectPtyWithRetry('pty-kept', alwaysCurrent, {
      reconnect: vi.fn(gone), clearPtyId, onRecoveryError, requestReconcile,
      isUnconfirmed: (id) => id === 'pty-kept', sleep: noSleep, log: noLog,
    });
    expect(clearPtyId).not.toHaveBeenCalled();
    expect(requestReconcile).toHaveBeenCalledTimes(1);
    expect(onRecoveryError).toHaveBeenCalledWith(null, { awaitingReconcile: true });
  });

  it('a confirmed binding reported gone still clears at once', async () => {
    const clearPtyId = vi.fn();
    const requestReconcile = vi.fn(() => true);
    await reconnectPtyWithRetry('pty-dead', alwaysCurrent, {
      reconnect: vi.fn(gone), clearPtyId, requestReconcile, isUnconfirmed: () => false, sleep: noSleep, log: noLog,
    });
    expect(clearPtyId).toHaveBeenCalledWith('pty-dead', undefined);
    expect(requestReconcile).not.toHaveBeenCalled();
  });

  it('with nothing to run a reconcile, it clears as before', async () => {
    const clearPtyId = vi.fn();
    await reconnectPtyWithRetry('pty-kept', alwaysCurrent, {
      reconnect: vi.fn(gone), clearPtyId, requestReconcile: () => false, isUnconfirmed: () => true, sleep: noSleep, log: noLog,
    });
    expect(clearPtyId).toHaveBeenCalledWith('pty-kept', undefined);
  });
});

// #2398 — a hidden pane asks without promote; a suspended session answers
// `deferred`. That is an answer, not a failure: the id is kept and nothing
// enters the back-off (which would spend the whole schedule per hidden pane
// and end every one of them exhausted).
describe('reconnectPtyWithRetry — a deferred answer (#2398)', () => {
  it('keeps the id, marks it deferred, and neither retries nor sleeps', async () => {
    const clearPtyId = vi.fn();
    const sleep = vi.fn(noSleep);
    const setDeferred = vi.fn();
    const setUnconfirmed = vi.fn();
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, deferred: true }));
    const got = await reconnectPtyWithRetry('pty-suspended', alwaysCurrent, {
      reconnect, clearPtyId, sleep, log: noLog, setDeferred, setUnconfirmed, onRecoveryError,
    });
    expect(got).toBeNull();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(clearPtyId).not.toHaveBeenCalled();
    expect(setDeferred).toHaveBeenCalledWith('pty-suspended', true);
    expect(setUnconfirmed).toHaveBeenCalledWith('pty-suspended', false);
    expect(onRecoveryError).toHaveBeenCalledWith(null, { deferred: true });
  });

  it('a later attach clears the deferred mark', async () => {
    const setDeferred = vi.fn();
    const reconnect = vi.fn(async () => ({ success: true }));
    await reconnectPtyWithRetry('pty-suspended', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), sleep: noSleep, log: noLog, setDeferred });
    expect(setDeferred).toHaveBeenCalledWith('pty-suspended', false);
  });
});

// #2398 §6-4 option B: the deferred answer carries what the session would
// resume, so the pane can resume it on start.
describe('reconnectPtyWithRetry — a deferred answer with a resume binding', () => {
  it('hands the binding to the settle callback', async () => {
    const onRecoveryError = vi.fn();
    const resumeBinding = { agent: 'claude', sessionId: '0c8f6a52-6c1b-4b6e-9a51-2f0d3c4b5a69', cwd: '/home/me/p', ts: 1 };
    const reconnect = vi.fn(async () => ({ success: false, deferred: true, resumeBinding }));
    await reconnectPtyWithRetry('pty-suspended', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), sleep: noSleep, log: noLog, onRecoveryError });
    expect(onRecoveryError).toHaveBeenCalledWith(null, { deferred: true, resume: { resumeAgent: undefined, resumeBinding } });
  });
});

// #2398 round 5 — a stop key that joined the pane's own attempt must know
// whether that attempt started the session (promoted a suspended one).
describe('reconnectPtyWithRetry — an attach that started the session (#2398)', () => {
  it('settles attached and says it promoted', async () => {
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn(async () => ({ success: true, promoted: true }));
    await reconnectPtyWithRetry('pty-promoted', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), onRecoveryError, sleep: noSleep, log: noLog });
    expect(onRecoveryError).toHaveBeenCalledWith(null, { promoted: true });
  });

  // Round-6 P3: the promote succeeded, its attach failed transiently, and the
  // retry attached the now running session without saying it was started.
  it('says it promoted when an earlier try promoted and a retry attached', async () => {
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn()
      .mockResolvedValueOnce({ success: false, transient: true, promoted: true, error: 'Session pipe not writable after reconnect' })
      .mockResolvedValueOnce({ success: true });
    await reconnectPtyWithRetry('pty-promoted-retry', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), onRecoveryError, sleep: noSleep, log: noLog });
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(onRecoveryError).toHaveBeenCalledWith(null, { promoted: true });
  });

  // Round-7 P3: a give-up after the start (retries exhausted) still says
  // this attempt started the session.
  it('a give-up after a promote still says it promoted', async () => {
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn()
      .mockResolvedValueOnce({ success: false, transient: true, promoted: true, error: 'Session pipe not writable after reconnect' })
      .mockResolvedValue({ success: false, transient: true, error: 'Session pipe not writable after reconnect' });
    await reconnectPtyWithRetry('pty-promoted-gave-up', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), onRecoveryError, sleep: noSleep, log: noLog });
    expect(onRecoveryError).toHaveBeenLastCalledWith('wmux could not reattach this terminal yet.', { unconfirmed: true, promoted: true });
  });

  it('a rate-limited give-up after a promote still says it promoted', async () => {
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn()
      .mockResolvedValueOnce({ success: false, transient: true, promoted: true, error: 'rate limit exceeded' })
      .mockResolvedValue({ success: false, transient: true, error: 'rate limit exceeded' });
    await reconnectPtyWithRetry('pty-promoted-busy', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), onRecoveryError, sleep: noSleep, log: noLog });
    expect(onRecoveryError).toHaveBeenLastCalledWith('wmux is busy and could not reattach this terminal yet.', { rateLimited: true, promoted: true });
  });

  // Round-8 P3: the promote succeeded, then main's refresh threw and it
  // answered recoveryPending: that settle still says this attempt started it.
  it('a recovery failure after a promote still says it promoted', async () => {
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn(async () => ({ success: false, recoveryPending: true, promoted: true, error: 'listSessions failed' }));
    await reconnectPtyWithRetry('pty-promoted-pending', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), onRecoveryError, sleep: noSleep, log: noLog });
    expect(onRecoveryError).toHaveBeenLastCalledWith('listSessions failed', { cwdMissing: false, promoted: true });
  });

  it('an attach of a running session settles as before', async () => {
    const onRecoveryError = vi.fn();
    const reconnect = vi.fn(async () => ({ success: true }));
    await reconnectPtyWithRetry('pty-live', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), onRecoveryError, sleep: noSleep, log: noLog });
    expect(onRecoveryError).toHaveBeenCalledWith(null);
  });
});

// #3443 — a daemon-recovered session whose folder was gone started in home;
// the reconnect that attaches it is where the pane learns which folder.
describe('reconnectPtyWithRetry — lost folder', () => {
  it('hands the lost folder of an attached session to onLostCwd', async () => {
    const onLostCwd = vi.fn();
    const reconnect = vi.fn(async () => ({ success: true, lostCwd: '/gone/project' }));
    await reconnectPtyWithRetry('pty-home', alwaysCurrent, { reconnect, clearPtyId: vi.fn(), onLostCwd, sleep: noSleep, log: noLog });
    expect(onLostCwd).toHaveBeenCalledWith('pty-home', '/gone/project');
  });
});
