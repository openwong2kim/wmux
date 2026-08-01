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
//
// Permission is scoped to the app launch that was granted it. Each record is
// stamped with the current boot identity, and a record that survives a shutdown
// comes back PARKED (#733): it is still owned, still holds the Stop gate and is
// still shown to the human, but it no longer authorizes the orchestrator to act
// on its own. Only a new human turn re-arms it.

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
  /** Identity of the app boot that last received a HUMAN turn for this request.
   * A record whose stamp is not the current boot is "parked" (see
   * `isDeckWorkParked`): it survived a shutdown, so nobody has confirmed since
   * launch that it is still what the human wants. Optional because records
   * written by builds before this field existed must still load — they read as
   * parked, which is the fail-closed answer. */
  bootId?: string;
}

/** Identity of THIS app boot. Seeded per process so a record written and read
 * inside one run is live even if nobody calls `setDeckWorkBootId`; the main
 * process overwrites it with the EventBus boot id so every subsystem agrees on
 * one identity. A UUID, deliberately not a timestamp: clock skew, NTP steps and
 * a system clock rolled backwards can all make a time comparison declare a
 * fresh record stale, and none of them can make two UUIDs collide. */
let currentBootId: string = randomUUID();

/** Adopt the process-wide boot identity (the EventBus's). Call once, during
 * startup, BEFORE any record is written — records stamped with the previous
 * value would otherwise read as parked. */
export function setDeckWorkBootId(id: string): void {
  const cleaned = cleanText(id, 128);
  if (cleaned) currentBootId = cleaned;
}

/** TRUE when the record predates the current app boot, i.e. it must not
 * autonomously drive the orchestrator. Fail-closed on a missing stamp: a record
 * from an older build carries no boot id, and the whole point of #733 is that an
 * unattended record drove the fleet after a restart. It stays PARKED, not
 * deleted — it still holds the Stop gate and stays visible to the human. */
export function isDeckWorkParked(work: ActiveDeckWork): boolean {
  if (!work.bootId || !currentBootId) return true;
  return work.bootId !== currentBootId;
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
  // A missing or malformed stamp is NOT a validation failure — records written
  // before this field existed are perfectly good work items. They simply load
  // without a boot id and therefore read as parked.
  const bootId = cleanText(value.bootId, 128);
  return {
    id,
    workspaceId,
    objective,
    followUps,
    startedAt,
    updatedAt,
    a2aTasks,
    ...(bootId ? { bootId } : {}),
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

/** The read seam for every consumer that may ACT on a record: the record only
 * when it belongs to this boot, null when it is parked. Readers that merely
 * SHOW the record to a human, or that hold the Stop gate with it, keep using
 * `loadActiveDeckWork` — a parked request is still owned, it just may not drive
 * the orchestrator on its own. */
export function loadLiveDeckWork(workspaceId: string, dir?: string): ActiveDeckWork | null {
  const work = loadActiveDeckWork(workspaceId, dir);
  return work && !isDeckWorkParked(work) ? work : null;
}

/** Same seam for the whole-file walkers (heartbeat arming, startup reconcile). */
export function loadLiveDeckWorks(dir?: string): Record<string, ActiveDeckWork> {
  const out: Record<string, ActiveDeckWork> = {};
  for (const [workspaceId, work] of Object.entries(loadActiveDeckWorks(dir))) {
    if (!isDeckWorkParked(work)) out[workspaceId] = work;
  }
  return out;
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
      // A human spoke to this request during THIS boot, so it is live again.
      // This is the ONLY re-arming path, and it is deliberately gated on a human
      // turn: nothing the fleet does on its own may un-park a record.
      bootId: currentBootId,
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
      bootId: currentBootId,
    };
  }
  file.active[workspaceId] = next;
  saveFile(file, dir);
  return next;
}

/** Project an A2A transition into the active human request. Events older than
 * the request cannot be adopted; they belong to earlier work.
 *
 * This deliberately does NOT stamp `bootId`, and that is also why `updatedAt` is
 * not the staleness signal. At boot the daemon recovers sessions and the
 * recovered workers replay their own older tasks; those transitions land here
 * within seconds. If a transition refreshed the staleness signal, a parked
 * record would re-arm itself from the fleet's own echo — exactly the #733 loop
 * we are cutting. Only a human turn re-arms a record. */
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
  const parked = isDeckWorkParked(work);
  const lines = [
    `[active-work${parked ? ' PARKED' : ''}] id: ${work.id}`,
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
  if (parked) {
    // The PARKED variant carries no imperative. The record predates this app
    // launch, so the ownership language ("you OWN this", "continue delegating")
    // would be an order to act on a request nobody has re-confirmed since the
    // restart — which is how #733 drove `claude --continue` into a pane four
    // seconds after boot. The id and objective stay so the human can recognise
    // the request and so a resume keeps the same work item.
    lines.push(
      'This request predates the current wmux session, so it is PARKED: it is recorded but NOT authorization to act.',
      'Do not resume, delegate, or drive any pane for it on your own. Its state may be stale and its workers may be gone.',
      'Ask the human whether to resume or drop it (deck_ask_decision) and wait for the answer. Their next instruction wins;',
      'if they confirm it, the request becomes active again and normal ownership rules resume from there.',
    );
    return lines.join('\n');
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
