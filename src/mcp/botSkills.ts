// skill_propose / skill_read — a bot's own skills (shared/botSkill.ts),
// registered with registerToolModule (src/mcp/toolModules.ts). Every call
// carries the bot's token; main takes the bot from its binding and builds
// every path itself, so no tool names a bot or a path.

import { z } from 'zod';
import { BOT_SKILL_RPC, SKILL_LIMITS, SKILL_NAME_RE, SKILL_REFERENCE_NAME_RE } from '../shared/botSkill';
import { registerToolModule } from './toolModules';

const NAME = z.string().regex(SKILL_NAME_RE).describe('The skill\'s name: a lowercase slug (a-z, 0-9, -).');

registerToolModule({
  name: 'bot-skills',
  tools: ['skill_propose', 'skill_read'],
  register(host, deps) {
    // A fresh object literal: the SDK's result type has an index signature.
    const call = async (method: Parameters<typeof deps.callRpc>[0], params: Record<string, unknown>) => ({
      ...(await deps.callRpc(method, params)),
    });

    host.tool(
      'skill_propose',
      'Write a skill: a procedure for one kind of your work (steps, checks, pitfalls), not a standing fact. '
        + 'Proposing a name you already have updates that skill (prefer it over a new one); an update takes a newer version. '
        + 'Nothing loads until the owner approves the card that shows the change; Deny archives the proposal. '
        + `The card shows the whole change, so it is at most ${SKILL_LIMITS.DIFF_MAX} characters (a new skill counts in full): keep a skill short, or split it.`,
      {
        name: NAME,
        content: z.string().min(1).max(SKILL_LIMITS.BODY_MAX)
          .describe('The whole SKILL.md: line 1 exactly ---, then exactly name, description (one line: when to use it) and version (1.0.0), one key: value line each, then a line exactly --- (no indent), then the procedure. No --- anywhere in the values, and no line of only dashes in the procedure (use *** for a rule).'),
        references: z.array(z.object({
          name: z.string().regex(SKILL_REFERENCE_NAME_RE),
          content: z.string().max(SKILL_LIMITS.REFERENCE_MAX),
        })).max(SKILL_LIMITS.REFERENCES_MAX).optional().describe('Supporting files of this version (the whole set).'),
        reason: z.string().min(1).max(SKILL_LIMITS.REASON_MAX).describe('One line for the owner: what you learned, and from what.'),
      },
      async ({ name, content, references, reason }) =>
        call(BOT_SKILL_RPC.propose, { name, content, reason, ...(references ? { references } : {}) }),
    );

    host.tool(
      'skill_read',
      'Read one of your approved skills (its SKILL.md and reference names), or one of its references. With no name: the list of your approved skills.',
      {
        name: NAME.optional(),
        reference: z.string().min(1).max(80).optional().describe('A reference file name from the skill.'),
      },
      async ({ name, reference }) => call(BOT_SKILL_RPC.read, { ...(name ? { name } : {}), ...(reference ? { reference } : {}) }),
    );
  },
});
