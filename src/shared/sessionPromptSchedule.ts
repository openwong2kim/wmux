import type { AgentSlug } from './agentIdentity';

export type SessionPromptScheduleResult =
  | 'sent'
  | 'busy'
  | 'unavailable'
  | 'session_changed'
  /** Nothing written: the pane is on an agent's folder-trust prompt. Stays
   *  due, like 'busy' (a screen that cannot rule one out answers 'busy'). */
  | 'folder_trust'
  | 'error';

/** Every result, so a stored or answered value is checked against the
 *  type: a new result fails typecheck here until it is listed. */
const SESSION_PROMPT_SCHEDULE_RESULTS: Record<SessionPromptScheduleResult, true> = {
  sent: true, busy: true, unavailable: true, session_changed: true, folder_trust: true, error: true,
};

export function isSessionPromptScheduleResult(value: unknown): value is SessionPromptScheduleResult {
  return typeof value === 'string' && Object.hasOwn(SESSION_PROMPT_SCHEDULE_RESULTS, value);
}

export interface SessionPromptDeliveryClaim {
  /** Unique attempt token used to reject stale finalizers. */
  token: string;
  /** The occurrence being delivered (the pre-claim nextRunAt). */
  occurrenceAt: number;
  /** Wall-clock time when the at-most-once claim was persisted. */
  startedAt: number;
}

/** A persisted prompt bound to one concrete agent PTY. */
export interface SessionPromptSchedule {
  id: string;
  /** Immutable daemon/local PTY session id. Never retargeted implicitly. */
  ptyId: string;
  /**
   * Daemon-minted identity for the logical session that owned `ptyId` when the
   * schedule was created. Missing only on legacy rows, which are surfaced as
   * terminal immediately rather than binding themselves to a possibly reused id.
   */
  sessionIncarnationId?: string;
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
  /** When the current run of `busy` answers began (ms epoch): the give-up
   *  hour counts from here, not from a due time that may be long past. */
  busySince?: number;
  /**
   * Persisted before PTY input begins. If wmux stops before finalization, the
   * next scheduler tick consumes the occurrence as an error instead of
   * risking duplicate unattended input.
   */
  deliveryClaim?: SessionPromptDeliveryClaim;
}
