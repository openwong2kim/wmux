// ─── The fan-out caller nudge: kinds, short ids and the one-line template ────
//
// Shared by the renderer (builds the line), main (checks it before asking the
// daemon to write) and the daemon (checks it again). The line is fixed text
// plus task short ids: no worker output can reach it, and anything that does
// not match the template is refused at both checks.

/** What happened to a fan-out task, as told to the pane that started it. */
export type FanoutCallerKind = 'agent.stop' | 'agent.stop_failure' | 'ledger.review_requested' | 'ledger.failed';

export const FANOUT_CALLER_KINDS: readonly FanoutCallerKind[] = [
  'agent.stop',
  'agent.stop_failure',
  'ledger.review_requested',
  'ledger.failed',
];

export function isFanoutCallerKind(v: unknown): v is FanoutCallerKind {
  return typeof v === 'string' && (FANOUT_CALLER_KINDS as readonly string[]).includes(v);
}

/** Most severe first: a task with several pending kinds is told the first. */
const SEVERITY: readonly FanoutCallerKind[] = ['ledger.failed', 'agent.stop_failure', 'ledger.review_requested', 'agent.stop'];

export function moreSevereKind(a: FanoutCallerKind, b: FanoutCallerKind): FanoutCallerKind {
  return SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b;
}

const PHRASE: Record<FanoutCallerKind, string> = {
  'ledger.failed': 'failed',
  'agent.stop_failure': 'stopped on an error',
  'ledger.review_requested': 'ready for review',
  'agent.stop': 'updated',
};

const LISTED_IDS = 4;

/**
 * The task's short id: the LAST 8 characters, the random segment — the same
 * rule as the mission channel name (WorkTaskService.missionChannelName). The
 * leading characters after `wtask-` are a timestamp shared by tasks started
 * together.
 */
export function fanoutTaskShortId(taskId: string): string {
  return taskId.replace(/^wtask-/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(-8);
}

/**
 * One line for every task in `items`, grouped by what happened, most severe
 * first. Examples:
 *   [wmux] fan-out task 6k7g7szw updated — channel_mission_list
 *   [wmux] fan-out task 6k7g7szw failed; tasks a1b2c3d4, e5f6g7h8 updated — channel_mission_list
 */
export function buildFanoutCallerNudge(items: readonly { taskId: string; kind: FanoutCallerKind }[]): string {
  const clauses: string[] = [];
  for (const kind of SEVERITY) {
    const ids = items
      .filter((i) => i.kind === kind)
      .map((i) => fanoutTaskShortId(i.taskId))
      .filter((id) => id.length > 0);
    if (ids.length === 0) continue;
    const listed = ids.slice(0, LISTED_IDS).join(', ');
    const more = ids.length > LISTED_IDS ? ` +${ids.length - LISTED_IDS}` : '';
    clauses.push(`task${ids.length === 1 ? '' : 's'} ${listed}${more} ${PHRASE[kind]}`);
  }
  if (clauses.length === 0) clauses.push(`task ? ${PHRASE['agent.stop']}`);
  return `[wmux] fan-out ${clauses.join('; ')} — channel_mission_list`;
}

const ID = '[A-Za-z0-9_-]{1,8}';
const CLAUSE = `tasks? (?:${ID}|\\?)(?:, ${ID}){0,${LISTED_IDS - 1}}(?: \\+\\d{1,4})? (?:${Object.values(PHRASE).join('|')})`;
/** The line after `[wmux] `, as a regex source (shared/prOwnerNudge combines it). */
export const FANOUT_CALLER_BODY_SOURCE = `fan-out ${CLAUSE}(?:; ${CLAUSE}){0,${SEVERITY.length - 1}} — channel_mission_list`;
const LINE = new RegExp(`^\\[wmux\\] ${FANOUT_CALLER_BODY_SOURCE}$`);

/** True only for a line `buildFanoutCallerNudge` can produce. */
export function isFanoutCallerNudge(text: unknown): text is string {
  return typeof text === 'string' && text.length <= 400 && LINE.test(text);
}
