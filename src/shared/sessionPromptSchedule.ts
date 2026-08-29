import type { AgentSlug } from './agentIdentity';

export type SessionPromptScheduleResult = 'sent' | 'busy' | 'unavailable' | 'error';

/** A persisted prompt bound to one concrete agent PTY. */
export interface SessionPromptSchedule {
  id: string;
  /** Immutable daemon/local PTY session id. Never retargeted implicitly. */
  ptyId: string;
  /** Agent family detected when the operator created the schedule. */
  agentSlug: AgentSlug;
  /** Exact operator-authored prompt to paste and submit. */
  prompt: string;
  /** Next delivery time (ms epoch). */
  nextRunAt: number;
  /** Repeat interval in minutes; absent = one-shot. */
  intervalMinutes?: number;
  enabled: boolean;
  createdAt: number;
  lastAttemptAt?: number;
  lastRunAt?: number;
  lastResult?: SessionPromptScheduleResult;
}
