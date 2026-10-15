// ─── The system gate on a bot task's report ────────────────────────────────
//
// A worker a bot started (lead, triage, maintainer: every preset but
// `verify`, which has its own gate in verifyPreset.ts) reports its work by
// moving its ledger row to review_requested. `completed` needs a gate main
// recorded itself, and no bot can run one or force a completion, so main
// runs it here, with the rules the verify gate uses:
//   - the shared TaskGateRunner (its allow-listed steps, its zero-dependency
//     rule, its parent-anchored "no gate" rule), recorded as a `system`
//     write with the HEAD it ran on;
//   - the steps chosen from origin's default branch (`gateBaseRef`), so a
//     worker cannot redefine the gate that grades its own work.
// Then, with the row re-read (a row that moved while the gate ran — sent
// back, failed, cancelled, stopped by the owner — gets nothing):
//   - a passing run (exit 0, recorded, not a recorded skip) completes the
//     task, written as the task's owner (the bot's workspace) exactly as a
//     bot's own ledger_update would be, which the ledger accepts only on that
//     system-recorded pass: the system adds no power a bot lacks;
//   - anything else (a failing, killed, skipped or refused gate, no worktree,
//     no base branch) leaves the task open.
// A research task (the `research` preset: a scratch folder, no repository,
// no code) has no gate to run: its report completes it at once, written as
// the task's owner the same way (the ledger lets a brain complete such a row
// without a gate), with one card and one wake like a gated report.
// Either way one system card in the task's thread says what happened, and the
// bot that started the task is woken once (`task.gated:<taskId>@<rev>`, the
// id the wake queue dedupes on) to read the settled row. That wake replaces
// the worker's own review_requested wake (fanoutCallerNotify.ts skips it), so
// a report is one bot turn, after the gate, never one before it.
//
// At install (start, after a restart) every open row in this state is caught
// up: a report with no gate after it is gated now; one whose newest write is
// a passing gate is gated again (a quit can land between a gate recorded for
// an older report and the run for the newer one, so that pass is not trusted
// for completion); one whose gate did not pass wakes the bot again (the queue
// drops a wake it already delivered). A task the system completed in the
// last day wakes its bot again too, in case the quit fell between the
// completion and the wake (same id, so a delivered wake is dropped).

import { isResearchDispatch, type LedgerEntry } from '../../shared/ledger';
import type { BotProfile } from '../../shared/bot';
import { isSystemGatePass } from '../../shared/botTask';
import { taskThreadOf, type ThreadId } from '../../shared/room';
import type { WakeReason } from '../../shared/wake';
import type { LedgerUpdateInput, LedgerUpdateResult } from '../../daemon/ledger/TaskLedger';
import type { GateRunInput, GateRunResult } from '../worktask/TaskGateRunner';
import { VERIFY_GATE_SYSTEM_WORKSPACE, verifyGateFactId } from './verifyPreset';

/** Whether a transition is a bot task (not a verify task) reporting its work. */
export function isTaskGateReport(entry: LedgerEntry, to: string): boolean {
  const d = entry.dispatch;
  return to === 'review_requested'
    && d?.origin.kind === 'bot' && typeof d.origin.botId === 'string' && d.origin.botId.length > 0
    && d.preset !== 'verify';
}

/** Whether a reported row's newest write is a system gate (the report was gated). */
export function reportWasGated(entry: LedgerEntry): boolean {
  return entry.gate?.recordedBy === 'system' && entry.updatedBy.kind === 'system';
}

/**
 * Complete a bot's research task on its report: only a row still in
 * review_requested whose dispatch is a research task, written as the task's
 * owner with no force (the ledger completes such a row without a gate). One
 * retry on a write that landed in between. Never throws.
 */
export async function completeResearchTask(ledger: CheckedTaskLedger, taskId: string): Promise<{ entry: LedgerEntry } | { entry: null; why: string }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = ledger.get(taskId);
      if (!row) return { entry: null, why: 'the task is gone' };
      if (row.status !== 'review_requested') return { entry: null, why: `the task moved to ${row.status}` };
      if (!isResearchDispatch(row.dispatch)) return { entry: null, why: 'the task is not a research task' };
      const r = await ledger.update({
        id: taskId,
        status: 'completed',
        actor: { kind: 'brain', workspaceId: row.ownerWorkspaceId },
        expectedRev: row.rev,
      });
      if (r.ok) return { entry: r.entry };
      if (r.error !== 'stale_rev') return { entry: null, why: r.message };
    }
  } catch (err) {
    return { entry: null, why: String(err) };
  }
  return { entry: null, why: 'the task kept changing' };
}

/** The ledger calls completing a checked task makes (TaskLedger). */
export interface CheckedTaskLedger {
  get(id: string): LedgerEntry | null;
  update(input: LedgerUpdateInput): Promise<LedgerUpdateResult>;
}

/**
 * Complete a bot task whose report the system gate passed: only a row still
 * in review_requested whose newest write is that passing system gate, written
 * as the task's owner with no force (the ledger itself refuses `completed`
 * without such a gate). One retry on a write that landed in between. Never
 * throws; the completed row, or null with why not.
 */
export async function completeCheckedTask(ledger: CheckedTaskLedger, taskId: string): Promise<{ entry: LedgerEntry } | { entry: null; why: string }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = ledger.get(taskId);
      if (!row) return { entry: null, why: 'the task is gone' };
      if (row.status !== 'review_requested') return { entry: null, why: `the task moved to ${row.status}` };
      if (!reportWasGated(row) || !isSystemGatePass(row.gate)) return { entry: null, why: 'no passing system gate is the newest write on the task' };
      const r = await ledger.update({
        id: taskId,
        status: 'completed',
        actor: { kind: 'brain', workspaceId: row.ownerWorkspaceId },
        expectedRev: row.rev,
      });
      if (r.ok) return { entry: r.entry };
      if (r.error !== 'stale_rev') return { entry: null, why: r.message };
    }
  } catch (err) {
    return { entry: null, why: String(err) };
  }
  return { entry: null, why: 'the task kept changing' };
}

export interface TaskGatePorts {
  onTransition: (fn: (t: { entry: LedgerEntry; from: string | null; to: string }) => void) => () => void;
  ledgerRow: (taskId: string) => LedgerEntry | null;
  /** The open ledger rows, read once at install (restart catch-up). */
  openRows?: () => LedgerEntry[];
  /** Every ledger row, read once at install (completions to wake again). */
  allRows?: () => LedgerEntry[];
  now?: () => number;
  bot: (botId: string) => BotProfile | null;
  worktreeOf: (entry: LedgerEntry) => Promise<string | null>;
  /** origin's default branch as a ref (`origin/main`), or null. */
  baseRef: (repoPath: string) => Promise<string | null>;
  runGate: (input: GateRunInput) => Promise<GateRunResult>;
  /** completeCheckedTask over the hosted ledger. */
  complete: (taskId: string) => Promise<{ entry: LedgerEntry } | { entry: null; why: string }>;
  /** completeResearchTask over the hosted ledger. */
  completeResearch?: (taskId: string) => Promise<{ entry: LedgerEntry } | { entry: null; why: string }>;
  wake: (input: { botId: string; workspaceId: string; reason: WakeReason; priority: 1; threadId: ThreadId }) => unknown;
  /** A system card in the task's thread (best effort). */
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string) => void;
  log?: (msg: string) => void;
}

/** The card for a gate run that did not complete the task. */
export function describeTaskGate(r: GateRunResult): { title: string; body: string } {
  if (r.ok && r.status === 'completed') {
    const g = r.result;
    const verdict = g.exitCode === 0 ? 'passed' : g.exitCode === null ? 'was killed' : `failed (exit ${g.exitCode})`;
    const head = g.headSha ? `at ${g.headSha}` : 'with no pinned head (the tree changed or HEAD moved during the run)';
    const receipt = r.recorded ? 'recorded in the ledger' : 'NOT recorded (ledger unreachable)';
    return { title: `Gate ${verdict}: task left open`, body: `\`${g.command}\` ${head}; ${receipt}.` };
  }
  if (r.ok && r.status === 'skipped') {
    return { title: `Gate skipped (${r.skipped}): task left open`, body: r.detail };
  }
  if (!r.ok && r.status === 'busy') return { title: 'Gate already running: task left open', body: 'Another gate run holds this task; its result is in the task\'s ledger row when it ends.' };
  return { title: 'Gate refused: task left open', body: r.ok ? '' : r.error };
}

/** How far back a completion is woken again at install. */
export const COMPLETION_REWAKE_MS = 24 * 3_600_000;

/** Install the gate on bot task reports. Returns the unsubscribe. */
export function installTaskGate(ports: TaskGatePorts): () => void {
  const log = ports.log ?? ((m: string) => console.warn(m));
  const running = new Set<string>();
  /** Reports that arrived while their task's gate ran: gated again after. */
  const again = new Set<string>();

  const note = (entry: LedgerEntry, title: string, body: string): void => {
    try {
      ports.note?.(entry.ownerWorkspaceId, taskThreadOf(entry), title, body);
    } catch {
      /* the card is best effort */
    }
  };
  const wake = (entry: LedgerEntry): void => {
    const botId = entry.dispatch?.origin.botId ?? '';
    try {
      ports.wake({
        botId, workspaceId: entry.ownerWorkspaceId, priority: 1, threadId: taskThreadOf(entry),
        reason: { kind: 'facts', factIds: [verifyGateFactId(entry.id, entry.rev)], trigger: { kind: 'task.done' } },
      });
    } catch (err) {
      log(`[factory] gate wake for ${entry.id} failed: ${String(err)}`);
    }
  };
  /** The row now, when it still holds the report being gated. */
  const stillReported = (taskId: string): LedgerEntry | null => {
    const row = ports.ledgerRow(taskId);
    return row && isTaskGateReport(row, row.status) ? row : null;
  };
  /** Settle a gated report: complete on a pass, else leave it open; wake once. */
  const settle = async (row: LedgerEntry, failure: { title: string; body: string } | null): Promise<void> => {
    if (!failure) {
      const done = await ports.complete(row.id);
      if (done.entry) {
        const g = done.entry.gate;
        note(done.entry, 'Task checked: gate passed, task completed', `\`${g?.command ?? 'gate'}\` ${g?.headSha ? `at ${g.headSha}` : 'with no pinned head'}.`);
        wake(done.entry);
        return;
      }
      const now = stillReported(row.id);
      if (!now) return;
      note(now, 'Gate passed: task not completed', done.why);
      wake(now);
      return;
    }
    note(row, failure.title, failure.body);
    wake(row);
  };

  const run = async (taskId: string): Promise<void> => {
    const entry = stillReported(taskId);
    if (!entry) return;
    // A research task changed no code: nothing to gate.
    if (isResearchDispatch(entry.dispatch)) {
      const done = ports.completeResearch
        ? await ports.completeResearch(entry.id)
        : { entry: null, why: 'research tasks cannot be completed here' };
      if (done.entry) {
        note(done.entry, 'Research reported: task completed', 'A research task changes no code, so no gate runs on it.');
        wake(done.entry);
        return;
      }
      const now = stillReported(entry.id);
      if (!now) return;
      note(now, 'Research reported: task not completed', done.why);
      wake(now);
      return;
    }
    const bot = ports.bot(entry.dispatch?.origin.botId ?? '');
    const repoPath = bot?.repo?.repoPath;
    if (!bot || !repoPath) {
      await settle(entry, { title: 'Gate not run: task left open', body: 'The bot that started this task is gone or has no repository.' });
      return;
    }
    const [worktree, baseRef] = await Promise.all([ports.worktreeOf(entry), ports.baseRef(repoPath)]);
    // The row may have moved (sent back, stopped by the owner) during the lookups.
    const before = again.has(taskId) ? null : stillReported(taskId);
    if (!before) return;
    if (!worktree || !baseRef) {
      await settle(before, {
        title: 'Gate not run: task left open',
        body: !worktree ? 'The task worktree is not on disk.' : 'origin\'s default branch could not be resolved, so there is no base gate to run.',
      });
      return;
    }
    const result = await ports.runGate({
      taskId,
      worktreePath: worktree,
      systemWorkspaceId: VERIFY_GATE_SYSTEM_WORKSPACE,
      projectRoot: repoPath,
      gateBaseRef: baseRef,
    });
    // A report that arrived during the run is gated again (start's finally);
    // this run's result does not settle it.
    const now = again.has(taskId) ? null : stillReported(taskId);
    if (!now) return;
    const passed = result.ok && result.status === 'completed' && result.recorded && result.result.exitCode === 0;
    await settle(now, passed ? null : describeTaskGate(result));
  };

  const start = (taskId: string): void => {
    if (running.has(taskId)) {
      again.add(taskId);
      return;
    }
    running.add(taskId);
    void run(taskId)
      .catch((err) => log(`[factory] gate for ${taskId} failed: ${String(err)}`))
      .finally(() => {
        running.delete(taskId);
        if (again.delete(taskId) && stillReported(taskId)) start(taskId);
      });
  };

  const off = ports.onTransition((t) => {
    if (isTaskGateReport(t.entry, t.to)) start(t.entry.id);
  });

  let open: LedgerEntry[] = [];
  try {
    open = ports.openRows?.() ?? [];
  } catch {
    open = [];
  }
  for (const entry of open) {
    if (!isTaskGateReport(entry, entry.status)) continue;
    // Not gated, or gated with a pass that may belong to an older report:
    // gate it (again). A gate that did not pass (its card is already up)
    // wakes the bot again, which the queue drops once delivered.
    if (!reportWasGated(entry) || isSystemGatePass(entry.gate)) start(entry.id);
    else wake(entry);
  }
  let all: LedgerEntry[] = [];
  try {
    all = ports.allRows?.() ?? [];
  } catch {
    all = [];
  }
  const since = (ports.now ?? Date.now)() - COMPLETION_REWAKE_MS;
  for (const entry of all) {
    if (entry.status !== 'completed' || entry.updatedAt < since || entry.updatedBy.kind !== 'brain') continue;
    if (!isTaskGateReport(entry, 'review_requested')) continue;
    if (!isSystemGatePass(entry.gate) && !isResearchDispatch(entry.dispatch)) continue;
    wake(entry);
  }
  return off;
}
