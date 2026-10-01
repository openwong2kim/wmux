import { createHash } from 'node:crypto';
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
export function registerComputerRpc(
  router: RpcRouter,
  getService: () => ComputerService,
  resolvePtyWorkspace: (ptyId: string) => Promise<string | null>,
): void {
  // Observation of the app list needs no identity beyond a named client;
  // getAppState and act are what consent, the lock and snapshots key on.
  const wrap = <T>(fn: (params: Record<string, unknown>, clientName: string) => Promise<T>, identified = false) =>
    async (params: Record<string, unknown>, ctx?: RpcContext): Promise<T> => {
      try {
        const caller = identified ? await callerName(ctx, params, resolvePtyWorkspace) : requireClient(ctx);
        return await fn(params, caller);
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
  }, true));

  router.register('computer.act', wrap((params, clientName) => {
    if (typeof params.action !== 'string' || !isControlAction(params.action)) {
      throw new ComputerError('invalid_argument', 'action must be one of click, setValue, type, pressKey, hotkey, scroll');
    }
    const control = { ...params };
    delete control.senderPtyId;
    delete control.callerInstance;
    return getService().control(clientName, control as unknown as ControlParams);
  }, true));
}

const INSTANCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A named MCP client, not dispatched from the plugin host. */
function requireClient(ctx: RpcContext | undefined): string {
  const name = ctx?.clientName?.trim();
  if (!name) throw new ComputerError('invalid_argument', 'computer use needs an identified MCP client');
  // The iframe plugin host is not a computer-use caller by design; refuse it
  // rather than key it on a name a plugin chose.
  if (ctx?.hostedWorkspace !== undefined) {
    throw new ComputerError('invalid_argument', 'computer use is not available to plugins');
  }
  return name;
}

/**
 * The agent identity consent grants, the input lock and snapshot ownership are
 * keyed on. The MCP client name alone is shared by every agent of one kind
 * (all Claude Code panes report the same name), so it is narrowed, in order:
 *
 *   1. `senderPtyId` — the caller's pane from its own PID-map walk, resolved
 *      server-side to the workspace that owns it right now (the fan-out R2
 *      lane). Per pane, so split panes of one workspace are distinct too. A
 *      pty that does not resolve, or disagrees with the caller's workspace
 *      claim, is refused, never demoted.
 *   2. a validated commander token — an orchestrator brain has no pane.
 *   3. otherwise `callerInstance`, a random id each MCP server process mints
 *      once: a caller with no pane (walk miss, external client) is its own
 *      principal and shares nothing with another process. Without one, refuse.
 *
 * Caller-supplied `workspaceId` is never used, and the weak WMUX_PTY_ID env
 * hint is never sent here: an inherited one would put several agents on one
 * pane's grants. `senderPtyId` is still caller-asserted within the same-user
 * ceiling (#113), like fan-out's. Grants live in main's memory only, so a
 * reused ptyId inherits them until wmux restarts or the stop key clears them;
 * a pane moved to another workspace changes key and asks again.
 */
async function callerName(
  ctx: RpcContext | undefined,
  params: Record<string, unknown>,
  resolvePtyWorkspace: (ptyId: string) => Promise<string | null>,
): Promise<string> {
  const name = requireClient(ctx);
  const claim = ctx?.workspaceClaim;
  if (claim?.kind === 'stale') {
    throw new ComputerError('invalid_argument', 'this agent\'s workspace claim is no longer valid');
  }
  const ptyId = typeof params.senderPtyId === 'string' ? params.senderPtyId.trim() : '';
  if (ptyId) {
    let ws: string | null = null;
    try {
      ws = await resolvePtyWorkspace(ptyId);
    } catch {
      ws = null;
    }
    if (!ws) {
      throw new ComputerError('invalid_argument', 'this agent\'s pane could not be verified; if wmux is still starting, try again in a moment');
    }
    if (claim?.kind === 'bound' && claim.workspaceId !== ws) {
      throw new ComputerError('invalid_argument', 'this agent\'s pane and workspace claim disagree');
    }
    return `${name} @ ${ws}/${ptyId}`;
  }
  if (ctx?.commanderWorkspace) return `${name} @ ${ctx.commanderWorkspace}/commander`;
  const instance = typeof params.callerInstance === 'string' ? params.callerInstance : '';
  if (!INSTANCE_RE.test(instance)) {
    throw new ComputerError('invalid_argument', 'computer use needs the calling agent\'s pane or session identity');
  }
  const where = claim?.kind === 'bound' ? `@ ${claim.workspaceId}` : '(no pane)';
  // Hashed: the key reaches other agents (input_busy names the holder), and a
  // raw instance id there would be one they could present as their own.
  return `${name} ${where} #${createHash('sha256').update(instance).digest('hex').slice(0, 12)}`;
}
