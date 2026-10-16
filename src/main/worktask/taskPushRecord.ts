// ─── What task.push published, per task ────────────────────────────────────
//
// `factory/task-pushes.json`: the commit main's task.push last published for
// each task (taskPush.rpc.ts writes it after a push lands). Main's own
// record, not a ref in the task's repository the worker could move or
// delete. The bot task gate (factory/taskGate.ts) reads it before it skips
// a task as having made no changes: a task whose worker pushed commits and
// then reset its HEAD to the base still has those commits on the remote.
// A push is fast-forward only, so the last commit holds every earlier one.
// Bounded, oldest first out.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';

export const TASK_PUSHES_FILENAME = 'task-pushes.json';
const MAX = 2000;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class TaskPushRecord {
  private readonly heads = new Map<string, string>();
  private loaded = false;

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.existsSync(this.file) ? atomicReadJSONSync<{ version?: unknown; pushes?: unknown }>(this.file) : null;
      const list = raw?.version === 1 && Array.isArray(raw.pushes) ? raw.pushes : [];
      for (const p of list.slice(-MAX)) {
        const { taskId, sha } = (p ?? {}) as { taskId?: unknown; sha?: unknown };
        if (typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 200 && typeof sha === 'string' && SHA_RE.test(sha)) this.heads.set(taskId, sha);
      }
    } catch {
      this.heads.clear();
    }
  }

  /** The commit task.push last published for the task, or null. */
  get(taskId: string): string | null {
    this.load();
    return this.heads.get(taskId) ?? null;
  }

  /** Record a landed push (a full commit id; anything else is ignored). */
  record(taskId: string, sha: string): void {
    if (!taskId || !SHA_RE.test(sha)) return;
    this.load();
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
