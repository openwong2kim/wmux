// moa_ask / moa_ask_status — the MCP input schemas (contract only).
//
// NOT registered yet. The step that wires them registers both only when
// readMoaAskEnabled() (shared/moaAskSwitch.ts) is true at server start, only
// in the `full` profile, appended after every other tool, so the default
// tools/list the probe pins stays byte-identical. Main re-validates every
// input with parseMoaAskInput / parseMoaAskStatusInput (shared/moaAsk.ts);
// this schema is the caller-facing description, not the check.

import { z } from 'zod';
import { MOA_ASK_LIMITS } from '../shared/moaAsk';

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
