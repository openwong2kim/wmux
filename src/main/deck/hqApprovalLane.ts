// ─── The HQ approval lane (C2 v2) — small approvals pressed by rule ──────────
//
// A fan-out worker whose owner runs in `danger` still stops on wmux's own
// permission gate (an `awaiting_permission` record) for Bash/Write/Edit/....
// Its owner's brain may press that (approval.press, owner lane). With an HQ
// designated, owners other than the HQ have no brain, so the gate waited for
// a human. This lane presses it — by RULE, in main, with no model judgement —
// and Moa is only told afterwards, as a pointer on its next turn.
//
// THE RULE (every condition, checked here and again where it can be):
//   - Moa is on, an HQ is designated and its workspace is present;
//   - the operator turned the lane on (Settings → Moa, default off);
//   - the record's workspace has exactly ONE open task, so exactly one owner;
//   - that owner's LIVE mode is `danger` (daemon: ownerMode);
//   - the task workspace's own approvalPress capability is on (daemon);
//   - the record came from a hook that named its pane exactly (daemon:
//     `attribution-inexact`) and is a permission gate — never an
//     AskUserQuestion, whose "approve" picks option 1 of a question;
//   - the record is not flagged critical (daemon: `critical-risk`);
//   - no choiceKey — the lane only ever says the record's own "yes";
//   - the daemon holds main's CURRENT facts and lane policy (the publisher is
//     settled), and the lane policy is still the generation checked here when
//     the daemon releases the gate (daemon: `hq-lane-closed`).
// The daemon is the single enforcement point for the facts it holds; main's
// pre-checks only keep it from being asked about records that cannot pass.
//
// THE HQ BRAIN never approves through this lane. `approval.press` from the HQ's
// commander token on a worker it does not own is DENY-only: if the rule
// pressed it, it is already pressed; if the rule did not, a human has it, and a
// model saying yes instead would be the judgement this lane exists to avoid.
//
// A critical record is left exactly where it is — pending, in the human's
// approval inbox (Fleet, the phone). No decision card and no second push: the
// approval IS the notification.

import type { DaemonClient } from '../DaemonClient';
import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import type { AgentMode } from './deckAutonomyStore';
import type { HqPresence } from './deckHqStore';

/** Why the HQ lane will not act on a record. Each is its own test. */
export type HqLaneRefusal =
  | 'hq-unset'
  | 'not-hq'
  | 'moa-off'
  | 'hq-missing'
  | 'hq-unknown'
  | 'hq-press-off'
  | 'hq-choice-key'
  | 'record-has-no-workspace'
  | 'task-closed'
  | 'owner-ambiguous'
  | 'facts-pending';

export interface HqLanePorts {
  getHq: () => string | null;
  isMoaEnabled: () => boolean;
  presence: (hq: string) => HqPresence;
  isOptedIn: () => boolean;
  ledger: () => Pick<TaskLedger, 'list'>;
  /** The owner's LIVE mode (deck-autonomy.json, never a copy). */
  modeOf: (workspaceId: string) => AgentMode;
}

/**
 * May the HQ act on this record at all? `callerWs` is the commander token's
 * workspace for a brain call, or the HQ itself for the rule lane. The HQ is
 * re-read on every call — a token minted for a previous HQ names a workspace
 * that is no longer the HQ and is refused here, whatever the token store says.
 */
export function checkHqLane(
  callerWs: string,
  record: { workspaceId?: string },
  opts: { choiceKey?: string; forDeny?: boolean },
  ports: HqLanePorts,
): { ok: true; hq: string; owner: string } | { ok: false; reason: HqLaneRefusal } {
  const hq = ports.getHq();
  if (hq === null) return { ok: false, reason: 'hq-unset' };
  if (!callerWs || callerWs !== hq) return { ok: false, reason: 'not-hq' };
  // A deny is the safe direction: it does not need Moa's switch or the
  // approve opt-in, only that it answers for exactly one owner.
  if (!opts.forDeny && !ports.isMoaEnabled()) return { ok: false, reason: 'moa-off' };
  const presence = ports.presence(hq);
  if (presence !== 'present') return { ok: false, reason: presence === 'missing' ? 'hq-missing' : 'hq-unknown' };
  if (!opts.forDeny && !ports.isOptedIn()) return { ok: false, reason: 'hq-press-off' };
  if (opts.choiceKey !== undefined) return { ok: false, reason: 'hq-choice-key' };
  if (!record.workspaceId) return { ok: false, reason: 'record-has-no-workspace' };
  const owners = new Set(
    ports.ledger().list({ taskWorkspaceId: record.workspaceId, openOnly: true }).map((e) => e.ownerWorkspaceId),
  );
  if (owners.size === 0) return { ok: false, reason: 'task-closed' };
  if (owners.size > 1) return { ok: false, reason: 'owner-ambiguous' };
  return { ok: true, hq, owner: [...owners][0] as string };
}

/** The audit label a lane press is recorded under (approval history). */
export function hqResolvedBy(hq: string, owner: string): string {
  return `hq:${hq};owner:${owner};lane:hq`;
}

// ── The rule lane ───────────────────────────────────────────────────────────

/** The slice of a pending record the lane reads. */
export interface LanePendingRecord {
  id: string;
  sessionId: string;
  workspaceId?: string;
  kind?: string;
  risk?: string;
  attribution?: string;
}

export interface HqAutoPressPorts extends HqLanePorts {
  getDaemonClient: () => DaemonClient | null;
  /** The facts publisher: is the daemon current, which table, which lane
   *  generation does it hold. */
  facts: { settled: () => boolean; ackedSeq: () => number; ackedLaneGeneration: () => number };
  /** A workspace's display name for the pointer (falls back to the id). */
  nameOf?: (workspaceId: string) => string | undefined;
  log?: (line: string) => void;
}

/** Most pointer lines held for Moa between its turns. */
const MAX_POINTER_LINES = 20;

export interface HqAutoPress {
  /** Re-list pending approvals and press what the rule allows. */
  run: () => Promise<void>;
  /** The pointer block for Moa's next turn, or null; draining it. */
  takePointer: () => string | null;
}

/** Workspace names are user text: one line, bounded, inside quotes. */
function safeName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f"]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/**
 * Refusals that may only mean the daemon judged by facts older than main's:
 * re-evaluated once a newer table is acknowledged. Every other refusal is a
 * verdict on the record and final for its id.
 */
const FACTS_LAG_REFUSALS: ReadonlySet<string> = new Set([
  'scope-unavailable',
  'workspace-unknown',
  'not-a-task-workspace',
  'autonomy-unknown',
  'autonomy-off',
  'unknown-autonomy-mode',
  'press-capability-unknown',
  'press-capability-off',
  'owner-mode-unknown',
  'owner-autonomy-off',
  'owner-not-danger',
  'hq-lane-closed',
]);

export function createHqAutoPress(ports: HqAutoPressPorts): HqAutoPress {
  const log = ports.log ?? ((line: string) => console.log(line));
  // id → 'final' (answered, or refused on the record itself) or the acked
  // facts seq it was refused under (re-tried once a newer table lands).
  // Pruned to what is pending.
  const attempted = new Map<string, number | 'final'>();
  // owner → counts since Moa last saw them; past the cap, totals only.
  const pressed = new Map<string, number>();
  const leftCritical = new Map<string, number>();
  const overflow = { pressed: 0, critical: 0, owners: new Set<string>() };
  let running: Promise<void> | null = null;
  let again = false;

  const bump = (m: Map<string, number>, owner: string): void => {
    if (pressed.size + leftCritical.size >= MAX_POINTER_LINES && !m.has(owner)) {
      if (m === pressed) overflow.pressed += 1;
      else overflow.critical += 1;
      overflow.owners.add(owner);
      return;
    }
    m.set(owner, (m.get(owner) ?? 0) + 1);
  };

  const pass = async (): Promise<void> => {
    const dc = ports.getDaemonClient();
    if (!dc?.isConnected) return;
    const hq = ports.getHq();
    // Nothing to do unless the lane could pass for SOME record — saves the
    // list round trip on every approval event while the lane is off.
    if (hq === null || !ports.isMoaEnabled() || !ports.isOptedIn()) return;
    let pending: LanePendingRecord[];
    try {
      const listed = (await dc.rpc('daemon.approvals.list', {})) as { pending?: LanePendingRecord[] } | undefined;
      pending = listed?.pending ?? [];
    } catch {
      return;
    }
    const live = new Set(pending.map((r) => r.id));
    for (const id of attempted.keys()) if (!live.has(id)) attempted.delete(id);

    for (const record of pending) {
      const prior = attempted.get(record.id);
      if (prior === 'final') continue;
      if (record.kind !== 'awaiting_permission') continue;
      if (record.attribution !== 'exact') continue;
      // The daemon must hold what main holds now; the push that settles it
      // runs this pass again.
      if (!ports.facts.settled()) return;
      const seqNow = ports.facts.ackedSeq();
      if (prior !== undefined && prior >= seqNow) continue;
      const lane = checkHqLane(hq, record, {}, ports);
      if (!lane.ok) continue;
      if (ports.modeOf(lane.owner) !== 'danger') continue;
      if (record.risk === 'critical') {
        attempted.set(record.id, 'final');
        bump(leftCritical, lane.owner);
        log(`[hq-lane] left ${record.id} for a human: critical (owner ${lane.owner})`);
        continue;
      }
      let result: { ok?: boolean; reason?: string; pressRefusal?: string } | undefined;
      try {
        result = (await dc.rpc('daemon.approvals.resolve', {
          id: record.id,
          decision: 'approve',
          resolvedBy: hqResolvedBy(lane.hq, lane.owner),
          resolver: 'automated',
          // Re-checked by the daemon at release (see the header).
          lane: 'hq',
          laneGeneration: ports.facts.ackedLaneGeneration(),
        })) as typeof result;
      } catch (err) {
        // Transport failure: no answer either way, so the next pass may retry.
        log(`[hq-lane] press of ${record.id} failed: ${String(err)}`);
        continue;
      }
      const why = result?.ok ? null : (result?.pressRefusal ?? result?.reason ?? 'unknown');
      // A refusal the daemon may have reached on older facts is retried under
      // the next table; anything else is final for this id.
      attempted.set(record.id, why !== null && FACTS_LAG_REFUSALS.has(why) ? seqNow : 'final');
      if (why === null) {
        bump(pressed, lane.owner);
        log(`[hq-lane] pressed ${record.id} on ${record.sessionId} (hq ${lane.hq}, owner ${lane.owner})`);
        continue;
      }
      if (why === 'critical-risk') bump(leftCritical, lane.owner);
      log(`[hq-lane] daemon refused ${record.id}: ${why} (owner ${lane.owner})`);
    }
  };

  const run = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await pass();
        } catch (err) {
          log(`[hq-lane] pass failed: ${String(err)}`);
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const takePointer = (): string | null => {
    if (pressed.size === 0 && leftCritical.size === 0 && overflow.owners.size === 0) return null;
    const label = (ws: string): string => `"${safeName(ports.nameOf?.(ws) ?? ws) || ws}"`;
    const plural = (n: number): string => (n === 1 ? '1 approval' : `${n} approvals`);
    const lines: string[] = [];
    for (const [ws, n] of pressed) lines.push(`[wmux] pressed ${plural(n)} for ${label(ws)} by rule`);
    for (const [ws, n] of leftCritical) {
      lines.push(
        `[wmux] left ${plural(n)} for ${label(ws)} to the human (critical) — ` +
          'already in their approval inbox; do not raise a decision for it',
      );
    }
    if (overflow.owners.size > 0) {
      const parts = [
        overflow.pressed > 0 ? `pressed ${plural(overflow.pressed)}` : '',
        overflow.critical > 0 ? `left ${plural(overflow.critical)} to the human (critical)` : '',
      ].filter(Boolean);
      lines.push(`[wmux] …and ${overflow.owners.size} more workspaces: ${parts.join(', ')}`);
    }
    pressed.clear();
    leftCritical.clear();
    overflow.pressed = 0;
    overflow.critical = 0;
    overflow.owners.clear();
    return lines.join('\n');
  };

  return { run, takePointer };
}

// ── Process singleton (wired in main/index.ts, read by the deck handler) ─────

let instance: HqAutoPress | null = null;

export function setHqAutoPress(next: HqAutoPress | null): void {
  instance = next;
}

/** The pointer block for the HQ's next turn, or null. */
export function takeHqPressPointer(): string | null {
  return instance?.takePointer() ?? null;
}

/** Run a lane pass now (opt-in turned on). No-op before main wires the lane. */
export function runHqAutoPress(): void {
  void instance?.run();
}
