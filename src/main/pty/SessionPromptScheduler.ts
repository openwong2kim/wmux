// Main-process runner for prompts queued against a concrete PTY session.

import type { AgentStatus } from '../../shared/types';
import type { AgentSlug } from '../../shared/agentIdentity';
import {
  formatBracketedPastePayload,
  isMultilinePtyPayload,
} from '../../shared/ptyMessageDelivery';
import {
  advanceSessionPromptSchedule,
  dueSessionPromptSchedules,
  loadSessionPromptSchedules,
  mutateSessionPromptSchedules,
  type SessionPromptSchedule,
  type SessionPromptScheduleResult,
} from './sessionPromptScheduleStore';

export const SESSION_PROMPT_SCHEDULER_TICK_MS = 15_000;
export const SESSION_PROMPT_SUBMIT_DELAY_MS = 100;

export interface ScheduledAgentState {
  slug: AgentSlug;
  status: AgentStatus;
}

export interface SessionPromptDeliveryDeps {
  getAgentState: (ptyId: string) => Promise<ScheduledAgentState | null>;
  /** Returns false when the target PTY/pipe is not currently writable. */
  write: (ptyId: string, data: string) => boolean;
  delay?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Safely paste and submit a scheduled prompt.
 *
 * The stored agent family is re-verified immediately before delivery so a
 * prompt queued for Codex cannot become a shell command after Codex exits.
 * Running turns and approval prompts are left alone; the schedule stays due
 * and retries when the target returns to a normal input prompt.
 */
export async function deliverSessionPrompt(
  schedule: SessionPromptSchedule,
  deps: SessionPromptDeliveryDeps,
): Promise<SessionPromptScheduleResult> {
  const agent = await deps.getAgentState(schedule.ptyId);
  if (!agent || agent.slug !== schedule.agentSlug) return 'unavailable';
  if (agent.status !== 'waiting' && agent.status !== 'complete') return 'busy';

  const pasted = deps.write(schedule.ptyId, formatBracketedPastePayload(schedule.prompt));
  if (!pasted) return 'unavailable';

  await (deps.delay ?? sleep)(SESSION_PROMPT_SUBMIT_DELAY_MS);
  const submit = isMultilinePtyPayload(schedule.prompt) ? '\r\r' : '\r';
  // The paste already landed. Do not retry automatically if only the submit
  // write fails: that could duplicate the prompt after the pipe reconnects.
  return deps.write(schedule.ptyId, submit) ? 'sent' : 'error';
}

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
    this.timer = setI(() => void this.tick(), SESSION_PROMPT_SCHEDULER_TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
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
      const due = dueSessionPromptSchedules(loadSessionPromptSchedules(this.deps.dir), now);
      for (const schedule of due) {
        let result: SessionPromptScheduleResult;
        try {
          result = await this.deps.deliver(schedule);
        } catch {
          result = 'error';
        }

        // Re-read before advancing so pause/delete operations performed while
        // delivery was in flight are never overwritten by a stale snapshot.
        await mutateSessionPromptSchedules((fresh) => {
          const index = fresh.findIndex((candidate) => candidate.id === schedule.id);
          if (index === -1) return { schedules: fresh, result: undefined };
          fresh[index] = advanceSessionPromptSchedule(
            fresh[index],
            result,
            (this.deps.now ?? Date.now)(),
          );
          return { schedules: fresh, result: undefined };
        }, this.deps.dir);
      }
    } finally {
      this.ticking = false;
    }
  }
}
