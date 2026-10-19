// ─── Facts — durable, deduplicated system events (agent factory) ───────────
//
// A fact is one thing that happened, written once to the factory fact log
// (`getWmuxDir()/factory/facts.jsonl`, main-owned) and read by the trigger
// engine and by bots through `fact.poll`. Bots wake only on facts, human
// messages, typed handoffs or the one scheduled morning wake — a fact is the
// unit every trigger matches on.
//
// Dedupe: every fact carries a key; the log drops a repeat key inside the
// retain window. `factDedupeKey` is the one place keys are built, so two
// sources that observe the same event (a gh poll and an EventBus tee) cannot
// disagree on it. A kind whose key parts are missing yields null and the fact
// must not be written (a fact that cannot be deduplicated is refused, never
// written with an ad-hoc key).

import type { CardNotice } from './room';

export type FactKind =
  | 'pr.opened' | 'pr.head_moved' | 'pr.closed' | 'pr.merged' | 'pr.labelled' | 'pr.review_requested_changes'
  | 'ci.failed' | 'ci.green'                     // per PR head, edge-triggered
  | 'issue.opened' | 'issue.labelled' | 'issue.closed'
  | 'verdict.recorded'                           // from prVerdictStore
  | 'merge.done' | 'merge.refused'               // from executor / lane
  | 'task.done' | 'task.failed' | 'task.input_required'   // ledger transitions (fan-out workers)
  | 'pane.idle' | 'pane.needs_input'             // agent.lifecycle mapped; only for bot-owned task panes
  | 'handoff.received' | 'handoff.refused'
  | 'human.message' | 'human.correction'         // correction = owner reverted/overrode a bot output
  | 'bot.refused' | 'bot.budget_exhausted' | 'bot.error'
  | 'bot.workers_full'                           // a fan-out waits for a worker slot (not a budget limit)
  | 'bot.notice'                                 // main tells one bot what became of its work (BotNoticePayload)
  | 'schedule.fired';                            // the one timer-origin fact (morning wake)

export const FACT_KINDS: readonly FactKind[] = [
  'pr.opened', 'pr.head_moved', 'pr.closed', 'pr.merged', 'pr.labelled', 'pr.review_requested_changes',
  'ci.failed', 'ci.green',
  'issue.opened', 'issue.labelled', 'issue.closed',
  'verdict.recorded',
  'merge.done', 'merge.refused',
  'task.done', 'task.failed', 'task.input_required',
  'pane.idle', 'pane.needs_input',
  'handoff.received', 'handoff.refused',
  'human.message', 'human.correction',
  'bot.refused', 'bot.budget_exhausted', 'bot.error',
  'bot.workers_full',
  'bot.notice',
  'schedule.fired',
];

export function isFactKind(value: unknown): value is FactKind {
  return typeof value === 'string' && (FACT_KINDS as readonly string[]).includes(value);
}

/** What a fact points at. Every field is optional; which ones a kind needs is
 *  decided by `factDedupeKey`. */
export interface FactRef {
  pr?: number;
  issue?: number;
  headSha?: string;
  taskId?: string;
  botId?: string;
  handoffId?: string;
  check?: string;
  /** pane.idle / pane.needs_input: the task pane's pty. */
  ptyId?: string;
  /** pr.labelled / issue.labelled: the label that was added. */
  label?: string;
  /** schedule.fired: the DeckScheduler entry. */
  scheduleId?: string;
  /** bot.refused: the RPC method the role surface refused. */
  method?: string;
  /** human.message / human.correction: the client message or override id. */
  messageId?: string;
}

/** `bot.notice` payload: main tells one bot (ref.botId, a directed fact)
 *  what became of something it started or asked for — a worker that started
 *  or could not start, an approval the owner decided, a pull request that
 *  merged. ref.messageId is the notice key (one notice per key). Written by
 *  main only, in main's words; `detail` may quote a tool's error output and
 *  is shown to the bot as data. */
export interface BotNoticePayload {
  topic: 'worker.started' | 'worker.start_failed' | 'worker.report_after_end' | 'approval.decided' | 'pr.merged';
  /** One line, main's words. */
  title: string;
  /** More of main's words (optional). */
  body?: string;
  /** Text main did not write (an error's output), fenced as data. */
  detail?: string;
  /** The thread the notice is about (also the wake's thread). */
  threadId?: string;
  /** Main posts a room card for it in that thread (else the notice is the
   *  bot's only: another card already shows the owner the same thing). */
  card?: boolean;
  /** It carries text from outside (detail): wakeTaint counts it. */
  tainted?: boolean;
  /** The card's stable code, so the reader's language words it (RoomCard.notice). */
  notice?: CardNotice;
}

export type FactActor = { kind: 'system' | 'bot' | 'human' | 'github'; id?: string };

export interface Fact<K extends FactKind = FactKind> {
  id: string;            // ulid
  seq: number;           // monotonic per fact log
  kind: K;
  at: number;
  dedupeKey: string;     // factDedupeKey(); the log drops a repeat key within the retain window
  workspaceId?: string;  // owning workspace when known
  repoKey?: string;      // 'owner/repo'
  ref?: FactRef;
  actor?: FactActor;
  payload: Record<string, unknown>;   // kind-specific, small (≤ FACT_LIMITS.PAYLOAD_MAX_BYTES)
}

/** A fact before the log assigns id, seq and key. */
export type FactDraft<K extends FactKind = FactKind> = Omit<Fact<K>, 'id' | 'seq' | 'dedupeKey'>;

export interface FactFilter { labelsAny?: string[]; authorTrusted?: boolean; repoKey?: string; botIdNot?: string; }

export const FACT_RETAIN_DAYS = 30;

export const FACT_LIMITS = {
  PAYLOAD_MAX_BYTES: 4096,
  /** facts.jsonl rotates to facts.<n>.jsonl past this size. */
  ROTATE_BYTES: 5 * 1024 * 1024,
  /** Most facts one fact.poll returns. */
  POLL_PAGE: 200,
  /** Longest a fact.poll may block waiting for a new fact. */
  POLL_MAX_BLOCK_MS: 60_000,
} as const;

/** `fact.emit` is main/first-party only: it is on no bot surface. */
export const FACT_RPC = { poll: 'fact.poll', emit: 'fact.emit' } as const;

/** `fact.poll` params. A bot reads facts of its own workspace only (the
 *  handler scopes on the caller's binding, never on a param). */
export interface FactPollParams {
  /** Return facts with seq > sinceSeq. Omitted: start from the newest. */
  sinceSeq?: number;
  kinds?: FactKind[];
  limit?: number;
  /** Block up to this long for a first new fact (≤ FACT_LIMITS.POLL_MAX_BLOCK_MS). */
  blockMs?: number;
}

export interface FactPollResult {
  ok: true;
  facts: Fact[];
  /** Pass back as sinceSeq. */
  nextSeq: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function prKey(repoKey: string | undefined, n: number | undefined): string | null {
  return repoKey && typeof n === 'number' && Number.isInteger(n) && n > 0 ? `${repoKey}#${n}` : null;
}

function join(kind: FactKind, ...parts: Array<string | number | null | undefined>): string | null {
  for (const p of parts) {
    if (p === null || p === undefined || p === '') return null;
  }
  return [kind, ...parts].join(':');
}

/** A payload value as an optional key part: one refusal reason cannot
 *  swallow another's fact (absent: no part). */
function payloadPart(v: unknown): string[] {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? [v] : [];
}

/**
 * The dedupe key of a fact, or null when the parts its kind needs are missing
 * (the fact must then be refused). Pure.
 *
 *   pr.opened                  pr.opened:<repo>#<n>
 *   pr.head_moved              pr.head_moved:<repo>#<n>:<sha>
 *   pr.closed / pr.merged      <kind>:<repo>#<n>
 *   pr.labelled                pr.labelled:<repo>#<n>:<label>
 *   pr.review_requested_changes  <kind>:<repo>#<n>:<sha>
 *   ci.failed / ci.green       <kind>:<repo>#<n>:<sha>
 *   issue.opened / issue.closed  <kind>:<repo>#<n>
 *   issue.labelled             issue.labelled:<repo>#<n>:<label>
 *   verdict.recorded           verdict.recorded:<repo>#<n>:<sha>:<botId|workspaceId>
 *   merge.done                 merge.done:<repo>#<n>
 *   merge.refused              merge.refused:<repo>#<n>:<sha>
 *   task.done / task.failed    <kind>:<taskId>
 *   task.input_required        task.input_required:<taskId>:<epochMinute>
 *   pane.idle / pane.needs_input  <kind>:<ptyId>:<epochMinute>
 *   handoff.received / .refused   <kind>:<handoffId>
 *   human.message / .correction   <kind>:<messageId>
 *   bot.refused                bot.refused:<botId>:<method>:<epochMinute>
 *   bot.budget_exhausted       bot.budget_exhausted:<botId>:park:<parkedAt> (a park: one per park,
 *                              so a new park in the same hour is reported again),
 *                              else bot.budget_exhausted:<botId>:<reason>:<epochHour>
 *   bot.workers_full           bot.workers_full:<botId>:<scope>:<epochHour>
 *                              (<reason> / <scope> left out when the payload has none)
 *   bot.error                  bot.error:<botId>:<epochMinute>
 *   bot.notice                 bot.notice:<botId>:<messageId>
 *   schedule.fired             schedule.fired:<scheduleId>:<epochDay>
 */
export function factDedupeKey(draft: Pick<FactDraft, 'kind' | 'at' | 'repoKey' | 'ref' | 'workspaceId'> & { payload?: Record<string, unknown> }): string | null {
  const { kind, at, repoKey } = draft;
  const ref = draft.ref ?? {};
  if (!Number.isFinite(at)) return null;
  const minute = Math.floor(at / MINUTE_MS);
  const pr = prKey(repoKey, ref.pr);
  const issue = prKey(repoKey, ref.issue);
  switch (kind) {
    case 'pr.opened':
    case 'pr.closed':
    case 'pr.merged':
    case 'merge.done':
      return join(kind, pr);
    case 'pr.head_moved':
    case 'pr.review_requested_changes':
    case 'ci.failed':
    case 'ci.green':
    case 'merge.refused':
      return join(kind, pr, ref.headSha);
    case 'pr.labelled':
      return join(kind, pr, ref.label);
    case 'issue.opened':
    case 'issue.closed':
      return join(kind, issue);
    case 'issue.labelled':
      return join(kind, issue, ref.label);
    case 'verdict.recorded':
      return join(kind, pr, ref.headSha, ref.botId || draft.workspaceId);
    case 'task.done':
    case 'task.failed':
      return join(kind, ref.taskId);
    case 'task.input_required':
      return join(kind, ref.taskId, minute);
    case 'pane.idle':
    case 'pane.needs_input':
      return join(kind, ref.ptyId, minute);
    case 'handoff.received':
    case 'handoff.refused':
      return join(kind, ref.handoffId);
    case 'human.message':
    case 'human.correction':
      return join(kind, ref.messageId);
    case 'bot.refused':
      return join(kind, ref.botId, ref.method, minute);
    case 'bot.budget_exhausted': {
      const parkedAt = draft.payload?.parkedAt;
      return typeof parkedAt === 'number' && Number.isSafeInteger(parkedAt)
        ? join(kind, ref.botId, 'park', parkedAt)
        : join(kind, ref.botId, ...payloadPart(draft.payload?.reason), Math.floor(at / HOUR_MS));
    }
    case 'bot.workers_full':
      return join(kind, ref.botId, ...payloadPart(draft.payload?.scope), Math.floor(at / HOUR_MS));
    case 'bot.error':
      return join(kind, ref.botId, minute);
    case 'bot.notice':
      return join(kind, ref.botId, ref.messageId);
    case 'schedule.fired':
      return join(kind, ref.scheduleId, Math.floor(at / DAY_MS));
    default: {
      const unknownKind: never = kind;
      void unknownKind;
      return null;
    }
  }
}
