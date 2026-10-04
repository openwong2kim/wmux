// ─── Moa track record — the feed (P3c) ───────────────────────────────────────
//
// Turns wmux's own signals into the rolled-up counts in track-record.json:
//   - work links (new A2A tasks and their states)   → delegations, done, stalls
//   - the fan-out ledger (worker transitions)        → the same, for fan-out
//   - Deck decisions (a new pending id)              → interruptions, questions
//   - the approval registry (resolved records)       → lane presses vs. people
//   - A2A replies on an open task from a non-owner   → nudges
// Only ids, states and times are read; titles, questions and summaries are
// reduced to counts (questions to hashed words) before anything is stored.
//
// MASTER SWITCH: the feed runs only while Moa is on. `sync()` follows the
// switch: off unsubscribes everything and clears the timer, so nothing is
// counted, swept, scheduled or injected; on re-subscribes and the stored
// counts come back as they were.
//
// Each start (the switch turned on, or the app opened with Moa on) first
// settles saved open items against the work links and the ledger: anything
// that moved while the feed was off moves now, without judging a wait whose
// end it did not see. Time the feed was off never counts as waiting, and
// approvals answered while it was off are taken as a baseline, not counted.
//
// The weekly retro runs on the tick: at the most recent scheduled slot it has
// not run for yet (the first tick after it, if the app was closed), reviewing
// the last full week. A week with no activity records the run and makes no card.
//
// Moa reads the record (renderTrackRecordContext) but never writes it.

import type { WorkLink } from '../../shared/workLink';
import type { LedgerEntry } from '../../shared/ledger';
import type { LedgerTransition } from '../../daemon/ledger/TaskLedger';
import type { WorkspaceDecision } from './deckDecisionStore';
import type { TrackRecordStore } from './trackRecordStore';
import { sanitizeContextValue, VIEW_CONTEXT_DISCLAIMER } from './viewContext';
import {
  addWeeks,
  agentSlug,
  buildRetro,
  bumpRow,
  formatDuration,
  markSeen,
  moveItem,
  noteDecisionAsked,
  noteHumanApproval,
  openItem,
  pruneTrackRecord,
  resumeOpenItems,
  retroDueWeek,
  rollupRows,
  sweepOpenItems,
  type OpenState,
  type TrackRecordData,
} from '../../shared/trackRecord';

/** How often waits are swept and the retro schedule is checked. */
export const TRACK_TICK_MS = 10 * 60 * 1000;
/** Weeks Moa's context block covers. */
export const TRACK_CONTEXT_WEEKS = 4;
const MAX_CONTEXT_ROWS = 12;

/** The slice of an approval record the feed reads. */
export interface TrackApprovalRecord {
  id: string;
  workspaceId?: string;
  agent?: string;
  state?: string;
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface TrackRecordFeedPorts {
  store: TrackRecordStore;
  isMoaEnabled: () => boolean;
  workLinks: {
    get: (id: string) => WorkLink | null;
    getByTaskId: (taskId: string) => WorkLink | null;
    onChange: (fn: (ids: string[]) => void) => () => void;
  };
  decisions: {
    load: () => Record<string, WorkspaceDecision>;
    onChanged: (fn: () => void) => () => void;
  };
  ledger: {
    onTransition: (fn: (t: LedgerTransition) => void) => () => void;
    get: (id: string) => Pick<LedgerEntry, 'status' | 'updatedAt'> | null;
  };
  /** The registry's recently resolved records, or null when the daemon is away. */
  listResolvedApprovals: () => Promise<TrackApprovalRecord[] | null>;
  /** A workspace's agent slug (`claude`), or `-`. */
  agentOf: (workspaceId: string) => string;
  /** The ledger owner of a fan-out task workspace, or null. */
  ownerOfTaskWorkspace: (workspaceId: string) => string | null;
  /** Told after a retro card was made or cleared. */
  onRetroChanged?: () => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void } | number;
  clearInterval?: (h: unknown) => void;
}

export interface TrackRecordFeed {
  /** Start or stop with the Moa switch. */
  sync: () => void;
  running: () => boolean;
  /** The approval registry changed: re-list and count what is new. */
  onApprovalsChanged: () => Promise<void>;
  /** A reply landed on an existing A2A task. */
  noteReply: (taskId: unknown, senderWorkspaceId: unknown) => void;
  /** Sweep waits and run the retro if due. */
  tick: () => void;
}

function linkState(link: WorkLink): OpenState | 'done' | 'gone' {
  switch (link.state) {
    case 'needs-you': return 'needs-you';
    case 'blocked': return 'blocked';
    case 'done': return 'done';
    case 'abandoned': return 'gone';
    default: return 'active';
  }
}

function ledgerState(to: string): OpenState | 'done' | 'gone' {
  switch (to) {
    case 'input_required': return 'needs-you';
    case 'failed': return 'blocked';
    case 'completed': return 'done';
    case 'cancelled': return 'gone';
    default: return 'active';
  }
}

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The owner from the lane's audit label `hq:<hq>;owner:<owner>;lane:hq`
 * (hqApprovalLane.hqResolvedBy), or null when the label is not exactly that
 * shape with valid workspace ids. The daemon stores no structured lane field
 * on the record, and `resolvedBy` is free text, so anything else is not
 * counted as a lane press. The daemon keeps 200 characters, sized for this label.
 */
export function laneOwner(resolvedBy: string): string | null {
  const m = /^hq:([^;]+);owner:([^;]+);lane:hq$/.exec(resolvedBy);
  if (!m || !WORKSPACE_ID_RE.test(m[1]) || !WORKSPACE_ID_RE.test(m[2])) return null;
  return m[2];
}

export function createTrackRecordFeed(ports: TrackRecordFeedPorts): TrackRecordFeed {
  const now = ports.now ?? Date.now;
  const store = ports.store;
  let offs: (() => void)[] = [];
  let timer: unknown = null;
  // Set on every start: the first approval list read after it is a baseline.
  let approvalBaseline = false;

  const onLinks = (ids: string[]): void => {
    if (!ports.isMoaEnabled()) return;
    const t = now();
    store.mutate((d) => {
      let changed = false;
      for (const id of ids) {
        const link = ports.workLinks.get(id);
        if (!link) continue;
        const key = `link:${id}`;
        const next = linkState(link);
        const agent = d.open[key]?.agent ?? (link.agent || ports.agentOf(link.owner.workspaceId));
        if (!d.open[key] && markSeen(d.seen.links, id)) {
          changed = true;
          // A link first seen already finished predates the feed: not counted.
          if (next !== 'done' && next !== 'gone') {
            openItem(d, key, { workspaceId: link.owner.workspaceId, agent, createdAt: link.createdAt }, t);
          }
        }
        if (d.open[key]) {
          moveItem(d, key, next, t);
          changed = true;
        }
        for (const decisionId of link.decisionIds) {
          if (markSeen(d.seen.linkedDecisions, decisionId)) {
            bumpRow(d, t, link.owner.workspaceId, agent, { decisions: 1 });
            changed = true;
          }
        }
      }
      return changed;
    });
  };

  const onDecisions = (): void => {
    if (!ports.isMoaEnabled()) return;
    let all: Record<string, WorkspaceDecision>;
    try {
      all = ports.decisions.load();
    } catch {
      return;
    }
    store.mutate((d) => {
      let changed = false;
      for (const [workspaceId, decision] of Object.entries(all)) {
        if (!markSeen(d.seen.decisions, decision.id)) continue;
        changed = true;
        // One answered while the feed was off was not seen being asked.
        if (decision.status === 'pending') {
          noteDecisionAsked(d, workspaceId, store.questionPrint(decision.question), decision.raisedAt || now());
        }
      }
      return changed;
    });
  };

  const onLedger = (tr: LedgerTransition): void => {
    if (!ports.isMoaEnabled()) return;
    const t = now();
    const key = `fan:${tr.entry.id}`;
    store.mutate((d) => {
      if (tr.from === null) {
        if (!markSeen(d.seen.ledger, tr.entry.id)) return false;
        openItem(d, key, { workspaceId: tr.entry.ownerWorkspaceId, agent: ports.agentOf(tr.entry.taskWorkspaceId), createdAt: t }, t);
        return true;
      }
      if (!d.open[key]) return false;
      moveItem(d, key, ledgerState(tr.to), t);
      return true;
    });
  };

  const onApprovalsChanged = async (): Promise<void> => {
    if (!ports.isMoaEnabled()) return;
    let resolved: TrackApprovalRecord[] | null;
    try {
      resolved = await ports.listResolvedApprovals();
    } catch {
      return;
    }
    if (!resolved || !ports.isMoaEnabled()) return;
    store.mutate((d) => {
      if (approvalBaseline) {
        // Answered while the feed was off: seen, not counted.
        approvalBaseline = false;
        for (const r of resolved) if (typeof r.id === 'string') markSeen(d.seen.approvals, r.id);
        return true;
      }
      let changed = false;
      for (const r of resolved) {
        if (typeof r.id !== 'string' || !markSeen(d.seen.approvals, r.id)) continue;
        changed = true;
        const at = typeof r.resolvedAt === 'number' ? r.resolvedAt : now();
        const by = typeof r.resolvedBy === 'string' ? r.resolvedBy : '';
        const agent = agentSlug(r.agent);
        const owner = by.startsWith('hq:') ? laneOwner(by) : null;
        if (by.startsWith('hq:') && owner === null) continue; // a malformed lane label
        if (owner !== null) {
          bumpRow(d, at, owner, agent, { approvalsLane: 1 });
        } else if (r.state === 'resolved' && !by.startsWith('brain')) {
          // Expired and superseded records never reached an answer; a brain's
          // press is not a person being asked.
          const ws = r.workspaceId ? (ports.ownerOfTaskWorkspace(r.workspaceId) ?? r.workspaceId) : '-';
          noteHumanApproval(d, ws, agent, at);
        }
      }
      return changed;
    });
  };

  const noteReply = (taskId: unknown, sender: unknown): void => {
    if (!ports.isMoaEnabled() || typeof taskId !== 'string' || typeof sender !== 'string' || !sender) return;
    const link = ports.workLinks.getByTaskId(taskId);
    if (!link || link.state === 'done' || link.state === 'abandoned') return;
    // The owner answering its own task is not a nudge.
    if (sender === link.owner.workspaceId) return;
    const t = now();
    store.mutate((d) => {
      const agent = d.open[`link:${link.id}`]?.agent ?? (link.agent || ports.agentOf(link.owner.workspaceId));
      bumpRow(d, t, link.owner.workspaceId, agent, { nudges: 1 });
    });
  };

  const tick = (): void => {
    if (!ports.isMoaEnabled()) return;
    const t = now();
    let retroChanged = false;
    store.mutate((d) => {
      sweepOpenItems(d, t);
      d.activeAt = t;
      pruneTrackRecord(d, t);
      const due = retroDueWeek(d.retro.schedule, d.retro.lastRunWeek, t);
      if (due !== null) {
        d.retro.lastRunWeek = due;
        const card = buildRetro(d, addWeeks(due, -1), t);
        if (card) {
          d.retro.card = card;
          delete d.retro.dismissed;
        } else {
          delete d.retro.card;
        }
        retroChanged = true;
      }
    });
    if (retroChanged) ports.onRetroChanged?.();
  };

  /** Settle saved open items against where the work actually is. */
  const reconcile = (d: TrackRecordData, t: number): void => {
    for (const [key, item] of Object.entries(d.open)) {
      const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      let next: OpenState | 'done' | 'gone';
      let at = t;
      if (kind === 'link') {
        const link = ports.workLinks.get(id);
        next = link ? linkState(link) : 'gone';
        if (link) at = link.updatedAt;
      } else if (kind === 'fan') {
        const entry = ports.ledger.get(id);
        next = entry ? ledgerState(entry.status) : 'gone';
        if (entry) at = entry.updatedAt;
      } else {
        next = 'gone';
      }
      // A finish found now happened while the feed was off, at the source's
      // last change: time-to-done uses it; the wait it ended is not judged.
      moveItem(d, key, next, Math.min(t, Math.max(item.createdAt, at)), { judge: false });
    }
  };

  const start = (): void => {
    approvalBaseline = true;
    store.mutate((d) => {
      const t = now();
      reconcile(d, t);
      resumeOpenItems(d, t);
    });
    offs = [
      ports.workLinks.onChange(onLinks),
      ports.decisions.onChanged(onDecisions),
      ports.ledger.onTransition(onLedger),
    ];
    const setIv = ports.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const h = setIv(tick, TRACK_TICK_MS);
    if (typeof h === 'object' && h) h.unref?.();
    timer = h;
    // Catch up with what changed while the feed was off.
    void onApprovalsChanged();
    onDecisions();
    tick();
  };

  const stop = (): void => {
    store.mutate((d) => { d.activeAt = now(); });
    for (const off of offs) off();
    offs = [];
    if (timer !== null) (ports.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout)))(timer);
    timer = null;
  };

  return {
    sync: () => {
      const on = ports.isMoaEnabled();
      if (on && timer === null) start();
      else if (!on && timer !== null) stop();
    },
    running: () => timer !== null,
    onApprovalsChanged,
    noteReply,
    tick,
  };
}

// ── Moa's read-only view ────────────────────────────────────────────────────

/**
 * The track record as one block for Moa's turn context, or null when there is
 * nothing to say. Counts only; workspace names are user text and go through
 * the same sanitizer as the view-context line.
 */
export function renderTrackRecordContext(
  data: TrackRecordData,
  now: number,
  nameOf: (workspaceId: string) => string | undefined,
): string | null {
  const rows = rollupRows(data, now, TRACK_CONTEXT_WEEKS).slice(0, MAX_CONTEXT_ROWS);
  if (rows.length === 0) return null;
  const lines = rows.map((r) => {
    const name = sanitizeContextValue(nameOf(r.workspaceId), 60);
    const avg = r.done > 0 ? ` (avg ${formatDuration(r.doneMs / r.done)})` : '';
    return (
      `- "${name}" (${sanitizeContextValue(r.workspaceId, 80)}) ${sanitizeContextValue(r.agent, 24)}: ` +
      `${r.delegations} delegated, ${r.done} done${avg}, ${r.nudges} nudges, ${r.decisions} decisions, ` +
      `${r.stalls} stalls, ${r.approvalsLane} approvals pressed by rule, ${r.approvalsHuman} by a person`
    );
  });
  return [
    `[wmux track record] Last ${TRACK_CONTEXT_WEEKS} weeks, per workspace and agent, counted by wmux from its own task data.`,
    'Use it to pick where to delegate; you cannot change it.',
    ...lines,
    VIEW_CONTEXT_DISCLAIMER,
  ].join('\n');
}

export interface TrackContextMemory {
  /**
   * The block for this brain turn, or null. Only while Moa is on, only for Moa
   * (the HQ, or with no HQ designated each workspace's own brain), and only when
   * it differs from what that brain's conversation already got, so an idle week
   * costs no tokens. The block is pending until the turn is settled.
   */
  take: (
    workspaceId: string,
    opts: { moaEnabled: boolean; hq: string | null; data: TrackRecordData; now: number; nameOf: (id: string) => string | undefined },
  ) => string | null;
  /** The turn ended: a delivered block counts as shown; an errored one is sent again. */
  settle: (workspaceId: string, delivered: boolean) => void;
  /** The conversation was reset or retired: the next turn gets the block again. */
  forget: (workspaceId: string) => void;
}

/** Changed-only memory for the block, settled like the deck's ambient blocks. */
export function createTrackContextMemory(): TrackContextMemory {
  const shown = new Map<string, string>();
  const pending = new Map<string, string>();
  return {
    take: (workspaceId, opts) => {
      if (!opts.moaEnabled || (opts.hq !== null && workspaceId !== opts.hq)) return null;
      const block = renderTrackRecordContext(opts.data, opts.now, opts.nameOf);
      if (!block || shown.get(workspaceId) === block) return null;
      pending.set(workspaceId, block);
      return block;
    },
    settle: (workspaceId, delivered) => {
      const block = pending.get(workspaceId);
      if (block === undefined) return;
      pending.delete(workspaceId);
      if (delivered) shown.set(workspaceId, block);
    },
    forget: (workspaceId) => {
      shown.delete(workspaceId);
      pending.delete(workspaceId);
    },
  };
}

/** The app's memory, used by the deck handler. */
export const trackContextMemory = createTrackContextMemory();

// ── The app's instance ──────────────────────────────────────────────────────

let feed: TrackRecordFeed | null = null;

export function setTrackRecordFeed(next: TrackRecordFeed | null): void {
  feed = next;
}

/** A reply landed on an existing task (a2a.rpc). Never throws. */
export function noteTrackReply(taskId: unknown, senderWorkspaceId: unknown): void {
  try {
    feed?.noteReply(taskId, senderWorkspaceId);
  } catch {
    /* stats never break a delivery */
  }
}
