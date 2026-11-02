import { A2A_COMPANY_RPC, isCompanyHoldReason } from '../../shared/companyHold';
import type { RpcClientContext } from '../DaemonPipeServer';
import type { A2aTaskService } from './A2aTaskService';

type RpcHandler = (params: Record<string, unknown>, ctx: RpcClientContext) => Promise<unknown>;

/** The part of the daemon's pipe server the company RPCs use. */
export interface CompanyHoldRpcPipe {
  onRpc(method: string, handler: RpcHandler): void;
  isFirstParty(clientId: string): boolean;
}

/**
 * Company mode: tasks held on their blockers (shared/companyHold.ts). Main
 * pulls the released ones it owes a delivery and records each attempt and
 * its outcome; the held list is for the board and the CEO. Only the app's
 * main process is answered: it is the one that delivers them.
 */
export function registerCompanyHoldRpc(pipe: CompanyHoldRpcPipe, taskService: A2aTaskService | null): void {
  const refused = (method: string) => ({ ok: false, error: `${method}: answered for the app only` });

  pipe.onRpc(A2A_COMPANY_RPC.pending, async (_p, ctx) => {
    if (!pipe.isFirstParty(ctx.clientId)) return refused(A2A_COMPANY_RPC.pending);
    return { tasks: taskService?.listCompanyPending() ?? [] };
  });

  pipe.onRpc(A2A_COMPANY_RPC.held, async (_p, ctx) => {
    if (!pipe.isFirstParty(ctx.clientId)) return refused(A2A_COMPANY_RPC.held);
    return { tasks: taskService?.listCompanyHeld() ?? [] };
  });

  pipe.onRpc(A2A_COMPANY_RPC.mark, async (p, ctx) => {
    if (!pipe.isFirstParty(ctx.clientId)) return refused(A2A_COMPANY_RPC.mark);
    if (!taskService) return { ok: false, error: 'a2a.company.mark: task log unavailable' };
    const taskId = typeof p.taskId === 'string' ? p.taskId : '';
    if (!taskId) return { ok: false, error: 'bad-request: taskId is required' };
    if ([p.attempted, p.delivered, p.held].filter((v) => v !== undefined).length !== 1) {
      return { ok: false, error: 'bad-request: give exactly one of attempted, delivered, held' };
    }
    if (p.attempted !== undefined && typeof p.attempted !== 'boolean') return { ok: false, error: 'bad-request: attempted must be a boolean' };
    if (p.delivered !== undefined && p.delivered !== true) return { ok: false, error: 'bad-request: delivered must be true' };
    if (p.held !== undefined && !isCompanyHoldReason(p.held)) return { ok: false, error: 'bad-request: unknown held reason' };
    if (p.ptyId !== undefined && (p.delivered !== true || typeof p.ptyId !== 'string' || !p.ptyId)) {
      return { ok: false, error: 'bad-request: ptyId goes with delivered, as a non-empty string' };
    }
    return taskService.markCompany({
      taskId,
      ...(typeof p.attempted === 'boolean' ? { attempted: p.attempted } : {}),
      ...(p.delivered === true ? { delivered: true as const } : {}),
      ...(typeof p.ptyId === 'string' ? { ptyId: p.ptyId } : {}),
      ...(isCompanyHoldReason(p.held) ? { held: p.held } : {}),
    });
  });
}
