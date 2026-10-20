// room_post / room_read / room_search / handoff_send / ask_person / question_close — the
// bot tools over `room.*`, `handoff.send`, `ask.person` and
// `bot.questionClose` (shared/room.ts, shared/handoff.ts, shared/bot.ts), registered with registerToolModule
// (src/mcp/toolModules.ts). Every call carries the bot's token; main takes
// the workspace, the actor and the addressee from the bot's binding, so no
// tool sends who the bot is.

import { z } from 'zod';
import { BOT_ID_RE, BOT_RPC } from '../shared/bot';
import { BOT_POSTABLE_CARD_KINDS, ROOM_LIMITS, ROOM_RPC } from '../shared/room';
import { ASK_PERSON_RPC, HANDOFF_LIMITS, HANDOFF_RPC } from '../shared/handoff';
import { ROOM_FILE_LIMITS } from '../shared/roomFiles';
import { registerToolModule } from './toolModules';

const THREAD_ID = z
  .string()
  .min(1)
  .max(240)
  .describe('Room thread: "general", "pr:<repo>#<n>", "issue:<repo>#<n>", "task:<taskId>", "handoff:<id>", "plan:<id>" or "report:<id>".');

const REFS = z
  .object({
    pr: z.number().int().positive().optional(),
    issue: z.number().int().positive().optional(),
    headSha: z.string().regex(/^[0-9a-fA-F]{7,64}$/).optional(),
    taskId: z.string().min(1).max(200).optional(),
    url: z.string().url().max(500).optional(),
  })
  .optional()
  .describe('What the card or handoff points at.');

const TITLE = z.string().min(1).max(ROOM_LIMITS.TITLE_MAX);

const BOT_ID = z.string().regex(BOT_ID_RE);

/** The question card's choices (main caps them the same way: the decision
 *  store's DECISION_LIMITS, which the bundle does not import). */
const ASK_OPTIONS_MAX = 6;
const ASK_OPTION_CHARS = 200;
const BODY = z.string().max(ROOM_LIMITS.CARD_BODY_MAX);

/** The snake_case tool args → the RPC params, dropping what was not given. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

registerToolModule({
  name: 'factory-rooms',
  tools: ['room_post', 'room_read', 'room_search', 'handoff_send', 'ask_person', 'question_close'],
  register(host, deps) {
    // A fresh object literal: the SDK's result type has an index signature.
    const call = async (method: Parameters<typeof deps.callRpc>[0], params: Record<string, unknown>) => ({
      ...(await deps.callRpc(method, compact(params))),
    });
    host.tool(
      'room_post',
      'Post one typed card into your workspace\'s room — the record the owner and the other bots read. '
        + `kind is your output: ${BOT_POSTABLE_CARD_KINDS.join(', ')}. It lands in the thread you were woken for `
        + 'unless you name another. To speak to other bots, put their bot ids (bot_list) in mentions: each is woken once '
        + 'with your card. A name in the text notifies nobody. To hand the owner files you made (a report, a spec, a diff), '
        + 'list their paths in files: wmux copies each onto the card, and the owner opens it from there. Returns the card with its id and seq (duplicate: true when '
        + 'this turn already posted it) and, per mention, whether it was delivered.',
      {
        kind: z.enum(BOT_POSTABLE_CARD_KINDS as unknown as [string, ...string[]]).describe('The card kind.'),
        title: TITLE.describe('One line: what this card says.'),
        body: BODY.optional().describe('Markdown details.'),
        thread_id: THREAD_ID.optional(),
        reply_to: z.string().min(1).max(64).optional().describe('A card id of the same thread this card answers.'),
        refs: REFS,
        mentions: z.array(BOT_ID).max(ROOM_LIMITS.MENTIONS_MAX).optional()
          .describe('Bot ids this card speaks to (any workspace, never yourself); each is woken once.'),
        files: z.array(z.string().min(1).max(4096)).max(ROOM_FILE_LIMITS.PER_CARD).optional()
          .describe(`Up to ${ROOM_FILE_LIMITS.PER_CARD} files you made, each at most ${ROOM_FILE_LIMITS.MAX_BYTES / (1024 * 1024)} MiB: absolute paths inside your repository, one of your task folders or your bot folder, or paths relative to your repository. One file that cannot be taken refuses the whole post, saying why.`),
      },
      async ({ kind, title, body, thread_id, reply_to, refs, mentions, files }) =>
        call(ROOM_RPC.post, { kind, title, body, threadId: thread_id, replyTo: reply_to, refs, mentions, files }),
    );

    host.tool(
      'room_read',
      'Read cards from your workspace\'s room in arrival order: every thread (the default), or one thread_id '
        + '("general" is the general thread only). Without since_seq you get the newest page; pass back nextSinceSeq '
        + 'to read what came after, hasMore says there is more. The HQ bot may read another workspace\'s room. '
        + 'Cards an external guest agent wrote (and cards written in a turn one started) are left out; include_guest returns '
        + 'them only in a turn an external guest\'s message started, and is refused in any other.',
      {
        thread_id: THREAD_ID.optional(),
        since_seq: z.number().int().min(0).optional().describe('Cards after this seq.'),
        limit: z.number().int().min(1).max(ROOM_LIMITS.PAGE).optional(),
        workspace_id: z.string().min(1).max(80).optional().describe('HQ bot: another workspace\'s room.'),
        include_guest: z.boolean().optional().describe('Also return external guest agents\' cards: only in a turn a guest\'s message started.'),
      },
      async ({ thread_id, since_seq, limit, workspace_id, include_guest }) =>
        call(ROOM_RPC.read, { threadId: thread_id, sinceSeq: since_seq, limit, workspaceId: workspace_id, ...(include_guest === true ? { includeGuest: true } : {}) }),
    );

    host.tool(
      'room_search',
      'Search your workspace\'s room for earlier cards by words: a card matches when its title or body holds every '
        + 'term (case-insensitive). Search before asking the owner to repeat something. Hits come newest first with seq, '
        + 'threadId, actor, time and a snippet; pass nextBefore back as before for older hits. To read around a hit, '
        + 'room_read its thread_id with since_seq a few below its seq. External guest agents\' cards are left out.',
      {
        query: z.string().min(1).max(ROOM_LIMITS.SEARCH_QUERY_MAX).describe('Words to find, separated by spaces.'),
        before: z.number().int().min(1).optional().describe('Only cards with a seq below this.'),
        limit: z.number().int().min(1).max(ROOM_LIMITS.SEARCH_MAX).optional().describe(`Default ${ROOM_LIMITS.SEARCH_DEFAULT}.`),
      },
      async ({ query, before, limit }) => call(ROOM_RPC.search, { query, before, limit }),
    );

    host.tool(
      'handoff_send',
      'Hand work or a message to another bot; wmux wakes it with your handoff. '
        + 'message: to to_bot_id, any bot in any workspace. dispatch: to to_bot_id, else the lead of to_workspace_id (default your workspace). '
        + 'result / refusal: to the sender of reply_to — pass the handoff id you were woken with; one result per handoff — or, without reply_to, to your workspace lead. '
        + 'It stays in the thread of the handoff it answers, else the thread you were woken for. '
        + 'Coordinator: next on a dispatch names the bots that take the work after to_bot_id, in order; wmux passes each result on and wakes you with the last. '
        + 'Returns the handoff id and the addressee, or a refusal with its reason (chain depth, hops per run, no addressee).',
      {
        kind: z.enum(['dispatch', 'result', 'refusal', 'message']),
        title: TITLE.describe('One line: the work or the outcome.'),
        body: BODY.describe('What the addressee needs to act.'),
        to_bot_id: BOT_ID.optional().describe('The bot to wake (bot_list); required for a message.'),
        to_workspace_id: z.string().min(1).max(80).optional(),
        reply_to: z.string().min(1).max(100).optional().describe('The handoff this answers.'),
        thread_id: THREAD_ID.optional(),
        refs: REFS,
        next: z.array(BOT_ID).min(1).max(HANDOFF_LIMITS.MAX_RELAY).optional().describe('Dispatch, coordinator only: the bots that follow, in order.'),
      },
      async ({ kind, title, body, to_bot_id, to_workspace_id, reply_to, thread_id, refs, next }) =>
        call(HANDOFF_RPC.send, { kind, title, body, toBotId: to_bot_id, toWorkspaceId: to_workspace_id, replyTo: reply_to, threadId: thread_id, refs, next }),
    );

    host.tool(
      'ask_person',
      'Ask the owner a question. It lands as a question card in your room (and on their phone) and you are woken '
        + 'with the answer when they reply; end your turn after asking. Give options when the answer is a choice. '
        + 'A thread holds one open question: a new question of yours there replaces your open one; another bot\'s waits until '
        + 'the first is answered. Your open question closes by itself when the owner answers it in chat or gives you a job.',
      {
        title: TITLE.describe('The question, in one line.'),
        body: BODY.optional().describe('What is at stake, what you already know.'),
        options: z.array(z.string().min(1).max(ASK_OPTION_CHARS)).max(ASK_OPTIONS_MAX).optional(),
        thread_id: THREAD_ID.optional().describe('Default: the thread you were woken for, else a thread of its own.'),
        refs: REFS,
      },
      async ({ title, body, options, thread_id, refs }) =>
        call(ASK_PERSON_RPC, { title, body, options, threadId: thread_id, refs }),
    );

    host.tool(
      'question_close',
      'Close one of your own open question cards when it no longer needs an answer (the owner answered it in chat, '
        + 'the work it was about is done or changed). Nobody is woken. Refused for a card that is not your open question.',
      {
        card_id: z.string().min(1).max(64).describe('The question card\'s id (room_read).'),
      },
      async ({ card_id }) => call(BOT_RPC.questionClose, { cardId: card_id }),
    );
  },
});
