// memory_update — a bot's own notes and the owner's profile
// (shared/botMemory.ts), registered with registerToolModule
// (src/mcp/toolModules.ts). Every call carries the bot's token; main takes
// the bot from its binding and decides from its running wake whether it may
// write, so the tool names no bot and no file.

import { z } from 'zod';
import { BOT_MEMORY_RPC, MEMORY_ACTIONS, MEMORY_LIMITS, MEMORY_TARGETS } from '../shared/botMemory';
import { registerToolModule } from './toolModules';

registerToolModule({
  name: 'bot-memory',
  tools: ['memory_update'],
  register(host, deps) {
    host.tool(
      'memory_update',
      'Keep a short note for your later sessions. target "memory": your own notes (a non-obvious environment fact, a convention '
        + `the owner wants, a lesson), ${MEMORY_LIMITS.MEMORY_CHARS} characters in all. target "user": the owner (who they are, their `
        + `preferences), shared by all their bots, ${MEMORY_LIMITS.USER_CHARS} characters, only in a turn the owner started. `
        + 'Both load when a session starts: a change applies from your next session. add saves an entry; replace and remove '
        + 'take the one entry holding match. Over the limit it is refused with the entries: remove or merge some first. '
        + 'Not for task progress, what the repository says, or secrets. The owner sees and can clear both.',
      {
        target: z.enum(MEMORY_TARGETS).describe('memory: your own notes. user: the owner\'s profile.'),
        action: z.enum(MEMORY_ACTIONS),
        text: z.string().min(1).max(MEMORY_LIMITS.MEMORY_CHARS).optional()
          .describe('add, replace: the entry, one fact or preference in a sentence or two, in your own words.'),
        match: z.string().min(1).max(MEMORY_LIMITS.MATCH_MAX).optional()
          .describe('replace, remove: a piece of the entry\'s text that no other entry holds.'),
      },
      async ({ target, action, text, match }) => ({
        ...(await deps.callRpc(BOT_MEMORY_RPC.update, { target, action, ...(text !== undefined ? { text } : {}), ...(match !== undefined ? { match } : {}) })),
      }),
    );
  },
});
