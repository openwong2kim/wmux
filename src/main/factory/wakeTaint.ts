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
//   handoff,  the handoff's own mark: recorded when it is sent (or, failing
//   mention   that, when it was delivered), from the sender's running wake
//             (a send is synchronous inside the sender's turn). A dispatch
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
// Consequences: a bot's fan-out records `dispatch.origin.tainted` (true or
// false, fanout.rpc.ts; a bot task without it counts as tainted); the merge lane and a
// remembered rule never merge a head a tainted task touched; an approval
// request made during one says so on its card ("started from outside text").
//
// Marks persist in `<wmuxDir>/factory/taint.json` ({version:1, handoffs}),
// the newest TAINT_MARKS_MAX kept. An unreadable file starts empty: every
// unmarked bot handoff then reads as tainted.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { Fact, FactKind } from '../../shared/facts';
import { botTemplate, type BotProfile } from '../../shared/bot';
import type { Handoff } from '../../shared/handoff';
import type { LedgerEntry } from '../../shared/ledger';
import type { WakeItem, WakeReason } from '../../shared/wake';
import { taskIdOfFactId } from './wakePrompt';

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

export interface WakeTaintPorts {
  /** Facts by id ([] for ids that cannot be found). */
  facts: (ids: readonly string[]) => Fact[];
  handoff: (id: string) => Handoff | null;
  /** A fan-out task's ledger row. */
  taskRow: (taskId: string) => LedgerEntry | null;
  /** The wake `botId` is running now and when its turn started, or null. */
  runningWake: (botId: string) => { item: WakeItem; startedAt: number } | null;
  /** A bot's profile (its template), or null when it is not known. */
  bot?: (botId: string) => Pick<BotProfile, 'template' | 'role'> | null;
  /** `<wmuxDir>/factory/taint.json`; absent: marks in memory only. */
  file?: string;
  log?: (line: string) => void;
}

export class WakeTaint {
  private readonly marks = new Map<string, boolean>();

  constructor(private readonly ports: WakeTaintPorts) {
    if (!ports.file) return;
    try {
      if (!fs.existsSync(ports.file)) return;
      const raw = atomicReadJSONSync<{ version?: unknown; handoffs?: unknown }>(ports.file);
      if (raw?.version !== 1 || !raw.handoffs || typeof raw.handoffs !== 'object') throw new Error('not a version 1 taint file');
      for (const [id, v] of Object.entries(raw.handoffs as Record<string, unknown>)) if (typeof v === 'boolean') this.marks.set(id, v);
    } catch (err) {
      this.marks.clear();
      (ports.log ?? console.warn)(`[factory] ${ports.file} is unreadable; unmarked bot handoffs read as tainted: ${String(err)}`);
    }
  }

  /** Whether a wake carried outside text. */
  wakeTainted(item: Pick<WakeItem, 'reason'>): boolean {
    return this.reasonTainted(item.reason);
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
          return taskId ? this.taskIdTainted(taskId) : true;
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
    if (mark === true) return true;
    let h: Handoff | null;
    try {
      h = this.ports.handoff(handoffId);
    } catch {
      return true;
    }
    if (!h) return mark ?? true;
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
    if (h.from.kind !== 'bot') {
      // The owner's answer keeps the mark of the hop it resumes, read now
      // while its question is on record: the answer itself may be pruned
      // later, and then only this mark is left.
      tainted = h.kind === 'answer' && !!h.replyTo && this.answerResumesTaintedHop(h.replyTo);
    } else if (h.relay === true || this.alwaysTainted(h.from.botId)) {
      // A relay's dispatch is wmux's, in the coordinator's name: its mark
      // is written before it is stored, never read from the coordinator's wake.
      tainted = true;
    } else {
      // The sender's turn sent it only if that turn began before it was made.
      const running = this.ports.runningWake(h.from.botId);
      tainted = !running || running.startedAt > h.createdAt ? true : this.wakeTainted(running.item);
    }
    this.mark(handoffId, tainted);
  }

  /** A researcher-template bot's sends are always tainted; a bot that
   *  cannot be looked up is not known to be clean either. */
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
   *  turn's wake, and as tainted as any handoff it answers (`answers`). A
   *  handoff already marked keeps its mark. Never throws. */
  markSent(handoffId: string, senderBotId: string, answers: readonly string[] = []): void {
    if (this.marks.has(handoffId)) return;
    let tainted = true;
    try {
      const running = this.ports.runningWake(senderBotId);
      tainted = !running || this.alwaysTainted(senderBotId) || this.wakeTainted(running.item) || answers.some((id) => this.handoffTainted(id));
    } catch {
      tainted = true;
    }
    this.mark(handoffId, tainted);
  }

  /** wmux sends a relay's dispatch on: mark it before it is stored. Tainted
   *  when the bot whose result it carries is sending from a tainted wake
   *  (`senderBotId`, the live path) or when any of `handoffIds` (the result
   *  on a restart, the hop it answers, the relay's first dispatch) is.
   *  Never throws. */
  markForward(handoffId: string, from: { senderBotId?: string; handoffIds: readonly string[] }): boolean {
    let tainted = true;
    try {
      const sender = from.senderBotId;
      const running = sender ? this.ports.runningWake(sender) : null;
      tainted = (sender ? !running || this.alwaysTainted(sender) || this.wakeTainted(running.item) : false)
        || from.handoffIds.some((id) => this.handoffTainted(id));
    } catch {
      tainted = true;
    }
    this.mark(handoffId, tainted);
    return tainted;
  }

  /** A fact from the log (subscribe). Never throws. */
  onFact(f: Fact): void {
    try {
      if (f.kind === 'handoff.received' && typeof f.ref?.handoffId === 'string') this.noteDelivered(f.ref.handoffId);
    } catch (err) {
      (this.ports.log ?? console.warn)(`[factory] taint of handoff not recorded: ${String(err)}`);
    }
  }

  private mark(id: string, tainted: boolean): void {
    this.marks.set(id, tainted);
    while (this.marks.size > TAINT_MARKS_MAX) {
      const first = this.marks.keys().next().value;
      if (first === undefined) break;
      this.marks.delete(first);
    }
    if (!this.ports.file) return;
    try {
      fs.mkdirSync(path.dirname(this.ports.file), { recursive: true });
      atomicWriteJSONSync(this.ports.file, { version: 1, handoffs: Object.fromEntries(this.marks) });
    } catch (err) {
      // In memory it still holds; after a restart the handoff reads tainted.
      (this.ports.log ?? console.warn)(`[factory] taint marks not written: ${String(err)}`);
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

// ── Singleton (registered by wakeTaintModule.ts) ───────────────────────────

let current: { taint: WakeTaint; runningWake: WakeTaintPorts['runningWake'] } | null = null;

export function setWakeTaint(taint: WakeTaint | null, runningWake?: WakeTaintPorts['runningWake']): void {
  current = taint && runningWake ? { taint, runningWake } : null;
}

/** The running taint tracker, or null before the module started. */
export function getWakeTaint(): WakeTaint | null {
  return current?.taint ?? null;
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
