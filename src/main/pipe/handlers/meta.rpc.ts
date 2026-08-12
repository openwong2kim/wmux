import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { MetadataUpdatePayload } from '../../../shared/types';
import { broadcastMetadataUpdate } from '../../ipc/handlers/metadata.handler';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';

type GetWindow = () => BrowserWindow | null;

/**
 * Resolve the caller's workspace from senderPtyId (server-derived, not
 * caller-supplied). Returns '' when unresolvable.
 *
 * Mirrors the pattern in fanout.rpc.ts / events.rpc.ts.
 */
async function resolveCallerWorkspace(getWindow: GetWindow, params: Record<string, unknown>): Promise<string> {
  const senderPtyId =
    typeof params['senderPtyId'] === 'string' ? params['senderPtyId'] : '';
  if (!senderPtyId) return '';
  try {
    // Mirror-first (workspace/ptyOwnership.ts); renderer round-trip fallback.
    const wsId = await resolvePtyOwnerWorkspace(getWindow, senderPtyId);
    return wsId ?? '';
  } catch {
    return '';
  }
}

/**
 * The workspace an external caller is allowed to write, or a throw.
 *
 * This MUST fail closed rather than return undefined: the renderer applies a
 * workspace-less MetadataUpdatePayload to `activeWorkspaceId`
 * (useNotificationListener: `payloadWsId ?? state.activeWorkspaceId`). Passing
 * undefined through would therefore write into whichever workspace the human
 * happens to be looking at — the exact unscoped write U8 reported. An agent
 * that cannot prove which pane it is calling from gets an error instead.
 */
async function requireCallerWorkspace(
  method: string,
  getWindow: GetWindow,
  params: Record<string, unknown>,
): Promise<string> {
  const resolved = await resolveCallerWorkspace(getWindow, params);
  if (!resolved) {
    throw new Error(
      `${method}: cannot resolve the calling pane's workspace — send a verified senderPtyId`,
    );
  }
  return resolved;
}

/**
 * meta.setStatus / meta.setProgress write through the unified
 * MetadataUpdatePayload shape on IPC.METADATA_UPDATE.
 *
 * U8 fix (2026-07-30): workspace scoping is now SERVER-RESOLVED from
 * senderPtyId (same pattern as fanout.rpc / events.rpc). The caller-supplied
 * workspaceId is ignored for external callers, and an external caller whose
 * workspace cannot be resolved is refused. First-party callers (the renderer
 * bridge) keep using the caller-supplied workspaceId since they are trusted and
 * the renderer itself controls which workspace to target.
 */
function sendMeta(getWindow: GetWindow, payload: MetadataUpdatePayload): Promise<{ ok: boolean }> {
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('meta: BrowserWindow is not available'));
  }
  broadcastMetadataUpdate(win, payload);
  return Promise.resolve({ ok: true });
}

export function registerMetaRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * meta.setStatus — sets an arbitrary status text string on a workspace.
   * params: { text: string, workspaceId?: string, senderPtyId?: string }
   *
   * U8: external callers (agents/MCP) have their workspace resolved from
   * senderPtyId. The caller-supplied workspaceId is only trusted for
   * first-party callers (renderer bridge).
   */
  router.register('meta.setStatus', async (params, ctx) => {
    if (typeof params['text'] !== 'string') {
      throw new Error('meta.setStatus: missing required param "text"');
    }
    let workspaceId: string | undefined;
    if (ctx?.firstParty) {
      // Trusted in-process caller (renderer) — honour their supplied workspaceId.
      workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    } else {
      // External caller — resolve from senderPtyId, ignore caller-supplied ws.
      workspaceId = await requireCallerWorkspace('meta.setStatus', getWindow, params);
    }
    return sendMeta(getWindow, { status: params['text'] as string, workspaceId });
  });

  /**
   * meta.setProgress — sets a progress value (0–100) on a workspace.
   * params: { value: number, workspaceId?: string, senderPtyId?: string }
   *
   * U8: same workspace-scoping as meta.setStatus.
   */
  router.register('meta.setProgress', async (params, ctx) => {
    if (typeof params['value'] !== 'number') {
      throw new Error('meta.setProgress: missing required param "value" (number)');
    }
    const value = Math.min(100, Math.max(0, params['value']));
    let workspaceId: string | undefined;
    if (ctx?.firstParty) {
      workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    } else {
      workspaceId = await requireCallerWorkspace('meta.setProgress', getWindow, params);
    }
    return sendMeta(getWindow, { progress: value, workspaceId });
  });
}
