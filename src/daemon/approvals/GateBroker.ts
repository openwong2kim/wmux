// #783 — GateBroker: the waiter coordinator for the PreToolUse permission gate.
//
// CRITICAL 1 (eng-review): the gate runs inside a `node` child process (the
// hook bridge), and the answer must travel BACK to that process as an RPC
// response. The broker holds that response open — the `awaitVerdict` promise
// resolves only when a phone taps approve/deny (via the ApprovalRegistry) or
// the deadline / lifecycle event defers it.
//
// The record-of-truth lives in ApprovalRegistry (one CAS, one event stream,
// one /api/approvals list). The broker owns ONLY the waiters: the promise
// resolvers and their timers. It never touches disk, never broadcasts, and
// never decides policy — it is plumbing.
//
// Lifecycle:
//   awaitVerdict(id, sessionId, deadline)  ← RPC handler calls this
//     ── creates a waiter, arms a self-defer timer
//   notifyResolved(id, decision)           ← ApprovalRegistry.resolve() calls this
//     ── wakes the waiter with the phone's answer
//   cancel(id, reason)                     ← timeout / expiry
//     ── wakes the waiter with 'defer'
//   cancelForSession(sessionId, reason)    ← session:died
//   cancelAll(reason)                      ← daemon shutdown

import type { ApprovalDecision } from './types';

/**
 * The verdict the broker resolves a waiter with. `allow`/`deny` come from a
 * phone tap; `defer` means "fall back to Claude Code's normal permission flow"
 * (timeout, session died, daemon restart, or the headless/escape hatch).
 */
export type GateVerdict =
  | { decision: 'allow' | 'deny'; reason: 'answered' }
  | { decision: 'defer'; reason: string };

interface GateWaiter {
  readonly sessionId: string;
  resolve: (verdict: GateVerdict) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GateBrokerDeps {
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for test determinism. */
  now?: () => number;
  /** Deadline override for the self-defer timer, for tests. */
  deadlineMs?: number;
  /**
   * Expire the approval record behind a gate the broker just deferred (review:
   * 3-MODEL). Without this the card stays `pending` after the tool has already
   * fallen through to the local prompt, and a late phone tap gets a success
   * receipt for a decision that changed nothing — "I tapped deny but it ran".
   */
  expireRecord?: (gateId: string, reason: string) => void;
  /**
   * Cap on gates blocking at once. Each one holds a control-plane socket for
   * its whole deadline, and the pipe server accepts a bounded number of
   * connections — without a cap, enough simultaneous gates starve the CLI, MCP
   * and the desktop app out of the daemon (review: Claude+Codex).
   */
  maxPending?: number;
}

/**
 * The default gate deadline. The harness (Claude Code) gives PreToolUse hooks a
 * 600 s budget; we self-defer well inside that so the agent never hits the
 * harness wall (which would kill the hook process and leave the daemon with a
 * dangling waiter). The bridge serialises its own shorter budget and sends it
 * in the envelope, so this is the cap, not always the value used.
 */
export const DEFAULT_GATE_DEADLINE_MS = 120_000;

/**
 * Leave room in the pipe server's connection budget for the control plane. A
 * blocked gate holds its socket for the full deadline, so this is deliberately
 * a small fraction of MAX_CONNECTIONS (20) — past it, gates defer immediately
 * rather than locking every other client out of the daemon.
 */
const DEFAULT_MAX_PENDING_GATES = 8;

export class GateBroker {
  private readonly waiters = new Map<string, GateWaiter>();
  private readonly deps: GateBrokerDeps;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly maxPending: number;

  constructor(deps: GateBrokerDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_GATE_DEADLINE_MS;
    this.maxPending = deps.maxPending ?? DEFAULT_MAX_PENDING_GATES;
  }

  /**
   * Hold the RPC response open until the gate is resolved. The caller (the
   * `daemon.hooks.signal` RPC handler) awaits this; the broker resolves it when
   * `notifyResolved` or `cancel` fires for this id.
   *
   * `deadlineMs` (from the bridge envelope) overrides the default when it is
   * shorter — the bridge knows its own remaining budget.
   */
  awaitVerdict(gateId: string, sessionId: string, deadlineMs?: number): Promise<GateVerdict> {
    // Over the cap: defer immediately rather than hold another control-plane
    // socket. The tool still runs — it just uses the local prompt.
    if (this.waiters.size >= this.maxPending) {
      this.deps.log?.('warn', `[gate] ${gateId} deferred — ${this.waiters.size} gates already pending`);
      this.deps.expireRecord?.(gateId, 'gate-timed-out');
      return Promise.resolve({ decision: 'defer', reason: 'too-many-pending-gates' });
    }
    // A repeat id would orphan the previous promise (its timer stays armed and
    // nothing ever resolves it), so settle the old one first.
    const existing = this.waiters.get(gateId);
    if (existing) this.cancel(gateId, 'superseded-by-duplicate-gate');
    const ms = Math.max(1_000, Math.min(deadlineMs ?? this.deadlineMs, this.deadlineMs));
    return new Promise<GateVerdict>((resolve) => {
      const timer = setTimeout(() => {
        // Self-defer before the harness wall. A defer tells Claude Code to use
        // its normal permission flow — the user gets a LOCAL prompt, not a
        // silent hang. This is the documented escape hatch (§3-6 ③).
        this.cancel(gateId, 'gate-timed-out');
      }, ms);
      timer.unref?.();
      this.waiters.set(gateId, { sessionId, resolve, timer });
    });
  }

  /**
   * Wake the waiter with the phone's answer. Called by
   * `ApprovalRegistry.resolve()` AFTER the CAS succeeds — the registry already
   * guarantees first-write-wins, so the broker does not need its own CAS.
   *
   * `decision` uses the approval wire vocabulary ('approve'/'deny'); the broker
   * translates to the PreToolUse vocabulary ('allow'/'deny') for the verdict.
   */
  notifyResolved(gateId: string, decision: ApprovalDecision): void {
    const w = this.waiters.get(gateId);
    if (!w) return; // already timed out / cancelled — the registry's CAS lost
    this.waiters.delete(gateId);
    clearTimeout(w.timer);
    w.resolve({ decision: decision === 'approve' ? 'allow' : 'deny', reason: 'answered' });
  }

  /**
   * Defer a single gate. Used by the self-defer timer and by explicit
   * cancellation (e.g. `agent.permission_answered` from a local answer).
   */
  cancel(gateId: string, reason: string): void {
    const w = this.waiters.get(gateId);
    if (!w) return;
    this.waiters.delete(gateId);
    clearTimeout(w.timer);
    this.deps.log?.('info', `[gate] deferred ${gateId} (${reason})`);
    // Expire the record in the SAME step as the waiter. The tool has moved on
    // to the local prompt, so a card left `pending` would let a late tap claim
    // it decided something (review: 3-MODEL). The registry's CAS makes this
    // idempotent — a phone answer that already won leaves nothing to expire.
    this.deps.expireRecord?.(gateId, reason);
    w.resolve({ decision: 'defer', reason });
  }

  /**
   * Defer every gate belonging to a session. Wired to `session:died` /
   * `session:destroyed` so an agent SIGKILL does not leave a dangling waiter
   * whose RPC response will never arrive (the bridge process died with the
   * pane, but the daemon's promise would hang forever without this).
   */
  cancelForSession(sessionId: string, reason: string): void {
    for (const id of [...this.waiters.keys()]) {
      const w = this.waiters.get(id);
      if (w?.sessionId === sessionId) {
        this.cancel(id, reason);
      }
    }
  }

  /**
   * Defer every pending gate. Called from the daemon's `shutdown()` path so the
   * exit is clean — every held RPC response gets a `defer`, and every bridge
   * process reading that response falls back to the local permission flow
   * instead of dying with a broken pipe.
   */
  cancelAll(reason: string): void {
    for (const id of [...this.waiters.keys()]) {
      this.cancel(id, reason);
    }
  }

  /** Number of gates currently blocking — for diagnostics and tests. */
  pendingCount(): number {
    return this.waiters.size;
  }

  /** Whether a specific gate is still waiting — for tests. */
  isWaiting(gateId: string): boolean {
    return this.waiters.has(gateId);
  }
}
