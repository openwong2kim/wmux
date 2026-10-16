// ─── ledger.list / ledger.update — the task ledger on the pipe surface ───────
//
// Two methods over the main-hosted TaskLedger (deck/taskLedgerHost.ts).
// Identity is server-resolved, never taken from params:
//   - a VALIDATED commander token (ctx.commanderWorkspace, set by RpcRouter)
//     makes the caller a `brain` actor for that workspace;
//   - otherwise the caller's senderPtyId resolves to its workspace through the
//     mirror/renderer (the same D5 anchor a2a.channel.* uses) and the caller
//     is a `worker` actor for that workspace.
// Authorization and transition legality live in the ledger (canActorSet /
// canTransition); this handler only shapes the wire and refuses an
// unresolvable caller. Reads are scoped to the caller's own rows: the tasks a
// workspace owns plus the task whose workspace it is. A worker may leave the
// task out of an update: it is the open task of the worker's own workspace.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { WORKER_SETTABLE_STATUSES, isLedgerStatus, type LedgerActor, type LedgerEntry } from '../../../shared/ledger';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import { LEDGER_SUMMARY_MAX_BYTES, truncateHead, type TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { reportOnEndedTask } from '../../factory/endedTaskReport';
import type { NoChangesVerdict } from '../../factory/noChangesCheck';

type GetWindow = () => BrowserWindow | null;

export interface LedgerRpcDeps {
  /** Injected in tests; defaults to the hosted instance. */
  getLedger?: () => TaskLedger;
  /** Injected in tests; defaults to the mirror/renderer resolution. */
  resolveCallerWorkspace?: (senderPtyId: string) => Promise<string | null>;
  /** The no-changes check (factory/noChangesCheck.ts). A `completed` on a
   *  no-changes skip goes through only when it answers `unchanged` now, at
   *  the HEAD the skip checked; without it, such a completion is refused. */
  noChangesCheck?: (entry: LedgerEntry) => Promise<NoChangesVerdict>;
}

function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Free text off the wire, clamped to the ledger's byte cap. */
function text(v: unknown): string {
  return truncateHead(str(v), LEDGER_SUMMARY_MAX_BYTES);
}

export function registerLedgerRpc(router: RpcRouter, getWindow: GetWindow, deps: LedgerRpcDeps = {}): void {
  const ledgerOf = deps.getLedger ?? getTaskLedger;
  const resolveCaller =
    deps.resolveCallerWorkspace ??
    (async (senderPtyId: string) => {
      try {
        return await resolvePtyOwnerWorkspace(getWindow, senderPtyId);
      } catch {
        return null;
      }
    });

  /** Who is calling: the validated commander (brain) or a pane (worker). */
  const resolveActor = async (
    params: Record<string, unknown>,
    ctx?: RpcContext,
  ): Promise<LedgerActor | null> => {
    if (ctx?.commanderWorkspace) return { kind: 'brain', workspaceId: ctx.commanderWorkspace };
    const senderPtyId = str(params.senderPtyId);
    if (!senderPtyId) return null;
    const ws = await resolveCaller(senderPtyId);
    return ws ? { kind: 'worker', workspaceId: ws } : null;
  };

  router.register('ledger.list', async (params, ctx) => {
    const actor = await resolveActor(params, ctx);
    if (!actor) {
      return deny('NOT_AUTHORIZED', 'ledger.list: caller identity could not be resolved (no commander token, no resolvable senderPtyId)');
    }
    const ledger = ledgerOf();
    const taskId = str(params.taskId);
    const openOnly = params.openOnly === true;
    const mine = ledger
      .list({ ...(taskId ? { id: taskId } : {}), ...(openOnly ? { openOnly: true } : {}) })
      .filter((e) => e.ownerWorkspaceId === actor.workspaceId || e.taskWorkspaceId === actor.workspaceId);
    return { ok: true, actor, entries: mine };
  });

  router.register('ledger.update', async (params, ctx) => {
    const actor = await resolveActor(params, ctx);
    if (!actor) {
      return deny('NOT_AUTHORIZED', 'ledger.update: caller identity could not be resolved (no commander token, no resolvable senderPtyId)');
    }
    // A worker that leaves the task out reports on the task of its own
    // workspace (resolved from its pane identity, never from params).
    const ownTask = actor.kind === 'worker' && !ctx?.bot ? ledgerOf().findOpenByTaskWorkspace(actor.workspaceId) : null;
    const taskId = str(params.taskId) || ownTask?.id || '';
    /** A worker's report refused on its own task once that task ended: told
     *  to the bot that started it, when its worker was resumed (endedTaskReport.ts). */
    const refusedOnOwnTask = (row: ReturnType<TaskLedger['get']>): void => {
      const reported = str(params.status);
      if (actor.kind !== 'worker' || ctx?.bot || !row || row.taskWorkspaceId !== actor.workspaceId) return;
      // Only a status a worker may set, with the rev it read: anything else
      // is the worker's mistake, not a report.
      if (!isLedgerStatus(reported) || !WORKER_SETTABLE_STATUSES.includes(reported) || typeof params.expectedRev !== 'number') return;
      reportOnEndedTask(row, { status: reported, ...(text(params.summary) ? { summary: text(params.summary) } : {}) });
    };
    if (!taskId) {
      if (actor.kind === 'worker' && !ctx?.bot) refusedOnOwnTask(ledgerOf().findByTaskWorkspace(actor.workspaceId));
      return actor.kind === 'worker' && !ctx?.bot
        ? deny('NOT_FOUND', 'ledger.update: no open task belongs to your workspace')
        : deny('INVALID_ARGUMENT', 'ledger.update: taskId is required');
    }
    const status = str(params.status);
    if (!isLedgerStatus(status)) {
      return deny('INVALID_ARGUMENT', `ledger.update: status must be one of working, input_required, review_requested, completed, failed, cancelled (got "${status}")`);
    }
    if (typeof params.expectedRev !== 'number' || !Number.isInteger(params.expectedRev)) {
      return deny('INVALID_ARGUMENT', 'ledger.update: expectedRev (the rev you read from ledger_list) is required');
    }
    // A gate result is the gate runner's write (system actor, TaskLedger.
    // recordGate). No wire caller — worker or brain — may supply one: a
    // caller-written "exitCode: 0" is exactly the self-certification the
    // ledger exists to refuse.
    if (params.gate !== undefined) {
      return deny('INVALID_ARGUMENT', 'ledger.update: gate results are recorded by the gate runner, not by callers; omit "gate" (use force + reason to complete without one)');
    }
    // A factory bot moves only the tasks it started itself (the row's
    // dispatch origin, written by main), never another bot's or a pane's
    // task in its workspace, and never with force.
    if (ctx?.bot) {
      const row = ledgerOf().get(taskId);
      const origin = row?.dispatch?.origin;
      if (!row || origin?.kind !== 'bot' || origin.botId !== ctx.bot.botId) {
        return deny('NOT_AUTHORIZED', 'ledger.update: a bot may update only the tasks it started');
      }
      if (params.force === true) return deny('NOT_AUTHORIZED', 'ledger.update: a bot cannot force a transition');
    }
    // A no-changes skip vouches for nothing the worker did after it: the
    // completion asks the same check again (its HEAD, main's push record and
    // origin's task branch against the recorded base), at the HEAD the skip
    // checked. Anything else, or no answer, is refused.
    const current = status === 'completed' && params.force !== true ? ledgerOf().get(taskId) : null;
    if (current?.gate?.skipped === 'no_changes') {
      const checked = current.gate.headSha;
      let verdict: NoChangesVerdict;
      try {
        verdict = deps.noChangesCheck ? await deps.noChangesCheck(current) : { kind: 'unknown', why: 'the no-changes check is not available' };
      } catch (err) {
        verdict = { kind: 'unknown', why: String(err) };
      }
      if (verdict.kind !== 'unchanged' || !checked || verdict.head !== checked) {
        const why = verdict.kind !== 'unchanged' ? verdict.why : `the task's HEAD is no longer ${checked ?? 'the commit the skip checked'}`;
        return deny('FAILED_PRECONDITION', `ledger.update: the no-changes skip no longer holds (${why}); settle it failed, or have its worker report again so its work is gated`);
      }
    }
    const res = await ledgerOf().update({
      id: taskId,
      status,
      actor,
      expectedRev: params.expectedRev,
      ...(text(params.summary) ? { summary: text(params.summary) } : {}),
      ...(params.force === true ? { force: true } : {}),
      ...(text(params.reason) ? { reason: text(params.reason) } : {}),
    });
    if (!res.ok) {
      refusedOnOwnTask(ledgerOf().get(taskId));
      // A worker that named a task that is not its own is told which one is.
      const hint = res.error === 'not_found' && ownTask && ownTask.id !== taskId ? ` (your task is ${ownTask.id} at rev ${ownTask.rev})` : '';
      return { ...deny(res.error.toUpperCase(), `ledger.update: ${res.message}${hint}`), ...(res.entry ? { entry: res.entry } : {}) };
    }
    return { ok: true, entry: res.entry, ...(res.noop ? { noop: true } : {}) };
  });
}
