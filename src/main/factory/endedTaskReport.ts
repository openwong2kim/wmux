// ─── A resumed worker reports on a task that has ended ─────────────────────
//
// The owner or a bot can resume the worker of a completed or cancelled bot
// task for a follow-up (worker_resume, the Resume card). Those two statuses
// are final in the ledger (shared/ledger.ts LEDGER_TRANSITIONS), so the
// worker's ledger_update after the follow-up is refused, and before this
// nobody heard of it: the bot never learned whether the follow-up worked.
//
// So a worker's refused ledger_update on its own ended task, while its worker
// is a resumed one, becomes one bot notice (botNotices.ts): a card in the
// task's thread for the owner, and a wake for the bot that started the task
// with the worker's message as data. One per resume and reported status, so
// a worker retrying with another rev wakes the bot once. The row stays as it
// is: reopening a final task would undo its gate, merge and cleanup.

import type { LedgerEntry } from '../../shared/ledger';
import { taskThreadOf } from '../../shared/room';
import type { BotNoticeInput } from './botNotices';
import type { ReclaimedWorker } from './workerReclaim';

/** What the worker tried to record. */
export interface EndedTaskReport {
  status: string;
  summary?: string;
}

/** The statuses no worker write can leave. */
const FINAL: ReadonlySet<string> = new Set(['completed', 'cancelled']);

/** The notice for a resumed worker's refused report on its ended task, or
 *  null when it is not one (an open row, not a bot's task, a worker that
 *  was not resumed). Pure. */
export function endedTaskNotice(entry: LedgerEntry, rec: Pick<ReclaimedWorker, 'state' | 'at'> | null, report: EndedTaskReport): BotNoticeInput | null {
  const botId = entry.dispatch?.origin.kind === 'bot' ? entry.dispatch.origin.botId : undefined;
  if (!botId || !FINAL.has(entry.status) || rec?.state !== 'resumed') return null;
  const summary = report.summary?.trim();
  return {
    botId,
    workspaceId: entry.ownerWorkspaceId,
    key: `worker-after-end:${entry.id}:${rec.at}:${report.status}`,
    topic: 'worker.report_after_end',
    title: `Worker of "${entry.title}" reported after its task ended`,
    body: `The worker you resumed for task ${entry.id} ("${entry.title}") tried to record ${report.status}, but the task is ${entry.status}, so the ledger refused it and the task stays ${entry.status}. `
      + (summary ? 'Its message is below.' : 'It sent no message.')
      + ' Read its pane or message it with worker_message to follow up, or start a new task.',
    ...(summary ? { detail: summary } : {}),
    threadId: taskThreadOf(entry),
    card: true,
    // A worker's report is the worker's doing, whatever it says.
    tainted: true,
    taskId: entry.id,
    notice: { code: 'worker.reportAfterEnd', args: { title: entry.title } },
  };
}

type Sink = (entry: LedgerEntry, report: EndedTaskReport) => void;
let sink: Sink | null = null;

/** The running factory's handling (workerLifecycleHost.ts); null when off. */
export function setEndedTaskReportSink(next: Sink | null): void {
  sink = next;
}

/** ledger.rpc: a worker's ledger_update on `entry` was refused. Best effort,
 *  never throws. */
export function reportOnEndedTask(entry: LedgerEntry | null, report: EndedTaskReport): void {
  if (!entry || !sink || !FINAL.has(entry.status)) return;
  try {
    sink(entry, report);
  } catch (err) {
    console.warn(`[factory] report after end of ${entry.id} not delivered: ${String(err)}`);
  }
}
