// ─── A bot worker that answered but never reported its task ────────────────
//
// A worker's task is done only when the worker moves its ledger row
// (ledger_update → review_requested, which main's gate then completes). A
// worker that ends its turn with the answer on screen and the row still
// `working` leaves the task open, and its process resident, until someone
// looks. For a task a bot started, main notices that on the worker's turn
// end and, once its pane has stayed idle for REPORT_NUDGE_GRACE_MS:
//   1. types one fixed reminder into the worker's own pane (the task id and
//      rev, no other text), through the same gated delivery as a message to
//      a pane, which waits while someone is typing there — once per task;
//   2. if the turn that follows ends with the row still `working`, moves the
//      row to `input_required` as the system (so the bot that started it is
//      woken and the Bots page shows it), with a card saying why.
// Nothing here stops or closes the worker.

import type { LedgerEntry } from '../../shared/ledger';
import type { LedgerUpdateInput, LedgerUpdateResult } from '../../daemon/ledger/TaskLedger';
import { taskThreadOf, type CardNotice, type ThreadId } from '../../shared/room';
import { registerDeliveryCheck } from '../pipe/deliveryGuards';

/** How long a worker's pane must stay idle after a turn end before a nudge. */
export const REPORT_NUDGE_GRACE_MS = 45_000;
export const UNREPORTED_SUMMARY = 'the worker answered but did not report its task (reminded once)';

/** The one reminder line. Fixed text, the task id and rev only. Pure. */
export function reportNudgeText(taskId: string, rev: number): string {
  return `[wmux] Your task ${taskId} is still "working" in the task ledger (rev ${rev}). If it is done and your checks passed, call ledger_update with task_id "${taskId}", status "review_requested", expected_rev ${rev} and a one-line summary. If you are blocked, use status "input_required". Do not redo the work.`;
}

export interface ReportNudgePorts {
  ledger: {
    findOpenByTaskWorkspace(taskWorkspaceId: string): LedgerEntry | null;
    get(id: string): LedgerEntry | null;
    update(input: LedgerUpdateInput): Promise<LedgerUpdateResult>;
  };
  /** True while the pane shows a running turn. */
  isRunning: (ptyId: string) => boolean;
  /** Paste the line + Enter into the pane (gated); true when it was sent. */
  submit: (ptyId: string, text: string) => Promise<boolean>;
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string, notice?: CardNotice) => void;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  log?: (msg: string) => void;
}

export interface ReportNudger {
  noteLifecycle(ev: { workspaceId: string; ptyId: string; kind: string; source?: string; decision?: string }): void;
  dispose(): void;
}

/** Whether a row is a bot task still `working` (the only kind nudged). Pure. */
export function isUnreportedBotTask(row: LedgerEntry | null): row is LedgerEntry {
  const origin = row?.dispatch?.origin;
  return !!row && row.status === 'working' && origin?.kind === 'bot' && typeof origin.botId === 'string' && origin.botId.length > 0;
}

export function installReportNudge(ports: ReportNudgePorts): ReportNudger {
  const log = ports.log ?? ((m: string) => console.warn(m));
  const graceMs = ports.graceMs ?? REPORT_NUDGE_GRACE_MS;
  const setTimer = ports.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  /** taskId → the pane the reminder went to. */
  const nudged = new Map<string, string>();
  const surfaced = new Set<string>();
  const pending = new Set<string>();
  let disposed = false;

  const note = (row: LedgerEntry, title: string, body: string, notice: CardNotice): void => {
    try {
      ports.note?.(row.ownerWorkspaceId, taskThreadOf(row), title, body, notice);
    } catch {
      /* best effort */
    }
  };

  const check = async (taskId: string, ptyId: string): Promise<void> => {
    const row = ports.ledger.get(taskId);
    if (disposed || !isUnreportedBotTask(row) || ports.isRunning(ptyId)) return;
    const sentTo = nudged.get(taskId);
    if (sentTo === undefined) {
      const sent = await ports.submit(ptyId, reportNudgeText(row.id, row.rev)).catch(() => false);
      if (!sent) return; // held (someone typing, an approval): the next turn end tries again
      nudged.set(taskId, ptyId);
      note(row, 'Worker answered without reporting its task', 'wmux reminded it once to record the result in the task ledger.', { code: 'worker.noReport' });
      return;
    }
    if (sentTo !== ptyId || surfaced.has(taskId)) return;
    // Held while the write runs (a turn end meanwhile moves nothing twice);
    // kept only once it landed, so a failed write is tried at the next one.
    surfaced.add(taskId);
    const r = await ports.ledger.update({
      id: taskId,
      status: 'input_required',
      actor: { kind: 'system', workspaceId: row.ownerWorkspaceId },
      expectedRev: row.rev,
      summary: UNREPORTED_SUMMARY,
    }).catch((err: unknown) => {
      log(`[factory] report nudge: ${taskId} not moved: ${String(err)}`);
      return null;
    });
    if (!r?.ok) {
      surfaced.delete(taskId);
      return;
    }
    if (!r.noop) note(row, 'Worker still has not reported its task', 'The task needs a look: the worker answered twice without recording a result. It keeps running.', { code: 'worker.stillNoReport' });
  };

  return {
    noteLifecycle(ev) {
      if (disposed) return;
      if (ev.kind !== 'agent.stop' && ev.kind !== 'agent.stop_failure') return;
      if (ev.source === 'osc133' || ev.decision === 'internal' || ev.decision === 'dedup') return;
      let row: LedgerEntry | null = null;
      try {
        row = ports.ledger.findOpenByTaskWorkspace(ev.workspaceId);
      } catch {
        row = null;
      }
      if (!isUnreportedBotTask(row) || pending.has(row.id)) return;
      const taskId = row.id;
      pending.add(taskId);
      // Pending until the check (and its delivery) ends: a turn end meanwhile
      // starts no second reminder.
      setTimer(() => {
        void check(taskId, ev.ptyId)
          .catch((err) => log(`[factory] report nudge for ${taskId} failed: ${String(err)}`))
          .finally(() => pending.delete(taskId));
      }, graceMs);
    },
    dispose() {
      disposed = true;
    },
  };
}

// ── The pane delivery (main/index.ts sets it: input.rpc's gated submit) ────

/** `guardKey`: a delivery check (pipe/deliveryGuards.ts) the gated
 *  delivery runs right before the paste and right before the Enter. */
let paneSubmit: ((ptyId: string, text: string, guardKey?: string) => Promise<boolean>) | null = null;

export function setWorkerPaneSubmit(fn: ((ptyId: string, text: string, guardKey?: string) => Promise<boolean>) | null): void {
  paneSubmit = fn;
}

let guardSeq = 0;

/** Deliver text into a worker pane, or false when no delivery is wired.
 *  `stillOk` (null = go on, else why not) is asked again right before the
 *  paste and right before the Enter, after any wait for the pane. */
export async function submitToWorkerPane(ptyId: string, text: string, stillOk?: () => string | null): Promise<boolean> {
  if (!paneSubmit) return false;
  if (!stillOk) return paneSubmit(ptyId, text);
  const key = `worker-pane:${process.pid}:${++guardSeq}`;
  const off = registerDeliveryCheck(key, { beforePaste: stillOk, beforeEnter: stillOk });
  try {
    return await paneSubmit(ptyId, text, key);
  } finally {
    off();
  }
}
