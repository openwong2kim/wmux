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
});
