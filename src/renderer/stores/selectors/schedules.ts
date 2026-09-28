import {
  AUTOMATION_FINAL_RUN_STATES,
  type Automation,
  type AutomationRun,
} from '../../../shared/automation';

type SchedulesState = { automations: Automation[]; automationRuns: AutomationRun[] };

/** Newest first: a run's own start, else the occurrence it was scheduled for. */
export function runTime(run: AutomationRun): number {
  return run.startedAt ?? run.scheduledFor;
}

export function sortRunsNewestFirst(runs: readonly AutomationRun[]): AutomationRun[] {
  return runs.slice().sort((a, b) => runTime(b) - runTime(a));
}

export function isLiveRun(run: AutomationRun): boolean {
  return !AUTOMATION_FINAL_RUN_STATES.includes(run.state);
}

/** Latest run per automation id. */
export function latestRunByAutomation(runs: readonly AutomationRun[]): Map<string, AutomationRun> {
  const latest = new Map<string, AutomationRun>();
  for (const run of runs) {
    const prev = latest.get(run.automationId);
    if (!prev || runTime(run) > runTime(prev)) latest.set(run.automationId, run);
  }
  return latest;
}

export interface ScheduleNavSummary {
  /** Runs awaiting a human + schedules whose latest run failed. */
  needs: number;
  /** Earliest upcoming occurrence across enabled schedules (ms epoch). */
  nextRunAt: number | null;
}

/**
 * The sidebar's Schedules row. "Needs" counts every run awaiting a response
 * plus every schedule whose LATEST run failed — the contract has no ack for a
 * failure, so it clears itself on the next run's outcome or on disabling the
 * schedule rather than lingering forever. Numbers only; the row calls t().
 */
export function selectScheduleNavSummary(state: SchedulesState): ScheduleNavSummary {
  const known = new Set(state.automations.map((a) => a.id));
  let needs = 0;
  for (const run of state.automationRuns) {
    if (run.state === 'awaiting' && known.has(run.automationId)) needs += 1;
  }
  const latest = latestRunByAutomation(state.automationRuns);
  let nextRunAt: number | null = null;
  for (const a of state.automations) {
    if (a.enabled && latest.get(a.id)?.state === 'failed') needs += 1;
    if (a.enabled && a.nextRunAt !== null && (nextRunAt === null || a.nextRunAt < nextRunAt)) {
      nextRunAt = a.nextRunAt;
    }
  }
  return { needs, nextRunAt };
}

/** A non-approval mode the daemon will downgrade: the grant predates an edit. */
export function isPermissionReset(a: Automation): boolean {
  return a.permission.mode !== 'approval' && a.permission.grantedRevision !== a.revision;
}

/** Drafts first (they wait on a human), then by name. */
export function orderSchedules(automations: readonly Automation[]): Automation[] {
  return automations.slice().sort((a, b) => {
    const pa = a.proposed ? 0 : 1;
    const pb = b.proposed ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}
