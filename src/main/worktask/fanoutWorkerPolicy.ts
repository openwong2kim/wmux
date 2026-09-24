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
//
// A missing file is the defaults (auto, no approval — owner decision
// 2026-09-24). A file that exists but cannot be read resolves to the SAFE side
// of each setting: approval required, and the default permission mode.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
  isFanoutWorkerPermissionMode,
  type FanoutWorkerPermissionMode,
} from '../../shared/workerLaunch';

export const DEFAULT_FANOUT_REQUIRE_APPROVAL = false;

interface FanoutPolicy {
  permissionMode: FanoutWorkerPermissionMode;
  requireApproval: boolean;
}

export function getFanoutWorkerPolicyPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'fanout-worker-policy.json');
}

function loadPolicy(dir?: string): FanoutPolicy {
  const p = getFanoutWorkerPolicyPath(dir);
  if (!fs.existsSync(p)) {
    return { permissionMode: DEFAULT_FANOUT_WORKER_PERMISSION_MODE, requireApproval: DEFAULT_FANOUT_REQUIRE_APPROVAL };
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
    };
  } catch {
    return { permissionMode: DEFAULT_FANOUT_WORKER_PERMISSION_MODE, requireApproval: true };
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

/** Persist the approval switch. Only a literal boolean writes. */
export async function setFanoutRequireApproval(value: unknown, dir?: string): Promise<boolean> {
  if (typeof value !== 'boolean') return loadFanoutRequireApproval(dir);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { ...loadPolicy(dir), requireApproval: value });
  return value;
}
