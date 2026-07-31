// ─── Command Deck — durable human-request ownership ────────────────────────
//
// A direct message to the commander is explicit permission to carry that work
// through its delegated pane/A2A stages. Resting workspace autonomy may still
// be `off`; this record is the narrower, request-scoped opt-in that lets the
// event loop wake until the commander explicitly finalizes the work.
//
// One active item per workspace keeps the contract understandable. A new human
// message while work is active is appended as a follow-up instead of silently
// abandoning workers that are already running. The commander closes the record
// through `deck_complete_work`, after the server checks local workers and every
// A2A task observed during this work item.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { TaskState } from '../../shared/types';

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_OBJECTIVE_CHARS = 8_000;
const MAX_FOLLOW_UPS = 12;
const MAX_FOLLOW_UP_CHARS = 4_000;
const MAX_TRACKED_A2A_TASKS = 128;

export interface DeckWorkA2aTask {
  taskId: string;
  to: string;
  state: TaskState;
  updatedAt: number;
  verifiedItemCount?: number;
}

export interface ActiveDeckWork {
  id: string;
  workspaceId: string;
  objective: string;
  followUps: string[];
  startedAt: number;
  updatedAt: number;
  a2aTasks: Record<string, DeckWorkA2aTask>;
}

interface DeckWorkFile {
  version: 1;
  active: Record<string, ActiveDeckWork>;
}

function emptyFile(): DeckWorkFile {
  return { version: 1, active: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function sanitizeTask(value: unknown): DeckWorkA2aTask | null {
  if (!isRecord(value)) return null;
  const taskId = cleanText(value.taskId, 256);
  const to = cleanText(value.to, 80);
  const state = value.state;
  const updatedAt = value.updatedAt;
  if (!taskId || !to) return null;
  if (
    state !== 'submitted' &&
    state !== 'working' &&
    state !== 'input-required' &&
    state !== 'completed' &&
    state !== 'failed' &&
    state !== 'canceled'
  ) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const task: DeckWorkA2aTask = { taskId, to, state, updatedAt };
  if (
    typeof value.verifiedItemCount === 'number' &&
    Number.isInteger(value.verifiedItemCount) &&
    value.verifiedItemCount >= 0
  ) {
    task.verifiedItemCount = value.verifiedItemCount;
  }
  return task;
}

function sanitizeWork(value: unknown, workspaceId: string): ActiveDeckWork | null {
  if (!isRecord(value)) return null;
  const id = cleanText(value.id, 128);
  const objective = cleanText(value.objective, MAX_OBJECTIVE_CHARS);
  const startedAt = value.startedAt;
  const updatedAt = value.updatedAt;
  if (!id || !objective) return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const followUps = Array.isArray(value.followUps)
    ? value.followUps
      .map((item) => cleanText(item, MAX_FOLLOW_UP_CHARS))
      .filter(Boolean)
      .slice(-MAX_FOLLOW_UPS)
    : [];
  const a2aTasks: Record<string, DeckWorkA2aTask> = {};
  if (isRecord(value.a2aTasks)) {
    for (const raw of Object.values(value.a2aTasks).slice(-MAX_TRACKED_A2A_TASKS)) {
      const task = sanitizeTask(raw);
      if (task) a2aTasks[task.taskId] = task;
    }
  }
  return {
    id,
    workspaceId,
    objective,
    followUps,
    startedAt,
    updatedAt,
    a2aTasks,
  };
}

export function getDeckWorkPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-work.json');
}

function loadFile(dir?: string): DeckWorkFile {
  try {
    const raw = atomicReadJSONSync<unknown>(getDeckWorkPath(dir));
    if (!isRecord(raw) || !isRecord(raw.active)) return emptyFile();
    const active: Record<string, ActiveDeckWork> = {};
    for (const [workspaceId, value] of Object.entries(raw.active)) {
      if (!WORKSPACE_ID_RE.test(workspaceId)) continue;
      const work = sanitizeWork(value, workspaceId);
      if (work) active[workspaceId] = work;
    }
    return { version: 1, active };
  } catch {
    return emptyFile();
  }
}

function saveFile(file: DeckWorkFile, dir?: string): void {
  atomicWriteJSONSync(getDeckWorkPath(dir), file, {
    durable: true,
    rotationEnabled: true,
  });
}

export function loadActiveDeckWork(workspaceId: string, dir?: string): ActiveDeckWork | null {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null;
  return loadFile(dir).active[workspaceId] ?? null;
}

export function loadActiveDeckWorks(dir?: string): Record<string, ActiveDeckWork> {
  return loadFile(dir).active;
}

/** Start ownership for a human request, or append a human follow-up to the
 * currently-owned request. Synchronous by design: DECK_SEND must not yield
 * between its idle check and manager.send(), or an ambient turn can win the
 * workspace while the request record is being written. */
export function beginOrContinueDeckWork(
  workspaceId: string,
  text: string,
  dir?: string,
  now = Date.now(),
): ActiveDeckWork | null {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null;
  const cleaned = cleanText(text, MAX_OBJECTIVE_CHARS);
  if (!cleaned) return null;
  const file = loadFile(dir);
  const current = file.active[workspaceId];
  let next: ActiveDeckWork;
  if (current) {
    const followUp = cleanText(cleaned, MAX_FOLLOW_UP_CHARS);
    const followUps = [...current.followUps];
    if (followUp && followUp !== current.objective && followUps.at(-1) !== followUp) {
      followUps.push(followUp);
    }
    next = {
      ...current,
      followUps: followUps.slice(-MAX_FOLLOW_UPS),
      updatedAt: now,
    };
  } else {
    next = {
      id: `work-${randomUUID()}`,
      workspaceId,
      objective: cleaned,
      followUps: [],
      startedAt: now,
      updatedAt: now,
      a2aTasks: {},
    };
  }
  file.active[workspaceId] = next;
  saveFile(file, dir);
  return next;
}

/** Project an A2A transition into the active human request. Events older than
 * the request cannot be adopted; they belong to earlier work. */
export function recordDeckWorkA2aTask(
  workspaceId: string,
  input: {
    taskId: string;
    to: string;
    state: TaskState;
    ts: number;
    verifiedItemCount?: number;
  },
  dir?: string,
): ActiveDeckWork | null {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null;
  const file = loadFile(dir);
  const current = file.active[workspaceId];
  if (!current || input.ts < current.startedAt) return current ?? null;
  const task = sanitizeTask({
    taskId: input.taskId,
    to: input.to,
    state: input.state,
    updatedAt: input.ts,
    verifiedItemCount: input.verifiedItemCount,
  });
  if (!task) return current;
  const tasks = { ...current.a2aTasks, [task.taskId]: task };
  const ids = Object.keys(tasks);
  if (ids.length > MAX_TRACKED_A2A_TASKS) {
    ids
      .sort((a, b) => tasks[a].updatedAt - tasks[b].updatedAt)
      .slice(0, ids.length - MAX_TRACKED_A2A_TASKS)
      .forEach((id) => delete tasks[id]);
  }
  const next = { ...current, updatedAt: Math.max(current.updatedAt, input.ts), a2aTasks: tasks };
  file.active[workspaceId] = next;
  saveFile(file, dir);
  return next;
}

export function completeActiveDeckWork(
  workspaceId: string,
  expected: ActiveDeckWork,
  dir?: string,
): ActiveDeckWork | null {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null;
  const file = loadFile(dir);
  const current = file.active[workspaceId];
  // Compare the full mutable revision, not only the stable id. A human follow-up
  // keeps the same work id, and an A2A transition can arrive while completeWork
  // is awaiting its canonical query; either change must make that older verdict
  // retry instead of deleting newer ownership.
  if (
    !current ||
    current.id !== expected.id ||
    current.updatedAt !== expected.updatedAt ||
    current.objective !== expected.objective ||
    JSON.stringify(current.followUps) !== JSON.stringify(expected.followUps) ||
    JSON.stringify(current.a2aTasks) !== JSON.stringify(expected.a2aTasks)
  ) return null;
  delete file.active[workspaceId];
  saveFile(file, dir);
  return current;
}

export function clearActiveDeckWork(workspaceId: string, dir?: string): void {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return;
  const file = loadFile(dir);
  if (!file.active[workspaceId]) return;
  delete file.active[workspaceId];
  saveFile(file, dir);
}

export function hasPendingDeckWorkA2aTasks(work: ActiveDeckWork): boolean {
  return Object.values(work.a2aTasks).some(
    (task) => task.state === 'submitted' || task.state === 'working' || task.state === 'input-required',
  );
}

/** Trusted runtime context. The objective/follow-ups originated from the human;
 * A2A rows are pointers only and carry no worker-authored body text. */
export function renderActiveDeckWorkBlock(work: ActiveDeckWork): string {
  const lines = [
    `[active-work] id: ${work.id}`,
    `objective: ${work.objective}`,
  ];
  if (work.followUps.length > 0) {
    lines.push('human follow-ups:');
    for (const followUp of work.followUps) lines.push(`- ${followUp}`);
  }
  const tasks = Object.values(work.a2aTasks).sort((a, b) => a.updatedAt - b.updatedAt);
  if (tasks.length > 0) {
    lines.push('tracked A2A tasks (query canonical state before acting):');
    for (const task of tasks) {
      const verified = task.verifiedItemCount === undefined
        ? ''
        : ` verified-evidence=${task.verifiedItemCount}`;
      lines.push(`- task=${task.taskId} to=${task.to} state=${task.state}${verified}`);
    }
  }
  lines.push(
    'You OWN this request until it is actually finished. Progress prose and a model turn ending do NOT finish it.',
    'Continue delegating, unblock workers, inspect artifacts, and run or delegate independent verification.',
    'Only after every required pane/A2A task is complete and the acceptance checks pass, call',
    'deck_complete_work({summary, verification}). The server rejects finalization while tracked work is outstanding.',
    'Do not tell the operator the work is done unless that tool call succeeds. If blocked on a real human fork,',
    'use deck_ask_decision and leave this work active.',
  );
  return lines.join('\n');
}
