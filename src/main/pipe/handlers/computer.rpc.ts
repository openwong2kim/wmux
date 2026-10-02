import { createHash } from 'node:crypto';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { ComputerError, encodeComputerErrorMessage } from '../../../shared/computer/errors';
import { isControlAction, type ObservationMode } from '../../../shared/computer/protocol';
import type { ComputerAgent, ComputerService, ControlParams } from '../../computer/ComputerService';

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
  /** The name the person gave a workspace, for the consent prompt. */
  workspaceName: (workspaceId: string) => string | undefined = () => undefined,
): void {
  // Listing apps needs no identity beyond a named client; getAppState and act
  // are what consent, the lock and snapshots key on. listWindows uses the
  // identity when the caller sends one (titles of consented apps) and
  // otherwise gets an agent with an empty key, for which every title is blank.
  type Identity = 'none' | 'required' | 'optional';
  const wrap = <T>(fn: (params: Record<string, unknown>, agent: ComputerAgent) => Promise<T>, identity: Identity = 'none') =>
    async (params: Record<string, unknown>, ctx?: RpcContext): Promise<T> => {
      try {
        const name = requireClient(ctx);
        const sendsIdentity = typeof params.senderPtyId === 'string' || typeof params.callerInstance === 'string'
          || Boolean(ctx?.commanderWorkspace);
        const agent = identity === 'required' || (identity === 'optional' && sendsIdentity)
          ? await callerAgent(ctx, params, resolvePtyWorkspace, workspaceName)
          : identity === 'optional' ? { key: '', label: name } : unkeyed(name);
        return await fn(params, agent);
      } catch (err) {
        if (err instanceof ComputerError) throw new Error(encodeComputerErrorMessage(err.toPayload()));
        throw new Error(encodeComputerErrorMessage({ code: 'internal', message: err instanceof Error ? err.message : String(err) }));
      }
    };

  router.register('computer.capabilities', wrap(() => getService().capabilities()));

  router.register('computer.listApps', wrap(() => getService().listApps()));

  router.register('computer.listWindows', wrap((params, agent) =>
    getService().listWindows(agent, typeof params.app === 'string' ? params.app : undefined), 'optional'));

  router.register('computer.getAppState', wrap((params, agent) => {
    if (typeof params.app !== 'string' || params.app.length === 0) {
      throw new ComputerError('invalid_argument', 'app is required');
    }
    return getService().getAppState(agent, {
      app: params.app,
      ...(typeof params.window === 'string' && { window: params.window }),
      ...(typeof params.mode === 'string' && { mode: params.mode as ObservationMode }),
    });
  }, 'required'));

  router.register('computer.act', wrap((params, agent) => {
    if (typeof params.action !== 'string' || !isControlAction(params.action)) {
      throw new ComputerError('invalid_argument', 'action must be one of click, setValue, type, pressKey, hotkey, scroll');
    }
    const control = { ...params };
    delete control.senderPtyId;
    delete control.callerInstance;
    return getService().control(agent, control as unknown as ControlParams);
  }, 'required'));
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

/** For the methods that key nothing on the caller (listing apps and windows). */
function unkeyed(name: string): ComputerAgent {
  return { key: name, label: name };
}

/** A workspace name as it may appear inside a quoted label. */
function quotable(text: string): string {
  // Workspace names are user- (and agent-) editable: no control characters,
  // and no double quote that could close the label's quotes early.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/"/g, "'").trim().slice(0, 60);
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
async function callerAgent(
  ctx: RpcContext | undefined,
  params: Record<string, unknown>,
  resolvePtyWorkspace: (ptyId: string) => Promise<string | null>,
  workspaceName: (workspaceId: string) => string | undefined,
): Promise<ComputerAgent> {
  const name = requireClient(ctx);
  // What the person (consent prompt) and other agents (input_busy) see: the
  // client name and the workspace by its name. The key carries pane and
  // workspace ids and stays internal.
  const inWorkspace = (workspaceId: string, role = 'in') => {
    let shown: string | undefined;
    try {
      shown = workspaceName(workspaceId);
    } catch {
      shown = undefined;
    }
    const clean = shown ? quotable(shown) : '';
    return clean ? `${name} ${role} workspace "${clean}"` : `${name} ${role} a wmux workspace`;
  };
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
    return { key: `${name} @ ${ws}/${ptyId}`, label: inWorkspace(ws) };
  }
  if (ctx?.commanderWorkspace) {
    return {
      key: `${name} @ ${ctx.commanderWorkspace}/commander`,
      label: inWorkspace(ctx.commanderWorkspace, 'orchestrating'),
    };
  }
  const instance = typeof params.callerInstance === 'string' ? params.callerInstance : '';
  if (!INSTANCE_RE.test(instance)) {
    throw new ComputerError('invalid_argument', 'computer use needs the calling agent\'s pane or session identity');
  }
  const where = claim?.kind === 'bound' ? `@ ${claim.workspaceId}` : '(no pane)';
  // Hashed, so the key never holds an instance id another agent could
  // present as its own (only the label is shown, but keep it that way).
  return {
    key: `${name} ${where} #${createHash('sha256').update(instance).digest('hex').slice(0, 12)}`,
    label: claim?.kind === 'bound' ? inWorkspace(claim.workspaceId) : `${name} (outside wmux panes)`,
  };
}
