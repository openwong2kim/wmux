// HookSignalRouter — dedup arbiter between deterministic hook signals
// (from integrations/<agent>/bin/wmux-bridge.mjs) and heuristic
// AgentDetector emissions (regex-driven, in src/main/pty/AgentDetector.ts).
//
// The Iron Rule: hook signal wins. AgentDetector is the fallback path
// for environments where the plugin isn't installed. When both fire
// within a 10s window, the second one is suppressed.
//
// ASCII timing diagrams:
//
//   Hook arrives first, detector follows within 10s
//   t0: hook    → ledger.set(slug:ptyId = {kind, ts: t0, source:'hook'})
//                  → emit notification
//   t0+200ms: detector → ledger lookup → source='hook', kind matches,
//                                         ts within window → DEDUP, no emit
//
//   Detector arrives first, hook follows within 10s
//   t0: detector → ledger.set(slug:ptyId = {kind, ts: t0, source:'detector'})
//                   → emit notification
//   t0+50ms: hook → ledger lookup → kind matches, ts within window → DEDUP
//                   → still records latency (the value of the hook is
//                     measurement here, not user-visible emission)
//
//   Hook arrives, but no detector ever fires (plugin-only path)
//   t0: hook    → emit
//   t0+1m: hook again (different kind) → emit again
//
//   Detector arrives, no plugin installed
//   t0: detector → emit
//   This is the legacy heuristic behavior, unchanged from pre-plugin wmux.

import type {
  AgentSignal,
  AgentSignalKind,
} from '../../../integrations/shared/signal-types';
import type { AgentSlug } from '../pty/AgentDetector';
import type { SignalLatencyMeter } from './SignalLatencyMeter';

/** Default dedup window. 10s chosen by eng review 2026-05-22 after measuring
 *  typical (hook-fire → detector-prompt-render) gap (≤2s observed). Wide
 *  margin keeps the dedup robust without making cross-turn collisions
 *  likely (a single agent turn is bounded well over 10s in practice). */
export const DEFAULT_DEDUP_WINDOW_MS = 10_000;

/** Ledger entry. Source field is what lets us implement the Iron Rule
 *  ("hook wins") asymmetrically — a detector emission gets suppressed
 *  by a later hook signal, but only if the recorded source was 'hook'. */
interface LedgerEntry {
  kind: AgentSignalKind;
  ts: number;
  source: 'hook' | 'detector';
}

/**
 * Decision returned to the caller. `emit` means the caller should
 * proceed to call sendNotification (or its slice action), `dedup` means
 * the caller should drop this event. Latency is always recorded
 * regardless of decision because health observation is independent of
 * user-visible dispatch.
 */
export type RouteDecision = 'emit' | 'dedup';

/**
 * Wiring: HookSignalRouter is constructed once in main/index.ts and
 * shared across:
 *   - `src/main/pipe/handlers/hooks.rpc.ts` (calls recordHook on every
 *     bridge signal)
 *   - `src/main/pty/PTYBridge.ts` (calls recordDetector before every
 *     AgentDetector-driven sendNotification)
 *
 * No singleton; the wiring layer holds the reference. Tests construct
 * their own instance.
 */
export class HookSignalRouter {
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly latencyMeter: SignalLatencyMeter;
  private readonly windowMs: number;

  constructor(deps: { latencyMeter: SignalLatencyMeter; dedupWindowMs?: number }) {
    this.latencyMeter = deps.latencyMeter;
    this.windowMs = deps.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  }

  /**
   * Record a hook-bridge signal. Returns `emit` when the caller should
   * proceed to fan-out, `dedup` when a recent detector emission already
   * covered the same (slug, ptyId, kind) tuple.
   *
   * Latency is always recorded because the bridge gave us a fire-time
   * we can measure against, regardless of whether we suppress emission.
   * That data feeds the Settings "Plugin signal health" card and tells
   * the user "the hook IS firing, dedup just won this round."
   *
   * @param signal Validated AgentSignal envelope (caller MUST have
   *               passed isAgentSignal already).
   * @param ptyId  Resolved ptyId from `cwd` lookup in hooks.rpc.
   * @param now    Optional override for test determinism.
   */
  recordHook(signal: AgentSignal, ptyId: string, now: number = Date.now()): RouteDecision {
    // NOTE: latency is NOT recorded here. The caller is responsible for
    // calling getLatencyMeter().recordSignal directly. This split exists
    // so non-emit kinds (PostToolUse / SessionStart) can record latency
    // without touching the dedup ledger — see hooks.rpc.ts for the wiring.
    const key = this.key(signal.agent, ptyId, signal.kind);
    const recent = this.ledger.get(key);
    // Hook beats detector only when the prior record was a detector emit
    // of the SAME kind within the window. Different kinds always emit
    // (a Stop hook after a SubagentStop detector is a distinct event).
    if (
      recent &&
      recent.source === 'detector' &&
      recent.kind === signal.kind &&
      now - recent.ts < this.windowMs
    ) {
      // Detector already emitted. Hook is the canonical-but-redundant
      // event. Update the ledger to 'hook' for downstream queries that
      // care about provenance.
      this.ledger.set(key, { kind: signal.kind, ts: now, source: 'hook' });
      return 'dedup';
    }
    // Either no prior record or prior was a different kind / stale —
    // emit and overwrite ledger.
    this.ledger.set(key, { kind: signal.kind, ts: now, source: 'hook' });
    return 'emit';
  }

  /**
   * Record an AgentDetector emission and ask whether to proceed. Called
   * BEFORE sendNotification by PTYBridge's onEvent handler.
   *
   * Detector loses to a recent hook of the SAME kind. Different kinds
   * (e.g. detector saw "waiting" prompt, hook fired Stop) emit
   * independently — they're different user-visible events.
   */
  recordDetector(
    slug: AgentSlug,
    kind: AgentSignalKind,
    ptyId: string,
    now: number = Date.now(),
  ): RouteDecision {
    const key = this.key(slug, ptyId, kind);
    const recent = this.ledger.get(key);
    if (
      recent &&
      recent.source === 'hook' &&
      recent.kind === kind &&
      now - recent.ts < this.windowMs
    ) {
      // Hook already won. Suppress detector emit. Don't overwrite the
      // ledger — leave the hook record so a subsequent detector emit
      // of the same kind also defers correctly.
      return 'dedup';
    }
    this.ledger.set(key, { kind, ts: now, source: 'detector' });
    return 'emit';
  }

  /** Expose the latency meter so callers can query stats without
   *  needing the meter reference directly. */
  getLatencyMeter(): SignalLatencyMeter {
    return this.latencyMeter;
  }

  /** Test-only: clear all dedup state. Latency meter is independent. */
  resetForTests(): void {
    this.ledger.clear();
  }

  /**
   * Ledger key includes `kind` (codex review round 2, P1 #7). Without it,
   * an `agent.activity` event would overwrite a recent `agent.stop`
   * entry on the same (slug, ptyId), defeating dedup for the case where
   * the user actually cares about (stop arriving while a fresh activity
   * was the last write). Per-kind ledgers cost a few extra entries per
   * pty in exchange for correctness.
   */
  private key(slug: string, ptyId: string, kind?: AgentSignalKind): string {
    return kind ? `${slug}:${ptyId}:${kind}` : `${slug}:${ptyId}`;
  }
}
