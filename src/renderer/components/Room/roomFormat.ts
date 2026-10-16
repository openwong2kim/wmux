// Pure display helpers for rooms and bot chats: labels, times and the one
// state word a card may colour.
import { BOT_ROLES, botTemplate, type BotRole, type BotTemplate } from '../../../shared/bot';
import type { Party } from '../../../shared/handoff';
import type { CardKind, RoomCard, ThreadId, ThreadSummary } from '../../../shared/room';
import type { FactoryBotRow } from './factoryPorts';
import { getLocale } from '../../i18n';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A thread's reference, short: `owner/repo#12` (github.com dropped), a
 *  task or handoff id, or the localized General (or 1:1, or group chat). */
export function threadRef(threadId: ThreadId, t: T): string {
  if (threadId === 'general') return t('room.thread.general');
  // A bot's 1:1 with the owner: never its id.
  if (threadId.startsWith('dm:')) return t('room.thread.dm');
  // A group chat the owner made: never its id.
  if (threadId.startsWith('group:')) return t('room.thread.group');
  const numbered = /^(pr|issue):(.+)#(\d+)$/.exec(threadId);
  if (numbered) {
    const repo = numbered[2].replace(/^github\.com\//, '');
    return `${repo}#${numbered[3]}`;
  }
  const opaque = /^(task|handoff|plan|report):(.+)$/.exec(threadId);
  return opaque ? `${opaque[1]} ${opaque[2]}` : threadId;
}

/** A thread's name as the owner reads it, never an internal id: a PR or an
 *  issue keeps its reference, a task its title (`taskTitle`, when known), a
 *  request the owner's words that opened it (`requestTitle`, when known),
 *  and a task, request, plan or report otherwise its kind word. Pure. */
export function threadLabel(
  threadId: ThreadId,
  t: T,
  taskTitle?: (taskId: string) => string | null | undefined,
  requestTitle?: (threadId: ThreadId) => string | null | undefined,
): string {
  if (threadId === 'general') return t('room.thread.general');
  if (/^(pr|issue):(.+)#(\d+)$/.test(threadId)) return threadRef(threadId, t);
  const opaque = /^(task|handoff|plan|report):(.+)$/.exec(threadId);
  if (!opaque) return threadRef(threadId, t);
  const title = opaque[1] === 'task' ? taskTitle?.(opaque[2])?.trim()
    : opaque[1] === 'handoff' ? requestTitle?.(threadId)?.trim()
    : undefined;
  if (title) return title;
  return t(`room.thread.${opaque[1]}`);
}

/** Each request thread's name: the first line of the owner's message that
 *  opened it (the card main links from the thread's opening hop,
 *  refs.requestCardId). Pure. */
export function requestTitles(cards: readonly RoomCard[]): Map<ThreadId, string> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out = new Map<ThreadId, string>();
  for (const c of cards) {
    const id = c.refs?.requestCardId;
    // Only main's line for the hop that opened this very thread names it.
    if (!id || out.has(c.threadId) || c.actor.kind !== 'system' || c.threadId !== `handoff:${c.refs?.handoffId}`) continue;
    const request = byId.get(id);
    // The request was said in General, a coordinator's 1:1 or a group chat.
    const own = request?.kind === 'human' && (request.threadId === 'general' || request.threadId.startsWith('dm:') || request.threadId.startsWith('group:')) && request.workspaceId === c.workspaceId;
    const line = own ? request.title.split('\n')[0].trim() : '';
    if (line) out.set(c.threadId, line);
  }
  return out;
}

/** Whether a thread is named by its PR or issue reference (shown in mono). */
export function isRefThread(threadId: string): boolean {
  return /^(pr|issue):/.test(threadId);
}

/** A `routine` card's body as the owner reads it: the schedule line main
 *  writes first, without the instructions the bot gave itself (those name
 *  tools and ids). Pure. */
export function routineCardBody(body: string | undefined): string {
  return (body ?? '').trim().split(/\n\s*\n/)[0]?.trim() ?? '';
}

/** The machine reasons main appends to a line: a trailing run of inline
 *  codes shaped `predicate:reason` or `lane-paused` (a dash or a colon, so
 *  an ordinary word in backticks is never one). */
const TRAILING_REASON_CODES = /(?:\s*`[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?`)+\s*$/;
const REASON_CODE_SHAPE = /^`[a-z0-9]+(?:(?:-|:)[a-z0-9]+)+`$/;

/** A refusal's body without the machine codes main keeps after each plain
 *  sentence. Inline code inside a sentence stays; a line that is only a
 *  code is kept as it is (nothing else would say why). Pure. */
export function withoutReasonCodes(body: string): string {
  return body.split('\n').map((line) => {
    const tail = TRAILING_REASON_CODES.exec(line);
    if (!tail) return line;
    const codes = tail[0].trim().split(/\s+/);
    if (!codes.every((c) => REASON_CODE_SHAPE.test(c))) return line;
    const plain = line.slice(0, tail.index).trimEnd();
    return /[\p{L}\p{N}]/u.test(plain.replace(/^\s*[-*]\s*/, '')) ? plain : line;
  }).join('\n');
}

/** Text with a bot's legacy role tag after its name removed ("Wmux Dev
 *  (lead)" → "Wmux Dev"): bots are named, roles are internal. Only after a
 *  name in `names`. Pure. */
export function withoutRoleTags(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) {
    const n = name.trim();
    if (!n) continue;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(${escaped}) \\((?:${BOT_ROLES.join('|')})\\)`, 'g'), '$1');
  }
  return out;
}

/** What an internal id stands for, when the renderer knows (null: it does
 *  not, and the id is left as it is). */
export interface IdLabels {
  /** A task's title, by task id. */
  taskTitle?: (taskId: string) => string | null | undefined;
  /** An approval request's label ("PR #2 approval"), by request id. */
  approval?: (requestId: string) => string | null | undefined;
}

const TASK_ID = String.raw`(?:task:)?(wtask-[a-z0-9]+-[a-z0-9]+)`;
const APPROVAL_ID = String.raw`(apr-[A-Za-z0-9_-]{8,32})`;
const NUMBERED_THREAD = String.raw`(pr|issue):(?:github\.com/)?[\w.-]+/[\w.-]+#(\d+)`;
/** Inline code as the room's markdown renders it (BrainMarkdown.tsx). */
const INLINE_CODE = /(`[^`\n]+`)/;

/** Bot text with the internal ids it names shown as what they stand for: a
 *  task id as the task's title, an approval id as its label, a PR or issue
 *  thread id as "PR #N" / "issue #N". Only ids that resolve change; an id
 *  that is a whole inline code span loses the backticks with it; any other
 *  inline code and fenced code blocks stay as written — code as the room's
 *  markdown renders it: a fence opens at a line starting with ``` and runs
 *  to the next such line (or the end). Pure. */
export function withoutInternalIds(text: string, labels: IdLabels): string {
  const label = (kind: 'task' | 'approval', id: string): string | null => {
    const v = (kind === 'task' ? labels.taskTitle?.(id) : labels.approval?.(id))?.trim();
    return v || null;
  };
  const swap = (part: string): string => part
    .replace(new RegExp(String.raw`\x60${TASK_ID}\x60|(?<![\w-])${TASK_ID}(?![\w-])`, 'g'), (m, a?: string, b?: string) => label('task', (a ?? b) as string) ?? m)
    .replace(new RegExp(String.raw`\x60${APPROVAL_ID}\x60|(?<![\w-])${APPROVAL_ID}(?![\w-])`, 'g'), (m, a?: string, b?: string) => label('approval', (a ?? b) as string) ?? m)
    .replace(new RegExp(String.raw`\x60${NUMBERED_THREAD}\x60|(?<![\w-])${NUMBERED_THREAD}(?![\w-])`, 'g'), (_m, k1?: string, n1?: string, k2?: string, n2?: string) => `${(k1 ?? k2) === 'pr' ? 'PR' : 'issue'} #${n1 ?? n2}`);
  // Inline code is code unless it is just the id.
  const onlyId = new RegExp(String.raw`^\x60(?:${TASK_ID}|${APPROVAL_ID}|${NUMBERED_THREAD})\x60$`);
  const prose = (part: string): string => part.split(INLINE_CODE).map((p, i) => (i % 2 === 0 || onlyId.test(p) ? swap(p) : p)).join('');
  let fenced = false;
  return text.split('\n').map((line) => {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      return line;
    }
    return fenced ? line : prose(line);
  }).join('\n');
}

/** The factory system cards this build words in the reader's language
 *  (RoomCard.notice): code → whether its body is worded too (true) or is the
 *  evidence the card carries (a command, an error), kept as written. */
const NOTICE_CODES: ReadonlyMap<string, boolean> = new Map([
  ['worker.paused', true], ['worker.pausedResumable', true], ['worker.idlePausedResumable', true],
  ['worker.done', true], ['worker.doneResumable', true],
  ['worker.resumed', true], ['worker.waiting', true],
  ['worker.noReport', true], ['worker.stillNoReport', true],
  ['gate.checked', false], ['gate.passedNotCompleted', false],
  ['gate.passed', false], ['gate.killed', false], ['gate.failed', false],
  ['gate.skipped', false], ['gate.busy', true], ['gate.noBase', true], ['gate.refused', false],
  ['gate.notRunNoBot', true], ['gate.notRunNoWorktree', true], ['gate.notRunNoBaseRef', true],
  ['research.completed', true], ['research.notCompleted', false],
  ['budget.exhausted', true], ['budget.held', true], ['bot.usageLimit', false],
  ['task.done', false], ['task.reported', false], ['task.failed', false], ['task.cancelled', false],
  ['task.stoppedByOwner', false], ['task.inputRequired', false],
  ['verify.passed', false], ['verify.killed', false], ['verify.failed', false], ['verify.skipped', false],
  ['verify.busy', true], ['verify.refused', false],
  ['verify.notRunNoBot', true], ['verify.notRunNoWorktree', true], ['verify.notRunNoBaseRef', true],
  ['pr.merged', false], ['pr.closed', false], ['verdict.recorded', false],
  ['handoff.sent', false], ['thread.finished', false], ['thread.stopped', false],
  ['bot.error', false], ['worker.startFailed', false],
]);

/** The notice codes that tell the owner a stopped worker can resume. */
export const RESUMABLE_NOTICE_CODES: ReadonlySet<string> = new Set(['worker.pausedResumable', 'worker.idlePausedResumable', 'worker.doneResumable']);

/** The task a system card offers Resume for: a card saying a stopped
 *  worker can resume (by its notice code), whose task's worker is still
 *  resumable now (`resumable`: an older card for a worker resumed since
 *  offers nothing). Null otherwise. Pure. */
export function cardResumeTaskId(card: Pick<RoomCard, 'actor' | 'notice' | 'refs'>, resumable: (taskId: string) => boolean): string | null {
  if (card.actor.kind !== 'system' || !card.notice || !RESUMABLE_NOTICE_CODES.has(card.notice.code)) return null;
  const taskId = card.refs?.taskId;
  return taskId && resumable(taskId) ? taskId : null;
}

const NOTICE_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  status: new Set(['completed', 'cancelled', 'failed']),
  by: new Set(['owner', 'bot']),
  where: new Set(['folder', 'newPane']),
  limit: new Set(['turns_hour', 'turns_day', 'concurrent_workers', 'worker_hours_day', 'factory_workers']),
  // The task a resumable worker card is about: a research task has a task
  // folder, not a worktree.
  kind: new Set(['research']),
  // A hop's kind (handoffRouter.ts HandoffKind) on a card to a bot.
  hop: new Set(['dispatch', 'result', 'message', 'refusal', 'answer']),
  verdict: new Set(['pass', 'fail']),
  // Why a worker could not start (botNotices.ts START_FAILURES).
  cause: new Set(['fetch', 'worktree', 'repository', 'promptFile', 'slot', 'pane', 'setupStep', 'setup']),
};

/** Why wmux moved a task to input_required (roomWriter.ts inputRequiredWhy). */
const INPUT_REQUIRED_WHY: ReadonlySet<string> = new Set(['trustDialog', 'firstRun', 'launchFailed']);

/** Why a gate was skipped (TaskGateRunner.ts GateSkipReason). */
const GATE_SKIP_REASONS: ReadonlySet<string> = new Set(['deps_missing', 'no_gate_command', 'gate_unavailable']);

/** A notice's clock time in the app's language: the time today, else a
 *  short date and the time. */
export function formatNoticeTime(at: number, now: number = Date.now(), locale: string = getLocale()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`;
}

/** What holds the agent slots on a slot-wait card, in the reader's
 *  language, from the values main sends (agentSlots.ts slotHolderArgs):
 *  bots in a turn, workers by title, then the rest. Null for a card
 *  written before them (its English `holders` stays). */
function slotHoldersText(args: Readonly<Record<string, string | number>>, t: T): string | null {
  const botCount = typeof args.botCount === 'number' ? args.botCount : null;
  const workerCount = typeof args.workerCount === 'number' ? args.workerCount : null;
  if (botCount === null && workerCount === null) return null;
  const names = (v: unknown): string[] => (typeof v === 'string' && v ? v.split('\n') : []);
  const list = (shown: string[], total: number): string => (total > shown.length
    ? t('room.notice.holders.more', { names: shown.join(', '), count: total - shown.length })
    : shown.join(', '));
  const parts: string[] = [];
  if (botCount) parts.push(t(botCount === 1 ? 'room.notice.holders.bot' : 'room.notice.holders.bots', { names: list(names(args.bots), botCount) }));
  if (workerCount) {
    const shown = names(args.workers).map((w) => `"${w}"`);
    parts.push(t(workerCount === 1 ? 'room.notice.holders.worker' : 'room.notice.holders.workers', { names: list(shown, workerCount) }));
  }
  const inUse = typeof args.inUse === 'number' ? args.inUse : 0;
  const rest = inUse - (botCount ?? 0) - (workerCount ?? 0);
  if (rest > 0) parts.push(t(rest === 1 ? 'room.notice.holders.other' : 'room.notice.holders.others', { count: rest }));
  return parts.length > 0 ? parts.join('; ') : t('room.notice.holders.none');
}

/** The title and body keys of a budget notice: which limit, and when the
 *  bot picks up again (a time, else what lifts it). */
function budgetNoticeKeys(code: string, args: Readonly<Record<string, string | number>>): { title: string; body: string } | null {
  const timed = typeof args.until === 'number';
  if (code === 'budget.held') return { title: 'room.notice.budget.held', body: timed ? 'room.notice.budget.held.at' : 'room.notice.budget.held.manual' };
  if (code !== 'budget.exhausted' || args.limit === undefined) return null;
  const turns = args.limit === 'turns_hour' || args.limit === 'turns_day';
  return {
    title: `room.notice.budget.exhausted.${args.limit}`,
    body: timed ? 'room.notice.budget.exhausted.at' : turns ? 'room.notice.budget.exhausted.manual' : 'room.notice.budget.exhausted.workers',
  };
}

/** A system card's words in the reader's language, from its stable code
 *  (RoomCard.notice); null for a card with none or a code this build does
 *  not know (its English title and body are shown). Pure over `t`. */
export function noticeText(card: Pick<RoomCard, 'actor' | 'body' | 'notice'>, t: T, now: number = Date.now()): { title: string; body: string } | null {
  const notice = card.actor.kind === 'system' ? card.notice : undefined;
  const wordedBody = notice ? NOTICE_CODES.get(notice.code) : undefined;
  if (!notice || wordedBody === undefined) return null;
  const args = notice.args ?? {};
  const vars: Record<string, string | number> = { ...args };
  // A word the template needs, worded too; one this build does not know
  // keeps the card's English.
  for (const [key, known] of Object.entries(NOTICE_WORDS)) {
    if (args[key] === undefined) continue;
    if (!known.has(String(args[key]))) return null;
  }
  if (args.status !== undefined) {
    vars.status = t(`room.notice.status.${args.status}`);
    vars.pane = t(args.status === 'failed' ? 'room.notice.pane.stays' : 'room.notice.pane.closes');
  }
  if (args.by !== undefined) vars.who = t(`room.notice.by.${args.by}`);
  if (args.where !== undefined) vars.place = t(`room.notice.where.${args.where}`);
  if (typeof args.until === 'number') vars.time = formatNoticeTime(args.until, now);
  // Why a gate did not run, worded; a reason this build does not know stays as written.
  if ((notice.code === 'gate.skipped' || notice.code === 'verify.skipped') && typeof args.reason === 'string' && GATE_SKIP_REASONS.has(args.reason)) {
    vars.reason = t(`room.notice.gate.reason.${args.reason}`);
  }
  if (notice.code === 'worker.waiting') {
    const holders = slotHoldersText(args, t);
    if (holders !== null) vars.holders = holders;
  }
  // Why wmux moved a task to input_required, worded (roomWriter inputRequiredWhy).
  if (notice.code === 'task.inputRequired' && typeof args.why === 'string' && INPUT_REQUIRED_WHY.has(args.why)) {
    return { title: t(`room.notice.${notice.code}`, vars), body: t(`room.notice.task.inputRequired.why.${args.why}`, vars) };
  }
  if (args.verdict !== undefined) vars.verdict = t(`room.notice.verdict.${args.verdict}`);
  if (args.cause !== undefined) vars.cause = t(`room.notice.worker.startFailed.cause.${args.cause}`);
  const budget = budgetNoticeKeys(notice.code, args);
  if (budget) return { title: t(budget.title, vars), body: t(budget.body, vars) };
  // A hop says what it carried: one template per kind, forwarded by wmux
  // for a coordinator's relay.
  if (notice.code === 'handoff.sent') {
    if (args.hop === undefined) return null;
    const hop = t(`room.notice.handoff.${args.hop}`, vars);
    return { title: args.relay ? t('room.notice.handoff.forwarded', { hop }) : hop, body: card.body ?? '' };
  }
  // A PR closed with no title known says only its number.
  if ((notice.code === 'pr.merged' || notice.code === 'pr.closed') && args.title === undefined) {
    return { title: t(`room.notice.${notice.code}.untitled`, vars), body: card.body ?? '' };
  }
  const key = `room.notice.${notice.code}`;
  const bodyKey = args.kind === 'research' && RESUMABLE_NOTICE_CODES.has(notice.code) ? `${key}.body.research` : `${key}.body`;
  return { title: t(key, vars), body: wordedBody ? t(bodyKey, vars) : (card.body ?? '') };
}

/** A card's title and body as the owner reads them: a factory system card
 *  in the reader's language (`t`, noticeText), a routine's schedule (not the
 *  bot's own instructions), a refusal's plain sentences (not their codes), no
 *  role tag after a bot's name in what main wrote, and in a bot's own words
 *  the ids it cites shown as what they stand for (`labels`). Pure. */
export function ownerCardText(card: Pick<RoomCard, 'kind' | 'title' | 'body' | 'actor' | 'notice'>, botNames: readonly string[], labels?: IdLabels, t?: T): { title: string; body: string } {
  const worded = t ? noticeText(card, t) : null;
  let title = worded?.title ?? card.title;
  let body = (worded?.body ?? card.body ?? '').trim();
  if (card.kind === 'routine') body = routineCardBody(body);
  if (card.kind === 'refusal') body = withoutReasonCodes(body);
  if (card.actor.kind === 'system') {
    title = withoutRoleTags(title, botNames);
    body = withoutRoleTags(body, botNames);
  }
  if (card.actor.kind === 'bot' && labels) {
    title = withoutInternalIds(title, labels);
    body = withoutInternalIds(body, labels);
  }
  return { title, body };
}

export function roleLabel(role: BotRole, t: T): string {
  return t(`room.role.${role}`);
}

/** A template's name (shared/bot.ts BotTemplate). */
export function templateLabel(template: BotTemplate, t: T): string {
  return t(`room.template.${template}`);
}

/** What a bot is shown as: its template's name (a profile from before
 *  templates: the one its role maps to). */
export function botKindLabel(bot: { role: BotRole; template?: BotTemplate }, t: T): string {
  return templateLabel(botTemplate(bot), t);
}

/** A card author as main's bot store knows it (room.handler.ts RoomActor):
 *  a removed bot keeps its name, marked `removed`. */
export interface RoomActorView { role: BotRole; name?: string; removed?: boolean; avatar?: string; hue?: number }

/** Who wrote a card: the bot's name from the bot runtime, else the name
 *  main's bot store keeps (a removed bot's marked so), else its role, else
 *  "Bot". */
export function actorLabel(
  actor: Party,
  t: T,
  bots: readonly FactoryBotRow[],
  actors: Readonly<Record<string, RoomActorView>> = {},
): string {
  if (actor.kind === 'human') return t('room.actor.you');
  if (actor.kind === 'system') return t('room.actor.system');
  const row = bots.find((b) => b.bot.id === actor.botId);
  if (row) return row.bot.name;
  const known = actors[actor.botId];
  if (!known) return t('room.actor.bot');
  const name = known.name?.trim();
  if (!name) return roleLabel(known.role, t);
  return known.removed ? t('room.actor.removed', { name }) : name;
}

export function kindLabel(kind: CardKind, t: T): string {
  return t(`room.kind.${kind}`);
}

/** The state word a card shows, and its tone. Colour is on this word (or
 *  glyph) only: a failed verdict or a refusal is red, an exhausted budget
 *  is the caution yellow, a merge or a finished task is a green check, and
 *  everything else is neutral. */
export type CardTone =
  | { word: 'pass' | 'fail'; tone: 'neutral' | 'danger' }
  | { word: 'done'; tone: 'success' | 'neutral' }
  | null;

export function cardTone(card: Pick<RoomCard, 'kind' | 'title' | 'closes'>): CardTone {
  if (card.kind === 'verdict' || (card.kind === 'fact' && /^Verdict\b/.test(card.title))) {
    const m = /\b(pass|fail)(?:ed)?\b/i.exec(card.title);
    if (m) {
      const word = m[1].toLowerCase() as 'pass' | 'fail';
      return { word, tone: word === 'fail' ? 'danger' : 'neutral' };
    }
    return null;
  }
  if (card.closes) {
    const success = /^Merged #|^PR #\d+ merged|^Task done/.test(card.title);
    return { word: 'done', tone: success ? 'success' : 'neutral' };
  }
  return null;
}

/** Clock time today, else a short date, in the app's language. */
export function formatCardTime(at: number, now: number = Date.now(), locale: string = getLocale()): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** The first line of a message, as a card title (≤ 200 characters). */
export function messageTitle(text: string): string {
  const first = text.trim().split('\n')[0]?.trim() ?? '';
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

/** Workspace ids as a plan names them: main writes each item as
 *  "— workspace `<id>`, size S" (and the notes may name an id too). One
 *  pattern, so a name put in is never read again as an id. */
const PLAN_WORKSPACE_RE = /\bworkspace `([A-Za-z0-9._-]{1,80})`|`?\b(ws-[A-Za-z0-9-]{4,80})\b`?/g;

/** A plan's text with every workspace id it names replaced by that
 *  workspace's name, or "a workspace" when it is not one here: the owner
 *  never reads a raw id. Pure. */
export function planTextWithNames(text: string, workspaceName: (id: string) => string | null, t: T): string {
  return text.replace(PLAN_WORKSPACE_RE, (_m, item: string | undefined, bare: string | undefined) => {
    const id = item ?? bare ?? '';
    return workspaceName(id) ?? t('room.plan.someWorkspace');
  });
}

/** The thread most recently written of a kind (`plan:` / `report:`). */
export function latestThreadOf(threads: readonly ThreadSummary[], prefix: 'plan:' | 'report:'): ThreadSummary | null {
  let best: ThreadSummary | null = null;
  for (const th of threads) if (th.threadId.startsWith(prefix) && (!best || th.lastSeq > best.lastSeq)) best = th;
  return best;
}
