// `app.action` / `app.action.list`: an agent in a wmux pane drives a few wmux
// features in its own workspace (shared/appActions.ts).
//
// Main decides who is calling and whether the call is well formed; the
// renderer, which owns the workspace tree, resolves the target and refuses one
// outside the caller's workspace. Main never falls back to the workspace the
// human is looking at: no verified caller workspace, no action.

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
import { a2aCallerWorkspace, type A2aCaller } from './a2aCaller';

type GetWindow = () => BrowserWindow | null;

/** How long the renderer has to answer; every action is a store write. */
const RENDERER_TIMEOUT_MS = 5000;

class AppActionTimeout extends Error {}

export interface AppActionRpcDeps {
  /** Injected in tests; defaults to a2aCallerWorkspace. */
  resolveCaller?: (method: string, params: Record<string, unknown>, ctx: RpcContext | undefined) => Promise<A2aCaller>;
  timeoutMs?: number;
}

/** The caller's verified pane, when its identity came with one. */
function verifiedCallerPty(ctx: RpcContext | undefined): string | undefined {
  if (ctx?.workspaceClaim?.kind === 'bound' && ctx.workspaceClaim.ptyId) return ctx.workspaceClaim.ptyId;
  // The envelope's pty is only a hint; the renderer uses it only inside the
  // caller's own workspace, to pick the caller's own tab or pane.
  return ctx?.callerPtyId;
}

export function registerAppActionRpc(router: RpcRouter, getWindow: GetWindow, deps: AppActionRpcDeps = {}): void {
  const resolveCaller =
    deps.resolveCaller ??
    ((method: string, params: Record<string, unknown>, ctx: RpcContext | undefined) =>
      a2aCallerWorkspace(getWindow, method, params, ctx));

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

    // The caller's workspace from what main verified: a pane claim, a
    // commander binding, or the pane its pty belongs to. Nothing the call
    // names is an identity here: a stated workspace or sender pane is not
    // passed on, so it can neither stand in for the claim nor be checked
    // against it. The operator lane has no workspace of its own and is
    // refused like any caller without one.
    const caller = await resolveCaller(method, {}, ctx);
    if (!caller.ok) {
      const code = /not owned by workspace/.test(caller.error) ? 'not_owned' : 'no_identity';
      return appActionRefusal(code, caller.error);
    }
    if (caller.trusted) {
      return appActionRefusal('no_identity', `${method}: acts for a pane's own workspace, and this caller has none`);
    }

    const win = getWindow();
    if (!win || win.isDestroyed()) {
      return appActionRefusal('no_window', `${id}: the wmux window is not open`);
    }
    const callerPtyId = verifiedCallerPty(ctx);
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
          ...(callerPtyId ? { callerPtyId } : {}),
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
