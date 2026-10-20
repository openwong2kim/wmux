// ─── Wake taint — did a bot's wake carry outside text? ─────────────────────
//
// A wake is tainted when its reason carries text the owner did not write and
// no bot of this factory wrote from clean input: GitHub-authored facts (a PR
// or issue, its labels, a review, a failing check), a task fact or a handoff
// that came from a tainted wake. Main decides, from its own stores, never
// from what a bot says:
//
//   facts     tainted when any fact is outside text (OUTSIDE_TEXT_FACT_KINDS:
//             GitHub's words, and a verdict, which reads them), a task / pane
//             fact of a task whose dispatch is tainted (or unknown), a
//             handoff fact of a tainted handoff, a bot.notice main marked
//             tainted, or a fact that cannot be found. The task ids main
//             gives a bot's own task wakes (`task.<status>:<taskId>@<rev>`,
//             not in the fact log) are as tainted as that task's dispatch.
//             Synthetic workflow.ready facts use the saved workflow's current
//             mark; an unknown workflow or future revision remains tainted.
//   handoff,  the handoff's own mark: recorded when it is sent (or, failing
//   mention   that, when it was delivered), from the sender's running wake
//             (a send is synchronous inside the sender's turn) and its
//             conversation: one that ran a tainted wake earlier
//             (conversationMarks.ts) taints what it sends. A dispatch
//             wmux sends on for a relay is marked before it is stored, as
//             tainted as the result it carries, the hop that result answers
//             and the relay's first dispatch (an unmarked one is tainted).
//             A handoff from the owner or the system is
//             clean; one from a bot with no mark (delivered again after a
//             restart, or its sender's turn already over) is tainted. A
//             handoff a researcher-template bot sends is always tainted:
//             research reads outside text whatever woke it. The owner's
//             answer to a question asked mid-hop is as tainted as that hop.
//   human, manual, schedule, routine, intro: clean (the owner's words, the
//             owner's buttons, timers). Any other reason is tainted.
//
// Taint is by the wake's origin: text a bot reads with its tools during a
// clean wake (pr_read, issue_read) does not mark the wake. The one rule by
// template is the researcher's: its handoffs (above) and the tasks it fans out
// (fanout.rpc.ts) are always tainted. A bot of any other template is marked by
// its wake's origin alone.
//
// Guest provenance is a wake's second mark, decided from the wake record
// alone (wakeGuest): `true` for an external guest's own wake and for anything
// derived from one (a handoff it sent, the owner's answer to a question it
// asked, a relay dispatch carrying its result, a task or notice it caused),
// `false` when the record says clean, `'unknown'` when the record that would
// say is gone or carries no mark. A guest wake is also tainted. Only a guest
// wake reads guest cards (room_read include_guest), so a clean wake never
// becomes guest mid-turn. What a guest-sourced or unknown wake would start or
// persist is refused (fan-out, resume, workflow, routine, job, worker message,
// secret request), and what it writes is stamped guest.
//
// Consequences: a bot's fan-out records `dispatch.origin.tainted` (true or
// false, fanout.rpc.ts; a bot task without it counts as tainted); the merge lane and a
// remembered rule never merge a head a tainted task touched; an approval
// request made during one says so on its card ("started from outside text").
//
// Marks persist in `<wmuxDir>/factory/taint.json` ({version:1, handoffs}),
// the newest TAINT_MARKS_MAX kept: `true`/`false` tainted or clean, `'guest'`
// guest-sourced (and tainted). An unreadable file starts empty: every
// unmarked bot handoff then reads as tainted and of unknown provenance.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { Fact, FactKind } from '../../shared/facts';
import { botTemplate, type BotProfile } from '../../shared/bot';
import type { Handoff } from '../../shared/handoff';
import type { LedgerEntry } from '../../shared/ledger';
import type { BotWorkflow } from '../../shared/botWorkflow';
import type { WakeItem, WakeReason } from '../../shared/wake';
import { taskIdOfFactId } from './wakePrompt';
import { factInIsland, isGuestWorkspace } from './guestWorkspaces';
import { conversationMarks } from './conversationMarks';

/** Facts whose payload is GitHub-authored text. */
export const OUTSIDE_TEXT_FACT_KINDS: ReadonlySet<FactKind> = new Set<FactKind>([
  'pr.opened', 'pr.head_moved', 'pr.closed', 'pr.merged', 'pr.labelled', 'pr.review_requested_changes',
  // A check's result carries the PR's title, branch and labels.
  'ci.failed', 'ci.green',
  'issue.opened', 'issue.labelled', 'issue.closed',
  // A verdict's summary is a reviewer's reading of the PR.
  'verdict.recorded',
]);

/** Facts about a fan-out task: as tainted as the task's dispatch. */
const TASK_FACT_KINDS: ReadonlySet<FactKind> = new Set<FactKind>(['task.done', 'task.failed', 'task.input_required', 'pane.idle', 'pane.needs_input']);

/** Facts about a handoff: as tainted as the handoff. */
const HANDOFF_FACT_KINDS: ReadonlySet<FactKind> = new Set<FactKind>(['handoff.received', 'handoff.refused']);

export const TAINT_FILENAME = 'taint.json';
export const TAINT_MARKS_MAX = 5000;

/** A wake's guest provenance: `'unknown'` when its record cannot say. */
export type GuestProvenance = boolean | 'unknown';
/** A handoff's stored mark: tainted, clean, or guest-sourced (and tainted). */
export type TaintMark = boolean | 'guest';

/** The first guest (true) of `values`, else the first unknown, else false. */
function anyGuest(values: Iterable<GuestProvenance>): GuestProvenance {
  let unknown = false;
  for (const v of values) {
    if (v === true) return true;
    if (v === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : false;
}

/** A record's own guest field, else what its taint proves: a clean record
 *  (tainted false) is never guest-sourced; anything else is unknown. */
export function guestOfRecord(guest: unknown, tainted: unknown): GuestProvenance {
  if (typeof guest === 'boolean') return guest;
  return tainted === false ? false : 'unknown';
}

export interface WakeTaintPorts {
  /** Facts by id ([] for ids that cannot be found). */
  facts: (ids: readonly string[]) => Fact[];
  handoff: (id: string) => Handoff | null;
  /** A fan-out task's ledger row. */
  taskRow: (taskId: string) => LedgerEntry | null;
  /** Main's persisted workflow provenance, absent when its store is unavailable. */
  workflow?: (workflowId: string) => Pick<BotWorkflow, 'revision' | 'tainted' | 'guest'> | null;
  /** The wake `botId` is running now and when its turn started, or null. */
  runningWake: (botId: string) => { item: WakeItem; startedAt: number } | null;
  /** A bot's profile (its template and workspace), or null when it is not known. */
  bot?: (botId: string) => Pick<BotProfile, 'template' | 'role' | 'workspaceId'> | null;
  /** Whether the bot's live conversation ran a tainted wake
   *  (conversationMarks.ts). Default: its mark; a bot with no live
   *  conversation is read by its wake alone (a sending bot is in a turn,
   *  which always has one). */
  conversationTainted?: (botId: string) => boolean;
  /** Whether a workspace is a guest workspace (default isGuestWorkspace). */
  guestWorkspace?: (workspaceId: string) => GuestProvenance;
  /** `<wmuxDir>/factory/taint.json`; absent: marks in memory only. */
  file?: string;
  log?: (line: string) => void;
}

export class WakeTaint {
  private readonly marks = new Map<string, TaintMark>();

  constructor(private readonly ports: WakeTaintPorts) {
    if (!ports.file) return;
    try {
      if (!fs.existsSync(ports.file)) return;
      const raw = atomicReadJSONSync<{ version?: unknown; handoffs?: unknown }>(ports.file);
      if (raw?.version !== 1 || !raw.handoffs || typeof raw.handoffs !== 'object') throw new Error('not a version 1 taint file');
      for (const [id, v] of Object.entries(raw.handoffs as Record<string, unknown>)) if (typeof v === 'boolean' || v === 'guest') this.marks.set(id, v);
    } catch (err) {
      this.marks.clear();
      (ports.log ?? console.warn)(`[factory] ${ports.file} is unreadable; unmarked bot handoffs read as tainted: ${String(err)}`);
    }
  }

  /** Whether a wake carried outside text. Every wake in a guest workspace does. */
  wakeTainted(item: Pick<WakeItem, 'reason'> & Partial<Pick<WakeItem, 'botId' | 'workspaceId'>>): boolean {
    if (item.botId !== undefined && item.workspaceId !== undefined && this.islandGuest({ botId: item.botId, workspaceId: item.workspaceId }) !== false) return true;
    return this.reasonTainted(item.reason);
  }

  /** A wake's guest provenance. First its workspace: every wake of a bot in
   *  a guest workspace is a guest wake, the owner's own messages there
   *  included (guestWorkspaces.ts). Then its record alone (the branches of
   *  reasonTainted). */
  wakeGuest(item: Pick<WakeItem, 'reason' | 'botId' | 'workspaceId'>): GuestProvenance {
    const island = this.islandGuest(item);
    if (island === true) return true;
    const own = this.reasonGuest(item.reason);
    return own === true ? true : island === 'unknown' ? 'unknown' : own;
  }

  /** Whether a wake's workspace, or its bot's stored one, is a guest
   *  workspace; unknown when that cannot be told or the bot is missing. */
  private islandGuest(item: Pick<WakeItem, 'botId' | 'workspaceId'>): GuestProvenance {
    const guestWs = this.ports.guestWorkspace ?? isGuestWorkspace;
    try {
      const own = guestWs(item.workspaceId);
      if (own === true) return true;
      let botWs: GuestProvenance = false;
      if (this.ports.bot) {
        const profile = this.ports.bot(item.botId);
        botWs = profile ? guestWs(profile.workspaceId) : 'unknown';
      }
      if (botWs === true) return true;
      return own === 'unknown' || botWs === 'unknown' ? 'unknown' : false;
    } catch {
      return 'unknown';
    }
  }

  private reasonGuest(reason: WakeReason): GuestProvenance {
    switch (reason.kind) {
      case 'human':
      case 'manual':
      case 'schedule':
      case 'routine':
      case 'intro':
        return false;
      case 'guest':
        return true;
      case 'handoff':
      case 'mention':
        return this.handoffGuest(reason.handoffId);
      case 'held_fanout':
        return guestOfRecord(reason.guest, reason.tainted);
      case 'facts': {
        const ids = Array.isArray(reason.factIds) ? reason.factIds : [];
        let found: Fact[];
        try {
          found = this.ports.facts(ids);
        } catch {
          return 'unknown';
        }
        const byId = new Map(found.map((f) => [f.id, f]));
        return anyGuest(ids.map((id): GuestProvenance => {
          const f = byId.get(id);
          if (f) return this.factGuest(f);
          const taskId = taskIdOfFactId(id);
          if (taskId) return this.taskIdGuest(taskId);
          const workflow = /^workflow\.ready:(wf-[a-f0-9]{24})@([1-9][0-9]*)$/.exec(id);
          if (!workflow) return 'unknown';
          try {
            const saved = this.ports.workflow?.(workflow[1]);
            return saved ? guestOfRecord(saved.guest, saved.tainted) : 'unknown';
          } catch {
            return 'unknown';
          }
        }));
      }
      default:
        return 'unknown';
    }
  }

  /** One fact's guest provenance (the branches of factTainted). */
  factGuest(f: Fact): GuestProvenance {
    if (TASK_FACT_KINDS.has(f.kind)) {
      const taskId = f.ref?.taskId;
      return taskId ? this.taskIdGuest(taskId) : 'unknown';
    }
    if (HANDOFF_FACT_KINDS.has(f.kind)) {
      const id = f.ref?.handoffId;
      return id ? this.handoffGuest(id) : 'unknown';
    }
    if (f.kind === 'bot.notice') return guestOfRecord(f.payload?.guest, f.payload?.tainted === true);
    // GitHub's words and main's own facts are no guest's.
    return false;
  }

  private taskIdGuest(taskId: string): GuestProvenance {
    let row: LedgerEntry | null;
    try {
      row = this.ports.taskRow(taskId);
    } catch {
      return 'unknown';
    }
    return row ? taskGuest(row) : 'unknown';
  }

  /** The guest provenance of the wake `botId` is running now: unknown when
   *  there is none. */
  runningGuest(botId: string): GuestProvenance {
    try {
      const running = this.ports.runningWake(botId);
      return running ? this.wakeGuest(running.item) : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** A handoff's guest provenance: its record's own flag or its mark; one
   *  from the owner is clean, except an answer, which is as guest-sourced as
   *  the question it answers; an unmarked bot handoff is unknown. */
  handoffGuest(handoffId: string): GuestProvenance {
    const mark = this.marks.get(handoffId);
    if (mark === 'guest') return true;
    let h: Handoff | null;
    try {
      h = this.ports.handoff(handoffId);
    } catch {
      return 'unknown';
    }
    if (h?.guestSourced === true) return true;
    if (typeof mark === 'boolean') return false;
    if (!h) return 'unknown';
    if (h.guestSourced === false) return false;
    if (h.kind === 'answer' && h.replyTo) return this.questionGuest(h.replyTo);
    return h.from.kind === 'bot' ? 'unknown' : false;
  }

  /** A question's guest provenance (Handoff.guestSourced, written when it
   *  was asked); unknown when it is gone or says nothing. */
  private questionGuest(askId: string): GuestProvenance {
    if (this.marks.get(askId) === 'guest') return true;
    let ask: Handoff | null;
    try {
      ask = this.ports.handoff(askId);
    } catch {
      return 'unknown';
    }
    return typeof ask?.guestSourced === 'boolean' ? ask.guestSourced : 'unknown';
  }

  reasonTainted(reason: WakeReason): boolean {
    switch (reason.kind) {
      case 'human':
      case 'manual':
      case 'schedule':
      case 'routine':
      case 'intro':
        return false;
      case 'handoff':
        return this.handoffTainted(reason.handoffId);
      case 'mention':
        return this.handoffTainted(reason.handoffId);
      // An outside agent's words, whatever they say.
      case 'guest':
        return true;
      // The wake that asked for the held fan-out, as it was marked then.
      case 'held_fanout':
        return reason.tainted !== false;
      case 'facts': {
        const ids = Array.isArray(reason.factIds) ? reason.factIds : [];
        let found: Fact[];
        try {
          found = this.ports.facts(ids);
        } catch {
          return true;
        }
        const byId = new Map(found.map((f) => [f.id, f]));
        return ids.some((id) => {
          const f = byId.get(id);
          if (f) return this.factTainted(f);
          // A bot task's own wake names its task, not a logged fact.
          const taskId = taskIdOfFactId(id);
          if (taskId) return this.taskIdTainted(taskId);
          const workflow = /^workflow\.ready:(wf-[a-f0-9]{24})@([1-9][0-9]*)$/.exec(id);
          if (!workflow || !Number.isSafeInteger(Number(workflow[2]))) return true;
          try {
            const saved = this.ports.workflow?.(workflow[1]);
            // Older ready wakes inherit the current mark: a workflow that
            // acquired taint must never become clean through a stale fact.
            return !saved || !Number.isSafeInteger(saved.revision) || saved.revision < Number(workflow[2]) || saved.tainted !== false;
          } catch {
            return true;
          }
        });
      }
      default:
        return true;
    }
  }

  /** Whether one fact carries outside text. */
  factTainted(f: Fact): boolean {
    if (OUTSIDE_TEXT_FACT_KINDS.has(f.kind)) return true;
    if (TASK_FACT_KINDS.has(f.kind)) {
      const taskId = f.ref?.taskId;
      return !taskId || this.taskIdTainted(taskId);
    }
    if (HANDOFF_FACT_KINDS.has(f.kind)) {
      const id = f.ref?.handoffId;
      return !id || this.handoffTainted(id);
    }
    // Main's notice: as tainted as main marked it (it quotes outside text,
    // or tells of work a tainted wake started).
    if (f.kind === 'bot.notice') return f.payload?.tainted === true;
    return false;
  }

  /** A task's dispatch mark; an unknown task is tainted. */
  private taskIdTainted(taskId: string): boolean {
    let row: LedgerEntry | null;
    try {
      row = this.ports.taskRow(taskId);
    } catch {
      return true;
    }
    return !row || taskTainted(row);
  }

  /** A handoff's mark; one from the owner or the system is clean, an
   *  unmarked one from a bot is tainted. */
  handoffTainted(handoffId: string): boolean {
    const mark = this.marks.get(handoffId);
    if (mark === true || mark === 'guest') return true;
    let h: Handoff | null;
    try {
      h = this.ports.handoff(handoffId);
    } catch {
      return true;
    }
    if (!h) return mark ?? true;
    if (h.guestSourced === true) return true;
    // A researcher's handoff is tainted whatever mark it was given.
    if (h.from.kind === 'bot' && this.alwaysTainted(h.from.botId)) return true;
    // The owner's answer to a question asked mid-hop resumes that hop: it
    // is as tainted as the hop. An answer whose question was pruned is
    // handled like outside text: which hop it resumed is no longer known.
    if (h.kind === 'answer' && h.replyTo && this.answerResumesTaintedHop(h.replyTo)) return true;
    return mark ?? h.from.kind === 'bot';
  }

  /** The question an answer replies to was asked mid-hop on a tainted hop,
   *  or is no longer on record (pruned, or unreadable). */
  private answerResumesTaintedHop(askId: string): boolean {
    let ask: Handoff | null;
    try {
      ask = this.ports.handoff(askId);
    } catch {
      return true;
    }
    if (!ask) return true;
    return !!ask.forHop && this.handoffTainted(ask.forHop);
  }

  /** A handoff was delivered: mark it from its sender's running wake. Called
   *  on the `handoff.received` fact. */
  noteDelivered(handoffId: string): void {
    if (this.marks.has(handoffId)) return;
    let h: Handoff | null;
    try {
      h = this.ports.handoff(handoffId);
    } catch {
      h = null;
    }
    if (!h) return;
    let tainted: boolean;
    // Stamped guest when it cannot be told.
    let guest: boolean;
    if (h.from.kind !== 'bot') {
      // The owner's answer keeps the mark of the hop it resumes, and the
      // guest provenance of its question, read now while its question is on
      // record: the answer itself may be pruned later, and then only this
      // mark is left.
      tainted = h.kind === 'answer' && !!h.replyTo && this.answerResumesTaintedHop(h.replyTo);
      guest = h.guestSourced === true || (h.kind === 'answer' && !!h.replyTo && this.questionGuest(h.replyTo) !== false);
    } else if (h.relay === true || this.alwaysTainted(h.from.botId)) {
      // A relay's dispatch is wmux's, in the coordinator's name: its mark
      // is written before it is stored, never read from the coordinator's wake.
      tainted = true;
      guest = h.guestSourced !== false;
    } else {
      // The sender's turn sent it only if that turn began before it was made.
      const running = this.ports.runningWake(h.from.botId);
      const sent = running && running.startedAt <= h.createdAt ? running.item : null;
      tainted = !sent || this.wakeTainted(sent);
      guest = h.guestSourced === true || !sent || this.wakeGuest(sent) !== false;
    }
    this.mark(handoffId, guest ? 'guest' : tainted);
  }

  /** A bot's stored workspace; null when it cannot be looked up, or there
   *  is no directory to ask (then: the workspace of none). */
  botWorkspace(botId: string): string | null {
    try {
      return this.ports.bot?.(botId)?.workspaceId ?? null;
    } catch {
      return null;
    }
  }

  /** A researcher-template bot's sends are always tainted; a bot that
   *  cannot be looked up is not known to be clean either. */
  /** The sender's conversation ran a tainted wake: what it sends now may
   *  carry that text, whatever woke this turn. */
  private conversationTainted(botId: string): boolean {
    try {
      return (this.ports.conversationTainted ?? ((id: string) => conversationMarks(id)?.tainted === true))(botId);
    } catch {
      return true;
    }
  }

  private alwaysTainted(botId: string): boolean {
    if (!this.ports.bot) return false;
    try {
      const profile = this.ports.bot(botId);
      return !profile || botTemplate(profile) === 'researcher';
    } catch {
      return true;
    }
  }

  /** A bot is sending a handoff now, inside its turn: mark it from that
   *  turn's wake and the sender's conversation (a tainted one taints it), and as tainted and as guest-sourced as any handoff it
   *  answers (`answers`). `guestSource`, when given, is the provenance of
   *  the card it carries (a room mention), read in place of the turn's. A
   *  handoff already marked keeps its mark. Returns the mark, or null when
   *  a guest mark could not be written (the send is then refused). Never
   *  throws. */
  markSent(handoffId: string, senderBotId: string, answers: readonly string[] = [], guestSource?: boolean): TaintMark | null {
    const had = this.marks.get(handoffId);
    if (had !== undefined) return had;
    let tainted = true;
    let guest = true;
    try {
      const running = this.ports.runningWake(senderBotId);
      tainted = guestSource === true || !running || this.alwaysTainted(senderBotId) || this.wakeTainted(running.item)
        || this.conversationTainted(senderBotId) || answers.some((id) => this.handoffTainted(id));
      guest = (guestSource ?? (!running || this.wakeGuest(running.item) !== false)) || answers.some((id) => this.handoffGuest(id) !== false);
    } catch {
      tainted = true;
      guest = true;
    }
    const mark: TaintMark = guest ? 'guest' : tainted;
    return this.mark(handoffId, mark) || mark !== 'guest' ? mark : null;
  }

  /** wmux sends a relay's dispatch on: mark it before it is stored. Tainted
   *  when the bot whose result it carries is sending from a tainted wake
   *  (`senderBotId`, the live path) or when any of `handoffIds` (the result
   *  on a restart, the hop it answers, the relay's first dispatch) is; guest
   *  the same way. Returns the mark, or null when a guest mark could not be
   *  written (the relay then stops). Never throws. */
  markForward(handoffId: string, from: { senderBotId?: string; handoffIds: readonly string[] }): TaintMark | null {
    let tainted = true;
    let guest = true;
    try {
      const sender = from.senderBotId;
      const running = sender ? this.ports.runningWake(sender) : null;
      tainted = (sender ? !running || this.alwaysTainted(sender) || this.wakeTainted(running.item) || this.conversationTainted(sender) : false)
        || from.handoffIds.some((id) => this.handoffTainted(id));
      guest = (sender ? !running || this.wakeGuest(running.item) !== false : false)
        || from.handoffIds.some((id) => this.handoffGuest(id) !== false);
    } catch {
      tainted = true;
      guest = true;
    }
    const mark: TaintMark = guest ? 'guest' : tainted;
    return this.mark(handoffId, mark) || mark !== 'guest' ? mark : null;
  }

  /** A fact from the log (subscribe). Never throws. */
  onFact(f: Fact): void {
    try {
      if (f.kind === 'handoff.received' && typeof f.ref?.handoffId === 'string') this.noteDelivered(f.ref.handoffId);
    } catch (err) {
      (this.ports.log ?? console.warn)(`[factory] taint of handoff not recorded: ${String(err)}`);
    }
  }

  /** Store a mark; false when it did not reach the file. */
  private mark(id: string, tainted: TaintMark): boolean {
    this.marks.set(id, tainted);
    while (this.marks.size > TAINT_MARKS_MAX) {
      const first = this.marks.keys().next().value;
      if (first === undefined) break;
      this.marks.delete(first);
    }
    if (!this.ports.file) return true;
    try {
      fs.mkdirSync(path.dirname(this.ports.file), { recursive: true });
      atomicWriteJSONSync(this.ports.file, { version: 1, handoffs: Object.fromEntries(this.marks) });
      return true;
    } catch (err) {
      // In memory it still holds; after a restart the handoff reads tainted.
      (this.ports.log ?? console.warn)(`[factory] taint marks not written: ${String(err)}`);
      return false;
    }
  }
}

/** Whether a ledger row's task may carry outside text: a bot's task unless
 *  main recorded it clean (a row from before the mark, or with no dispatch,
 *  is unknown and counts as tainted); another origin only when marked. */
export function taskTainted(row: Pick<LedgerEntry, 'dispatch'>): boolean {
  const origin = row.dispatch?.origin;
  if (!origin) return true;
  return origin.kind === 'bot' ? origin.tainted !== false : origin.tainted === true;
}

/** A ledger row's guest provenance: its dispatch's own mark, else false
 *  for a task main recorded clean and unknown for any other. */
export function taskGuest(row: Pick<LedgerEntry, 'dispatch'>): GuestProvenance {
  const origin = row.dispatch?.origin;
  if (!origin) return 'unknown';
  return guestOfRecord(origin.guest, taskTainted(row) ? true : false);
}

// ── Singleton (registered by wakeTaintModule.ts) ───────────────────────────

/** Set when the taint module is part of the app (wakeTaintModule.ts). */
let trackerExpected = false;

export function expectWakeTaint(on = true): void {
  trackerExpected = on;
}

let current: { taint: WakeTaint; runningWake: WakeTaintPorts['runningWake']; wakeItem: (wakeId: string) => WakeItem | null } | null = null;

export function setWakeTaint(taint: WakeTaint | null, runningWake?: WakeTaintPorts['runningWake'], wakeItem?: (wakeId: string) => WakeItem | null): void {
  current = taint && runningWake ? { taint, runningWake, wakeItem: wakeItem ?? (() => null) } : null;
}

/** The running taint tracker, or null before the module started. */
export function getWakeTaint(): WakeTaint | null {
  return current?.taint ?? null;
}

/** What a bot is told when a guest-sourced wake (or one whose provenance is
 *  not known) asks to start, resume or message workers, or to save work
 *  that runs later (fanout.rpc.ts, workerResume.rpc.ts, workerMessage.ts,
 *  botWorkflowModule.ts, routine.rpc.ts, bot.rpc.ts, botSecret.rpc.ts). */
export const GUEST_TURN_STARTS_NO_WORKERS = 'this turn comes from an external guest\'s message (or wmux cannot tell where it came from), and such a turn starts and saves no work; tell the owner what you would do';

/** The guest provenance of wake `wakeId`, from its queue record: unknown
 *  when the record is gone or there is no tracker. */
export function guestOfWake(wakeId: string): GuestProvenance {
  const c = current;
  if (!c) return 'unknown';
  try {
    const item = c.wakeItem(wakeId);
    return item ? c.taint.wakeGuest(item) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The guest provenance of the wake `botId` is running now: unknown when
 *  there is none or no tracker. */
export function guestOfRunningWake(botId: string): GuestProvenance {
  const c = current;
  if (!c) return 'unknown';
  try {
    const item = c.runningWake(botId)?.item;
    return item ? c.taint.wakeGuest(item) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Which facts a bot's own reads (fact.poll) show: every fact in a
 *  guest-sourced wake; in any other, only facts known clean of a guest's
 *  words (WakeTaint.factGuest). Read again for each read. */
export function factVisibleToBot(botId: string): (f: Fact) => boolean {
  const c = current;
  // No tracker where one is expected (its module not started, or failed):
  // only facts that never carry a bot's or a guest's words.
  if (!c) return trackerExpected ? (f) => !TASK_FACT_KINDS.has(f.kind) && !HANDOFF_FACT_KINDS.has(f.kind) && f.kind !== 'bot.notice' : () => true;
  // The island first: a bot sees no fact across a guest workspace's
  // boundary, whatever its wake (a bot that cannot be found sees none).
  const ws = c.taint.botWorkspace(botId);
  const island = (f: Fact): boolean => ws !== null && factInIsland(ws, f);
  if (guestOfRunningWake(botId) === true) return island;
  return (f) => {
    try {
      return island(f) && c.taint.factGuest(f) === false;
    } catch {
      return false;
    }
  };
}

/** The guest provenance RpcRouter's gate reads for a bot call: the running
 *  wake's; without a tracker, unknown where one is expected (its module not
 *  started, or failed) and clean where none is (a router built without the
 *  factory, as in tests). */
export function guestGateProvenance(botId: string): GuestProvenance {
  if (!current) return untrackedGuest();
  return guestOfRunningWake(botId);
}

/** RoomWriter's turn probe (setGuestTurnProbe): whether a bot's card is
 *  written outside a wake known clean; no running wake is not known clean. */
export function guestTurnProbeOf(taint: Pick<WakeTaint, 'wakeGuest'>, runningWake: WakeTaintPorts['runningWake']): (botId: string) => boolean {
  return (botId) => {
    const running = runningWake(botId);
    return running === null || taint.wakeGuest(running.item) !== false;
  };
}

/** The provenance a reader without a tracker assumes: unknown where one is
 *  expected, clean where none is (a router or store built alone, in tests). */
export function untrackedGuest(): GuestProvenance {
  return trackerExpected ? 'unknown' : false;
}

/** Why work wake `wakeId` asks for may not start or be saved, or null: the
 *  wake is guest-sourced, or its provenance is not known. */
export function guestTurnRefusal(wakeId: string): string | null {
  return guestOfWake(wakeId) !== false ? GUEST_TURN_STARTS_NO_WORKERS : null;
}

/** Whether the wake `botId` is running now is tainted; true when it cannot
 *  be told (no tracker, no running wake). */
export function runningWakeTainted(botId: string): boolean {
  const c = current;
  if (!c) return true;
  try {
    const item = c.runningWake(botId)?.item;
    return item ? c.taint.wakeTainted(item) : true;
  } catch {
    return true;
  }
}
