// ─── Moa track record — rolled-up counts and the weekly retro (P3c) ─────────
//
// Built only from wmux's own data: work links, A2A task states, Deck decisions,
// the fan-out ledger and the approval registry. The file holds ids, counts,
// durations and keyed word hashes — never a title, a question, a summary or any
// other free text, so nothing in it can carry instructions back to Moa.
// A decision question is kept only as HMACs of its words under a per-install
// key (trackRecordStore.ts), so the prints compare across restarts but cannot
// be reversed with a dictionary without that key.
//
// Everything here is pure: main (src/main/deck/trackRecordFeed.ts) feeds it
// events and a clock, and owns the file (trackRecordStore.ts).

/** Weeks kept, the current one included. Older weeks are dropped. */
export const TRACK_RETENTION_WEEKS = 12;
/** Time in needs-you after which the wait counts as a stall. Blocked counts at once. */
export const STALL_AFTER_MS = 60 * 60 * 1000;
/** Time in needs-you or blocked with no state change that the retro calls missed. */
export const MISSED_STALL_AFTER_MS = 8 * 60 * 60 * 1000;
/** Two decision questions whose word sets overlap this much count as the same question. */
export const SIMILAR_QUESTION_JACCARD = 0.6;

const MAX_ROWS_PER_WEEK = 200;
const MAX_SLOWEST = 5;
const MAX_MISSED = 10;
const MAX_QUESTIONS = 100;
const MAX_PRINT_TOKENS = 24;
export const MAX_OPEN_ITEMS = 500;
export const MAX_SEEN_IDS = 1000;

export interface TrackCounters {
  /** Work handed to this workspace and agent (A2A tasks and fan-out workers). */
  delegations: number;
  /** Of those, how many reached done. */
  done: number;
  /** Sum of time-to-done over `done`, in ms. */
  doneMs: number;
  /** Replies the requester sent on a task still open (nudges and re-pokes). */
  nudges: number;
  /** Decisions raised about this workspace's linked work. */
  decisions: number;
  /** Approvals the HQ approval lane pressed. */
  approvalsLane: number;
  /** Approvals a person answered. */
  approvalsHuman: number;
  /** Waits in needs-you past STALL_AFTER_MS, and every blocked spell. */
  stalls: number;
}

export type TrackCounterKey = keyof TrackCounters;

export interface TrackRow extends TrackCounters {
  workspaceId: string;
  /** Agent slug (`claude`, `codex`, …) or `-` when unknown. */
  agent: string;
}

/** One finished delegation, by ids only. */
export interface TrackItemRef {
  workspaceId: string;
  agent: string;
  /** Short id of the work (link or fan-out task), never its title. */
  ref: string;
  ms: number;
}

export interface TrackMissedStall extends TrackItemRef {
  state: 'needs-you' | 'blocked';
}

export interface TrackQuestion {
  workspaceId: string;
  at: number;
  /** Keyed hashes of the question's de-duplicated words (questionWords → main's HMAC). */
  print: string[];
}

export interface TrackWeek {
  /** Local Monday 00:00 of the week, epoch ms. */
  weekStart: number;
  rows: TrackRow[];
  /** Every time a person was asked: decisions raised and approvals answered. */
  interruptions: { decisions: number; approvals: number };
  slowest: TrackItemRef[];
  missedStalls: TrackMissedStall[];
  questions: TrackQuestion[];
}

export type OpenState = 'active' | 'needs-you' | 'blocked';

/** A delegation still under way. */
export interface TrackOpenItem {
  workspaceId: string;
  agent: string;
  createdAt: number;
  state: OpenState;
  /** When `state` began. */
  since: number;
  stallCounted?: boolean;
  missedCounted?: boolean;
}

export interface RetroSchedule {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday, local time. */
  day: number;
  /** 0–23, local time. */
  hour: number;
}

export const DEFAULT_RETRO_SCHEDULE: RetroSchedule = { enabled: true, day: 1, hour: 9 };

export interface RetroRepeated {
  workspaceId: string;
  /** How many times a similar question was asked that week. */
  count: number;
  lastAt: number;
}

export type RetroSuggestion = 'precedent' | 'stalls' | 'approvals';

export interface RetroCard {
  /** The week reviewed (local Monday 00:00). */
  weekStart: number;
  builtAt: number;
  interruptions: { decisions: number; approvals: number; total: number; prevTotal: number };
  approvalsLane: number;
  delegations: number;
  done: number;
  missedStalls: TrackMissedStall[];
  repeated: RetroRepeated[];
  slowest: TrackItemRef[];
  /** Machine-readable next steps; the renderer words them. `precedent` is the
   *  hook for the decision-precedents feature. */
  suggestions: RetroSuggestion[];
}

export interface TrackRecordData {
  version: 1;
  weeks: TrackWeek[];
  open: Record<string, TrackOpenItem>;
  /** Ids already counted, so a restart or a repeated signal counts nothing twice. */
  seen: { links: string[]; decisions: string[]; linkedDecisions: string[]; approvals: string[]; ledger: string[] };
  /** When the feed last ran (tick or stop). Waits do not accrue past it while
   *  the feed is off, whether Moa was switched off or the app was closed. */
  activeAt?: number;
  retro: {
    schedule: RetroSchedule;
    /** The week (local Monday) whose scheduled run already happened, card or not. */
    lastRunWeek?: number;
    card?: RetroCard;
    dismissed?: boolean;
  };
}

export function emptyTrackRecord(schedule: RetroSchedule = DEFAULT_RETRO_SCHEDULE): TrackRecordData {
  return {
    version: 1,
    weeks: [],
    open: {},
    seen: { links: [], decisions: [], linkedDecisions: [], approvals: [], ledger: [] },
    retro: { schedule: { ...schedule } },
  };
}

const ZERO: TrackCounters = {
  delegations: 0, done: 0, doneMs: 0, nudges: 0, decisions: 0, approvalsLane: 0, approvalsHuman: 0, stalls: 0,
};
export const TRACK_COUNTER_KEYS = Object.keys(ZERO) as TrackCounterKey[];

// ── Weeks ───────────────────────────────────────────────────────────────────

/** Local Monday 00:00 of the week holding `ms`. DST-safe (calendar arithmetic). */
export function weekStartOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** The local Monday `n` weeks after (negative: before) `weekStart`. */
export function addWeeks(weekStart: number, n: number): number {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + n * 7);
  return d.getTime();
}

function weekFor(data: TrackRecordData, at: number): TrackWeek {
  const ws = weekStartOf(at);
  let week = data.weeks.find((w) => w.weekStart === ws);
  if (!week) {
    week = { weekStart: ws, rows: [], interruptions: { decisions: 0, approvals: 0 }, slowest: [], missedStalls: [], questions: [] };
    data.weeks.push(week);
    data.weeks.sort((a, b) => a.weekStart - b.weekStart);
  }
  return week;
}

/** Add to one workspace-and-agent row of the week holding `at`. */
export function bumpRow(
  data: TrackRecordData,
  at: number,
  workspaceId: string,
  agent: string,
  patch: Partial<TrackCounters>,
): void {
  const week = weekFor(data, at);
  let row = week.rows.find((r) => r.workspaceId === workspaceId && r.agent === agent);
  if (!row) {
    if (week.rows.length >= MAX_ROWS_PER_WEEK) return;
    row = { workspaceId, agent, ...ZERO };
    week.rows.push(row);
  }
  for (const k of TRACK_COUNTER_KEYS) row[k] += patch[k] ?? 0;
}

/** Drop weeks past retention, and open items older than the oldest week kept. */
export function pruneTrackRecord(data: TrackRecordData, now: number): void {
  const floor = addWeeks(weekStartOf(now), -(TRACK_RETENTION_WEEKS - 1));
  data.weeks = data.weeks.filter((w) => w.weekStart >= floor);
  for (const [key, item] of Object.entries(data.open)) if (item.createdAt < floor) delete data.open[key];
}

/** Remember an id; false when it was already there. Bounded, oldest out. */
export function markSeen(list: string[], id: string): boolean {
  if (list.includes(id)) return false;
  list.push(id);
  if (list.length > MAX_SEEN_IDS) list.splice(0, list.length - MAX_SEEN_IDS);
  return true;
}

/** A short, stable reference for a piece of work: never its title. */
export function shortRef(id: string): string {
  return id.replace(/^(wtask-|task-)/, '').slice(0, 8);
}

// ── Open delegations ────────────────────────────────────────────────────────

/** Start tracking a delegation and count it. */
export function openItem(
  data: TrackRecordData,
  key: string,
  item: { workspaceId: string; agent: string; createdAt: number; state?: OpenState },
  now: number,
): void {
  if (data.open[key]) return;
  const keys = Object.keys(data.open);
  if (keys.length >= MAX_OPEN_ITEMS) {
    const oldest = keys.reduce((a, b) => (data.open[a].createdAt <= data.open[b].createdAt ? a : b));
    delete data.open[oldest];
  }
  data.open[key] = { workspaceId: item.workspaceId, agent: item.agent, createdAt: item.createdAt, state: item.state ?? 'active', since: now };
  bumpRow(data, now, item.workspaceId, item.agent, { delegations: 1 });
}

/** Count a waiting spell's stall and missed stall once each, as they cross. */
function judgeWait(data: TrackRecordData, key: string, item: TrackOpenItem, now: number): void {
  if (item.state === 'active') return;
  const waited = now - item.since;
  if (!item.stallCounted && (item.state === 'blocked' || waited >= STALL_AFTER_MS)) {
    item.stallCounted = true;
    bumpRow(data, now, item.workspaceId, item.agent, { stalls: 1 });
  }
  if (!item.missedCounted && waited >= MISSED_STALL_AFTER_MS) {
    item.missedCounted = true;
    const week = weekFor(data, now);
    week.missedStalls.push({ workspaceId: item.workspaceId, agent: item.agent, ref: shortRef(key.replace(/^\w+:/, '')), ms: waited, state: item.state });
    week.missedStalls.sort((a, b) => b.ms - a.ms);
    week.missedStalls.splice(MAX_MISSED);
  }
}

/**
 * A tracked delegation moved. `done` counts it finished (time-to-done and the
 * slowest list); `gone` (cancelled, abandoned) just stops tracking it. A state
 * that did not change is not a reaction, so the wait clock keeps running.
 */
export function moveItem(
  data: TrackRecordData,
  key: string,
  next: OpenState | 'done' | 'gone',
  now: number,
  opts: { judge?: boolean } = {},
): void {
  const item = data.open[key];
  if (!item) return;
  if (next === item.state) return;
  // A move found on catch-up happened at an unknown time while the feed was
  // off: the wait it ended is not judged.
  if (opts.judge !== false) judgeWait(data, key, item, now);
  if (next === 'done' || next === 'gone') {
    delete data.open[key];
    if (next === 'gone') return;
    const ms = Math.max(0, now - item.createdAt);
    bumpRow(data, now, item.workspaceId, item.agent, { done: 1, doneMs: ms });
    const week = weekFor(data, now);
    week.slowest.push({ workspaceId: item.workspaceId, agent: item.agent, ref: shortRef(key.replace(/^\w+:/, '')), ms });
    week.slowest.sort((a, b) => b.ms - a.ms);
    week.slowest.splice(MAX_SLOWEST);
    return;
  }
  item.state = next;
  item.since = now;
  item.stallCounted = false;
  item.missedCounted = false;
}

/**
 * The feed is running again: time it was off (Moa switched off, or the app
 * closed) does not count as waiting, so every wait clock moves forward by it.
 */
export function resumeOpenItems(data: TrackRecordData, now: number): void {
  const gap = data.activeAt !== undefined ? Math.max(0, now - data.activeAt) : 0;
  if (gap > 0) {
    for (const item of Object.values(data.open)) {
      if (item.state !== 'active') item.since = Math.min(now, item.since + gap);
    }
  }
  data.activeAt = now;
}

/** Count the waits that crossed a threshold while nothing changed. */
export function sweepOpenItems(data: TrackRecordData, now: number): void {
  for (const [key, item] of Object.entries(data.open)) judgeWait(data, key, item, now);
}

// ── Decisions and approvals ─────────────────────────────────────────────────

/** A person was asked a decision question. Only its keyed word hashes are kept. */
export function noteDecisionAsked(data: TrackRecordData, workspaceId: string, print: string[], at: number): void {
  const week = weekFor(data, at);
  week.interruptions.decisions += 1;
  if (print.length === 0) return;
  week.questions.push({ workspaceId, at, print });
  if (week.questions.length > MAX_QUESTIONS) week.questions.splice(0, week.questions.length - MAX_QUESTIONS);
}

/** A person answered an approval. */
export function noteHumanApproval(data: TrackRecordData, workspaceId: string, agent: string, at: number): void {
  weekFor(data, at).interruptions.approvals += 1;
  bumpRow(data, at, workspaceId, agent, { approvalsHuman: 1 });
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'should', 'this', 'that', 'what', 'which', 'when', 'does', 'from', 'into',
  'are', 'can', 'you', 'now', 'not', 'any', 'our', 'its', 'have', 'has', 'was', 'will', 'would', 'how', 'why',
]);

/** The question's distinct content words, for main to hash. Never stored as is. */
export function questionWords(question: string): string[] {
  const words = question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/** A print from word hashes: sorted, de-duplicated, capped. */
export function toPrint(hashes: readonly string[]): string[] {
  return [...new Set(hashes)].sort().slice(0, MAX_PRINT_TOKENS);
}

export function printSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  const shared = a.filter((t) => sb.has(t)).length;
  return shared / (a.length + b.length - shared);
}

/** Groups of similar questions asked two or more times in the same workspace,
 *  largest first. A question asked once in each of two workspaces is not a repeat. */
export function repeatedQuestions(questions: readonly TrackQuestion[]): RetroRepeated[] {
  const groups: { head: TrackQuestion; members: TrackQuestion[] }[] = [];
  for (const q of questions) {
    const g = groups.find((x) =>
      x.head.workspaceId === q.workspaceId && printSimilarity(x.head.print, q.print) >= SIMILAR_QUESTION_JACCARD);
    if (g) g.members.push(q);
    else groups.push({ head: q, members: [q] });
  }
  return groups
    .filter((g) => g.members.length >= 2)
    .map((g) => ({ workspaceId: g.head.workspaceId, count: g.members.length, lastAt: Math.max(...g.members.map((m) => m.at)) }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, 5);
}

// ── Weekly retro ────────────────────────────────────────────────────────────

/** When this week's retro runs: the schedule's local day and hour. */
export function retroRunAt(schedule: RetroSchedule, weekStart: number): number {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + ((schedule.day + 6) % 7));
  d.setHours(schedule.hour, 0, 0, 0);
  return d.getTime();
}

/**
 * The week of the most recent scheduled slot at or before `now`, when that
 * slot has not run yet; otherwise null. Looking back to last week's slot is
 * what lets a Sunday-evening retro still run when the app opens on Monday.
 */
export function retroDueWeek(schedule: RetroSchedule, lastRunWeek: number | undefined, now: number): number | null {
  if (!schedule.enabled) return null;
  const thisWeek = weekStartOf(now);
  const slotWeek = now >= retroRunAt(schedule, thisWeek) ? thisWeek : addWeeks(thisWeek, -1);
  if (lastRunWeek !== undefined && lastRunWeek >= slotWeek) return null;
  return slotWeek;
}

function sumRows(week: TrackWeek | undefined): TrackCounters {
  const out = { ...ZERO };
  for (const r of week?.rows ?? []) for (const k of TRACK_COUNTER_KEYS) out[k] += r[k];
  return out;
}

function hasActivity(week: TrackWeek | undefined): boolean {
  if (!week) return false;
  const t = sumRows(week);
  return TRACK_COUNTER_KEYS.some((k) => t[k] > 0) || week.interruptions.decisions + week.interruptions.approvals > 0;
}

/** The retro for the week starting `weekStart`, or null when nothing happened that week. */
export function buildRetro(data: TrackRecordData, weekStart: number, now: number): RetroCard | null {
  const week = data.weeks.find((w) => w.weekStart === weekStart);
  if (!hasActivity(week) || !week) return null;
  const prev = data.weeks.find((w) => w.weekStart === addWeeks(weekStart, -1));
  const totals = sumRows(week);
  const total = week.interruptions.decisions + week.interruptions.approvals;
  const repeated = repeatedQuestions(week.questions);
  const suggestions: RetroSuggestion[] = [];
  if (repeated.length > 0) suggestions.push('precedent');
  if (week.missedStalls.length > 0) suggestions.push('stalls');
  if (week.interruptions.approvals >= 5 && totals.approvalsLane === 0) suggestions.push('approvals');
  return {
    weekStart,
    builtAt: now,
    interruptions: {
      decisions: week.interruptions.decisions,
      approvals: week.interruptions.approvals,
      total,
      prevTotal: prev ? prev.interruptions.decisions + prev.interruptions.approvals : 0,
    },
    approvalsLane: totals.approvalsLane,
    delegations: totals.delegations,
    done: totals.done,
    missedStalls: week.missedStalls.slice(0, 5),
    repeated,
    slowest: week.slowest.slice(0, 3),
    suggestions,
  };
}

/** Rows over the last `weeks` weeks, merged per workspace and agent. */
export function rollupRows(data: TrackRecordData, now: number, weeks: number): TrackRow[] {
  const floor = addWeeks(weekStartOf(now), -(weeks - 1));
  const merged = new Map<string, TrackRow>();
  for (const w of data.weeks) {
    if (w.weekStart < floor) continue;
    for (const r of w.rows) {
      const key = `${r.workspaceId}\u0000${r.agent}`;
      const into = merged.get(key) ?? { workspaceId: r.workspaceId, agent: r.agent, ...ZERO };
      for (const k of TRACK_COUNTER_KEYS) into[k] += r[k];
      merged.set(key, into);
    }
  }
  return [...merged.values()].sort((a, b) => b.delegations - a.delegations || a.workspaceId.localeCompare(b.workspaceId));
}

/** `3h 05m`, `42m`, `<1m`. */
export function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** An agent's display name as a slug (`Claude Code` → `claude`), or `-`. */
export function agentSlug(name: string | null | undefined): string {
  const first = (name ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  const slug = first.replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return slug || '-';
}
