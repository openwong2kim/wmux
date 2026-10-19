// job_set — the bot tool over `bot.setJob` (shared/bot.ts BOT_RPC). Registered
// with registerToolModule (src/mcp/toolModules.ts). The bot token on the call
// is the identity: main sets the calling bot's own job, and only while it
// runs a wake on the owner's own words (their message, or their answer to its
// question), so the tool sends no bot id.

import { z } from 'zod';
import { BOT_JOB_MAX, BOT_RPC } from '../shared/bot';
import { registerToolModule } from './toolModules';

registerToolModule({
  name: 'bot-job',
  tools: ['job_set'],
  register(host, deps) {
    host.tool(
      'job_set',
      'Set your own job when the owner gives you one in their own words (this wake must be the owner\'s message or their answer to your question). '
        + 'The job becomes part of your instructions from your next wake; the room shows the change and the owner can undo it. '
        + 'Pass job: null to clear it.',
      {
        job: z.string().min(1).max(BOT_JOB_MAX).nullable()
          .describe('Your job in a few sentences: what you do, for whom, and what you produce. The owner reads it: write it in their language, in plain words, with no tool names or ids.'),
      },
      async ({ job }) => ({ ...(await deps.callRpc(BOT_RPC.setJob, { job })) }),
    );
  },
});
