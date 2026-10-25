// Main's half of pushing a bot's open prompts to the phone: the open
// question / login_request / secret_request cards bots wrote, sent to the
// daemon over `daemon.botPrompts.set` whenever a room card of those kinds is
// written or closed, when the rooms start, and on every daemon connect
// (shared/botPromptPush.ts, daemon/push/botPromptPush.ts).

import type { CardKind, RoomCard } from '../../shared/room';
import { BOT_PROMPT_KINDS, parseBotPromptPushRows, type BotPromptPushRow } from '../../shared/botPromptPush';
import { createPushTableFeed, type PushTableFeed } from './pushTableFeed';
import type { RoomWriter } from '../factory/roomWriter';
import type { BotDirectoryApi } from '../factory/botStore';

export const BOT_PROMPT_CARD_KINDS: ReadonlySet<CardKind> = new Set<CardKind>(BOT_PROMPT_KINDS);

/** The open prompt cards among `cards` that a bot wrote, as push rows: the
 *  card's ids, kind and structured refs only, never its words. */
export function botPromptPushRows(
  cards: readonly RoomCard[],
  botName: (botId: string) => string | undefined,
): BotPromptPushRow[] {
  const raw = cards
    .filter((c) => c.state === 'open' && BOT_PROMPT_CARD_KINDS.has(c.kind) && c.actor.kind === 'bot')
    .map((c) => {
      const botId = c.actor.kind === 'bot' ? c.actor.botId : '';
      return {
        cardId: c.id,
        promptKind: c.kind,
        workspaceId: c.workspaceId,
        threadId: c.threadId,
        botId,
        botName: botName(botId),
        // The login service rides in refs.label, written by main only:
        // botLogin.request sets it from its own service enum (and takes a URL
        // for `website` alone), and a bot's room_post cannot write a
        // login_request card (BOT_POSTABLE_CARD_KINDS).
        ...(c.kind === 'secret_request' ? { secretName: c.refs?.secretName } : {}),
        ...(c.kind === 'login_request' ? { loginService: c.refs?.label } : {}),
      };
    });
  return parseBotPromptPushRows(raw) ?? [];
}

/** The open prompts of the owner's enabled bots, each in its own
 *  workspace's room: `listEnabled` leaves a guest workspace's bots out, as
 *  the phone's bot list does, and a disabled or removed bot's card is not
 *  pushed though another bot of its workspace is on. Null while the rooms or
 *  the bots are not running (not started yet, or stopping on quit): not
 *  known, so nothing is sent. */
export function openBotPromptRows(
  writer: Pick<RoomWriter, 'openCards'> | null,
  bots: Pick<BotDirectoryApi, 'listEnabled' | 'get'> | null,
): BotPromptPushRow[] | null {
  if (!writer || !bots) return null;
  const enabled = new Map<string, Set<string>>();
  for (const b of bots.listEnabled()) {
    const ids = enabled.get(b.workspaceId) ?? new Set<string>();
    ids.add(b.id);
    enabled.set(b.workspaceId, ids);
  }
  const cards = [...enabled].flatMap(([ws, ids]) => writer.openCards(ws, BOT_PROMPT_CARD_KINDS)
    .filter((c) => c.actor.kind === 'bot' && ids.has(c.actor.botId)));
  return botPromptPushRows(cards, (botId) => bots.get(botId)?.name);
}

export function createBotPromptPushFeed(deps: { rows: () => BotPromptPushRow[] | null; push: (rows: BotPromptPushRow[]) => Promise<unknown> }): PushTableFeed {
  return createPushTableFeed(deps);
}

let feed: PushTableFeed | null = null;

/** Wired once by index.ts; null in tests and before it runs. */
export function setBotPromptPushFeed(next: PushTableFeed | null): void {
  feed = next;
}

/** The bots changed (one turned on or off, added or removed, or the bot
 *  store started): a card can enter or leave the table with no card event. */
export function noteBotSetChanged(): void {
  feed?.schedule();
}

/** A room card was written or changed: republish when it is a prompt. */
export function noteRoomCardChanged(card?: Pick<RoomCard, 'kind'>): void {
  if (!card || BOT_PROMPT_CARD_KINDS.has(card.kind)) feed?.schedule();
}
