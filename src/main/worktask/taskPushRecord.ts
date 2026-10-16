// ─── What task.push published, per task ────────────────────────────────────
//
// `factory/task-pushes.json`: the commit main's task.push last published for
// each task (taskPush.rpc.ts writes it after a push lands; the push sends
// that exact commit, never `HEAD`). Main's own record, not a ref in the
// task's repository the worker could move or delete. The no-changes check
// (factory/noChangesCheck.ts) reads it next to the remote itself. A push is
// fast-forward only, so the last commit holds every earlier one. Bounded,
// oldest first out.
//
// A file that exists but cannot be read is not "nothing was pushed": every
// task's answer is `unknown` from then on (the check then runs the gate),
// and the file is left as it is rather than overwritten with less.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';

export const TASK_PUSHES_FILENAME = 'task-pushes.json';
const MAX = 2000;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What the record knows of a task's pushes. */
export type TaskPushLookup = string | null | 'unknown';

export class TaskPushRecord {
  private readonly heads = new Map<string, string>();
  private loaded = false;
  private unreadable = false;
  /** Pushes under way, per task: what lands is not known until they end. */
  private readonly inflight = new Map<string, number>();

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: { version?: unknown; pushes?: unknown } | null;
    try {
      if (!fs.existsSync(this.file)) return;
      raw = atomicReadJSONSync<{ version?: unknown; pushes?: unknown }>(this.file);
    } catch {
      this.unreadable = true;
      return;
    }
    if (!raw || raw.version !== 1 || !Array.isArray(raw.pushes)) {
      this.unreadable = true;
      return;
    }
    for (const p of raw.pushes.slice(-MAX)) {
      const { taskId, sha } = (p ?? {}) as { taskId?: unknown; sha?: unknown };
      if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 200 || typeof sha !== 'string' || !SHA_RE.test(sha)) {
        this.unreadable = true;
        return;
      }
      this.heads.set(taskId, sha);
    }
  }

  /** The commit task.push last published for the task; null when it never
   *  pushed; `unknown` when the record cannot be read or a push of the task
   *  is under way. */
  get(taskId: string): TaskPushLookup {
    this.load();
    if (this.unreadable || this.inflight.has(taskId)) return 'unknown';
    return this.heads.get(taskId) ?? null;
  }

  /** A push of the task starts; `end` it (in a finally) once it is over. */
  begin(taskId: string): void {
    this.inflight.set(taskId, (this.inflight.get(taskId) ?? 0) + 1);
  }

  end(taskId: string): void {
    const n = (this.inflight.get(taskId) ?? 0) - 1;
    if (n > 0) this.inflight.set(taskId, n);
    else this.inflight.delete(taskId);
  }

  /** Record a landed push (a full commit id; anything else is ignored). */
  record(taskId: string, sha: string): void {
    if (!taskId || !SHA_RE.test(sha)) return;
    this.load();
    if (this.unreadable) {
      console.warn(`[worktask] task push record ${this.file} cannot be read; the push of ${taskId} is not added to it`);
      return;
    }
    this.heads.delete(taskId);
    this.heads.set(taskId, sha);
    while (this.heads.size > MAX) this.heads.delete(this.heads.keys().next().value as string);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWriteJSONSync(this.file, { version: 1, pushes: [...this.heads].map(([id, head]) => ({ taskId: id, sha: head })) });
    } catch (err) {
      console.warn(`[worktask] task push record not written: ${String(err)}`);
    }
  }
}

const shared = new Map<string, TaskPushRecord>();

/** The record under `wmuxDir` (one instance per file, shared in-process). */
export function taskPushRecordOf(wmuxDir: string): TaskPushRecord {
  const file = path.join(wmuxDir, 'factory', TASK_PUSHES_FILENAME);
  let r = shared.get(file);
  if (!r) {
    r = new TaskPushRecord(file);
    shared.set(file, r);
  }
  return r;
}
