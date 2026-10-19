// ─── Room writer — per-workspace timelines of typed cards ──────────────────
//
// One room per workspace, `<wmuxDir>/factory/rooms/<workspaceId>.jsonl`, one
// RoomCard per line (shared/room.ts). Main is the only writer:
//
// - bots post their typed outputs (BOT_POSTABLE_CARD_KINDS) through room.post;
// - the owner posts `human` cards through the operator lane (renderer, later
//   the phone), which also become a `human.message` fact addressed to one bot;
// - main writes system cards from facts (handoff sent / refused / answered,
//   task done / failed / input_required, verdict recorded, merge done /
//   refused, bot refused / budget exhausted / error) and from interrupted
//   wakes, and the handoff router writes `question` cards for ask_person.
//
// A card is appended once; a state change (a question answered, a proposal
// resolved) appends the same card again with the same id and seq and the new
// state, and the last line of an id wins on load. Readers that page by seq see
// the change through the system card that comes with it (the answer fact).
//
// Retention: on load, cards older than ROOM_LIMITS.RETAIN_DAYS are dropped
// unless they are still open, and a room keeps at most
// ROOM_STORE_LIMITS.MAX_CARDS cards (oldest closed ones go first). The file is
// rewritten (atomically) when it holds that many superseded or expired lines.
//
// Every new or changed card is pushed to the renderer as ROOM_EVENT with its
// thread's summary.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicReadJSONSync, atomicWriteJSONSync, atomicWriteTextSync } from '../../daemon/util/atomicWrite';
import { BOT_ID_RE, normalizeBotJob, type BotProfile } from '../../shared/bot';
import { isBotSecretName } from '../../shared/botSecret';
import type { Fact, FactDraft, FactRef } from '../../shared/facts';
import type { Party } from '../../shared/handoff';
import type { WakeReason } from '../../shared/wake';
import {
  GENERAL_THREAD,
  ROOM_LIMITS,
  dmThreadBot,
  groupThreadGroup,
  parseThreadId,
  issueThreadId,
  prThreadId,
  taskOriginThread,
  type CardKind,
  type CardNotice,
  type RoomCard,
  type ThreadId,
  type ThreadSummary,
} from '../../shared/room';
import { normalizeRepoKey } from './repoWatch';
import { formatLaneRefusal } from './laneRefusalText';
import { redactStoredSecrets, redactStoredSecretsDeep } from './secretRedaction';
import type { BotDirectoryApi, FactLogApi, WakeSinkApi } from './triggerEngine';
import type { BotGroup } from '../../shared/botGroup';
import { parseRoomAttachments } from '../../shared/roomAttachments';

export const ROOMS_DIRNAME = 'rooms';

export const ROOM_STORE_LIMITS = {
  /** Cards one room keeps (open cards are kept first). */
  MAX_CARDS: 5000,
  /** Superseded / expired lines tolerated before the file is rewritten. */
  COMPACT_SLACK: 1000,
  /** Fact ids remembered per room to drop a re-delivered fact. */
  SEEN_FACTS: 2000,
} as const;

const DAY_MS = 24 * 3600_000;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SHORT_STRING_MAX = 200;
const URL_MAX = 500;

export const CARD_KINDS: readonly CardKind[] = [
  'fact', 'dispatch', 'status', 'triage', 'verdict', 'report', 'plan', 'proposal', 'opinion',
  'question', 'human', 'refusal', 'budget',
  'approval', 'routine', 'secret_request', 'login_request', 'job_changed',
];

// ── Ports (design §14; resolved at module start, wired by the factory host) ─

/** The bot runtime's hook events this module reads (shape of BotRuntime's
 *  botHooks.ts `BotHookEvent`; `wake.interrupted` and `wake.held` are used here). */
export type RoomBotHookEvent =
  | { type: 'wake.interrupted'; botId: string; workspaceId: string; wakeId: string; threadId?: ThreadId; at: number }
  | { type: 'wake.held'; botId: string; workspaceId: string; wakeId: string; threadId?: ThreadId; until: number | null; at: number }
  | { type: string; botId?: string; workspaceId?: string; at?: number };

export interface FactoryRoomPorts {
  factLog: FactLogApi;
  wakes: WakeSinkApi;
  bots: BotDirectoryApi;
  /** BotRuntime's `onBotHook`. Missing: interrupted wakes write no card. */
  botHooks?: { subscribe(fn: (ev: RoomBotHookEvent) => void): () => void };
  /** The thread of the wake the bot is running now (WakeItem.threadId), or
   *  null. A post, handoff or question without a threadId lands there: main
   *  pins where a bot answers, not the model. Missing: `general` /
   *  the handoff's own thread. */
  currentWakeThread?: (botId: string) => ThreadId | null;
  /** The wake the bot is running now, or null: its id and attempt
   *  (1-based) derive the default idempotency keys, so a retried turn
   *  re-posts the same keys and writes nothing twice; `handoffId` is the
   *  handoff the wake delivers (WakeReason handoff), which a handoff sent
   *  from that turn continues (run, depth) even without a replyTo. */
  currentWake?: (botId: string) => RunningWake | null;
  /** The owner's group chats (groupStore.ts): the live group a thread of a
   *  room is. Missing: no group thread takes a post. */
  groups?: { byThread(workspaceId: string, threadId: ThreadId | null | undefined): BotGroup | null };
}

/** `handoffId`: the handoff the wake delivers (a handoff or a mention), or
 *  for a task wake the one its tasks were started for (every task of the
 *  wake, LedgerDispatch.handoffId); `runId`: the owner message's run (a human wake), so the handoffs the bot
 *  sends in that turn join it. */
export interface RunningWake {
  wakeId: string; attempt: number; handoffId?: string; runId?: string;
  /** The wake's reason kind (a question asked in an `intro` wake is the
   *  bot's greeting question). */
  reasonKind?: WakeReason['kind'];
  /** The one fan-out task the wake is about (its facts name that task
   *  only): a question asked in it is about that task. */
  taskId?: string;
  /** An owner-message wake: the owner's `human` card that started it, which
   *  the cards the bot writes in its turn answer (wakeReplyTo). */
  ownerCardId?: string;
}

type RoomPortsResolver = () => Partial<FactoryRoomPorts> | null;

let resolveRoomPortsImpl: RoomPortsResolver = () => null;

/** Point the room and handoff modules at the real ports (the factory host,
 *  at wiring time: getFactLog / getWakeQueue / getBotDirectory / onBotHook). */
export function setFactoryRoomPorts(resolver: RoomPortsResolver): void {
  resolveRoomPortsImpl = resolver;
}

/** Whatever ports are wired right now (each may be missing). */
export function resolveRoomPorts(): Partial<FactoryRoomPorts> {
  try {
    return resolveRoomPortsImpl() ?? {};
  } catch {
    return {};
  }
}

// ── The owner's corrections (gardener input) ──────────────────────────────

/** What the owner corrected: a plan or proposal declined or rewritten, or a
 *  question answered with none of the options the bot offered. */
export type HumanCorrectionCategory =
  | 'plan-declined' | 'plan-edited' | 'proposal-declined' | 'proposal-edited' | 'question-override';

export interface HumanCorrection {
  workspaceId: string;
  /** The bot whose output was corrected. */
  botId: string;
  /** The corrected card's id (the fact's dedupe key: one correction per card). */
  messageId: string;
  category: HumanCorrectionCategory;
  cardKind?: CardKind;
  threadId?: ThreadId;
  /** One line about the correction (the owner's answer or revision). */
  note?: string;
}

const CORRECTION_NOTE_MAX = 200;

/** The `human.correction` fact draft for one correction (gardener.ts reads
 *  ref.botId, ref.messageId and payload.category / cardKind / note). Pure. */
export function humanCorrectionDraft(c: HumanCorrection, at: number, bots?: BotDirectoryApi): FactDraft<'human.correction'> {
  let role: string | undefined;
  try {
    role = bots?.get(c.botId)?.role;
  } catch {
    role = undefined;
  }
  const note = oneLine(c.note, CORRECTION_NOTE_MAX);
  return {
    kind: 'human.correction',
    at,
    workspaceId: c.workspaceId,
    ref: { botId: c.botId, messageId: c.messageId },
    actor: { kind: 'human' },
    payload: {
      category: c.category,
      ...(c.cardKind ? { cardKind: c.cardKind } : {}),
      ...(role ? { botRole: role } : {}),
      ...(c.threadId ? { threadId: c.threadId } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/** Append one correction to the fact log. Never throws: without a fact log
 *  (or when it refuses the fact) the correction is not recorded and the
 *  owner's answer stands as given. */
export function emitHumanCorrection(
  ports: Partial<Pick<FactoryRoomPorts, 'factLog' | 'bots'>>,
  c: HumanCorrection,
  now: number = Date.now(),
): Fact | null {
  try {
    return ports.factLog?.append(humanCorrectionDraft(c, now, ports.bots)) ?? null;
  } catch (err) {
    console.warn('[factory] rooms: correction fact not written', err);
    return null;
  }
}

// ── Default idempotency keys ───────────────────────────────────────────────

/** Counts a bot's posts, handoffs and routines inside one attempt of one
 *  wake: the n-th post of a turn gets `wake:<wakeId>:<n>`, the n-th handoff
 *  `wake:<wakeId>:h<n>` and the n-th routine `wake:<wakeId>:r<n>`, the same
 *  keys on a retried attempt. */
export class WakeOrdinals {
  private readonly counts = new Map<string, number>();

  next(wake: { wakeId: string; attempt: number } | null | undefined, kind: 'post' | 'handoff' | 'routine'): string | undefined {
    if (!wake || typeof wake.wakeId !== 'string' || !wake.wakeId) return undefined;
    const slot = `${wake.wakeId}#${wake.attempt}#${kind}`;
    const n = (this.counts.get(slot) ?? 0) + 1;
    this.counts.delete(slot);
    this.counts.set(slot, n);
    if (this.counts.size > 2000) {
      const oldest = this.counts.keys().next().value;
      if (oldest !== undefined) this.counts.delete(oldest);
    }
    const key = `wake:${wake.wakeId}:${kind === 'handoff' ? 'h' : kind === 'routine' ? 'r' : ''}${n}`;
    return key.length <= ROOM_LIMITS.CLIENT_ID_MAX ? key : undefined;
  }
}

export const wakeOrdinals = new WakeOrdinals();

/** The running wake of a bot through the ports, or null. Never throws. */
export function runningWake(ports: Partial<FactoryRoomPorts>, botId: string): RunningWake | null {
  try {
    const w = ports.currentWake?.(botId) ?? null;
    return w && typeof w.wakeId === 'string' && w.wakeId ? w : null;
  } catch {
    return null;
  }
}

/** The card a bot's card answers by default: the owner card that started
 *  the bot's running wake, when that `human` card is in the room and thread
 *  the bot's card lands in (a reply stays in its card's thread). Undefined
 *  otherwise, and for any wake no owner message started. Never throws. */
export function wakeReplyTo(
  writer: Pick<RoomWriter, 'get'>,
  wake: Pick<RunningWake, 'ownerCardId'> | null | undefined,
  workspaceId: string,
  threadId: ThreadId,
): string | undefined {
  const id = wake?.ownerCardId;
  if (!id) return undefined;
  try {
    const card = writer.get(workspaceId, id);
    return card && card.kind === 'human' && card.actor.kind === 'human' && card.threadId === threadId ? card.id : undefined;
  } catch {
    return undefined;
  }
}

/** The running wake's thread of a bot through the ports, or null. */
export function runningWakeThread(ports: Partial<FactoryRoomPorts>, botId: string): ThreadId | null {
  try {
    return parseThreadId(ports.currentWakeThread?.(botId) ?? null);
  } catch {
    return null;
  }
}

/** A group chat's thread the bot may not name: a live group it is not in,
 *  unless its running wake is in that thread (a bot asked there answers
 *  there). */
export function namesOthersGroup(ports: Partial<FactoryRoomPorts>, bot: { workspaceId: string; botId: string }, threadId: ThreadId | null | undefined): boolean {
  if (!groupThreadGroup(threadId) || threadId === runningWakeThread(ports, bot.botId)) return false;
  try {
    return ports.groups?.byThread(bot.workspaceId, threadId)?.memberIds.includes(bot.botId) !== true;
  } catch {
    return true;
  }
}

/** Why a bot may not name this thread for what it posts or the workers it
 *  starts, or null: another bot's 1:1 is named only from the wake running
 *  in it; a group chat's thread by its members, or from the wake running
 *  in it. */
export function botThreadRefusal(ports: Partial<FactoryRoomPorts>, bot: { workspaceId: string; botId: string }, threadId: ThreadId | undefined): string | null {
  const dmOf = dmThreadBot(threadId);
  if (dmOf && dmOf !== bot.botId && threadId !== runningWakeThread(ports, bot.botId)) return 'a bot posts in its own 1:1 thread only';
  if (namesOthersGroup(ports, bot, threadId)) return 'a bot posts in a group chat it is in';
  return null;
}

// ── JSONL files ────────────────────────────────────────────────────────────

/** Whether appending to `file` needs a newline first: its last byte is not
 *  one (a torn write left a fragment), so the next record would join it. */
export function needsLeadingNewline(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Append lines to a JSONL file, after a newline when its tail is torn.
 *  Throws when the write fails. */
export function appendJsonLines(file: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lead = needsLeadingNewline(file) ? '\n' : '';
  fs.appendFileSync(file, `${lead}${lines.join('\n')}\n`, { mode: 0o600 });
}

// ── Validation (pure) ──────────────────────────────────────────────────────

export function isRoomWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_ID_RE.test(value);
}

function isCardKind(value: unknown): value is CardKind {
  return typeof value === 'string' && (CARD_KINDS as readonly string[]).includes(value);
}

/** One line of text: control characters and runs of whitespace become one
 *  space; capped. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
}

/** Markdown body: NULs dropped, capped. */
export function capBody(value: unknown, max: number = ROOM_LIMITS.CARD_BODY_MAX): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u0000/g, '').slice(0, max);
}

function shortString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= SHORT_STRING_MAX ? v : undefined;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e10 ? v : undefined;
}

export function sanitizeParty(value: unknown): Party | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (p.kind === 'human') return { kind: 'human' };
  if (p.kind === 'system') return { kind: 'system' };
  if (p.kind === 'bot' && isRoomWorkspaceId(p.workspaceId) && shortString(p.botId)) {
    return { kind: 'bot', workspaceId: p.workspaceId, botId: p.botId as string };
  }
  return null;
}

const REF_STRING_KEYS = [
  'taskId', 'botId', 'handoffId', 'check', 'ptyId', 'label', 'scheduleId', 'method', 'messageId', 'factId', 'decisionId',
  'approvalId', 'routineId', 'requestCardId',
] as const;

/** The refs a card may carry: known keys with the right types only. */
export function sanitizeRefs(value: unknown): RoomCard['refs'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const out: NonNullable<RoomCard['refs']> = {};
  const pr = positiveInt(r.pr);
  if (pr !== undefined) out.pr = pr;
  const issue = positiveInt(r.issue);
  if (issue !== undefined) out.issue = issue;
  if (typeof r.headSha === 'string' && /^[0-9a-f]{7,64}$/i.test(r.headSha)) out.headSha = r.headSha;
  for (const key of REF_STRING_KEYS) {
    const v = shortString(r[key]);
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  if (typeof r.url === 'string' && r.url.length <= URL_MAX && /^https?:\/\/\S+$/.test(r.url)) out.url = r.url;
  // The bots a card is addressed to (main settles them; shared/room.ts).
  if (Array.isArray(r.botIds)) {
    const ids = [...new Set(r.botIds.filter((id): id is string => typeof id === 'string' && BOT_ID_RE.test(id)))].slice(0, ROOM_LIMITS.MENTIONS_MAX);
    if (ids.length > 0) out.botIds = ids;
  }
  if (isBotSecretName(r.secretName)) out.secretName = r.secretName;
  // The subject thread a card links (an approval card's PR thread).
  const linked = parseThreadId(r.threadId);
  if (linked) out.threadId = linked;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A `job_changed` card's record (RoomCard.jobChange), or undefined. */
export function sanitizeJobChange(value: unknown): RoomCard['jobChange'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const j = value as Record<string, unknown>;
  if (typeof j.botId !== 'string' || !BOT_ID_RE.test(j.botId)) return undefined;
  const side = (v: unknown): string | null | undefined => (v === null ? null : normalizeBotJob(v));
  const previous = side(j.previous);
  const next = side(j.next);
  if (previous === undefined || next === undefined) return undefined;
  return { botId: j.botId, previous, next };
}

const NOTICE_CODE_RE = /^[a-z][a-zA-Z0-9.]{0,63}$/;
const NOTICE_ARG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const NOTICE_ARGS_MAX = 8;

/** A system card's notice (RoomCard.notice), or undefined. */
export function sanitizeNotice(value: unknown): CardNotice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const n = value as Record<string, unknown>;
  if (typeof n.code !== 'string' || !NOTICE_CODE_RE.test(n.code)) return undefined;
  const args: Record<string, string | number> = {};
  if (n.args && typeof n.args === 'object' && !Array.isArray(n.args)) {
    for (const [k, v] of Object.entries(n.args as Record<string, unknown>).slice(0, NOTICE_ARGS_MAX)) {
      if (!NOTICE_ARG_KEY_RE.test(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) args[k] = v;
      else if (typeof v === 'string') args[k] = capBody(v);
    }
  }
  return Object.keys(args).length > 0 ? { code: n.code, args } : { code: n.code };
}

/** A card read from disk, or null when it is not one of this room's. */
export function parseCardLine(raw: unknown, workspaceId: string): RoomCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.version !== 1 || c.workspaceId !== workspaceId) return null;
  if (typeof c.id !== 'string' || c.id.length === 0 || c.id.length > 64) return null;
  if (typeof c.seq !== 'number' || !Number.isInteger(c.seq) || c.seq < 1) return null;
  if (typeof c.at !== 'number' || !Number.isFinite(c.at)) return null;
  const threadId = parseThreadId(c.threadId);
  const actor = sanitizeParty(c.actor);
  if (!threadId || !actor || !isCardKind(c.kind)) return null;
  const title = oneLine(c.title, ROOM_LIMITS.TITLE_MAX);
  if (!title) return null;
  const body = typeof c.body === 'string' ? capBody(c.body) : undefined;
  const refs = sanitizeRefs(c.refs);
  const jobChange = c.kind === 'job_changed' ? sanitizeJobChange(c.jobChange) : undefined;
  const notice = actor.kind === 'system' ? sanitizeNotice(c.notice) : undefined;
  const attachments = c.kind === 'human' && actor.kind === 'human' ? parseRoomAttachments(c.attachments) : undefined;
  return {
    version: 1,
    id: c.id,
    seq: c.seq,
    workspaceId,
    threadId,
    kind: c.kind,
    at: c.at,
    actor,
    title,
    ...(body ? { body } : {}),
    ...(refs ? { refs } : {}),
    ...(c.state === 'open' || c.state === 'resolved' ? { state: c.state } : {}),
    ...(typeof c.replyTo === 'string' && c.replyTo.length > 0 && c.replyTo.length <= 64 ? { replyTo: c.replyTo } : {}),
    ...(isClientId(c.clientPostId) ? { clientPostId: c.clientPostId } : {}),
    ...(c.closes === true ? { closes: true as const } : {}),
    ...(jobChange ? { jobChange } : {}),
    ...(c.greeting === true && c.kind === 'question' ? { greeting: true as const } : {}),
    ...(notice ? { notice } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

/** The seq high-water mark line a compaction writes, or null. */
function seqMark(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = (raw as { seqMark?: unknown }).seqMark;
  return typeof m === 'number' && Number.isInteger(m) && m >= 0 ? m : null;
}

export function isClientId(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= ROOM_LIMITS.CLIENT_ID_MAX && !/[\u0000-\u001f]/.test(value);
}

// ── Store ──────────────────────────────────────────────────────────────────

/** What a writer appends; id, seq and workspace stamping are the store's. */
export interface RoomCardInput {
  workspaceId: string;
  threadId?: ThreadId;
  kind: CardKind;
  actor: Party;
  title: string;
  body?: string;
  refs?: RoomCard['refs'];
  state?: 'open' | 'resolved';
  at?: number;
  /** Main-written closing card (see RoomCard.closes). */
  closes?: true;
  /** `job_changed` cards only (RoomCard.jobChange). */
  jobChange?: RoomCard['jobChange'];
  /** `question` cards only (RoomCard.greeting). */
  greeting?: true;
  /** System cards only (RoomCard.notice). */
  notice?: CardNotice;
  /** The owner's `human` cards only (RoomCard.attachments): photos already
   *  in the room's store. */
  attachments?: RoomCard['attachments'];
}

/** A post from a bot or the owner: idempotent by clientPostId, and a replyTo
 *  must name a card of the same thread. */
export interface RoomPostInput extends RoomCardInput {
  replyTo?: string;
  clientPostId?: string;
}

export type RoomPostResult =
  | { ok: true; card: RoomCard; duplicate?: true }
  | { ok: false; code: 'invalid' | 'reply_to'; message: string };

/** main → renderer push on ROOM_EVENT. */
export interface RoomEventPayload {
  workspaceId: string;
  card: RoomCard;
  threadSummary: ThreadSummary;
}

interface RoomState {
  cards: RoomCard[];
  byId: Map<string, RoomCard>;
  nextSeq: number;
  /** Lines in the file (for compaction). */
  lines: number;
  seenFacts: Set<string>;
  /** clientPostId → card id. */
  byClientId: Map<string, string>;
  /** threadId → the owner's read position (seq). */
  readThrough: Record<string, number>;
}

export interface RoomWriterOptions {
  /** `<wmuxDir>/factory/rooms` */
  dir: string;
  now?: () => number;
  emit?: (payload: RoomEventPayload) => void;
  log?: (msg: string, err?: unknown) => void;
  /** Tests: smaller ROOM_STORE_LIMITS. */
  limits?: { maxCards?: number; compactSlack?: number };
}

function cardId(): string {
  return `c-${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

const STATUS_RANK: Readonly<Record<ThreadSummary['status'], number>> = { open: 0, quiet: 1, closed: 2 };

function factCardKey(c: Pick<RoomCard, 'refs' | 'threadId' | 'kind'>): string {
  return `${c.refs?.factId ?? ''}:${c.threadId}:${c.kind}`;
}

function threadTitle(threadId: ThreadId): string {
  return threadId === GENERAL_THREAD ? 'General' : threadId;
}

export class RoomWriter {
  private readonly rooms = new Map<string, RoomState>();
  private readonly now: () => number;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly maxCards: number;
  private readonly compactSlack: number;

  constructor(private readonly opts: RoomWriterOptions) {
    this.now = opts.now ?? Date.now;
    this.maxCards = opts.limits?.maxCards ?? ROOM_STORE_LIMITS.MAX_CARDS;
    this.compactSlack = opts.limits?.compactSlack ?? ROOM_STORE_LIMITS.COMPACT_SLACK;
    this.log = opts.log ?? ((m, e) => console.warn(`[factory] rooms: ${m}`, e ?? ''));
  }

  private file(workspaceId: string): string {
    return path.join(this.opts.dir, `${workspaceId}.jsonl`);
  }

  private readFile(workspaceId: string): string {
    return path.join(this.opts.dir, `${workspaceId}.read.json`);
  }

  private loadReadThrough(workspaceId: string): Record<string, number> {
    try {
      const raw = atomicReadJSONSync<unknown>(this.readFile(workspaceId));
      const threads = raw && typeof raw === 'object' ? (raw as { threads?: unknown }).threads : undefined;
      const out: Record<string, number> = {};
      if (threads && typeof threads === 'object') {
        for (const [k, v] of Object.entries(threads as Record<string, unknown>)) {
          const t = parseThreadId(k);
          if (t && typeof v === 'number' && Number.isInteger(v) && v >= 0) out[t] = Math.max(out[t] ?? -1, v);
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /** The room, loaded on first use. Null for an id that is not filename-safe. */
  private room(workspaceId: string): RoomState | null {
    if (!isRoomWorkspaceId(workspaceId)) return null;
    const hit = this.rooms.get(workspaceId);
    if (hit) return hit;
    const state = this.load(workspaceId);
    this.rooms.set(workspaceId, state);
    return state;
  }

  private load(workspaceId: string): RoomState {
    const byId = new Map<string, RoomCard>();
    let lines = 0;
    let text = '';
    try {
      text = fs.readFileSync(this.file(workspaceId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') this.log(`room ${workspaceId} unreadable; starting empty`, err);
    }
    let highWater = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const mark = seqMark(raw);
      if (mark !== null) {
        highWater = Math.max(highWater, mark);
        continue;
      }
      const card = parseCardLine(raw, workspaceId);
      if (card) byId.set(card.id, card);
    }
    const cutoff = this.now() - ROOM_LIMITS.RETAIN_DAYS * DAY_MS;
    let cards = [...byId.values()].filter((c) => c.at >= cutoff || c.state === 'open');
    cards.sort((a, b) => a.seq - b.seq);
    if (cards.length > this.maxCards) cards = capCards(cards, this.maxCards);
    const state: RoomState = {
      cards,
      byId: new Map(cards.map((c) => [c.id, c])),
      nextSeq: Math.max(highWater, ...[...byId.values()].map((c) => c.seq)) + 1,
      lines,
      seenFacts: new Set(cards.filter((c) => c.refs?.factId).map(factCardKey).slice(-ROOM_STORE_LIMITS.SEEN_FACTS)),
      byClientId: new Map(cards.filter((c) => c.clientPostId).map((c) => [c.clientPostId as string, c.id])),
      readThrough: this.loadReadThrough(workspaceId),
    };
    if (state.lines - state.cards.length >= this.compactSlack || state.cards.length < byId.size) {
      this.compact(workspaceId, state);
    }
    return state;
  }

  private compact(workspaceId: string, state: RoomState): void {
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true });
      // The seq high-water mark goes first, so a room emptied by retention
      // never hands out a seq a reader already passed.
      const lines = [JSON.stringify({ version: 1, seqMark: state.nextSeq - 1 }), ...state.cards.map((c) => JSON.stringify(c))];
      atomicWriteTextSync(this.file(workspaceId), `${lines.join('\n')}\n`);
      state.lines = lines.length;
    } catch (err) {
      this.log(`room ${workspaceId} not compacted`, err);
    }
  }

  /** Persist one card line; false when the write failed (nothing changes
   *  in memory then). */
  private writeLine(workspaceId: string, state: RoomState, card: RoomCard): boolean {
    try {
      appendJsonLines(this.file(workspaceId), [JSON.stringify(card)]);
      state.lines += 1;
    } catch (err) {
      this.log(`card ${card.id} not persisted in ${workspaceId}`, err);
      return false;
    }
    return true;
  }

  /** Cap and compact after a successful write. */
  private afterWrite(workspaceId: string, state: RoomState): void {
    if (state.cards.length > this.maxCards) {
      state.cards = capCards(state.cards, this.maxCards);
      state.byId = new Map(state.cards.map((c) => [c.id, c]));
      this.compact(workspaceId, state);
    } else if (state.lines - state.cards.length >= this.compactSlack) {
      this.compact(workspaceId, state);
    }
  }

  private push(workspaceId: string, card: RoomCard): void {
    if (!this.opts.emit) return;
    try {
      this.opts.emit({ workspaceId, card, threadSummary: this.summary(workspaceId, card.threadId) });
    } catch (err) {
      this.log('room event not pushed', err);
    }
  }

  /** Append a card. Null when the workspace id, thread or title is invalid. */
  append(input: RoomCardInput, extra?: { replyTo?: string; clientPostId?: string }): RoomCard | null {
    const state = this.room(input.workspaceId);
    if (!state) return null;
    const threadId = input.threadId === undefined ? GENERAL_THREAD : parseThreadId(input.threadId);
    // A stored bot secret never lands in a room (secretRedaction.ts).
    const title = oneLine(typeof input.title === 'string' ? redactStoredSecrets(input.title) : input.title, ROOM_LIMITS.TITLE_MAX);
    const actor = sanitizeParty(input.actor);
    if (!threadId || !title || !actor || !isCardKind(input.kind)) return null;
    const body = capBody(typeof input.body === 'string' ? redactStoredSecrets(input.body) : input.body);
    const refs = sanitizeRefs(redactStoredSecretsDeep(input.refs));
    const jobChange = input.kind === 'job_changed' ? sanitizeJobChange(redactStoredSecretsDeep(input.jobChange)) : undefined;
    const notice = actor.kind === 'system' ? sanitizeNotice(redactStoredSecretsDeep(input.notice)) : undefined;
    const attachments = input.kind === 'human' && actor.kind === 'human' ? parseRoomAttachments(input.attachments) : undefined;
    // A fact delivered twice (a re-subscribe, a replay) writes one card.
    const factKey = refs?.factId ? factCardKey({ refs, threadId, kind: input.kind }) : null;
    if (factKey && state.seenFacts.has(factKey)) return null;
    const card: RoomCard = {
      version: 1,
      id: cardId(),
      seq: state.nextSeq,
      workspaceId: input.workspaceId,
      threadId,
      kind: input.kind,
      at: input.at ?? this.now(),
      actor,
      title,
      ...(body ? { body } : {}),
      ...(refs ? { refs } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.closes ? { closes: true as const } : {}),
      ...(jobChange ? { jobChange } : {}),
      ...(input.greeting === true && input.kind === 'question' ? { greeting: true as const } : {}),
      ...(notice ? { notice } : {}),
      ...(attachments ? { attachments } : {}),
      ...(extra?.replyTo ? { replyTo: extra.replyTo } : {}),
      ...(extra?.clientPostId ? { clientPostId: extra.clientPostId } : {}),
    };
    // Durable first: a card that did not reach the file does not exist.
    if (!this.writeLine(input.workspaceId, state, card)) return null;
    state.nextSeq = card.seq + 1;
    if (factKey) {
      state.seenFacts.add(factKey);
      if (state.seenFacts.size > ROOM_STORE_LIMITS.SEEN_FACTS) {
        const first = state.seenFacts.values().next().value;
        if (first !== undefined) state.seenFacts.delete(first);
      }
    }
    state.cards.push(card);
    state.byId.set(card.id, card);
    if (card.clientPostId) state.byClientId.set(card.clientPostId, card.id);
    this.afterWrite(input.workspaceId, state);
    this.push(input.workspaceId, card);
    return card;
  }

  /** A bot's or the owner's post. A clientPostId already used in this room
   *  returns that card (duplicate) instead of writing a second one. */
  post(input: RoomPostInput): RoomPostResult {
    const state = this.room(input.workspaceId);
    if (!state) return { ok: false, code: 'invalid', message: 'not a workspace id' };
    const clientPostId = isClientId(input.clientPostId) ? input.clientPostId : undefined;
    if (clientPostId) {
      const prior = state.byId.get(state.byClientId.get(clientPostId) ?? '');
      if (prior) return { ok: true, card: prior, duplicate: true };
    }
    const threadId = input.threadId === undefined ? GENERAL_THREAD : parseThreadId(input.threadId);
    if (input.replyTo !== undefined) {
      const parent = typeof input.replyTo === 'string' ? state.byId.get(input.replyTo) : undefined;
      if (!parent) return { ok: false, code: 'reply_to', message: `no card ${String(input.replyTo)} in this room` };
      if (parent.threadId !== threadId) return { ok: false, code: 'reply_to', message: 'a reply stays in the thread of the card it answers' };
    }
    const card = this.append(input, {
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(clientPostId ? { clientPostId } : {}),
    });
    return card ? { ok: true, card } : { ok: false, code: 'invalid', message: 'the card is not valid' };
  }

  /** Record that the owner read a thread through `seq` (only moves forward). */
  markRead(workspaceId: string, threadId: ThreadId, seq: number): boolean {
    const state = this.room(workspaceId);
    const thread = parseThreadId(threadId);
    if (!state || !thread || !Number.isInteger(seq) || seq < 0) return false;
    const through = Math.min(seq, state.nextSeq - 1);
    if ((state.readThrough[thread] ?? -1) >= through) return false;
    state.readThrough[thread] = through;
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true });
      atomicWriteJSONSync(this.readFile(workspaceId), { version: 1, threads: state.readThrough });
    } catch (err) {
      this.log(`read position of ${workspaceId} not persisted`, err);
    }
    return true;
  }

  /** Change an open card's state (same id and seq). Null when there is no
   *  such card or it already has that state. */
  setState(workspaceId: string, id: string, next: 'open' | 'resolved'): RoomCard | null {
    const state = this.room(workspaceId);
    const cur = state?.byId.get(id);
    if (!state || !cur || cur.state === next) return null;
    const card: RoomCard = { ...cur, state: next };
    if (!this.writeLine(workspaceId, state, card)) return null;
    state.byId.set(id, card);
    const idx = state.cards.findIndex((c) => c.id === id);
    if (idx >= 0) state.cards[idx] = card;
    this.afterWrite(workspaceId, state);
    this.push(workspaceId, card);
    return card;
  }

  /** One card as readers see it: a stored bot secret is redacted even in a
   *  card written before that value was stored (secretRedaction.ts). */
  get(workspaceId: string, id: string): RoomCard | null {
    const card = this.room(workspaceId)?.byId.get(id) ?? null;
    return card ? redactStoredSecretsDeep(card) : null;
  }

  /** The first card of the room that matches, newest first. */
  find(workspaceId: string, match: (c: RoomCard) => boolean): RoomCard | null {
    const cards = this.room(workspaceId)?.cards ?? [];
    for (let i = cards.length - 1; i >= 0; i -= 1) if (match(cards[i])) return cards[i];
    return null;
  }

  /** Cards in arrival (seq) order, at most `limit` (≤ PAGE). threadId
   *  omitted: every card; `general`: the general thread only. With sinceSeq:
   *  the cards after it, `hasMore` when the page stopped short; without: the
   *  newest page. Pass `nextSinceSeq` back to continue. */
  read(workspaceId: string, opts: { threadId?: ThreadId; sinceSeq?: number; limit?: number } = {}): { cards: RoomCard[]; nextSinceSeq: number; hasMore: boolean } {
    const state = this.room(workspaceId);
    if (!state) return { cards: [], nextSinceSeq: 0, hasMore: false };
    const limit = Math.max(1, Math.min(ROOM_LIMITS.PAGE, Math.floor(opts.limit ?? ROOM_LIMITS.PAGE)));
    const scoped = opts.threadId === undefined ? state.cards : state.cards.filter((c) => c.threadId === opts.threadId);
    const since = typeof opts.sinceSeq === 'number' && Number.isFinite(opts.sinceSeq) ? opts.sinceSeq : null;
    // Every reader (bots, the renderer's room.read, the phone's room routes)
    // gets cards with stored bot secrets redacted, whenever a card was written.
    if (since === null) {
      const cards = scoped.slice(-limit);
      return { cards: redactStoredSecretsDeep(cards), nextSinceSeq: cards[cards.length - 1]?.seq ?? 0, hasMore: false };
    }
    const after = scoped.filter((c) => c.seq > since);
    const cards = after.slice(0, limit);
    return { cards: redactStoredSecretsDeep(cards), nextSinceSeq: cards[cards.length - 1]?.seq ?? since, hasMore: after.length > limit };
  }

  summary(workspaceId: string, threadId: ThreadId): ThreadSummary {
    const state = this.room(workspaceId);
    const cards = state ? state.cards.filter((c) => c.threadId === threadId) : [];
    const last = cards[cards.length - 1];
    const openQuestions = cards.filter((c) => c.kind === 'question' && c.state === 'open').length;
    const openItems = cards.filter((c) => c.state === 'open').length;
    const through = state?.readThrough[threadId];
    let status: ThreadSummary['status'] = 'open';
    if (threadId !== GENERAL_THREAD && openItems === 0 && cards.some((c) => c.closes)) status = 'closed';
    else if (openItems === 0 && last && this.now() - last.at > ROOM_LIMITS.QUIET_DAYS * DAY_MS) status = 'quiet';
    const dmBotId = state ? threadLinked(state.cards, threadId, dmThreadBot) : null;
    const groupId = state && !dmBotId ? threadLinked(state.cards, threadId, groupThreadGroup) : null;
    return {
      threadId,
      title: threadId === GENERAL_THREAD ? threadTitle(threadId) : redactStoredSecrets(cards[0]?.title ?? threadTitle(threadId)),
      lastAt: last?.at ?? 0,
      lastSeq: last?.seq ?? 0,
      cardCount: cards.length,
      openQuestions,
      lastKind: last?.kind ?? 'fact',
      status,
      unread: through === undefined ? null : cards.filter((c) => c.seq > through).length,
      ...(cards[0] ? { firstAt: cards[0].at } : {}),
      ...(dmBotId ? { dmBotId } : {}),
      ...(groupId ? { groupId } : {}),
    };
  }

  /** Every thread of the room: open questions first, then open, quiet and
   *  closed threads, each newest first. */
  threads(workspaceId: string): ThreadSummary[] {
    const state = this.room(workspaceId);
    if (!state) return [];
    const ids = new Set<ThreadId>([GENERAL_THREAD, ...state.cards.map((c) => c.threadId)]);
    return [...ids]
      .map((t) => this.summary(workspaceId, t))
      .sort((a, b) => (b.openQuestions > 0 ? 1 : 0) - (a.openQuestions > 0 ? 1 : 0)
        || STATUS_RANK[a.status] - STATUS_RANK[b.status]
        || b.lastAt - a.lastAt);
  }

  /** Forget loaded rooms (tests; a later read reloads from disk). */
  unload(): void {
    this.rooms.clear();
  }
}

/** The bot whose 1:1 a thread is, or started it (`of` = dmThreadBot), or
 *  the group chat's (`of` = groupThreadGroup): its own `dm:<botId>` /
 *  `group:<id>`, or a thread one of main's cards ties to one — the opening
 *  hop linking it (`refs.threadId`), or the pointer card in it linking this
 *  thread. */
function threadLinked(cards: readonly RoomCard[], threadId: ThreadId, of: (t: unknown) => string | null): string | null {
  const own = of(threadId);
  if (own || threadId === GENERAL_THREAD || dmThreadBot(threadId) || groupThreadGroup(threadId)) return own;
  for (const c of cards) {
    if (c.actor.kind !== 'system') continue;
    if (c.threadId === threadId) {
      const linked = of(c.refs?.threadId);
      if (linked) return linked;
    } else if (c.refs?.threadId === threadId) {
      const from = of(c.threadId);
      if (from) return from;
    }
  }
  return null;
}

/** Keep `max` cards: open ones first, then the newest; seq order kept. */
function capCards(cards: RoomCard[], max: number): RoomCard[] {
  const open = cards.filter((c) => c.state === 'open');
  const rest = cards.filter((c) => c.state !== 'open');
  const keepRest = rest.slice(Math.max(0, rest.length - Math.max(0, max - open.length)));
  const keep = new Set([...open.slice(-max), ...keepRest]);
  return cards.filter((c) => keep.has(c));
}

// ── Facts → system cards ───────────────────────────────────────────────────

function botLabel(bots: BotDirectoryApi | undefined, botId: unknown): string {
  if (typeof botId !== 'string' || !botId) return 'a bot';
  try {
    const p: BotProfile | null = bots?.get(botId) ?? null;
    if (p) return p.name || p.role;
  } catch {
    /* label only */
  }
  return botId;
}

function str(v: unknown, max: number = ROOM_LIMITS.TITLE_MAX): string {
  return typeof v === 'string' ? oneLine(v, max) : '';
}

function prThread(fact: Fact): ThreadId {
  const key = normalizeRepoKey(fact.repoKey) ?? fact.repoKey;
  if (key && fact.ref?.pr) {
    const t = parseThreadId(prThreadId(key, fact.ref.pr));
    if (t) return t;
  }
  return GENERAL_THREAD;
}

function issueThread(fact: Fact): ThreadId {
  const key = normalizeRepoKey(fact.repoKey) ?? fact.repoKey;
  if (key && fact.ref?.issue) {
    const t = parseThreadId(issueThreadId(key, fact.ref.issue));
    if (t) return t;
  }
  return GENERAL_THREAD;
}

/** A task fact's thread: the thread of the wake that started the task
 *  (`payload.threadId`, from its ledger row — factIngest.ts), else the task's
 *  own `task:<id>`. */
function taskThread(fact: Fact): ThreadId {
  return taskOriginThread(fact.payload?.threadId)
    ?? ((fact.ref?.taskId && parseThreadId(`task:${fact.ref.taskId}`)) || GENERAL_THREAD);
}

/** The room thread a fact is about: its PR, issue or task thread, a
 *  handoff's or a message's own thread, else `general`. A wake the fact
 *  causes is pinned there (the trigger engine). Pure. */
export function factThreadId(fact: Fact): ThreadId {
  const k = fact.kind;
  if (k.startsWith('pr.') || k.startsWith('ci.') || k === 'verdict.recorded' || k.startsWith('merge.')) return prThread(fact);
  if (k.startsWith('issue.')) return issueThread(fact);
  if (k.startsWith('task.') || k.startsWith('pane.')) return taskThread(fact);
  if (k.startsWith('handoff.') || k.startsWith('human.')) return parseThreadId(fact.payload?.threadId) ?? GENERAL_THREAD;
  return GENERAL_THREAD;
}

function sha7(sha: unknown): string {
  return typeof sha === 'string' ? sha.slice(0, 7) : '';
}

/** The workspaces whose rooms a fact belongs in: its own workspace, else the
 *  workspaces with an enabled bot on its repo. */
export function factRooms(fact: Fact, bots: BotDirectoryApi | undefined): string[] {
  if (fact.workspaceId) return isRoomWorkspaceId(fact.workspaceId) ? [fact.workspaceId] : [];
  const repo = normalizeRepoKey(fact.repoKey);
  if (!repo || !bots) return [];
  let enabled: BotProfile[] = [];
  try {
    enabled = bots.listEnabled();
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const b of enabled) if (normalizeRepoKey(b.repo?.repoKey) === repo && isRoomWorkspaceId(b.workspaceId)) out.add(b.workspaceId);
  return [...out];
}

interface SystemCard { workspaces: string[]; threadId: ThreadId; kind: CardKind; title: string; body?: string; refs?: RoomCard['refs']; closes?: true; notice?: CardNotice }

/** factoryStop.ts STOPPED_BY_OWNER: the summary of a task the owner's stop
 *  cancelled (not imported: the stop pulls in the fan-out notifier). */
const STOPPED_BY_OWNER_SUMMARY = 'stopped by owner';

/** A task card's label in the English the card keeps, by its notice code. */
/** #2231 — why wmux itself moved a task to input_required, from the summary
 *  it wrote (FanOutService), so the room can word it in the reader's
 *  language; null for a worker's own words. Pure. */
export function inputRequiredWhy(summary: string): 'trustDialog' | 'firstRun' | 'launchFailed' | null {
  if (/^worker is waiting on Claude Code's (?:workspace|codex folder) trust dialog;/.test(summary)) return 'trustDialog';
  if (/^worker is waiting on Claude Code's [^;]+; it needs a keypress in the pane$/.test(summary)) return 'firstRun';
  if (/^launch failed: no agent started in pane \S+ within \d+s/.test(summary)) return 'launchFailed';
  return null;
}

const TASK_CARD_LABEL: Readonly<Record<string, string>> = {
  'task.done': 'Task done',
  'task.reported': 'Task reported · in review',
  'task.failed': 'Task failed',
  'task.cancelled': 'Task cancelled',
  'task.stoppedByOwner': 'Task cancelled · stopped by owner',
  'task.inputRequired': 'Task needs input',
};

/** What a budget refusal stopped, in the English the card keeps (the
 *  reader's language comes from its notice, roomFormat.ts). */
const BUDGET_LIMIT_TEXT: Readonly<Record<string, string>> = {
  turns_hour: 'is out of turns for this hour',
  turns_day: 'is out of turns for today',
  concurrent_workers: 'is running as many workers as it may at once',
  worker_hours_day: 'has used its worker hours for today',
  factory_workers: 'waits: the bots run as many workers as they may at once',
};

/** The system card(s) a fact becomes, or null for kinds the room does not
 *  show (PR / issue / CI edges other than the closing ones — the bots post
 *  what they make of them; human.message — its `human` card was written with
 *  it). Pure. */
export function systemCardForFact(fact: Fact, bots?: BotDirectoryApi): SystemCard | null {
  const p = fact.payload ?? {};
  const baseRefs: FactRef & { factId: string } = { ...(fact.ref ?? {}), factId: fact.id };
  switch (fact.kind) {
    case 'handoff.received':
    case 'handoff.refused': {
      // The router puts both ends' workspaces in the payload: a cross-workspace
      // hop shows in both rooms.
      const workspaces = [p.toWorkspaceId, p.fromWorkspaceId, fact.workspaceId].filter(isRoomWorkspaceId);
      const threadId = parseThreadId(p.threadId) ?? GENERAL_THREAD;
      const title = str(p.title) || 'handoff';
      const to = str(p.toLabel) || botLabel(bots, fact.ref?.botId);
      const kind = str(p.handoffKind);
      // A thread opened from a coordinator's 1:1 or a group chat: the opening
      // hop links it.
      const openedIn = parseThreadId(p.openedIn);
      const dmLink = openedIn && (dmThreadBot(openedIn) || groupThreadGroup(openedIn)) ? { threadId: openedIn } : {};
      if (fact.kind === 'handoff.refused') {
        return {
          workspaces: [...new Set(workspaces)], threadId, kind: 'refusal',
          title: `Handoff refused (${str(p.code) || 'refused'}): ${title}`,
          body: capBody(p.detail, 1000), refs: { ...baseRefs, ...dmLink },
        };
      }
      // A room mention is the card that said it: its delivery adds no line.
      // A refused one shows above.
      if (p.mention === true) return null;
      // Worded in the reader's language only for a bot addressee (ref.botId:
      // handoffRouter emit's `directed`); the owner and wmux keep the English.
      const hop = kind || 'handoff';
      const hopNotice: CardNotice | undefined = fact.ref?.botId
        ? { code: 'handoff.sent', args: { hop, to, title, ...(p.relay === true && kind !== 'answer' ? { relay: 1 } : {}) } }
        : undefined;
      return {
        workspaces: [...new Set(workspaces)], threadId, kind: 'fact',
        title: kind === 'answer' ? `Answered → ${to}: ${title}`
          : p.relay === true ? `${kind || 'handoff'} → ${to}: ${title} (forwarded by wmux)`
          : `${kind || 'handoff'} → ${to}: ${title}`,
        ...(kind === 'answer' ? { body: capBody(p.answer, 1000) } : {}),
        ...(hopNotice ? { notice: hopNotice } : {}),
        refs: {
          ...baseRefs,
          ...(str(p.requestCardId) ? { requestCardId: str(p.requestCardId) } : {}),
          ...dmLink,
        },
      };
    }
    case 'task.done':
    case 'task.failed':
    case 'task.input_required': {
      // A task cancelled before it reported comes as task.failed (factIngest.ts)
      // but is not a failure: it says Cancelled, and stopped by owner when
      // the owner's stop ended it (factoryStop.ts).
      const cancelled = fact.kind === 'task.failed' && p.status === 'cancelled';
      const byOwner = cancelled && p.by === 'system' && p.summary === STOPPED_BY_OWNER_SUMMARY;
      // A worker that reported is not done: the task waits on review.
      const code = fact.kind === 'task.done' ? (p.status === 'review_requested' ? 'task.reported' : 'task.done')
        : byOwner ? 'task.stoppedByOwner'
          : cancelled ? 'task.cancelled'
            : fact.kind === 'task.failed' ? 'task.failed' : 'task.inputRequired';
      const gate = typeof p.gateExit === 'number' ? `gate exit ${p.gateExit}${p.gateHeadSha ? ` at ${sha7(p.gateHeadSha)}` : ''}` : '';
      const body = [byOwner ? '' : capBody(p.summary, 2000), gate].filter(Boolean).join('\n\n');
      const threadId = taskThread(fact);
      const title = str(p.title) || fact.ref?.taskId || 'task';
      const why = code === 'task.inputRequired' ? inputRequiredWhy(str(p.summary)) : null;
      return {
        workspaces: factRooms(fact, bots), threadId, kind: 'fact',
        title: `${TASK_CARD_LABEL[code]}: ${title}`,
        notice: { code, args: { title, ...(why ? { why } : {}) } },
        ...(body ? { body } : {}), refs: baseRefs,
        // A task's end closes only its own thread: in the issue, PR or other
        // thread it was started from, the subject is still open.
        ...(fact.kind === 'task.done' && threadId === `task:${fact.ref?.taskId}` ? { closes: true as const } : {}),
      };
    }
    case 'verdict.recorded': {
      const pr = fact.ref?.pr;
      const sha = sha7(fact.ref?.headSha);
      const by = botLabel(bots, fact.ref?.botId);
      return {
        workspaces: factRooms(fact, bots), threadId: prThread(fact), kind: 'fact',
        title: `Verdict ${str(p.verdict) || 'recorded'} for #${pr ?? '?'} at ${sha} by ${by}`,
        ...(capBody(p.summary, 2000) ? { body: capBody(p.summary, 2000) } : {}),
        refs: baseRefs,
        ...(typeof pr === 'number' && str(p.verdict) ? { notice: { code: 'verdict.recorded', args: { verdict: str(p.verdict), pr, sha, bot: by } } } : {}),
      };
    }
    case 'merge.done':
      return {
        workspaces: factRooms(fact, bots), threadId: prThread(fact), kind: 'fact',
        title: `Merged #${fact.ref?.pr ?? '?'} at ${sha7(fact.ref?.headSha)}`, refs: baseRefs, closes: true,
      };
    case 'pr.merged':
    case 'pr.closed': {
      const pr = fact.ref?.pr;
      return {
        workspaces: factRooms(fact, bots), threadId: prThread(fact), kind: 'fact',
        title: `PR #${pr ?? '?'} ${fact.kind === 'pr.merged' ? 'merged' : 'closed'}${str(p.title) ? `: ${str(p.title)}` : ''}`,
        refs: baseRefs, closes: true,
        ...(typeof pr === 'number' ? { notice: { code: fact.kind, args: { pr, ...(str(p.title) ? { title: str(p.title) } : {}) } } } : {}),
      };
    }
    case 'issue.closed':
      return {
        workspaces: factRooms(fact, bots), threadId: issueThread(fact), kind: 'fact',
        title: `Issue #${fact.ref?.issue ?? '?'} closed${str(p.title) ? `: ${str(p.title)}` : ''}`,
        refs: baseRefs, closes: true,
      };
    case 'merge.refused': {
      // Lane auto-merge off: the lane host posts the card itself, unless the
      // owner is asked to approve that PR (mergeLaneHost.ts refuse).
      if (p.cardHeld === true) return null;
      // The reasons in the owner's words; the fact keeps the raw codes.
      const body = capBody(formatLaneRefusal(typeof p.reason === 'string' ? p.reason : ''), 2000);
      return {
        workspaces: factRooms(fact, bots), threadId: prThread(fact), kind: 'refusal',
        title: `Merge refused for #${fact.ref?.pr ?? '?'} at ${sha7(fact.ref?.headSha)}`,
        ...(body ? { body } : {}),
        refs: baseRefs,
      };
    }
    case 'bot.refused':
      return {
        workspaces: factRooms(fact, bots), threadId: GENERAL_THREAD, kind: 'refusal',
        title: `${botLabel(bots, fact.ref?.botId)} was refused ${str(fact.ref?.method) || 'a call'} (${str(p.reason) || 'surface'})`,
        refs: baseRefs,
      };
    case 'bot.budget_exhausted': {
      // Which limit, and when the bot picks up again (a turn limit frees by
      // itself as its window slides; BotRuntime computes the time).
      const name = botLabel(bots, fact.ref?.botId);
      const reason = str(p.reason);
      const until = typeof p.until === 'number' && Number.isFinite(p.until) && p.until > 0 ? p.until : null;
      const limit = BUDGET_LIMIT_TEXT[reason] ?? 'is out of budget';
      return {
        workspaces: factRooms(fact, bots), threadId: GENERAL_THREAD, kind: 'budget',
        title: `${name} ${limit}${until !== null ? `; it picks up again at ${formatHeldUntil(until, fact.at)}` : ''}`,
        refs: baseRefs,
        ...(reason in BUDGET_LIMIT_TEXT ? { notice: { code: 'budget.exhausted', args: { bot: name, limit: reason, ...(until !== null ? { until } : {}) } } } : {}),
      };
    }
    case 'bot.notice': {
      // Main's own line to one bot; the owner sees it only when it says so
      // (a worker that could not start), in the thread it is about, title only.
      if (p.card !== true || !isRoomWorkspaceId(fact.workspaceId) || !str(p.title)) return null;
      // Main's stable code for it, when it wrote one (botNotices.ts).
      const notice = sanitizeNotice(p.notice);
      return {
        workspaces: [fact.workspaceId], threadId: parseThreadId(p.threadId) ?? GENERAL_THREAD,
        kind: p.topic === 'worker.start_failed' ? 'refusal' : 'fact',
        title: str(p.title), refs: baseRefs,
        ...(notice ? { notice } : {}),
      };
    }
    case 'bot.error': {
      // At the provider's usage limit: when the bot picks up by itself.
      const name = botLabel(bots, fact.ref?.botId);
      const until = typeof p.until === 'number' && Number.isFinite(p.until) && p.until > 0 ? p.until : null;
      return {
        workspaces: factRooms(fact, bots), threadId: GENERAL_THREAD, kind: 'fact',
        title: until !== null ? `${name} hit its usage limit; it picks up again at ${formatHeldUntil(until, fact.at)}` : `${name} hit an error`,
        ...(capBody(p.message, 1000) ? { body: capBody(p.message, 1000) } : {}),
        refs: baseRefs,
        notice: until !== null ? { code: 'bot.usageLimit', args: { bot: name, until } } : { code: 'bot.error', args: { bot: name } },
      };
    }
    default:
      return null;
  }
}

/** Write the system cards of one fact. Never throws. */
export function writeFactCards(writer: RoomWriter, fact: Fact, bots?: BotDirectoryApi): RoomCard[] {
  let spec: SystemCard | null;
  try {
    spec = systemCardForFact(fact, bots);
  } catch {
    return [];
  }
  if (!spec) return [];
  const out: RoomCard[] = [];
  for (const workspaceId of spec.workspaces) {
    const card = writer.append({
      workspaceId,
      threadId: spec.threadId,
      kind: spec.kind,
      actor: { kind: 'system' },
      title: spec.title,
      ...(spec.body ? { body: spec.body } : {}),
      ...(spec.refs ? { refs: spec.refs } : {}),
      ...(spec.closes ? { closes: true as const } : {}),
      ...(spec.notice ? { notice: spec.notice } : {}),
      at: fact.at,
    });
    if (card) out.push(card);
  }
  return out;
}

/** The card of a turn that was running when the app quit (never replayed),
 *  in the thread that wake was pinned to. */
export function writeInterruptedWakeCard(writer: RoomWriter, ev: RoomBotHookEvent, bots?: BotDirectoryApi): RoomCard | null {
  if (ev.type !== 'wake.interrupted' || !isRoomWorkspaceId(ev.workspaceId)) return null;
  const threadId = ('threadId' in ev ? parseThreadId(ev.threadId) : null) ?? GENERAL_THREAD;
  return writer.append({
    workspaceId: ev.workspaceId,
    threadId,
    kind: 'fact',
    actor: { kind: 'system' },
    title: `${botLabel(bots, ev.botId)}'s turn was interrupted when the app quit; it is not replayed`,
    refs: { ...(ev.botId ? { botId: ev.botId } : {}) },
  });
}

/** "14:05" today, "Oct 14 14:05" on another day (local time). */
export function formatHeldUntil(until: number, now: number): string {
  const d = new Date(until);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

/** The status card of an owner's message held while its bot is out of
 *  turns, in that message's thread: one card per held wake, however often
 *  the runtime reports it (keyed by the wake id, across restarts too). */
export function writeHeldWakeCard(writer: RoomWriter, ev: RoomBotHookEvent, bots?: BotDirectoryApi): RoomCard | null {
  if (ev.type !== 'wake.held' || !('wakeId' in ev) || !isRoomWorkspaceId(ev.workspaceId)) return null;
  const threadId = parseThreadId(ev.threadId) ?? GENERAL_THREAD;
  const name = botLabel(bots, ev.botId);
  const at = 'until' in ev && typeof ev.until === 'number' ? ev.until : null;
  const until = at !== null ? ` until ${formatHeldUntil(at, ev.at)}` : '';
  const r = writer.post({
    workspaceId: ev.workspaceId,
    threadId,
    kind: 'budget',
    actor: { kind: 'system' },
    title: `Queued: ${name} is out of turns${until}; resume it in its profile`,
    refs: { botId: ev.botId },
    notice: { code: 'budget.held', args: { bot: name, ...(at !== null ? { until: at } : {}) } },
    clientPostId: `held:${ev.wakeId}`,
  });
  return r.ok && !r.duplicate ? r.card : null;
}

/** The card a bot runtime hook writes, if any. */
export function writeBotHookCard(writer: RoomWriter, ev: RoomBotHookEvent, bots?: BotDirectoryApi): RoomCard | null {
  return ev.type === 'wake.held' ? writeHeldWakeCard(writer, ev, bots) : writeInterruptedWakeCard(writer, ev, bots);
}

// ── The running writer ─────────────────────────────────────────────────────

let current: RoomWriter | null = null;

/** Set by the room module's start(). */
export function setRoomWriter(writer: RoomWriter | null): void {
  current = writer;
}

/** The room writer, or null before the factory started. */
export function getRoomWriter(): RoomWriter | null {
  return current;
}
