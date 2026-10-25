// A bot's open prompt (a question, a login request, a secret request), as a
// push to the phone, and the retraction once its card closes. Main pushes the
// table of open prompts (shared/botPromptPush.ts).
//
// Like a bot approval it never sets `approvalId`, and the body is built from
// structured fields only: the bot's display name, the kind of prompt, the
// login service, the secret's name. The question's words and a website's URL
// are the bot's to choose, so they stay on the card in the app.

import type { PushPayload } from '../../shared/push/pushEnvelope';
import { BOT_PROMPT_PUSH_CAPABILITY, type BotPromptPushRow } from '../../shared/botPromptPush';
import { APPROVAL_RETRACTION_KIND } from './approvalPushPayload';
import { PushTableRouter, type PushTableRouterDeps } from './pushTableRouter';

/** The bot has no name the daemon was told. */
const BOT_NAME_FALLBACK = 'A bot';

const LOGIN_NAMES = { github: 'GitHub', claude: 'Claude' } as const;

function summary(row: BotPromptPushRow): string {
  switch (row.promptKind) {
    case 'question':
      return 'Has a question for you';
    case 'login_request':
      return row.loginService && row.loginService !== 'website'
        ? `Asks you to sign in to ${LOGIN_NAMES[row.loginService]}`
        : 'Asks you to log in to a website';
    case 'secret_request':
      // parseBotPromptPushRows drops a secret_request row without a name.
      return `Asks for the secret ${row.secretName}`;
  }
}

export function buildBotPromptPushPayload(row: BotPromptPushRow): PushPayload {
  return {
    title: `${row.botName ?? BOT_NAME_FALLBACK} needs you`,
    body: summary(row),
    approvalKind: 'bot_prompt',
    promptKind: row.promptKind,
    botPromptId: row.cardId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    botId: row.botId,
    // Answered on the card in the app, never from the lock screen.
    requiresInAppChoice: true,
  };
}

/** One banner per card. Card ids are at most 54 characters. */
export function botPromptPushCollapseId(cardId: string): string {
  return `botprompt-${cardId}`.slice(0, 64);
}

/** Replaces the card's banner once it closes; no id the extension would act on. */
export function buildBotPromptRetractionPayload(cardId: string): PushPayload {
  return {
    title: 'Answered',
    body: 'No longer waiting — nothing to do.',
    kind: APPROVAL_RETRACTION_KIND,
    retractsBotPromptId: cardId,
  };
}

export const BOT_PROMPT_PARK_PREFIX = 'botprompt:';

/** Main's table of open bot prompts, as pushes and retractions. */
export class BotPromptPushRouter extends PushTableRouter<BotPromptPushRow> {
  constructor(deps: PushTableRouterDeps) {
    super({
      parkPrefix: BOT_PROMPT_PARK_PREFIX,
      requires: BOT_PROMPT_PUSH_CAPABILITY,
      noun: 'bot prompt',
      idOf: (row) => row.cardId,
      build: buildBotPromptPushPayload,
      collapseId: botPromptPushCollapseId,
      retraction: buildBotPromptRetractionPayload,
    }, deps);
  }
}
