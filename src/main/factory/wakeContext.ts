// ─── Wake context — what a wake prompt says about the room right now ───────
//
// Beside why a bot was woken, its wake prompt (wakePrompt.ts) carries what it
// would otherwise get wrong from the room's history:
//
//   approvals   the workspace's approval requests as they stand now (asked,
//               approved, merged, denied), so no bot asks the owner to
//               approve what is already merged;
//   replies     on a message the owner sent to the whole room, what the other
//               bots already answered to it (bounded), so the bots talk to
//               each other instead of answering in parallel;
//   language    the owner's latest message's language (its script, and, in
//               a wake on that message, its words for the model to match),
//               else the app's UI language before the owner has written;
//   clock       the owner's time zone and local time, so times in bot text
//               are the owner's, never UTC;
//   group       in a group chat's thread, the group (its name and members,
//               the roster the wake shows) and whether the bot has spoken
//               there before (a bot introduces itself the first time).
//
// Every read is best effort: what cannot be read is left out.

import { getConnectorStore, type ConnectorStore } from './connectorStore';
import type { BotProfile } from '../../shared/bot';
import type { RoomCard, ThreadId } from '../../shared/room';
import type { WakeItem } from '../../shared/wake';
import type { BotGroup } from '../../shared/botGroup';
import type { WakeApprovalSummary, WakeClock, WakeConnectorSummary, WakeGroup, WakeLanguage, WakePromptInput, WakeRunReply } from './wakePrompt';

export const WAKE_CONTEXT_LIMITS = {
  /** Approval requests a wake lists. */
  APPROVALS: 8,
  /** Settled requests older than this are left out (pending ones never). */
  APPROVAL_WINDOW_MS: 24 * 3_600_000,
  REPLIES: 8,
  REPLY_BODY_MAX: 600,
  SAMPLE_MAX: 60,
  /** Room cards scanned for the owner's latest message. */
  SCAN: 200,
} as const;

/** What wakeContext reads. */
export interface WakeContextPorts {
  /** The connection library (default: the running one). */
  connectors?: () => Pick<ConnectorStore, 'forBot'> | null;
  /** Cards of a room (a thread, or every thread), oldest first: the newest
   *  `limit`, or with `sinceSeq` the first `limit` after it. */
  cards: (workspaceId: string, threadId: ThreadId | null, limit: number, sinceSeq?: number) => readonly RoomCard[];
  /** One card by id, or by the poster's clientPostId. */
  findCard: (workspaceId: string, match: (c: RoomCard) => boolean) => RoomCard | null;
  /** The workspace's approval requests, newest first. */
  approvals?: (workspaceId: string) => ReadonlyArray<{
    action: string; prNumber?: number; issueNumber?: number; repoKey: string; state: string;
    botId: string; createdAt: number; updatedAt: number; refusal?: string;
  }>;
  botName: (botId: string) => string | null;
  /** The app's UI locale (e.g. "ko", "en", "zh-TW"). */
  uiLocale?: () => string;
  /** The live group chat a thread of a room is (groupStore.ts). */
  group?: (workspaceId: string, threadId: ThreadId) => BotGroup | null;
  /** The owner's IANA time zone. */
  timeZone?: () => string;
  now?: () => number;
}

const SCRIPTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[가-힣ᄀ-ᇿ㄰-㆏]/u, 'Korean'],
  [/[぀-ヿ]/u, 'Japanese'],
  [/[一-鿿]/u, 'Chinese'],
  [/[Ѐ-ӿ]/u, 'Russian or another Cyrillic language'],
  [/[؀-ۿ]/u, 'Arabic'],
  [/[฀-๿]/u, 'Thai'],
  [/[ऀ-ॿ]/u, 'Hindi'],
  [/[֐-׿]/u, 'Hebrew'],
];

/** The language a text is written in when its script says so (Hangul is
 *  Korean even beside Chinese characters; kana is Japanese), else null (a
 *  Latin-script text could be any of many). Pure. */
export function scriptLanguage(text: string): string | null {
  for (const [re, name] of SCRIPTS) if (re.test(text)) return name;
  return null;
}

/** A UI locale code as a language name ("ko" → "Korean"). Pure. */
export function localeLanguageName(locale: string): string {
  const code = locale.trim() || 'en';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    if (name) return name;
  } catch {
    /* an unknown code */
  }
  return code;
}

function ownerText(c: RoomCard): string {
  return (c.body?.trim() ? c.body : c.title).trim();
}

function isOwnerCard(c: RoomCard): boolean {
  return c.kind === 'human' && c.actor.kind === 'human';
}

/** The language the bot writes in for this wake. Pure over its ports.
 *  The owner's latest words to the bot (in the wake's thread, else in the
 *  room), else their latest message to anyone in the room (a bot added
 *  after the owner wrote follows the owner too), else the UI language. A
 *  wake on the owner's message carries a sample of its words; any other wake
 *  only when the script does not name the language, marked as a sample
 *  (earlier words must not read as a request for this wake). */
export function wakeLanguage(ports: WakeContextPorts, profile: BotProfile, item: WakeItem): WakeLanguage | null {
  const human = item.reason.kind === 'human' ? item.reason.text : null;
  let said: string | null = human;
  if (!said) {
    const addressed = (c: RoomCard): boolean => {
      const to = [c.refs?.botId, ...(c.refs?.botIds ?? [])];
      return to.includes(profile.id) || to.every((x) => x === undefined);
    };
    const pick = (cards: readonly RoomCard[], match: (c: RoomCard) => boolean): RoomCard | undefined => [...cards].reverse().find((c) => isOwnerCard(c) && match(c));
    try {
      const inThread = item.threadId ? pick(ports.cards(item.workspaceId, item.threadId, WAKE_CONTEXT_LIMITS.SCAN), addressed) : undefined;
      const room = inThread ? [] : ports.cards(item.workspaceId, null, WAKE_CONTEXT_LIMITS.SCAN);
      const latest = inThread ?? pick(room, addressed) ?? pick(room, () => true);
      said = latest ? ownerText(latest) : null;
    } catch {
      said = null;
    }
  }
  if (said && said.trim()) {
    const name = scriptLanguage(said);
    const sample = human || !name ? said.replace(/\s+/g, ' ').trim().slice(0, WAKE_CONTEXT_LIMITS.SAMPLE_MAX) : undefined;
    return { name, source: 'owner', ...(sample ? { sample } : {}), ...(human ? {} : { earlier: true as const }) };
  }
  const locale = ports.uiLocale?.();
  return locale ? { name: localeLanguageName(locale), source: 'ui' } : null;
}

/** The owner's clock now, or null when the zone cannot be read. Pure. */
export function wakeClock(now: number, timeZone: string | undefined): WakeClock | null {
  try {
    const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
    }).formatToParts(new Date(now));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    return { timeZone: zone, local: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`, weekday: get('weekday') };
  } catch {
    return null;
  }
}

const ACTION_WORDS: Readonly<Record<string, string>> = {
  merge: 'Merge',
  push_default: 'Push to the default branch of',
  issue_create: 'Open an issue on',
  issue_close: 'Close',
  comment: 'Comment on',
  release: 'Publish a release of',
};

/** The approval requests a wake shows: pending and approved ones, and the
 *  ones settled within the window, newest change first. Pure. */
export function wakeApprovals(ports: WakeContextPorts, profile: BotProfile, now: number): WakeApprovalSummary[] {
  let rows: ReturnType<NonNullable<WakeContextPorts['approvals']>> = [];
  try {
    rows = ports.approvals?.(profile.workspaceId) ?? [];
  } catch {
    rows = [];
  }
  return rows
    .filter((r) => r.state === 'pending' || r.state === 'approved' || now - r.updatedAt <= WAKE_CONTEXT_LIMITS.APPROVAL_WINDOW_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, WAKE_CONTEXT_LIMITS.APPROVALS)
    .map((r) => {
      const subject = r.prNumber !== undefined ? `PR #${r.prNumber}` : r.issueNumber !== undefined ? `issue #${r.issueNumber}` : r.repoKey;
      return {
        what: `${ACTION_WORDS[r.action] ?? r.action} ${subject}`,
        state: r.state,
        askedBy: r.botId === profile.id ? 'you' : ports.botName(r.botId) ?? r.botId,
        at: r.updatedAt,
        ...(r.refusal ? { refusal: r.refusal } : {}),
      };
    });
}

/** On an owner message to the whole room: the other bots' cards posted
 *  after it in its thread, oldest first (bounded). Pure. */
export function wakeRunReplies(ports: WakeContextPorts, profile: BotProfile, item: WakeItem): WakeRunReply[] {
  const r = item.reason;
  if (r.kind !== 'human' || !r.room || !r.clientMessageId || !item.threadId) return [];
  const id = r.clientMessageId;
  try {
    const message = ports.findCard(item.workspaceId, (c) => isOwnerCard(c) && (c.clientPostId === id || c.id === id));
    if (!message) return [];
    return ports.cards(item.workspaceId, message.threadId, WAKE_CONTEXT_LIMITS.SCAN, message.seq)
      .filter((c) => c.seq > message.seq && c.actor.kind === 'bot' && c.actor.botId !== profile.id)
      .slice(0, WAKE_CONTEXT_LIMITS.REPLIES)
      .map((c) => ({
        name: (c.actor.kind === 'bot' ? ports.botName(c.actor.botId) : null) ?? 'a bot',
        ...(c.refs?.botIds?.includes(profile.id) ? { toYou: true as const } : {}),
        kind: c.kind,
        title: c.title,
        ...(c.body ? { body: c.body.slice(0, WAKE_CONTEXT_LIMITS.REPLY_BODY_MAX) } : {}),
      }));
  } catch {
    return [];
  }
}

/** Everything wakeContext adds to one wake prompt. */
export function wakeContext(ports: WakeContextPorts, profile: BotProfile, item: WakeItem): Partial<WakePromptInput> {
  const now = (ports.now ?? Date.now)();
  return {
    approvals: wakeApprovals(ports, profile, now),
    runReplies: wakeRunReplies(ports, profile, item),
    language: wakeLanguage(ports, profile, item),
    clock: wakeClock(now, ports.timeZone?.()),
    connectors: wakeConnectors(ports, profile),
    group: wakeGroup(ports, profile, item),
    now,
  };
}

/** The group chat the wake's thread is, or null: its name, its members and
 *  whether the bot has posted there before (searched over the whole room,
 *  so an early introduction is not missed). */
export function wakeGroup(ports: WakeContextPorts, profile: BotProfile, item: WakeItem): WakeGroup | null {
  const threadId = item.threadId;
  if (!threadId || !ports.group) return null;
  try {
    const g = ports.group(item.workspaceId, threadId);
    if (!g) return null;
    const spoke = ports.findCard(item.workspaceId, (c) => c.threadId === threadId && c.actor.kind === 'bot' && c.actor.botId === profile.id) !== null;
    return { name: g.name, memberIds: [...g.memberIds], spoke };
  } catch {
    return null;
  }
}

/** The connections this bot's workers may use (connectorsForBot): names and
 *  the owner's purpose, never a key or a command. */
export function wakeConnectors(ports: WakeContextPorts, profile: BotProfile): WakeConnectorSummary[] {
  try {
    const lib = (ports.connectors ?? getConnectorStore)();
    return (lib?.forBot(profile.id) ?? []).map((c) => ({ name: c.name, ...(c.purpose ? { purpose: c.purpose } : {}) }));
  } catch {
    return [];
  }
}
