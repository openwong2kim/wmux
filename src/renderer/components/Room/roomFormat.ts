// Pure display helpers for rooms and bot chats: labels, times and the one
// state word a card may colour.
import { BOT_ROLES, botTemplate, type BotRole, type BotTemplate } from '../../../shared/bot';
import type { Party } from '../../../shared/handoff';
import type { CardKind, RoomCard, ThreadId, ThreadSummary } from '../../../shared/room';
import type { FactoryBotRow } from './factoryPorts';

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

/** A card's title and body as the owner reads them: a routine's schedule
 *  (not the bot's own instructions), a refusal's plain sentences (not their
 *  codes), no role tag after a bot's name in what main wrote, and in a bot's
 *  own words the ids it cites shown as what they stand for (`labels`). Pure. */
export function ownerCardText(card: Pick<RoomCard, 'kind' | 'title' | 'body' | 'actor'>, botNames: readonly string[], labels?: IdLabels): { title: string; body: string } {
  let title = card.title;
  let body = (card.body ?? '').trim();
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

/** Who wrote a card: the bot's name from the bot runtime, else its role
 *  from main's bot store, else "Bot". */
export function actorLabel(
  actor: Party,
  t: T,
  bots: readonly FactoryBotRow[],
  actors: Readonly<Record<string, { role: BotRole }>> = {},
): string {
  if (actor.kind === 'human') return t('room.actor.you');
  if (actor.kind === 'system') return t('room.actor.system');
  const row = bots.find((b) => b.bot.id === actor.botId);
  if (row) return row.bot.name;
  const known = actors[actor.botId];
  return known ? roleLabel(known.role, t) : t('room.actor.bot');
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

/** Clock time today, else a short date. */
export function formatCardTime(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
