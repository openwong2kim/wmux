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
import { getBotSkillStore, type BotSkillStore } from './botSkills';
import { getSecretStore, type DeletedKey, type SecretStore } from './secretStore';
import type { SkillIndexEntry } from '../../shared/botSkill';
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
  /** The bot skills store (default: the running one). */
  skills?: () => Partial<Pick<BotSkillStore, 'index' | 'archivedNames' | 'approvalStatus'>> | null;
  /** The bot key store (default: the running one). */
  secrets?: () => Pick<SecretStore, 'deletedFor'> | null;
  /** Cards of a room (a thread, or every thread), oldest first: the newest
   *  `limit`, or with `sinceSeq` the first `limit` after it. */
  cards: (workspaceId: string, threadId: ThreadId | null, limit: number, sinceSeq?: number) => readonly RoomCard[];
  /** One card by id, or by the poster's clientPostId. */
  findCard: (workspaceId: string, match: (c: RoomCard) => boolean) => RoomCard | null;
  /** The workspace's approval requests, newest first. */
  approvals?: (workspaceId: string) => ReadonlyArray<{
    action: string; prNumber?: number; issueNumber?: number; repoKey: string; state: string;
    skill?: { name: string; version: string; hash?: string };
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

/** Every letter of the text is a Latin-script one (and there is one). Pure. */
function latinScript(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length > 0 && letters.every((c) => /\p{Script=Latin}/u.test(c));
}

/** The UI language's name, for words whose script names no language: a UI
 *  in a language whose own script scriptLanguage names (Korean, Japanese,
 *  …) says nothing about Latin-script words, so null then. Pure. */
export function latinUiLanguage(locale: string): string | null {
  const code = locale.trim() || 'en';
  let native: string | undefined;
  try {
    native = new Intl.DisplayNames([code], { type: 'language' }).of(code);
  } catch {
    return null;
  }
  return native && !scriptLanguage(native) ? localeLanguageName(code) : null;
}

function ownerText(c: RoomCard): string {
  return (c.body?.trim() ? c.body : c.title).trim();
}

function isOwnerCard(c: RoomCard): boolean {
  return c.kind === 'human' && c.actor.kind === 'human';
}

/** The language the bot writes in for this wake. Pure over its ports.
 *  The owner's latest words to the bot in the wake's thread, else their
 *  latest words to anyone there, else (in a plan or request thread another
 *  bot started) to
 *  that bot, else to this bot in the room, else their latest message to
 *  anyone in the room (a bot added
 *  after the owner wrote follows the owner too), else the UI language. A
 *  wake on the owner's message carries a sample of its words; any other wake
 *  only when the script does not name the language, marked as a sample
 *  (earlier words must not read as a request for this wake). Words whose
 *  script names no language (Latin) take the UI language's name when it
 *  could be theirs (latinUiLanguage); the owner's script always wins. */
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
      const threadCards = item.threadId ? ports.cards(item.workspaceId, item.threadId, WAKE_CONTEXT_LIMITS.SCAN) : [];
      const inThread = pick(threadCards, addressed) ?? pick(threadCards, () => true);
      // A plan or request thread another bot started (a coordinator's): the
      // owner reads it as their talk with that bot, so its words to that bot
      // set the language. Its starter is known only when the whole thread
      // was read.
      const root = /^(?:plan|handoff):/.test(item.threadId ?? '') && threadCards.length < WAKE_CONTEXT_LIMITS.SCAN ? threadCards[0]?.actor : undefined;
      const lead = root?.kind === 'bot' && root.botId !== profile.id ? root.botId : null;
      const toLead = (c: RoomCard): boolean => !!lead && (c.refs?.botId === lead || (c.refs?.botIds ?? []).includes(lead));
      const room = inThread ? [] : ports.cards(item.workspaceId, null, WAKE_CONTEXT_LIMITS.SCAN);
      const latest = inThread ?? pick(room, toLead) ?? pick(room, addressed) ?? pick(room, () => true);
      said = latest ? ownerText(latest) : null;
    } catch {
      said = null;
    }
  }
  if (said && said.trim()) {
    const script = scriptLanguage(said);
    const locale = script ? undefined : ports.uiLocale?.();
    const name = script ?? (locale && latinScript(said) ? latinUiLanguage(locale) : null);
    const sample = human || !script ? said.replace(/\s+/g, ' ').trim().slice(0, WAKE_CONTEXT_LIMITS.SAMPLE_MAX) : undefined;
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
  skill: 'Load the skill',
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
      const subject = r.skill ? `${r.skill.name} ${r.skill.version}` : r.prNumber !== undefined ? `PR #${r.prNumber}` : r.issueNumber !== undefined ? `issue #${r.issueNumber}` : r.repoKey;
      const skill = r.action === 'skill' && r.state === 'approved' && r.skill ? approvedSkillStatus(ports, r.botId, r.skill) : undefined;
      return {
        what: `${ACTION_WORDS[r.action] ?? r.action} ${subject}`,
        state: r.state,
        action: r.action,
        askedBy: r.botId === profile.id ? 'you' : ports.botName(r.botId) ?? r.botId,
        at: r.updatedAt,
        ...(r.refusal ? { refusal: r.refusal } : {}),
        ...(skill ? { skill } : {}),
      };
    });
}

/** Where the skill an approved `skill` request loaded stands now (by its
 *  content hash): undefined when the store cannot tell. */
function approvedSkillStatus(ports: WakeContextPorts, botId: string, skill: { name: string; hash?: string }): WakeApprovalSummary['skill'] {
  if (!skill.hash) return undefined;
  try {
    return (ports.skills ?? getBotSkillStore)()?.approvalStatus?.(botId, skill.name, skill.hash) ?? undefined;
  } catch {
    return undefined;
  }
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
    skills: wakeSkills(ports, profile),
    archivedSkills: wakeArchivedSkills(ports, profile),
    deletedKeys: wakeDeletedKeys(ports, profile),
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

/** The bot's approved skills (name and description) for its wake; a
 *  proposal waiting for the owner is never listed. */
export function wakeSkills(ports: WakeContextPorts, profile: BotProfile): SkillIndexEntry[] {
  try {
    return (ports.skills ?? getBotSkillStore)()?.index?.(profile.id) ?? [];
  } catch {
    return [];
  }
}

/** The keys the owner deleted that the bot asked for or last used, for its
 *  wake: names only. */
export function wakeDeletedKeys(ports: WakeContextPorts, profile: BotProfile): DeletedKey[] {
  try {
    return (ports.secrets ?? getSecretStore)()?.deletedFor(profile.id) ?? [];
  } catch {
    return [];
  }
}

/** The skills the owner archived after approving them, for its wake. */
export function wakeArchivedSkills(ports: WakeContextPorts, profile: BotProfile): string[] {
  try {
    return (ports.skills ?? getBotSkillStore)()?.archivedNames?.(profile.id) ?? [];
  } catch {
    return [];
  }
}
