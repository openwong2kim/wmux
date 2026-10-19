// ─── Work a conversation handed off, derived from room cards (pure) ──────
//
// Owner decision 2026-10-16: a thread a conversation started (a
// coordinator's request thread, opened from a bot's 1:1 or a group chat)
// shows in that conversation as one work card at the position of its root,
// instead of the thread's own cards: who it was handed to, the request, the
// delegate's newest message, its state, and the steps folded inside. A card
// that waits on the owner still shows in the timeline too.
//
// The desktop's Bots page (renderer/components/Bots: botsModel.ts,
// botsTimeline.ts, botsWork.ts re-export these) and the phone's Bots list
// (shared/phoneBots.ts phoneConversationWork) derive it with the same
// functions, so both read one thread as the same work card.
import { dmThreadBot, groupThreadGroup, groupThreadId, type RoomCard, type ThreadId, type ThreadSummary } from './room';
import type { BotTaskView } from './botTask';

/** What the room summaries say about 1:1 threads, per workspace. */
export type ThreadsByWorkspace = Readonly<Record<string, readonly ThreadSummary[] | undefined>>;

/** A room card as a timeline entry (renderer botsModel.ts RoomEntry). */
export type WorkEntry = { kind: 'card'; card: RoomCard };

function threadKeyOf(card: Pick<RoomCard, 'workspaceId' | 'threadId'>): string {
  return threadKey(card.workspaceId, card.threadId);
}

/** A run of one author's messages holds while each follows the last by less than this. */
export const RUN_WINDOW_MS = 10 * 60_000;

/** A delegating bot's message this soon after a work card's root is the one
 *  announcing it (placeWork). */
export const ANNOUNCE_WINDOW_MS = 60_000;

/** A thread as its root's summary line shows it. */
export interface ThreadView {
  workspaceId: string;
  threadId: ThreadId;
  /** The thread's cards after its root. */
  replies: number;
  /** The newest reply's time (the root's when there is none). */
  lastAt: number;
}

/** The key a thread is known by: a thread id is a room's own, so a 1:1
 *  (which spans rooms) keys it with its workspace. */
export function threadKey(workspaceId: string, threadId: ThreadId): string {
  return `${workspaceId}\u0000${threadId}`;
}

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

/** The threads a group chat started (a coordinator's request thread opened
 *  there), by thread key, to the group's own thread — known as a 1:1's are
 *  (dmStartedThreads): the summary's `groupId`, main's opening hop linking
 *  the group or naming the owner's request in it, or main's pointer card in
 *  the group. Pure. */
export function groupStartedThreads(cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): Map<string, ThreadId> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out = new Map<string, ThreadId>();
  for (const [workspaceId, list] of Object.entries(threads)) {
    for (const th of list ?? []) {
      if (th.groupId && !groupThreadGroup(th.threadId)) out.set(threadKeyOf({ workspaceId, threadId: th.threadId }), groupThreadId(th.groupId));
    }
  }
  for (const c of cards) {
    if (c.actor.kind !== 'system') continue;
    const inGroup = groupThreadGroup(c.threadId) ? c.threadId : null;
    const linked = c.refs?.threadId;
    if (inGroup && linked?.startsWith('handoff:')) {
      out.set(threadKeyOf({ workspaceId: c.workspaceId, threadId: linked }), inGroup);
      continue;
    }
    if (!c.threadId.startsWith('handoff:')) continue;
    const request = c.refs?.requestCardId ? byId.get(c.refs.requestCardId) : undefined;
    const owner = groupThreadGroup(linked) ? linked as ThreadId
      : request && request.workspaceId === c.workspaceId && groupThreadGroup(request.threadId) ? request.threadId : null;
    if (owner) out.set(threadKeyOf(c), owner);
  }
  return out;
}

/** The conversation a started thread belongs to: a bot's 1:1 (`botId`) or
 *  a group chat's own thread (`threadId`). */
export type WorkOwner = { botId: string } | { threadId: ThreadId };

/** The thread keys (`workspaceId\0threadId`, threadKey) of the threads this
 *  conversation started. Pure. */
export function startedThreadsOf(owner: WorkOwner, cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): Set<string> {
  const out = new Set<string>();
  if ('botId' in owner) {
    for (const [key, botId] of dmStartedThreads(cards, threads)) if (botId === owner.botId) out.add(key);
  } else {
    for (const [key, group] of groupStartedThreads(cards, threads)) if (group === owner.threadId) out.add(key);
  }
  return out;
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

/** Whether a card waits on the owner's answer: an open question, the live
 *  plan, an open proposal, approval, key or login request (the desktop's
 *  BotsChat.tsx waitsOnOwner). Pure. */
export function waitsOnOwner(card: RoomCard, livePlans: ReadonlySet<string>): boolean {
  if (card.state !== 'open') return false;
  return card.kind === 'question' || awaitsApproval(card, livePlans);
}

/** A started thread as the timeline holds it: its cards in order — `steps`,
 *  folded into the card (the thread's own cards and main's pointer lines
 *  about it in the conversation's thread, "Finished: …"), and `all`, the
 *  steps plus the cards that wait on the owner (shown in the timeline). */
export interface WorkThread {
  workspaceId: string;
  threadId: ThreadId;
  steps: RoomCard[];
  all: RoomCard[];
}

/** The work card's state: a task's worker at work (or no end yet), its
 *  report waiting for review, something waiting on the owner, or ended. */
export type WorkState = 'working' | 'review' | 'needsYou' | 'done' | 'failed' | 'cancelled';

export interface WorkView {
  /** The bot the work was handed to (the opening hop's addressee). */
  delegateId: string | null;
  /** The request's words (the owner's request, else the handoff's title);
   *  null: none known, the reader shows the kind word. */
  title: string | null;
  /** The delegate's newest message in the thread. */
  latest: RoomCard | null;
  state: WorkState;
  /** The newest card's time, waiting cards included. */
  lastAt: number;
  /** A GitHub pull request or issue the work is about. */
  refUrl: string | null;
}

/** main's opening hop line: `<kind> → <name>: <title>` (roomWriter.ts). */
const HOP_LINE = /^([a-z_]+) → [^:]+?: (.+)$/s;
/** main's line for a refused opening hop (roomWriter.ts). */
const REFUSED_LINE = /^Handoff refused \([^)]*\): (.+)$/s;
/** main's pointer in the conversation once the work came back (handoffRouter pointToThread). */
const POINTER_LINE = /^(Finished|Stopped): (.+)$/s;
const GITHUB_REF = /https?:\/\/github\.com\/[^/\s]+\/[^/\s#?]+\/(?:pull|issues)\/\d+/gi;
const FORWARDED = / \(forwarded by wmux\)$/;

/** General, a 1:1 or a group chat: a conversation's own thread. */
function isConversationThread(threadId: unknown): boolean {
  return threadId === 'general' || !!dmThreadBot(threadId) || !!groupThreadGroup(threadId);
}

/** Whether a card is main's line, in a conversation's own thread, about
 *  another thread (the pointer to a started thread: "Finished: …"). */
export function isPointerCard(card: RoomCard): boolean {
  const linked = card.refs?.threadId;
  return card.actor.kind === 'system' && !!linked && isConversationThread(card.threadId) && !isConversationThread(linked);
}

/** The bot a started thread was handed to: the addressee main names on the
 *  thread's opening hop (`refs.botId`), else the first bot other than the
 *  delegating one that wrote there. Pure. */
export function workDelegate(cards: readonly RoomCard[], delegatorId: string | null): string | null {
  for (const c of cards) {
    if (c.actor.kind === 'system' && c.threadId === `handoff:${c.refs?.handoffId}` && c.refs?.botId && HOP_LINE.test(c.title)) return c.refs.botId;
  }
  for (const c of cards) if (c.actor.kind === 'bot' && c.actor.botId !== delegatorId && !isPointerCard(c)) return c.actor.botId;
  return null;
}

/** The work's name for a started thread: the title the delegating bot gave
 *  the handoff, from main's opening hop (delivered or refused) or its
 *  pointer line, else the first line of the owner's request (roomFormat
 *  requestTitles; often only a short reply such as "go ahead"). Pure. */
export function workTitle(cards: readonly RoomCard[], threadId: ThreadId, requestTitle?: (threadId: ThreadId) => string | null): string | null {
  for (const c of cards) {
    if (c.actor.kind !== 'system') continue;
    const opening = c.threadId === threadId && threadId === `handoff:${c.refs?.handoffId}`;
    const hop = opening ? HOP_LINE.exec(c.title)?.[2] ?? REFUSED_LINE.exec(c.title)?.[1] : undefined;
    const pointer = !hop && isPointerCard(c) ? POINTER_LINE.exec(c.title)?.[2] : undefined;
    const line = (hop ?? pointer ?? '').replace(FORWARDED, '').split('\n')[0].trim();
    if (line) return line;
  }
  return requestTitle?.(threadId)?.trim() || null;
}

/** The delegate's newest message in the thread (any other bot's but the
 *  delegating one's when the delegate wrote none). Pure. */
export function workLatest(cards: readonly RoomCard[], delegateId: string | null, delegatorId: string | null): RoomCard | null {
  let other: RoomCard | null = null;
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    if (c.actor.kind !== 'bot' || isPointerCard(c)) continue;
    if (c.actor.botId === delegateId) return c;
    if (!other && c.actor.botId !== delegatorId) other = c;
  }
  return other;
}

/** The task stages whose task is not over. */
const LIVE_STAGE: ReadonlySet<BotTaskView['stage']> = new Set<BotTaskView['stage']>(['working', 'needs_input', 'waiting_slot', 'coded']);

/** An ended task's outcome. */
function endedState(stage: BotTaskView['stage']): WorkState {
  return stage === 'failed' ? 'failed' : stage === 'cancelled' ? 'cancelled' : 'done';
}

/** The state a card on its own says, in thread order (null: none). A
 *  worker's ask for input is not one: what waits on the owner is read from
 *  the open cards and the live tasks. */
function cardState(c: RoomCard): WorkState | null {
  if (c.kind === 'refusal') return 'failed';
  if (c.actor.kind !== 'system') return null;
  switch (c.notice?.code) {
    case 'task.reported': return 'review';
    case 'task.done': return 'done';
    case 'task.failed': return 'failed';
    case 'task.cancelled':
    case 'task.stoppedByOwner': return 'cancelled';
    default: break;
  }
  const pointer = isPointerCard(c) ? POINTER_LINE.exec(c.title) : null;
  if (pointer) return pointer[1] === 'Finished' ? 'done' : 'failed';
  const hop = HOP_LINE.exec(c.title);
  if (hop && hop[1] === 'dispatch') return 'working';
  return null;
}

/** A started thread's state. Something waiting on the owner wins (an open
 *  card, or a task's worker asking for input); then a live task of the
 *  thread (its cards' `refs.taskId`, in the bots' task lists): at work, or
 *  reported and waiting for review; else the newest word — a card's (a
 *  task's end, main's Finished or Stopped line, a refusal, a new dispatch)
 *  or the newest ended task's outcome (a task's end may write no card of
 *  its own) — and, with none, at work. Pure. */
export function workState(cards: readonly RoomCard[], waits: (card: RoomCard) => boolean, tasks: readonly BotTaskView[] = []): WorkState {
  if (cards.some(waits)) return 'needsYou';
  const ids = new Set(cards.map((c) => c.refs?.taskId).filter((id): id is string => !!id));
  const known = tasks.filter((task) => ids.has(task.taskId));
  const live = known.filter((task) => LIVE_STAGE.has(task.stage));
  if (live.some((task) => task.stage === 'needs_input')) return 'needsYou';
  if (live.some((task) => task.stage === 'working' || task.stage === 'waiting_slot')) return 'working';
  if (live.length > 0) return 'review';
  let state: WorkState = 'working';
  let saidAt = -Infinity;
  for (const c of cards) {
    const said = cardState(c);
    if (said) {
      state = said;
      saidAt = c.at;
    }
  }
  const ended = known.reduce<BotTaskView | null>((m, task) => (!m || task.updatedAt > m.updatedAt ? task : m), null);
  return ended && ended.updatedAt >= saidAt ? endedState(ended.stage) : state;
}

/** The GitHub pull request or issue a started thread is about: one its
 *  tasks opened (`prUrl`, by task id), else the newest one a card links. Pure. */
export function workRef(cards: readonly RoomCard[], prUrl?: (taskId: string) => string | null): string | null {
  for (let i = cards.length - 1; i >= 0; i--) {
    const taskId = cards[i].refs?.taskId;
    const url = taskId ? prUrl?.(taskId) : null;
    if (url) return url;
  }
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    const linked = c.refs?.url && /^https?:\/\/github\.com\/[^/\s]+\/[^/\s#?]+\/(?:pull|issues)\/\d+/i.test(c.refs.url) ? c.refs.url : null;
    if (linked) return linked;
    const found = `${c.title}\n${c.body ?? ''}`.match(GITHUB_REF);
    if (found) return found[found.length - 1];
  }
  return null;
}

/** Everything the work card shows for a started thread. Pure. */
export function workView(work: WorkThread, opts: {
  delegatorId: string | null;
  waits: (card: RoomCard) => boolean;
  tasks?: readonly BotTaskView[];
  requestTitle?: (threadId: ThreadId) => string | null;
  prUrl?: (taskId: string) => string | null;
}): WorkView {
  const delegateId = workDelegate(work.all, opts.delegatorId);
  return {
    delegateId,
    title: workTitle(work.all, work.threadId, opts.requestTitle),
    latest: workLatest(work.all, delegateId, opts.delegatorId),
    state: workState(work.all, opts.waits, opts.tasks),
    lastAt: work.all.reduce((m, c) => Math.max(m, c.at), 0),
    refUrl: workRef(work.all, opts.prUrl),
  };
}

/** The main timeline's cards and the threads behind them: General cards
 *  (and a 1:1's or a group chat's thread: the conversation itself), each
 *  thread's root (first
 *  card) with its summary, any thread card that waits on the owner, and
 *  each thread's newest bot reply (`surfaced`). A thread the conversation
 *  started (`started`, by threadKey) is one work card instead (`work`, by
 *  its first folded card's id, which stands in `main` for it): its cards and
 *  main's pointer lines about it fold in, but a card that waits on the owner
 *  stays in `main` too. */
export function splitThreads(cards: readonly RoomCard[], waits: (card: RoomCard) => boolean, started?: ReadonlySet<string>): { main: RoomCard[]; threads: Map<string, ThreadView>; surfaced: Set<string>; work: Map<string, WorkThread> } {
  const main: RoomCard[] = [];
  const byKey = new Map<string, ThreadView>();
  const rootOf = new Map<string, string>();
  const lastBotReply = new Map<string, string>();
  const inMain = (card: RoomCard) => card.threadId === 'general' || dmThreadBot(card.threadId) !== null || groupThreadGroup(card.threadId) !== null;
  /** The started thread a card folds into, or null. */
  const workOf = (card: RoomCard): { key: string; threadId: ThreadId } | null => {
    if (!started || started.size === 0) return null;
    const threadId = inMain(card) ? (isPointerCard(card) ? card.refs!.threadId! : null) : card.threadId;
    const key = threadId ? threadKey(card.workspaceId, threadId) : null;
    return key && threadId && started.has(key) ? { key, threadId } : null;
  };
  for (const card of cards) {
    if (inMain(card) || workOf(card)) continue;
    const key = threadKey(card.workspaceId, card.threadId);
    if (!rootOf.has(key)) rootOf.set(key, card.id);
    else if (card.actor.kind === 'bot') lastBotReply.set(key, card.id);
  }
  const surfaced = new Set(lastBotReply.values());
  const works = new Map<string, WorkThread & { anchor?: string }>();
  for (const card of cards) {
    const folds = workOf(card);
    if (folds) {
      let w = works.get(folds.key);
      if (!w) works.set(folds.key, (w = { workspaceId: card.workspaceId, threadId: folds.threadId, steps: [], all: [] }));
      w.all.push(card);
      // The thread's first card read places the work card; one that waits
      // on the owner also shows as itself.
      const first = !w.anchor;
      if (first) w.anchor = card.id;
      if (waits(card)) {
        main.push(card);
        continue;
      }
      w.steps.push(card);
      if (first) main.push(card);
      continue;
    }
    if (inMain(card)) {
      main.push(card);
      continue;
    }
    const key = threadKey(card.workspaceId, card.threadId);
    const view = byKey.get(key);
    if (!view) {
      byKey.set(key, { workspaceId: card.workspaceId, threadId: card.threadId, replies: 0, lastAt: card.at });
      main.push(card);
      continue;
    }
    view.replies += 1;
    view.lastAt = Math.max(view.lastAt, card.at);
    if (waits(card) || surfaced.has(card.id)) main.push(card);
  }
  const threads = new Map<string, ThreadView>();
  for (const [key, view] of byKey) threads.set(rootOf.get(key)!, view);
  const work = new Map<string, WorkThread>();
  for (const { anchor, ...w } of works.values()) if (anchor) work.set(anchor, w);
  return { main, threads, surfaced, work };
}

/** Main's hop line opens a thread a few milliseconds before the delegating
 *  bot's own message announcing it lands: a work card goes right after
 *  that message — the delegating bot's next card in the conversation's own
 *  thread within ANNOUNCE_WINDOW_MS, or later in its run when it is its
 *  dispatch card or names that handoff or thread — so the bubble comes
 *  first, then the card. Without one it keeps its root's place. The owner's
 *  message ends the search. The delegating bot is the 1:1's (`workAuthor`),
 *  else the nearest of `workCandidates` above the root (any of them when
 *  none is), else the nearest bot above other than the delegate. Cards
 *  placed after one message keep their order; each moved card is read at
 *  that message's time (`at`), for separators and runs. Pure. */
export function placeWork(entries: readonly WorkEntry[], opts: { work?: ReadonlyMap<string, WorkThread>; workAuthor?: string; workCandidates?: ReadonlySet<string> }): { entries: WorkEntry[]; at: Map<string, number> } {
  const at = new Map<string, number>();
  if (!opts.work || opts.work.size === 0) return { entries: [...entries], at };
  const isConversation = (threadId: ThreadId) => threadId === 'general' || !!dmThreadBot(threadId) || !!groupThreadGroup(threadId);
  /** Announcement card id → the anchors placed after it, in order. */
  const after = new Map<string, string[]>();
  const moved = new Set<string>();
  for (let from = 0; from < entries.length; from++) {
    const anchor = entries[from].card;
    const work = opts.work.get(anchor.id);
    if (!work) continue;
    const delegate = workDelegate(work.all, null);
    let delegator: string | null = opts.workAuthor ?? null;
    for (let i = from - 1; i >= 0 && !delegator; i--) {
      const c = entries[i].card;
      if (c.actor.kind === 'bot' && c.actor.botId !== delegate && (!opts.workCandidates || opts.workCandidates.has(c.actor.botId))) delegator = c.actor.botId;
    }
    const isDelegator = (botId: string) => (delegator ? botId === delegator : opts.workCandidates ? opts.workCandidates.has(botId) : botId !== delegate);
    const handoffId = work.threadId.startsWith('handoff:') ? work.threadId.slice(8) : null;
    for (let i = from + 1; i < entries.length; i++) {
      const c = entries[i].card;
      const gap = c.at - anchor.at;
      if (c.actor.kind === 'human' || gap >= RUN_WINDOW_MS) break;
      if (c.actor.kind !== 'bot' || !isDelegator(c.actor.botId) || c.workspaceId !== anchor.workspaceId || !isConversation(c.threadId)) continue;
      const names = c.kind === 'dispatch' || (!!handoffId && c.refs?.handoffId === handoffId) || c.refs?.threadId === work.threadId;
      if (gap <= ANNOUNCE_WINDOW_MS || names) {
        const list = after.get(c.id) ?? [];
        list.push(anchor.id);
        after.set(c.id, list);
        moved.add(anchor.id);
        at.set(anchor.id, c.at);
        break;
      }
    }
  }
  const byId = new Map(entries.map((e) => [e.card.id, e]));
  const out: WorkEntry[] = [];
  for (const e of entries) {
    if (moved.has(e.card.id)) continue;
    out.push(e);
    for (const id of after.get(e.card.id) ?? []) out.push(byId.get(id)!);
  }
  return { entries: out, at };
}

/** The pull request each task opened, as a GitHub URL (`prUrl` for
 *  workView): a task's `pr` on a bot whose repository is on GitHub. Pure. */
export function taskPrUrls(bots: ReadonlyArray<{ repoKey?: string; tasks?: readonly BotTaskView[] }>): Map<string, string> {
  const urls = new Map<string, string>();
  for (const b of bots) {
    const repo = b.repoKey;
    if (!repo || !/^github\.com\//.test(repo)) continue;
    for (const task of b.tasks ?? []) if (task.pr) urls.set(task.taskId, `https://${repo}/pull/${task.pr.number}`);
  }
  return urls;
}
