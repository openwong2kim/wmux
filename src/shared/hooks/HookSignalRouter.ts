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
  AgentSlug,
} from './signal-types';
import { isAgentSlug } from '../agentIdentity';
import type { SignalLatencyMeter } from './SignalLatencyMeter';

/** Default dedup window. 10s chosen by eng review 2026-05-22 after measuring
 *  typical (hook-fire → detector-prompt-render) gap (≤2s observed). Wide
 *  margin keeps the dedup robust without making cross-turn collisions
 *  likely (a single agent turn is bounded well over 10s in practice). */
export const DEFAULT_DEDUP_WINDOW_MS = 10_000;

/** Hook-authority freshness window. While a pane has seen ANY bridge signal
 *  for an agent within this TTL, that agent's detector notifications on the
 *  pane are vetoed entirely (hook is canonical; the detector's always-visible
 *  footer matches — `bypass permissions on` etc. — otherwise re-fire mid-turn
 *  AND poison the dedup ledger so the real Stop hook lands as 'dedup').
 *  30min mirrors Orca's AGENT_STATUS_STALE_AFTER_MS: long enough to span a
 *  long tool call between hook signals, short enough that a bridge killed
 *  with -9 (no Stop ever arrives) eventually returns the pane to the
 *  detector backstop. PTY dispose clears immediately via dropPty. */
export const HOOK_AUTHORITY_TTL_MS = 30 * 60_000;

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
 * Has the pane's hook bridge taken over its lifecycle yet?
 *
 * `isGovernedFor` answers "a bridge speaks for this pane". That is the right
 * question for the notification veto but a subtly wrong one for the status
 * broadcast, and the gap has a name: a bridge that has said `SessionStart` and
 * nothing else is alive but has never written a lifecycle status. Withholding
 * the detector's read there leaves the roster showing whatever it had —
 * the gate's one-shot `running` — so a freshly launched agent sitting at its
 * prompt reads as busy until its first turn ends. Live-measured at 30+ seconds
 * per launch.
 *
 * So: `agent.session_start` (and only it) hands the lifecycle BACK to the
 * detector, because it is the one signal that says "this pane's hook history
 * starts here, and nothing has been claimed yet". A relaunch in the same pane
 * resets ownership for the same reason.
 *
 * Every other kind — work, turn ends, subagent stops, permission-gate state —
 * means the bridge is speaking for the turn, so the hook owns the lifecycle
 * and the detector's always-visible footer must not overwrite it.
 *
 * An absent kind also means owned: a caller that does not name its signal gets
 * the pre-#935 behavior, which is the conservative direction here.
 */
function hookOwnsLifecycleAfter(kind: AgentSignalKind | undefined): boolean {
  return kind !== 'agent.session_start';
}

/**
 * Wiring: one instance per process. In main it is constructed in
 * main/index.ts and shared across:
 *   - `src/main/pipe/handlers/hooks.rpc.ts` (calls recordHook on every
 *     bridge signal)
 *   - `src/main/pty/PTYBridge.ts` (calls recordDetector before every
 *     AgentDetector-driven sendNotification)
 * In the daemon (M1) it is constructed by `src/daemon/hooks/HookIngest.ts`
 * and shared with the `session:agent` broadcast site in `src/daemon/index.ts`,
 * which is the daemon's detector-emission point.
 *
 * No singleton; the wiring layer holds the reference. Tests construct
 * their own instance.
 */
export class HookSignalRouter {
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly latencyMeter: SignalLatencyMeter;
  private readonly windowMs: number;
  private readonly authorityTtlMs: number;
  /** ptyId → last bridge signal for that pane (any kind, incl. non-emit
   *  SessionStart/activity). Drives the detector veto — see HOOK_AUTHORITY_TTL_MS —
   *  and (daemon-side, #919) the canonical identity tier. `exact` records
   *  whether the signal was routed by exact ptyId or via the cwd-prefix
   *  fallback: only exact-routed authority may decide identity alone. */
  private readonly authority = new Map<
    string,
    { agent: string; lastSignalAt: number; exact: boolean; lifecycleOwned: boolean }
  >();
  /** ptyId → when this pane's bridge last reported a TURN START. Separate from
   *  `authority` on purpose: it answers "has the hook proven it can light this
   *  pane's running dot", not "is a bridge alive". See governsRunningState. */
  private readonly turnStart = new Map<string, number>();

  constructor(deps: { latencyMeter: SignalLatencyMeter; dedupWindowMs?: number; authorityTtlMs?: number }) {
    this.latencyMeter = deps.latencyMeter;
    this.windowMs = deps.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.authorityTtlMs = deps.authorityTtlMs ?? HOOK_AUTHORITY_TTL_MS;
  }

  /**
   * Record that a live bridge signal (any kind) arrived for this pane.
   * Called by hooks.rpc on every resolved signal — including the non-emit
   * kinds (SessionStart, agent.activity) — so authority freshness tracks
   * "the bridge is alive for this pane", not "a toast just fired".
   *
   * `exact` (default true) marks signals routed by exact ptyId; the daemon's
   * cwd-prefix fallback passes false — #919 lets only exact-routed authority
   * decide identity uncorroborated, since a cwd guess can attach to a
   * neighboring pane.
   *
   * `kind` sets the pane's lifecycle-ownership latch that
   * `governsDetectorStatus` reads — see `hookOwnsLifecycleAfter`.
   */
  touchAuthority(
    ptyId: string,
    agent: string,
    now: number = Date.now(),
    exact = true,
    kind?: AgentSignalKind,
  ): void {
    this.authority.set(ptyId, {
      agent,
      lastSignalAt: now,
      exact,
      lifecycleOwned: hookOwnsLifecycleAfter(kind),
    });
  }

  /**
   * #919 — the pane's hook authority within the map TTL, as identity input:
   * which agent's bridge signaled, how long ago, and with which routing
   * provenance. Undefined past the 30-min TTL (the caller applies the much
   * shorter identity TTL to `ageMs` on the uncorroborated path only).
   */
  authorityAgentFor(
    ptyId: string,
    now: number = Date.now(),
  ): { slug: AgentSlug; ageMs: number; exact: boolean } | undefined {
    const entry = this.authority.get(ptyId);
    if (!entry || !isAgentSlug(entry.agent)) return undefined;
    const ageMs = now - entry.lastSignalAt;
    if (ageMs >= this.authorityTtlMs) return undefined;
    return { slug: entry.agent, ageMs, exact: entry.exact };
  }

  /**
   * #919 — expire the pane's authority on CONFIRMED process death. The 30-min
   * veto belongs to the dead launch's generation: left alone it suppresses
   * every detector completion of a relaunched same-slug agent whose hooks are
   * broken. `onlyAgent` scopes the expiry to that agent's entry so a death of
   * process A never strips process B's authority.
   */
  expireAuthorityFor(ptyId: string, onlyAgent?: string): void {
    const entry = this.authority.get(ptyId);
    if (!entry) return;
    if (onlyAgent !== undefined && entry.agent !== onlyAgent) return;
    this.authority.delete(ptyId);
  }

  /**
   * True when `slug`'s hook bridge has signaled on this pane within the
   * authority TTL. Callers (PTYBridge / DaemonNotificationRouter) suppress
   * detector-sourced NOTIFICATIONS for governed (ptyId, slug) pairs — the
   * hook is canonical there and the detector's footer heuristics both
   * re-fire mid-turn and pre-poison the dedup ledger against the real Stop.
   * A different agent on the same pane (e.g. detector sees codex while the
   * claude bridge governs) is NOT vetoed — that's a genuinely distinct
   * signal source the hook can't speak for. Metadata/status-dot broadcasts
   * are never gated by this; notifications only.
   */
  isGovernedFor(ptyId: string, slug: string, now: number = Date.now()): boolean {
    const entry = this.authority.get(ptyId);
    if (!entry || entry.agent !== slug) return false;
    return now - entry.lastSignalAt < this.authorityTtlMs;
  }

  /**
   * Record that this pane's bridge reported a TURN START
   * (`agent.user_prompt_submit`). Called from both ingest paths' prompt-submit
   * branch — main's `hooks.signal` fallback and, in daemon mode, the
   * `session:agent` replay in DaemonNotificationRouter, because main's own
   * authority map is deliberately never touched for a daemon-served pane (the
   * daemon's arbitration stamp stands in for it there).
   */
  noteHookTurnStart(ptyId: string, now: number = Date.now()): void {
    if (!ptyId) return;
    this.turnStart.set(ptyId, now);
  }

  /**
   * True when this pane's `running` state is the HOOK's to write, so the
   * byte-rate heuristic must stop writing it — neither promoting the pane on an
   * output burst nor clearing it on silence.
   *
   * The question is deliberately NOT `isGovernedFor`. A bridge can be alive on
   * a pane and still never report a turn start: an older plugin (< 0.4.0), an
   * install that predates `UserPromptSubmit` in setup-hooks, or an agent whose
   * integration only wires turn ENDS. Suppressing the heuristic there would
   * leave those panes with no `running` source at all — grey for the whole
   * turn. So authority is not the gate; EVIDENCE is: only a pane that has
   * actually delivered a turn start has proven the hook can light it.
   *
   * Rides the same 30-minute TTL as the notification veto, and for the same
   * reason (a single turn can run 20+ minutes with no bridge traffic on a
   * turn-boundary-only install, so a short window would just restore the bug).
   * The accepted cost is symmetric too: a bridge that dies mid-session leaves
   * the pane's dot on whatever the hook last wrote until the TTL lapses.
   * `dropPty` releases it immediately on pane death or reuse.
   */
  governsRunningState(ptyId: string, now: number = Date.now()): boolean {
    const at = this.turnStart.get(ptyId);
    return at !== undefined && now - at < this.authorityTtlMs;
  }

  /**
   * True when the pane's live hook bridge owns this detector-sourced status,
   * so the caller must withhold it from `metadata.agentStatus` as well as from
   * the notification.
   *
   * `waiting` and `complete` are the two statuses the bridge's Stop signal
   * speaks for. They are also the two the detector infers from ALWAYS-VISIBLE
   * TUI chrome: Claude Code's footer reads `bypass permissions on` /
   * `shift+tab to cycle` for the whole turn in bypass-permissions mode, so
   * every repaint re-asserts "ready for input" while the agent is working.
   * The notification veto (`isGovernedFor`) has always covered the toast, but
   * the status broadcast ran BEFORE it and was deliberately left ungated —
   * which put the false read straight onto the roster row and into the
   * "N need you" roll-up, the one signal that must never cry wolf (#935).
   *
   * Deliberately NOT covered:
   *   - `awaiting_input` — Claude's hooks wire PreToolUse only for
   *     AskUserQuestion, so the ordinary approval prompts have no hook at all
   *     and the detector is their only source. Same carve-out the notification
   *     veto makes, and for the same reason.
   *   - `running` — a working cue, not a turn boundary; nothing about it
   *     competes with the Stop signal.
   *   - a pane whose bridge has said `SessionStart` and nothing since. It is
   *     governed, but the hook has not written a lifecycle status yet, so
   *     withholding the detector's read leaves the roster on the gate's
   *     one-shot `running` — a launched-but-idle agent reading as busy, live-
   *     measured at 30+ seconds per launch. See `hookOwnsLifecycleAfter`. Once
   *     any other kind arrives the hook owns the lifecycle and this returns
   *     true again, so the post-Stop double-toast veto is unaffected.
   *
   * An ungoverned pane (no bridge, or a bridge gone quiet past the authority
   * TTL) is unaffected: the detector stays the backstop it has always been.
   *
   * Accepted cost, stated because a reviewer will ask: this rides the same
   * 30-minute authority TTL as the notification veto, so a bridge that stops
   * speaking while its agent process is still alive leaves the status stale
   * until the TTL expires. That is deliberately symmetric — the notification
   * veto has always accepted exactly that window on the LOUDER surface, and
   * making the status less trusting than the toast would be the odd choice.
   * A shorter TTL is not the answer either: a single turn can run past twenty
   * minutes with no bridge traffic at all on a turn-boundary-only hook install
   * (the #935 report measured 21m), so a short window would simply restore the
   * bug it fixes. Confirmed process death already releases authority ahead of
   * the TTL (`expireAuthorityFor`, wired to the daemon's liveness poll).
   */
  governsDetectorStatus(
    ptyId: string,
    slug: string | null | undefined,
    status: string,
    now: number = Date.now(),
  ): boolean {
    if (status !== 'waiting' && status !== 'complete') return false;
    if (!slug) return false;
    if (!this.isGovernedFor(ptyId, slug, now)) return false;
    return this.authority.get(ptyId)?.lifecycleOwned === true;
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
   * Suppresses (`dedup`) when any recent emission for the same
   * (agent, pty, kind) tuple exists within the dedup window, regardless
   * of source. Two cases this covers:
   *   1. hook → detector: hook is canonical, detector is redundant.
   *   2. detector → detector: e.g. Aider emits "Applied edit to ..."
   *      (status='complete') and then "aider> " (status='waiting') for
   *      a single turn; both collapse to `kind: 'agent.stop'` and would
   *      otherwise stream two `decision:'emit'` lifecycle events for one
   *      turn — orchestrators filtering on emit would run follow-up
   *      twice. Codex round-3 catch.
   *
   * Different kinds (e.g. detector saw "waiting" prompt, hook fired
   * Stop) still emit independently — those are different user-visible
   * events. Different (slug, ptyId) tuples are independent too.
   *
   * The ledger is NOT refreshed on dedup, so a third same-kind emission
   * 8s into the original 10s window still defers (no rolling window
   * extension). Refreshing only happens on `emit`.
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
      recent.kind === kind &&
      now - recent.ts < this.windowMs
    ) {
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
    this.authority.clear();
  }

  /**
   * Drop every ledger entry for a given ptyId. Called from PTYBridge's
   * cleanupInstance when a PTY is disposed (UI close, MCP destroy, exit)
   * so the ledger doesn't accumulate dead-ptyId entries over a long
   * daemon lifetime.
   *
   * Keys are formed as `${slug}:${ptyId}:${kind}` in `key()`. ptyIds are
   * UUIDs in production and never contain `:`, so the substring check
   * `:${ptyId}:` is unambiguous; agent slugs and signal kinds are bound
   * to a finite enum that also never contains `:`.
   *
   * Returns the number of entries removed (testing aid, not a contract).
   */
  dropPty(ptyId: string): number {
    if (!ptyId) return 0;
    // Authority rides the same lifecycle: a disposed PTY must return to
    // detector-backstop behavior immediately if the id is ever reused.
    this.authority.delete(ptyId);
    // Same rule for the turn-start latch: a reused id must not inherit the
    // dead pane's "the hook owns my running dot" claim, which would leave the
    // new pane's heuristic muted with no bridge to replace it.
    this.turnStart.delete(ptyId);
    const needle = `:${ptyId}:`;
    let removed = 0;
    for (const k of this.ledger.keys()) {
      if (k.includes(needle)) {
        this.ledger.delete(k);
        removed++;
      }
    }
    return removed;
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
