// moa_ask / moa_ask_status — the MCP tools.
//
// Registered (registerMoaAskTools) only when readMoaAskEnabled()
// (shared/moaAskSwitch.ts) is true at server start, only in the `full`
// profile, appended after every other tool, so the default tools/list the
// probe pins stays byte-identical. Main re-validates every input with
// parseMoaAskInput / parseMoaAskStatusInput (shared/moaAsk.ts); this schema is
// the caller-facing description, not the check.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MOA_ASK_LIMITS, MOA_ASK_STATUS_TOOL, MOA_ASK_TOOL } from '../shared/moaAsk';

export const MOA_ASK_DESCRIPTION =
  'Ask Moa (the owner\'s delegate) instead of the owner. Returns at once with {ticketId, status}; poll moa_ask_status. ' +
  'answered: proceed with answer. escalated: ask the owner yourself. refused: do not proceed. ' +
  'Give question+options, or action {type:"merge", prNumber, expectHead} for a PR in your repo. ' +
  'askId makes a retry return the same ticket.';

export const MOA_ASK_STATUS_DESCRIPTION = 'The state of your moa_ask ticket. While pending, poll again after pollAfterMs.';

export const MOA_ASK_INPUT_SHAPE = {
  question: z.string().max(MOA_ASK_LIMITS.QUESTION_MAX).optional(),
  options: z.array(z.object({
    key: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })).min(MOA_ASK_LIMITS.OPTIONS_MIN).max(MOA_ASK_LIMITS.OPTIONS_MAX).optional(),
  kind: z.string().optional().describe('Question category'),
  action: z.object({
    type: z.literal('merge'),
    prNumber: z.number().int(),
    expectHead: z.string().describe('Full head SHA you checked'),
  }).optional(),
  context: z.string().max(MOA_ASK_LIMITS.CONTEXT_MAX).optional(),
  askId: z.string().optional(),
} as const;

export const MOA_ASK_STATUS_INPUT_SHAPE = {
  ticketId: z.string(),
} as const;

export interface MoaAskToolDeps {
  callRpc: (method: 'moa.ask' | 'moa.askStatus', params: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }>;
  /** The caller's VERIFIED pane (PID-walk hit only, never the env hint);
   *  '' when unknown, which main answers `not-attributed`. */
  getSenderPtyId: () => Promise<string>;
}

/** Register both tools. The caller decides whether to (switch + profile). */
export function registerMoaAskTools(server: Pick<McpServer, 'tool'>, deps: MoaAskToolDeps): void {
  const withSender = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const senderPtyId = await deps.getSenderPtyId().catch(() => '');
    return senderPtyId ? { ...input, senderPtyId } : { ...input };
  };
  server.tool(MOA_ASK_TOOL, MOA_ASK_DESCRIPTION, MOA_ASK_INPUT_SHAPE, async (input) =>
    deps.callRpc('moa.ask', await withSender(stripUndefined(input))));
  server.tool(MOA_ASK_STATUS_TOOL, MOA_ASK_STATUS_DESCRIPTION, MOA_ASK_STATUS_INPUT_SHAPE, async (input) =>
    deps.callRpc('moa.askStatus', await withSender(stripUndefined(input))));
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}
