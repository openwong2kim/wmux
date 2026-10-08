/**
 * Paged view of `a2a.task.query` for the a2a_task_query tool.
 *
 * Full tasks carry their whole history, which grows without bound: 20+ tasks
 * blew the 64 KiB tool result cap, and 135 tasks (~1.4 MB) outgrew the 1 MiB
 * daemon line, so the reply was dropped and the call sat out the 10 s RPC
 * timeout. A caller that sends `view: 'page'` therefore gets compact
 * summaries, newest first, one page at a time, and the full task only when it
 * names one — itself bounded, newest messages first.
 *
 * The work is split so no hop carries full histories for a list: each task
 * source (renderer cache, daemon log) runs {@link applyTaskQueryView} on its
 * own rows, main merges the two and runs {@link shapeTaskQueryResult}. A call
 * without `view` is untouched: the brain and other RPC callers still read full
 * tasks. Runs in the renderer too, so nothing here that the renderer calls
 * may touch Node's Buffer.
 */

import { isReceiverPaneGone, normalizeLivePaneIds } from './a2aOrphanedTask';
import { TERMINAL_STATES } from './types';

/** Byte budget for one result: the MCP tool result cap (DEFAULT_RESULT_CAP_BYTES). */
export const TASK_QUERY_CAP_BYTES = 64 * 1024;

export const DEFAULT_TASK_PAGE_LIMIT = 20;
export const MAX_TASK_PAGE_LIMIT = 100;
/** Characters of the last message kept in a summary. */
export const TASK_PREVIEW_CHARS = 300;
/** Byte bounds for the free-text fields of a summary. */
const TITLE_MAX_BYTES = 400;
const NAME_MAX_BYTES = 200;

export interface TaskQueryViewOptions {
  readonly taskId?: string;
  readonly messageId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Byte budget for one result; the view pages on rather than exceed it. */
  readonly capBytes?: number;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** UTF-8 length of a string (a lone surrogate encodes as U+FFFD, 3 bytes). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function bytesOf(value: unknown): number {
  return utf8Length(JSON.stringify(value, null, 2));
}

/** Cut to at most `maxBytes` of UTF-8 on a code-point boundary, marking the cut. */
function clipBytes(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (used + size > maxBytes - 3) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

/** Sort and cursor keys of a summary row. */
function createdAtOf(summary: Rec): string {
  return str(summary.createdAt) ?? '';
}

function updatedAtOf(summary: Rec): string {
  return str(summary.updatedAt) ?? str(summary.createdAt) ?? '';
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
  const party = (side: unknown): string | undefined => {
    const name = isRec(side) ? str(side.name) : undefined;
    return name === undefined ? undefined : clipBytes(name, NAME_MAX_BYTES);
  };
  return {
    id: task.id,
    state: status.state,
    title: clipBytes(str(meta.title) ?? '', TITLE_MAX_BYTES),
    from: party(meta.from),
    to: party(meta.to),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: history.length,
    // A task sent to another PC: how far the receiver got (its receipts).
    ...(isRec(meta.remote) && (meta.remote.remoteReadAt || meta.remote.remoteDeliveredAt)
      ? { remoteReceipt: meta.remote.remoteReadAt ? 'read' : 'delivered' }
      : {}),
    ...(last !== undefined && {
      lastMessage: {
        ...(isRec(last) && str(last.role) !== undefined && { role: last.role }),
        preview: preview(messageText(last)),
      },
    }),
  };
}

function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** Decode a cursor of the given kind ('l' = task list, 'h' = task history). */
function decodeCursor(cursor: string, kind: 'l' | 'h', arity: number): string[] | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(decoded) &&
      decoded.length === arity &&
      decoded[0] === kind &&
      decoded.every((part) => typeof part === 'string')
    ) {
      return decoded as string[];
    }
  } catch {
    // fall through
  }
  return null;
}

const BAD_CURSOR = { error: 'a2a_task_query: cursor is not a value this tool returned for this query' };

/**
 * Newest first by CREATION time, id breaking ties: an immutable key, so a task
 * updated while the caller pages cannot jump across the cursor and vanish.
 */
function compareNewestFirst(a: Rec, b: Rec): number {
  const keyA = [createdAtOf(a), String(a.id)];
  const keyB = [createdAtOf(b), String(b.id)];
  if (keyA[0] !== keyB[0]) return keyA[0] < keyB[0] ? 1 : -1;
  return keyA[1] === keyB[1] ? 0 : keyA[1] < keyB[1] ? 1 : -1;
}

function detailView(envelope: Rec, task: Rec, cursor: string | undefined, capBytes: number): unknown {
  const history = Array.isArray(task.history) ? task.history : [];
  let end = history.length;
  if (cursor) {
    const decoded = decodeCursor(cursor, 'h', 2);
    const index = decoded ? history.findIndex((m) => isRec(m) && m.messageId === decoded[1]) : -1;
    if (index < 0) return BAD_CURSOR;
    end = index;
  }
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const render = (shown: number, summarizeArtifacts: boolean): Rec => {
    const start = end - shown;
    const olderId = start > 0 && isRec(history[start]) ? str(history[start].messageId) : undefined;
    return {
      ...envelope,
      task: {
        ...task,
        history: history.slice(start, end),
        ...(summarizeArtifacts && {
          artifacts: artifacts.map((artifact) => ({
            ...(isRec(artifact) && str(artifact.name) !== undefined && { name: clipBytes(str(artifact.name)!, NAME_MAX_BYTES) }),
            parts: isRec(artifact) && Array.isArray(artifact.parts) ? artifact.parts.length : 0,
            bytes: bytesOf(artifact),
          })),
        }),
      },
      ...(summarizeArtifacts && { artifactsSummarized: true }),
      ...(shown < history.length && { historyTruncated: { shownMessages: shown, totalMessages: history.length } }),
      ...(olderId !== undefined && { nextCursor: encodeCursor(['h', olderId]) }),
    };
  };
  const fits = (view: Rec): boolean => bytesOf(view) <= capBytes;
  if (fits(render(end, false))) return render(end, false);
  // Artifacts go first (their size is stated), then the oldest messages: the
  // most recent messages that fit, found by search since sizes vary.
  if (!fits(render(0, true))) {
    return { error: 'a2a_task_query: this task does not fit one result even without its history; fetch messages with message_id' };
  }
  let low = 0;
  let high = end;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(render(mid, true))) low = mid;
    else high = mid - 1;
  }
  return render(low, true);
}

/** Whether an `a2a.task.query` call asked for the paged view. */
export function isPagedTaskQuery(params: Rec): boolean {
  return params.view === 'page';
}

/** The task a paged call names, if any (then it gets that task in full). */
export function pagedTaskId(params: Rec): string | undefined {
  return isPagedTaskQuery(params) && typeof params.taskId === 'string' && params.taskId ? params.taskId : undefined;
}

/**
 * `row` with `orphaned: true` when `task` is pinned to a receiver pane of the
 * querying workspace that no longer exists (#1598). Main supplies the live
 * pane ids of that workspace as `params.livePaneIds`; without them (pane tree
 * unreadable, or a call main did not annotate) nothing is flagged. An ended
 * task is never flagged: nobody has to adopt it, so the mark would be noise.
 */
export function flagOrphanedTask(row: Rec, task: Rec, params: Rec): Rec {
  const state = isRec(task.status) ? task.status.state : undefined;
  if ((TERMINAL_STATES as readonly unknown[]).includes(state)) return row;
  const meta = isRec(task.metadata) ? task.metadata : undefined;
  const to = meta && isRec(meta.to) ? meta.to : undefined;
  const workspaceId = str(params.workspaceId);
  return workspaceId && isReceiverPaneGone(to, workspaceId, normalizeLivePaneIds(params.livePaneIds))
    ? { ...row, orphaned: true }
    : row;
}

/**
 * #1680 — `view: 'anchors'`: the open tasks only (not completed, failed or
 * canceled; a task with no readable state counts as open), each reduced to its
 * id, state and the pane anchors of both sides. Main's fresh-context step asks
 * the daemon for this to learn whether a pane is mid-thread; full tasks carry
 * their whole history and a busy workspace's list can outgrow the 1 MiB daemon
 * line. A source that predates the view ignores it and answers in full.
 */
export function isAnchorTaskQuery(params: Rec): boolean {
  return params.view === 'anchors';
}

const ANCHOR_KEYS = ['workspaceId', 'paneId', 'surfaceId', 'ptyId'] as const;

function anchorsOf(side: unknown): Rec {
  const out: Rec = {};
  if (!side || typeof side !== 'object') return out;
  for (const key of ANCHOR_KEYS) {
    const value = (side as Rec)[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function taskAnchorRows<T extends object>(tasks: readonly T[]): Rec[] {
  const rows: Rec[] = [];
  for (const task of tasks as readonly Rec[]) {
    const status = task.status && typeof task.status === 'object' ? (task.status as Rec) : undefined;
    const state = status?.state;
    if (typeof state === 'string' && (TERMINAL_STATES as readonly string[]).indexOf(state) !== -1) continue;
    const metadata = task.metadata && typeof task.metadata === 'object' ? (task.metadata as Rec) : {};
    rows.push({
      id: task.id,
      status: typeof state === 'string' ? { state } : {},
      metadata: { to: anchorsOf(metadata.to), from: anchorsOf(metadata.from) },
    });
  }
  return rows;
}

/**
 * What one task source returns for a query: every task in full without
 * `view` (the legacy contract), and for `view: 'page'` either the named task in
 * full or a summary of each task, flagged when orphaned.
 */
export function applyTaskQueryView<T extends object>(tasks: readonly T[], params: Rec): unknown[] {
  if (isAnchorTaskQuery(params)) return taskAnchorRows(tasks);
  if (!isPagedTaskQuery(params)) return [...tasks];
  const taskId = pagedTaskId(params);
  if (taskId) {
    return tasks
      .filter((task) => (task as Rec).id === taskId)
      .map((task) => flagOrphanedTask(task as Rec, task as Rec, params));
  }
  return tasks.map((task) => flagOrphanedTask(summarizeTask(task as Rec), task as Rec, params));
}

/**
 * Shape a merged paged `a2a.task.query` result: full tasks when
 * `options.taskId` names one, summary rows ({@link summarizeTask}) otherwise.
 * A result that is not a `{tasks: []}` envelope (an RPC error) passes through
 * untouched.
 */
export function shapeTaskQueryResult(result: unknown, options: TaskQueryViewOptions = {}): unknown {
  if (!isRec(result) || !Array.isArray(result.tasks)) return result;
  const envelope: Rec = { ...result };
  delete envelope.tasks;
  const tasks = (result.tasks as unknown[]).filter(isRec);
  const capBytes = options.capBytes ?? TASK_QUERY_CAP_BYTES;

  if (options.taskId) {
    const task = tasks.find((candidate) => candidate.id === options.taskId);
    if (!task) return { error: `a2a_task_query: task ${options.taskId} not found (or filtered out by status/role/updated_since)` };
    if (!options.messageId) return detailView(envelope, task, options.cursor, capBytes);
    const history = Array.isArray(task.history) ? task.history : [];
    const message = [...history, isRec(task.status) ? task.status.message : undefined].find(
      (candidate) => isRec(candidate) && candidate.messageId === options.messageId,
    );
    if (!message) return { error: `a2a_task_query: message ${options.messageId} not found in task ${options.taskId}` };
    const view = { ...envelope, taskId: task.id, message };
    return bytesOf(view) <= capBytes ? view : { error: `a2a_task_query: message ${options.messageId} is larger than one result` };
  }
  if (options.messageId) return { error: 'a2a_task_query: message_id needs task_id' };

  const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_TASK_PAGE_LIMIT), 1), MAX_TASK_PAGE_LIMIT);
  const ordered = [...tasks].sort(compareNewestFirst);
  // Snapshot of the newest update when paging began, carried in the cursor so
  // every page reports the same value: polling from it with updated_since
  // catches whatever changed while the caller paged.
  let snapshot = ordered.reduce((max, task) => (updatedAtOf(task) > max ? updatedAtOf(task) : max), '');
  let rest = ordered;
  if (options.cursor) {
    const after = decodeCursor(options.cursor, 'l', 4);
    if (!after) return BAD_CURSOR;
    const [, afterCreated, afterId, carried] = after;
    snapshot = carried;
    rest = ordered.filter((task) => {
      const created = createdAtOf(task);
      return created < afterCreated || (created === afterCreated && String(task.id) < afterId);
    });
  }
  const render = (count: number): Rec => ({
    ...envelope,
    total: ordered.length,
    remaining: rest.length - count,
    tasks: rest.slice(0, count),
    ...(snapshot && { nextUpdatedSince: snapshot }),
    ...(count < rest.length && count > 0 && {
      nextCursor: encodeCursor(['l', createdAtOf(rest[count - 1]), String(rest[count - 1].id), snapshot]),
    }),
  });
  let count = Math.min(limit, rest.length);
  while (count > 0 && bytesOf(render(count)) > capBytes) count -= 1;
  if (count === 0 && rest.length > 0) {
    return { error: 'a2a_task_query: not even one task summary fits one result' };
  }
  return render(count);
}
