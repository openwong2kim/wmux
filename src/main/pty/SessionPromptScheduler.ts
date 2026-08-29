// Main-process runner for prompts queued against a concrete PTY session.

import {
  claimDueSessionPromptSchedule,
  dueSessionPromptSchedules,
  finalizeSessionPromptScheduleClaim,
  loadSessionPromptSchedules,
  mutateSessionPromptSchedules,
  recoverInterruptedSessionPromptDeliveries,
  SESSION_PROMPT_CLAIM_STALE_MS,
  type SessionPromptSchedule,
  type SessionPromptScheduleResult,
} from './sessionPromptScheduleStore';

export const SESSION_PROMPT_SCHEDULER_TICK_MS = 15_000;
export interface SessionPromptSchedulerDeps {
  deliver: (schedule: SessionPromptSchedule) => Promise<SessionPromptScheduleResult>;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  dir?: string;
}

export class SessionPromptScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly deps: SessionPromptSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    const setI = this.deps.setIntervalFn ?? setInterval;
    const runTick = (): void => {
      void this.tick().catch((error) => {
        console.warn('[session-schedule] scheduler tick failed:', error);
      });
    };
    this.timer = setI(runTick, SESSION_PROMPT_SCHEDULER_TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
    runTick();
  }

  stop(): void {
    if (!this.timer) return;
    (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      // A stale persisted claim means the previous process may have written
      // some or all of the prompt. Recover it before selecting this tick's due
      // set: an unattended duplicate is worse than a visible at-most-once failure.
      const snapshot = loadSessionPromptSchedules(this.deps.dir);
      const due = snapshot.some((schedule) => schedule.deliveryClaim &&
        now - schedule.deliveryClaim.startedAt >= SESSION_PROMPT_CLAIM_STALE_MS)
        ? await mutateSessionPromptSchedules((schedules) => {
          const recovered = recoverInterruptedSessionPromptDeliveries(schedules, now);
          return { schedules: recovered, result: dueSessionPromptSchedules(recovered, now) };
        }, this.deps.dir)
        : dueSessionPromptSchedules(snapshot, now);
      for (const candidate of due) {
        // Re-read through the serialized mutation queue immediately before
        // delivery. A pause/delete that happened after the due snapshot wins.
        const schedule = await claimDueSessionPromptSchedule(candidate.id, now, this.deps.dir);
        if (!schedule?.deliveryClaim) continue;
        let result: SessionPromptScheduleResult;
        try {
          result = await this.deps.deliver(schedule);
        } catch {
          result = 'error';
        }

        await finalizeSessionPromptScheduleClaim(
          schedule.id,
          schedule.deliveryClaim.token,
          result,
          (this.deps.now ?? Date.now)(),
          this.deps.dir,
        );
      }
    } finally {
      this.ticking = false;
    }
  }
}
