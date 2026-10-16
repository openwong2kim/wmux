// ─── The Bots page's conversations (pure) ────────────────────────────────
//
// The page reads like a messenger: one conversation per bot (1:1) and one per
// group chat the owner made. Nothing here is a second source of truth: every
// conversation is derived from what the stores already hold —
//
//   bots      the factory bot port's list (profile + runtime status)
//   groups    the owner's group chats (Room/botGroups.ts)
//   cards     the room timelines already read (room slice), per workspace
//   workers   the bot's tasks whose worker is still at work or waits on
//             input (`row.tasks`, main's ledger stage) while the worker's
//             pane is open, and the bot's other task workspaces (its lineage
//             origin or main's bot flag, Sidebar/botTasks.ts) with a live
//             Fleet attention class
//
// A 1:1 conversation is the bot's own thread of its room, `dm:<botId>` (owner
// decision 2026-10-15: the 1:1 and the room are separate, never mirrors) —
// what the owner and the bot say there, its greeting and the work it does
// for those words — plus the threads its 1:1 started (a coordinator's request
// thread, whose opening hop or pointer card names the 1:1; main's thread
// summaries say so too, `dmBotId`, so a page of cards that misses those
// cards still knows). Before a 1:1 thread existed a 1:1 was a filter of the
// rooms, and those cards keep it: in every room read, the cards older than
// the first card of any 1:1 thread (read, or its summary's `firstAt`; none
// yet: all of them) that are the bot's own, the owner's messages
// addressed to it (`refs.botId`) or the system cards about its work (naming
// the bot, or in a thread other than General it wrote in). A workspace whose
// General is no group chat's (no workspace room is listed by itself, owner
// decision 2026-10-15) shows its bots' General in their 1:1s: such a bot's
// 1:1 keeps that filter over every card outside the 1:1 and group threads,
// whatever its age: nothing it says is out of view.
//
// A group chat is the owner's (shared/botGroup.ts): its own thread,
// `group:<id>`, and the threads it started (a coordinator's request thread,
// linked as a 1:1's is; main's summaries say `groupId`). A group made from a
// workspace's room lives on in General: the room without the 1:1 and group
// threads and the threads they started. A bot's greeting is said in its 1:1,
// so a group view leaves an old greeting out and adds no "joined" line.
// Every conversation is ordered by latest activity; nothing is pinned
// (2026-10-14: the HQ is a workspace like any other).
//
// Needs you lives on the 1:1 rows only — a bot's open questions, its open
// plan (the newest one; an older plan left open is superseded) and open
// proposals, in its 1:1 or a group chat, plus its workers waiting on the
// owner (a worker its bot's open
// question already asks about, by task, is that question) — so each waiting
// thing is counted once, and the rail badge is the sum of those rows
// (botsNeedsYou). While the bots are paused the page is read-only and
// nothing on it is counted.

import { dmThreadBot, dmThreadId, groupThreadGroup, type RoomCard, type ThreadId, type ThreadSummary } from '../../../shared/room';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';
import type { BotGroup } from '../../../shared/botGroup';
import type { FleetAttentionClass } from '../../stores/selectors/fleet';
import type { RoomTimeline } from '../../stores/slices/roomSlice';
import type { FactoryBotRow } from '../Room/factoryPorts';
import type { BotTaskView } from '../../../shared/botTask';
import { awaitsApproval, dmStartedThreads, groupStartedThreads, livePlanIds } from '../../../shared/botsWork';

export { awaitsApproval, dmStartedThreads, groupStartedThreads, livePlanIds } from '../../../shared/botsWork';

/** A worker class that is still live on the page (finished ones leave). */
const LIVE_WORKER: ReadonlySet<FleetAttentionClass> = new Set<FleetAttentionClass>(['running', 'needsYou', 'error']);
/** A live worker that waits on the owner (Fleet counts both as Needs you). */
const WAITING_WORKER: ReadonlySet<FleetAttentionClass> = new Set<FleetAttentionClass>(['needsYou', 'error']);

export interface BotWorker {
  workspaceId: string;
  botId: string;
  name: string;
  cls: FleetAttentionClass;
  waiting: boolean;
  /** The task's ledger says its worker asked for input (a stopped agent's
   *  pane reads idle, so this is the stage, not the attention class). */
  needsInput?: boolean;
  /** The bot's task, when the worker is known from its ledger row. */
  taskId?: string;
  /** The task's latest summary (for a worker waiting on input: what it
   *  waits for). */
  summary?: string;
}

interface ConversationBase {
  /** `bot:<botId>` or `group:<groupId>`. */
  id: string;
  workspaceId: string;
  /** The newest card's time, wmux's own lines too (a bot without any: its
   *  creation): the list's order. */
  lastAt: number;
  /** The newest message, a bot's or the owner's, for the row's preview. */
  last: RoomCard | null;
  needsYou: number;
}

export interface BotConversation extends ConversationBase {
  kind: 'bot';
  row: FactoryBotRow;
  openQuestions: number;
  /** Its live plan and open proposals, waiting on the owner's answer. */
  openApprovals: number;
  workers: BotWorker[];
  /** The rows nested under the bot in the list (botWorkerTree). */
  tree: BotTreeRow[];
  /** No group chat lives in its workspace's General (a bot alone there
   *  never has one): its 1:1 shows everything it says (see the header). */
  lone: boolean;
  /** Where the owner answers it when every card it waits on is in a group
   *  chat (none in its 1:1): the group and the newest card's thread. */
  needsAt?: { conversationId: string; workspaceId: string; threadId: ThreadId };
  /** Its newest post in a group chat, when newer than its 1:1's newest
   *  message (the row's preview says where it spoke). */
  elsewhere?: { card: RoomCard; conversationId: string };
  /** The bot was deleted: its 1:1 stays to read (its messages stay), at the
   *  bottom of the list, with nothing to send or change. `row` then holds
   *  only what its tombstone kept. */
  removed?: true;
}

/** A deleted bot as its tombstone keeps it (the room's actors). */
export interface RemovedBotRef {
  id: string;
  workspaceId: string;
  name: string;
  role: BotProfile['role'];
  avatar?: string;
  hue?: number;
}

/** A worker row under its bot in the list, as the Sidebar draws a task. */
export interface BotTreeRow {
  workspaceId: string;
  title: string;
  /** running · waits on the owner · errored, live; review (reported for
   *  review: still open, its worker not running); done · failed · cancelled
   *  (stopped by the owner: not an error), ended. */
  state: 'running' | 'needsYou' | 'error' | 'review' | 'done' | 'failed' | 'cancelled';
  taskId?: string;
  /** An ended task whose stopped worker can resume the same conversation. */
  resumable: boolean;
  /** A live worker whose task is still open (working or waiting on input):
   *  the owner can stop it, its task cancelled. A resumed worker of an
   *  ended task is not (it has no task left to cancel). */
  stoppable?: true;
  /** A review task's worker was stopped (paused) while it waits. */
  workerPaused?: boolean;
  /** Its folder was kept because something in it is not committed. */
  folderKept?: boolean;
  /** The task's ledger says its worker asked for input. */
  needsInput?: boolean;
  /** What a worker waiting on input waits for (its task's summary). */
  summary?: string;
}

/** A group chat the owner made (shared/botGroup.ts). */
export interface RoomConversation extends ConversationBase {
  kind: 'room';
  group: BotGroup;
  /** The thread the group lives in: its own, or General (made from the room). */
  threadId: ThreadId;
  /** The group's bots, oldest first. */
  bots: FactoryBotRow[];
  /** The group's bots' live workers. */
  workers: BotWorker[];
}

export type Conversation = BotConversation | RoomConversation;

export interface BotsInput {
  bots: readonly FactoryBotRow[];
  /** The owner's live group chats. */
  groups?: readonly BotGroup[];
  /** Every card read for a workspace's room, in seq order (roomCardsByWorkspace). */
  cards: ReadonlyMap<string, readonly RoomCard[]>;
  threads: Readonly<Record<string, readonly ThreadSummary[] | undefined>>;
  /** Task workspace id → the bot that owns it (Sidebar/botTasks.ts). */
  botTaskOf: Readonly<Record<string, string>>;
  /** Task workspace id → its attention class; open workspaces only. */
  workerClass: Readonly<Record<string, FleetAttentionClass | undefined>>;
  workspaceName: (workspaceId: string) => string | null;
  /** The bots are paused: the page is read-only, so nothing waits on it. */
  readOnly?: boolean;
  /** Deleted bots: each whose 1:1 holds messages gets a read-only row. */
  removed?: readonly RemovedBotRef[];
}

export interface BotsModel {
  conversations: Conversation[];
  /** The rail badge: the sum of the 1:1 rows' needs-you. */
  needsYou: number;
}

export const EMPTY_BOTS: BotsModel = { conversations: [], needsYou: 0 };

export function botConversationId(botId: string): string {
  return `bot:${botId}`;
}

export function groupConversationId(groupId: string): string {
  return `group:${groupId}`;
}

/** Every card read for each room — the whole-room timeline and any thread
 *  timeline — merged by id (the newer copy wins) in seq order. */
export function roomCardsByWorkspace(timelines: Readonly<Record<string, RoomTimeline>>): Map<string, RoomCard[]> {
  const byWs = new Map<string, Map<string, RoomCard>>();
  for (const [key, tl] of Object.entries(timelines)) {
    const cut = key.indexOf('\u0000');
    if (cut <= 0) continue;
    const ws = key.slice(0, cut);
    let ids = byWs.get(ws);
    if (!ids) byWs.set(ws, (ids = new Map()));
    for (const card of tl.cards) {
      // Two timelines may hold different copies of a card answered in place:
      // an answer is never undone by an older copy.
      const prev = ids.get(card.id);
      ids.set(card.id, prev && prev.state === 'resolved' && card.state === 'open' ? prev : card);
    }
  }
  const out = new Map<string, RoomCard[]>();
  for (const [ws, ids] of byWs) out.set(ws, [...ids.values()].sort((a, b) => a.seq - b.seq));
  return out;
}

/** Where a bot's own work shows: the threads (other than General) it wrote
 *  in, per room, and the tasks its cards name. */
export interface BotWorkScope {
  threads: ReadonlySet<string>;
  tasks: ReadonlySet<string>;
}

function threadKeyOf(card: Pick<RoomCard, 'workspaceId' | 'threadId'>): string {
  return `${card.workspaceId}\u0000${card.threadId}`;
}

/** The bot's work scope among the given cards. Pure. */
export function botWorkScope(cards: readonly RoomCard[], botId: string): BotWorkScope {
  const threads = new Set<string>();
  const tasks = new Set<string>();
  for (const c of cards) {
    if (c.actor.kind !== 'bot' || c.actor.botId !== botId) continue;
    if (c.threadId !== 'general') threads.add(threadKeyOf(c));
    if (c.refs?.taskId) tasks.add(c.refs.taskId);
  }
  return { threads, tasks };
}

/** Whether a system card is about the bot's own work: it names the bot, its
 *  task, or sits in a thread the bot wrote in. Pure. */
export function isBotSystemCard(card: RoomCard, botId: string, scope: BotWorkScope): boolean {
  if (card.actor.kind !== 'system') return false;
  if (card.refs?.botId === botId) return true;
  if (card.refs?.taskId && scope.tasks.has(card.refs.taskId)) return true;
  return card.threadId !== 'general' && scope.threads.has(threadKeyOf(card));
}

/** Whether a card belongs to a bot's 1:1 conversation (system cards need
 *  the bot's work scope; without it none belongs). */
export function isBotConversationCard(card: RoomCard, botId: string, scope?: BotWorkScope): boolean {
  if (card.actor.kind === 'bot') return card.actor.botId === botId;
  if (card.actor.kind === 'system') return !!scope && isBotSystemCard(card, botId, scope);
  return card.kind === 'human' && card.refs?.botId === botId;
}

/** What the room summaries say about 1:1 threads, per workspace. */
type ThreadsByWorkspace = Readonly<Record<string, readonly ThreadSummary[] | undefined>>;

/** The bot whose 1:1 a card belongs to — it sits in that 1:1's thread or a
 *  thread it started — or null for the room's own cards. */
function dmOwnerOf(card: RoomCard, started: ReadonlyMap<string, string>): string | null {
  return dmThreadBot(card.threadId) ?? started.get(threadKeyOf(card)) ?? null;
}

/** The group chat thread a card belongs to — its own or one it started —
 *  or null. */
function groupOwnerOf(card: RoomCard, started: ReadonlyMap<string, ThreadId>): ThreadId | null {
  return (groupThreadGroup(card.threadId) ? card.threadId : null) ?? started.get(threadKeyOf(card)) ?? null;
}

/** A room's own cards: every card but the 1:1 and group threads and the
 *  threads they started. Pure. */
export function roomViewCards(cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): RoomCard[] {
  const started = dmStartedThreads(cards, threads);
  const groups = groupStartedThreads(cards, threads);
  return cards.filter((c) => dmOwnerOf(c, started) === null && groupOwnerOf(c, groups) === null);
}

/** A group chat's cards (see the header): its thread and the threads it
 *  started, or — made from its workspace's room — the room's own cards; a
 *  bot's greeting is its 1:1's. Pure. */
export function groupViewCards(cards: readonly RoomCard[], group: Pick<BotGroup, 'workspaceId' | 'threadId'>, threads: ThreadsByWorkspace = {}): RoomCard[] {
  const here = cards.filter((c) => c.workspaceId === group.workspaceId && !(c.greeting === true && c.kind === 'question'));
  if (!groupThreadGroup(group.threadId)) return roomViewCards(here, threads);
  const started = groupStartedThreads(here, threads);
  return here.filter((c) => groupOwnerOf(c, started) === group.threadId);
}

/** A bot's 1:1 conversation (see the header): its 1:1 thread and the
 *  threads it started, and the cards from before 1:1 threads (all of them
 *  outside the 1:1 threads for a bot alone in its workspace) that are its
 *  own, the owner's messages to it and the system cards about its work.
 *  Pure. */
export function conversationCards(cards: readonly RoomCard[], botId: string, opts: { lone?: boolean; threads?: ThreadsByWorkspace } = {}): RoomCard[] {
  const threads = opts.threads ?? {};
  const started = dmStartedThreads(cards, threads);
  const groups = groupStartedThreads(cards, threads);
  const mine = new Set<RoomCard>();
  const rest: RoomCard[] = [];
  let firstDm = Infinity;
  for (const list of Object.values(threads)) {
    for (const th of list ?? []) if (dmThreadBot(th.threadId) && typeof th.firstAt === 'number') firstDm = Math.min(firstDm, th.firstAt);
  }
  for (const c of cards) {
    const owner = dmOwnerOf(c, started);
    if (owner === null) {
      if (groupOwnerOf(c, groups) === null) rest.push(c);
    } else if (owner === botId) mine.add(c);
    if (dmThreadBot(c.threadId)) firstDm = Math.min(firstDm, c.at);
  }
  const earlier = opts.lone ? rest : rest.filter((c) => c.at < firstDm);
  const scope = botWorkScope(earlier, botId);
  const legacy = new Set(earlier.filter((c) => isBotConversationCard(c, botId, scope)));
  return cards.filter((c) => mine.has(c) || legacy.has(c));
}

/** The bots whose running turn shows in this conversation (its busy lines):
 *  a turn answers in the conversation its thread belongs to. A 1:1 thread,
 *  or a thread a 1:1 started (a dispatch sent from it: another bot may run
 *  that turn), belongs to that bot's 1:1; a group chat's thread, or one it
 *  started, to that group; any other thread to the room's General (a group
 *  living there). A turn whose thread is not known shows in its bot's 1:1,
 *  and a bot whose General is no group's shows its General turns there too.
 *  Pure. */
export function conversationTurns(conversation: Conversation, bots: readonly FactoryBotRow[], cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): FactoryBotRow[] {
  const started = dmStartedThreads(cards, threads);
  const fromGroups = groupStartedThreads(cards, threads);
  const running = (r: FactoryBotRow): boolean => r.status?.presence === 'running';
  /** The conversation thread the turn's thread belongs to (`dm:<bot>` or
   *  `group:<id>`), null for General, undefined when the turn names none. */
  const owner = (r: FactoryBotRow): string | null | undefined => {
    const threadId = r.status?.currentTurn?.threadId as ThreadId | undefined;
    if (!threadId) return undefined;
    if (groupThreadGroup(threadId)) return threadId;
    const key = threadKeyOf({ workspaceId: r.bot.workspaceId, threadId });
    const dm = dmThreadBot(threadId) ?? started.get(key);
    if (dm) return `dm:${dm}`;
    return fromGroups.get(key) ?? null;
  };
  if (conversation.kind === 'room') {
    const general = !groupThreadGroup(conversation.threadId);
    return conversation.bots.filter((r) => running(r) && (general ? !owner(r) : owner(r) === conversation.threadId));
  }
  const me = conversation.row;
  const dm = `dm:${me.bot.id}`;
  const own = owner(me);
  const mine = running(me) && (own === undefined || own === dm || (conversation.lone && own === null)) ? [me] : [];
  return [...mine, ...bots.filter((r) => r.bot.id !== me.bot.id && running(r) && owner(r) === dm)];
}

/** Whether no group chat lives in a workspace's General: its bots' 1:1s
 *  show what they say there (see the header). Pure. */
export function isRoomless(groups: readonly Pick<BotGroup, 'workspaceId' | 'threadId'>[], workspaceId: string): boolean {
  return !groups.some((g) => g.workspaceId === workspaceId && g.threadId === 'general');
}

/** Every card read, across rooms, oldest first (rooms number their cards
 *  separately, so time orders them). */
export function allRoomCards(cards: ReadonlyMap<string, readonly RoomCard[]>): RoomCard[] {
  const out: RoomCard[] = [];
  for (const list of cards.values()) out.push(...list);
  return out.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

/** A bot's 1:1 conversation across every room read. */
export function botConversationCards(cards: ReadonlyMap<string, readonly RoomCard[]>, botId: string, opts: { lone?: boolean; threads?: ThreadsByWorkspace } = {}): RoomCard[] {
  return conversationCards(allRoomCards(cards), botId, opts);
}

/** The tasks the bot's open questions are about (`refs.taskId`): a worker
 *  of one of them waiting on input is the same thing to answer. Pure. */
export function openQuestionTasks(cards: readonly RoomCard[], botId: string, threads: BotsInput['threads'] = {}): Set<string> {
  const out = new Set<string>();
  for (const c of cards) {
    if (c.kind !== 'question' || c.state !== 'open' || c.actor.kind !== 'bot' || c.actor.botId !== botId || !c.refs?.taskId) continue;
    const summary = threads[c.workspaceId]?.find((th) => th.threadId === c.threadId);
    if (summary && summary.openQuestions === 0) continue;
    out.add(c.refs.taskId);
  }
  return out;
}

/** The bot's questions still waiting on the owner. A copy of a card read
 *  before it was answered elsewhere does not count once its thread's
 *  summary (re-read on focus) says no question is open there. */
export function openQuestionsBy(
  cards: readonly RoomCard[],
  botId: string,
  threads: BotsInput['threads'] = {},
): number {
  let n = 0;
  for (const c of cards) {
    if (c.kind !== 'question' || c.state !== 'open' || c.actor.kind !== 'bot' || c.actor.botId !== botId) continue;
    const summary = threads[c.workspaceId]?.find((th) => th.threadId === c.threadId);
    if (summary && summary.openQuestions === 0) continue;
    n += 1;
  }
  return n;
}

/** The bot's live plan and open proposals. Pure. */
export function openApprovalsBy(cards: readonly RoomCard[], botId: string): number {
  const live = livePlanIds(cards);
  let n = 0;
  for (const c of cards) if (c.actor.kind === 'bot' && c.actor.botId === botId && awaitsApproval(c, live)) n += 1;
  return n;
}

/** The task stages whose worker still exists and has not reported. */
const WORKING_STAGE: ReadonlySet<BotTaskView['stage']> = new Set<BotTaskView['stage']>(['working', 'needs_input']);

/** A bot's live workers (running, or waiting on the owner), by name: each
 *  of its tasks still working or waiting on input while the worker's pane is
 *  open (named by the task), then any other task workspace it started whose
 *  Fleet class is live. Finished or closed ones are gone. */
export function botWorkers(
  botId: string,
  owners: BotsInput['botTaskOf'],
  workerClass: BotsInput['workerClass'],
  workspaceName: BotsInput['workspaceName'],
  tasks: readonly BotTaskView[] = [],
): BotWorker[] {
  const out: BotWorker[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.botId !== botId) continue;
    const workspaceId = task.workerWorkspaceId || task.taskWorkspaceId;
    // A resumed worker of an ended task is live while its pane's agent is.
    const resumedLive = task.worker === 'resumed' && !!workspaceId && LIVE_WORKER.has(workerClass[workspaceId] ?? 'idle');
    if (!WORKING_STAGE.has(task.stage) && !resumedLive) continue;
    if (!workspaceId || seen.has(workspaceId) || workspaceName(workspaceId) === null) continue;
    seen.add(workspaceId);
    const cls = workerClass[workspaceId] ?? 'running';
    const needsInput = task.stage === 'needs_input';
    const summary = task.summary?.trim();
    out.push({
      workspaceId, botId, name: task.title || (workspaceName(workspaceId) ?? workspaceId), cls,
      waiting: needsInput || WAITING_WORKER.has(cls), needsInput, taskId: task.taskId, ...(summary ? { summary } : {}),
    });
  }
  // A workspace one of the bot's tasks names follows that task's stage: a
  // done task's pane whose agent still reads running is not a live worker.
  const tasked = new Set<string>();
  for (const task of tasks) {
    if (task.botId !== botId || task.worker === 'resumed') continue;
    if (task.taskWorkspaceId) tasked.add(task.taskWorkspaceId);
    if (task.workerWorkspaceId) tasked.add(task.workerWorkspaceId);
  }
  for (const [workspaceId, owner] of Object.entries(owners)) {
    if (owner !== botId || seen.has(workspaceId) || tasked.has(workspaceId)) continue;
    const cls = workerClass[workspaceId];
    if (!cls || !LIVE_WORKER.has(cls)) continue;
    out.push({ workspaceId, botId, name: workspaceName(workspaceId) ?? workspaceId, cls, waiting: WAITING_WORKER.has(cls) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.workspaceId.localeCompare(b.workspaceId));
}

/** A task that ended, or was reported for review (`coded`, still open): its
 *  worker no longer runs for it. */
const ENDED_STAGE: ReadonlySet<BotTaskView['stage']> = new Set<BotTaskView['stage']>(['coded', 'checked', 'waiting_to_merge', 'merged', 'closed', 'failed', 'cancelled']);

/** The worker rows nested under a bot in the list (owner decision
 *  2026-10-14, the Sidebar's task tree): its live workers, then its ended
 *  tasks whose workspace is still open, newest first, then every other open
 *  workspace the bot's fan-out made — one whose task is older than the task
 *  list the bot reports. The Workspaces sidebar and Fleet hide every bot
 *  worker, so each open one is listed here. A row drops off when its
 *  workspace is cleared. Pure. */
export function botWorkerTree(
  botId: string,
  workers: readonly BotWorker[],
  tasks: readonly BotTaskView[] = [],
  workspaceName: BotsInput['workspaceName'],
  owners: BotsInput['botTaskOf'] = {},
  workerClass: BotsInput['workerClass'] = {},
): BotTreeRow[] {
  const out: BotTreeRow[] = workers.map((w) => ({
    workspaceId: w.workspaceId,
    title: w.name,
    state: w.cls === 'error' ? 'error' : w.waiting ? 'needsYou' : 'running',
    ...(w.taskId ? { taskId: w.taskId } : {}),
    resumable: false,
    ...(w.taskId && tasks.some((task) => task.taskId === w.taskId && WORKING_STAGE.has(task.stage)) ? { stoppable: true as const } : {}),
    ...(w.needsInput ? { needsInput: true } : {}),
    ...(w.needsInput && w.summary ? { summary: w.summary } : {}),
  }));
  const seen = new Set(out.map((r) => r.workspaceId));
  const ended = tasks
    .filter((task) => task.botId === botId && ENDED_STAGE.has(task.stage))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const task of ended) {
    const workspaceId = task.workerWorkspaceId || task.taskWorkspaceId;
    const name = workspaceId ? workspaceName(workspaceId) : null;
    if (!workspaceId || name === null || seen.has(workspaceId)) continue;
    seen.add(workspaceId);
    const review = task.stage === 'coded';
    out.push({
      workspaceId,
      title: task.title || name,
      state: review ? 'review' : task.stage === 'failed' ? 'failed' : task.stage === 'cancelled' ? 'cancelled' : 'done',
      taskId: task.taskId,
      resumable: task.worker === 'resumable',
      ...(review && (task.worker === 'resumable' || task.worker === 'stopped') ? { workerPaused: true } : {}),
      ...(task.folder === 'kept_dirty' ? { folderKept: true } : {}),
    });
  }
  const others: BotTreeRow[] = [];
  for (const [workspaceId, owner] of Object.entries(owners)) {
    if (owner !== botId || seen.has(workspaceId)) continue;
    const name = workspaceName(workspaceId);
    if (name === null) continue;
    seen.add(workspaceId);
    const cls = workerClass[workspaceId];
    others.push({
      workspaceId,
      title: name,
      state: cls === 'error' ? 'error' : cls === 'needsYou' ? 'needsYou' : cls === 'running' ? 'running' : 'done',
      resumable: false,
    });
  }
  return [...out, ...others.sort((a, b) => a.title.localeCompare(b.title) || a.workspaceId.localeCompare(b.workspaceId))];
}

/** The newest message, a bot's or the owner's: wmux's own lines (a relay
 *  hop, a task's start) are never a conversation's preview. */
function lastOf(cards: readonly RoomCard[]): RoomCard | null {
  for (let i = cards.length - 1; i >= 0; i--) if (cards[i].actor.kind !== 'system') return cards[i];
  return null;
}

/** The conversations, newest first. */
export function buildBots(input: BotsInput): BotsModel {
  const bots = [...input.bots].sort((a, b) => a.bot.createdAt - b.bot.createdAt || a.bot.id.localeCompare(b.bot.id));
  const groups = input.groups ?? [];
  // One row per group chat the owner made; no workspace has one by itself.
  const rooms: RoomConversation[] = groups.map((group) => {
    const workspaceId = group.workspaceId;
    const all = input.cards.get(workspaceId) ?? [];
    const cards = groupViewCards(all, group, input.threads);
    const last = lastOf(cards);
    const general = !groupThreadGroup(group.threadId);
    const started = general ? dmStartedThreads(all, input.threads) : null;
    const fromGroups = general ? groupStartedThreads(all, input.threads) : null;
    const threadLast = (input.threads[workspaceId] ?? [])
      .filter((th) => (general
        ? !dmThreadBot(th.threadId) && !groupThreadGroup(th.threadId) && !started!.has(threadKeyOf({ workspaceId, threadId: th.threadId }))
          && !fromGroups!.has(threadKeyOf({ workspaceId, threadId: th.threadId }))
        : th.threadId === group.threadId || th.groupId === group.id))
      .reduce((m, th) => Math.max(m, th.lastAt), 0);
    return {
      kind: 'room',
      id: groupConversationId(group.id),
      workspaceId,
      group,
      threadId: group.threadId,
      bots: bots.filter((r) => r.bot.workspaceId === workspaceId && group.memberIds.includes(r.bot.id)),
      workers: [],
      last,
      // A group with nothing said yet sorts by when it was made.
      lastAt: Math.max(cards.at(-1)?.at ?? group.createdAt, threadLast),
      needsYou: 0,
    };
  });

  const every = allRoomCards(input.cards);
  const oneToOne: BotConversation[] = bots.map((row) => {
    const lone = isRoomless(groups, row.bot.workspaceId);
    const own = conversationCards(every, row.bot.id, { lone, threads: input.threads });
    const last = lastOf(own);
    // What it asks the owner in a group chat waits on its row too (a group
    // row counts nothing: every question has a bot that asked it).
    const ownIds = new Set(own.map((c) => c.id));
    const inGroups = rooms
      .filter((r) => r.workspaceId === row.bot.workspaceId)
      .flatMap((r) => groupViewCards(input.cards.get(r.workspaceId) ?? [], r.group, input.threads)
        .filter((c) => c.actor.kind === 'bot' && c.actor.botId === row.bot.id && !ownIds.has(c.id))
        .map((card) => ({ card, conversationId: r.id })));
    const asked = [...own, ...inGroups.map((g) => g.card)];
    const openQuestions = openQuestionsBy(asked, row.bot.id, input.threads);
    const openApprovals = openApprovalsBy(asked, row.bot.id);
    // The row leads where the owner answers: its 1:1 while anything it
    // waits on is there, else the group holding the newest such card.
    const live = livePlanIds(asked);
    const waits = (c: RoomCard): boolean => isOpenQuestion(c, input.threads) || awaitsApproval(c, live);
    const groupWait = own.some((c) => c.actor.kind === 'bot' && c.actor.botId === row.bot.id && waits(c))
      ? undefined
      : newestOf(inGroups.filter((g) => waits(g.card)));
    const lastGroupPost = newestOf(inGroups);
    const workers = botWorkers(row.bot.id, input.botTaskOf, input.workerClass, input.workspaceName, row.tasks);
    return {
      kind: 'bot',
      id: botConversationId(row.bot.id),
      workspaceId: row.bot.workspaceId,
      row,
      last,
      lastAt: own.at(-1)?.at ?? row.bot.createdAt,
      openQuestions,
      openApprovals,
      workers,
      tree: botWorkerTree(row.bot.id, workers, row.tasks, input.workspaceName, input.botTaskOf, input.workerClass),
      lone,
      ...(groupWait ? { needsAt: { conversationId: groupWait.conversationId, workspaceId: groupWait.card.workspaceId, threadId: groupWait.card.threadId } } : {}),
      ...(lastGroupPost && (!last || lastGroupPost.card.at > last.at) ? { elsewhere: lastGroupPost } : {}),
      // A waiting worker whose question the bot already asked counts once.
      needsYou: input.readOnly ? 0 : openQuestions + openApprovals + waitingWorkers(workers, openQuestionTasks(asked, row.bot.id, input.threads)),
    };
  });

  // A room shows its bots' workers too (each bubble under its bot's face).
  for (const room of rooms) {
    room.workers = oneToOne.filter((c) => room.bots.some((r) => r.bot.id === c.row.bot.id)).flatMap((c) => c.workers);
  }
  const conversations: Conversation[] = [...rooms, ...oneToOne]
    .sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
  // A deleted bot's 1:1 stays reachable below every live conversation.
  const gone = removedConversations(input, new Set(bots.map((r) => r.bot.id)), every)
    .sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
  return { conversations: [...conversations, ...gone], needsYou: botsNeedsYou(oneToOne) };
}

/** The read-only 1:1 of each deleted bot that has messages (its cards, or
 *  its 1:1 thread in the room's thread list). Pure. */
function removedConversations(input: BotsInput, live: ReadonlySet<string>, every: readonly RoomCard[]): BotConversation[] {
  const out: BotConversation[] = [];
  for (const r of input.removed ?? []) {
    if (live.has(r.id)) continue;
    const own = conversationCards(every, r.id, { threads: input.threads });
    const dm = (input.threads[r.workspaceId] ?? []).find((th) => th.threadId === dmThreadId(r.id));
    if (own.length === 0 && !dm) continue;
    const bot: BotProfile = {
      version: 1, id: r.id, workspaceId: r.workspaceId, role: r.role, name: r.name,
      ...(r.avatar ? { avatar: r.avatar } : {}),
      ...(r.hue !== undefined ? { hue: r.hue } : {}),
      engine: { kind: 'claude-sdk' }, triggers: [], budget: DEFAULT_BOT_BUDGETS[r.role],
      enabled: false, createdAt: 0, updatedAt: 0,
    };
    out.push({
      kind: 'bot',
      id: botConversationId(r.id),
      workspaceId: r.workspaceId,
      row: { bot, status: null },
      last: lastOf(own),
      lastAt: Math.max(own.at(-1)?.at ?? 0, dm?.lastAt ?? 0),
      openQuestions: 0,
      openApprovals: 0,
      workers: [],
      tree: [],
      lone: false,
      needsYou: 0,
      removed: true,
    });
  }
  return out;
}

/** Whether a card is a question still open (its thread's summary, re-read
 *  on focus, may say it was answered elsewhere). Pure. */
function isOpenQuestion(c: RoomCard, threads: BotsInput['threads']): boolean {
  if (c.kind !== 'question' || c.state !== 'open') return false;
  const summary = threads[c.workspaceId]?.find((th) => th.threadId === c.threadId);
  return !(summary && summary.openQuestions === 0);
}

/** The newest of some cards, each with where it is. */
function newestOf<E extends { card: RoomCard }>(list: readonly E[]): E | undefined {
  let best: E | undefined;
  for (const e of list) if (!best || e.card.at > best.card.at || (e.card.at === best.card.at && e.card.seq > best.card.seq)) best = e;
  return best;
}

/** The workers waiting on the owner that no open question already asks
 *  about (by task). Pure. */
export function waitingWorkers(workers: readonly BotWorker[], askedTasks: ReadonlySet<string>): number {
  return workers.filter((w) => w.waiting && !(w.taskId && askedTasks.has(w.taskId))).length;
}

/** The rail badge: every 1:1 row's needs-you, summed. */
export function botsNeedsYou(conversations: readonly Conversation[]): number {
  let n = 0;
  for (const c of conversations) if (c.kind === 'bot') n += c.needsYou;
  return n;
}

/** A room's newest thread of a kind (its newest plan or report), by its
 *  last card. Pure. */
export function latestThreadOf(threads: readonly ThreadSummary[], prefix: 'plan:' | 'report:'): ThreadSummary | null {
  let best: ThreadSummary | null = null;
  for (const th of threads) if (th.threadId.startsWith(prefix) && (!best || th.lastSeq > best.lastSeq)) best = th;
  return best;
}

/** The rooms the page reads: every bot's workspace (its 1:1 and its group
 *  chats are threads of that room). */
export function botsRooms(bots: readonly FactoryBotRow[]): string[] {
  const out: string[] = [];
  for (const row of bots) if (!out.includes(row.bot.workspaceId)) out.push(row.bot.workspaceId);
  return out;
}

/** A resumable worker is listed this long after its task ended. */
const RESUMABLE_SHOWN_MS = 24 * 3_600_000;
/** At most this many resumable workers per bot (newest first). */
const RESUMABLE_SHOWN_MAX = 3;

/** The tasks a bot's chat lists at its foot besides its live workers: every
 *  worker still waiting for an agent slot, and the newest ended tasks whose
 *  stopped worker can resume the same conversation or whose folder was kept
 *  for uncommitted changes. Pure. */
export function taskBubbles(tasks: readonly BotTaskView[] | undefined, now: number): BotTaskView[] {
  const list = tasks ?? [];
  const waiting = list.filter((t) => t.stage === 'waiting_slot');
  const resumable = list
    .filter((t) => (t.worker === 'resumable' || t.folder === 'kept_dirty') && t.stage !== 'waiting_slot' && now - t.updatedAt <= RESUMABLE_SHOWN_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RESUMABLE_SHOWN_MAX);
  return [...waiting, ...resumable];
}

/** One entry of a conversation's timeline. */
export type RoomEntry = { kind: 'card'; card: RoomCard };
