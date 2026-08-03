import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GateBroker } from '../GateBroker';

describe('GateBroker', () => {
  let broker: GateBroker;

  beforeEach(() => {
    broker = new GateBroker({
      log: () => { /* silent */ },
      now: () => 10_000,
      deadlineMs: 30_000,
    });
  });

  describe('awaitVerdict + notifyResolved (CAS)', () => {
    it('resolves with the phone answer when notifyResolved fires', async () => {
      const verdict = broker.awaitVerdict('gate-1', 'pty-a');
      broker.notifyResolved('gate-1', 'approve');
      expect(await verdict).toEqual({ decision: 'allow', reason: 'answered' });
    });

    it('translates deny to the PreToolUse vocabulary', async () => {
      const verdict = broker.awaitVerdict('gate-2', 'pty-a');
      broker.notifyResolved('gate-2', 'deny');
      expect(await verdict).toEqual({ decision: 'deny', reason: 'answered' });
    });

    it('first resolution wins — a second notifyResolved is a no-op', async () => {
      const verdict = broker.awaitVerdict('gate-3', 'pty-a');
      broker.notifyResolved('gate-3', 'approve');
      // Second call should NOT throw and should NOT change the resolved value.
      broker.notifyResolved('gate-3', 'deny');
      expect(await verdict).toEqual({ decision: 'allow', reason: 'answered' });
    });
  });

  describe('cancel (timeout / expiry)', () => {
    it('defers a single gate', async () => {
      const verdict = broker.awaitVerdict('gate-4', 'pty-a');
      broker.cancel('gate-4', 'gate-timed-out');
      expect(await verdict).toEqual({ decision: 'defer', reason: 'gate-timed-out' });
    });

    it('cancel after notifyResolved is a no-op (waiter already gone)', async () => {
      const verdict = broker.awaitVerdict('gate-5', 'pty-a');
      broker.notifyResolved('gate-5', 'approve');
      broker.cancel('gate-5', 'late-cancel');
      expect(await verdict).toEqual({ decision: 'allow', reason: 'answered' });
    });
  });

  describe('cancelForSession (session:died)', () => {
    it('defers every gate for the dead session', async () => {
      const v1 = broker.awaitVerdict('gate-6', 'pty-a');
      const v2 = broker.awaitVerdict('gate-7', 'pty-a');
      const v3 = broker.awaitVerdict('gate-8', 'pty-b');
      broker.cancelForSession('pty-a', 'pane-gone');
      expect(await v1).toEqual({ decision: 'defer', reason: 'pane-gone' });
      expect(await v2).toEqual({ decision: 'defer', reason: 'pane-gone' });
      // The other session's gate is untouched.
      expect(broker.isWaiting('gate-8')).toBe(true);
      broker.notifyResolved('gate-8', 'approve');
      expect(await v3).toEqual({ decision: 'allow', reason: 'answered' });
    });
  });

  describe('cancelAll (daemon shutdown)', () => {
    it('defers every pending gate', async () => {
      const v1 = broker.awaitVerdict('gate-9', 'pty-a');
      const v2 = broker.awaitVerdict('gate-10', 'pty-b');
      broker.cancelAll('daemon-restart');
      expect(await v1).toEqual({ decision: 'defer', reason: 'daemon-restart' });
      expect(await v2).toEqual({ decision: 'defer', reason: 'daemon-restart' });
      expect(broker.pendingCount()).toBe(0);
    });
  });

  describe('pendingCount / isWaiting', () => {
    it('tracks live waiters', () => {
      expect(broker.pendingCount()).toBe(0);
      broker.awaitVerdict('gate-11', 'pty-a');
      expect(broker.pendingCount()).toBe(1);
      expect(broker.isWaiting('gate-11')).toBe(true);
      broker.notifyResolved('gate-11', 'approve');
      expect(broker.pendingCount()).toBe(0);
      expect(broker.isWaiting('gate-11')).toBe(false);
    });
  });

  // Review findings (3-MODEL panel): each of these was a way the gate lied
  // about its own state or took the daemon down with it.
  describe('review regressions', () => {
    it('expires the approval record whenever it defers a gate', async () => {
      const expired: { id: string; reason: string }[] = [];
      const b = new GateBroker({
        log: () => { /* silent */ },
        deadlineMs: 30_000,
        expireRecord: (id, reason) => expired.push({ id, reason }),
      });
      const verdict = b.awaitVerdict('gate-x', 'pty-a');
      b.cancel('gate-x', 'gate-timed-out');
      await verdict;
      // Without this the card stays pending after the tool already fell through
      // to the local prompt, and a late tap gets a receipt for nothing.
      expect(expired).toEqual([{ id: 'gate-x', reason: 'gate-timed-out' }]);
    });

    it('does NOT expire the record when the phone answered', async () => {
      const expired: string[] = [];
      const b = new GateBroker({
        log: () => { /* silent */ },
        deadlineMs: 30_000,
        expireRecord: (id) => expired.push(id),
      });
      const verdict = b.awaitVerdict('gate-y', 'pty-a');
      b.notifyResolved('gate-y', 'approve');
      expect(await verdict).toEqual({ decision: 'allow', reason: 'answered' });
      expect(expired).toEqual([]);
    });

    it('defers immediately past the pending cap instead of holding a socket', async () => {
      const b = new GateBroker({ log: () => { /* silent */ }, deadlineMs: 30_000, maxPending: 2 });
      b.awaitVerdict('g1', 'pty-a');
      b.awaitVerdict('g2', 'pty-a');
      // Each blocked gate pins a control-plane connection; past the cap the
      // tool goes to the local prompt rather than starving the daemon.
      expect(await b.awaitVerdict('g3', 'pty-a')).toEqual({
        decision: 'defer',
        reason: 'too-many-pending-gates',
      });
      expect(b.pendingCount()).toBe(2);
    });

    it('settles the previous waiter when the same gate id arrives twice', async () => {
      const first = broker.awaitVerdict('dup', 'pty-a');
      const second = broker.awaitVerdict('dup', 'pty-a');
      // The first promise must not be orphaned — it would hang until the bridge
      // gave up on its own.
      expect(await first).toEqual({ decision: 'defer', reason: 'superseded-by-duplicate-gate' });
      broker.notifyResolved('dup', 'approve');
      expect(await second).toEqual({ decision: 'allow', reason: 'answered' });
    });
  });
});
