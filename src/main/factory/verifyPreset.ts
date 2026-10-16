// ─── The verify preset, main's half — the gate a verdict rests on ──────────
//
// A verify worker (worktask/botFanoutPresets.ts) sits on a detached checkout
// of a PR head, installs dependencies, reads the change and reports
// review_requested. The worker's report is its reading; the evidence a
// verdict can count on is a gate main ran and recorded itself. So when a
// bot-dispatched `verify` task reaches review_requested, main runs the
// repository gate in that worktree:
//   - with the gate chosen from origin's default branch (`gateBaseRef`), so
//     a PR cannot redefine the gate that grades it;
//   - through the shared TaskGateRunner, which records the result as a
//     `system` write and pins the HEAD it ran on (only on a clean tree).
// When the run ends, a system card in the task's thread (the thread of the
// wake that started it, e.g. the PR's, else `task:<id>`) says what happened,
// and the bot that dispatched it (any bot may verify) is woken once more
// (`task.gated:<taskId>@<rev>`) to read the recorded gate and record its
// verdict. The worker's own
// review_requested wake (fanoutCallerNotify) comes first, before the gate
// exists; the verifier's prompt says to end that turn.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LedgerEntry } from '../../shared/ledger';
import type { BotProfile } from '../../shared/bot';
import { taskThreadOf, type CardNotice, type ThreadId } from '../../shared/room';
import type { WakeReason } from '../../shared/wake';
import type { GateRunInput, GateRunResult } from '../worktask/TaskGateRunner';
import { metaDirForWorktree } from '../worktask/TaskWorktreeManager';
import { WORKTASK_META_FILENAME } from '../../shared/workTask';

/** The fact id a recorded verify gate wakes its bot with. */
export function verifyGateFactId(taskId: string, rev: number): string {
  return `task.gated:${taskId}@${rev}`;
}

/** The daemon's workspace id the gate is written as (worktask.rpc's default). */
export const VERIFY_GATE_SYSTEM_WORKSPACE = 'ws-daemon';

export interface VerifyGatePorts {
  /** The task ledger's transitions and rows. */
  onTransition: (fn: (t: { entry: LedgerEntry; from: string | null; to: string }) => void) => () => void;
  ledgerRow: (taskId: string) => LedgerEntry | null;
  /** The open ledger rows, read once at install (restart reconciliation). */
  openRows?: () => LedgerEntry[];
  /** The bot that dispatched the task. */
  bot: (botId: string) => BotProfile | null;
  /** The task's worktree on disk, or null. */
  worktreeOf: (entry: LedgerEntry) => Promise<string | null>;
  /** origin's default branch as a ref (`origin/main`), or null. */
  baseRef: (repoPath: string) => Promise<string | null>;
  runGate: (input: GateRunInput) => Promise<GateRunResult>;
  wake: (input: { botId: string; workspaceId: string; reason: WakeReason; priority: 1; threadId: ThreadId }) => unknown;
  /** A system card in the task's thread (best effort), with its stable
   *  code (RoomCard.notice). */
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string, notice?: CardNotice) => void;
  log?: (msg: string) => void;
}

/** Whether a transition is a bot verify task reporting done. */
export function isVerifyReport(entry: LedgerEntry, to: string): boolean {
  const d = entry.dispatch;
  return to === 'review_requested'
    && d?.origin.kind === 'bot' && typeof d.origin.botId === 'string'
    && d.preset === 'verify' && d.checkout?.detached === true;
}

/** One line on what a gate run produced, for the task's thread: its
 *  English words and its stable code (RoomCard.notice). */
export function describeGateRun(r: GateRunResult): { title: string; body: string; notice: CardNotice } {
  if (r.ok && r.status === 'completed') {
    const g = r.result;
    const verdict = g.exitCode === 0 ? 'passed' : g.exitCode === null ? 'was killed' : `failed (exit ${g.exitCode})`;
    const head = g.headSha ? `at ${g.headSha}` : 'with no pinned head (the tree changed or HEAD moved during the run)';
    const notice: CardNotice = g.exitCode === 0 ? { code: 'verify.passed' } : g.exitCode === null ? { code: 'verify.killed' } : { code: 'verify.failed', args: { exit: g.exitCode } };
    return { title: `Verify gate ${verdict}`, body: `\`${g.command}\` ${head}; ${r.recorded ? 'recorded in the ledger' : 'NOT recorded (ledger unreachable)'}.`, notice };
  }
  if (r.ok && r.status === 'skipped') {
    return {
      title: `Verify gate skipped (${r.skipped})`, body: r.recorded ? `${r.detail} A recorded skip proves nothing about the head.` : r.detail,
      notice: { code: 'verify.skipped', args: { reason: r.skipped } },
    };
  }
  if (!r.ok && r.status === 'busy') return { title: 'Verify gate already running', body: 'A gate for this task is running; its result follows.', notice: { code: 'verify.busy' } };
  return { title: 'Verify gate refused', body: r.ok ? '' : r.error, notice: { code: 'verify.refused' } };
}

/**
 * Run the verify gate for every bot verify task that reports
 * review_requested. Returns the unsubscribe. One run per task at a time (the
 * runner answers `busy` for a second one). At install, a verify task that
 * reported before a restart is caught up: without a recorded gate it is
 * gated now; with one, its verifier wake is queued again (the wake queue
 * drops it when that gate's wake was already delivered).
 */
export function installVerifyGate(ports: VerifyGatePorts): () => void {
  const log = ports.log ?? ((m: string) => console.warn(m));
  const running = new Set<string>();
  const run = async (entry: LedgerEntry): Promise<void> => {
    const botId = entry.dispatch?.origin.botId ?? '';
    const thread = taskThreadOf(entry);
    const note = (title: string, body: string, notice: CardNotice): void => {
      try {
        ports.note?.(entry.ownerWorkspaceId, thread, title, body, notice);
      } catch {
        /* the card is best effort */
      }
    };
    const bot = ports.bot(botId);
    const repoPath = bot?.repo?.repoPath;
    if (!bot || !repoPath) {
      note('Verify gate not run', 'The bot that dispatched this task is gone or has no repository.', { code: 'verify.notRunNoBot' });
      return;
    }
    const [worktree, baseRef] = await Promise.all([ports.worktreeOf(entry), ports.baseRef(repoPath)]);
    // A task that left review_requested during the lookups gets no gate.
    const current = ports.ledgerRow(entry.id);
    if (current && !isVerifyReport(current, current.status)) return;
    if (!worktree || !baseRef) {
      note('Verify gate not run', !worktree ? 'The task worktree is not on disk.' : 'origin\'s default branch could not be resolved, so there is no base gate to run.', { code: !worktree ? 'verify.notRunNoWorktree' : 'verify.notRunNoBaseRef' });
      ports.wake({
        botId, workspaceId: entry.ownerWorkspaceId, priority: 1, threadId: thread,
        reason: { kind: 'facts', factIds: [verifyGateFactId(entry.id, entry.rev)], trigger: { kind: 'task.done' } },
      });
      return;
    }
    const result = await ports.runGate({
      taskId: entry.id,
      worktreePath: worktree,
      systemWorkspaceId: VERIFY_GATE_SYSTEM_WORKSPACE,
      projectRoot: repoPath,
      gateBaseRef: baseRef,
    });
    if (!result.ok && result.status === 'busy') return;
    // A task that left review_requested while its gate ran (sent back,
    // cancelled, stopped by the owner) is not reported on.
    const after = ports.ledgerRow(entry.id);
    if (after && !isVerifyReport(after, after.status)) return;
    const { title, body, notice } = describeGateRun(result);
    note(title, body, notice);
    const rev = ports.ledgerRow(entry.id)?.rev ?? entry.rev;
    ports.wake({
      botId, workspaceId: entry.ownerWorkspaceId, priority: 1, threadId: thread,
      reason: { kind: 'facts', factIds: [verifyGateFactId(entry.id, rev)], trigger: { kind: 'task.done' } },
    });
  };
  const start = (entry: LedgerEntry): void => {
    if (running.has(entry.id)) return;
    running.add(entry.id);
    void run(entry)
      .catch((err) => log(`[factory] verify gate for ${entry.id} failed: ${String(err)}`))
      .finally(() => running.delete(entry.id));
  };
  const off = ports.onTransition((t) => {
    if (isVerifyReport(t.entry, t.to)) start(t.entry);
  });
  let open: LedgerEntry[] = [];
  try {
    open = ports.openRows?.() ?? [];
  } catch {
    open = [];
  }
  for (const entry of open) {
    if (!isVerifyReport(entry, entry.status)) continue;
    const gate = entry.gate;
    if (!gate || gate.recordedBy !== 'system') {
      start(entry);
      continue;
    }
    const botId = entry.dispatch?.origin.botId ?? '';
    try {
      ports.wake({
        botId, workspaceId: entry.ownerWorkspaceId, priority: 1, threadId: taskThreadOf(entry),
        reason: { kind: 'facts', factIds: [verifyGateFactId(entry.id, entry.rev)], trigger: { kind: 'task.done' } },
      });
    } catch (err) {
      log(`[factory] verify gate wake for ${entry.id} failed: ${String(err)}`);
    }
  }
  return off;
}

// ── Default ports ──────────────────────────────────────────────────────────

type Rpc = (method: string, params?: unknown) => Promise<unknown>;
type Git = (args: string[], cwd: string) => Promise<{ stdout: string; code: number }>;

/** The worktree of a task, from the daemon's mission list of its owner. */
export async function worktreeFromMissions(rpc: Rpc | null, entry: LedgerEntry): Promise<string | null> {
  if (!rpc) return null;
  let reply: unknown;
  try {
    reply = await rpc('task.mission.list', { verifiedWorkspaceId: entry.ownerWorkspaceId });
  } catch {
    return null;
  }
  const tasks = (reply as { ok?: unknown; tasks?: unknown } | null);
  if (!tasks || tasks.ok !== true || !Array.isArray(tasks.tasks)) return null;
  for (const t of tasks.tasks as Array<Record<string, unknown>>) {
    if (t && t.id === entry.id && typeof t.worktreePath === 'string' && t.worktreePath) return t.worktreePath;
  }
  return null;
}

/** The folder a task's worker runs in: its worktree, or the output folder of
 *  a task without one (a research task's scratch folder), or null. */
export async function taskFolderFromMissions(rpc: Rpc | null, entry: LedgerEntry): Promise<string | null> {
  if (!rpc) return null;
  let reply: unknown;
  try {
    reply = await rpc('task.mission.list', { verifiedWorkspaceId: entry.ownerWorkspaceId });
  } catch {
    return null;
  }
  const tasks = (reply as { ok?: unknown; tasks?: unknown } | null);
  if (!tasks || tasks.ok !== true || !Array.isArray(tasks.tasks)) return null;
  for (const t of tasks.tasks as Array<Record<string, unknown>>) {
    if (!t || t.id !== entry.id) continue;
    if (typeof t.worktreePath === 'string' && t.worktreePath) return t.worktreePath;
    if (typeof t.outputDir === 'string' && t.outputDir) return t.outputDir;
  }
  return null;
}

/**
 * The commit a task's branch started from: the `baseOid` fan-out stamped in
 * the task.json beside its worktree (a full commit id). Null when none is
 * recorded or it cannot be read: a task that fell back to the owner's HEAD, a
 * stamp written before the base was stamped, or a detached checkout (its
 * stamp names origin's default branch, not the commit it checked out).
 */
export async function taskBaseFromStamp(entry: LedgerEntry, worktreePath: string): Promise<string | null> {
  if (entry.dispatch?.checkout) return null;
  try {
    const raw = await fs.promises.readFile(path.join(metaDirForWorktree(worktreePath), WORKTASK_META_FILENAME), 'utf8');
    const oid = (JSON.parse(raw) as { baseOid?: unknown } | null)?.baseOid;
    return typeof oid === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** origin's default branch (`origin/<name>`): origin/HEAD, else main or master. */
export async function originDefaultRef(git: Git, repoPath: string): Promise<string | null> {
  try {
    const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoPath);
    const target = head.code === 0 ? head.stdout.trim() : '';
    if (target.startsWith('refs/remotes/origin/')) return `origin/${target.slice('refs/remotes/origin/'.length)}`;
    for (const name of ['main', 'master']) {
      const r = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}^{commit}`], repoPath);
      if (r.code === 0 && r.stdout.trim()) return `origin/${name}`;
    }
  } catch {
    /* unresolved */
  }
  return null;
}
