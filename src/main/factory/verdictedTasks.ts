// ─── Verify tasks whose verdict is recorded ────────────────────────────────
//
// `factory/verdicted-tasks.json`: the ids of bot verify tasks a verdict was
// recorded on (its evidence task). A verify task that reported done and has
// its verdict no longer holds a worker slot (fanout.rpc.ts); this file keeps
// that true after the verdict fact has left the fact log. Bounded, oldest
// first out.
//
// `closeVerifyTask` then moves that task's ledger row from review_requested
// to `completed`, so a graded verify task leaves the open lists: when its
// verdict is recorded (factoryWiring.ts, and again on start for a close a
// quit cut short), and when its verdict was refused because the PR head
// moved past the head the task checked out (verify.rpc.ts).

import { holderInputsChanged } from './holderInputs';
import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { LedgerUpdateInput, LedgerUpdateResult } from '../../daemon/ledger/TaskLedger';
import type { LedgerEntry } from '../../shared/ledger';
import type { PrVerdictRecord } from '../../shared/prVerdict';

export const VERDICTED_TASKS_FILENAME = 'verdicted-tasks.json';
const MAX = 2000;

export class VerdictedTasks {
  private ids: string[] = [];
  private set = new Set<string>();

  constructor(private readonly file: string) {}

  load(): void {
    try {
      const raw = fs.existsSync(this.file) ? atomicReadJSONSync<{ version?: unknown; tasks?: unknown }>(this.file) : null;
      const list = raw?.version === 1 && Array.isArray(raw.tasks) ? raw.tasks.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 200) : [];
      this.ids = list.slice(-MAX);
    } catch {
      this.ids = [];
    }
    this.set = new Set(this.ids);
  }

  has(taskId: string): boolean {
    return this.set.has(taskId);
  }

  add(taskId: string): void {
    if (!taskId || this.set.has(taskId)) return;
    this.ids.push(taskId);
    this.set.add(taskId);
    holderInputsChanged();
    while (this.ids.length > MAX) this.set.delete(this.ids.shift() as string);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWriteJSONSync(this.file, { version: 1, tasks: this.ids });
    } catch (err) {
      console.warn(`[factory] verdicted tasks not written: ${String(err)}`);
    }
  }
}

let current: VerdictedTasks | null = null;

export function setVerdictedTasks(v: VerdictedTasks | null): void {
  current = v;
}

export function getVerdictedTasks(): VerdictedTasks | null {
  return current;
}

/** The ledger calls closeVerifyTask makes (TaskLedger). */
export interface VerifyTaskLedger {
  get(id: string): LedgerEntry | null;
  update(input: LedgerUpdateInput): Promise<LedgerUpdateResult>;
}

/** Whether a row is the verify task `botId` dispatched (main-written origin). */
export function isBotVerifyTask(row: LedgerEntry, botId: string): boolean {
  const d = row.dispatch;
  return d?.origin.kind === 'bot' && d.origin.botId === botId && d.preset === 'verify';
}

/**
 * Close the verify task `taskId` that bot `botId` dispatched: `completed`,
 * written as the task's owner (the bot's workspace is the task's brain). A
 * gate that did not pass (a FAIL resting on a red gate, a stale head) is
 * closed with `why` as the forced reason the ledger records; a green gate
 * needs none. Only a row in review_requested moves; any other task, or one
 * that is not this bot's verify task, is left alone. Never throws; true when
 * the row is `completed` afterwards.
 */
export async function closeVerifyTask(ledger: VerifyTaskLedger, taskId: string, botId: string, why: string): Promise<boolean> {
  try {
    // One retry: a write that landed between the read and the update.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = ledger.get(taskId);
      if (!row || !isBotVerifyTask(row, botId)) return false;
      if (row.status !== 'review_requested') return row.status === 'completed';
      const r = await ledger.update({
        id: taskId,
        status: 'completed',
        actor: { kind: 'brain', workspaceId: row.ownerWorkspaceId },
        expectedRev: row.rev,
        force: true,
        reason: why,
      });
      if (r.ok) return true;
      if (r.error !== 'stale_rev') {
        console.warn(`[factory] verify task ${taskId} not closed: ${r.message}`);
        return false;
      }
    }
  } catch (err) {
    console.warn(`[factory] verify task ${taskId} not closed: ${String(err)}`);
  }
  return false;
}

export interface VerifyTaskClosePorts {
  ledger: VerifyTaskLedger & { list(filter: { openOnly?: boolean }): LedgerEntry[] };
  verdicted: Pick<VerdictedTasks, 'add' | 'has'>;
  /** prVerdictStore.onPrVerdictRecorded. */
  onRecorded: (fn: (r: PrVerdictRecord) => void) => () => void;
  /** The ledger's transitions: a verdicted task that reports done again
   *  (it was sent back while its verdict was being written) is closed then. */
  onTransition?: (fn: (t: { entry: LedgerEntry; to: string }) => void) => () => void;
}

/**
 * A bot verdict closes the verify task it rests on (its evidence task), PASS
 * or FAIL, whatever the PR's head is by then. At install, a verify task whose
 * verdict was recorded but whose close a quit cut short is closed too.
 * Returns the unsubscribe.
 */
export function installVerifyTaskClose(ports: VerifyTaskClosePorts): () => void {
  const off = ports.onRecorded((r) => {
    const botId = r.principal.botId;
    const taskId = r.evidence?.taskId;
    if (!botId || !taskId) return;
    ports.verdicted.add(taskId);
    void closeVerifyTask(ports.ledger, taskId, botId, `${r.verdict.toUpperCase()} verdict recorded at ${r.headSha.slice(0, 7)}`);
  });
  const offMoves = ports.onTransition?.((t) => {
    const botId = t.entry.dispatch?.origin.botId;
    if (t.to !== 'review_requested' || !botId || !isBotVerifyTask(t.entry, botId) || !ports.verdicted.has(t.entry.id)) return;
    void closeVerifyTask(ports.ledger, t.entry.id, botId, 'verdict recorded before this report');
  });
  let open: LedgerEntry[] = [];
  try {
    open = ports.ledger.list({ openOnly: true });
  } catch {
    open = [];
  }
  for (const row of open) {
    const botId = row.dispatch?.origin.botId;
    if (row.status !== 'review_requested' || !botId || !isBotVerifyTask(row, botId) || !ports.verdicted.has(row.id)) continue;
    void closeVerifyTask(ports.ledger, row.id, botId, 'verdict recorded before the app quit');
  }
  return () => {
    off();
    offMoves?.();
  };
}
