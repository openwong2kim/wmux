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
import { isLedgerStatus, type LedgerActor, type LedgerGateResult } from '../../../shared/ledger';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';

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

function readGate(v: unknown): LedgerGateResult | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const g = v as Record<string, unknown>;
  const exitCode = g.exitCode === null ? null : typeof g.exitCode === 'number' ? g.exitCode : undefined;
  if (exitCode === undefined) return undefined;
  return {
    exitCode,
    tail: typeof g.tail === 'string' ? g.tail : '',
    at: typeof g.at === 'number' ? g.at : Date.now(),
    command: typeof g.command === 'string' ? g.command : '',
  };
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
    const res = await ledgerOf().update({
      id: taskId,
      status,
      actor,
      expectedRev: params.expectedRev,
      ...(str(params.summary) ? { summary: str(params.summary) } : {}),
      ...(readGate(params.gate) ? { gate: readGate(params.gate) } : {}),
      ...(params.force === true ? { force: true } : {}),
      ...(str(params.reason) ? { reason: str(params.reason) } : {}),
    });
    if (!res.ok) {
      return { ...deny(res.error.toUpperCase(), `ledger.update: ${res.message}`), ...(res.entry ? { entry: res.entry } : {}) };
    }
    return { ok: true, entry: res.entry, ...(res.noop ? { noop: true } : {}) };
  });
}
