// `app.action` / `app.action.list`: an agent in a wmux pane drives a few wmux
// features in its own workspace (shared/appActions.ts).
//
// Main decides which workspace the call is for and whether it is well formed;
// the renderer, which owns the workspace tree, resolves the target and refuses
// one outside that workspace. The workspace comes from the caller's pane claim
// only (the claim main minted from its own walk of the CLI's parent
// processes), never from a field of the call, and main never falls back to
// the workspace the human is looking at: no claim, no action. This guards
// against an agent's mistake; it is not a boundary against same-user code,
// which can reach the pipe directly.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import {
  APP_ACTIONS,
  APP_ACTION_RPC,
  APP_ACTION_TARGET_MAX,
  appActionRefusal,
  checkAppActionArgs,
  findAppAction,
  isAppActionErrorCode,
  type AppActionResult,
} from '../../../shared/appActions';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

/** How long the renderer has to answer; every action is a store write. */
const RENDERER_TIMEOUT_MS = 5000;

class AppActionTimeout extends Error {}

export interface AppActionRpcDeps {
  timeoutMs?: number;
}

type ClaimedCaller = { ok: true; workspaceId: string; ptyId: string } | { ok: false; error: string };

/**
 * The caller's workspace and pane, from its pane claim alone. The claim is
 * looked up in the registry main wrote when it minted it, so a call cannot
 * name one that resolves; a claim without a pane (an external MCP client's
 * workspace claim) or a pty stated on the envelope does not count.
 */
function claimedCaller(ctx: RpcContext | undefined): ClaimedCaller {
  const method = APP_ACTION_RPC.run;
  const claim = ctx?.workspaceClaim;
  if (claim?.kind === 'stale') return { ok: false, error: `${method}: the workspace you claimed is gone; run the command again` };
  if (claim?.kind !== 'bound' || !claim.ptyId) {
    return { ok: false, error: `${method}: run this from a wmux pane (no pane claim came with the call)` };
  }
  return { ok: true, workspaceId: claim.workspaceId, ptyId: claim.ptyId };
}

export function registerAppActionRpc(router: RpcRouter, getWindow: GetWindow, deps: AppActionRpcDeps = {}): void {
  router.register(APP_ACTION_RPC.list, async (_params, ctx) => {
    if (ctx?.origin === 'remote') {
      return appActionRefusal('remote_refused', `${APP_ACTION_RPC.list}: not available to another computer`);
    }
    return {
      ok: true,
      actions: APP_ACTIONS.map((a) => ({ id: a.id, target: a.target, args: a.args, description: a.description })),
    };
  });

  router.register(APP_ACTION_RPC.run, async (params, ctx): Promise<AppActionResult> => {
    const method = APP_ACTION_RPC.run;
    if (ctx?.origin === 'remote') {
      return appActionRefusal('remote_refused', `${method}: not available to another computer`);
    }
    // The router refuses this method to a fenced worker's pane before it gets
    // here; the context mark is the same verdict, checked again.
    if (ctx?.fencedWorker) {
      return appActionRefusal('fenced', `${method}: not available inside the worker fence`);
    }

    const id = typeof params['id'] === 'string' ? params['id'].trim() : '';
    if (!id) return appActionRefusal('invalid_args', `${method}: missing "id" (${APP_ACTION_RPC.list} lists them)`);
    const spec = findAppAction(id);
    if (!spec) return appActionRefusal('unknown_action', `${method}: no action "${id}" (${APP_ACTION_RPC.list} lists them)`);

    const rawTarget = params['target'];
    if (rawTarget !== undefined && rawTarget !== null && typeof rawTarget !== 'string') {
      return appActionRefusal('invalid_args', `${id}: target must be a string`);
    }
    const target = typeof rawTarget === 'string' ? rawTarget.trim() : '';
    if (target.length > APP_ACTION_TARGET_MAX) {
      return appActionRefusal('invalid_args', `${id}: target is longer than ${APP_ACTION_TARGET_MAX} characters`);
    }
    if (target && spec.target === 'none') {
      return appActionRefusal('invalid_args', `${id}: takes no target (it is an app setting)`);
    }
    const args = checkAppActionArgs(spec, params['args']);
    if (!args.ok) return appActionRefusal('invalid_args', args.error);

    // Nothing the call names (a workspace, a sender pane, the envelope's
    // pty) stands in for the claim. The operator lane carries no claim and
    // is refused like any caller without one.
    const caller = claimedCaller(ctx);
    if (!caller.ok) return appActionRefusal('no_identity', caller.error);

    const win = getWindow();
    if (!win || win.isDestroyed()) {
      return appActionRefusal('no_window', `${id}: the wmux window is not open`);
    }
    let answer: unknown;
    try {
      answer = await sendToRenderer(
        getWindow,
        method,
        {
          id,
          args: args.args,
          ...(target ? { target } : {}),
          callerWorkspaceId: caller.workspaceId,
          callerPtyId: caller.ptyId,
        },
        { timeoutMs: deps.timeoutMs ?? RENDERER_TIMEOUT_MS, timeoutError: new AppActionTimeout() },
      );
    } catch (err) {
      if (err instanceof AppActionTimeout) {
        return appActionRefusal('timeout', `${id}: the wmux window did not answer in time; check the result before running it again`);
      }
      // sendToRenderer's only other refusal: the window closed in between.
      return appActionRefusal('no_window', `${id}: the wmux window is not open`);
    }
    return normalizeAnswer(id, answer);
  });
}

/** The renderer's answer as an AppActionResult, whatever it sent. */
function normalizeAnswer(id: string, answer: unknown): AppActionResult {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return appActionRefusal('no_window', `${id}: the wmux window sent no answer`);
  }
  const a = answer as Record<string, unknown>;
  if (a['ok'] === true) return { ...a, ok: true, id };
  const error = typeof a['error'] === 'string' && a['error'] ? a['error'] : `${id}: refused`;
  // The bridge's own refusals (still starting, unknown method) carry no code.
  const code = isAppActionErrorCode(a['code']) ? a['code'] : 'no_window';
  return appActionRefusal(code, error);
}
