// The workspace an `a2a.task.*` call acts as, taken from the server side.
//
// A task call names its caller's workspace in `params.workspaceId`, and the
// task log decides what that workspace may do (send as it, read its tasks,
// update or cancel them) and records the action under it. So the name is
// checked against what main knows about the caller, as the channel handlers
// already do (a2a.channel.rpc.ts): a commander token's workspace, the plugin
// host's binding, a workspace claim main issued, or the workspace that owns
// the caller's pane. A name that differs, or a caller none of those
// identifies, is refused.
//
// The operator lane (the renderer and main's own dispatches) and in-process
// first-party dispatches are main itself and keep naming the workspace.

import type { BrowserWindow } from 'electron';
import { hostedBindingOf, isHostedCaller, type RpcContext } from '../../../shared/rpc';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';

export type A2aCaller =
  | { ok: true; trusted: true }
  | { ok: true; trusted: false; workspaceId: string }
  | { ok: false; error: string };

/** main itself: the operator lane, or an in-process first-party dispatch that is not a plugin host. */
export function isTrustedA2aLane(ctx: RpcContext | undefined): boolean {
  return ctx?.operator === true || (ctx?.firstParty === true && !isHostedCaller(ctx));
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The caller's workspace for `method`, or a refusal. The refusals say the
 * caller is "not owned by workspace" or that "no workspace" was found for it:
 * the MCP server drops a cached workspace id on those words and finds its
 * workspace again (src/mcp/index.ts isStaleIdentityResult).
 */
export async function a2aCallerWorkspace(
  getWindow: () => BrowserWindow | null,
  method: string,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
): Promise<A2aCaller> {
  if (isTrustedA2aLane(ctx)) return { ok: true, trusted: true };
  const named = text(params.workspaceId);
  let derived: string | null = null;
  if (ctx?.commanderWorkspace) {
    derived = ctx.commanderWorkspace;
  } else if (isHostedCaller(ctx)) {
    derived = hostedBindingOf(ctx) ?? null;
  } else if (ctx?.workspaceClaim?.kind === 'bound') {
    derived = ctx.workspaceClaim.workspaceId;
  } else if (ctx?.workspaceClaim?.kind === 'stale') {
    return { ok: false, error: `${method}: the workspace you claimed is gone` };
  } else {
    const pty = text(params.senderPtyId) || text(ctx?.callerPtyId);
    if (pty) {
      derived = await resolvePtyOwnerWorkspace(getWindow, pty, named ? { expected: named } : {}).catch(() => null);
    }
  }
  if (!derived) return { ok: false, error: `${method}: no workspace found for the calling pane` };
  if (named && named !== derived) return { ok: false, error: `${method}: the calling pane is not owned by workspace ${named}` };
  return { ok: true, trusted: false, workspaceId: derived };
}
