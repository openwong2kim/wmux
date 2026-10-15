// ─── The Bots page's conversations (pure) ────────────────────────────────
//
// The page reads like a messenger: one conversation per bot (1:1) and one per
// workspace room (a group). Nothing here is a second source of truth: every
// conversation is derived from what the stores already hold —
//
//   bots      the factory bot port's list (profile + runtime status)
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
// the bot, or in a thread other than General it wrote in). A bot alone in its
// workspace has no room row, so its 1:1 keeps that filter over every card
// outside the 1:1 threads, whatever its age: nothing it says is out of view.
//
// A group is its workspace's room without the 1:1 threads and the threads
// they started, listed once the workspace has two or more bots (a team).
// Every conversation is ordered by latest activity; no room is special
// (2026-10-14: the HQ is a workspace like any other).
//
// Needs you lives on the 1:1 rows only — a bot's open questions, its open
// plan (the newest one; an older plan left open is superseded) and open
// proposals, plus its workers waiting on the owner (a worker its bot's open
// question already asks about, by task, is that question) — so each waiting
// thing is counted once, and the rail badge is the sum of those rows
// (botsNeedsYou). While the bots are paused the page is read-only and
// nothing on it is counted.

import { dmThreadBot, type RoomCard, type ThreadSummary } from '../../../shared/room';
import type { FleetAttentionClass } from '../../stores/selectors/fleet';
import type { RoomTimeline } from '../../stores/slices/roomSlice';
import type { FactoryBotRow } from '../Room/factoryPorts';
import type { BotTaskView } from '../../../shared/botTask';

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
  /** `bot:<botId>` or `room:<workspaceId>`. */
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
  /** The bot is its workspace's only one: no room row, so its 1:1 shows
   *  everything it says (see the header). */
  lone: boolean;
}

/** A worker row under its bot in the list, as the Sidebar draws a task. */
export interface BotTreeRow {
  workspaceId: string;
  title: string;
  /** running · waits on the owner · errored, live; done · failed, ended. */
  state: 'running' | 'needsYou' | 'error' | 'done' | 'failed';
  taskId?: string;
  /** An ended task whose stopped worker can resume the same conversation. */
  resumable: boolean;
  /** The task's ledger says its worker asked for input. */
  needsInput?: boolean;
  /** What a worker waiting on input waits for (its task's summary). */
  summary?: string;
}

export interface RoomConversation extends ConversationBase {
  kind: 'room';
  /** The room's bots, oldest first. */
  bots: FactoryBotRow[];
  /** The room's bots' live workers. */
  workers: BotWorker[];
}

export type Conversation = BotConversation | RoomConversation;

export interface BotsInput {
  bots: readonly FactoryBotRow[];
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

export function roomConversationId(workspaceId: string): string {
  return `room:${workspaceId}`;
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

/** The threads a 1:1 started (a coordinator's request thread), by thread
 *  key, to the bot whose 1:1 it is: the thread's summary says so
 *  (`dmBotId`), main's opening hop card links the 1:1 (`refs.threadId`) or
 *  names the owner's request in it (`refs.requestCardId`), or main's pointer
 *  card in the 1:1 links the thread. Only main's own cards count. Pure. */
export function dmStartedThreads(cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): Map<string, string> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out = new Map<string, string>();
  for (const [workspaceId, list] of Object.entries(threads)) {
    for (const th of list ?? []) {
      if (th.dmBotId && !dmThreadBot(th.threadId)) out.set(threadKeyOf({ workspaceId, threadId: th.threadId }), th.dmBotId);
    }
  }
  for (const c of cards) {
    if (c.actor.kind !== 'system') continue;
    const inDm = dmThreadBot(c.threadId);
    const linked = c.refs?.threadId;
    if (inDm && linked?.startsWith('handoff:')) {
      out.set(threadKeyOf({ workspaceId: c.workspaceId, threadId: linked }), inDm);
      continue;
    }
    if (!c.threadId.startsWith('handoff:')) continue;
    const request = c.refs?.requestCardId ? byId.get(c.refs.requestCardId) : undefined;
    const owner = dmThreadBot(linked) ?? (request && request.workspaceId === c.workspaceId ? dmThreadBot(request.threadId) : null);
    if (owner) out.set(threadKeyOf(c), owner);
  }
  return out;
}

/** The bot whose 1:1 a card belongs to — it sits in that 1:1's thread or a
 *  thread it started — or null for the room's own cards. */
function dmOwnerOf(card: RoomCard, started: ReadonlyMap<string, string>): string | null {
  return dmThreadBot(card.threadId) ?? started.get(threadKeyOf(card)) ?? null;
}

/** A room's own cards: every card but the 1:1 threads and the threads they
 *  started. Pure. */
export function roomViewCards(cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): RoomCard[] {
  const started = dmStartedThreads(cards, threads);
  return cards.filter((c) => dmOwnerOf(c, started) === null);
}

/** A bot's 1:1 conversation (see the header): its 1:1 thread and the
 *  threads it started, and the cards from before 1:1 threads (all of them
 *  outside the 1:1 threads for a bot alone in its workspace) that are its
 *  own, the owner's messages to it and the system cards about its work.
 *  Pure. */
export function conversationCards(cards: readonly RoomCard[], botId: string, opts: { lone?: boolean; threads?: ThreadsByWorkspace } = {}): RoomCard[] {
  const threads = opts.threads ?? {};
  const started = dmStartedThreads(cards, threads);
  const mine = new Set<RoomCard>();
  const rest: RoomCard[] = [];
  let firstDm = Infinity;
  for (const list of Object.values(threads)) {
    for (const th of list ?? []) if (dmThreadBot(th.threadId) && typeof th.firstAt === 'number') firstDm = Math.min(firstDm, th.firstAt);
  }
  for (const c of cards) {
    const owner = dmOwnerOf(c, started);
    if (owner === null) rest.push(c);
    else if (owner === botId) mine.add(c);
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
 *  that turn), belongs to that bot's 1:1; any other thread to the room. A
 *  turn whose thread is not known shows wherever its bot does, and a lone
 *  bot's 1:1 (its whole room) shows every turn of its own. Pure. */
export function conversationTurns(conversation: Conversation, bots: readonly FactoryBotRow[], cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): FactoryBotRow[] {
  const started = dmStartedThreads(cards, threads);
  const running = (r: FactoryBotRow): boolean => r.status?.presence === 'running';
  /** The bot whose 1:1 the turn's thread belongs to, null for the room,
   *  undefined when the turn names no thread. */
  const owner = (r: FactoryBotRow): string | null | undefined => {
    const threadId = r.status?.currentTurn?.threadId;
    if (!threadId) return undefined;
    return dmThreadBot(threadId) ?? started.get(threadKeyOf({ workspaceId: r.bot.workspaceId, threadId: threadId as RoomCard['threadId'] })) ?? null;
  };
  if (conversation.kind === 'room') return conversation.bots.filter((r) => running(r) && !owner(r));
  const me = conversation.row;
  const mine = running(me) && (conversation.lone || owner(me) === undefined || owner(me) === me.bot.id) ? [me] : [];
  return [...mine, ...bots.filter((r) => r.bot.id !== me.bot.id && running(r) && owner(r) === me.bot.id)];
}

/** Whether a bot is its workspace's only one (no room row). Pure. */
export function isLoneBot(bots: readonly FactoryBotRow[], workspaceId: string): boolean {
  return bots.filter((r) => r.bot.workspaceId === workspaceId).length < 2;
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

/** The plans still waiting on the owner: each bot's newest plan card, when
 *  it is open (an older plan left open is superseded by the newer one).
 *  Pure. */
export function livePlanIds(cards: readonly RoomCard[]): Set<string> {
  const newest = new Map<string, RoomCard>();
  for (const c of cards) {
    if (c.kind !== 'plan' || c.actor.kind !== 'bot') continue;
    const prev = newest.get(c.actor.botId);
    if (!prev || c.at > prev.at || (c.at === prev.at && c.seq > prev.seq)) newest.set(c.actor.botId, c);
  }
  const out = new Set<string>();
  for (const c of newest.values()) if (c.state === 'open') out.add(c.id);
  return out;
}

/** Whether a card waits on the owner's Approve / Decline: the live plan or
 *  an open proposal a bot posted. Pure. */
export function awaitsApproval(card: RoomCard, livePlans: ReadonlySet<string>): boolean {
  if (card.actor.kind !== 'bot' || card.state !== 'open') return false;
  // A bot's open key or login request waits on the owner the same way.
  if (card.kind === 'secret_request' || card.kind === 'login_request') return true;
  return card.kind === 'proposal' || card.kind === 'approval' || (card.kind === 'plan' && livePlans.has(card.id));
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

/** A task that ended: its worker no longer runs for it. */
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
    out.push({
      workspaceId,
      title: task.title || name,
      state: task.stage === 'failed' || task.stage === 'cancelled' ? 'failed' : 'done',
      taskId: task.taskId,
      resumable: task.worker === 'resumable',
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
  // A room is listed once its workspace has a team (two or more bots).
  const rooms: RoomConversation[] = botsRooms(bots).filter((ws) => !isLoneBot(bots, ws)).map((workspaceId) => {
    const all = input.cards.get(workspaceId) ?? [];
    const started = dmStartedThreads(all, input.threads);
    const cards = all.filter((c) => dmOwnerOf(c, started) === null);
    const last = lastOf(cards);
    const threadLast = (input.threads[workspaceId] ?? [])
      .filter((th) => !dmThreadBot(th.threadId) && !started.has(threadKeyOf({ workspaceId, threadId: th.threadId })))
      .reduce((m, th) => Math.max(m, th.lastAt), 0);
    return {
      kind: 'room',
      id: roomConversationId(workspaceId),
      workspaceId,
      bots: bots.filter((r) => r.bot.workspaceId === workspaceId),
      workers: [],
      last,
      lastAt: Math.max(cards.at(-1)?.at ?? 0, threadLast),
      needsYou: 0,
    };
  });

  const every = allRoomCards(input.cards);
  const oneToOne: BotConversation[] = bots.map((row) => {
    const lone = isLoneBot(bots, row.bot.workspaceId);
    const own = conversationCards(every, row.bot.id, { lone, threads: input.threads });
    const last = lastOf(own);
    const openQuestions = openQuestionsBy(own, row.bot.id, input.threads);
    const openApprovals = openApprovalsBy(own, row.bot.id);
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
      // A waiting worker whose question the bot already asked counts once.
      needsYou: input.readOnly ? 0 : openQuestions + openApprovals + waitingWorkers(workers, openQuestionTasks(own, row.bot.id, input.threads)),
    };
  });

  // A room shows its bots' workers too (each bubble under its bot's face).
  for (const room of rooms) {
    room.workers = oneToOne.filter((c) => room.bots.some((r) => r.bot.id === c.row.bot.id)).flatMap((c) => c.workers);
  }
  const conversations: Conversation[] = [...rooms, ...oneToOne]
    .sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
  return { conversations, needsYou: botsNeedsYou(oneToOne) };
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

/** The rooms the page reads: every bot's workspace (its 1:1 is a thread of
 *  that room; the room is listed only for a team, buildBots). */
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
 *  worker still waiting for an agent slot, and the newest stopped workers of
 *  ended tasks that can resume the same conversation. Pure. */
export function taskBubbles(tasks: readonly BotTaskView[] | undefined, now: number): BotTaskView[] {
  const list = tasks ?? [];
  const waiting = list.filter((t) => t.stage === 'waiting_slot');
  const resumable = list
    .filter((t) => t.worker === 'resumable' && now - t.updatedAt <= RESUMABLE_SHOWN_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RESUMABLE_SHOWN_MAX);
  return [...waiting, ...resumable];
}

/** The greeting each of these bots posted when it was added: the question
 *  card main marks `greeting` (asked in the bot's intro wake). A room shows
 *  a one-line "joined" notice instead; the bot's 1:1 keeps the greeting.
 *  Card ids. Pure. */
export function greetingCardIds(cards: readonly RoomCard[], bots: readonly FactoryBotRow[]): Set<string> {
  const ids = new Set(bots.map((r) => r.bot.id));
  const out = new Set<string>();
  for (const c of cards) {
    if (c.greeting === true && c.kind === 'question' && c.actor.kind === 'bot' && ids.has(c.actor.botId)) out.add(c.id);
  }
  return out;
}

export type RoomEntry = { kind: 'card'; card: RoomCard } | { kind: 'joined'; row: FactoryBotRow };

/** A room's timeline with each of its bots' "joined" notices placed at the
 *  time the bot was added: a bot whose greeting was read (`greeted`, the
 *  notice stands in for it), or one added after the oldest card shown. A bot
 *  added before the page's oldest card with no greeting read gets none — its
 *  place is not on the page. Pure. */
export function roomEntries(cards: readonly RoomCard[], bots: readonly FactoryBotRow[], greeted: ReadonlySet<string> = new Set()): RoomEntry[] {
  const oldest = cards.length > 0 ? cards[0].at : -Infinity;
  const joined = bots.filter((r) => greeted.has(r.bot.id) || r.bot.createdAt >= oldest).sort((a, b) => a.bot.createdAt - b.bot.createdAt);
  const out: RoomEntry[] = [];
  let j = 0;
  for (const card of cards) {
    while (j < joined.length && joined[j].bot.createdAt <= card.at) out.push({ kind: 'joined', row: joined[j++] });
    out.push({ kind: 'card', card });
  }
  while (j < joined.length) out.push({ kind: 'joined', row: joined[j++] });
  return out;
}
