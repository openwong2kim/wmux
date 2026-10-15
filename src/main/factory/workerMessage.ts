// ─── A bot writes to its own live worker ───────────────────────────────────
//
// `worker_message` (BOT_RPC.workerMessage): the bot that started an open task
// — its ledger row `working` or `input_required` — types text into that
// task's worker. This is how a bot answers its worker's question, unblocks
// it or steers it; the owner's own typing in the pane stays the other way.
//
// Main decides everything but the text:
//   - the task: its ledger row's dispatch origin names the calling bot, and
//     the row is open (an ended task's worker takes worker_resume);
//   - the pane: a pane of the task's own workspace whose agent process runs
//     (the daemon's process truth), else refused `not_running`;
//   - the delivery: the gated pane submit the report nudge uses
//     (workerReportNudge.ts submitToWorkerPane), which waits while someone
//     types there and gives up after its deadline (`held`: nothing typed);
//   - the rate: one message in flight per task, at least MIN_GAP_MS apart,
//     at most PER_HOUR in a rolling hour (attempts count, delivered or not);
//   - the origin: a message from a wake that carried outside text
//     (wakeTaint.ts) goes only to a task recorded as started from outside
//     text, so a task recorded clean only ever took clean instructions.
// The text goes in after one fixed line naming the bot and the task, so the
// worker can tell it from the owner's typing.

import { BOT_WORKER_MESSAGE_LIMITS, type BotWorkerMessageResult } from '../../shared/bot';
import type { LedgerEntry } from '../../shared/ledger';
import { runningWakeTainted } from './wakeTaint';

export const WORKER_MESSAGE_TASK_RE = /^wtask-[A-Za-z0-9_-]{1,80}$/;

export interface WorkerMessagePorts {
  /** The task's ledger row, or null. */
  row: (taskId: string) => LedgerEntry | null;
  /** The pty of the task workspace's pane whose agent runs, or null. */
  livePane: (taskWorkspaceId: string) => Promise<string | null>;
  /** The gated delivery: true once typed. `stillOk` is asked again right
   *  before the paste and the Enter (null = go on). */
  submit: (ptyId: string, text: string, stillOk: () => string | null) => Promise<boolean>;
  /** Why the bot may not act on its workers now (factory off, bot disabled
   *  or parked, its turn stopped), or null; asked again at the paste. */
  refusal?: (botId: string) => string | null;
  /** The bot's display name. */
  botName: (botId: string) => string;
  /** Whether the bot's running wake carried outside text (unknown: true).
   *  Default: the wake taint tracker. */
  senderTainted?: (botId: string) => boolean;
  now?: () => number;
}

/** The one line a bot's message starts with. Pure. */
export function workerMessageText(botName: string, taskId: string, text: string): string {
  const name = botName.replace(/[\r\n]+/g, ' ').trim().slice(0, 64) || 'the bot';
  return `[wmux] ${name}, the bot that started your task ${taskId}, writes:\n${text.trim()}`;
}

type Refused = Extract<BotWorkerMessageResult, { ok: false }>;

function refuse(code: Refused['code'], message: string): Refused {
  return { ok: false, code, message };
}

/** Rate and in-flight bookkeeping, per task. */
export class WorkerMessageLimiter {
  private readonly sent = new Map<string, number[]>();
  private readonly busy = new Set<string>();

  /** Why a message to this task may not go now, or null (and it is booked). */
  take(taskId: string, now: number): string | null {
    if (this.busy.has(taskId)) return 'a message to this worker is still being delivered';
    const recent = (this.sent.get(taskId) ?? []).filter((t) => now - t < 3_600_000);
    const last = recent[recent.length - 1];
    if (last !== undefined && now - last < BOT_WORKER_MESSAGE_LIMITS.MIN_GAP_MS) {
      return `wait ${Math.ceil((BOT_WORKER_MESSAGE_LIMITS.MIN_GAP_MS - (now - last)) / 1000)}s between messages to one worker`;
    }
    if (recent.length >= BOT_WORKER_MESSAGE_LIMITS.PER_HOUR) return `at most ${BOT_WORKER_MESSAGE_LIMITS.PER_HOUR} messages to one worker an hour`;
    recent.push(now);
    this.sent.set(taskId, recent);
    this.busy.add(taskId);
    if (this.sent.size > 500) {
      const oldest = this.sent.keys().next().value;
      if (oldest !== undefined && oldest !== taskId) this.sent.delete(oldest);
    }
    return null;
  }

  done(taskId: string): void {
    this.busy.delete(taskId);
  }
}

/** Deliver one bot's message to its worker. The caller checked who the bot
 *  is (its binding) and that it may act now. */
export async function deliverWorkerMessage(
  ports: WorkerMessagePorts,
  limiter: WorkerMessageLimiter,
  botId: string,
  raw: { taskId?: unknown; text?: unknown },
): Promise<BotWorkerMessageResult> {
  const taskId = raw.taskId;
  if (typeof taskId !== 'string' || !WORKER_MESSAGE_TASK_RE.test(taskId)) return refuse('invalid_argument', 'taskId must be a task id (wtask-…)');
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > BOT_WORKER_MESSAGE_LIMITS.TEXT_MAX) {
    return refuse('invalid_argument', `text must be 1-${BOT_WORKER_MESSAGE_LIMITS.TEXT_MAX} characters`);
  }
  const text = raw.text;
  let row: LedgerEntry | null;
  try {
    row = ports.row(taskId);
  } catch {
    row = null;
  }
  const origin = row?.dispatch?.origin;
  if (!row || origin?.kind !== 'bot' || origin.botId !== botId) return refuse('not_found', 'no task you started has this id');
  if (row.status !== 'working' && row.status !== 'input_required') {
    return refuse('not_running', `the task is ${row.status}: its worker is not taking messages (worker_resume restarts the stopped worker of an ended or reported task)`);
  }
  // Read in the same tick as the task: the wake that sends is the one asking.
  if (origin.tainted === false) {
    let tainted = true;
    try {
      tainted = (ports.senderTainted ?? runningWakeTainted)(botId) !== false;
    } catch {
      tainted = true;
    }
    if (tainted) {
      return refuse('not_now', 'this task was started from clean input, and this wake carried outside text: it takes messages only from a clean wake');
    }
  }
  const now = (ports.now ?? Date.now)();
  const limited = limiter.take(taskId, now);
  if (limited) return refuse('rate_limited', limited);
  try {
    let pane: string | null = null;
    try {
      pane = await ports.livePane(row.taskWorkspaceId);
    } catch {
      pane = null;
    }
    if (!pane) return refuse('not_running', 'the worker\'s agent is not running in its pane; nothing was typed');
    // The wait for a quiet pane can be long: who may write, and to what, is
    // asked again right before the text goes in.
    const stillOk = (): string | null => {
      let now: LedgerEntry | null;
      try {
        now = ports.row(taskId);
      } catch {
        return 'the task could not be read';
      }
      const o = now?.dispatch?.origin;
      if (!now || o?.kind !== 'bot' || o.botId !== botId || (now.status !== 'working' && now.status !== 'input_required')) return 'the task is no longer open';
      return ports.refusal?.(botId) ?? null;
    };
    const typed = await ports.submit(pane, workerMessageText(ports.botName(botId), taskId, text), stillOk).catch(() => false);
    return typed
      ? { ok: true, status: 'delivered', taskId }
      : refuse('held', 'the worker\'s pane stayed busy (someone typing, or a prompt open); nothing was typed — try again later');
  } finally {
    limiter.done(taskId);
  }
}

// ── The live pane lookup (set by workerLifecycleHost.ts) ───────────────────

let livePaneLookup: ((taskWorkspaceId: string) => Promise<string | null>) | null = null;

export function setWorkerLivePane(fn: ((taskWorkspaceId: string) => Promise<string | null>) | null): void {
  livePaneLookup = fn;
}

export function workerLivePane(taskWorkspaceId: string): Promise<string | null> {
  return livePaneLookup ? livePaneLookup(taskWorkspaceId) : Promise.resolve(null);
}
