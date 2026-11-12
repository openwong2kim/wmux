// ─── Fan-out policy (Settings → Agents) ─────────────────────────────────────
//
// Two operator settings for pipe/MCP fan-out, both kept main-side in the wmux
// data dir rather than in the renderer's session.json:
//
//   permissionMode   — the Claude Code permission mode a worker launches with.
//                      `bypassPermissions` loosens what an unattended agent may
//                      do, and session.json is restored into the renderer and
//                      written back freely, so it lives where only the
//                      Settings IPC writes it.
//   requireApproval  — whether a fan-out waits for the operator's dialog.
//                      Main makes the decision, so a request that arrives
//                      before the renderer has loaded its session cannot be
//                      waved through by a not-yet-restored default.
//   trustAgyFolders  — whether main may list a fan-out task folder in agy's
//                      own trustedWorkspaces (main/agents/agyTrust). Off by
//                      default (owner decision): a persistent write into
//                      another CLI's global settings is opt-in.
//   tasksPerCall     — tasks one fan-out call may start (default 8), and how
//   fanoutDepth        deep fan-out may go (default 1). Main-side, like the
//                      caps below, so an agent cannot raise them.
//   liveTaskCap      — the app-wide fan-out caps (worktask/fanoutGuards.ts):
//   hourlyTaskCap      tasks live at once, and starts per rolling hour. Each
//                      is optional; null (the default) is no limit. An agent
//                      must not set its own brakes, so they live here, where
//                      only the Settings IPC writes, clamped to
//                      shared/fanoutTaskCaps.ts's bounds.
//
// A missing file is the defaults (auto, no approval — owner decision
// 2026-09-24). A file that exists but cannot be read resolves to the SAFE side
// of each setting: approval required, the default permission mode, and the
// caps at their old defaults (8 live, 24 per hour). A missing file has no
// caps (no limit). A file written before the caps were optional reads those
// old defaults as unset; see `taskCapsVersion`.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
  isFanoutWorkerPermissionMode,
  type FanoutWorkerPermissionMode,
} from '../../shared/workerLaunch';
import {
  LEGACY_FANOUT_HOURLY_TASK_CAP,
  LEGACY_FANOUT_LIVE_TASK_CAP,
  DEFAULT_FANOUT_DEPTH,
  DEFAULT_FANOUT_TASKS_PER_CALL,
  clampFanoutDepth,
  clampFanoutHourlyTaskCap,
  clampFanoutLiveTaskCap,
  clampFanoutTasksPerCall,
} from '../../shared/fanoutTaskCaps';

export const DEFAULT_FANOUT_REQUIRE_APPROVAL = false;
export const DEFAULT_FANOUT_TRUST_AGY_FOLDERS = false;

interface FanoutPolicy {
  permissionMode: FanoutWorkerPermissionMode;
  requireApproval: boolean;
  trustAgyFolders: boolean;
  /** null: no limit (the default). */
  liveTaskCap: number | null;
  hourlyTaskCap: number | null;
  /** Tasks one fan-out call may start (default 8, up to the wire maximum). */
  tasksPerCall: number;
  /** How deep fan-out may go (default 1: a task cannot fan out again). */
  fanoutDepth: number;
  /**
   * TASK_CAPS_VERSION once the caps were read as optional. A file without it
   * was written when they were always stored: there, a cap equal to the old
   * default reads as unset, any other value as the owner's choice. Every
   * write carries the version, so that reading happens until the first write
   * and never again (a cap the owner then sets to 8 or 24 stays).
   */
  taskCapsVersion: typeof TASK_CAPS_VERSION;
}

const TASK_CAPS_VERSION = 2;

/** A stored cap: the old default in a file from before the caps were optional is unset. */
function storedCap(raw: Record<string, unknown>, key: 'liveTaskCap' | 'hourlyTaskCap', legacyDefault: number, clamp: (v: unknown) => number | null): number | null {
  const value = raw[key] === null ? null : clamp(raw[key]);
  if (raw.taskCapsVersion !== TASK_CAPS_VERSION && value === legacyDefault) return null;
  return value;
}

export function getFanoutWorkerPolicyPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'fanout-worker-policy.json');
}

function loadPolicy(dir?: string): FanoutPolicy {
  const p = getFanoutWorkerPolicyPath(dir);
  if (!fs.existsSync(p)) {
    return {
      permissionMode: DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
      requireApproval: DEFAULT_FANOUT_REQUIRE_APPROVAL,
      trustAgyFolders: DEFAULT_FANOUT_TRUST_AGY_FOLDERS,
      liveTaskCap: null,
      hourlyTaskCap: null,
      tasksPerCall: DEFAULT_FANOUT_TASKS_PER_CALL,
      fanoutDepth: DEFAULT_FANOUT_DEPTH,
      taskCapsVersion: TASK_CAPS_VERSION,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    return {
      permissionMode: isFanoutWorkerPermissionMode(raw.permissionMode)
        ? raw.permissionMode
        : DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
      requireApproval:
        typeof raw.requireApproval === 'boolean' ? raw.requireApproval : DEFAULT_FANOUT_REQUIRE_APPROVAL,
      // Only a literal true opts in.
      trustAgyFolders: raw.trustAgyFolders === true,
      liveTaskCap: storedCap(raw, 'liveTaskCap', LEGACY_FANOUT_LIVE_TASK_CAP, clampFanoutLiveTaskCap),
      hourlyTaskCap: storedCap(raw, 'hourlyTaskCap', LEGACY_FANOUT_HOURLY_TASK_CAP, clampFanoutHourlyTaskCap),
      tasksPerCall: clampFanoutTasksPerCall(raw.tasksPerCall),
      fanoutDepth: clampFanoutDepth(raw.fanoutDepth),
      taskCapsVersion: TASK_CAPS_VERSION,
    };
  } catch {
    return {
      permissionMode: DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
      requireApproval: true,
      trustAgyFolders: false,
      // The safe side: the brakes the old defaults were, until the file is readable again.
      liveTaskCap: LEGACY_FANOUT_LIVE_TASK_CAP,
      hourlyTaskCap: LEGACY_FANOUT_HOURLY_TASK_CAP,
      tasksPerCall: DEFAULT_FANOUT_TASKS_PER_CALL,
      fanoutDepth: DEFAULT_FANOUT_DEPTH,
      taskCapsVersion: TASK_CAPS_VERSION,
    };
  }
}

/** The worker permission mode in force. */
export function loadFanoutWorkerPermissionMode(dir?: string): FanoutWorkerPermissionMode {
  return loadPolicy(dir).permissionMode;
}

/** Whether a pipe/MCP fan-out waits for the operator's approval. */
export function loadFanoutRequireApproval(dir?: string): boolean {
  return loadPolicy(dir).requireApproval;
}

/** Persist the mode. Returns the mode now in force (an unknown value writes
 *  nothing and reports what is stored). */
export async function setFanoutWorkerPermissionMode(
  mode: unknown,
  dir?: string,
): Promise<FanoutWorkerPermissionMode> {
  if (!isFanoutWorkerPermissionMode(mode)) return loadFanoutWorkerPermissionMode(dir);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { ...loadPolicy(dir), permissionMode: mode });
  return mode;
}

/** Whether main may pre-trust fan-out task folders in agy's settings. */
export function loadFanoutTrustAgyFolders(dir?: string): boolean {
  return loadPolicy(dir).trustAgyFolders;
}

/** Persist the agy trust switch. Only a literal boolean writes. */
export async function setFanoutTrustAgyFolders(value: unknown, dir?: string): Promise<boolean> {
  if (typeof value !== 'boolean') return loadFanoutTrustAgyFolders(dir);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { ...loadPolicy(dir), trustAgyFolders: value });
  return value;
}

/** Persist the approval switch. Only a literal boolean writes. */
export async function setFanoutRequireApproval(value: unknown, dir?: string): Promise<boolean> {
  if (typeof value !== 'boolean') return loadFanoutRequireApproval(dir);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { ...loadPolicy(dir), requireApproval: value });
  return value;
}

/** How many fan-out tasks may be live at once across wmux; null: no limit. */
export function loadFanoutLiveTaskCap(dir?: string): number | null {
  return loadPolicy(dir).liveTaskCap;
}

/** How many fan-out tasks may start per rolling hour across wmux; null: no limit. */
export function loadFanoutHourlyTaskCap(dir?: string): number | null {
  return loadPolicy(dir).hourlyTaskCap;
}

/** Persist the live cap, clamped to its bounds, or null for no limit. Anything
 *  else writes nothing; returns the cap now in force. */
export async function setFanoutLiveTaskCap(value: unknown, dir?: string): Promise<number | null> {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) return loadFanoutLiveTaskCap(dir);
  const cap = clampFanoutLiveTaskCap(value);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { ...loadPolicy(dir), liveTaskCap: cap });
  return cap;
}

/** Persist the hourly cap, clamped to its bounds, or null for no limit.
 *  Anything else writes nothing; returns the cap now in force. */
export async function setFanoutHourlyTaskCap(value: unknown, dir?: string): Promise<number | null> {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) return loadFanoutHourlyTaskCap(dir);
  const cap = clampFanoutHourlyTaskCap(value);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { ...loadPolicy(dir), hourlyTaskCap: cap });
  return cap;
}

/** Tasks one fan-out call may start, the owner's setting (default 8). */
export function loadFanoutTasksPerCall(dir?: string): number {
  return loadPolicy(dir).tasksPerCall;
}

/** Persist tasks per call, clamped to its bounds. Only a finite number writes;
 *  returns the value now in force. */
export async function setFanoutTasksPerCall(value: unknown, dir?: string): Promise<number> {
  if (typeof value !== 'number' || !Number.isFinite(value)) return loadFanoutTasksPerCall(dir);
  const n = clampFanoutTasksPerCall(value);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { ...loadPolicy(dir), tasksPerCall: n });
  return n;
}

/** How deep fan-out may go, the owner's setting (default 1). */
export function loadFanoutDepth(dir?: string): number {
  return loadPolicy(dir).fanoutDepth;
}

/** Persist the depth, clamped to its bounds. Only a finite number writes;
 *  returns the value now in force. */
export async function setFanoutDepth(value: unknown, dir?: string): Promise<number> {
  if (typeof value !== 'number' || !Number.isFinite(value)) return loadFanoutDepth(dir);
  const n = clampFanoutDepth(value);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { ...loadPolicy(dir), fanoutDepth: n });
  return n;
}
