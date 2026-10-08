// ─── moa.ask / moa.askStatus — Moa's delegate on the pipe ────────────────────
//
// The two methods behind the moa_ask / moa_ask_status MCP tools
// (shared/moaAsk.ts has the contract). Identity is server-resolved, never
// taken from params:
//   - the caller's senderPtyId (the MCP server's PID-walk hit) resolves to the
//     workspace that owns that pane right now; an unresolved pane, a missing
//     one, or a commander brain (no pane of its own) is `not-attributed`;
//   - the agent is the slug of the caller's MCP client name;
//   - the cwd is the one wmux reports for that pane; a merge's repo is
//     resolved from it by the service, never named by the caller.
// With the delegate off (no service registered) every call answers `off` and
// nothing is recorded. Owner resolution is NOT here: it is renderer IPC only.

import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { AgentSlug } from '../../../shared/agentIdentity';
import {
  MOA_ASK_RPC,
  MOA_ASK_STATUS_RPC,
  parseMoaAskInput,
  parseMoaAskStatusInput,
  type MoaAsker,
  type MoaAskResult,
  type MoaAskStatusResult,
} from '../../../shared/moaAsk';
import type { MoaDelegateServicePort } from '../../deck/moaDelegatePorts';

export interface MoaRpcDeps {
  getService: () => MoaDelegateServicePort | null;
  /** The workspace that owns this pane now, or null. */
  resolvePtyWorkspace: (ptyId: string) => Promise<string | null>;
  /** The cwd wmux knows for this pane ('' when none). */
  paneCwd: (ptyId: string, workspaceId: string) => string;
}

/** The agent slug for an MCP client name (the same slugs the daemon stamps on
 *  approval records, so a moa_ask and a shadow record hash alike). Substring
 *  order is deliberate (an `openclaude` client reads as claude); the return
 *  type ties every answer to a registry slug. */
export function agentSlugOf(clientName: string | undefined): AgentSlug | 'unknown' {
  const n = (clientName ?? '').toLowerCase();
  if (n.includes('claude')) return 'claude';
  if (n.includes('codex')) return 'codex';
  if (n.includes('opencode')) return 'opencode';
  if (n.includes('gemini')) return 'gemini';
  return 'unknown';
}

const PARAM_KEYS_OF_IDENTITY = ['senderPtyId'];

/** The input the caller sent, without the identity fields the MCP layer adds. */
function bodyOf(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!PARAM_KEYS_OF_IDENTITY.includes(k)) out[k] = v;
  return out;
}

export function registerMoaRpc(router: RpcRouter, deps: MoaRpcDeps): void {
  const resolveAsker = async (params: Record<string, unknown>, ctx?: RpcContext): Promise<{ asker: MoaAsker; cwd: string } | null> => {
    // A brain has no pane: it asks the owner through its own decision card.
    if (ctx?.commanderWorkspace || ctx?.hostedWorkspace !== undefined) return null;
    const ptyId = typeof params.senderPtyId === 'string' ? params.senderPtyId.trim() : '';
    if (!ptyId) return null;
    let workspaceId: string | null;
    try {
      workspaceId = await deps.resolvePtyWorkspace(ptyId);
    } catch {
      workspaceId = null;
    }
    if (!workspaceId) return null;
    return { asker: { ptyId, workspaceId, agent: agentSlugOf(ctx?.clientName) }, cwd: deps.paneCwd(ptyId, workspaceId) };
  };

  router.register(MOA_ASK_RPC, async (params, ctx): Promise<MoaAskResult> => {
    const service = deps.getService();
    if (!service) return { ok: false, code: 'off', message: 'moa_ask is off; ask the owner yourself' };
    const who = await resolveAsker(params, ctx);
    if (!who) return { ok: false, code: 'not-attributed', message: 'wmux could not tie this call to your pane; ask the owner yourself' };
    const parsed = parseMoaAskInput(bodyOf(params));
    if (!parsed.ok) return { ok: false, code: 'invalid', message: `${parsed.field ? `${parsed.field}: ` : ''}${parsed.message}` };
    return service.ask(who.asker, who.cwd, parsed.value);
  });

  router.register(MOA_ASK_STATUS_RPC, async (params, ctx): Promise<MoaAskStatusResult> => {
    const service = deps.getService();
    if (!service) return { ok: false, code: 'off', message: 'moa_ask is off' };
    const who = await resolveAsker(params, ctx);
    if (!who) return { ok: false, code: 'not-attributed', message: 'wmux could not tie this call to your pane' };
    const parsed = parseMoaAskStatusInput(bodyOf(params));
    if (!parsed.ok) return { ok: false, code: 'invalid', message: parsed.message };
    return service.status(who.asker, parsed.value.ticketId);
  });
}
