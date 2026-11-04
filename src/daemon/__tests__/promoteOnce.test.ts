import { describe, it, expect, vi } from 'vitest';
import { createPromoteOnce, type PromoteResult } from '../promoteOnce';
import { promoteStartedSession } from '../../shared/suspendedSession';

/** A promoteSession whose attempts settle when the test says. */
function controlled() {
  const settles: Array<(r: PromoteResult) => void> = [];
  const promoteSession = vi.fn((params: { id: string; fresh: boolean; credentialEnv?: Record<string, string> }) => new Promise<PromoteResult>((r) => { void params; settles.push(r); }));
  return { promoteSession, settle: (i: number, r: PromoteResult) => settles[i](r) };
}

// #2398 round 7 — only the daemon knows whether a promote call started the
// session or joined an attempt already in flight (the boot background start
// of an exec unit, or another caller's). A stop key must never land in a
// session its own call just started, and must reach one it did not start.
describe('promoteOnce', () => {
  it('a call with nothing in flight starts the session and is not marked joined', async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const first = promoteOnce('s1');
    settle(0, { ok: true, alreadyActive: false });
    expect(await first).toEqual({ ok: true, alreadyActive: false });
    expect(promoteSession).toHaveBeenCalledTimes(1);
  });

  it('a call while the boot background start is in flight joins it and is told so', async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const background = promoteOnce('s1', false, 'background');
    const caller = promoteOnce('s1');
    settle(0, { ok: true, alreadyActive: false });
    expect(await background).toEqual({ ok: true, alreadyActive: false });
    expect(await caller).toEqual({ ok: true, alreadyActive: false, joined: true });
    expect(promoteSession).toHaveBeenCalledTimes(1);
  });

  // Round-8 P3: a raw write's promote spawned the unit; a concurrent stop
  // key's promote:false reconnect joined it and, marked joined, was delivered
  // into the unit just started.
  it("a call that joins another caller's promote is not marked joined: that caller started it", async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const rawWrite = promoteOnce('s1');
    const stopKey = promoteOnce('s1');
    settle(0, { ok: true, alreadyActive: false });
    expect(await rawWrite).toEqual({ ok: true, alreadyActive: false });
    expect(await stopKey).toEqual({ ok: true, alreadyActive: false });
    expect(promoteSession).toHaveBeenCalledTimes(1);
  });

  it('a call after a failed attempt settled starts its own (nothing to join)', async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const background = promoteOnce('s1', false, 'background');
    settle(0, { ok: false, error: { code: 'SPAWN_FAILED', message: 'distro busy' } });
    await background;
    const caller = promoteOnce('s1');
    settle(1, { ok: true, alreadyActive: false });
    expect(await caller).toEqual({ ok: true, alreadyActive: false });
    expect(promoteSession).toHaveBeenCalledTimes(2);
  });

  // Second-model P2-1: a stop key's promote:false reconnect of an exec unit
  // whose background start failed or never covered it spawned the unit, and
  // the caller was told nothing was running to stop.
  describe('join-only (a stop key)', () => {
    it('with nothing in flight starts nothing and says so', async () => {
      const { promoteSession } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession);
      expect(await promoteOnce('s1', false, 'rpc', true)).toEqual({ ok: false, notInFlight: true });
      expect(promoteSession).not.toHaveBeenCalled();
    });

    it('after a failed background start starts nothing', async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession);
      const background = promoteOnce('s1', false, 'background');
      settle(0, { ok: false, error: { code: 'SPAWN_FAILED', message: 'distro down' } });
      await background;
      expect(await promoteOnce('s1', false, 'rpc', true)).toEqual({ ok: false, notInFlight: true });
      expect(promoteSession).toHaveBeenCalledTimes(1);
    });

    it('joins the boot background start in flight and is told so (the key is delivered)', async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession);
      const background = promoteOnce('s1', false, 'background');
      const stopKey = promoteOnce('s1', false, 'rpc', true);
      settle(0, { ok: true, alreadyActive: false });
      await background;
      expect(await stopKey).toEqual({ ok: true, alreadyActive: false, joined: true });
      expect(promoteSession).toHaveBeenCalledTimes(1);
    });

    // Mac review P3-1: the reconcile's promote of a cap-skipped unit finished
    // between a stop key's list (suspended) and its join-only call. "Running"
    // was answered as already active, main attached, and the ctrl+c landed in
    // the unit that call had just started.
    it("nothing in flight but running: a start another caller just ran is answered as that caller's", async () => {
      const { promoteSession, settle } = controlled();
      let running = false;
      const promoteOnce = createPromoteOnce(promoteSession, () => running);
      const reconcile = promoteOnce('s1');
      settle(0, { ok: true, alreadyActive: false });
      await reconcile;
      running = true;
      const answer = await promoteOnce('s1', false, 'rpc', true);
      expect(answer).toEqual({ ok: true, alreadyActive: false });
      expect(promoteStartedSession(answer)).toBe(true);
      expect(promoteSession).toHaveBeenCalledTimes(1);
    });

    it('nothing in flight but running: the boot background start, or a start not run here, is running', async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession, () => true);
      const background = promoteOnce('s1', false, 'background');
      settle(0, { ok: true, alreadyActive: false });
      await background;
      expect(await promoteOnce('s1', false, 'rpc', true)).toEqual({ ok: true, alreadyActive: true });
      // Boot recovery started s2 without an attempt here.
      expect(await promoteOnce('s2', false, 'rpc', true)).toEqual({ ok: true, alreadyActive: true });
      expect(promoteStartedSession({ ok: true, alreadyActive: true })).toBe(false);
    });

    it('forgets who started a session once it leaves', async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession, () => true);
      const caller = promoteOnce('s1');
      settle(0, { ok: true, alreadyActive: false });
      await caller;
      promoteOnce.forget('s1');
      expect(await promoteOnce('s1', false, 'rpc', true)).toEqual({ ok: true, alreadyActive: true });
    });

    it('a failed or already-active attempt records no starter', async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession, () => true);
      const failed = promoteOnce('s1');
      settle(0, { ok: false, error: { code: 'SPAWN_FAILED', message: 'x' } });
      await failed;
      const active = promoteOnce('s2');
      settle(1, { ok: true, alreadyActive: true });
      await active;
      expect(await promoteOnce('s1', false, 'rpc', true)).toEqual({ ok: true, alreadyActive: true });
      expect(await promoteOnce('s2', false, 'rpc', true)).toEqual({ ok: true, alreadyActive: true });
    });

    it("joins another caller's promote unmarked: that caller started it", async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession);
      const rawWrite = promoteOnce('s1');
      const stopKey = promoteOnce('s1', false, 'rpc', true);
      settle(0, { ok: true, alreadyActive: false });
      await rawWrite;
      expect(await stopKey).toEqual({ ok: true, alreadyActive: false });
      expect(promoteSession).toHaveBeenCalledTimes(1);
    });
  });

  it('a start-fresh queued behind an ordinary promote runs its own attempt', async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const ordinary = promoteOnce('s1');
    const fresh = promoteOnce('s1', true);
    settle(0, { ok: false, error: { code: 'CWD_MISSING', message: 'gone' } });
    await ordinary;
    await vi.waitFor(() => expect(promoteSession).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    settle(1, { ok: true, alreadyActive: false });
    expect(await fresh).toEqual({ ok: true, alreadyActive: false });
    expect(promoteSession.mock.calls[1][0]).toEqual({ id: 's1', fresh: true });
  });

  // #3049 — main's promote of a held user shell carries its credentials; the
  // attempt it starts is the one that applies them, and a call that joins an
  // attempt runs with whatever that attempt was started with.
  describe('credentialEnv', () => {
    const CRED = { GH_TOKEN: 'placeholder-3049' };

    it('goes with the attempt the call starts, and only when given', async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession);
      const main = promoteOnce('s1', false, 'rpc', false, CRED);
      settle(0, { ok: true, alreadyActive: false, credentialsApplied: true });
      expect(await main).toEqual({ ok: true, alreadyActive: false, credentialsApplied: true });
      expect(promoteSession.mock.calls[0][0]).toEqual({ id: 's1', fresh: false, credentialEnv: CRED });
      const plain = promoteOnce('s2');
      settle(1, { ok: true, alreadyActive: false });
      await plain;
      expect(promoteSession.mock.calls[1][0]).toEqual({ id: 's2', fresh: false });
    });

    it('the first caller\'s env wins: a second call with other values joins it', async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession);
      const first = promoteOnce('s1', false, 'rpc', false, CRED);
      const second = promoteOnce('s1', false, 'rpc', false, { GH_TOKEN: 'other-placeholder' });
      settle(0, { ok: true, alreadyActive: false, credentialsApplied: true });
      expect(await second).toEqual(await first);
      expect(promoteSession).toHaveBeenCalledTimes(1);
      expect(promoteSession.mock.calls[0][0].credentialEnv).toEqual(CRED);
    });

    it('main joining the fallback start is told it joined, without credentialsApplied', async () => {
      const { promoteSession, settle } = controlled();
      const promoteOnce = createPromoteOnce(promoteSession);
      const fallback = promoteOnce('s1', false, 'background');
      const main = promoteOnce('s1', false, 'rpc', false, CRED);
      settle(0, { ok: true, alreadyActive: false });
      await fallback;
      expect(await main).toEqual({ ok: true, alreadyActive: false, joined: true });
      expect(promoteSession.mock.calls[0][0]).toEqual({ id: 's1', fresh: false });
    });
  });
});
