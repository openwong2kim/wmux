// ─── Fan-out worker permission mode (Settings → Agents) ─────────────────────
//
// Which Claude Code permission mode a fan-out worker launches with. It lives
// main-side, in the wmux data dir, rather than in the renderer's session.json:
// `bypassPermissions` loosens what an unattended agent may do, and session.json
// is restored into the renderer and written back freely, so a setting that can
// loosen a boundary is kept where only the Settings IPC writes it. Same
// storage shape and never-throw read as deck-ledger-gate.json.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
  isFanoutWorkerPermissionMode,
  type FanoutWorkerPermissionMode,
} from '../../shared/workerLaunch';

export function getFanoutWorkerPolicyPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'fanout-worker-policy.json');
}

/** The mode in force. Anything missing or unreadable is the default. */
export function loadFanoutWorkerPermissionMode(dir?: string): FanoutWorkerPermissionMode {
  const p = getFanoutWorkerPolicyPath(dir);
  try {
    if (!fs.existsSync(p)) return DEFAULT_FANOUT_WORKER_PERMISSION_MODE;
    const raw = atomicReadJSONSync<unknown>(p);
    const mode = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).permissionMode : undefined;
    return isFanoutWorkerPermissionMode(mode) ? mode : DEFAULT_FANOUT_WORKER_PERMISSION_MODE;
  } catch {
    return DEFAULT_FANOUT_WORKER_PERMISSION_MODE;
  }
}

/** Persist the mode. Returns the mode now in force (an unknown value writes
 *  nothing and reports what is stored). */
export async function setFanoutWorkerPermissionMode(
  mode: unknown,
  dir?: string,
): Promise<FanoutWorkerPermissionMode> {
  if (!isFanoutWorkerPermissionMode(mode)) return loadFanoutWorkerPermissionMode(dir);
  await atomicWriteJSON(getFanoutWorkerPolicyPath(dir), { permissionMode: mode });
  return mode;
}
