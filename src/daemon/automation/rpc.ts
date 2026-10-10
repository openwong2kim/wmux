// automation.* RPC surface on the daemon pipe.
//
// Reads (list, runs) are open to any authenticated client. Every mutation —
// propose included, which reaches the daemon through the desktop — and the
// output snapshot are first-party only. That is a classification over the one
// shared pipe token (see DaemonPipeServer.markFirstParty), not a second
// credential: a token holder can already run anything via daemon.createSession.
// What schedules add is persistence and unattended timing, and the control for
// that is detection — grants and drafts queue an attention item the desktop
// surfaces — rather than a stronger wall here.
//
// Client payloads are never spread into stored state: the engine reads only
// validated draft fields, so a client-sent `grantedRevision`, `revision`,
// `enabled` or `permission` is ignored. `automation.grant` is the only writer
// of a grant, and it records the automation's current revision server-side.

import { AUTOMATION_PTY_PREFIX, AUTOMATION_RPC, type AutomationListResult } from '../../shared/automation';
import type { AutomationEngine } from './AutomationEngine';

type RpcHandler = (params: Record<string, unknown>, ctx: { clientId: string }) => Promise<unknown>;

const REFUSED = { ok: false as const, error: 'Unavailable' };

/**
 * `auto-` ids are reserved for scheduled runs (the desktop hides them from the
 * orphan list by that prefix). The engine creates its sessions through the
 * internal create path, so only the external `daemon.createSession` checks.
 */
export function assertExternalSessionId(params: Record<string, unknown>): void {
  const id = params['id'];
  if (typeof id === 'string' && id.toLowerCase().startsWith(AUTOMATION_PTY_PREFIX)) {
    throw new Error(`Invalid session ID: the ${AUTOMATION_PTY_PREFIX} prefix is reserved for scheduled runs`);
  }
}

/**
 * What a non-first-party reader sees: names, schedules, agents and state, but
 * not the prompt, the folder or the account (the prompt can carry anything the
 * user typed, and none of it is needed to show a schedule list).
 */
export function redactListForThirdParty(result: AutomationListResult): AutomationListResult {
  return {
    automations: result.automations.map((a) => ({
      ...a,
      action: { kind: a.action.kind, agent: a.action.agent, cwd: '', prompt: '' },
    })),
    ...(result.pendingAttention ? { pendingAttention: result.pendingAttention } : {}),
  };
}

export function registerAutomationRpc(
  onRpc: (method: string, handler: RpcHandler) => void,
  engine: AutomationEngine,
  firstPartyOnly: (clientId: string, method: string) => boolean,
  /** Silent classification (no refusal log) for the read that is open to all. */
  isFirstParty: (clientId: string) => boolean = () => false,
): void {
  const gated = (method: string, run: (params: Record<string, unknown>) => Promise<unknown>): void => {
    onRpc(method, async (params, ctx) => (firstPartyOnly(ctx.clientId, method) ? run(params ?? {}) : REFUSED));
  };

  onRpc(AUTOMATION_RPC.list, async (_params, ctx) =>
    (isFirstParty(ctx.clientId) ? engine.list() : redactListForThirdParty(engine.list())));
  onRpc(AUTOMATION_RPC.runs, async (params) => ({
    runs: engine.listRuns(typeof params?.['automationId'] === 'string' ? params['automationId'] : undefined),
  }));
  // Output of an agent run: same class as the transcript RPCs.
  onRpc(AUTOMATION_RPC.snapshot, async (params, ctx) => ({
    text: firstPartyOnly(ctx.clientId, AUTOMATION_RPC.snapshot) && typeof params?.['runId'] === 'string'
      ? engine.snapshot(params['runId'])
      : null,
  }));

  gated(AUTOMATION_RPC.create, (p) => engine.create(p['draft'], p['enabled']));
  gated(AUTOMATION_RPC.update, (p) => engine.update(p['id'], p['draft']));
  gated(AUTOMATION_RPC.remove, (p) => engine.remove(p['id']));
  gated(AUTOMATION_RPC.setEnabled, (p) => engine.setEnabled(p['id'], p['enabled']));
  gated(AUTOMATION_RPC.grant, (p) => engine.grant(p['id'], p['mode'], p['allowedTools'], p['expectedRevision']));
  gated(AUTOMATION_RPC.runNow, (p) => engine.runNow(p['id'], p['kind']));
  gated(AUTOMATION_RPC.cancelRun, (p) => engine.cancelRun(p['runId']));
  gated(AUTOMATION_RPC.propose, (p) => engine.propose(p['draft']));
  gated(AUTOMATION_RPC.ackAttention, (p) => engine.ackAttention(p['ids']));
}
