/**
 * Caller-facing view of an `a2a.task.query` result for the a2a_task_query tool.
 *
 * The RPC returns every matching task with its full history, which grows
 * without bound (20+ tasks came back at ~74 KB and blew the 64 KiB result
 * cap). The tool therefore lists compact summaries, newest first, one page at
 * a time, and returns the full task only when the caller names it. The RPC
 * contract is untouched: the brain and other RPC callers still read full
 * tasks.
 */
import { DEFAULT_RESULT_CAP_BYTES } from './resultCap';

export const DEFAULT_TASK_PAGE_LIMIT = 20;
export const MAX_TASK_PAGE_LIMIT = 100;
/** Characters of the last message kept in a summary. */
export const TASK_PREVIEW_CHARS = 300;

export interface TaskQueryViewOptions {
  readonly taskId?: string;
  readonly messageId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Byte budget for a summary page; the page shrinks and pages on past it. */
  readonly capBytes?: number;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function updatedAtOf(task: Rec): string {
  const meta = isRec(task.metadata) ? task.metadata : {};
  return str(meta.updatedAt) ?? str(meta.createdAt) ?? '';
}

function messageText(message: unknown): string {
  if (!isRec(message) || !Array.isArray(message.parts)) return '';
  return message.parts
    .map((part) => (isRec(part) && part.kind === 'text' ? str(part.text) ?? '' : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

function preview(text: string): string {
  const chars = Array.from(text);
  return chars.length <= TASK_PREVIEW_CHARS
    ? text
    : `${chars.slice(0, TASK_PREVIEW_CHARS).join('')}…`;
}

/** One task as a summary line: identity, parties, timing, and a short look at the latest message. */
export function summarizeTask(task: Rec): Rec {
  const meta = isRec(task.metadata) ? task.metadata : {};
  const status = isRec(task.status) ? task.status : {};
  // A daemon-only task (a restart survivor) may carry no history; its status
  // message is then the latest thing said.
  const history = Array.isArray(task.history) ? task.history : [];
  const last = history.length > 0 ? history[history.length - 1] : status.message;
  const party = (side: unknown): string | undefined => (isRec(side) ? str(side.name) : undefined);
  return {
    id: task.id,
    state: status.state,
    title: str(meta.title) ?? '',
    from: party(meta.from),
    to: party(meta.to),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: history.length,
    ...(last !== undefined && {
      lastMessage: {
        ...(isRec(last) && str(last.role) !== undefined && { role: last.role }),
        preview: preview(messageText(last)),
      },
    }),
  };
}

function encodeCursor(task: Rec): string {
  return Buffer.from(JSON.stringify([updatedAtOf(task), String(task.id)]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(decoded) && decoded.length === 2 && decoded.every((part) => typeof part === 'string')) {
      return decoded as [string, string];
    }
  } catch {
    // fall through
  }
  return null;
}

/** Newest first; id breaks ties so the keyset cursor is total. */
function compareNewestFirst(a: Rec, b: Rec): number {
  // Plain code-unit order, the same order the cursor filter uses.
  const keyA = [updatedAtOf(a), String(a.id)];
  const keyB = [updatedAtOf(b), String(b.id)];
  if (keyA[0] !== keyB[0]) return keyA[0] < keyB[0] ? 1 : -1;
  return keyA[1] === keyB[1] ? 0 : keyA[1] < keyB[1] ? 1 : -1;
}

/**
 * Shape a raw `a2a.task.query` result. A result that is not a `{tasks: []}`
 * envelope (an RPC error) passes through untouched.
 */
export function shapeTaskQueryResult(result: unknown, options: TaskQueryViewOptions = {}): unknown {
  if (!isRec(result) || !Array.isArray(result.tasks)) return result;
  const envelope: Rec = { ...result };
  delete envelope.tasks;
  const tasks = (result.tasks as unknown[]).filter(isRec);

  if (options.taskId) {
    const task = tasks.find((candidate) => candidate.id === options.taskId);
    if (!task) return { error: `a2a_task_query: task ${options.taskId} not found (or filtered out by status/role/updated_since)` };
    if (!options.messageId) return { ...envelope, task };
    const history = Array.isArray(task.history) ? task.history : [];
    const message = [...history, isRec(task.status) ? task.status.message : undefined].find(
      (candidate) => isRec(candidate) && candidate.messageId === options.messageId,
    );
    if (!message) return { error: `a2a_task_query: message ${options.messageId} not found in task ${options.taskId}` };
    return { ...envelope, taskId: task.id, message };
  }
  if (options.messageId) return { error: 'a2a_task_query: message_id needs task_id' };

  const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_TASK_PAGE_LIMIT), 1), MAX_TASK_PAGE_LIMIT);
  let ordered = [...tasks].sort(compareNewestFirst);
  if (options.cursor) {
    const after = decodeCursor(options.cursor);
    if (!after) return { error: 'a2a_task_query: cursor is not a value this tool returned' };
    const [afterTime, afterId] = after;
    ordered = ordered.filter((task) => {
      const time = updatedAtOf(task);
      return time < afterTime || (time === afterTime && String(task.id) < afterId);
    });
  }
  const render = (count: number): Rec => ({
    ...envelope,
    total: ordered.length,
    tasks: ordered.slice(0, count).map(summarizeTask),
    ...(count < ordered.length && count > 0 && { nextCursor: encodeCursor(ordered[count - 1]) }),
  });
  // Summaries are bounded per task, but a page must still fit the result cap
  // whole: shrink it and page on rather than let the generic cap cut it.
  const capBytes = options.capBytes ?? DEFAULT_RESULT_CAP_BYTES;
  let count = Math.min(limit, ordered.length);
  while (count > 1 && Buffer.byteLength(JSON.stringify(render(count), null, 2), 'utf8') > capBytes) {
    count -= 1;
  }
  return render(count);
}
