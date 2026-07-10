// Plugin host IPC — the renderer side of the postMessage bridge.
//
// The renderer hosts plugin iframes and validates their bridge envelopes
// (shared/pluginHost.parseBridgeRequest); validated requests are forwarded
// here and dispatched through the SAME RpcRouter the pipe RPC surface uses,
// with `clientName` pinned main-side to the plugin's manifest name. That
// gives plugin-iframe RPCs the full Phase 2.2 stack — trust lookup,
// PermissionEnforcer capability/path checks, approval prompts — without a
// parallel enforcement path.
//
// Trust note: the renderer is first-party code, but the pluginName it
// forwards is attacker-influenced only to the extent a hostile iframe can
// post messages to its OWN host component — the host stamps the plugin name
// itself (never reads it from the envelope), and main re-validates the name
// against the loaded set, so a plugin cannot impersonate another plugin.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { RpcRouter } from '../../pipe/RpcRouter';
import type { RpcMethod, RpcResponse } from '../../../shared/rpc';
import type { PluginHostLoader } from '../../plugins/PluginHostLoader';
import type { ApprovalQueue } from '../../mcp/ApprovalQueue';

const MAX_METHOD_LEN = 128;
let rpcSeq = 0;

export function registerPluginHostHandlers(
  rpcRouter: RpcRouter,
  getLoader: () => PluginHostLoader | null,
  getApprovalQueue?: () => ApprovalQueue | null,
): () => void {
  ipcMain.removeHandler(IPC.PLUGINS_LIST);
  ipcMain.handle(IPC.PLUGINS_LIST, wrapHandler(IPC.PLUGINS_LIST, async () => {
    const loader = getLoader();
    if (!loader) return { plugins: [], failures: [] };
    return {
      plugins: await loader.summaries(),
      failures: loader.listFailures(),
    };
  }));

  ipcMain.removeHandler(IPC.PLUGINS_RPC);
  ipcMain.handle(IPC.PLUGINS_RPC, wrapHandler(IPC.PLUGINS_RPC, async (
    _event: Electron.IpcMainInvokeEvent,
    pluginName: unknown,
    method: unknown,
    params: unknown,
  ): Promise<RpcResponse> => {
    if (typeof pluginName !== 'string' || typeof method !== 'string'
      || method.length === 0 || method.length > MAX_METHOD_LEN) {
      throw new Error('Invalid plugin RPC request');
    }
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      throw new Error('Invalid plugin RPC params');
    }
    const loader = getLoader();
    const plugin = loader?.get(pluginName);
    if (!plugin) {
      throw new Error(`Unknown plugin: ${pluginName}`);
    }
    // Unknown methods fall through to RpcRouter's own "Unknown method"
    // response — no separate allowlist here, the router IS the method space.
    // firstParty: the plugin host is an in-process, human-approved (trust-gated
    // iframe) dispatch entry point, not the external wire — so it keeps the
    // operator scope for private events.poll types (audit B3). Without this a
    // plugin polling channel.*/a2a.task with a workspaceId would hit the
    // agent-transport branch, resolve no senderPtyId, and drop every private
    // event. Not forgeable from the wire: firstParty is a dispatch argument.
    return rpcRouter.dispatch({
      id: `plugin-${pluginName}-${++rpcSeq}`,
      method: method as RpcMethod,
      params: (params ?? {}) as Record<string, unknown>,
      clientName: plugin.manifest.name,
      clientVersion: plugin.manifest.version,
    }, { firstParty: true });
  }));

  // Renderer-initiated approval for an unconfirmed plugin. Breaks the UI
  // dead-lock where the host won't mount an untrusted iframe and an
  // unmounted iframe never triggers the RPC-rejection approval path. Uses
  // the same ApprovalQueue (and thus the same PermissionApprovalDialog +
  // trust-store persistence) as enforce-mode RPC rejections.
  ipcMain.removeHandler(IPC.PLUGINS_REQUEST_APPROVAL);
  ipcMain.handle(IPC.PLUGINS_REQUEST_APPROVAL, wrapHandler(IPC.PLUGINS_REQUEST_APPROVAL, async (
    _event: Electron.IpcMainInvokeEvent,
    pluginName: unknown,
  ): Promise<{ approved: boolean }> => {
    if (typeof pluginName !== 'string') throw new Error('Invalid plugin name');
    const plugin = getLoader()?.get(pluginName);
    if (!plugin) throw new Error(`Unknown plugin: ${pluginName}`);
    const queue = getApprovalQueue?.() ?? null;
    if (!queue) throw new Error('Approval queue unavailable');
    const handle = queue.requestApproval({
      clientName: plugin.manifest.name,
      declaredCapabilities: plugin.manifest.capabilities,
      rationale: plugin.manifest.description,
    });
    const result = await handle.resolution;
    return { approved: result.approved };
  }));

  return () => {
    ipcMain.removeHandler(IPC.PLUGINS_LIST);
    ipcMain.removeHandler(IPC.PLUGINS_RPC);
    ipcMain.removeHandler(IPC.PLUGINS_REQUEST_APPROVAL);
  };
}
