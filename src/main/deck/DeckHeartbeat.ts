// ─── Command Deck — level-review heartbeat (WP4) ─────────────────────────────
//
// The periodic safety net for a missed judgment. The event-push coalescer wakes
// a workspace's brain on pane EDGES (agent.stop / awaiting_input / pr.*); if an
// edge is ever dropped — a hook that never fired, an event lost during a busy
// window that then got consumed — the pane sits needing attention with nothing
// to surface it. This heartbeat re-reads the CURRENT level state of each armed
// workspace on a slow cadence and hands it to the coalescer's flushSnapshot,
// which wakes the brain through the SAME gate stack (decision → mode → rate →
// busy → budget). So the review can never wake MORE than the edge path would —
// it only catches what the edge path missed.
//
// Main-process, transport-free — same shape as DeckScheduler: a `flushSnapshot`
// callback plus probes and injectable clock/timer deps so tests drive it
// deterministically. The per-tick conditions below are an OPTIMIZATION (skip
// the obvious non-candidates cheaply); the coalescer's gates remain the
// authority on whether a wake actually fires.

import type { WorkspaceAutonomy } from './deckAutonomyStore';
import type { FleetSnapshot, FleetSnapshotPane } from '../../shared/workspaceMirror';

export interface DeckHeartbeatDeps {
  /** The workspaces to review each tick: those with a live commander manager OR
   *  a resting autonomy mode other than 'off' (deck.handler supplies the union —
   *  a workspace can be armed before its brain has ever spawned). */
  getWorkspaceIds: () => string[];
  /** Resolve this workspace's autonomy (fail-closed). Only `mode` is read here —
   *  the coalescer applies the full policy. */
  getAutonomy: (workspaceId: string) => WorkspaceAutonomy;
  /** True when this workspace's brain is mid-turn (a review must not race it). */
  isBusy: (workspaceId: string) => boolean;
  /** True when this workspace has an unresolved decision gate (blocks every wake). */
  hasPendingDecision: (workspaceId: string) => boolean;
  /** This workspace's current per-pane snapshot from the renderer mirror, or null
   *  when unknown (never populated / no fleet for this workspace). */
  getFleetSnapshot: (workspaceId: string) => FleetSnapshot | null;
  /** Hand the snapshot to the coalescer, which re-runs all gates and wakes iff
   *  worthy. Fire-and-forget from the heartbeat's view. */
  flushSnapshot: (workspaceId: string, snapshot: FleetSnapshot) => void;
  /** The timestamp (ms) of this workspace's most recent accepted wake, or null.
   *  A review within intervalMs of it is skipped — the wake already surfaced
   *  current state (from CommanderEventCoalescer.lastWakeAt). */
  lastWakeAt: (workspaceId: string) => number | null;
  /** Global on/off for the heartbeat (deck-heartbeat.json). Read fresh each tick. */
  isEnabled: () => boolean;
  /** Review cadence (ms). Doubles as the tick interval AND the per-workspace
   *  "recently woken" window. Already clamped by the store loader. */
  intervalMs: number;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/** The agentStatus values a level review treats as "needs a look": a pane that
 *  is blocked, has ended its turn, or errored. running/idle are quiescent. Mirrors
 *  the coalescer's own attention filter so the pre-check and the flush agree. */
function isAttentionStatus(s: FleetSnapshotPane['agentStatus']): boolean {
  return s === 'awaiting_input' || s === 'waiting' || s === 'complete' || s === 'error';
}

export class DeckHeartbeat {
  private readonly deps: DeckHeartbeatDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: DeckHeartbeatDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    const setI = this.deps.setIntervalFn ?? setInterval;
    this.timer = setI(() => this.tick(), Math.max(1, this.deps.intervalMs));
    // Electron main must never be kept alive by the heartbeat.
    (this.timer as { unref?: () => void }).unref?.();
    // Unlike the scheduler, do NOT fire an immediate tick on start: the first
    // review lands one cadence in, so a just-launched app doesn't wake every
    // armed workspace before the renderer has even pushed its first mirror.
  }

  stop(): void {
    if (!this.timer) return;
    (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
    this.timer = null;
  }

  /** One review pass over every armed workspace. Re-entrancy guarded — a tick
   *  that overruns the cadence must not overlap itself. */
  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.safe(() => this.deps.isEnabled(), false)) return;
      const now = (this.deps.now ?? Date.now)();
      for (const wsId of this.safe(() => this.deps.getWorkspaceIds(), [] as string[])) {
        this.reviewWorkspace(wsId, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Decide whether this one workspace warrants a level review right now, and if
   *  so hand its snapshot to the coalescer. Every probe is never-throw so one
   *  torn store can't wedge the whole pass. */
  private reviewWorkspace(workspaceId: string, now: number): void {
    // Mode gate: 'off' never wakes. (The coalescer re-checks the full policy;
    // this just skips the obvious case without a snapshot read.)
    if (this.safe(() => this.deps.getAutonomy(workspaceId).mode, 'off') === 'off') return;
    // A mid-turn brain, or one blocked on a decision, is never level-reviewed.
    if (this.safe(() => this.deps.isBusy(workspaceId), false)) return;
    if (this.safe(() => this.deps.hasPendingDecision(workspaceId), false)) return;
    // Recently woken → the last wake already surfaced current state.
    const last = this.safe(() => this.deps.lastWakeAt(workspaceId), null);
    if (last !== null && now - last < this.deps.intervalMs) return;
    // Need a snapshot with at least one attention pane, else there is nothing to
    // review. (An empty/quiescent fleet is the common no-op — cheap to reject.)
    const snapshot = this.safe(() => this.deps.getFleetSnapshot(workspaceId), null);
    if (!snapshot || !snapshot.panes.some((p) => isAttentionStatus(p.agentStatus))) return;
    // Hand it to the coalescer — it re-runs decision/mode/rate/busy/budget and
    // wakes only if worthy. Never-throw: a flush error must not abort the pass.
    this.safe(() => {
      this.deps.flushSnapshot(workspaceId, snapshot);
      return undefined;
    }, undefined);
  }

  /** Run a probe, swallowing any throw and returning the fallback — the whole
   *  heartbeat is best-effort ambient plumbing, never a source of crashes. */
  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }
}
