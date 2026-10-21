// ─── One Bots conversation, as a chat ────────────────────────────────────
//
// A 1:1 conversation is a bot's own room cards and the owner's messages to
// it; a group chat is the owner's, its own thread of its workspace's room
// (botsModel.ts). Messages are
// bubbles in runs, as the reference messenger draws them (owner decision
// 2026-10-14): a bot's on the left in soft fills — in a room its name above
// the run's first bubble — and its avatar once, beside the run's last; the
// owner's on the right. A run is one author's messages within ten minutes.
// The date and time divide days and long quiets; consecutive system cards
// of one thread merge into one quiet line (botsTimeline.ts). A card that
// waits on the owner — an open question, plan, proposal, approval, key or
// login request — stays a distinct card with its answers inside its run
// (the room's own RoomCard / CardAnswers). PR and issue links are chips.
// The column is capped at 44rem; the composer is one pill with "+".
//
// Threads: a non-General thread shows as its first card with "N replies ·
// last 14:02" under it; that line (or the thread's chip) opens the thread in
// a side panel with its own composer, and the main timeline stays put. A
// card that waits on the owner shows in the main timeline whatever its
// thread.
//
// Work the conversation handed off (owner decision 2026-10-16): a thread it
// started — a coordinator's request thread — is one work card at its root's
// position instead of the thread's cards, inside the delegating bot's run
// (BotsWorkCard). A card in it that waits on the owner still shows.
//
// What is happening now sits in the working rail right above the composer:
// "<bot> working · 0:14" with its queue and a neutral Stop (the turn only;
// the profile's Stop ends the bot's workers too), then the bot's workers
// and tasks as compact rows with Open (the worker panel beside the chat,
// BotsWorkerPanel; never switching the active workspace) or Resume. While
// the bots are off the rail keeps only the worker rows and their Open.
//
// The owner never reads an internal id: a thread chip names a task by its
// title (a request, plan or report by its kind word), a routine card shows
// its schedule, a refusal its plain sentences (roomFormat.ts). A bot's
// greeting is its 1:1's; a group chat shows no greeting and no "joined"
// line — its bots introduce themselves when the owner first writes there.
// An empty 1:1 opens with the bot's face, job and a few first messages to
// pick from.
//
// While the bots are off the conversation is read-only: no answers and no
// composer, only the reason under it.
//
// Sending: a 1:1 message is a post in the bot's 1:1 thread (`dm:<botId>`) of
// its workspace's room that mentions that one bot (main wakes it alone, in
// that thread). A group chat's message is a post in its thread that goes to
// every bot of the group — main wakes each — or, in a group with a
// coordinator, to that coordinator alone, unless bots are picked: the
// recipients control above the box ("To: everyone ▾" or "To: <lead> ▾", a
// checkbox per bot),
// or an `@Name` of a group bot anywhere in the text (resolved here at send;
// main reads only the field). The picks reset after each send. Typing `@`
// in a group suggests its bots.
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { dmThreadBot, dmThreadId, groupThreadGroup, type RoomCard as RoomCardData, type ThreadId, type ThreadSummary } from '../../../shared/room';
import { FOCUS_RING } from '../focusRing';
import Button from '../ui/Button';
import Select from '../ui/Select';
import Popover from '../ui/Popover';
import { IconFanOut, IconImage, IconPlus } from '../icons';
import { ChatAttachmentChips } from '../Chat/ChatAttachmentViews';
import type { ChatAttachment } from '../Chat/chatAttachments';
import { CardPhotos, ROOM_PHOTO_LIMIT, isRoomPhotoPath, photoOnlyCard, registerBotsDropTarget } from './BotsPhotos';
import BotsFilePanel, { CardFiles, type OpenRoomFile } from './BotsFiles';
import { renderBrainMarkdown, type MarkdownOptions } from '../shared/BrainMarkdown';
import { getLocale } from '../../i18n';
import { normalizeRepoKey } from '../../../shared/repoKey';
import { roomsApi, type RoomsApi } from '../../hooks/useRoomSync';
import { useStore } from '../../stores';
import { getFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from '../Room/factoryPorts';
import { RoomCard, useIdLabels } from '../Room/RoomCard';
import { CardAnswers, useWorkspaceNames } from '../Room/CardAnswers';
import { ApprovePendingChip } from '../Room/ApprovalAnswers';
import { pendingForChip, useApprovals } from '../Room/approvalsStore';
import { PresenceDot, botActionsFor, botPresence } from '../Room/BotChips';
import { deliveryLine, deliveryTaken, photoPostParams, roomLead, roomPostParams, sentFrom, useMentionPicks, type SentTo } from '../Room/RoomComposer';
import { actorLabel, botKindLabel, cardResumeTaskId, cardTone, isRefThread, kindLabel, onceText, ownerCardText, planTextWithNames, requestTitles, threadLabel, threadRef, type IdLabels, type RoomActorView } from '../Room/roomFormat';
import { BOT_JOB_MAX, botTemplate, delegatesFromConversation, normalizeBotJob, type BotPresence, type BotProfile as BotProfileData } from '../../../shared/bot';
import { DEFAULT_BOT_WORKER_AGENT, botWorkerAgentLabel, type BotWorkerAgentOption } from '../../../shared/botWorkerAgent';
import { pickFolderDialog, templateJob } from '../Settings/FactoryTab';
import BotAvatar, { botHueIndex, botIdentityColor, noteRemovedBotHues } from '../Room/BotAvatar';
import { RoomAvatar } from './BotsAvatar';
import { awaitsApproval, conversationCards, groupViewCards, livePlanIds, taskBubbles, conversationTurns, type BotTreeRow, type BotWorker, type Conversation, type RoomEntry } from './botsModel';
import BotsWorkerTree, { TaskVerification, treeRowLabel } from './BotsWorkerTree';
import { loadWholeThread } from './useBots';
import { loadRoomActors } from '../../hooks/useRoomSync';
import { useShallow } from 'zustand/react/shallow';
import type { BotTaskView } from '../../../shared/botTask';
import { botCanDo } from './botsProfile';
import { BotConnections } from './BotConnections';
import { BotRecipeChecklist } from './BotRecipes';
import { BotSkills } from './BotSkills';
import { BotMemory } from './BotMemory';
import { BotCommands } from './BotCommands';
import { BotToday } from './BotToday';
import { BrainModelLine, WorkerModelLine } from './BotModelLines';
import { stopBotSummary, useWorkerStopUnfinished, type BotsStopPort } from './botsStop';
import { InlineConfirm } from './InlineConfirm';
import BotsWorkerPanel from './BotsWorkerPanel';
import { displayWorkspaceName } from '../../utils/fanoutProvenance';
import { BOTS_SESSION_START, selectWorkerPanelHost } from '../../stores/slices/roomSlice';
import { routineScheduleText, routineStateText, useBotRoutines } from '../Schedules/BotRoutines';
import { buildTimeline, clockTime, elapsed, fullTime, hasKindWord, liveNewAfter, separatorLabel, splitThreads, threadCards, type ThreadView, type TimelineItem } from './botsTimeline';
import { conversationStartedThreads, workView } from './botsWork';
import BotsWorkCard from './BotsWorkCard';
import BotsWorkflowCard from './BotsWorkflowCard';
import { countNewWorkflows, withWorkflows, type WorkflowTimelineItem } from './botsWorkflow';
import { useConversationWorkflows } from './useBotWorkflows';
import '../Chat/chatMono.css';

const EMPTY_TREE: readonly BotTreeRow[] = [];

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A system card's body folds to two lines when it is longer than this or
 *  has more than one line. */
const SYSTEM_FOLD_CHARS = 140;

/** The cards a conversation shows, narrowed to one thread when asked: its
 *  own cards and those that link it (an approval card posted where the bot
 *  talks with the owner links its PR's thread). Pure. */
export function chatCards(
  conversation: Conversation,
  roomCards: readonly RoomCardData[],
  thread: ThreadId | null,
  threads: Readonly<Record<string, readonly ThreadSummary[] | undefined>> = {},
): RoomCardData[] {
  // A 1:1 is handed every room's cards (botConversationCards); a group chat
  // its room's, of which it shows its own thread and what that started.
  const own = conversation.kind === 'bot' ? conversationCards(roomCards, conversation.row.bot.id, { lone: conversation.lone, threads }) : groupViewCards(roomCards, conversation.group, threads);
  return thread ? own.filter((c) => c.threadId === thread || c.refs?.threadId === thread) : own;
}

/** General, a 1:1 or a group chat: a conversation, never a thread to open. */
function isConversationThread(threadId: ThreadId): boolean {
  return threadId === 'general' || !!dmThreadBot(threadId) || !!groupThreadGroup(threadId);
}

/** The thread a card links besides its own (its subject's), or null. */
function linkedThread(card: RoomCardData): ThreadId | null {
  const linked = card.refs?.threadId;
  return linked && linked !== card.threadId && !isConversationThread(linked) ? linked : null;
}

/** Why a 1:1 message cannot be sent right now, or null: the bot is off. The
 *  message mentions this bot, so it reaches this bot alone. Pure. */
export function oneToOneRefusal(row: FactoryBotRow, t: T): string | null {
  return row.bot.enabled ? null : t('botsPage.botOff', { name: row.bot.name });
}

/** The quiet line by a 1:1's composer while the owner has paused its bot:
 *  a message still goes, and the bot reads it once resumed. Null otherwise.
 *  Pure. */
export function pausedHint(row: FactoryBotRow, t: T): string | null {
  return row.bot.enabled && row.bot.parked?.reason === 'human' ? t('botsPage.pausedHint', { name: row.bot.name }) : null;
}

/** The composer's placeholder: a Lead's empty 1:1 says what to ask it for
 *  (the first task after adding it), any other "Message <name>". Pure. */
export function composerHint(conversation: Conversation, shown: number, title: string, t: T): string {
  if (conversation.kind === 'bot' && conversation.row.bot.role === 'lead' && shown === 0) return t('botsPage.leadHint', { name: title });
  return t('botsPage.messageTo', { name: title });
}

function newClientPostId(): string {
  return `bots-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A task's title by its id, from the bots' task lists (null: unknown). */
type TaskTitleOf = (taskId: string) => string | null;
type RequestTitleOf = (threadId: ThreadId) => string | null;

/** A pull request's or an issue's mark (12px line icon). */
function RefIcon({ kind }: { kind: 'pr' | 'issue' }) {
  return kind === 'pr' ? (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true" className="shrink-0">
      <circle cx="3" cy="2.6" r="1.3" /><circle cx="3" cy="9.4" r="1.3" /><circle cx="9" cy="9.4" r="1.3" />
      <path d="M3 3.9v4.2M9 8.1V5.2a1.8 1.8 0 0 0-1.8-1.8H5.4M6.6 2.2 5.4 3.4l1.2 1.2" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true" className="shrink-0">
      <circle cx="6" cy="6" r="4.6" /><circle cx="6" cy="6" r="1" fill="currentColor" />
    </svg>
  );
}

/** A GitHub pull request or issue URL as its parts, or null. Pure. */
export function githubRef(url: string): { repoKey: string; kind: 'pr' | 'issue'; number: number } | null {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/(pull|issues)\/(\d+)(?:[/#?].*)?$/i.exec(url.trim());
  const repoKey = m ? normalizeRepoKey(`github.com/${m[1]}/${m[2]}`) : null;
  if (!m || !repoKey) return null;
  return { repoKey, kind: m[3].toLowerCase() === 'pull' ? 'pr' : 'issue', number: Number(m[4]) };
}

/** A PR or issue link in a message, as a compact chip: its mark, `#N` and
 *  its title when a thread of this room knows it. It opens that thread
 *  beside the chat, else the page on GitHub. */
function RefChip({ url, label, title, onOpen }: { url: string; label: string | null; title: string | null; onOpen: (() => void) | null }) {
  const ref = githubRef(url)!;
  const text = title ?? (label && label !== url ? label : null);
  return (
    <button
      type="button"
      data-bots-ref-chip={`${ref.kind}:${ref.repoKey}#${ref.number}`}
      title={url}
      onClick={() => { if (onOpen) onOpen(); else window.open(url, '_blank'); }}
      className={`wmux-bots-ref-chip ${FOCUS_RING}`}
    >
      <RefIcon kind={ref.kind} />
      <span className="shrink-0 font-mono">{`#${ref.number}`}</span>
      {text && <span className="min-w-0 truncate">{text}</span>}
    </button>
  );
}

/** A bot's name above its run, in its identity colour (an unknown author
 *  stays neutral). */
function botNameStyle(botId: string): React.CSSProperties {
  return { color: botId ? botIdentityColor(botId) : 'var(--text-sub)' };
}

/** The `@Name` mentions of these bots in a message, longest name first (so
 *  "@Ada Lovelace" is not read as "@Ada"); null when there are none. Pure. */
export function mentionPattern(names: readonly string[]): RegExp | null {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (list.length === 0) return null;
  const escaped = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}_.@])@(${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
}

/** What may not stand right before an `@` that names a bot (an address
 *  such as `me@host` is no mention). */
const BEFORE_MENTION = /[\p{L}\p{N}_.@]/u;
const LATIN_WORD = /[A-Za-z0-9_]/;

/** The bots among `candidates` named by an `@Name` anywhere in the text,
 *  in the order typed, each once (owner, 2026-10-15: a typed `@Name`
 *  addresses that bot wherever it stands). Each `@` is read against every
 *  bot in `known` (the candidates too): a longer name wins over one it
 *  starts with ("@Ada Lovelace" is not "@Ada", wherever Ada Lovelace
 *  lives), a candidate wins a shared name; case does not matter. A Latin
 *  name ends at a non-word character; a name ending in another script may
 *  run straight into the next word (a Korean particle: "@대장이"). An `@`
 *  naming no candidate is plain text. Pure. */
export function textMentions(text: string, candidates: readonly FactoryBotRow[], known: readonly FactoryBotRow[] = candidates): string[] {
  if (!text.includes('@')) return [];
  const lower = text.toLowerCase();
  const allowed = new Set(candidates.map((r) => r.bot.id));
  const named = [...new Map([...candidates, ...known].map((r) => [r.bot.id, r])).values()]
    .map((r) => ({ id: r.bot.id, name: r.bot.name.trim().toLowerCase(), here: allowed.has(r.bot.id) ? 0 : 1 }))
    .filter((r) => r.name)
    .sort((a, b) => b.name.length - a.name.length || a.here - b.here);
  const out: string[] = [];
  for (let at = lower.indexOf('@'); at >= 0; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && BEFORE_MENTION.test(text.charAt(at - 1))) continue;
    for (const r of named) {
      if (!lower.startsWith(r.name, at + 1)) continue;
      const next = lower.charAt(at + 1 + r.name.length);
      if (next && LATIN_WORD.test(r.name.charAt(r.name.length - 1)) && LATIN_WORD.test(next)) continue;
      if (allowed.has(r.id) && !out.includes(r.id)) out.push(r.id);
      break;
    }
  }
  return out;
}

/** The `@` being typed right before the caret — its index and the letters
 *  after it — or null when the caret is not in one. Pure. */
export function mentionQuery(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /@([^\s@]{0,40})$/u.exec(before);
  if (!m) return null;
  const at = before.length - m[0].length;
  if (at > 0 && BEFORE_MENTION.test(before.charAt(at - 1))) return null;
  return { at, query: m[1] };
}

/** The bots a `@query` suggests: those whose name starts with it, in the
 *  room's order. Pure. */
export function mentionSuggestions(candidates: readonly FactoryBotRow[], query: string): FactoryBotRow[] {
  const q = query.toLowerCase();
  return candidates.filter((r) => r.bot.name.trim() && r.bot.name.trim().toLowerCase().startsWith(q));
}

/** The thread chip under a bubble (General has none): a PR or issue
 *  reference (with its mark), else the thread's name in words; its id only
 *  in the tooltip. */
function ThreadChip({ threadId, t, onPick, taskTitle, requestTitle }: { threadId: ThreadId; t: T; onPick: (id: ThreadId) => void; taskTitle?: TaskTitleOf; requestTitle?: RequestTitleOf }) {
  // General and a 1:1 are conversations, never a thread to open.
  if (isConversationThread(threadId)) return null;
  const label = threadLabel(threadId, t, taskTitle, requestTitle);
  const ref = isRefThread(threadId);
  return (
    <button
      type="button"
      data-bots-thread-chip={threadId}
      onClick={() => onPick(threadId)}
      title={ref ? t('botsPage.showThread', { thread: label }) : `${t('botsPage.showThread', { thread: label })} · ${threadRef(threadId, t)}`}
      className={`inline-flex h-[20px] max-w-full items-center gap-1 px-1.5 rounded-[var(--chip-radius)] bg-[var(--selection)] ${ref ? 'font-mono' : ''} text-[11px] text-[var(--text-sub)] hover:bg-[var(--selection-hover)] ${FOCUS_RING}`}
    >
      {/^pr:/.test(threadId) && <RefIcon kind="pr" />}
      {/^issue:/.test(threadId) && <RefIcon kind="issue" />}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/** Undo on a bot's `job_changed` card: the job it replaced, written back
 *  as the owner (bot.update). */
function JobChangeUndo({ card, t, jobPort }: { card: RoomCardData; t: T; jobPort: Pick<FactoryBotPort, 'update'> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = card.jobChange;
  const update = jobPort.update;
  if (!change || !update) return null;
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await update(change.botId, { job: change.previous });
      if (!r.ok) setError(r.message || t('room.jobChanged.undoFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-job-change-undo className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="secondary" data-testid="bots-job-undo" disabled={busy} onClick={() => void undo()}>{t('room.jobChanged.undo')}</Button>
      {error && <p role="alert" className="basis-full text-[11px] text-[var(--accent-red)]">{error}</p>}
    </div>
  );
}

/** What every row of a timeline reads. */
interface RowCtx {
  t: T;
  bots: readonly FactoryBotRow[];
  actors: Readonly<Record<string, RoomActorView>>;
  api?: RoomsApi | null;
  now?: number;
  /** The bots are off: no answers. */
  readOnly: boolean;
  jobPort?: Pick<FactoryBotPort, 'update'>;
  nameOf: (id: string) => string | null;
  botNames: readonly string[];
  taskTitle: TaskTitleOf;
  /** A request thread's name: the owner's words that opened it. */
  requestTitle: RequestTitleOf;
  idLabels: IdLabels;
  /** The delivery line of each message sent from here. */
  sent: Readonly<Record<string, SentTo[] | null>>;
  /** The messages whose bot has been seen taking them up: their line stays
   *  "Sent" while the bot runs later turns. */
  started: ReadonlySet<string>;
  /** Opens a thread in the side panel. */
  onThread: (workspaceId: string, threadId: ThreadId) => void;
  /** The thread a side panel shows: its rows name no chip for it. */
  hideThread?: ThreadId;
  /** A 1:1's bot: another bot speaking in its 1:1 (work its 1:1 started)
   *  is named above its run, as in a room. */
  selfBot?: string;
  onOpenBot?: (botId: string) => void;
  /** How message text renders: links (PR and issue links as chips), rich
   *  code blocks. */
  markdown: MarkdownOptions;
  /** A stopped worker's Resume on the system card that says it can resume
   *  (absent: none, as while the bots are off): whether the task's worker
   *  is resumable now, and the resume. */
  resume?: { resumable: (taskId: string) => boolean; run: (taskId: string) => Promise<void> };
  /** What a work card reads (absent: no work cards): which cards wait on
   *  the owner, the bots' tasks, and the pull request a task opened. */
  work?: { waits: (card: RoomCardData) => boolean; tasks: readonly BotTaskView[]; prUrl: (taskId: string) => string | null };
  /** Opens a file a bot attached to its card in the side panel. */
  onOpenFile?: (open: OpenRoomFile) => void;
  /** The file the side panel shows now. */
  shownFileId?: string | null;
}

/** A bot message's prose: the title and the body as one text in one colour,
 *  then the answers it waits for (a plan's Approve / Edit / Decline…), and a
 *  `job_changed` card's Undo. */
function BotProse({ card, answers, waiting, ctx }: { card: RoomCardData; answers: boolean; waiting: boolean; ctx: RowCtx }) {
  const { t } = ctx;
  const [editing, setEditing] = useState(false);
  // The answers can leave mid-edit (the plan was answered elsewhere, a newer
  // one superseded it, the bots were turned off): the body comes back.
  useEffect(() => { if (!answers) setEditing(false); }, [answers]);
  const isPlan = card.kind === 'plan';
  const shown = ownerCardText(card, ctx.botNames, ctx.idLabels);
  const rawTitle = isPlan ? planTextWithNames(shown.title, ctx.nameOf, t) : shown.title;
  const rawBody = (isPlan ? planTextWithNames(shown.body, ctx.nameOf, t) : shown.body).trim();
  // A body that repeats the title is printed once (a card with answers keeps
  // its body below them, where an edit replaces it).
  const { title, body } = answers ? { title: rawTitle, body: rawBody } : onceText(rawTitle, rawBody);
  const tone = cardTone(card);
  return (
    <>
      {(hasKindWord(card) || (tone && tone.word !== 'done')) && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]" data-bots-kind>
          {hasKindWord(card) && (
            <span className={card.kind === 'refusal' ? 'text-[var(--accent-red)]' : card.kind === 'budget' ? 'text-[var(--accent-yellow)]' : waiting ? 'text-[var(--attention-text)]' : undefined}>
              {kindLabel(card.kind, t)}
            </span>
          )}
          {tone && tone.word !== 'done' && (
            <span data-card-verdict={tone.word} className={tone.tone === 'danger' ? 'text-[var(--accent-red)]' : undefined}>{t(`room.verdict.${tone.word}`)}</span>
          )}
        </div>
      )}
      <div className="wmux-bots-prose break-words">{renderBrainMarkdown(title, ctx.markdown)}</div>
      {answers && <CardAnswers card={card} workspaceId={card.workspaceId} t={t} api={ctx.api === undefined ? roomsApi() : ctx.api} onEditingChange={setEditing} readOnly={ctx.readOnly} />}
      {body && !editing && (
        <div data-card-body className="wmux-bots-prose mt-1 break-words">
          {renderBrainMarkdown(body, ctx.markdown)}
        </div>
      )}
      {card.kind === 'job_changed' && ctx.jobPort && <JobChangeUndo card={card} t={t} jobPort={ctx.jobPort} />}
    </>
  );
}

/** "N replies · last 14:02" under a thread's root: opens the thread. */
function ThreadSummaryLine({ thread, ctx }: { thread: ThreadView; ctx: RowCtx }) {
  const { t } = ctx;
  const label = thread.replies === 1
    ? t('botsPage.chat.repliesOne', { time: clockTime(thread.lastAt) })
    : t('botsPage.chat.replies', { count: thread.replies, time: clockTime(thread.lastAt) });
  return (
    <button
      type="button"
      data-bots-thread-summary={thread.threadId}
      onClick={() => ctx.onThread(thread.workspaceId, thread.threadId)}
      title={fullTime(thread.lastAt)}
      className={`wmux-bots-thread-summary ${FOCUS_RING}`}
    >
      {label}
    </button>
  );
}

/** One message in its run: a bot's on the left — its name above the run's
 *  first bubble (in a room), its avatar once, beside the run's last bubble —
 *  the owner's on the right. A bubble is a soft fill with no border; a card
 *  that waits on the owner is a distinct card inside the run. */
function MessageRow({ item, ctx, group }: { item: Extract<TimelineItem, { kind: 'message' }>; ctx: RowCtx; group: boolean }) {
  const { card, continuation, runEnd, waiting, thread, inThread } = item;
  const { t } = ctx;
  const human = card.actor.kind === 'human';
  const botId = card.actor.kind === 'bot' ? card.actor.botId : '';
  const botRow = ctx.bots.find((b) => b.bot.id === botId);
  const role = botRow?.bot.role ?? ctx.actors[botId]?.role;
  // An outside agent the owner let in (shared/guestBots.ts): always named,
  // always marked external.
  const guest = card.kind === 'guest';
  const showName = guest || group || (!!ctx.selfBot && !!botId && botId !== ctx.selfBot);
  const name = human ? t('room.actor.you')
    : guest ? t('botsPage.guest.author', { name: card.guest?.name ?? t('botsPage.guest.unnamed') })
    : actorLabel(card.actor, t, ctx.bots, ctx.actors);
  // A bot the runtime no longer lists still gets a face: its name, picture
  // and colour as the room knows them (a removed bot's from its tombstone).
  const known = ctx.actors[botId];
  const face = botRow?.bot ?? (role ? { id: botId, name: known?.name ?? name, role, ...(known?.avatar ? { avatar: known.avatar } : {}) } : null);
  // An open question is the room's own card (its own header and border,
  // answered in place); with the bots off it reads as a bubble.
  const question = card.kind === 'question' && !ctx.readOnly;
  // An approval card always shows its request's state (answers only while
  // the bots run); a plan or proposal its answers while it waits.
  const answers = !human && ((!ctx.readOnly && waiting) || card.kind === 'approval');
  const line = human && card.id in ctx.sent ? deliveryLine(ctx.sent[card.id], ctx.bots, t, ctx.started.has(card.id), ctx.actors) : null;
  const linked = linkedThread(card);
  const chip = (id: ThreadId) => <ThreadChip threadId={id} t={t} onPick={(th) => ctx.onThread(card.workspaceId, th)} taskTitle={ctx.taskTitle} requestTitle={ctx.requestTitle} />;
  // A thread's root names its thread only when the name says something (a
  // PR, an issue, a task's title): a bare "Request" under a question card
  // leads nowhere its summary line does not.
  const named = isRefThread(card.threadId) || (/^task:/.test(card.threadId) && !!ctx.taskTitle(card.threadId.slice(5)))
    || (/^handoff:/.test(card.threadId) && !!ctx.requestTitle(card.threadId));
  const own = !isConversationThread(card.threadId) && card.threadId !== ctx.hideThread && !(thread && !named);
  const link = linked && linked !== ctx.hideThread ? linked : null;
  const chips = (own || link || line) && (
    <div className={`mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 ${human ? 'justify-end' : ''}`}>
      {own && inThread && <span data-bots-in-thread className="text-[11px] text-[var(--text-muted)]">{t('botsPage.chat.inThread')}</span>}
      {own && chip(card.threadId)}
      {link && chip(link)}
      {line && <span data-bots-delivery className="text-[11px] text-[var(--text-muted)]">{line}</span>}
    </div>
  );
  if (human) {
    return (
      <div
        className={`wmux-bots-msg is-owner${continuation ? ' is-continuation' : ''}`}
        data-room-card-id={card.id}
        data-bots-bubble="owner"
        data-continuation={continuation ? 'true' : undefined}
      >
        <div className="wmux-bots-msg-main">
          <CardPhotos card={card} api={ctx.api} t={t} />
          {/* A photo-only card's title is wmux's placeholder: no words drawn. */}
          {photoOnlyCard(card) ? <span className="sr-only">{`${name}: ${t('room.photo.count', { count: card.attachments?.length ?? 0 })}`}</span> : (
            <div className="wmux-bots-bubble wmux-bots-bubble-owner wmux-bots-prose" title={fullTime(card.at)}>
              <span className="sr-only">{`${name}: `}</span>
              {renderBrainMarkdown((card.body?.trim() ? card.body : card.title).trim(), ctx.markdown)}
            </div>
          )}
          {chips}
          {thread && thread.replies > 0 && <ThreadSummaryLine thread={thread} ctx={ctx} />}
        </div>
      </div>
    );
  }
  return (
    <div
      className={`wmux-bots-msg${continuation ? ' is-continuation' : ''}`}
      data-room-card-id={question ? undefined : card.id}
      data-bots-bubble={question ? 'card' : 'bot'}
      data-card-kind={card.kind}
      data-bots-guest={guest ? 'true' : undefined}
      data-continuation={continuation ? 'true' : undefined}
      data-run-end={runEnd ? 'true' : undefined}
      data-waits-on-owner={waiting && !question ? 'true' : undefined}
    >
      <div className="wmux-bots-msg-gutter">{runEnd && face ? <BotAvatar bot={face} size={28} /> : null}</div>
      <div className="wmux-bots-msg-main">
        {!continuation && showName && (
          <div className="wmux-bots-msg-head" data-bots-msg-head>
            <span className="truncate" style={botNameStyle(botId)}>{name}</span>
          </div>
        )}
        {question ? (
          <RoomCard card={card} workspaceId={card.workspaceId} t={t} bots={ctx.bots} roomsBridge={ctx.api} now={ctx.now} />
        ) : (
          <div className={waiting ? 'wmux-bots-waiting' : 'wmux-bots-bubble wmux-bots-bubble-bot'} title={fullTime(card.at)}>
            {/* The author for assistive tech where no name is shown. */}
            {(continuation || !showName) && <span className="sr-only">{`${name}: `}</span>}
            <BotProse card={card} answers={answers} waiting={waiting} ctx={ctx} />
          </div>
        )}
        {/* Its files sit under the bubble, outside it (a chip's fill never
            sits on the bubble's). */}
        {ctx.onOpenFile && <CardFiles card={card} t={t} shownId={ctx.shownFileId} onOpen={ctx.onOpenFile} />}
        {chips}
        {thread && thread.replies > 0 && <ThreadSummaryLine thread={thread} ctx={ctx} />}
      </div>
    </div>
  );
}

/** A bot's face as the chat knows it: its row, else what the room keeps
 *  of it (a removed bot's tombstone); null when neither knows it. */
function botFace(botId: string, ctx: RowCtx): Pick<BotProfileData, 'id' | 'name' | 'role' | 'avatar'> | null {
  const row = ctx.bots.find((b) => b.bot.id === botId);
  if (row) return row.bot;
  const known = ctx.actors[botId];
  return known?.role ? { id: botId, name: known.name ?? '', role: known.role, ...(known.avatar ? { avatar: known.avatar } : {}) } : null;
}

/** A thread the conversation started, as one work card in the delegating
 *  bot's run: its avatar once beside the run's last item, its name above
 *  the run in a room. */
function WorkRow({ item, ctx, group }: { item: Extract<TimelineItem, { kind: 'work' }>; ctx: RowCtx; group: boolean }) {
  const { work, delegatorId, continuation, runEnd } = item;
  const { t } = ctx;
  const opts = ctx.work;
  const view = useMemo(
    () => workView(work, { delegatorId, waits: opts?.waits ?? (() => false), tasks: opts?.tasks, requestTitle: ctx.requestTitle, prUrl: opts?.prUrl }),
    [work, delegatorId, opts, ctx.requestTitle],
  );
  const party = (botId: string) => ({ kind: 'bot' as const, workspaceId: work.workspaceId, botId });
  const face = delegatorId ? botFace(delegatorId, ctx) : null;
  const showName = !!delegatorId && (group || (!!ctx.selfBot && delegatorId !== ctx.selfBot));
  const textOf = (c: RoomCardData): string => {
    const title = ownerCardText(c, ctx.botNames, c.actor.kind === 'bot' ? ctx.idLabels : undefined, t).title.split('\n')[0].trim();
    return c.actor.kind === 'human' ? `${t('room.actor.you')}: ${title}` : title;
  };
  const refChip = view.refUrl ? ctx.markdown.linkChip?.(view.refUrl, null) : null;
  return (
    <div
      className={`wmux-bots-msg${continuation ? ' is-continuation' : ''}`}
      data-bots-bubble="work"
      data-continuation={continuation ? 'true' : undefined}
      data-run-end={runEnd ? 'true' : undefined}
    >
      <div className="wmux-bots-msg-gutter">{runEnd && face ? <BotAvatar bot={face} size={28} /> : null}</div>
      <div className="wmux-bots-msg-main">
        {!continuation && showName && (
          <div className="wmux-bots-msg-head" data-bots-msg-head>
            <span className="truncate" style={botNameStyle(delegatorId)}>{actorLabel(party(delegatorId), t, ctx.bots, ctx.actors)}</span>
          </div>
        )}
        <BotsWorkCard
          work={work}
          view={view}
          t={t}
          faceOf={(botId) => botFace(botId, ctx)}
          nameOf={(botId) => actorLabel(party(botId), t, ctx.bots, ctx.actors)}
          textOf={textOf}
          refChip={refChip}
          onOpenThread={() => ctx.onThread(work.workspaceId, work.threadId)}
        />
      </div>
    </div>
  );
}

/** Consecutive system cards of one thread: one line naming each (a
 *  refusal's or a budget's word kept in its colour) and how many, which
 *  opens into the cards themselves. A lone card is its own line. */
function SystemGroup({ cards, thread, ctx }: { cards: RoomCardData[]; thread?: ThreadView; ctx: RowCtx }) {
  const [open, setOpen] = useState(false);
  const { t } = ctx;
  const onThread = (th: ThreadId) => ctx.onThread(cards[0].workspaceId, th);
  // A task's start roots its thread: its replies open from here, and the
  // line names no chip the summary already opens.
  const summary = thread && thread.replies > 0 ? (
    <div className="wmux-bots-row wmux-bots-row-system">
      <ThreadSummaryLine thread={thread} ctx={ctx} />
    </div>
  ) : null;
  const hide = summary ? thread!.threadId : ctx.hideThread;
  const resume = ctx.resume;
  const resumeOf = (c: RoomCardData): string | null => (resume ? cardResumeTaskId(c, resume.resumable) : null);
  // A run holding a card with a Resume shows its lines, so the button shows.
  if (cards.length === 1 || open || cards.some((c) => resumeOf(c) !== null)) {
    return (
      <div data-bots-system-group={cards.length > 1 ? cards.length : undefined}>
        {cards.map((c) => {
          const taskId = resumeOf(c);
          return <SystemLine key={c.id} card={c} t={t} onThread={onThread} now={ctx.now} botNames={ctx.botNames} taskTitle={ctx.taskTitle} requestTitle={ctx.requestTitle} hideThread={hide} onResume={taskId && resume ? () => resume.run(taskId) : undefined} />;
        })}
        {summary}
        {open && (
          <div className="wmux-bots-row wmux-bots-row-system">
            <button type="button" data-bots-system-fold aria-expanded onClick={() => setOpen(false)} className={`text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>{t('room.showLess')}</button>
          </div>
        )}
      </div>
    );
  }
  const last = cards[cards.length - 1];
  return (
    <div className="wmux-bots-row wmux-bots-row-system" data-bots-system-group={cards.length} data-room-card-id={cards[0].id}>
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        title={fullTime(last.at)}
        className={`wmux-bots-system flex min-w-0 items-baseline justify-center gap-1 hover:text-[var(--text-main)] ${FOCUS_RING}`}
      >
        {cards.map((c, i) => {
          const word = c.kind === 'refusal' || c.kind === 'budget' ? kindLabel(c.kind, t) : null;
          return (
            <span key={c.id} className="min-w-0 truncate">
              {i > 0 && <span aria-hidden="true">{' · '}</span>}
              {word && <span className={c.kind === 'refusal' ? 'text-[var(--accent-red)]' : 'text-[var(--accent-yellow)]'}>{`${word} `}</span>}
              <span className="text-[var(--text-sub)]">{ownerCardText(c, ctx.botNames, undefined, t).title}</span>
            </span>
          );
        }).slice(0, 3)}
        <span className="shrink-0 tabular-nums">{` · ${t('botsPage.chat.events', { count: cards.length })} · ${clockTime(last.at)}`}</span>
      </button>
      {summary}
    </div>
  );
}

/** The date and time, centred and muted, at a new day and after an hour's
 *  quiet. No rule: the label alone divides (one boundary). */
function DayDivider({ at, ctx }: { at: number; ctx: RowCtx }) {
  return (
    <div className="wmux-bots-day" data-bots-day role="separator">
      <span title={fullTime(at)}>{separatorLabel(at, ctx.now ?? Date.now(), ctx.t, getLocale())}</span>
    </div>
  );
}

/** A timeline's rows. */
/** A bot's saved workflow as one card at the time it was saved, its bot's
 *  avatar beside it and, in a group, its name above (botsWorkflow.ts). */
function WorkflowRow({ item, ctx, group, onCancel }: { item: Extract<WorkflowTimelineItem, { kind: 'workflow' }>; ctx: RowCtx; group: boolean; onCancel?: React.ComponentProps<typeof BotsWorkflowCard>['onCancel'] }) {
  const { workflow } = item;
  const face = botFace(workflow.botId, ctx);
  return (
    <div className="wmux-bots-msg" data-bots-bubble="workflow" data-run-end="true">
      <div className="wmux-bots-msg-gutter">{face ? <BotAvatar bot={face} size={28} /> : null}</div>
      <div className="wmux-bots-msg-main">
        {group && (
          <div className="wmux-bots-msg-head" data-bots-msg-head>
            <span className="truncate" style={botNameStyle(workflow.botId)}>{actorLabel({ kind: 'bot', workspaceId: workflow.workspaceId, botId: workflow.botId }, ctx.t, ctx.bots, ctx.actors)}</span>
          </div>
        )}
        <BotsWorkflowCard workflow={workflow} t={ctx.t} onCancel={ctx.readOnly ? undefined : onCancel} />
      </div>
    </div>
  );
}

function TimelineView({ items, ctx, group = false, onCancelWorkflow }: { items: readonly WorkflowTimelineItem[]; ctx: RowCtx; group?: boolean; onCancelWorkflow?: React.ComponentProps<typeof BotsWorkflowCard>['onCancel'] }) {
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case 'day': return <DayDivider key={item.key} at={item.at} ctx={ctx} />;
          case 'new': return <div key={item.key} className="wmux-bots-new" data-bots-new-divider role="separator"><span>{ctx.t('botsPage.chat.new')}</span></div>;
          case 'system': return <SystemGroup key={item.key} cards={item.cards} thread={item.thread} ctx={ctx} />;
          case 'message': return <MessageRow key={item.key} item={item} ctx={ctx} group={group} />;
          case 'work': return <WorkRow key={item.key} item={item} ctx={ctx} group={group} />;
          case 'workflow': return <WorkflowRow key={item.key} item={item} ctx={ctx} group={group} onCancel={onCancelWorkflow} />;
        }
      })}
    </>
  );
}

/** Ticks once a second while `on` (an elapsed time), else not at all. */
function useSecondTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

/** One bot's running turn in the rail: "<bot> working · 0:14", its queue,
 *  and Stop — the turn only, neutral (the profile's Stop also ends its
 *  workers). The outcome is a toast. */
function TurnLine({ row, t, now, readOnly }: { row: FactoryBotRow; t: T; now?: number; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const started = row.status?.currentTurn?.startedAt;
  const tick = useSecondTick(now === undefined);
  const at = now ?? tick;
  const queued = row.status?.queueDepth ?? 0;
  const stop = async () => {
    setBusy(true);
    try {
      const r = await getFactoryBotPort().act('interrupt', row.bot.id);
      useStore.getState().pushToast({
        message: r.ok ? t('botsPage.chat.turnStopped', { name: row.bot.name }) : (r.message || t('botsPage.chat.turnStopFailed', { name: row.bot.name })),
        level: r.ok ? 'info' : 'error',
      });
    } catch (err) {
      useStore.getState().pushToast({ message: `${t('botsPage.chat.turnStopFailed', { name: row.bot.name })} ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wmux-bots-rail-row" data-bots-turn={row.bot.id}>
      <span aria-hidden="true" className="inline-block h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--text-muted)]" />
      <span className="min-w-0 truncate text-[12px] text-[var(--text-sub)]">
        {t('botsPage.chat.botWorking', { name: row.bot.name })}
        {typeof started === 'number' && <span className="tabular-nums text-[var(--text-muted)]">{` · ${elapsed(at - started)}`}</span>}
        {queued > 0 && <span className="text-[var(--text-muted)]">{` · ${t('botsPage.chat.queued', { count: queued })}`}</span>}
      </span>
      {!readOnly && (
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={busy}
          data-bots-turn-stop={row.bot.id}
          aria-label={t('botsPage.chat.stopTurnName', { name: row.bot.name })}
          onClick={() => void stop()}
        >
          {busy ? t('botsPage.chat.stopping') : t('botsPage.chat.stopTurn')}
        </Button>
      )}
    </div>
  );
}

/** A rail task's state in words: waiting for a slot, or how it ended
 *  (cancelled, failed, in review, done), and whether its worker can resume. */
function taskRailState(task: BotTaskView, t: T): string {
  if (task.stage === 'waiting_slot') return t('botsPage.worker.waitingSlot');
  const state = task.stage === 'cancelled' ? 'taskStatus.cancelled'
    : task.stage === 'failed' ? 'botsPage.worker.failed'
      : task.stage === 'coded' ? 'botsPage.worker.inReview'
        : null;
  if (!state) return t(task.worker === 'resumable' ? 'botsPage.worker.resumable' : 'botsPage.worker.done');
  return task.worker === 'resumable' ? `${t(state)} · ${t('botsPage.worker.canResume')}` : t(state);
}

/** Why a Resume was refused, in the reader's language when this build words
 *  it (no free agent slot), else main's own message. Pure over `t`. */
function resumeRefusalText(r: { message?: string; code?: string; cap?: number }, t: T): string | null {
  if (r.code === 'no_slot' && typeof r.cap === 'number') return t('botsPage.worker.resumeNoSlot', { cap: r.cap });
  return r.message ?? null;
}

/** A bot's task that is not a live worker, in the rail: waiting for an agent
 *  slot, or done with a stopped worker that can resume the same
 *  conversation. Open shows only while the worker's pane is still open; a
 *  cleared task offers Resume, which opens a new pane (and the panel). */
function TaskRow({ task, t, resumePort, readOnly, shownId, onOpen }: { task: BotTaskView; t: T; resumePort?: Pick<FactoryBotPort, 'resumeWorker'>; readOnly: boolean; shownId: string | null; onOpen: (workspaceId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeWorker = resumePort?.resumeWorker;
  // A Resume answered after this row left (another conversation) opens
  // nothing; one still shown opens in the conversation shown now.
  const live = useRef({ mounted: true, onOpen });
  live.current.onOpen = onOpen;
  useEffect(() => {
    live.current.mounted = true;
    return () => { live.current.mounted = false; };
  }, []);
  const waiting = task.stage === 'waiting_slot';
  const resumable = task.worker === 'resumable';
  const paneWorkspaceId = task.workerWorkspaceId ?? task.taskWorkspaceId;
  const paneOpen = useStore((s) => !!paneWorkspaceId && s.workspaces.some((w) => w.id === paneWorkspaceId));
  return (
    <div className="wmux-bots-rail-row" data-bots-task={task.taskId} data-task-state={waiting ? 'waiting_slot' : resumable ? 'resumable' : 'done'}>
      <span aria-hidden="true" className="inline-block h-[6px] w-[6px] shrink-0 rounded-full border-[1.5px] border-[var(--text-muted)]" />
      <span className="min-w-0 flex-1 truncate text-[12px]">
        <span className="text-[var(--text-main)]">{task.title}</span>
        <span className="text-[var(--text-muted)]">{` · ${error ?? taskRailState(task, t)}`}</span>
        {!waiting && <TaskVerification verification={task.verification} t={t} className="text-[var(--accent-yellow)]" prefix=" · " />}
        {!waiting && task.folder === 'kept_dirty' && <span data-bots-task-folder-kept className="text-[var(--text-muted)]">{` · ${t('botsPage.worker.folderKept')}`}</span>}
      </span>
      {!waiting && paneOpen && (
        <Button
          size="sm"
          variant="secondary"
          data-bots-worker-open={paneWorkspaceId}
          aria-label={t('botsPage.worker.openName', { name: task.title })}
          aria-pressed={!!paneWorkspaceId && shownId === paneWorkspaceId}
          onClick={() => { if (paneWorkspaceId) onOpen(paneWorkspaceId); }}
        >
          {t('botsPage.worker.open')}
        </Button>
      )}
      {!waiting && resumable && !readOnly && resumeWorker && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          data-bots-task-resume={task.taskId}
          aria-label={t('botsPage.worker.resumeName', { name: task.title })}
          onClick={() => {
            setBusy(true);
            setError(null);
            void resumeWorker(task.taskId)
              .then((r) => {
                if (!live.current.mounted) return;
                if (!r.ok) setError(resumeRefusalText(r, t));
                else {
                  const opened = r.workspaceId ?? paneWorkspaceId;
                  if (opened) live.current.onOpen(opened);
                }
              })
              .catch((err: unknown) => { if (live.current.mounted) setError(String(err)); })
              .finally(() => { if (live.current.mounted) setBusy(false); });
          }}
        >
          {t('botsPage.worker.resume')}
        </Button>
      )}
    </div>
  );
}

/** Rows the rail shows before "+N more". */
const RAIL_ROWS_MAX = 3;

/** The working rail right above the composer: each running bot's turn on
 *  one line ("<bot> working · 0:02 · Stop"), then the tasks the list's
 *  worker tree cannot show — waiting for an agent slot, or resumable with
 *  their pane cleared (owner decision 2026-10-14: the workers themselves are
 *  rows under their bot in the list; narrowed by the owner decision
 *  2026-10-16 to tasks still open: resuming an ended task's worker is the
 *  bot's call, and the owner's Resume for it stays in its panel and on its
 *  card). Nothing at all while nothing works; with the bots off, no turns
 *  and no Stop or Resume. */
function WorkingRail({ turns, tasks, t, now, readOnly, resumePort, shownId, onOpen }: {
  turns: readonly FactoryBotRow[];
  tasks: readonly BotTaskView[];
  t: T;
  now?: number;
  readOnly: boolean;
  resumePort?: Pick<FactoryBotPort, 'resumeWorker'>;
  shownId: string | null;
  onOpen: (workspaceId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const rows = tasks.map((task) => <TaskRow key={`t:${task.taskId}`} task={task} t={t} resumePort={resumePort} readOnly={readOnly} shownId={shownId} onOpen={onOpen} />);
  const live = readOnly ? [] : turns;
  if (live.length === 0 && rows.length === 0) return null;
  const shownRows = all ? rows : rows.slice(0, RAIL_ROWS_MAX);
  const more = rows.length - shownRows.length;
  return (
    <div className="wmux-bots-rail" data-bots-rail role="group" aria-label={t('botsPage.chat.rail')}>
      {live.map((row) => <TurnLine key={row.bot.id} row={row} t={t} now={now} readOnly={readOnly} />)}
      {shownRows}
      {(more > 0 || all) && rows.length > RAIL_ROWS_MAX && (
        <button
          type="button"
          data-bots-rail-more
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className={`self-start px-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
        >
          {all ? t('room.showLess') : t('botsPage.chat.moreRows', { count: more })}
        </button>
      )}
    </div>
  );
}

/** Suggested first messages for an empty 1:1. */
const SUGGESTION_KEYS = ['botsPage.chat.suggestDo', 'botsPage.chat.suggestStart', 'botsPage.chat.suggestStatus'] as const;

/** An empty 1:1's start: the bot's face and name, its job in one line, and
 *  a few first messages to pick from (each fills the composer). */
function ChatIntro({ row, t, onPick, readOnly }: { row: FactoryBotRow; t: T; onPick: (text: string) => void; readOnly: boolean }) {
  const job = row.bot.job ?? templateJob(botTemplate(row.bot), t);
  return (
    <div className="wmux-bots-intro" data-bots-intro={row.bot.id}>
      <BotAvatar bot={row.bot} size={48} working={botPresence(row) === 'running'} />
      <p className="mt-2 text-[16px] font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.chat.introTitle', { name: row.bot.name })}</p>
      {job && <p className="mt-0.5 line-clamp-2 text-[13px] text-[var(--text-muted)]">{job}</p>}
      {!readOnly && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SUGGESTION_KEYS.map((key) => (
            <button key={key} type="button" data-bots-suggestion={key} onClick={() => onPick(t(key))} className={`wmux-bots-suggestion ${FOCUS_RING}`}>
              {t(key)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The side panel's share of the area right of the list (owner decision
 *  2026-10-14: chat ~45%, panel ~55%), the bounds a drag keeps it in, and
 *  where the owner's choice is kept (this window's browser storage: a
 *  per-viewer convenience). */
export const SIDE_SPLIT_DEFAULT = 0.55;
const SIDE_SPLIT_MIN = 0.3;
const SIDE_SPLIT_MAX = 0.75;
const SIDE_SPLIT_KEY = 'wmux.bots.sideSplit';

export function clampSideSplit(v: number): number {
  return Number.isFinite(v) ? Math.min(SIDE_SPLIT_MAX, Math.max(SIDE_SPLIT_MIN, v)) : SIDE_SPLIT_DEFAULT;
}

/** The panel never under 320px, the chat never under 360px (beside the 6px
 *  handle): the share a body `width` px wide can take, as bots.css draws
 *  it. Pure. */
export const SIDE_PANEL_MIN_PX = 320;
export const SIDE_CHAT_MIN_PX = 360;
export function fitSideSplit(v: number, width: number): number {
  const share = clampSideSplit(v);
  if (!(width > SIDE_PANEL_MIN_PX + SIDE_CHAT_MIN_PX + 6)) return share;
  return Math.min((width - SIDE_CHAT_MIN_PX - 6) / width, Math.max(SIDE_PANEL_MIN_PX / width, share));
}

function readSideSplit(): number {
  try {
    const raw = window.localStorage.getItem(SIDE_SPLIT_KEY);
    return raw === null ? SIDE_SPLIT_DEFAULT : clampSideSplit(Number(raw));
  } catch {
    return SIDE_SPLIT_DEFAULT;
  }
}

function writeSideSplit(v: number): void {
  try { window.localStorage.setItem(SIDE_SPLIT_KEY, String(v)); } catch { /* not kept: the default next time */ }
}

/** The seam between the chat and its side panel: drag it, or focus it and
 *  use the arrow keys, to share the width. A drag moves a guide line and
 *  applies the width once, on release, so the worker's terminal is resized
 *  once at its final size instead of on every pointer move (each resize
 *  makes the agent redraw). */
function SideSplitter({ areaRef, split, t, onChange }: {
  areaRef: React.RefObject<HTMLDivElement | null>;
  split: number;
  t: T;
  onChange: (next: number, done: boolean) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const at = (clientX: number) => {
    const box = areaRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return split;
    return fitSideSplit((box.right - clientX) / box.width, box.width);
  };
  const width = () => areaRef.current?.getBoundingClientRect().width ?? 0;
  return (
    <>
    {drag !== null && <div aria-hidden="true" data-bots-split-guide className="wmux-bots-split-guide" style={{ right: `${(drag * 100).toFixed(2)}%` }} />}
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('botsPage.chat.resizePanel')}
      aria-valuemin={Math.round(SIDE_SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SIDE_SPLIT_MAX * 100)}
      aria-valuenow={Math.round(split * 100)}
      tabIndex={0}
      data-bots-splitter
      className={`wmux-bots-splitter ${FOCUS_RING}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDrag(fitSideSplit(split, width()));
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) setDrag(at(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        setDrag(null);
        onChange(at(e.clientX), true);
      }}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={(e) => {
        // The panel is on the right: the left arrow widens it.
        const step = e.key === 'ArrowLeft' ? 0.02 : e.key === 'ArrowRight' ? -0.02 : 0;
        if (!step) return;
        e.preventDefault();
        onChange(fitSideSplit(split + step, width()), true);
      }}
    />
    </>
  );
}

/** A thread beside the chat: its root, how many replies, the replies as a
 *  timeline, and a composer that posts into the thread. The main timeline
 *  stays where it was. */
function BotsThreadPanel({ conversation, cards, workspaceId, threadId, ctx: parentCtx, waits, bots, api, readOnly, onClose, onSent, style }: {
  conversation: Conversation;
  /** The thread's cards (and those linking it), in order; the approve chip
   *  counts theirs. */
  cards: readonly RoomCardData[];
  workspaceId: string;
  threadId: ThreadId;
  ctx: RowCtx;
  waits: (card: RoomCardData) => boolean;
  bots: readonly FactoryBotRow[];
  api?: RoomsApi | null;
  readOnly: boolean;
  onClose: () => void;
  onSent: (cardId: string, to: SentTo[] | null) => void;
  /** The panel's width beside the chat (the splitter's). */
  style?: React.CSSProperties;
}) {
  const ctx = { ...parentCtx, hideThread: threadId };
  const { t } = ctx;
  const label = threadLabel(threadId, t, ctx.taskTitle, ctx.requestTitle);
  const [root, ...replies] = cards;
  const rootItems = root ? buildTimeline([{ kind: 'card', card: root }], { waits }) : [];
  const replyItems = buildTimeline(replies.map((card): RoomEntry => ({ kind: 'card', card })), { waits });
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastId = cards[cards.length - 1]?.id ?? '';
  // Not while the window is hidden (see BotsChat's own pin): the pin missed
  // then is made when the window is shown again.
  const missedPin = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (document.visibilityState === 'hidden') missedPin.current = true;
    else el.scrollTop = el.scrollHeight;
  }, [lastId]);
  useEffect(() => {
    const onVisible = () => {
      const el = scrollRef.current;
      if (!el || !missedPin.current || document.visibilityState === 'hidden') return;
      missedPin.current = false;
      el.scrollTop = el.scrollHeight;
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return (
    <aside className="wmux-bots-side" data-bots-thread-panel={threadId} aria-label={t('botsPage.chat.threadPanel', { name: label })} style={style}>
      <div className="wmux-bots-worker-head">
        <span className={`min-w-0 flex-1 truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)] ${isRefThread(threadId) ? 'font-mono' : ''}`}>{label}</span>
        <button
          type="button"
          data-bots-thread-close
          onClick={onClose}
          aria-label={t('botsPage.chat.closeThread')}
          title={t('botsPage.chat.closeThread')}
          className={`wmux-bots-icon-button ${FOCUS_RING}`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
        </button>
      </div>
      <div ref={scrollRef} className="wmux-bots-side-scroll" role="log" aria-label={label}>
        <TimelineView items={rootItems} ctx={ctx} group={conversation.kind === 'room'} />
        <p className="wmux-bots-side-count" data-bots-thread-count={replies.length}>
          {replies.length === 1 ? t('botsPage.chat.replyCountOne') : t('botsPage.chat.replyCount', { count: replies.length })}
        </p>
        <TimelineView items={replyItems} ctx={ctx} group={conversation.kind === 'room'} />
      </div>
      <div className="wmux-bots-composer">
        <BotsComposer
          conversation={conversation}
          threadId={threadId}
          workspaceId={workspaceId}
          bots={bots}
          placeholder={t('botsPage.chat.replyPlaceholder')}
          t={t}
          api={api}
          onSent={onSent}
          readOnly={readOnly}
          cards={cards}
        />
      </div>
    </aside>
  );
}

/** A system card: the evidence itself (a refusal's reasons, a gate's
 *  result, a task's end, an error), as a centred line with its body folded
 *  to two lines under Show more (by height: a markdown list does not
 *  line-clamp). */
function SystemLine({ card, t, onThread, now, botNames = [], taskTitle, requestTitle, hideThread, onResume }: { card: RoomCardData; t: T; onThread: (id: ThreadId) => void; now?: number; botNames?: readonly string[]; taskTitle?: TaskTitleOf; requestTitle?: RequestTitleOf; hideThread?: ThreadId; onResume?: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [resuming, setResuming] = useState(false);
  const { title, body } = ownerCardText(card, botNames, undefined, t);
  const foldable = body.length > SYSTEM_FOLD_CHARS || body.includes('\n');
  const word = card.kind === 'refusal' || card.kind === 'budget' ? kindLabel(card.kind, t) : null;
  const chip = !isConversationThread(card.threadId) && card.threadId !== hideThread;
  // One alignment per line: a bare line is centred; one with evidence under
  // it reads left, header and chip with it.
  const align = body ? 'justify-start' : 'justify-center';
  return (
    <div className="wmux-bots-row wmux-bots-row-system" data-room-card-id={card.id} data-bots-bubble="system" data-card-kind={card.kind} data-system-align={body ? 'start' : 'center'}>
      <div className={`wmux-bots-system${body ? ' is-detailed' : ''}`}>
        <div className={`flex min-w-0 items-baseline ${align} gap-1`}>
          {word && <span className={card.kind === 'refusal' ? 'shrink-0 text-[var(--accent-red)]' : 'shrink-0 text-[var(--accent-yellow)]'}>{word}</span>}
          <span className="min-w-0 break-words text-[var(--text-sub)]">{title}</span>
          <span className="shrink-0 tabular-nums" title={fullTime(card.at)}>· {clockTime(card.at)}</span>
        </div>
        {body && (
          <div data-card-body data-clamped={foldable && !expanded ? 'true' : undefined} className={`mt-0.5 text-left text-[12px] leading-relaxed text-[var(--text-sub)] break-words ${foldable && !expanded ? 'max-h-[39px] overflow-hidden' : ''}`}>
            {renderBrainMarkdown(body, { links: true, richCode: true, strictEmphasis: true })}
          </div>
        )}
        {(foldable || chip || onResume) && (
          <div className={`mt-0.5 flex items-center ${align} gap-2`}>
            {onResume && (
              <Button
                size="sm"
                variant="secondary"
                data-bots-card-resume
                disabled={resuming}
                onClick={() => {
                  setResuming(true);
                  void onResume().finally(() => setResuming(false));
                }}
              >
                {t('botsPage.worker.resume')}
              </Button>
            )}
            {foldable && (
              <button type="button" data-card-more aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className={`text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>
                {expanded ? t('room.showLess') : t('room.showMore')}
              </button>
            )}
            {chip && <ThreadChip threadId={card.threadId} t={t} onPick={onThread} taskTitle={taskTitle} requestTitle={requestTitle} />}
          </div>
        )}
      </div>
    </div>
  );
}

function workerState(worker: BotWorker): string {
  if (worker.needsInput) return 'botsPage.worker.needsInput';
  return worker.waiting ? 'botsPage.worker.waiting' : 'botsPage.worker.running';
}

/** What the worker panel's header says for the shown workspace: a live
 *  worker's name and state (needs-you text while it waits), else its row in
 *  the list's tree (in review, done, failed or cancelled, with its folder
 *  note, and whether it can resume), else a task's rail state, else its
 *  workspace's name with no state. `stopTaskId`: a live worker whose task
 *  is still open (its row's), which Stop worker stops; `taskId`: the shown
 *  row's task, whatever its state. */
function workerPanelView(workspaceId: string, workers: readonly BotWorker[], tree: readonly BotTreeRow[], tasks: readonly BotTaskView[], t: T): { name: string; state: string | null; attention: boolean; resumeTaskId?: string; stopTaskId?: string; taskId?: string } {
  const live = workers.find((w) => w.workspaceId === workspaceId);
  const row = tree.find((r) => r.workspaceId === workspaceId);
  const taskId = row?.taskId ?? live?.taskId;
  if (live) return { name: live.name, state: t(workerState(live)), attention: live.waiting, ...(taskId ? { taskId } : {}), ...(row?.stoppable && row.taskId ? { stopTaskId: row.taskId } : {}) };
  if (row) return { name: row.title, state: treeRowLabel(row, t), attention: row.state === 'needsYou', ...(taskId ? { taskId } : {}), ...(row.resumable && row.taskId ? { resumeTaskId: row.taskId } : {}) };
  const task = tasks.find((x) => (x.workerWorkspaceId ?? x.taskWorkspaceId) === workspaceId);
  if (task) return { name: task.title, state: taskRailState(task, t), attention: false };
  const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
  return { name: displayWorkspaceName(ws?.name ?? '', true), state: null, attention: false };
}

function BotsComposer({ conversation, threadId, workspaceId: workspaceOverride, bots, placeholder, t, api, onSent, readOnly, cards = [], prefill }: {
  conversation: Conversation;
  threadId: ThreadId;
  /** The room to post in when it is not the conversation's (a thread a 1:1
   *  holds from another room). */
  workspaceId?: string;
  /** Text to put in the box (a suggested first message); a new nonce puts
   *  it in again. */
  prefill?: { text: string; nonce: number };
  /** The cards the conversation shows (the approve chip counts theirs). */
  cards?: readonly RoomCardData[];
  bots: readonly FactoryBotRow[];
  placeholder: string;
  t: T;
  api?: RoomsApi | null;
  onSent: (cardId: string, sent: SentTo[] | null) => void;
  /** The bots are paused: nothing is sent. */
  readOnly?: boolean;
}) {
  const [text, setText] = useState('');
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Photos staged for the next message (BotsPhotos.tsx): local paths main
  // copies into the room when the message is sent.
  const [photos, setPhotos] = useState<ChatAttachment[]>([]);
  const failedPost = useRef<{ key: string; clientPostId: string } | null>(null);
  const textNow = useRef(text);
  const workspaceId = workspaceOverride ?? conversation.workspaceId;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!prefill) return;
    textNow.current = prefill.text;
    setText(prefill.text);
    inputRef.current?.focus();
  }, [prefill]);
  // The pending approval requests whose cards this conversation shows now,
  // whatever thread a card sits in (a 1:1: this bot's, in any room; a view
  // narrowed to a thread shows that thread's cards and those linking it).
  const { list: approvals } = useApprovals();
  const scopeBot = conversation.kind === 'bot' ? conversation.row.bot.id : undefined;
  const pendingIds = useMemo(() => (readOnly ? [] : pendingForChip(approvals, cards, scopeBot ? { botId: scopeBot } : { workspaceId })
    .map((r) => r.requestId)), [approvals, cards, readOnly, scopeBot, workspaceId]);
  const picks = useMentionPicks(bots, workspaceId);
  // A group's bots that can take a message (oldest first).
  const roomCandidates = useMemo(() => (conversation.kind === 'room' ? conversation.bots.filter((r) => r.bot.enabled) : []), [conversation]);
  // The group's coordinator, which an unpicked message goes to alone (main's
  // rule, humanMessage.ts).
  const lead = useMemo(() => roomLead(roomCandidates), [roomCandidates]);
  // A group message goes to the bots picked and every group bot named by an
  // `@Name` anywhere in the text (main reads the field, never the text).
  const typed = useMemo(() => textMentions(text, roomCandidates, bots.filter((r) => r.bot.enabled)), [text, roomCandidates, bots]);
  const picked: string[] = useMemo(
    () => (conversation.kind === 'bot' ? [conversation.row.bot.id] : [...new Set([...picks.picked, ...typed])].filter((id) => roomCandidates.some((r) => r.bot.id === id))),
    [conversation, picks.picked, typed, roomCandidates],
  );
  // Nobody picked: no mentions, in the group's own thread or one it
  // started. Main settles who gets it (humanMessage.ts): the group's
  // coordinator with any bot waiting on the owner in that thread, else
  // every bot of the group.
  const mentions: string[] = picked;
  // A group with no bot on takes no message (main would read a thread's
  // unaddressed reply as the whole workspace's).
  const refusal = readOnly ? t('botsPage.pausedComposer')
    : conversation.kind === 'bot' ? oneToOneRefusal(conversation.row, t)
      : roomCandidates.length === 0 ? t('botsPage.group.noneOn') : null;

  // `t` reads the store's language: callbacks and memos keyed on it also
  // key on the locale, so they re-word after a language change.
  const locale = useStore((s) => s.locale);
  const submit = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    if (inFlight || refusal) return;
    const bridge = api === undefined ? roomsApi() : api;
    const submitted = text;
    const paths = photos.map((p) => p.path);
    const key = JSON.stringify([workspaceId, threadId, text, mentions, paths]);
    const clientPostId = failedPost.current?.key === key ? failedPost.current.clientPostId : newClientPostId();
    const params = paths.length > 0
      ? photoPostParams({ workspaceId, threadId, text, mentions, clientPostId, paths })
      : roomPostParams({ workspaceId, threadId, text, mentions, clientPostId });
    if (!params) return;
    if (!bridge) {
      setError(t('room.composer.unavailable'));
      return;
    }
    setInFlight(true);
    setError(null);
    try {
      const r = await bridge.post(params);
      failedPost.current = r.ok ? null : { key, clientPostId };
      if (r.ok) {
        if (textNow.current === submitted) {
          textNow.current = '';
          setText('');
          picks.reset();
        }
        // The photos this message took leave the draft; one added while it
        // was sending stays for the next message.
        setPhotos((current) => current.filter((p) => !paths.includes(p.path)));
        onSent(r.card.id, sentFrom(r));
      } else if (r.code === 'attachment' && 'reason' in r) {
        setError(t(`room.attach.${r.reason}`, { count: ROOM_PHOTO_LIMIT }));
      } else {
        setError(r.message || t('room.composer.failed'));
      }
    } catch (err) {
      failedPost.current = { key, clientPostId };
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInFlight(false);
    }
  }, [api, inFlight, refusal, text, photos, workspaceId, threadId, mentions, picks, t, locale, onSent]);

  // Photos: from the picker, a paste or a drop on the window; PNG and JPEG,
  // at most ROOM_PHOTO_LIMIT; a refused one says why in the status line.
  const addPhotos = useCallback(async (paths: readonly string[]) => {
    if (refusal) return;
    const preview = window.electronAPI?.chat?.attachment;
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() || path;
      if (!isRoomPhotoPath(path)) { setError(t('room.attach.type', { name })); continue; }
      const result = preview ? await preview({ path }).catch(() => null) : null;
      if (result && !result.ok) { setError(t(result.reason === 'size' ? 'room.attach.size' : 'room.attach.missing', { name })); continue; }
      let full = false;
      setPhotos((current) => {
        if (current.some((p) => p.path === path)) return current;
        if (current.length >= ROOM_PHOTO_LIMIT) { full = true; return current; }
        return [...current, { path, name, thumbnail: result?.ok ? result.thumbnail : '' }];
      });
      if (full) setError(t('room.attach.count', { count: ROOM_PHOTO_LIMIT }));
      else setError(null);
    }
    inputRef.current?.focus();
  }, [refusal, t]);
  const addPhotosRef = useRef(addPhotos);
  addPhotosRef.current = addPhotos;
  useEffect(() => (readOnly ? undefined : registerBotsDropTarget((paths) => void addPhotosRef.current(paths))), [readOnly]);
  const pickPhotos = useCallback(async () => {
    const bridge = api === undefined ? roomsApi() : api;
    const picked = await bridge?.pickAttachments?.().catch(() => null);
    if (Array.isArray(picked) && picked.length > 0) await addPhotos(picked);
  }, [api, addPhotos]);
  const pastePhoto = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    // A mixed clipboard (a browser copy carries text and a picture) pastes its text.
    if (data.getData('text/plain') || ![...data.files].some((f) => f.type.startsWith('image/'))) return;
    e.preventDefault();
    const path = await window.clipboardAPI?.readImage?.().catch(() => null);
    if (path) await addPhotos([path]);
    else setError(t('room.attach.missing'));
  }, [addPhotos, t]);

  // `@` suggestions: typing `@` and the start of a name in a room lists the
  // room's bots that match; Enter or Tab (or a click) puts `@Name ` in its
  // place, the arrows move, Escape closes. Focus stays in the box.
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const query = conversation.kind === 'room' && !readOnly ? mentionQuery(text, caret) : null;
  const suggestions = query && query.at !== dismissedAt ? mentionSuggestions(roomCandidates, query.query) : [];
  const suggesting = suggestions.length > 0;
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1));
  useEffect(() => { setActive(0); }, [query?.at, query?.query]);
  useEffect(() => {
    const el = inputRef.current;
    if (pendingCaret.current === null || !el) return;
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);
  const insertMention = (row: FactoryBotRow) => {
    if (!query) return;
    const name = `@${row.bot.name.trim()} `;
    // The rest of the word the caret is in is replaced too ("@Ad|a" → "@Ada ").
    const rest = text.slice(caret).replace(/^[^\s@]*\s?/u, '');
    const next = text.slice(0, query.at) + name + rest;
    const at = query.at + name.length;
    pendingCaret.current = at;
    textNow.current = next;
    setText(next);
    setCaret(at);
    picks.onText(next);
    inputRef.current?.focus();
  };
  const listId = `bots-mention-list-${workspaceId}-${threadId}`;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Never while the IME composes (a Korean syllable is still being built).
    if (e.nativeEvent.isComposing) return;
    if (suggesting) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggestions.length;
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        insertMention(suggestions[activeIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (query) setDismissedAt(query.at);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
      return;
    }
    // Backspace at the very start takes the last photo off.
    if (e.key === 'Backspace' && photos.length > 0 && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      setPhotos((current) => current.slice(0, -1));
    }
  };
  const line = error ?? refusal ?? (conversation.kind === 'bot' ? pausedHint(conversation.row, t) : null);
  // "+": what to put in the box — a suggested message, or (in a room) a bot
  // to address. It closes on a pick, Escape or a press outside it.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !plusRef.current?.contains(target)) setMenuOpen(false);
    };
    const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
    // Opening moves focus to the first item; arrows, Home and End move
    // between them; Escape and Tab close it.
    items()[0]?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenuOpen(false);
        plusRef.current?.focus();
        return;
      }
      if (e.key === 'Tab') {
        setMenuOpen(false);
        return;
      }
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (at + 1) % list.length
        : e.key === 'ArrowUp' ? (at - 1 + list.length) % list.length
          : e.key === 'Home' ? 0
            : e.key === 'End' ? list.length - 1 : -1;
      if (next < 0 || list.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      list[next].focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);
  const putText = (value: string) => {
    textNow.current = value;
    setText(value);
    setMenuOpen(false);
    inputRef.current?.focus();
  };
  return (
    <div className="wmux-bots-composer-wrap">
      <ApprovePendingChip ids={pendingIds} t={t} />
      {suggesting && !menuOpen && (
        <Popover id={listId} role="listbox" data-bots-mention-list aria-label={t('botsPage.chat.mentionList')} className="wmux-bots-composer-menu">
          {suggestions.map((row, i) => (
            <div
              key={row.bot.id}
              id={`${listId}-${row.bot.id}`}
              role="option"
              aria-selected={i === activeIndex}
              data-bots-mention-option={row.bot.id}
              className="ui-section-row w-full cursor-default text-left text-[13px]"
              // Keeps the caret in the box: the press never takes focus.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMention(row)}
            >
              <BotAvatar bot={row.bot} size={20} />
              <span className="min-w-0 truncate">{`@${row.bot.name}`}</span>
            </div>
          ))}
        </Popover>
      )}
      {menuOpen && (
        <Popover ref={menuRef} role="menu" data-bots-composer-menu aria-label={t('botsPage.chat.add')} className="wmux-bots-composer-menu">
          {SUGGESTION_KEYS.map((key) => (
            <button key={key} type="button" role="menuitem" data-bots-composer-suggestion={key} className="ui-section-row w-full text-left text-[13px]" onClick={() => putText(t(key))}>{t(key)}</button>
          ))}
          {roomCandidates.map((row) => (
            <button
              key={row.bot.id}
              type="button"
              role="menuitem"
              data-bots-composer-mention={row.bot.id}
              className="ui-section-row w-full text-left text-[13px]"
              onClick={() => { picks.toggle(row.bot.id); setMenuOpen(false); inputRef.current?.focus(); }}
            >
              {`@${row.bot.name}`}
            </button>
          ))}
        </Popover>
      )}
      {conversation.kind === 'room' && !refusal && (
        <RecipientsControl candidates={roomCandidates} lead={lead} picked={picked} onToggle={picks.toggle} t={t} />
      )}
      {photos.length > 0 && (
        <div data-bots-composer-photos>
          <ChatAttachmentChips items={photos} onRemove={(path) => setPhotos((current) => current.filter((p) => p.path !== path))} />
        </div>
      )}
    <form
      onSubmit={(e) => void submit(e)}
      data-testid="bots-composer"
      data-channel-composer
      data-in-flight={inFlight ? 'true' : 'false'}
      className="wmux-bots-composer-pill"
    >
        <button
          ref={plusRef}
          type="button"
          data-bots-composer-plus
          aria-label={t('botsPage.chat.add')}
          title={t('botsPage.chat.add')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={!!refusal}
          onClick={() => setMenuOpen((v) => !v)}
          onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setMenuOpen(true); } }}
          className={`wmux-bots-composer-plus ${FOCUS_RING}`}
        >
          <IconPlus size={16} />
        </button>
        <button
          type="button"
          data-bots-composer-attach
          aria-label={t('room.attach.add')}
          title={t('room.attach.add')}
          disabled={!!refusal || photos.length >= ROOM_PHOTO_LIMIT}
          onClick={() => void pickPhotos()}
          className={`wmux-bots-composer-plus ${FOCUS_RING}`}
        >
          <IconImage size={16} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          data-testid="bots-composer-input"
          aria-label={placeholder}
          placeholder={placeholder}
          role={conversation.kind === 'room' ? 'combobox' : undefined}
          aria-autocomplete={conversation.kind === 'room' ? 'list' : undefined}
          aria-expanded={conversation.kind === 'room' ? suggesting : undefined}
          aria-controls={suggesting ? listId : undefined}
          aria-activedescendant={suggesting ? `${listId}-${suggestions[activeIndex].bot.id}` : undefined}
          onChange={(e) => {
            textNow.current = e.target.value;
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
            if (conversation.kind === 'room') picks.onText(e.target.value);
            if (error) setError(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setDismissedAt(query?.at ?? null)}
          onFocus={() => setDismissedAt(null)}
          onKeyDown={onKeyDown}
          onPaste={(e) => void pastePhoto(e)}
          className="wmux-bots-composer-input text-[14px]"
        />
        <button
          type="submit"
          data-testid="bots-composer-send"
          disabled={(!text.trim() && photos.length === 0) || inFlight || !!refusal}
          aria-label={t('room.composer.send')}
          title={t('room.composer.send')}
          className={`wmux-bots-composer-send ${FOCUS_RING}`}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="7" y1="11" x2="7" y2="3" />
            <polyline points="3.5,6.5 7,3 10.5,6.5" />
          </svg>
        </button>
    </form>
      {line && (
        <p role={error ? 'alert' : 'status'} data-testid="bots-composer-status" className={`text-[11px] ${error ? 'text-[var(--accent-red)]' : 'text-[var(--text-muted)]'}`}>
          {line}
        </p>
      )}
    </div>
  );
}

/** Whom a group message goes to, above the box: "To: everyone ▾" ("To:
 *  <lead> ▾" in a group with a coordinator), or the bots picked; it opens a
 *  checkbox per bot of the group. A typed `@Name` shows checked too. The
 *  picks reset after each send. */
function RecipientsControl({ candidates, lead, picked, onToggle, t }: {
  candidates: readonly FactoryBotRow[];
  lead: FactoryBotRow | null;
  picked: readonly string[];
  onToggle: (botId: string) => void;
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const names = candidates.filter((r) => picked.includes(r.bot.id)).map((r) => r.bot.name);
  const label = names.length > 0 ? t('botsPage.group.toSome', { names: names.join(', ') })
    : lead ? t('botsPage.group.toSome', { names: lead.bot.name }) : t('botsPage.group.toEveryone');
  return (
    <div ref={wrapRef} className="relative flex min-w-0 items-center">
      <button
        ref={buttonRef}
        type="button"
        data-bots-recipients
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-[24px] max-w-full items-center gap-1 rounded-[var(--chip-radius)] px-2 text-[12px] ${names.length > 0 ? 'bg-[var(--selection-emphasis)] text-[var(--text-main)]' : 'text-[var(--text-sub)] hover:bg-[var(--hover-fill)]'} ${FOCUS_RING}`}
      >
        <span className="min-w-0 truncate">{label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="2.5,4 5,6.5 7.5,4" /></svg>
      </button>
      {open && (
        <Popover
          role="group"
          aria-label={t('botsPage.group.recipients')}
          data-bots-recipients-list
          className="wmux-bots-composer-menu"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            buttonRef.current?.focus();
          }}
        >
          <p className="px-3 pb-1 pt-2 text-[11px] text-[var(--text-muted)]">{lead ? t('botsPage.group.recipientsHintLead', { name: lead.bot.name }) : t('botsPage.group.recipientsHint')}</p>
          {candidates.map((r, i) => (
            <label key={r.bot.id} className="ui-section-row w-full cursor-pointer text-left text-[13px]">
              <input
                type="checkbox"
                data-bots-recipient={r.bot.id}
                autoFocus={i === 0}
                checked={picked.includes(r.bot.id)}
                onChange={() => onToggle(r.bot.id)}
                className={FOCUS_RING}
              />
              <BotAvatar bot={r.bot} size={20} />
              <span className="min-w-0 truncate">{r.bot.name}</span>
            </label>
          ))}
        </Popover>
      )}
    </div>
  );
}

/** What an empty group chat says: who its first message goes to. */
function emptyGroupLine(bots: readonly FactoryBotRow[], t: T): string {
  const lead = roomLead(bots);
  return lead ? t('botsPage.group.emptyLead', { name: lead.bot.name }) : t('botsPage.group.empty');
}

function ProfileLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]">
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 truncate text-[var(--text-main)]">{value}</span>
    </div>
  );
}

/** Pause (park the bot: it takes no new turn until Resume; reversible, so
 *  no confirm) beside Stop (the bot's turn and its workers, after an inline
 *  confirm; the result is a toast). A paused bot shows Resume in Today. */
function StopBot({ row, port, act, t }: { row: FactoryBotRow; port: BotsStopPort; act?: FactoryBotPort['act']; t: T }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const stopBot = port.stopBot;
  const canPause = !!act && row.bot.enabled && botActionsFor(row).park;
  if (!stopBot && !canPause) return null;
  const run = async () => {
    if (!stopBot) return;
    setBusy(true);
    try {
      const r = await stopBot(row.bot.id);
      useStore.getState().pushToast({ message: stopBotSummary(row.bot.name, r, t), level: r.ok ? 'info' : 'error' });
      if (r.ok) setConfirming(false);
    } catch (err) {
      useStore.getState().pushToast({ message: `${t('botsPage.stop.failed')} ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const pause = async () => {
    if (!act) return;
    setPausing(true);
    try {
      const r = await act('park', row.bot.id);
      if (!r.ok) useStore.getState().pushToast({ message: t('room.bot.actionFailed', { name: row.bot.name, reason: r.message ?? '' }), level: 'error' });
    } catch (err) {
      useStore.getState().pushToast({ message: t('room.bot.actionFailed', { name: row.bot.name, reason: err instanceof Error ? err.message : String(err) }), level: 'error' });
    } finally {
      setPausing(false);
    }
  };
  return (
    <div className="mt-1 border-t border-[var(--stroke)] pt-2" data-bots-stop-bot={row.bot.id}>
      {confirming && stopBot ? (
        <InlineConfirm
          text={t('botsPage.stop.botConfirm', { name: row.bot.name })}
          confirmLabel={t('botsPage.stop.bot')}
          cancelLabel={t('room.hq.cancel')}
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => setConfirming(false)}
          testId="bots-stop-bot"
        />
      ) : (
        <div className="flex items-center gap-2">
          {canPause && <Button size="sm" variant="secondary" data-testid="bots-pause-bot" disabled={pausing} onClick={() => void pause()}>{t('botsPage.pause.bot')}</Button>}
          {stopBot && <Button size="sm" variant="destructive" data-testid="bots-stop-bot" onClick={() => setConfirming(true)}>{t('botsPage.stop.bot')}</Button>}
        </div>
      )}
    </div>
  );
}

/** The verbs the profile sends through the bot port beyond the job editor:
 *  Resume and Delete bot (absent ones show no control). */
type BotAdminPort = Partial<Pick<FactoryBotPort, 'act' | 'remove'>>;

/** Delete bot, after an inline confirm that says what happens: its history
 *  stays, its running workers are stopped, its routines are removed. Its
 *  colour goes with its tombstone, so its old cards keep its face. */
function DeleteBot({ row, port, t }: { row: FactoryBotRow; port?: BotAdminPort; t: T }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = port?.remove;
  if (!remove) return null;
  const run = async () => {
    setBusy(true);
    try {
      const hue = botHueIndex(row.bot.id);
      noteRemovedBotHues([[row.bot.id, hue]]);
      const r = await remove(row.bot.id, hue);
      if (r.ok) {
        useStore.getState().pushToast({ message: t('botsPage.delete.done', { name: row.bot.name }), level: 'info' });
        void loadRoomActors();
      } else {
        useStore.getState().pushToast({ message: t('botsPage.delete.failed', { name: row.bot.name, reason: r.message ?? '' }), level: 'error' });
      }
    } catch (err) {
      useStore.getState().pushToast({ message: t('botsPage.delete.failed', { name: row.bot.name, reason: err instanceof Error ? err.message : String(err) }), level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1.5" data-bots-delete-bot={row.bot.id}>
      {confirming ? (
        <InlineConfirm
          text={t('botsPage.delete.confirm', { name: row.bot.name })}
          confirmLabel={t('botsPage.delete.bot')}
          cancelLabel={t('room.hq.cancel')}
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => setConfirming(false)}
          testId="bots-delete-bot"
        />
      ) : (
        <Button size="sm" variant="destructive" data-testid="bots-delete-bot" onClick={() => setConfirming(true)}>{t('botsPage.delete.bot')}</Button>
      )}
    </div>
  );
}

/** A deleted bot's 1:1 in the Archive: Remove from Archive, after an inline
 *  confirm that says what happens (the chat leaves the list for good; its
 *  messages stay saved, and its name on what it wrote in group chats). */
function ClearArchived({ name, t, onClear }: { name: string; t: T; onClear: () => Promise<string | null> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const failed = await onClear();
      if (failed !== null) setError(t('botsPage.archive.failed', { reason: failed }));
    } catch (err) {
      setError(t('botsPage.archive.failed', { reason: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto flex w-full max-w-[28rem] flex-col items-center gap-1.5 pb-3" data-bots-archive-clear>
      {confirming ? (
        <div className="w-full">
          <InlineConfirm
            text={t('botsPage.archive.confirm', { name })}
            confirmLabel={t('botsPage.archive.remove')}
            cancelLabel={t('room.hq.cancel')}
            busy={busy}
            onConfirm={() => void run()}
            onCancel={() => setConfirming(false)}
            testId="bots-archive-clear"
          />
        </div>
      ) : (
        <Button size="sm" variant="destructive" data-testid="bots-archive-clear" onClick={() => setConfirming(true)}>{t('botsPage.archive.remove')}</Button>
      )}
      {error && <p role="alert" className="text-[12px] text-[var(--accent-red)]">{error}</p>}
    </div>
  );
}

/** The bot's job in its profile: the text, and Edit when the bot port can
 *  update (saved as the owner; an empty job clears it). */
function JobLine({ row, t, jobPort }: { row: FactoryBotRow; t: T; jobPort?: Pick<FactoryBotPort, 'update'> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.bot.job ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = jobPort?.update;
  const ok = draft.trim() === '' || normalizeBotJob(draft) !== undefined;
  const save = async () => {
    if (!update) return;
    setBusy(true);
    setError(null);
    try {
      const r = await update(row.bot.id, { job: draft.trim() === '' ? null : draft.trim() });
      if (r.ok) setEditing(false);
      else setError(r.message || t('botsPage.profile.jobFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  // No job of its own: it works on its template's starting job, shown in
  // the owner's language (main's copy of it is English).
  const startingJob = row.bot.job ? '' : templateJob(botTemplate(row.bot), t);
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-job>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.job')}</span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <>
            <textarea
              data-testid="bots-profile-job-input"
              aria-label={t('botsPage.profile.job')}
              value={draft}
              rows={4}
              maxLength={BOT_JOB_MAX}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className={`w-full rounded-[6px] border border-[var(--line)] focus:border-[var(--line-strong)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text-main)] outline-none ${FOCUS_RING}`}
            />
            <div className="mt-1 flex items-center gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setDraft(row.bot.job ?? ''); setError(null); }}>{t('settings.factory.cancel')}</Button>
              <Button size="sm" variant="primary" data-testid="bots-profile-job-save" disabled={busy || !ok} onClick={() => void save()}>{t('settings.factory.save')}</Button>
            </div>
            {error && <p role="alert" className="mt-1 text-[11px] text-[var(--accent-red)]">{error}</p>}
          </>
        ) : (
          <>
            <p data-bots-profile-job-text className={`whitespace-pre-wrap break-words ${row.bot.job ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`}>
              {row.bot.job ?? (startingJob || t('botsPage.profile.noJob'))}
            </p>
            {startingJob && <p data-bots-profile-job-default className="text-[11px] text-[var(--text-muted)]">{t('botsPage.profile.defaultJob')}</p>}
            {update && (
              <button
                type="button"
                data-testid="bots-profile-job-edit"
                onClick={() => { setDraft(row.bot.job ?? ''); setEditing(true); }}
                className={`mt-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
              >
                {t('botsPage.profile.editJob')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The bot's repository, with Change: the folder picker Add bot uses; main
 *  resolves the folder and checks it as it does at creation (its origin's
 *  owner/repo, never a local path; one repository per workspace). */
function RepoLine({ row, t, port, pickFolder = pickFolderDialog }: { row: FactoryBotRow; t: T; port?: Pick<FactoryBotPort, 'update'>; pickFolder?: () => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = port?.update;
  const change = async () => {
    if (!update) return;
    setError(null);
    try {
      const folder = await pickFolder();
      if (!folder) return;
      setBusy(true);
      const r = await update(row.bot.id, { repoFolder: folder });
      if (!r.ok) setError(r.message || t('botsPage.profile.repoFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-repo>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.repo')}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span data-bots-profile-repo-key className="min-w-0 truncate text-[var(--text-main)]" title={row.bot.repo?.repoPath}>{row.bot.repo?.repoKey ?? t('botsPage.profile.noRepo')}</span>
          {update && (
            <button
              type="button"
              data-testid="bots-profile-repo-change"
              disabled={busy}
              onClick={() => void change()}
              className={`shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}
            >
              {t(row.bot.repo ? 'settings.factory.addBotChangeFolder' : 'settings.factory.addBotChooseFolder')}
            </button>
          )}
        </div>
        {!row.bot.repo && !error && <p data-bots-profile-repo-hint className="mt-1 text-[11px] text-[var(--text-muted)]">{t('botsPage.profile.repoHint')}</p>}
        {error && <p role="alert" data-bots-profile-repo-error className="mt-1 text-[11px] text-[var(--accent-red)]">{error}</p>}
      </div>
    </div>
  );
}

/** What the bot's workers run on: the default (the presets' engine) or an
 *  installed engine that has a worker guard, saved as the owner. Read-only
 *  text when the port cannot update or list the engines. */
function WorkerEngineLine({ row, t, port }: { row: FactoryBotRow; t: T; port?: Pick<FactoryBotPort, 'update' | 'workerAgents'> }) {
  const [options, setOptions] = useState<BotWorkerAgentOption[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = port?.workerAgents;
  const update = port?.update;
  useEffect(() => {
    if (!list) return;
    let live = true;
    list().then((o) => { if (live) setOptions(o); }, () => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [list]);
  const current = row.bot.workerAgent?.agent ?? '';
  // A save in flight shows its value until the profile catches up.
  useEffect(() => { if (pending !== null && pending === current) setPending(null); }, [pending, current]);
  const defaultName = botWorkerAgentLabel(DEFAULT_BOT_WORKER_AGENT);
  const label = t('botsPage.profile.workersRunOn');
  if (!update || !list) {
    return <ProfileLine label={label} value={<span data-bots-profile-workers-engine>{current ? botWorkerAgentLabel(current) : t('botsPage.profile.workersDefault', { name: defaultName })}</span>} />;
  }
  // Every guarded engine but the default's own (listed only when it is the
  // stored pick), and the stored pick even when the list could not be read.
  const listed = (options ?? []).filter((o) => o.agent !== DEFAULT_BOT_WORKER_AGENT || o.agent === current);
  const choices = current && !listed.some((o) => o.agent === current)
    ? [...listed, { agent: current, label: botWorkerAgentLabel(current), installed: false, supported: true }]
    : listed;
  const save = async (value: string) => {
    setPending(value);
    setError(null);
    try {
      const r = await update(row.bot.id, { workerAgent: value ? { agent: value } : null });
      if (!r.ok) {
        setPending(null);
        setError(r.message || t('botsPage.profile.workersFailed'));
      }
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const optionText = (o: BotWorkerAgentOption): string => {
    if (!o.supported) return t('botsPage.profile.workersUnavailable', { name: o.label });
    return o.installed ? o.label : t('botsPage.profile.workersNotInstalled', { name: o.label });
  };
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-workers-engine>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{label}</span>
      <div className="min-w-0 flex-1">
        <Select
          data-testid="bots-profile-workers-engine"
          aria-label={label}
          value={pending ?? current}
          disabled={pending !== null || options === null}
          onChange={(e) => void save(e.target.value)}
        >
          <option value="">{t('botsPage.profile.workersDefault', { name: defaultName })}</option>
          {choices.map((o) => (
            <option key={o.agent} value={o.agent} disabled={!o.installed || !o.supported}>{optionText(o)}</option>
          ))}
        </Select>
        {error && <p role="alert" className="mt-1 text-[11px] text-[var(--accent-red)]">{error}</p>}
      </div>
    </div>
  );
}

/** Each bot's last presence the runtime reported while the app runs, and
 *  when one last reported parked went unreported (its Resume). */
const lastProfilePresence = new Map<string, BotPresence>();
const profileResumedAt = new Map<string, number>();
/** How long a resumed bot reads "Resuming…" at most. */
export const RESUMING_MAX_MS = 10_000;

/** The profile's state word. A bot the runtime reported parked and now
 *  reports nothing for (its session attaches on its next turn) was just
 *  resumed: it reads "Resuming…" until the runtime reports, for at most
 *  RESUMING_MAX_MS; then it reads as any bot with no turn yet. */
export function profilePresenceKey(
  row: FactoryBotRow,
  now: number = Date.now(),
  last: Map<string, BotPresence> = lastProfilePresence,
  resumedAt: Map<string, number> = profileResumedAt,
): string {
  const id = row.bot.id;
  const presence = botPresence(row);
  if (presence !== 'unknown') {
    last.set(id, presence);
    resumedAt.delete(id);
    return `room.presence.${presence}`;
  }
  if (row.bot.enabled && !row.bot.parked) {
    if (last.get(id) === 'parked') {
      resumedAt.set(id, now);
      last.set(id, 'unknown');
    }
    const at = resumedAt.get(id);
    if (at !== undefined && now - at < RESUMING_MAX_MS) return 'botsPage.profile.resuming';
  }
  return 'room.presence.unknown';
}

/** The profile's state line: on/off and presence, re-read when "Resuming…"
 *  runs out. */
function ProfileState({ row, t }: { row: FactoryBotRow; t: T }) {
  const [, expire] = useState(0);
  const key = profilePresenceKey(row);
  useEffect(() => {
    if (key !== 'botsPage.profile.resuming') return;
    const at = profileResumedAt.get(row.bot.id) ?? Date.now();
    const h = setTimeout(() => expire((n) => n + 1), Math.max(0, at + RESUMING_MAX_MS - Date.now()));
    return () => clearTimeout(h);
  }, [key, row.bot.id]);
  return <ProfileLine label={t('botsPage.profile.state')} value={<span data-bots-profile-state>{`${t(row.bot.enabled ? 'botsPage.profile.on' : 'botsPage.profile.off')} · ${t(key)}`}</span>} />;
}

/** The bot's profile under its name pill: template, job (editable),
 *  workspace, repo, the model it thinks on, what its workers run on and
 *  their model, on/off, what it used today of each limit (and what stops
 *  it, with Resume when parked), its routines
 *  (read-only), the recipe it was added from and what its connections still
 *  need, its connections, then what it can do (the shared powers,
 *  read-only), whom it reports to, its workers now, and Pause and Stop. */
function BotProfile({ row, workers, workspaceName, t, stopPort, jobPort, adminPort }: { row: FactoryBotRow; workers: readonly BotWorker[]; workspaceName: string; t: T; stopPort: BotsStopPort; jobPort?: Pick<FactoryBotPort, 'update' | 'workerAgents'>; adminPort?: BotAdminPort }) {
  const routines = (useBotRoutines()?.routines ?? []).filter((r) => r.botId === row.bot.id);
  const canDo = botCanDo(row.bot);
  const waiting = workers.filter((w) => w.waiting).length;
  const running = workers.length - waiting;
  return (
    <div data-bots-profile={row.bot.id} className="px-3 py-2">
      <ProfileLine label={t('botsPage.profile.template')} value={<span data-bots-profile-template>{botKindLabel(row.bot, t)}</span>} />
      <JobLine key={`${row.bot.id}:${row.bot.job ?? ''}`} row={row} t={t} jobPort={jobPort} />
      <ProfileLine label={t('botsPage.profile.workspace')} value={workspaceName} />
      <RepoLine row={row} t={t} port={jobPort} />
      <BrainModelLine row={row} t={t} port={jobPort} />
      <WorkerEngineLine row={row} t={t} port={jobPort} />
      <WorkerModelLine row={row} t={t} port={jobPort} />
      <ProfileState row={row} t={t} />
      <BotToday row={row} act={adminPort?.act} liveWorkers={workers.length} t={t} />
      {routines.length > 0 && (
        <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-routines>
          <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.routines')}</span>
          <ul className="min-w-0 flex-1 space-y-0.5">
            {routines.map((r) => (
              <li key={r.id} data-bot-routine={r.id} className={`truncate ${r.state !== 'active' ? 'text-[var(--text-muted)]' : 'text-[var(--text-main)]'}`}>
                {`${r.title} · ${routineScheduleText(r.schedule)} · ${routineStateText(r)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <BotRecipeChecklist bot={row.bot} t={t} />
      <BotConnections row={row} t={t} />
      <BotSkills row={row} t={t} />
      <BotMemory row={row} t={t} />
      <BotCommands row={row} t={t} />
      <div className="mt-1 border-t border-[var(--stroke)] pt-1">
        <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-can-do>
          <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.canDo')}</span>
          <ul className="min-w-0 flex-1 space-y-0.5 text-[var(--text-main)]">
            {canDo.map((key) => <li key={key} data-can-do={key}>{t(key)}</li>)}
          </ul>
        </div>
        <ProfileLine label={t('botsPage.profile.reportsTo')} value={<span data-bots-profile-reports-to>{t('botsPage.profile.reportsToYou')}</span>} />
        <ProfileLine
          label={t('botsPage.profile.workersNow')}
          value={(
            <span data-bots-profile-workers={workers.length}>
              {t('botsPage.profile.workersRunning', { count: running })}
              {waiting > 0 && <span className="text-[var(--attention-text)]">{` · ${t('botsPage.profile.workersWaiting', { count: waiting })}`}</span>}
            </span>
          )}
        />
      </div>
      <StopBot row={row} port={stopPort} act={adminPort?.act} t={t} />
      <DeleteBot row={row} port={adminPort} t={t} />
    </div>
  );
}

/** Whether a card waits on the owner's answer: an open question, the live
 *  plan, an open proposal, approval, key or login request. Pure. */
export function waitsOnOwner(card: RoomCardData, livePlans: ReadonlySet<string>): boolean {
  if (card.state !== 'open') return false;
  return card.kind === 'question' || awaitsApproval(card, livePlans);
}

/** The narrow layout's way to a bot's workers without going back to the
 *  list (#2231): a round button right of the name pill, mirroring the back
 *  button, that opens the bot's worker tree as a popover. Shown only in the
 *  one-column layout (bots.css); the wide layout's list shows the tree. */
function HeadWorkers({ rows, name, shownId, t, onOpen }: {
  rows: readonly BotTreeRow[];
  name: string;
  shownId: string | null;
  t: T;
  onOpen: (workspaceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const label = t(open ? 'botsPage.worker.collapse' : 'botsPage.worker.expand', { name, count: rows.length });
  const treeId = 'bots-head-workers';
  return (
    <span ref={wrapRef} className="wmux-bots-head-workers">
      <button
        ref={buttonRef}
        type="button"
        data-bots-head-workers
        aria-expanded={open}
        aria-controls={open ? treeId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={`wmux-bots-back wmux-bots-head-workers-button ${FOCUS_RING}`}
      >
        <IconFanOut size={13} />
        <span className="tabular-nums">{rows.length}</span>
      </button>
      {open && (
        <Popover
          className="wmux-bots-head-workers-pop"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); buttonRef.current?.focus(); } }}
        >
          <BotsWorkerTree id={treeId} rows={rows} name={name} shownId={shownId} t={t} onOpen={(workspaceId) => { setOpen(false); onOpen(workspaceId); }} />
        </Popover>
      )}
    </span>
  );
}

export function BotsChat({ conversation, roomCards, bots, title, workspaceName, t, onBack, api, now, readOnly: pausedView = false, stopPort = {}, jobPort, resumePort, onOpenBot, onEditGroup, threadAsk, onClearArchived }: {
  conversation: Conversation;
  roomCards: readonly RoomCardData[];
  /** Every bot (names for senders and the addressee check). */
  bots: readonly FactoryBotRow[];
  title: string;
  workspaceName: string;
  t: T;
  onBack: () => void;
  api?: RoomsApi | null;
  now?: number;
  /** The bots are off: no answers, nothing sent. */
  readOnly?: boolean;
  /** The stop verbs (botsStop.ts); absent ones show no control. */
  stopPort?: BotsStopPort;
  /** The bot port's update: the profile's job editor and a job_changed
   *  card's Undo (absent: neither); its act and remove: the profile's
   *  Resume and Delete bot. */
  jobPort?: Pick<FactoryBotPort, 'update' | 'workerAgents'> & BotAdminPort;
  /** The bot port's resumeWorker: a done worker's Resume (absent: none). */
  resumePort?: Pick<FactoryBotPort, 'resumeWorker'>;
  /** Opens a bot's 1:1 (absent: no link). */
  onOpenBot?: (botId: string) => void;
  /** A group chat's pill: rename it, change its bots or delete it (absent:
   *  the pill does nothing). */
  onEditGroup?: () => void;
  /** A thread to open beside the chat (a bot row led here to what it asks);
   *  a new nonce opens it again. */
  threadAsk?: { workspaceId: string; threadId: ThreadId; nonce: number };
  /** A deleted bot's 1:1: takes it out of the Archive; a failure's reason,
   *  or null (absent: no Remove from Archive). */
  onClearArchived?: () => Promise<string | null>;
}): React.ReactElement {
  // A deleted bot's 1:1 is read only: no composer, profile or answers.
  const removedBot = conversation.kind === 'bot' && conversation.removed === true;
  const readOnly = pausedView || removedBot;
  const [profileOpen, setProfileOpen] = useState(false);
  const [sent, setSent] = useState<Record<string, SentTo[] | null>>({});
  const [started, setStarted] = useState<ReadonlySet<string>>(() => new Set());
  // The bot list each message was sent against: an idle bot counts as having
  // taken it only on a later read (deliveryTaken).
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const botsAtSend = useRef(new Map<string, readonly FactoryBotRow[]>());
  useEffect(() => {
    const taken = Object.keys(sent).filter((id) => !started.has(id) && deliveryTaken(sent[id], bots, bots !== botsAtSend.current.get(id)));
    if (taken.length > 0) setStarted((cur) => new Set([...cur, ...taken]));
  }, [sent, bots, started]);
  const [openThread, setOpenThread] = useState<{ workspaceId: string; threadId: ThreadId } | null>(null);
  // The file a bot attached that the side panel shows.
  const [openFile, setOpenFile] = useState<OpenRoomFile | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const actors = useStore((s) => s.roomActors);
  const roomThreads = useStore((s) => s.roomThreads);
  const cards = useMemo(() => chatCards(conversation, roomCards, null, roomThreads), [conversation, roomCards, roomThreads]);
  // The plans still waiting (each bot's newest), judged on every card the
  // conversation holds.
  const livePlans = useMemo(() => livePlanIds(roomCards), [roomCards]);
  const waits = useCallback((card: RoomCardData) => waitsOnOwner(card, livePlans), [livePlans]);
  const nameOf = useWorkspaceNames();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // A 1:1 spans rooms, whose seqs are separate: the newest card's id says
  // something new arrived.
  const lastId = cards[cards.length - 1]?.id ?? '';
  const workers = conversation.workers;
  // A room lists its bots' tasks the same way.
  const taskRows = conversation.kind === 'bot' ? [conversation.row] : conversation.bots;
  const tasks = taskRows.flatMap((r) => taskBubbles(r.tasks, now ?? Date.now()));
  // Busy where the turn answers: a turn in a 1:1 (or in a dispatch sent
  // from it, whichever bot runs it) shows in that 1:1, not in the room.
  const turns = conversationTurns(conversation, bots, roomCards, roomThreads);
  // The session's "New" divider: what arrived since this conversation was
  // last read to its end, as it stood when the chat opened.
  const conversationId = conversation.id;
  // Cards that land while the chat is in view are not "new" (liveNewAfter).
  const [newAfter, setNewAfter] = useState(() => useStore.getState().botsSeenAt[conversationId] ?? BOTS_SESSION_START);
  // The threads this conversation started fold into work cards.
  const startedThreads = useMemo(() => conversationStartedThreads(conversation, roomCards, roomThreads), [conversation, roomCards, roomThreads]);
  const { main, threads, surfaced, work } = useMemo(() => splitThreads(cards, waits, startedThreads), [cards, waits, startedThreads]);
  // Who handed it off: a 1:1's bot; in a group, its coordinator or lead bot
  // (only their dispatch opens a thread), the nearest above when several.
  const coordinators = useMemo(
    () => (conversation.kind === 'room' ? new Set(conversation.bots.filter((r) => delegatesFromConversation(r.bot)).map((r) => r.bot.id)) : null),
    [conversation],
  );
  const workAuthor = conversation.kind === 'bot' ? conversation.row.bot.id : coordinators?.size === 1 ? [...coordinators][0] : undefined;
  const items = useMemo(() => {
    const entries: RoomEntry[] = main.map((card) => ({ kind: 'card' as const, card }));
    return buildTimeline(entries, { waits, threads, surfaced, newAfter, work, ...(workAuthor ? { workAuthor } : coordinators ? { workCandidates: coordinators } : {}) });
  }, [main, threads, surfaced, waits, newAfter, work, workAuthor, coordinators]);
  const flows = useConversationWorkflows(conversation, cards);
  const shownItems = useMemo(() => withWorkflows(items, flows.workflows), [items, flows.workflows]);
  const botNames = useMemo(() => bots.map((b) => b.bot.name), [bots]);
  const taskTitle = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of bots) for (const task of r.tasks ?? []) byId.set(task.taskId, task.title);
    return (id: string) => byId.get(id) ?? null;
  }, [bots]);
  const requestTitle = useMemo(() => {
    const byThread = requestTitles(roomCards);
    return (threadId: ThreadId) => byThread.get(threadId) ?? null;
  }, [roomCards]);
  const idLabels = useIdLabels(bots, t);
  // A work card's state reads its tasks; its chip, the PR a task opened.
  const workCtx = useMemo((): NonNullable<RowCtx['work']> => {
    const tasks = bots.flatMap((r) => r.tasks ?? []);
    const urls = new Map<string, string>();
    for (const r of bots) {
      const repo = r.bot.repo?.repoKey;
      if (!repo || !/^github\.com\//.test(repo)) continue;
      for (const task of r.tasks ?? []) if (task.pr) urls.set(task.taskId, `https://${repo}/pull/${task.pr.number}`);
    }
    return { waits, tasks, prUrl: (taskId) => urls.get(taskId) ?? null };
  }, [bots, waits]);

  // An open conversation is read: the list row's unread count clears while
  // the window and the chat are in view, wherever it is scrolled (the
  // "N new" pill keeps the scroll position's own count).
  const newestAt = useMemo(() => cards.reduce((m, c) => (c.actor.kind === 'bot' && c.at > m ? c.at : m), 0), [cards]);
  const inView = useCallback((): boolean => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    // The narrow layout keeps the chat mounted but hidden behind the list.
    const el = scrollRef.current;
    return !(el && typeof el.checkVisibility === 'function' && !el.checkVisibility());
  }, []);
  const markSeen = useCallback(() => {
    if (newestAt <= 0 || !inView()) return;
    useStore.getState().markBotsSeen(conversationId, newestAt);
  }, [conversationId, newestAt, inView]);
  // "N new" while scrolled up: the cards from others newer than any seen
  // before (older history read in later is not new), and the workflows saved
  // since the chat opened.
  const [newCount, setNewCount] = useState(0);
  const newestSeen = useRef(cards.reduce((m, c) => Math.max(m, c.at), 0));
  const openedAt = useRef(Date.now());
  const countedFlows = useRef(new Set<string>());
  useEffect(() => {
    const before = newestSeen.current;
    const added = cards.filter((c) => c.actor.kind !== 'human' && c.at > before).length;
    const addedFlows = countNewWorkflows(flows.workflows, countedFlows.current, openedAt.current);
    newestSeen.current = cards.reduce((m, c) => Math.max(m, c.at), before);
    if (added > 0) {
      const visible = inView();
      const at = Date.now();
      setNewAfter((cur) => liveNewAfter(cards, cur, before, visible, at));
    }
    // A workflow card read in later (flows.workflows) is pinned the same way.
    const el = scrollRef.current;
    if (el && atBottom.current) {
      // A hidden window draws no frames, and Blink keeps a scroll event (with
      // the whole chat, once it unmounts) until the next one: pin on return.
      if (document.visibilityState !== 'hidden') el.scrollTop = el.scrollHeight;
    } else if (added + addedFlows > 0) setNewCount((n) => n + added + addedFlows);
    markSeen();
  }, [lastId, workers.length, markSeen, cards, inView, flows.workflows]);
  useEffect(() => {
    const onVisible = () => {
      const el = scrollRef.current;
      if (el && atBottom.current && document.visibilityState !== 'hidden') el.scrollTop = el.scrollHeight;
      markSeen();
    };
    document.addEventListener('visibilitychange', onVisible);
    // A window brought back to the front may not change visibility.
    window.addEventListener('focus', onVisible);
    // The chat coming into view (the narrow layout's list → chat) resizes it.
    // A side panel opening narrows it and its cards grow taller: a chat read
    // at the bottom stays at the bottom.
    const el = scrollRef.current;
    const ro = el && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (atBottom.current) el.scrollTop = el.scrollHeight;
        markSeen();
      })
      : null;
    if (el) ro?.observe(el);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      ro?.disconnect();
    };
  }, [markSeen]);
  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setNewCount(0);
    markSeen();
  };

  const onSent = useCallback((cardId: string, to: SentTo[] | null) => {
    atBottom.current = true;
    botsAtSend.current.set(cardId, botsRef.current);
    setSent((cur) => ({ ...cur, [cardId]: to }));
  }, []);
  // The profile closes on Escape or a press outside it (the pill toggles it).
  const profileRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!profileOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!profileRef.current?.contains(target) && !pillRef.current?.contains(target)) setProfileOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setProfileOpen(false);
      pillRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [profileOpen]);
  const presence = conversation.kind === 'bot' && !removedBot ? botPresence(conversation.row) : null;
  const group = conversation.kind === 'room';
  // One side panel at a time: a worker's terminal, a thread or a file a bot
  // attached. The worker panel belongs to the conversation it was opened
  // from: another conversation closes it (the thread and the file are this
  // chat's own state: BotsChat is keyed by its conversation).
  const panel = useStore((s) => s.botsWorkerPanel);
  const shownId = panel && panel.conversationId === conversationId ? panel.workspaceId : null;
  const hostedId = useStore(selectWorkerPanelHost);
  useEffect(() => {
    const st = useStore.getState();
    if (st.botsWorkerPanel && st.botsWorkerPanel.conversationId !== conversationId) st.setBotsWorkerPanel(null);
  }, [conversationId]);
  const openWorker = useCallback((workspaceId: string) => {
    setOpenThread(null);
    setOpenFile(null);
    useStore.getState().setBotsWorkerPanel({ workspaceId, conversationId });
  }, [conversationId]);
  const onThread = useCallback((workspaceId: string, threadId: ThreadId) => {
    useStore.getState().setBotsWorkerPanel(null);
    setOpenFile(null);
    setOpenThread({ workspaceId, threadId });
  }, []);
  // Another file replaces the one shown.
  const onOpenFile = useCallback((open: OpenRoomFile) => {
    useStore.getState().setBotsWorkerPanel(null);
    setOpenThread(null);
    setOpenFile(open);
  }, []);
  // The chat and its side panel share the width by the splitter.
  const areaRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(readSideSplit);
  const onSplit = useCallback((next: number, done: boolean) => {
    setSplit(next);
    if (done) writeSideSplit(next);
  }, []);
  const sideStyle = useMemo((): React.CSSProperties => ({ width: `${(split * 100).toFixed(2)}%` }), [split]);
  // Resume from the panel's menu: the resumed worker's pane (a new one when
  // the old was cleared) takes the panel; a failure is a toast.
  // An answer that comes after the owner moved on (another worker, Close,
  // another conversation) leaves the panel as it is now.
  // A chat that closed or moved to another conversation since opens nothing.
  const shownChat = useRef({ mounted: true, conversationId });
  shownChat.current.conversationId = conversationId;
  useEffect(() => {
    shownChat.current.mounted = true;
    return () => { shownChat.current.mounted = false; };
  }, []);
  const locale = useStore((s) => s.locale);
  const resumeShown = useCallback(async (taskId: string): Promise<void> => {
    const resume = resumePort?.resumeWorker;
    if (!resume) return;
    const asked = useStore.getState().botsWorkerPanel;
    await resume(taskId).then((r) => {
      if (!r.ok) useStore.getState().pushToast({ message: resumeRefusalText(r, t) || t('botsPage.worker.resume'), level: 'error' });
      else if (r.workspaceId && shownChat.current.mounted && shownChat.current.conversationId === conversationId && useStore.getState().botsWorkerPanel === asked) {
        useStore.getState().setBotsWorkerPanel({ workspaceId: r.workspaceId, conversationId });
      }
    }).catch((err: unknown) => useStore.getState().pushToast({ message: String(err), level: 'error' }));
  }, [resumePort, conversationId, t, locale]);
  const askedNonce = threadAsk?.nonce;
  useEffect(() => {
    if (threadAsk) onThread(threadAsk.workspaceId, threadAsk.threadId);
    // Only a new ask opens it: closing the panel is not undone on re-render.
  }, [askedNonce]);
  // A worker picked in the list while a thread or a file is open takes the side.
  useEffect(() => {
    if (!shownId) return;
    setOpenThread(null);
    setOpenFile(null);
  }, [shownId]);
  const tree = conversation.kind === 'bot' ? conversation.tree : EMPTY_TREE;
  const shown = shownId && !openThread && !openFile ? workerPanelView(shownId, workers, tree, tasks, t) : null;
  // A Stop worker under way, or one main answered partial, keeps the item
  // offered once its task is cancelled, so the owner can stop again.
  const stopUnfinished = useWorkerStopUnfinished(shown?.taskId);
  const shownStopTaskId = shown?.stopTaskId ?? (stopUnfinished ? shown?.taskId : undefined);
  // The rail lists only the tasks with no row in the list's tree.
  const openWorkspaceIds = useStore(useShallow((s) => s.workspaces.map((w) => w.id)));
  // An ended task is never a rail row (owner decision 2026-10-16), only one
  // waiting for a slot or still open.
  const railTasks = useMemo(() => {
    const open = new Set(openWorkspaceIds);
    return tasks.filter((task) => {
      const pane = task.workerWorkspaceId ?? task.taskWorkspaceId;
      const ended = task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed';
      return task.stage === 'waiting_slot' || (!ended && (!pane || !open.has(pane)));
    });
  }, [tasks, openWorkspaceIds]);
  // PR and issue links become chips: titled from a thread this conversation
  // holds, which they open beside the chat.
  const pattern = useMemo(() => mentionPattern(bots.map((b) => b.bot.name)), [bots]);
  const markdown = useMemo((): MarkdownOptions => ({
    links: true,
    richCode: true,
    htmlPreview: true,
    // Worker and bot text carries code-like runs (2**31): `*` between
    // letters or digits is never emphasis here.
    strictEmphasis: true,
    ...(pattern ? {
      mention: {
        pattern,
        render: (name: string) => {
          const row = bots.find((b) => b.bot.name.trim() === name);
          if (!row) return `@${name}`;
          return (
            <span data-bots-mention={row.bot.id} className="wmux-bots-mention" style={{ color: botIdentityColor(row.bot.id) }}>
              <BotAvatar bot={row.bot} size={14} />
              {name}
            </span>
          );
        },
      },
    } : {}),
    linkChip: (url, label) => {
      const ref = githubRef(url);
      if (!ref) return null;
      const threadId = `${ref.kind}:${ref.repoKey}#${ref.number}` as ThreadId;
      const holder = cards.find((c) => c.threadId === threadId);
      const summary = holder ? roomThreads[holder.workspaceId]?.find((th) => th.threadId === threadId) : undefined;
      return <RefChip url={url} label={label} title={summary?.title ?? null} onOpen={holder ? () => onThread(holder.workspaceId, threadId) : null} />;
    },
  }), [cards, roomThreads, onThread, pattern, bots]);
  // The Resume on a system card saying a stopped worker can resume: the
  // same resume as the panel's menu.
  // Every task the bots list, not only the few the rail shows.
  const cardResume = useMemo((): RowCtx['resume'] => (readOnly || !resumePort?.resumeWorker ? undefined : {
    resumable: (taskId) => taskRows.some((row) => (row.tasks ?? []).some((task) => task.taskId === taskId && task.worker === 'resumable')),
    run: resumeShown,
  }), [readOnly, resumePort, taskRows, resumeShown]);
  const ctx: RowCtx = { t, bots, actors, api, now, readOnly, jobPort: readOnly ? undefined : jobPort, nameOf, botNames, taskTitle, requestTitle, idLabels, sent, started, onThread, onOpenBot, markdown, ...(conversation.kind === 'bot' ? { selfBot: conversation.row.bot.id } : {}), ...(cardResume ? { resume: cardResume } : {}), work: workCtx, onOpenFile, shownFileId: openFile?.file.id ?? null };
  // The open thread is read whole, from its first card (the cached room
  // timeline holds only its newest page), and shown from every card read
  // for the room — not only this conversation's.
  useEffect(() => {
    if (openThread) void loadWholeThread(openThread.workspaceId, openThread.threadId);
  }, [openThread]);
  const threadShown = openThread ? threadCards(roomCards, openThread.workspaceId, openThread.threadId) : null;
  const empty = shownItems.length === 0;

  return (
    <div ref={areaRef} className="wmux-bots-chat-area" data-worker-open={shownId || openThread || openFile ? 'true' : undefined}>
    <section className="wmux-bots-chat" data-bots-chat={conversation.id} aria-label={title}>
      <div className="wmux-bots-chat-head">
        <button type="button" data-bots-back onClick={onBack} aria-label={t('botsPage.back')} title={t('botsPage.back')} className={`wmux-bots-back ${FOCUS_RING}`}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9,2.5 4.5,7 9,11.5" /></svg>
        </button>
        <button
          type="button"
          ref={pillRef}
          data-bots-pill
          aria-expanded={conversation.kind === 'bot' && !removedBot ? profileOpen : undefined}
          aria-haspopup={conversation.kind === 'room' && onEditGroup ? 'dialog' : undefined}
          title={conversation.kind === 'room' && onEditGroup ? t('botsPage.group.edit') : undefined}
          onClick={() => (conversation.kind === 'bot' ? setProfileOpen((v) => !v) : onEditGroup?.())}
          disabled={removedBot || (conversation.kind !== 'bot' && !onEditGroup)}
          className={`wmux-bots-pill ${FOCUS_RING}`}
        >
          {conversation.kind === 'bot' ? <BotAvatar bot={conversation.row.bot} size={20} /> : <RoomAvatar bots={conversation.bots} size={20} layout="row" />}
          <span className="min-w-0 truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{title}</span>
          {presence && <PresenceDot presence={presence} />}
          {group && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{conversation.bots.length === 1 ? t('botsPage.botCountOne') : t('botsPage.botCount', { count: conversation.bots.length })}</span>}
        </button>
        {tree.length > 0 && <HeadWorkers rows={tree} name={title} shownId={shownId} t={t} onOpen={openWorker} />}
      </div>
      {profileOpen && conversation.kind === 'bot' && !removedBot && (
        <div className="wmux-bots-profile" ref={profileRef}><BotProfile row={conversation.row} workers={workers} workspaceName={workspaceName} t={t} stopPort={stopPort} jobPort={readOnly ? undefined : jobPort} adminPort={readOnly ? (jobPort?.remove ? { remove: jobPort.remove } : undefined) : jobPort} /></div>
      )}

      <div className="wmux-bots-scroll-wrap">
        <div
          ref={scrollRef}
          role="log"
          aria-label={title}
          data-bots-messages
          className="wmux-bots-messages"
          onScroll={(e) => {
            const el = e.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            atBottom.current = bottom;
            if (bottom) {
              setNewCount(0);
              markSeen();
            }
          }}
        >
          <div className="wmux-bots-column">
            {empty && conversation.kind === 'bot' && !removedBot && (
              <ChatIntro row={conversation.row} t={t} readOnly={readOnly} onPick={(text) => setPrefill({ text, nonce: Date.now() })} />
            )}
            {empty && conversation.kind === 'room' && (
              <p data-bots-empty-chat className="py-8 text-center text-[12px] text-[var(--text-muted)]">{emptyGroupLine(conversation.bots, t)}</p>
            )}
            <TimelineView items={shownItems} ctx={ctx} group={group} onCancelWorkflow={flows.cancel} />
          </div>
        </div>
        {newCount > 0 && (
          <button type="button" data-bots-new-pill onClick={toBottom} className={`wmux-bots-new-pill ${FOCUS_RING}`}>
            {t('botsPage.chat.newCount', { count: newCount })}
          </button>
        )}
      </div>

      <div className="wmux-bots-column wmux-bots-foot">
        <WorkingRail turns={turns} tasks={railTasks} t={t} now={now} readOnly={readOnly} resumePort={resumePort} shownId={shownId} onOpen={openWorker} />
        {removedBot ? (
          <>
            <p data-bots-removed-note className="py-3 text-center text-[12px] text-[var(--text-muted)]">{t('botsPage.removedChat')}</p>
            {onClearArchived && conversation.kind === 'bot' && <ClearArchived name={conversation.row.bot.name} t={t} onClear={onClearArchived} />}
          </>
        ) : (
        <div className="wmux-bots-composer">
          <BotsComposer
            conversation={conversation}
            threadId={conversation.kind === 'bot' ? dmThreadId(conversation.row.bot.id) : conversation.threadId}
            bots={bots}
            placeholder={composerHint(conversation, cards.length, title, t)}
            t={t}
            api={api}
            onSent={onSent}
            readOnly={readOnly}
            cards={cards}
            prefill={prefill}
          />
        </div>
        )}
      </div>
    </section>
    {((openThread && threadShown) || (shownId && shown) || openFile) && <SideSplitter areaRef={areaRef} split={split} t={t} onChange={onSplit} />}
    {openThread && threadShown && (
      <BotsThreadPanel
        key={`${openThread.workspaceId}:${openThread.threadId}`}
        conversation={conversation}
        cards={threadShown}
        workspaceId={openThread.workspaceId}
        threadId={openThread.threadId}
        ctx={ctx}
        waits={waits}
        bots={bots}
        api={api}
        readOnly={readOnly}
        onClose={() => setOpenThread(null)}
        onSent={onSent}
        style={sideStyle}
      />
    )}
    {openFile && (
      <BotsFilePanel
        key={`${openFile.workspaceId}:${openFile.file.id}`}
        open={openFile}
        api={api}
        t={t}
        onClose={() => setOpenFile(null)}
        style={sideStyle}
      />
    )}
    {!openThread && shownId && shown && (
      <BotsWorkerPanel
        workspaceId={shownId}
        hosted={hostedId === shownId}
        name={shown.name}
        state={shown.state}
        attention={shown.attention}
        t={t}
        onClose={() => useStore.getState().setBotsWorkerPanel(null)}
        onResume={shown.resumeTaskId && !readOnly && resumePort?.resumeWorker ? () => resumeShown(shown.resumeTaskId!) : undefined}
        stop={shownStopTaskId && stopPort.stopTask ? { taskId: shownStopTaskId, stopTask: stopPort.stopTask } : undefined}
        style={sideStyle}
      />
    )}
    </div>
  );
}
