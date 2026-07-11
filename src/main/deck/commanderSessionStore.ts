// ─── Command Deck — commander session persistence (P3a) ─────────────────────
//
// Persists the commander brain's SDK session id across app restarts (and OS
// reboots) so the next launch resumes the SAME conversation instead of an
// amnesiac fresh brain. The transcript itself lives on the claude side (keyed
// by session id + cwd — see the stable-cwd note in ClaudeSdkAdapter); wmux only
// needs to remember which id to hand back to `resume`.
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

export function getCommanderSessionPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-commander.json');
}

/** Load the persisted commander session, or null when absent/corrupt. Sync on
 *  purpose: it runs once inside the lazy manager construction on the first
 *  deck:send, and the file is a handful of bytes. */
export function loadCommanderSession(dir?: string): PersistedCommanderSession | null {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getCommanderSessionPath(dir));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.sessionId !== 'string' || o.sessionId.trim() === '') return null;
  return {
    sessionId: o.sessionId,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
  };
}

/** Persist the current session id (fire-and-forget from the caller's point of
 *  view — a failed write only costs resume continuity, never the live turn). */
export async function saveCommanderSession(sessionId: string, dir?: string): Promise<void> {
  const record: PersistedCommanderSession = {
    sessionId,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJSON(getCommanderSessionPath(dir), record);
}
