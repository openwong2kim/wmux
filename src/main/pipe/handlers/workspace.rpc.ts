import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { sendToRenderer } from './_bridge';
import {
  mintWorkspaceClaimToken,
  revokeWorkspaceClaimTokensFor,
} from '../../workspace/workspaceClaimTrust';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { getFanOutGuards, type FanOutGuards } from '../../worktask/fanoutGuards';

type GetWindow = () => BrowserWindow | null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface WorkspaceRpcDeps {
  /** Injected in tests; defaults to the hosted lineage store. */
  guards?: Pick<FanOutGuards, 'fanoutOwnerOf' | 'markTask'>;
  /** Injected in tests; defaults to the mirror/renderer resolution. */
  resolveCallerWorkspace?: (senderPtyId: string) => Promise<string | null>;
}

export function registerWorkspaceRpc(router: RpcRouter, getWindow: GetWindow, deps: WorkspaceRpcDeps = {}): void {
  const resolveCaller =
    deps.resolveCallerWorkspace ??
    (async (senderPtyId: string) => {
      try {
        return await resolvePtyOwnerWorkspace(getWindow, senderPtyId);
      } catch {
        return null;
      }
    });

  /**
   * Depth-1 lineage inheritance: a workspace created by a caller whose own
   * workspace is a fan-out task is stamped as a task of the same owner, so
   * "create a fresh workspace, start an agent there, fan out from it" does not
   * step around the depth limit on the honest path.
   *
   * Who inherits: a validated commander binding, or a caller that STATES a
   * senderPtyId (the `wmux new-workspace` CLI sends its pane's WMUX_PTY_ID).
   * A caller with neither has no pane to be a task in — the external MCP
   * client's `mcp.claimWorkspace` sends only `{ name }` — and creates an
   * unstamped workspace. Trusting a stated pty is safe here for the same reason
   * the stamp is: inheriting can only take fan-out away.
   *
   * Fail-closed, in two halves. BEFORE the create: a stated senderPtyId that
   * does not resolve, or a lineage store that cannot be read, refuses the
   * call. AFTER it: if the caller is a task and the stamp cannot be written,
   * the new workspace is closed again and the call fails — an unstamped
   * workspace created by a task is exactly the escape this exists to stop.
   *
   * Returns the owner the new workspace must inherit, or null.
   */
  const lineageToInherit = async (
    params: Record<string, unknown>,
    ctx: RpcContext | undefined,
    method: string,
  ): Promise<string | null> => {
    const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'].trim() : '';
    let callerWs = ctx?.commanderWorkspace || null;
    if (!callerWs && senderPtyId) {
      callerWs = await resolveCaller(senderPtyId);
      if (!callerWs) {
        throw new Error(`${method}: senderPtyId ${senderPtyId} does not resolve to a workspace`);
      }
    }
    if (!callerWs) return null;
    const guards = deps.guards ?? getFanOutGuards();
    try {
      return guards.fanoutOwnerOf(callerWs);
    } catch (err) {
      throw new Error(`${method}: cannot tell whether the caller is a fan-out task (${(err as Error).message})`);
    }
  };

  /** Stamp the created workspace, or close it and fail. */
  const stampOrUndo = async (owner: string, result: unknown, method: string): Promise<void> => {
    if (!isRecord(result)) return;
    const created = typeof result['id'] === 'string' ? result['id'] : result['workspaceId'];
    if (typeof created !== 'string' || created.length === 0) return;
    try {
      (deps.guards ?? getFanOutGuards()).markTask(created, owner);
    } catch (err) {
      try {
        await sendToRenderer(getWindow, 'workspace.close', { id: created });
      } catch {
        // best-effort; the error below names the workspace either way
      }
      throw new Error(
        `${method}: the caller is a fan-out task and the new workspace ${created} could not be stamped as one, so it was closed (${(err as Error).message})`,
      );
    }
  };
  /**
   * workspace.list — returns all workspaces as {id, name}[]
   */
  router.register('workspace.list', (_params) =>
    sendToRenderer(getWindow, 'workspace.list'),
  );

  /**
   * workspace.new — creates a new workspace
   * params: { name?: string }
   */
  router.register('workspace.new', async (params, ctx) => {
    const name = typeof params['name'] === 'string' ? params['name'] : undefined;
    const owner = await lineageToInherit(params, ctx, 'workspace.new');
    const result = await sendToRenderer(getWindow, 'workspace.new', name !== undefined ? { name } : {});
    if (owner) await stampOrUndo(owner, result, 'workspace.new');
    return result;
  });

  /**
   * workspace.focus — sets the active workspace
   * params: { id: string }
   */
  router.register('workspace.focus', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('workspace.focus: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'workspace.focus', { id: params['id'] });
  });

  /**
   * workspace.close — removes a workspace
   * params: { id: string }
   */
  router.register('workspace.close', async (params) => {
    if (typeof params['id'] !== 'string') {
      throw new Error('workspace.close: missing required param "id"');
    }
    const result = await sendToRenderer(getWindow, 'workspace.close', { id: params['id'] });
    // #922 PR-A — retire any claim bound to this workspace, but ONLY once the
    // close actually happened.
    //
    // The renderer reports a REFUSAL as a resolved `{ error }` envelope, not a
    // rejection: an unknown id, the last-workspace guard, and the post-removal
    // "still open" assertion all return one (`useRpcBridge.ts`, #799). So
    // awaiting the call proves nothing on its own — revoking unconditionally
    // would kill the claim of a workspace that is still open and still the
    // holder's. Under the lane that refuses a stale claim, that holder would be
    // locked out of its own live workspace with no way back: re-claiming mints
    // a NEW workspace, it does not re-bind the old one.
    //
    // It is also reachable by anyone else: workspace ids come from
    // `workspace.list`, so a second caller could aim a close it knows will be
    // refused at a claimant's workspace and destroy only that claim.
    //
    // Hence a POSITIVE success check rather than "no error" — a shape this
    // handler does not recognise leaves the claim alone, which is the safe way
    // to be wrong.
    if (isRecord(result) && result['ok'] === true) {
      revokeWorkspaceClaimTokensFor(params['id']);
    }
    return result;
  });

  /**
   * workspace.current — returns the currently active workspace {id, name}
   */
  router.register('workspace.current', (_params) =>
    sendToRenderer(getWindow, 'workspace.current'),
  );

  /**
   * mcp.claimWorkspace — spawn a dedicated workspace + PTY for an external
   * MCP caller (i.e. Claude Code running in a terminal outside wmux).
   *
   * Without this, terminal_send falls through to the currently-focused pane
   * and injects keystrokes into the user's live work. claim creates an
   * isolated workspace, spawns a terminal in it, and returns the ptyId so
   * the MCP client can pin all future "no-ptyId" calls to that PTY.
   *
   * Critically, the renderer restores the previous active workspace after
   * creation — claim must not steal the user's focus.
   *
   * params: { name?: string }
   * returns: { ptyId, workspaceId, workspaceName }
   */
  router.register('mcp.claimWorkspace', async (params, ctx) => {
    const name = typeof params['name'] === 'string' ? params['name'] : undefined;
    const owner = await lineageToInherit(params, ctx, 'mcp.claimWorkspace');
    const result = await sendToRenderer(
      getWindow,
      'mcp.claimWorkspace',
      name !== undefined ? { name } : {},
    );
    if (owner) await stampOrUndo(owner, result, 'mcp.claimWorkspace');

    // ── #922 PR-A — issue the claim token ────────────────────────────────
    //
    // This is the one call where main CREATES a workspace for a specific
    // caller, so "this caller owns that workspace" is a fact main already
    // holds rather than something the caller asserts. Minting here records it
    // (workspaceClaimTrust.ts) and hands the holder its half.
    //
    // Issued ONLY to the external wire. The in-process surfaces have stronger
    // bindings already — the renderer is the operator, and the plugin host
    // carries `hostedWorkspace` derived by the host itself (#941/#1097) — so
    // handing them a bearer secret would add a credential neither needs and
    // widen where one can leak from.
    //
    // Additive and non-fatal by construction: the token rides ALONGSIDE the
    // existing fields, never replacing one, and a response that carries no
    // workspaceId (a renderer error envelope, an older renderer) is returned
    // untouched. Nothing reads the token for an authorisation decision yet —
    // PR-B adds that — so a caller that ignores it behaves exactly as before.
    if (ctx?.externalWire !== true) return result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
    const workspaceId = (result as Record<string, unknown>)['workspaceId'];
    const token = mintWorkspaceClaimToken(workspaceId);
    if (!token) return result;
    return { ...(result as Record<string, unknown>), workspaceToken: token };
  });
}
