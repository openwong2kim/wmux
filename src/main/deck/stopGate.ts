// ─── Stop gate — refuse to end an orchestrator turn with work outstanding ────
//
// The terminal orchestrator's failure mode is ending its turn the moment it has
// dispatched work: it delegates to a worker pane, says "delegated", and stops.
// Nothing then drives the fleet until a wake event happens to fire. This module
// is the predicate that answers ONE question — "does the fleet still have panes
// that need this brain?" — and the answer rides the `hooks.signal` RPC response
// back to the bridge, which turns a block into exit 2 (Claude Code's "keep
// going" contract for a Stop hook).
//
// Pure and dependency-free on purpose: the whole gate is unit-testable without
// a mirror, a pty, or a claude. Everything stateful (the consecutive-block
// counter, the snapshot lookup) lives in the adapter that calls this.
//
// Five fail-open rules, all deliberate:
//   1. A null snapshot never blocks. The gate INFERS outstanding work from pane
//      status; a derived signal cannot prove absence, so a missing or stale
//      mirror must not wedge the brain.
//   2. A stale snapshot is treated as a null one. The mirror is pushed by the
//      renderer, so a backgrounded/wedged/reloading renderer leaves the last
//      push sitting in main indefinitely. Blocking a turn on panes that were
//      "running" a quarter of an hour ago is a trap, not a gate — the same
//      rule 1 reasoning, applied to a snapshot that merely LOOKS present.
//   3. A run of consecutive blocks is capped. A model that cannot resolve a
//      parked pane would otherwise be refused until TURN_TIMEOUT_MS (30 min),
//      which ends in the worst possible way — an ESC into the TUI and a
//      superseded-turn credit. The cap is what makes this a gate and not a
//      trap, so the deadlock-avoidance it buys is worth the turns it lets
//      through: a wrongly-allowed Stop costs one wake event, a wrongly-held
//      turn costs the whole fleet its orchestrator.
//   4. A PENDING deck decision releases the gate outright. deck_ask_decision
//      is the brain saying "only a human can move this forward", and the
//      decision block orders it NOT to proceed — holding the turn open then
//      forces the one thing a stalled model can still do: re-print the same
//      question. The coalescer already suppresses every wake under a pending
//      decision; this is the mirror image for ending the turn. The resolve
//      path kicks an explicit resume turn, so nothing is lost by stopping.
//   5. A cap-out is remembered (hysteresis). The consecutive-block counter is
//      per turn, so a wake loop over UNCHANGED fleet state re-bought the same
//      three refusals — and three re-printed turns — every cycle. The verdict
//      carries a fingerprint of exactly what was held on; the caller records
//      it at cap-out and passes it back, and the gate stays quiet until the
//      state actually changes (or the record expires / a human turn clears
//      it — both the caller's job, see stopGateState).

import type { FleetSnapshot, FleetSnapshotPane } from '../../shared/workspaceMirror';
import type { LedgerStatus } from '../../shared/ledger';

/** One OPEN ledger row owned by the brain being gated (lane F). */
export interface StopGateLedgerTask {
  id: string;
  title: string;
  status: LedgerStatus;
}

/** The ledger's view for one Stop (lane F, `deck.ledgerGate`). `openTasks`
 *  is null when the ledger could not be read — the gate then falls back to
 *  today's snapshot inference (fail-open toward the shipped behaviour, never
 *  toward a wedge). */
export interface StopGateLedgerInput {
  enabled: boolean;
  openTasks: readonly StopGateLedgerTask[] | null;
}

/** Default ceiling on consecutive refusals for one turn. */
export const DEFAULT_MAX_CONSECUTIVE_BLOCKS = 3;

/** How old a fleet snapshot may be and still be trusted to hold a turn open.
 *  Comfortably above the renderer's push cadence, well below the point where
 *  "running" means "was running when the renderer last got a frame". */
export const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30_000;

/** Every refusal has to say what NOT to do, not just what to do. Issue #733:
 *  the brain read "resolve the pane" as "end the pane" and ran `exit` then
 *  Ctrl+D on a live user shell. Shared so the pane branch and the active-work
 *  branches cannot drift apart — the active-work branches shipped without it. */
const NO_KILL_SENTENCE =
  'Do NOT close or kill a pane to clear its status — no exit, no Ctrl+D, no kill. ' +
  'Those sessions belong to the human. If a pane will not resolve, leave it running and ' +
  'raise it with deck_ask_decision instead of ending it.';

/** Every refusal must also forbid the cheap non-action. The observed failure
 *  (transcript, 2026-08-07) was the same "shall I proceed?" message re-printed
 *  on every refused Stop — a blocked model's path of least resistance is to
 *  restate itself, which spends tokens and moves nothing. The sentence also
 *  names the one legitimate way to WAIT: a pending decision releases this gate
 *  (rule 4), so prose questions the gate cannot see become tool calls it can. */
const NO_REPEAT_SENTENCE =
  'Do NOT re-send or restate your previous message — a repeated turn is not progress; ' +
  'take a NEW concrete step. If only a human answer can move this forward, raise it with ' +
  'deck_ask_decision({question, options}): a pending decision releases this gate and ' +
  'pauses auto-wakes until the human answers.';

export type StopGateVerdict =
  | {
      block: false;
      /**
       * Present ONLY on the allow that ends a refusal run at the cap (rule 5):
       * the fingerprint of exactly what the gate was holding on when it gave
       * up. The caller records it (`noteGateCapOut`) and passes it back as
       * `suppressedFingerprint`, so identical state cannot re-buy another run
       * of refusals on the next turn. Absent on every other allow.
       */
      cappedOutFingerprint?: string;
      /** Lane F: this allow ended a run of LEDGER-held refusals at the cap —
       *  the caller logs `ledger_gate_released`. */
      ledgerReleased?: true;
    }
  /**
   * `outstandingPtyIds` is the set of panes this refusal is actually about, and
   * it is EMPTY for a block that names none — an active-work hold with a
   * missing or stale snapshot. `input.rpc` protects exactly this set (#733), so
   * it has to travel with the verdict rather than be re-derived by the caller:
   * a caller re-reading a stale snapshot would protect panes the model was
   * never told about, which is the drift this field exists to make impossible.
   */
  | {
      block: true;
      reason: string;
      outstandingPtyIds: string[];
      /** What this refusal is holding on (rule 5). The caller remembers the
       *  last one so a cap-out only suppresses a state that was actually
       *  refused — never a state that appeared for the first time on the
       *  capping Stop (e.g. a worker dispatched mid-refusal-run). */
      fingerprint: string;
    };

/** Pane statuses that mean "this pane still needs the orchestrator". The same
 *  attention set CommanderEventCoalescer treats as non-quiescent. */
function isOutstanding(status: FleetSnapshotPane['agentStatus']): boolean {
  return status === 'running' || status === 'awaiting_input';
}

/**
 * Is this mirror row an AGENT pane — something the orchestrator can actually
 * drive — rather than the human's own shell?
 *
 * `agentName` cannot answer it: the mirror only carries a name for the active
 * pane's active surface, so every background worker reports `null` too. The
 * per-pty `isAgent` flag (surfaceAgent identity, #850) is the one signal that
 * separates them.
 *
 * `undefined` is UNKNOWN, not "shell": a snapshot pushed by a renderer that
 * predates the field must keep the behaviour it shipped with (every
 * running/awaiting_input pane holds the turn) rather than silently disarm both
 * gates. Only an explicit `false` releases a pane.
 */
export function isAgentPane(pane: FleetSnapshotPane): boolean {
  return pane.isAgent !== false;
}

/**
 * The ONE rule both gates share (finding 11): a pane holds the turn open only
 * when it is an agent pane AND its status still needs the orchestrator. A plain
 * zsh the operator typed a command into promotes to `running` off byte activity
 * alone, and counting it made `deck_complete_work` refuse work that was done.
 * Exported so `deck.completeWork` and `evaluateStopGate` cannot drift apart.
 */
export function isOutstandingWorkerPane(pane: FleetSnapshotPane): boolean {
  return isAgentPane(pane) && isOutstanding(pane.agentStatus);
}

/** Short human label for one blocking pane, used in the reason string. */
function describePane(pane: FleetSnapshotPane): string {
  const name = pane.agentName && pane.agentName.length > 0 ? pane.agentName : pane.ptyId;
  return `${name} (${pane.agentStatus})`;
}

/** One line naming exactly what the gate is holding on: the active-work
 *  revision plus the outstanding pane set. Equal fingerprints mean "the gate
 *  would refuse for the reason it already refused" — that is the whole
 *  hysteresis predicate (rule 5). `updatedAt` is in the work half because any
 *  touch to the record (a human follow-up, an A2A transition) is exactly the
 *  state change that should re-arm the gate; pane statuses are in the other
 *  half so a worker flipping running → awaiting_input re-arms it too. Sorted
 *  so pane ordering in the snapshot cannot fake a change. */
function gateFingerprint(
  activeWork: { id: string; updatedAt?: number } | null,
  outstanding: readonly FleetSnapshotPane[],
  openTasks: readonly StopGateLedgerTask[] = [],
): string {
  const work = activeWork ? `${activeWork.id}@${activeWork.updatedAt ?? 0}` : '';
  const panes = outstanding
    .map((p) => `${p.ptyId}:${p.agentStatus}`)
    .sort()
    .join(',');
  const tasks = openTasks
    .map((t) => `${t.id}:${t.status}`)
    .sort()
    .join(',');
  return tasks.length > 0 ? `${work}|${panes}|${tasks}` : `${work}|${panes}`;
}

/** Lane F: the ledger's refusal text. One line per open task with the action
 *  that clears it, plus the same no-kill / no-repeat rules as the pane branch. */
function describeLedgerHold(openTasks: readonly StopGateLedgerTask[]): string {
  const lines = openTasks.map((t) => {
    const hint =
      t.status === 'review_requested'
        ? 'the worker claims done — run the gate and complete it, or bounce it back'
        : t.status === 'input_required'
          ? 'the worker is blocked — answer it (ledger_list shows its summary) or decide'
          : 'the worker is still working — check its pane or wait for its report';
    return `${t.id} "${t.title}" (${t.status}: ${hint})`;
  });
  const noun = openTasks.length === 1 ? 'task' : 'tasks';
  return (
    `Do not end this turn yet: the task ledger still lists ${openTasks.length} open ${noun} you own — ${lines.join('; ')}. ` +
    'Read ledger_list for their current rev and summary and drive each one to completed, failed or cancelled. '
  );
}

/** The ledger portion of a decision prompt (lane F): prepended to the context
 *  of deck_ask_decision while the ledger gate is on, so the human sees what
 *  is still open when the brain asks. Empty when nothing is open. */
export function describeOpenLedgerTasksForDecision(openTasks: readonly StopGateLedgerTask[]): string {
  if (openTasks.length === 0) return '';
  return (
    `[open tasks in the ledger: ${openTasks.map((t) => `${t.id} "${t.title}" (${t.status})`).join(', ')}]`
  );
}

/**
 * Decide whether this Stop may end the turn.
 *
 * Brain ptys are not in the snapshot — they carry ENV_KEYS.BRAIN_PTY and are
 * filtered out of every pane listing — so the gate can never block on the
 * orchestrator's own session. That is asserted in the tests rather than trusted.
 */
export function evaluateStopGate(input: {
  /** `getWorkspaceMirror().getFleetSnapshot(workspaceId)`, or null when absent. */
  snapshot: FleetSnapshot | null;
  /** A durable human request that still belongs to this commander. Unlike pane
   *  state, this is authoritative even when the renderer snapshot is absent.
   *  `updatedAt` (when supplied) rides into the hysteresis fingerprint so any
   *  touch to the record re-arms a capped-out gate. */
  activeWork?: { id: string; updatedAt?: number } | null;
  /** TRUE when this workspace has a PENDING deck decision — the brain raised
   *  deck_ask_decision and the human has not answered (rule 4). Read fresh at
   *  every Stop by the caller, so resolve/clear re-arms the gate with no extra
   *  state. */
  pendingDecision?: boolean;
  /** The fingerprint recorded at this workspace's last cap-out, or null (rule
   *  5). Matching the current state means the gate already gave up on exactly
   *  this hold — stay quiet instead of re-buying the same refusal run. */
  suppressedFingerprint?: string | null;
  /** Lane F: the task ledger's view (see StopGateLedgerInput). Absent or
   *  `enabled: false` = the shipped snapshot-inferred gate, unchanged. */
  ledger?: StopGateLedgerInput;
  /** How many times in a row this turn's Stop has already been refused. */
  consecutiveBlocks: number;
  maxConsecutiveBlocks?: number;
  /** Injectable clock, so the staleness rule is testable without waiting. */
  now?: number;
  maxSnapshotAgeMs?: number;
}): StopGateVerdict {
  const { snapshot, activeWork } = input;
  // Rule 4 first: a pending decision is the one legitimate "waiting on a
  // human" state, and it is checked before anything else because every other
  // input describes work the brain could still drive — this one says it must
  // not. The decision block already orders the brain to stop acting; refusing
  // the Stop on top of that leaves it nothing to do but repeat itself.
  if (input.pendingDecision) return { block: false };

  // Rules 1+2 folded into one read: a null or stale snapshot contributes no
  // outstanding panes (a derived signal cannot prove absence), while a fresh
  // one contributes its running/awaiting_input AGENT set — a shell the human
  // is using is not a worker, however busy it looks (finding 11). Computed up
  // front because the fingerprint needs the same set the block branches use.
  const now = input.now ?? Date.now();
  const maxAge = input.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;
  const outstanding =
    snapshot && now - snapshot.ts <= maxAge
      ? snapshot.panes.filter(isOutstandingWorkerPane)
      : [];

  // Lane F — the ledger path (`deck.ledgerGate`). Open tasks owned by this
  // brain hold the turn exactly like outstanding panes do, through the SAME
  // cap (rule 3) and hysteresis (rule 5). A ledger that could not be read
  // (openTasks null) contributes nothing: that is rule 2 applied to the
  // ledger — a missing signal cannot prove work, so the snapshot inference
  // above decides, never a wedge.
  const openTasks: readonly StopGateLedgerTask[] =
    input.ledger?.enabled && input.ledger.openTasks ? input.ledger.openTasks : [];

  // Nothing held — no active work, no outstanding panes, no open tasks. The
  // common allow.
  if (!activeWork && outstanding.length === 0 && openTasks.length === 0) return { block: false };

  // Rule 5: the gate already capped out on exactly this state. Stay quiet
  // until the state changes; the caller's TTL and the next human turn bound
  // how long "quiet" can last.
  const fingerprint = gateFingerprint(activeWork ?? null, outstanding, openTasks);
  if (input.suppressedFingerprint != null && input.suppressedFingerprint === fingerprint) {
    return { block: false };
  }

  // Rule 3: the refusal-run cap. The fingerprint travels with this allow so
  // the caller can record what was held on — an allow for exhaustion, not for
  // completion. A ledger-held run that caps out is flagged so the caller can
  // log `ledger_gate_released`.
  const max = input.maxConsecutiveBlocks ?? DEFAULT_MAX_CONSECUTIVE_BLOCKS;
  if (input.consecutiveBlocks >= max) {
    return {
      block: false,
      cappedOutFingerprint: fingerprint,
      ...(openTasks.length > 0 ? { ledgerReleased: true as const } : {}),
    };
  }

  // Ledger hold: refuse, naming the open tasks. Outstanding panes (if any)
  // ride along so input.rpc keeps protecting them (#733); the reason leads
  // with the ledger because that is the state the brain can actually change.
  if (openTasks.length > 0) {
    return {
      block: true,
      outstandingPtyIds: outstanding.map((p) => p.ptyId),
      fingerprint,
      reason:
        `${describeLedgerHold(openTasks)}` +
        (outstanding.length > 0
          ? `Agent panes still needing you: ${outstanding.map(describePane).join(', ')}. `
          : '') +
        `${NO_KILL_SENTENCE} ${NO_REPEAT_SENTENCE}`,
    };
  }

  // A durable active-work record is stronger than the renderer-derived pane
  // snapshot. Even with no/freshness-lost snapshot, give the brain a bounded
  // chance to explicitly finalize the request instead of silently ending its
  // turn. The consecutive-block cap above still prevents a broken tool/store
  // from trapping the TUI indefinitely.
  const finalizeReason = activeWork
    ? `The human request ${activeWork.id} is still ACTIVE. Do not claim completion or end yet. ` +
      'Inspect the delegated results and acceptance checks; when everything is actually complete, call ' +
      'deck_complete_work({summary, verification}). If work remains, delegate or unblock the next step.'
    : null;
  // An active-work hold names NO pane, so the pane branch's no-kill sentence
  // never reaches the model here — and this is the branch a stale record wedges
  // on. That is the #733 shape exactly: held with nothing to point at, the brain
  // escalated to `exit`/Ctrl+D on a live user shell. `input.rpc` cannot cover it
  // either, since it protects the panes the verdict names and this verdict names
  // none. So the sentence has to be carried by the reason string itself.
  if (outstanding.length === 0) {
    // activeWork is non-null here (the nothing-held allow above returned
    // otherwise), covering all three former exits: no snapshot, stale
    // snapshot, and a fresh snapshot whose panes are all quiescent. The
    // ternary keeps that invariant type-checked rather than trusted.
    return finalizeReason
      ? {
          block: true,
          reason: `${finalizeReason} ${NO_KILL_SENTENCE} ${NO_REPEAT_SENTENCE}`,
          outstandingPtyIds: [],
          fingerprint,
        }
      : { block: false };
  }

  // This string is the ONLY thing the model reads about the refusal, so it
  // names the panes, their statuses, and the action that clears the gate.
  //
  // It also has to name what NOT to do. Issue #733: a pane wedged at `running`
  // held the gate, and the brain escalated to `exit` and then Ctrl+D on a live
  // user shell — reading "resolve the pane" as "end the pane". A reported
  // status is not resolved by killing the thing it describes, and the pane
  // belongs to a human who did not ask for it to close. `input.rpc` enforces
  // this for the panes named here; the sentence exists so the model does not
  // have to learn it by being refused.
  const list = outstanding.map(describePane).join(', ');
  const noun = outstanding.length === 1 ? 'pane' : 'panes';
  return {
    block: true,
    outstandingPtyIds: outstanding.map((p) => p.ptyId),
    fingerprint,
    reason:
      `Do not end this turn yet: ${outstanding.length} agent ${noun} still need you — ${list}. ` +
      'Check each one (read its screen, answer what it is waiting on, or delegate the next step). ' +
      `${NO_KILL_SENTENCE} ` +
      (finalizeReason ?? 'If there is genuinely nothing left for you to do, say so and stop again.') +
      ` ${NO_REPEAT_SENTENCE}`,
  };
}
