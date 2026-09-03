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
// workspace owns plus the task whose workspace it is.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { isLedgerStatus, type LedgerActor } from '../../../shared/ledger';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import { LEDGER_SUMMARY_MAX_BYTES, truncateHead, type TaskLedger } from '../../../daemon/ledger/TaskLedger';

type GetWindow = () => BrowserWindow | null;

export interface LedgerRpcDeps {
  /** Injected in tests; defaults to the hosted instance. */
  getLedger?: () => TaskLedger;
  /** Injected in tests; defaults to the mirror/renderer resolution. */
  resolveCallerWorkspace?: (senderPtyId: string) => Promise<string | null>;
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
    const taskId = str(params.taskId);
    if (!taskId) return deny('INVALID_ARGUMENT', 'ledger.update: taskId is required');
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
      return { ...deny(res.error.toUpperCase(), `ledger.update: ${res.message}`), ...(res.entry ? { entry: res.entry } : {}) };
    }
    return { ok: true, entry: res.entry, ...(res.noop ? { noop: true } : {}) };
  });
}
