import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { ComputerError, encodeComputerErrorMessage } from '../../../shared/computer/errors';
import { isControlAction, type ObservationMode } from '../../../shared/computer/protocol';
import type { ComputerService, ControlParams } from '../../computer/ComputerService';

/**
 * computer.* — desktop computer use (docs/computer-use-design.md).
 *
 * Errors cross the pipe as `[code] message` (encodeComputerErrorMessage) so
 * the MCP tool can recover the code and attach its next steps. The service is
 * resolved lazily: nothing is constructed, and no helper spawned, until an
 * agent actually calls in.
 */
export function registerComputerRpc(router: RpcRouter, getService: () => ComputerService): void {
  const wrap = <T>(fn: (params: Record<string, unknown>, clientName: string) => Promise<T>) =>
    async (params: Record<string, unknown>, ctx?: RpcContext): Promise<T> => {
      try {
        return await fn(params, callerName(ctx));
      } catch (err) {
        if (err instanceof ComputerError) throw new Error(encodeComputerErrorMessage(err.toPayload()));
        throw new Error(encodeComputerErrorMessage({ code: 'internal', message: err instanceof Error ? err.message : String(err) }));
      }
    };

  router.register('computer.capabilities', wrap(() => getService().capabilities()));

  router.register('computer.listApps', wrap(() => getService().listApps()));

  router.register('computer.listWindows', wrap((params) =>
    getService().listWindows(typeof params.app === 'string' ? params.app : undefined)));

  router.register('computer.getAppState', wrap((params, clientName) => {
    if (typeof params.app !== 'string' || params.app.length === 0) {
      throw new ComputerError('invalid_argument', 'app is required');
    }
    return getService().getAppState(clientName, {
      app: params.app,
      ...(typeof params.window === 'string' && { window: params.window }),
      ...(typeof params.mode === 'string' && { mode: params.mode as ObservationMode }),
    });
  }));

  router.register('computer.act', wrap((params, clientName) => {
    if (typeof params.action !== 'string' || !isControlAction(params.action)) {
      throw new ComputerError('invalid_argument', 'action must be one of click, setValue, type, pressKey, hotkey, scroll');
    }
    return getService().control(clientName, params as unknown as ControlParams);
  }));
}

/**
 * The agent identity consent grants and the input lock are keyed on. The MCP
 * client name alone is shared by every agent of one kind (all Claude Code
 * panes report the same name), so a server-verified workspace claim narrows it
 * when present. A caller-supplied `workspaceId` param is NOT used: it would let
 * one agent borrow another's grants by naming its workspace.
 */
function callerName(ctx: RpcContext | undefined): string {
  const name = ctx?.clientName?.trim();
  if (!name) throw new ComputerError('invalid_argument', 'computer use needs an identified MCP client');
  const claim = ctx?.workspaceClaim;
  if (claim?.kind === 'stale') {
    throw new ComputerError('invalid_argument', 'this agent\'s workspace claim is no longer valid');
  }
  return claim?.kind === 'bound' ? `${name} @ ${claim.workspaceId}` : name;
}
