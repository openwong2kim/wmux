import { describe, it, expect, beforeEach } from 'vitest';
import { HookSignalRouter, DEFAULT_DEDUP_WINDOW_MS } from '../HookSignalRouter';
import { SignalLatencyMeter } from '../SignalLatencyMeter';
import type { AgentSignal } from '../../../../integrations/shared/signal-types';

function makeSignal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/some/dir',
    payload: {},
    ts: 1000,
    ...overrides,
  };
}

describe('HookSignalRouter', () => {
  let meter: SignalLatencyMeter;
  let router: HookSignalRouter;

  beforeEach(() => {
    meter = new SignalLatencyMeter();
    router = new HookSignalRouter({ latencyMeter: meter });
  });

  describe('dedup matrix', () => {
    it('hook-then-detector (same kind, within window): detector deduped', () => {
      const ptyId = 'p1';
      const hookDecision = router.recordHook(makeSignal(), ptyId, 1000);
      expect(hookDecision).toBe('emit');
      const detDecision = router.recordDetector('claude', 'agent.stop', ptyId, 1100);
      expect(detDecision).toBe('dedup');
    });

    it('detector-then-hook (same kind, within window): hook deduped', () => {
      const ptyId = 'p1';
      const detDecision = router.recordDetector('claude', 'agent.stop', ptyId, 1000);
      expect(detDecision).toBe('emit');
      const hookDecision = router.recordHook(makeSignal({ ts: 1100 }), ptyId, 1100);
      expect(hookDecision).toBe('dedup');
    });

    it('both within window, DIFFERENT kinds: both emit', () => {
      const ptyId = 'p1';
      const d1 = router.recordHook(makeSignal({ kind: 'agent.stop' }), ptyId, 1000);
      expect(d1).toBe('emit');
      const d2 = router.recordHook(
        makeSignal({ kind: 'agent.activity', ts: 1100 }),
        ptyId,
        1100,
      );
      expect(d2).toBe('emit');
    });

    it('outside window: both emit', () => {
      const ptyId = 'p1';
      const d1 = router.recordHook(makeSignal({ ts: 0 }), ptyId, 0);
      expect(d1).toBe('emit');
      const d2 = router.recordDetector('claude', 'agent.stop', ptyId, DEFAULT_DEDUP_WINDOW_MS + 1);
      expect(d2).toBe('emit');
    });

    it('different ptyIds: independent ledgers', () => {
      const d1 = router.recordHook(makeSignal(), 'p1', 1000);
      expect(d1).toBe('emit');
      const d2 = router.recordHook(makeSignal({ ts: 1100 }), 'p2', 1100);
      expect(d2).toBe('emit');
    });

    it('different agents on same pty: independent ledgers', () => {
      const ptyId = 'p1';
      const d1 = router.recordHook(makeSignal({ agent: 'claude' }), ptyId, 1000);
      expect(d1).toBe('emit');
      const d2 = router.recordHook(
        makeSignal({ agent: 'codex', ts: 1100 }),
        ptyId,
        1100,
      );
      expect(d2).toBe('emit');
    });
  });

  describe('latency recording — caller responsibility', () => {
    // After the round-3 split (claude review 2026-05-23 P2 #6), latency
    // is NOT recorded inside recordHook. The caller (hooks.rpc.ts)
    // records every signal regardless of dedup outcome. These tests
    // assert the new contract: recordHook itself touches only the
    // dedup ledger.
    it('recordHook does not call latencyMeter', () => {
      router.recordHook(makeSignal({ ts: 1050 }), 'p1', 1100);
      expect(meter.getStats().count).toBe(0);
    });

    it('caller can independently record latency to track every signal', () => {
      // Simulates the hooks.rpc.ts flow: latency first, then dedup.
      meter.recordSignal('claude', 1050, 1100);
      router.recordDetector('claude', 'agent.stop', 'p1', 1000);
      router.recordHook(makeSignal({ ts: 1050 }), 'p1', 1100);
      // Latency was recorded by the caller, not by recordHook.
      expect(meter.getStats().count).toBe(1);
      expect(meter.getStats().p50).toBe(50);
    });

    it('does NOT record latency for detector emissions (no fire time)', () => {
      router.recordDetector('claude', 'agent.stop', 'p1', 1000);
      expect(meter.getStats().count).toBe(0);
    });
  });

  describe('hook updates ledger to source=hook after dedup', () => {
    it('subsequent detector with SAME kind is still deduped (hook claim sticks)', () => {
      const ptyId = 'p1';
      // Detector emits first.
      router.recordDetector('claude', 'agent.stop', ptyId, 1000);
      // Hook deduped but takes over ledger.
      router.recordHook(makeSignal({ ts: 1050 }), ptyId, 1100);
      // Another detector tries at 1200 — should be deduped against hook.
      const d3 = router.recordDetector('claude', 'agent.stop', ptyId, 1200);
      expect(d3).toBe('dedup');
    });
  });

  describe('custom dedup window', () => {
    it('respects shorter custom window', () => {
      const tight = new HookSignalRouter({ latencyMeter: meter, dedupWindowMs: 100 });
      tight.recordHook(makeSignal(), 'p1', 1000);
      // 101ms later → outside window → emit.
      const d2 = tight.recordDetector('claude', 'agent.stop', 'p1', 1101);
      expect(d2).toBe('emit');
    });
  });

  describe('resetForTests', () => {
    it('clears dedup ledger; latency meter is independent', () => {
      // Round-3 split: recordHook no longer touches latency, so the
      // caller is the only path that writes there. Reset only affects
      // the ledger.
      meter.recordSignal('claude', 1000, 1000);
      router.recordHook(makeSignal(), 'p1', 1000);
      router.resetForTests();
      // Caller-recorded latency entry still present.
      expect(meter.getStats().count).toBe(1);
      // But dedup ledger is empty: a detector at 1100 emits.
      const d = router.recordDetector('claude', 'agent.stop', 'p1', 1100);
      expect(d).toBe('emit');
    });
  });
});
