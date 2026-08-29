// Persisted prompts that target one concrete wmux PTY session.
//
// This is intentionally separate from Command Deck schedules. A deck schedule
// starts a new orchestrator turn for a workspace; a session prompt schedule
// safely pastes text into an already-running agent TUI. Keeping the stores
// distinct prevents deck autonomy controls from accidentally disabling a
// prompt the operator explicitly queued for a pane.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { isAgentSlug, type AgentSlug } from '../../shared/agentIdentity';
import type {
  SessionPromptSchedule,
  SessionPromptScheduleResult,
} from '../../shared/sessionPromptSchedule';

export type {
  SessionPromptSchedule,
  SessionPromptScheduleResult,
} from '../../shared/sessionPromptSchedule';

const MAX_SCHEDULES = 100;
const MAX_PROMPT_CHARS = 16_000;
const MAX_PTY_ID_CHARS = 256;
const MAX_INTERVAL_MINUTES = 365 * 24 * 60;

export const SESSION_PROMPT_SCHEDULE_LIMITS = {
  MAX_SCHEDULES,
  MAX_PROMPT_CHARS,
  MAX_PTY_ID_CHARS,
  MAX_INTERVAL_MINUTES,
} as const;

export function getSessionPromptSchedulesPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'session-prompt-schedules.json');
}

function validPtyId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PTY_ID_CHARS) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function sanitize(raw: unknown): SessionPromptSchedule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (!validPtyId(o.ptyId)) return null;
  if (!isAgentSlug(o.agentSlug)) return null;
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) return null;
  if (typeof o.nextRunAt !== 'number' || !Number.isFinite(o.nextRunAt)) return null;

  const schedule: SessionPromptSchedule = {
    id: o.id,
    ptyId: o.ptyId,
    agentSlug: o.agentSlug,
    prompt: o.prompt.slice(0, MAX_PROMPT_CHARS),
    nextRunAt: o.nextRunAt,
    enabled: o.enabled === true,
    createdAt:
      typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0,
  };
  if (
    typeof o.intervalMinutes === 'number' &&
    Number.isFinite(o.intervalMinutes) &&
    o.intervalMinutes >= 1 &&
    o.intervalMinutes <= MAX_INTERVAL_MINUTES
  ) {
    schedule.intervalMinutes = Math.floor(o.intervalMinutes);
  }
  if (typeof o.lastAttemptAt === 'number' && Number.isFinite(o.lastAttemptAt)) {
    schedule.lastAttemptAt = o.lastAttemptAt;
  }
  if (typeof o.lastRunAt === 'number' && Number.isFinite(o.lastRunAt)) {
    schedule.lastRunAt = o.lastRunAt;
  }
  if (
    o.lastResult === 'sent' ||
    o.lastResult === 'busy' ||
    o.lastResult === 'unavailable' ||
    o.lastResult === 'error'
  ) {
    schedule.lastResult = o.lastResult;
  }
  return schedule;
}

export function loadSessionPromptSchedules(dir?: string): SessionPromptSchedule[] {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getSessionPromptSchedulesPath(dir));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitize).filter((s): s is SessionPromptSchedule => s !== null);
}

export async function saveSessionPromptSchedules(
  schedules: SessionPromptSchedule[],
  dir?: string,
): Promise<void> {
  await atomicWriteJSON(getSessionPromptSchedulesPath(dir), schedules);
}

const mutationQueues = new Map<string, Promise<void>>();

/**
 * Serialize read-modify-write operations so scheduler ticks and renderer CRUD
 * cannot overwrite one another with stale snapshots.
 */
export async function mutateSessionPromptSchedules<T>(
  mutate: (schedules: SessionPromptSchedule[]) => {
    schedules: SessionPromptSchedule[];
    result: T;
  } | Promise<{ schedules: SessionPromptSchedule[]; result: T }>,
  dir?: string,
): Promise<T> {
  const storePath = getSessionPromptSchedulesPath(dir);
  const previous = mutationQueues.get(storePath) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  mutationQueues.set(storePath, queued);

  await previous;
  try {
    const outcome = await mutate(loadSessionPromptSchedules(dir));
    await saveSessionPromptSchedules(outcome.schedules, dir);
    return outcome.result;
  } finally {
    release();
    if (mutationQueues.get(storePath) === queued) mutationQueues.delete(storePath);
  }
}

export function createSessionPromptSchedule(args: {
  ptyId: string;
  agentSlug: AgentSlug;
  prompt: string;
  nextRunAt: number;
  intervalMinutes?: number;
  now?: number;
}): SessionPromptSchedule | null {
  const prompt = args.prompt.trim();
  const createdAt = args.now ?? Date.now();
  if (!validPtyId(args.ptyId)) return null;
  if (!isAgentSlug(args.agentSlug)) return null;
  if (!prompt || prompt.length > MAX_PROMPT_CHARS || !Number.isFinite(args.nextRunAt)) return null;
  if (args.nextRunAt <= createdAt) return null;
  if (
    args.intervalMinutes !== undefined &&
    (!Number.isInteger(args.intervalMinutes) ||
      args.intervalMinutes < 1 ||
      args.intervalMinutes > MAX_INTERVAL_MINUTES)
  ) {
    return null;
  }

  const schedule: SessionPromptSchedule = {
    id: randomUUID(),
    ptyId: args.ptyId,
    agentSlug: args.agentSlug,
    prompt,
    nextRunAt: args.nextRunAt,
    enabled: true,
    createdAt,
  };
  if (
    typeof args.intervalMinutes === 'number' &&
    Number.isInteger(args.intervalMinutes) &&
    args.intervalMinutes >= 1 &&
    args.intervalMinutes <= MAX_INTERVAL_MINUTES
  ) {
    schedule.intervalMinutes = Math.floor(args.intervalMinutes);
  }
  return schedule;
}

export function dueSessionPromptSchedules(
  schedules: SessionPromptSchedule[],
  now: number,
): SessionPromptSchedule[] {
  return schedules
    .filter((s) => s.enabled && s.nextRunAt <= now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt);
}

/**
 * Advance one delivery attempt.
 *
 * Busy and temporarily unavailable sessions remain due and retry on the next
 * tick. A successful delivery consumes the occurrence. An error after a
 * partial write also consumes it: retrying could duplicate half a prompt in
 * the target TUI, which is worse than surfacing the failed result.
 */
export function advanceSessionPromptSchedule(
  schedule: SessionPromptSchedule,
  result: SessionPromptScheduleResult,
  now: number,
): SessionPromptSchedule {
  const next: SessionPromptSchedule = {
    ...schedule,
    lastAttemptAt: now,
    lastResult: result,
  };
  if (result === 'busy' || result === 'unavailable') return next;

  next.lastRunAt = now;
  if (schedule.intervalMinutes && schedule.intervalMinutes > 0) {
    const step = schedule.intervalMinutes * 60_000;
    let candidate = schedule.nextRunAt;
    while (candidate <= now) candidate += step;
    next.nextRunAt = candidate;
  } else {
    next.enabled = false;
  }
  return next;
}
