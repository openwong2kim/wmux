// ─── Command Deck — commander session persistence (P3a, per-workspace M1.5) ──
//
// Persists each workspace orchestrator's SDK session id across app restarts
// (and OS reboots) so the next launch resumes the SAME conversation instead of
// an amnesiac fresh brain. The transcript itself lives on the claude side
// (keyed by session id + cwd — see the stable-cwd note in ClaudeSdkAdapter);
// wmux only needs to remember which id to hand back to `resume`.
//
// M1.5: one orchestrator per workspace → one persisted session per workspace,
// stored as a wsId-keyed map in the same file. The pre-M1.5 schema (a single
// top-level `sessionId` for the fleet-wide brain) is DELIBERATELY DISCARDED on
// load: that conversation belonged to no particular workspace, so migrating it
// into any one partition would be arbitrary — the one-time cost is losing one
// dev-machine conversation's continuity (the feature is unreleased).
//
// Storage: one tiny JSON file in the wmux data dir (`deck-commander.json`),
// written with the daemon's atomic-write primitives so a crash mid-write can't
// leave a torn file, and honoring WMUX_DATA_SUFFIX instance isolation like
// every other wmux store. The dir is injectable for tests.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export interface PersistedCommanderSession {
  /** The SDK session id to pass as `resume` on the next first turn. */
  sessionId: string;
  /** ISO timestamp of the last persist — surfaced to the P3b greeting later. */
  updatedAt: string;
}

interface CommanderSessionsFile {
  /** workspaceId → that workspace orchestrator's persisted session. */
  sessions: Record<string, PersistedCommanderSession>;
}

export function getCommanderSessionPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-commander.json');
}

function readSessionsFile(dir?: string): Record<string, PersistedCommanderSession> {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getCommanderSessionPath(dir));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  // Legacy (fleet-wide) schema had `sessionId` at the top level — discarded.
  const sessions = (raw as Record<string, unknown>).sessions;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return {};
  const out: Record<string, PersistedCommanderSession> = {};
  for (const [wsId, entry] of Object.entries(sessions as Record<string, unknown>)) {
    if (!wsId || !entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || o.sessionId.trim() === '') continue;
    out[wsId] = {
      sessionId: o.sessionId,
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    };
  }
  return out;
}

/** Load the persisted session for one workspace's orchestrator, or null when
 *  absent/corrupt. Sync on purpose: it runs once inside the lazy manager
 *  construction on that workspace's first deck:send, and the file is a
 *  handful of bytes. */
export function loadCommanderSession(
  workspaceId: string,
  dir?: string,
): PersistedCommanderSession | null {
  if (!workspaceId) return null;
  return readSessionsFile(dir)[workspaceId] ?? null;
}

/** Persist one workspace orchestrator's session id (fire-and-forget from the
 *  caller's point of view — a failed write only costs resume continuity,
 *  never the live turn). Read-modify-write against the current file so
 *  concurrent workspaces don't clobber each other's entries. */
export async function saveCommanderSession(
  workspaceId: string,
  sessionId: string,
  dir?: string,
): Promise<void> {
  if (!workspaceId) return;
  const sessions = readSessionsFile(dir);
  sessions[workspaceId] = { sessionId, updatedAt: new Date().toISOString() };
  const record: CommanderSessionsFile = { sessions };
  await atomicWriteJSON(getCommanderSessionPath(dir), record);
}

/** Drop one workspace orchestrator's persisted session (the `/clear` reset).
 *  The next turn then starts a FRESH SDK conversation instead of resuming.
 *  Missing entry / missing file are fine — clearing twice is a no-op. */
export async function clearCommanderSession(
  workspaceId: string,
  dir?: string,
): Promise<void> {
  if (!workspaceId) return;
  const sessions = readSessionsFile(dir);
  if (!(workspaceId in sessions)) return;
  delete sessions[workspaceId];
  const record: CommanderSessionsFile = { sessions };
  await atomicWriteJSON(getCommanderSessionPath(dir), record);
}
