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
// A task whose branch has no commits beyond the commit it started from (its
// task.json base; an operational task such as "call this API" commits
// nothing) is not gated at all: the gate would grade that base commit, which
// says nothing about the task, and a pass there completed tasks whose own
// report said they failed. A system gate that ran nothing is recorded
// instead (`skipped: 'no_changes'`, exit 0, the way the runner records
// `no_gate_command`), the task is left open, and the bot settles it from the
// report: the ledger takes its `completed` on that record, or its `failed`.
// A task whose base is not recorded, or whose HEAD cannot be compared with
// it, is gated as before.
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
// A merged pull request ends its task too. A reported task is completed when
// GitHub lists a PR from the task's own branch merged into the repository's
// default branch on GitHub (`gh pr list --head <branch> --base <default>`,
// the prsOfBranch port; the default from `gh repo view`, kept per repository:
// GitHub's answers, never repo-watch's polled and truncated closed list,
// which only announces) on the task's own repository (LedgerDispatch.repoKey,
// recorded at dispatch; never the bot's current profile), not a fork's, with
// the task worktree's HEAD that PR's head or behind it (commits made after
// the merge were never merged). It is completed as a gate pass completes it:
// written as the task's owner, forced with `merged` as the reason (a
// repository with no gate, or a gate still running, has no pass to complete
// on), the merge recorded as the row's completion (LedgerEntry.completion,
// main's own field, which the restart re-wake reads; the summary's
// `[merged: PR #<n>]` is only its words), one card and one wake the same way.
// An answer is for the row's rev and the worktree's HEAD it was read with:
// the completion is written to that rev only (compare-and-set) and only while
// HEAD is unchanged, and an answer is kept MERGE_ANSWER_TTL_MS for them. This
// is the one completion main forces for a bot's code task, and only on what
// landed on the default branch, which no bot merges past the owner's merge
// rules. Checked when a task reports (a PR merged before the report ends it
// then, with no gate), at install, every MERGE_SWEEP_MS (at most
// MERGE_SWEEP_MAX tasks a tick of repositories not backing off, the longest
// unchecked first) and when a pr.merged fact arrives (a trigger only, not
// evidence). A repository whose GitHub read failed backs off, and no read of
// it is made meanwhile. One check per task at a time: a caller that finds one
// under way takes its answer. A check that cannot answer (a failed read, no
// default branch, the task's branch, worktree or HEAD not readable) is
// 'unknown'. At install a report waits for its check before it is woken
// again or gated; one whose check is 'unknown' is neither now, and the sweep
// wakes or gates it once a check answers (such reports take at most half a
// tick's slots), so it gets one wake: the completion's, its gate's or its
// own. A gate still running when the merge
// lands finds the row moved and settles nothing; the ledger records no gate
// on an ended row. A PR closed without a merge leaves the task open, and so
// does a task still `working` (the ledger has no working → completed move).
//
// Every card carries the id of the row it was written about
// (`task.gated:<taskId>@<rev>`, the card's clientPostId).
// At install (start, after a restart) every open row in this state is caught
// up: one whose current rev already has its card (a refused, skipped or
// not-run gate records nothing in the ledger, so the card is the only trace)
// wakes the bot again and is neither gated nor carded again; otherwise a
// report with no gate after it is gated now; one whose newest write is
// a passing gate is gated again (a quit can land between a gate recorded for
// an older report and the run for the newer one, so that pass is not trusted
// for completion); one whose gate did not pass wakes the bot again (the queue
// drops a wake it already delivered). A task the system completed in the
// last day wakes its bot again too, in case the quit fell between the
// completion and the wake (same id, so a delivered wake is dropped).

import { isResearchDispatch, type LedgerActor, type LedgerEntry, type LedgerGateResult } from '../../shared/ledger';
import type { BotProfile } from '../../shared/bot';
import type { Fact } from '../../shared/facts';
import { normalizeRepoKey } from '../../shared/repoKey';
import { isSystemGatePass } from '../../shared/botTask';
import { taskThreadOf, type CardNotice, type RoomCard, type ThreadId } from '../../shared/room';
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

/** The ledger calls recording a gate that ran nothing makes (TaskLedger). */
export interface GateRecordingLedger {
  get(id: string): LedgerEntry | null;
  recordGate(id: string, gate: LedgerGateResult, actor?: LedgerActor, expectedRev?: number): Promise<LedgerUpdateResult>;
}

/** What a `no_changes` skip says (its card body and its ledger tail). */
export function noChangesDetail(base: string): string {
  return `The task's branch has no commits beyond ${base}, the commit it started from, so a gate would grade that commit and not the task. `
    + 'No gate ran; the bot settles the task from its report.';
}

/**
 * Record that a reported bot task made no commits beyond its base: a system
 * gate that ran nothing (`exitCode: 0`, `command: 'none'`, `skipped:
 * 'no_changes'`, the detail as its tail), as the gate runner records
 * `no_gate_command`. The bot can then settle `completed` (the ledger takes it
 * on a system gate with exit 0) or `failed`; the system completes nothing on
 * it (isSystemGatePass refuses a skip). Only on a row still in
 * review_requested. One retry on a write that landed in between. Never
 * throws; whether it was recorded.
 */
export async function recordNoChangesGate(ledger: GateRecordingLedger, taskId: string, detail: string, now: () => number = Date.now): Promise<boolean> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = ledger.get(taskId);
      if (!row || row.status !== 'review_requested') return false;
      const r = await ledger.recordGate(
        taskId,
        { exitCode: 0, tail: detail, at: now(), command: 'none', skipped: 'no_changes' },
        { kind: 'system', workspaceId: VERIFY_GATE_SYSTEM_WORKSPACE },
        row.rev,
      );
      if (r.ok) return true;
      if (r.error !== 'stale_rev') return false;
    }
  } catch {
    return false;
  }
  return false;
}

/** The reason the ledger records on a task its merged pull request ended. */
export const MERGED_REASON = 'merged';

/** The words heading the summary of a task its merged pull request ended
 *  (display only: LedgerEntry.completion is the record). */
export function mergedMark(pr: number): string {
  return `[merged: PR #${pr}]`;
}

/** Whether a completed row was ended by its merged pull request: main's own
 *  completion record, never the summary's words. Pure. */
export function isMergeCompletion(entry: LedgerEntry): boolean {
  return entry.status === 'completed' && entry.completion?.source === 'merge';
}

/** A merged pull request from a task's branch, as GitHub lists it. */
export interface BranchPr {
  pr: number;
  /** The branch it was merged into. */
  base: string;
  /** Its head when it was merged. */
  headSha: string;
  /** Opened from a fork (a fork's branch can share the task's branch name). */
  cross: boolean;
}

/**
 * Whether the worktree's HEAD is commit `sha` or an ancestor of it (its work
 * is all in that commit). False when that cannot be told: not a full commit
 * id, no HEAD, or the commit not in the repository.
 */
export async function worktreeHeadMerged(git: (args: string[], cwd: string) => Promise<{ stdout: string; code: number }>, worktreePath: string, sha: string): Promise<boolean> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) return false;
  try {
    const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], worktreePath);
    if (head.code !== 0) return false;
    if (head.stdout.trim().toLowerCase() === sha.toLowerCase()) return true;
    return (await git(['merge-base', '--is-ancestor', 'HEAD', sha], worktreePath)).code === 0;
  } catch {
    return false;
  }
}

/**
 * Complete a reported bot task whose pull request `pr` was merged: only a row
 * still in review_requested that the gate would check (not a verify or a
 * research task), written as the task's owner, forced with MERGED_REASON (a
 * merge is not a gate: a repository with no gate, or a gate still running,
 * has no pass to complete on), the merge recorded as the row's completion and
 * its summary headed by mergedMark (both kept even where the ledger needs no
 * force, a recorded "no gate" skip). With `checkedRev`, only that rev of the
 * row is completed (the merge was checked against it: a newer report is not
 * ended by an older answer). One retry on a write that landed in between.
 * Never throws; the completed row, or null with why not.
 */
export async function completeMergedTask(ledger: CheckedTaskLedger, taskId: string, pr: number, checkedRev?: number): Promise<{ entry: LedgerEntry } | { entry: null; why: string }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = ledger.get(taskId);
      if (!row) return { entry: null, why: 'the task is gone' };
      if (checkedRev !== undefined && row.rev !== checkedRev) return { entry: null, why: 'the task moved on since its merge was checked' };
      if (row.status !== 'review_requested') return { entry: null, why: `the task moved to ${row.status}` };
      if (!isTaskGateReport(row, row.status) || isResearchDispatch(row.dispatch)) return { entry: null, why: 'the task is not a bot\'s code task' };
      const r = await ledger.update({
        id: taskId,
        status: 'completed',
        actor: { kind: 'brain', workspaceId: row.ownerWorkspaceId },
        expectedRev: row.rev,
        summary: `${mergedMark(pr)} ${row.summary ?? ''}`.trim(),
        force: true,
        reason: MERGED_REASON,
        completion: { source: 'merge', pr },
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
  /** The fact log's live facts: a `pr.merged` on a task's repository checks
   *  its open reports now (a trigger only: prsOfBranch is the evidence). */
  onFact?: (fn: (f: Fact) => void) => () => void;
  /** The PRs from `branch` merged into `base` on `repoKey`, newest first
   *  (GitHub's answer; rejects when it could not be read). With
   *  defaultBranchOf, branchOf, headOf, headMerged and completeMerged;
   *  absent, merges end nothing. */
  prsOfBranch?: (repoKey: string, branch: string, base: string) => Promise<readonly BranchPr[]>;
  /** The repository's default branch on GitHub (rejects when it could not be
   *  read). Kept per repository for DEFAULT_BRANCH_TTL_MS. */
  defaultBranchOf?: (repoKey: string) => Promise<string>;
  /** The worktree's HEAD commit, or null when it cannot be read. */
  headOf?: (worktreePath: string) => Promise<string | null>;
  /** A task's branch; null when it has none (a detached checkout),
   *  undefined when it cannot be read now. */
  branchOf?: (entry: LedgerEntry) => Promise<string | null | undefined>;
  /** Whether the worktree's HEAD is `sha` or an ancestor of it (false when
   *  it cannot be told). */
  headMerged?: (worktreePath: string, sha: string) => Promise<boolean>;
  /** completeMergedTask over the hosted ledger. */
  completeMerged?: (taskId: string, pr: number, checkedRev: number) => Promise<{ entry: LedgerEntry } | { entry: null; why: string }>;
  /** The commit the task's branch started from (its task.json stamp), or
   *  null when none is recorded. With headMerged and recordNoChanges, a task
   *  whose HEAD is that commit or behind it is not gated (absent: every
   *  report is gated). */
  taskBase?: (entry: LedgerEntry, worktreePath: string) => Promise<string | null>;
  /** recordNoChangesGate over the hosted ledger. */
  recordNoChanges?: (taskId: string, detail: string) => Promise<boolean>;
  /** How often open reports are checked for a merged PR (default
   *  MERGE_SWEEP_MS). */
  mergeSweepMs?: number;
  wake: (input: { botId: string; workspaceId: string; reason: WakeReason; priority: 1; threadId: ThreadId }) => unknown;
  /** A system card in the task's thread (best effort), keyed by the row it
   *  is about (`verifyGateFactId(taskId, rev)`): a key already carded writes
   *  nothing. */
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string, key: string, notice?: CardNotice) => void;
  /** Whether a system card with this key is in the task's thread; null when
   *  the room cannot be read yet (the install catch-up waits for it). */
  noted?: (workspaceId: string, threadId: ThreadId, key: string) => boolean | null;
  /** How long the install catch-up waits for `noted` to answer (default
   *  NOTED_WAIT_MS); after that it runs as if nothing was carded. */
  notedWaitMs?: number;
  log?: (msg: string) => void;
}

/** Whether the task's thread holds a system card with this key (a bot's
 *  post cannot claim one: only system cards count). Null while the rooms
 *  cannot be read. Pure over `find`. */
export function gateCardNoted(
  find: ((workspaceId: string, match: (c: RoomCard) => boolean) => RoomCard | null) | null,
  workspaceId: string,
  threadId: ThreadId,
  key: string,
): boolean | null {
  if (!find) return null;
  return find(workspaceId, (c) => c.threadId === threadId && c.actor.kind === 'system' && c.clientPostId === key) !== null;
}

/** How long the install catch-up waits for the room to be readable. */
export const NOTED_WAIT_MS = 10_000;
const NOTED_POLL_MS = 250;

/** A gate card: its English words and its stable code (RoomCard.notice). */
export interface GateCard {
  title: string;
  body: string;
  notice: CardNotice;
}

/** The card for a gate run that did not complete the task. */
export function describeTaskGate(r: GateRunResult): GateCard {
  if (r.ok && r.status === 'completed') {
    const g = r.result;
    const verdict = g.exitCode === 0 ? 'passed' : g.exitCode === null ? 'was killed' : `failed (exit ${g.exitCode})`;
    const head = g.headSha ? `at ${g.headSha}` : 'with no pinned head (the tree changed or HEAD moved during the run)';
    const receipt = r.recorded ? 'recorded in the ledger' : 'NOT recorded (ledger unreachable)';
    const notice: CardNotice = g.exitCode === 0 ? { code: 'gate.passed' } : g.exitCode === null ? { code: 'gate.killed' } : { code: 'gate.failed', args: { exit: g.exitCode } };
    return { title: `Gate ${verdict}: task left open`, body: `\`${g.command}\` ${head}; ${receipt}.`, notice };
  }
  if (r.ok && r.status === 'skipped') {
    // A no_changes skip that did not land in the ledger leaves the bot no
    // record to complete on: say so.
    const body = r.skipped === 'no_changes' && r.recorded === false ? `${r.detail} The skip was NOT recorded (ledger unreachable).` : r.detail;
    // The stored English words for no_changes are the rendered card's
    // (room.notice.gate.reason.no_changes): the bot reads this title too.
    const reason = r.skipped === 'no_changes' ? 'the task made no changes' : r.skipped;
    return { title: `Gate skipped (${reason}): task left open`, body, notice: { code: 'gate.skipped', args: { reason: r.skipped } } };
  }
  if (!r.ok && r.status === 'busy') return { title: 'Gate already running: task left open', body: 'Another gate run holds this task; its result is in the task\'s ledger row when it ends.', notice: { code: 'gate.busy' } };
  if (!r.ok && r.code === 'no_base_gate') {
    return {
      notice: { code: 'gate.noBase', args: { detail: r.error } },
      title: 'No gate on the default branch yet: task left open',
      body: `${r.error}.\n\nThis task cannot be completed by the gate as it stands. To finish it, either merge a test script into the default branch first `
        + '(its own small PR), then have the bot send the task back so its worker reports again and the gate runs; or end the task: '
        + 'ask the bot to cancel it, or close its workspace. The task\'s branch and worktree are kept either way.',
    };
  }
  return { title: 'Gate refused: task left open', body: r.ok ? '' : r.error, notice: { code: 'gate.refused' } };
}

/** How far back a completion is woken again at install. */
export const COMPLETION_REWAKE_MS = 24 * 3_600_000;

/** How often open reports are checked for a merged PR (a merge whose task
 *  branch could not be read, or whose completion did not land, is tried
 *  again then). */
export const MERGE_SWEEP_MS = 5 * 60_000;
/** Most tasks one sweep tick checks (one gh read each). */
export const MERGE_SWEEP_MAX = 20;
/** A repository whose merged-PR read failed is not read again for this long,
 *  doubled on each failure in a row up to MERGE_BACKOFF_MAX_MS. */
export const MERGE_BACKOFF_MS = 60_000;
export const MERGE_BACKOFF_MAX_MS = 30 * 60_000;
/** How long a merge check's answer stands for the same rev and HEAD. */
export const MERGE_ANSWER_TTL_MS = 60_000;
/** How long a repository's default branch is kept. */
export const DEFAULT_BRANCH_TTL_MS = 60 * 60_000;

/** How long a repository's merged-PR reads wait after `failures` failed in
 *  a row: MERGE_BACKOFF_MS, doubled per failure, at most
 *  MERGE_BACKOFF_MAX_MS. Pure. */
export function mergeBackoffMs(failures: number): number {
  return Math.min(MERGE_BACKOFF_MAX_MS, MERGE_BACKOFF_MS * 2 ** Math.max(0, Math.min(failures - 1, 30)));
}

/** A merge check's answer: the task was ended, it is open (no merge holds
 *  its work), or no answer could be had (try again later). */
export type MergeCheck = 'ended' | 'open' | 'unknown';

/** Install the gate on bot task reports. Returns the unsubscribe. */
export function installTaskGate(ports: TaskGatePorts): () => void {
  const log = ports.log ?? ((m: string) => console.warn(m));
  const running = new Set<string>();
  /** Reports that arrived while their task's gate ran: gated again after. */
  const again = new Set<string>();

  const note = (entry: LedgerEntry, title: string, body: string, notice: CardNotice): void => {
    try {
      ports.note?.(entry.ownerWorkspaceId, taskThreadOf(entry), title, body, verifyGateFactId(entry.id, entry.rev), notice);
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
  const settle = async (row: LedgerEntry, failure: GateCard | null): Promise<void> => {
    if (!failure) {
      const done = await ports.complete(row.id);
      if (done.entry) {
        const g = done.entry.gate;
        note(done.entry, 'Task checked: gate passed, task completed', `\`${g?.command ?? 'gate'}\` ${g?.headSha ? `at ${g.headSha}` : 'with no pinned head'}.`, { code: 'gate.checked' });
        wake(done.entry);
        return;
      }
      const now = stillReported(row.id);
      if (!now) return;
      note(now, 'Gate passed: task not completed', done.why, { code: 'gate.passedNotCompleted' });
      wake(now);
      return;
    }
    note(row, failure.title, failure.body, failure.notice);
    wake(row);
  };

  let disposed = false;
  const clock = ports.now ?? Date.now;
  const mergeable = (): boolean => !!(ports.branchOf && ports.completeMerged && ports.headMerged && ports.headOf && ports.prsOfBranch && ports.defaultBranchOf);
  /** The open reports a merge could end: code tasks with their repository recorded. */
  const reportedRows = (): LedgerEntry[] => {
    try {
      return (ports.openRows?.() ?? []).filter((e) => e.status === 'review_requested' && isTaskGateReport(e, e.status)
        && !isResearchDispatch(e.dispatch) && !!normalizeRepoKey(e.dispatch?.repoKey));
    } catch {
      return [];
    }
  };
  /** Per repository: GitHub reads that failed in a row, and when the next may run. */
  const backoff = new Map<string, { failures: number; until: number }>();
  const backingOff = (repoKey: string | null): boolean => {
    const held = repoKey ? backoff.get(repoKey) : undefined;
    return !!held && held.until > clock();
  };
  /** One GitHub read for `repoKey`: its answer, or 'unknown' (and the
   *  repository backs off) when it failed. */
  const readGitHub = async <T>(repoKey: string, what: string, read: () => Promise<T>): Promise<T | 'unknown'> => {
    try {
      const v = await read();
      backoff.delete(repoKey);
      return v;
    } catch (err) {
      const failures = (backoff.get(repoKey)?.failures ?? 0) + 1;
      backoff.set(repoKey, { failures, until: clock() + mergeBackoffMs(failures) });
      log(`[factory] ${what} of ${repoKey} not read: ${String(err)}`);
      return 'unknown';
    }
  };
  /** Per repository: its default branch on GitHub, and when it was read. */
  const defaults = new Map<string, { name: string; at: number }>();
  const defaultBranch = async (repoKey: string): Promise<string | 'unknown'> => {
    const kept = defaults.get(repoKey);
    if (kept && clock() - kept.at < DEFAULT_BRANCH_TTL_MS) return kept.name;
    const name = await readGitHub(repoKey, 'the default branch', () => (ports.defaultBranchOf as (k: string) => Promise<string>)(repoKey));
    if (name === 'unknown' || !name) return 'unknown';
    defaults.set(repoKey, { name, at: clock() });
    return name;
  };
  /** Per task: the last answer, for the rev and HEAD it was given for. */
  const answers = new Map<string, { key: string; at: number; answer: MergeCheck }>();
  /**
   * End the reported task when a merged PR holds its work: one card, one
   * wake. The answer is for the row's rev and the worktree's HEAD as read
   * here; it is kept for MERGE_ANSWER_TTL_MS (`fresh` skips it), and a
   * merge found is written only to that same rev and HEAD.
   */
  const checkMerged = async (taskId: string, fresh: boolean): Promise<MergeCheck> => {
    const row = stillReported(taskId);
    const repoKey = normalizeRepoKey(row?.dispatch?.repoKey);
    if (!row || isResearchDispatch(row.dispatch) || !repoKey) return 'open';
    const branchOf = ports.branchOf as NonNullable<TaskGatePorts['branchOf']>;
    const headOf = ports.headOf as NonNullable<TaskGatePorts['headOf']>;
    const headMerged = ports.headMerged as NonNullable<TaskGatePorts['headMerged']>;
    const prsOfBranch = ports.prsOfBranch as NonNullable<TaskGatePorts['prsOfBranch']>;
    const completeMerged = ports.completeMerged as NonNullable<TaskGatePorts['completeMerged']>;
    const branch = await branchOf(row);
    if (branch === undefined) return 'unknown';
    if (!branch) return 'open';
    // The worktree and its HEAD: what a merge must hold, and what the answer is for.
    const worktree = await ports.worktreeOf(row);
    const head = worktree ? await headOf(worktree) : null;
    if (!worktree || !head) return 'unknown';
    const key = `${row.rev}:${head}`;
    const kept = answers.get(taskId);
    if (!fresh && kept && kept.key === key && clock() - kept.at < MERGE_ANSWER_TTL_MS) return kept.answer;
    const settle = (answer: MergeCheck): MergeCheck => {
      answers.set(taskId, { key, at: clock(), answer });
      return answer;
    };
    if (backingOff(repoKey)) return settle('unknown');
    // Only what landed on the default branch on GitHub: a merge into any
    // other base would complete a task no gate checked and main never received.
    const base = await defaultBranch(repoKey);
    if (base === 'unknown') return settle('unknown');
    const prs = await readGitHub(repoKey, `merged PRs from ${branch}`, () => prsOfBranch(repoKey, branch, base));
    if (prs === 'unknown') return settle('unknown');
    // `--head` also lists a fork's PR from a branch of the same name.
    let pr: number | null = null;
    for (const m of prs) {
      if (m.cross || m.base !== base || !m.headSha) continue;
      // Commits made after the merged head were never merged.
      if (await headMerged(worktree, m.headSha)) {
        pr = m.pr;
        break;
      }
    }
    if (pr === null) return settle('open');
    // Written only to what was checked: the row's rev (the ledger's
    // compare-and-set) and the worktree's HEAD (read again here).
    if (disposed) return 'unknown';
    if (await headOf(worktree) !== head) return 'unknown';
    const done = await completeMerged(taskId, pr, row.rev);
    if (!done.entry) {
      log(`[factory] merged PR #${pr} did not complete task ${taskId}: ${done.why}`);
      return 'unknown';
    }
    answers.delete(taskId);
    // Disposed meanwhile: the completion stands; its wake comes again at the
    // next install (the re-wake reads the row's completion).
    if (disposed) return 'ended';
    note(done.entry, `PR #${pr} merged: task completed`, 'The pull request from this task\'s branch was merged, so the task ends without waiting for a gate.', { code: 'task.merged', args: { pr } });
    wake(done.entry);
    return 'ended';
  };
  /** The merge check under way per task: every caller meanwhile shares its answer. */
  const merging = new Map<string, Promise<MergeCheck>>();
  /** Check the task for a merge, or take the answer of the check of it
   *  already under way. `fresh`: not a kept answer (a pr.merged just came). */
  const endIfMerged = async (taskId: string, fresh = false): Promise<MergeCheck> => {
    if (!mergeable()) return 'open';
    const pending = merging.get(taskId);
    if (pending) return pending.catch((): MergeCheck => 'unknown');
    if (disposed) return 'unknown';
    const check = checkMerged(taskId, fresh);
    merging.set(taskId, check);
    try {
      return await check;
    } finally {
      if (merging.get(taskId) === check) merging.delete(taskId);
    }
  };
  /** Reports at install whose merge check had no answer: taskId → the rev
   *  to settle once a check answers 'open' (the sweep), and how: woken again
   *  (a report already gated and carded) or gated (one not gated yet). */
  const deferred = new Map<string, { rev: number; then: 'wake' | 'gate' }>();
  /** When each open report was last checked by a sweep (oldest first next). */
  const sweptAt = new Map<string, number>();
  /** Check `rows` one after another (never throws); a report deferred at
   *  install is woken or gated once its check answers that it is open. */
  const endMerged = async (rows: readonly LedgerEntry[], fresh = false): Promise<void> => {
    for (const row of rows) {
      if (disposed) return;
      let answer: MergeCheck = 'unknown';
      try {
        answer = await endIfMerged(row.id, fresh);
      } catch (err) {
        log(`[factory] merge check of ${row.id} failed: ${String(err)}`);
      }
      const later = deferred.get(row.id);
      if (!later || answer === 'unknown') continue;
      deferred.delete(row.id);
      const now = stillReported(row.id);
      if (answer !== 'open' || disposed || !now || now.rev !== later.rev) continue;
      if (later.then === 'gate') start(row.id);
      else if (!running.has(row.id)) wake(now);
    }
  };
  /** One sweep tick: at most MERGE_SWEEP_MAX open reports of repositories
   *  not backing off. Reports deferred at install take at most half the
   *  slots (the longest unchecked of them), so ones that stay unanswerable
   *  never crowd out the rest; the longest unchecked of all fill the others. */
  const sweepMerged = (): void => {
    if (disposed || !mergeable()) return;
    const rows = reportedRows();
    const open = new Set(rows.map((r) => r.id));
    for (const id of [...sweptAt.keys()]) if (!open.has(id)) sweptAt.delete(id);
    for (const id of [...deferred.keys()]) if (!open.has(id)) deferred.delete(id);
    for (const id of [...answers.keys()]) if (!open.has(id)) answers.delete(id);
    const unchecked = rows
      .filter((r) => !backingOff(normalizeRepoKey(r.dispatch?.repoKey)))
      .sort((a, b) => (sweptAt.get(a.id) ?? 0) - (sweptAt.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    const first = unchecked.filter((r) => deferred.has(r.id)).slice(0, Math.floor(MERGE_SWEEP_MAX / 2));
    const firstIds = new Set(first.map((r) => r.id));
    const picked = [...first, ...unchecked.filter((r) => !firstIds.has(r.id)).slice(0, MERGE_SWEEP_MAX - first.length)];
    const at = clock();
    for (const r of picked) sweptAt.set(r.id, at);
    if (picked.length > 0) void endMerged(picked);
  };

  /** The base a task's HEAD holds no commits beyond (it is that commit or
   *  behind it), else null: commits of its own, no recorded base, or a
   *  comparison that could not be made (the gate then runs as before). */
  const unchangedBase = async (entry: LedgerEntry, worktree: string): Promise<string | null> => {
    if (!ports.taskBase || !ports.headMerged || !ports.recordNoChanges) return null;
    try {
      const base = await ports.taskBase(entry, worktree);
      if (!base) return null;
      return (await ports.headMerged(worktree, base)) ? base : null;
    } catch (err) {
      log(`[factory] base of task ${entry.id} not compared: ${String(err)}`);
      return null;
    }
  };

  /** Gate a report. `atInstall`: one found open at install, whose merge
   *  check, when it cannot answer, defers it to the sweep (not gated, not
   *  woken now), so it gets one wake: the completion's or its gate's. A
   *  report the sweep later gates comes back through here, no_changes skip
   *  included. */
  const run = async (taskId: string, atInstall: boolean): Promise<void> => {
    const entry = stillReported(taskId);
    if (!entry) return;
    // A research task changed no code: nothing to gate.
    if (isResearchDispatch(entry.dispatch)) {
      const done = ports.completeResearch
        ? await ports.completeResearch(entry.id)
        : { entry: null, why: 'research tasks cannot be completed here' };
      if (done.entry) {
        note(done.entry, 'Research reported: task completed', 'A research task changes no code, so no gate runs on it.', { code: 'research.completed' });
        wake(done.entry);
        return;
      }
      const now = stillReported(entry.id);
      if (!now) return;
      note(now, 'Research reported: task not completed', done.why, { code: 'research.notCompleted' });
      wake(now);
      return;
    }
    // A PR merged before the report ends the task now, with no gate.
    const merge = await endIfMerged(entry.id);
    if (merge === 'ended') return;
    if (merge === 'unknown' && atInstall) {
      if (!disposed && stillReported(taskId)?.rev === entry.rev) deferred.set(taskId, { rev: entry.rev, then: 'gate' });
      return;
    }
    if (!stillReported(taskId)) return;
    const bot = ports.bot(entry.dispatch?.origin.botId ?? '');
    const repoPath = bot?.repo?.repoPath;
    if (!bot || !repoPath) {
      await settle(entry, { title: 'Gate not run: task left open', body: 'The bot that started this task is gone or has no repository.', notice: { code: 'gate.notRunNoBot' } });
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
        notice: { code: !worktree ? 'gate.notRunNoWorktree' : 'gate.notRunNoBaseRef' },
      });
      return;
    }
    // No commits beyond its base: nothing of the task's to gate. Recorded as
    // a skip and left open for the bot to settle from the report.
    const base = await unchangedBase(before, worktree);
    if (base && ports.recordNoChanges) {
      if (again.has(taskId) || !stillReported(taskId)) return;
      const detail = noChangesDetail(base);
      const recorded = await ports.recordNoChanges(taskId, detail);
      const now = again.has(taskId) ? null : stillReported(taskId);
      if (!now) return;
      await settle(now, describeTaskGate({ ok: true, status: 'skipped', taskId, skipped: 'no_changes', detail, recorded }));
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

  const start = (taskId: string, atInstall = false): void => {
    if (running.has(taskId)) {
      again.add(taskId);
      return;
    }
    running.add(taskId);
    void run(taskId, atInstall)
      .catch((err) => log(`[factory] gate for ${taskId} failed: ${String(err)}`))
      .finally(() => {
        running.delete(taskId);
        if (again.delete(taskId) && stillReported(taskId)) start(taskId);
      });
  };

  const off = ports.onTransition((t) => {
    if (isTaskGateReport(t.entry, t.to)) start(t.entry.id);
  });

  const offFacts = ports.onFact?.((f) => {
    if (f.kind !== 'pr.merged') return;
    const repo = normalizeRepoKey(f.repoKey);
    if (!repo) return;
    const rows = reportedRows().filter((e) => normalizeRepoKey(e.dispatch?.repoKey) === repo).slice(0, MERGE_SWEEP_MAX);
    if (rows.length > 0) void endMerged(rows, true);
  });

  /** Whether this rev of the row already has its card; null: unknown yet. */
  const carded = (entry: LedgerEntry): boolean | null => {
    if (!ports.noted) return false;
    try {
      return ports.noted(entry.ownerWorkspaceId, taskThreadOf(entry), verifyGateFactId(entry.id, entry.rev));
    } catch {
      return null;
    }
  };
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  const sweepOpen = (waitedMs: number): void => {
    sweepTimer = null;
    if (disposed) return;
    let open: LedgerEntry[] = [];
    try {
      open = (ports.openRows?.() ?? []).filter((e) => isTaskGateReport(e, e.status));
    } catch {
      open = [];
    }
    // The room is not readable yet (its module starts after this one): wait
    // for it rather than gate and card a report again.
    const waitMs = ports.notedWaitMs ?? NOTED_WAIT_MS;
    if (waitedMs < waitMs && open.some((e) => carded(e) === null)) {
      sweepTimer = setTimeout(() => sweepOpen(waitedMs + NOTED_POLL_MS), NOTED_POLL_MS);
      sweepTimer.unref?.();
      return;
    }
    for (const entry of open) {
      // A report that arrived while the sweep waited is being gated already.
      if (running.has(entry.id)) continue;
      // This rev was gated and carded already (before a restart): the bot is
      // woken again (the queue drops a delivered wake), nothing runs again.
      // A carded pass is not: its completion did not land, so it is gated
      // again below, as any pass at install is.
      const passed = reportWasGated(entry) && isSystemGatePass(entry.gate);
      if (carded(entry) === true && !passed) void wakeUnlessMerged(entry);
      // Not gated, or gated with a pass that may belong to an older report:
      // gate it (again; the gate checks for a merge first). A gate that did
      // not pass (its card is already up) wakes the bot again, which the
      // queue drops once delivered.
      else if (!reportWasGated(entry) || isSystemGatePass(entry.gate)) start(entry.id, true);
      else void wakeUnlessMerged(entry);
    }
  };
  /** Wake a report again at install, unless its PR was merged (while the app
   *  was closed, or before a report a quit cut short): that ends it, with
   *  its own wake. The merge check is awaited first, so such a report is one
   *  bot turn, not one for this rev and one for the completion; a check with
   *  no answer leaves the wake to the sweep (deferred). */
  const wakeUnlessMerged = async (entry: LedgerEntry): Promise<void> => {
    let answer: MergeCheck = 'unknown';
    try {
      answer = await endIfMerged(entry.id);
    } catch (err) {
      log(`[factory] merge check of ${entry.id} failed: ${String(err)}`);
    }
    if (answer === 'ended') return;
    if (answer === 'unknown') {
      if (!disposed) deferred.set(entry.id, { rev: entry.rev, then: 'wake' });
      return;
    }
    // Woken only as it stood: a row that moved meanwhile was handled by what moved it.
    const now = stillReported(entry.id);
    if (disposed || !now || now.rev !== entry.rev || running.has(entry.id)) return;
    wake(now);
  };
  sweepOpen(0);
  const mergeSweep = mergeable() ? setInterval(sweepMerged, ports.mergeSweepMs ?? MERGE_SWEEP_MS) : null;
  mergeSweep?.unref?.();
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
    if (!isSystemGatePass(entry.gate) && !isResearchDispatch(entry.dispatch) && !isMergeCompletion(entry)) continue;
    wake(entry);
  }
  return () => {
    disposed = true;
    if (sweepTimer) clearTimeout(sweepTimer);
    if (mergeSweep) clearInterval(mergeSweep);
    off();
    offFacts?.();
  };
}
