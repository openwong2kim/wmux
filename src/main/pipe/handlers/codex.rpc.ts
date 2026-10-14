import type {BrowserWindow} from 'electron';
import type {DaemonClient} from '../../DaemonClient';
import type {RpcRouter} from '../RpcRouter';
import {assertWorkspaceOwnsPty} from '../../workspace/ptyOwnership';

/** Only the CLI's main-minted pane claim can reserve its own Codex link.
 * No target pane, workspace or identity environment is accepted from params. */
export function registerCodexRpc(router:RpcRouter, getWindow:()=>BrowserWindow|null,
  getDaemon:()=>DaemonClient|null):void {
  for (const method of ['codex.relay.prepare','codex.relay.close'] as const) {
    router.register(method,async(params,ctx)=>{
      const claim = ctx?.workspaceClaim;
      if (claim?.kind !== 'bound' || !claim.ptyId || claim.browserOnly) {
        throw new Error('Run wmux codex directly in a wmux terminal pane.');
      }
      await assertWorkspaceOwnsPty(getWindow,claim.ptyId,claim.workspaceId,method);
      const daemon = getDaemon();
      if (!daemon?.isConnected) throw new Error('wmux daemon unavailable');
      return daemon.rpc(`daemon.${method}`,{
        id:claim.ptyId,
        ...(method === 'codex.relay.prepare' ? {codeHome:params.codeHome} : {leaseId:params.leaseId}),
      },{timeoutMs:method === 'codex.relay.prepare' ? 100_000 : 10_000});
    });
  }
}
