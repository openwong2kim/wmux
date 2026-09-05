import { describe, it, expect, beforeEach } from 'vitest';
import { HookSignalRouter, DEFAULT_DEDUP_WINDOW_MS, HOOK_AUTHORITY_TTL_MS } from '../HookSignalRouter';
import { SignalLatencyMeter } from '../SignalLatencyMeter';
import type { AgentSignal } from '../signal-types';

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

    it('detector-then-detector (same kind, within window): second deduped (Aider complete+waiting case)', () => {
      // Aider emits status='complete' on "Applied edit to ..." then
      // status='waiting' on the "aider> " prompt for one turn. Both
      // collapse to kind='agent.stop' inside PTYBridge — without dedup
      // here, both stream `decision:'emit'` and an orchestrator filtering
      // on emit would run follow-up twice (codex round-3 P2).
      const ptyId = 'p1';
      const d1 = router.recordDetector('claude', 'agent.stop', ptyId, 1000);
      expect(d1).toBe('emit');
      const d2 = router.recordDetector('claude', 'agent.stop', ptyId, 2000);
      expect(d2).toBe('dedup');
    });

    it('detector-then-detector (same kind, OUTSIDE window): both emit', () => {
      const ptyId = 'p1';
      const d1 = router.recordDetector('claude', 'agent.stop', ptyId, 0);
      expect(d1).toBe('emit');
      const d2 = router.recordDetector('claude', 'agent.stop', ptyId, DEFAULT_DEDUP_WINDOW_MS + 1);
      expect(d2).toBe('emit');
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

  describe('dropPty', () => {
    it('removes every entry for the given ptyId, keeps other PTYs intact', () => {
      // Populate ledger across two PTYs, multiple agents and kinds.
      router.recordDetector('claude', 'agent.stop', 'pty-a', 1000);
      router.recordDetector('claude', 'agent.activity', 'pty-a', 1000);
      router.recordDetector('codex', 'agent.stop', 'pty-a', 1000);
      router.recordDetector('claude', 'agent.stop', 'pty-b', 1000);

      const removed = router.dropPty('pty-a');
      expect(removed).toBe(3);

      // pty-a entries gone — fresh emit decision allowed within window.
      expect(router.recordDetector('claude', 'agent.stop', 'pty-a', 1100)).toBe('emit');
      expect(router.recordDetector('codex', 'agent.stop', 'pty-a', 1100)).toBe('emit');

      // pty-b entry preserved — same kind within window still deduped.
      expect(router.recordDetector('claude', 'agent.stop', 'pty-b', 1100)).toBe('dedup');
    });

    it('returns 0 for an unknown ptyId and never throws on empty input', () => {
      expect(router.dropPty('never-seen')).toBe(0);
      expect(router.dropPty('')).toBe(0);
    });

    it('does not partial-match prefixes (substring guard)', () => {
      // Guard against accidental prefix collisions — if dropPty used
      // `startsWith(ptyId)` or similar, dropping `p1` would nuke `p10`.
      router.recordDetector('claude', 'agent.stop', 'p1', 1000);
      router.recordDetector('claude', 'agent.stop', 'p10', 1000);

      expect(router.dropPty('p1')).toBe(1);

      // p10 entry survives, same kind within window still deduped.
      expect(router.recordDetector('claude', 'agent.stop', 'p10', 1100)).toBe('dedup');
    });
  });

  describe('turn-start latch (who writes the running dot)', () => {
    it('an untouched pane keeps the byte heuristic', () => {
      expect(router.governsRunningState('p1', 1000)).toBe(false);
    });

    it('is NOT implied by authority — a bridge can be alive and never report a turn start', () => {
      // The exact case an older plugin (< 0.4.0) or a turn-end-only
      // integration produces. Muting the heuristic here would leave the pane
      // with no running source at all.
      router.touchAuthority('p1', 'claude', 1000);
      expect(router.isGovernedFor('p1', 'claude', 2000)).toBe(true);
      expect(router.governsRunningState('p1', 2000)).toBe(false);
    });

    it('a reported turn start claims the dot for the hook', () => {
      router.noteHookTurnStart('p1', 1000);
      expect(router.governsRunningState('p1', 2000)).toBe(true);
    });

    it('expires on the authority TTL, so a dead bridge hands the pane back', () => {
      router = new HookSignalRouter({ latencyMeter: meter, authorityTtlMs: 5_000 });
      router.noteHookTurnStart('p1', 1000);
      expect(router.governsRunningState('p1', 5_999)).toBe(true);
      expect(router.governsRunningState('p1', 6_000)).toBe(false);
    });

    it('dropPty releases it immediately, so a reused id does not inherit it', () => {
      router.noteHookTurnStart('p1', 1000);
      router.dropPty('p1');
      expect(router.governsRunningState('p1', 1100)).toBe(false);
    });

    it('is scoped to the pane', () => {
      router.noteHookTurnStart('p1', 1000);
      expect(router.governsRunningState('p2', 1100)).toBe(false);
    });
  });

  describe('hook authority (detector veto)', () => {
    it('untouched pane is not governed', () => {
      expect(router.isGovernedFor('p1', 'claude', 1000)).toBe(false);
    });

    it('touchAuthority governs the SAME agent on that pane only', () => {
      router.touchAuthority('p1', 'claude', 1000);
      expect(router.isGovernedFor('p1', 'claude', 2000)).toBe(true);
      // Different agent on the same pane: the claude bridge can't speak
      // for a codex session — detector stays authoritative there.
      expect(router.isGovernedFor('p1', 'codex', 2000)).toBe(false);
      // Different pane entirely.
      expect(router.isGovernedFor('p2', 'claude', 2000)).toBe(false);
    });

    it('authority expires after the TTL (bridge killed without a Stop)', () => {
      router = new HookSignalRouter({ latencyMeter: meter, authorityTtlMs: 5_000 });
      router.touchAuthority('p1', 'claude', 1000);
      expect(router.isGovernedFor('p1', 'claude', 5_999)).toBe(true);
      expect(router.isGovernedFor('p1', 'claude', 6_000)).toBe(false);
    });

    it('a fresh touch renews the TTL', () => {
      router = new HookSignalRouter({ latencyMeter: meter, authorityTtlMs: 5_000 });
      router.touchAuthority('p1', 'claude', 1000);
      router.touchAuthority('p1', 'claude', 5_000);
      expect(router.isGovernedFor('p1', 'claude', 9_999)).toBe(true);
    });

    it('a later agent takes over the pane authority (last writer wins)', () => {
      router.touchAuthority('p1', 'claude', 1000);
      router.touchAuthority('p1', 'codex', 2000);
      expect(router.isGovernedFor('p1', 'claude', 2100)).toBe(false);
      expect(router.isGovernedFor('p1', 'codex', 2100)).toBe(true);
    });

    it('#935 governsDetectorStatus covers waiting/complete on a governed pane', () => {
      router.touchAuthority('p1', 'claude', 1000);
      expect(router.governsDetectorStatus('p1', 'claude', 'waiting', 2000)).toBe(true);
      expect(router.governsDetectorStatus('p1', 'claude', 'complete', 2000)).toBe(true);
    });

    it('#935 SessionStart alone does not hand the lifecycle to the hook', () => {
      // The bridge is alive but has never written a lifecycle status, so the
      // detector's read is all the roster has. Withholding it left a freshly
      // launched agent showing the gate's one-shot `running` while it sat at
      // its prompt — live-measured at 30+ seconds per launch.
      router.touchAuthority('p1', 'claude', 1000, true, 'agent.session_start');
      expect(router.isGovernedFor('p1', 'claude', 2000)).toBe(true);
      expect(router.governsDetectorStatus('p1', 'claude', 'waiting', 2000)).toBe(false);
    });

    it('#935 any signal after SessionStart hands the lifecycle back to the hook', () => {
      // Including the turn END: the post-Stop veto is what stops a detector
      // repaint from double-toasting a completion the hook already announced.
      for (const kind of ['agent.activity', 'agent.stop', 'agent.subagent_stop'] as const) {
        router.resetForTests();
        router.touchAuthority('p1', 'claude', 1000, true, 'agent.session_start');
        router.touchAuthority('p1', 'claude', 2000, true, kind);
        expect(router.governsDetectorStatus('p1', 'claude', 'waiting', 2100)).toBe(true);
      }
    });

    it('#935 a relaunch in the same pane returns the lifecycle to the detector', () => {
      router.touchAuthority('p1', 'claude', 1000, true, 'agent.stop');
      expect(router.governsDetectorStatus('p1', 'claude', 'waiting', 1100)).toBe(true);
      router.touchAuthority('p1', 'claude', 2000, true, 'agent.session_start');
      expect(router.governsDetectorStatus('p1', 'claude', 'waiting', 2100)).toBe(false);
    });

    it('#935 governsDetectorStatus spares awaiting_input and running', () => {
      router.touchAuthority('p1', 'claude', 1000);
      // Approval prompts have no hook (PreToolUse is wired for AskUserQuestion
      // only), so the detector is their sole source — withholding this status
      // would leave a blocked pane looking idle for the full authority TTL.
      expect(router.governsDetectorStatus('p1', 'claude', 'awaiting_input', 2000)).toBe(false);
      // 'running' is a working cue, not a turn boundary.
      expect(router.governsDetectorStatus('p1', 'claude', 'running', 2000)).toBe(false);
    });

    it('#935 governsDetectorStatus is false without authority, slug, or a matching agent', () => {
      expect(router.governsDetectorStatus('p1', 'claude', 'waiting', 2000)).toBe(false);
      router.touchAuthority('p1', 'claude', 1000);
      expect(router.governsDetectorStatus('p1', null, 'waiting', 2000)).toBe(false);
      expect(router.governsDetectorStatus('p1', undefined, 'waiting', 2000)).toBe(false);
      // A different agent on the same pane is a genuinely distinct source.
      expect(router.governsDetectorStatus('p1', 'codex', 'waiting', 2000)).toBe(false);
      // Past the authority TTL the detector is the backstop again.
      expect(router.governsDetectorStatus('p1', 'claude', 'waiting', 1000 + HOOK_AUTHORITY_TTL_MS)).toBe(false);
    });

    it('dropPty releases authority immediately (pane disposal)', () => {
      router.touchAuthority('p1', 'claude', 1000);
      router.dropPty('p1');
      expect(router.isGovernedFor('p1', 'claude', 1100)).toBe(false);
    });

    it('resetForTests clears authority alongside the ledger', () => {
      router.touchAuthority('p1', 'claude', 1000);
      router.resetForTests();
      expect(router.isGovernedFor('p1', 'claude', 1100)).toBe(false);
    });

    it('#919 authorityAgentFor reports slug, age and routing provenance', () => {
      router.touchAuthority('p1', 'claude', 1000);
      router.touchAuthority('p2', 'codex', 1000, false); // cwd-fallback routed
      expect(router.authorityAgentFor('p1', 4000)).toEqual({ slug: 'claude', ageMs: 3000, exact: true });
      expect(router.authorityAgentFor('p2', 4000)).toEqual({ slug: 'codex', ageMs: 3000, exact: false });
      expect(router.authorityAgentFor('p3', 4000)).toBeUndefined();
      // Non-slug agents (unknown future spellings) carry no identity weight.
      expect(router.touchAuthority('p4', 'agent-nine', 1000)).toBeUndefined();
      expect(router.authorityAgentFor('p4', 4000)).toBeUndefined();
    });

    it('#919 authorityAgentFor expires with the map TTL', () => {
      router = new HookSignalRouter({ latencyMeter: meter, authorityTtlMs: 5_000 });
      router.touchAuthority('p1', 'claude', 1000);
      expect(router.authorityAgentFor('p1', 5_999)).toBeDefined();
      expect(router.authorityAgentFor('p1', 6_000)).toBeUndefined();
    });

    it('#919 expireAuthorityFor clears the veto on confirmed process death', () => {
      router.touchAuthority('p1', 'claude', 1000);
      router.expireAuthorityFor('p1', 'claude');
      // A relaunched same-slug agent with broken hooks must get its detector
      // completions through — the veto died with the old launch.
      expect(router.isGovernedFor('p1', 'claude', 1100)).toBe(false);
      expect(router.authorityAgentFor('p1', 1100)).toBeUndefined();
    });

    it('#919 expireAuthorityFor scoped to another agent leaves the entry intact', () => {
      router.touchAuthority('p1', 'codex', 1000);
      router.expireAuthorityFor('p1', 'claude'); // claude's death, not codex's
      expect(router.isGovernedFor('p1', 'codex', 1100)).toBe(true);
      // Unscoped expiry (slugless pick) clears whatever is there.
      router.expireAuthorityFor('p1');
      expect(router.isGovernedFor('p1', 'codex', 1100)).toBe(false);
    });
  });
});
