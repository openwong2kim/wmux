// ─── Which pane sessions are fenced (factory/pane-fence-sessions.json) ──────
//
// A person's opted-in pane (paneFence.ts): main's record, per daemon session,
// of whether the pane's next claude launch is fenced and what its last fenced
// launch ran with. pty:create writes it when an opted-in pane starts;
// pty:write-launch (a resume, a relaunch) reads it, and the pane menu's
// switch changes it for the next launch. Session ids are the daemon's, so the
// record outlives an app restart that reattaches to the same sessions.
//
// Kept in memory and written through to the file. A missing or unreadable
// file is an empty record.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSONSync } from '../../daemon/util/atomicWrite/core';

export interface PaneFenceSession {
  /** The pane's next claude launch is fenced. */
  on: boolean;
  /** The folder the last fenced launch was fenced to. */
  cwd?: string;
  settingsFile?: string;
  tempDir?: string;
  at: number;
}

/** Most sessions the file keeps (the oldest go first). */
export const PANE_FENCE_SESSIONS_MAX = 512;

export function getPaneFenceSessionsPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'factory', 'pane-fence-sessions.json');
}

const cache = new Map<string, Map<string, PaneFenceSession>>();

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 ? v : undefined;
}

function load(dir: string): Map<string, PaneFenceSession> {
  const known = cache.get(dir);
  if (known) return known;
  const out = new Map<string, PaneFenceSession>();
  try {
    const raw = JSON.parse(fs.readFileSync(getPaneFenceSessionsPath(dir), 'utf8')) as { sessions?: unknown };
    const sessions = raw && typeof raw.sessions === 'object' && raw.sessions && !Array.isArray(raw.sessions) ? raw.sessions as Record<string, unknown> : {};
    for (const [id, v] of Object.entries(sessions)) {
      if (!id || id.length > 128 || !v || typeof v !== 'object') continue;
      const r = v as Record<string, unknown>;
      if (typeof r.on !== 'boolean') continue;
      const cwd = str(r.cwd);
      const settingsFile = str(r.settingsFile);
      const tempDir = str(r.tempDir);
      out.set(id, { on: r.on, ...(cwd ? { cwd } : {}), ...(settingsFile ? { settingsFile } : {}), ...(tempDir ? { tempDir } : {}), at: typeof r.at === 'number' ? r.at : 0 });
    }
  } catch { /* missing or unreadable: empty */ }
  cache.set(dir, out);
  return out;
}

function save(dir: string, sessions: Map<string, PaneFenceSession>): void {
  while (sessions.size > PANE_FENCE_SESSIONS_MAX) {
    // A switched-off record goes first: dropping an on one would let that
    // pane's next launch start unfenced until the renderer asserts it again.
    let oldest: string | null = null;
    let at = Infinity;
    for (const [id, r] of sessions) if (!r.on && r.at < at) { at = r.at; oldest = id; }
    if (oldest === null) for (const [id, r] of sessions) if (r.at < at) { at = r.at; oldest = id; }
    if (oldest === null) break;
    sessions.delete(oldest);
  }
  try {
    fs.mkdirSync(path.dirname(getPaneFenceSessionsPath(dir)), { recursive: true, mode: 0o700 });
    atomicWriteJSONSync(getPaneFenceSessionsPath(dir), { version: 1, sessions: Object.fromEntries(sessions) });
  } catch (err) {
    console.warn('[pane-fence] the session record could not be written', err);
  }
}

/** The session's record, or null (not an opted-in pane). */
export function getPaneFenceSession(sessionId: string, dir: string = getWmuxDir()): PaneFenceSession | null {
  return load(dir).get(sessionId) ?? null;
}

/** Record a fenced launch of the session. Its switch stays as it is (a
 *  switch-off made while the launch was being checked holds); a session with
 *  no record yet is on. */
export function notePaneFenceLaunch(sessionId: string, launch: { cwd: string; settingsFile: string; tempDir?: string }, dir: string = getWmuxDir(), now: number = Date.now()): void {
  const sessions = load(dir);
  sessions.set(sessionId, { on: sessions.get(sessionId)?.on ?? true, cwd: launch.cwd, settingsFile: launch.settingsFile, ...(launch.tempDir ? { tempDir: launch.tempDir } : {}), at: now });
  save(dir, sessions);
}

/** The pane menu's switch: the session's next claude launch is fenced or
 *  not. A running claude is never changed. Returns the state now in force. */
export function setPaneFenceOn(sessionId: unknown, on: unknown, dir: string = getWmuxDir(), now: number = Date.now()): boolean {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128 || typeof on !== 'boolean') {
    return typeof sessionId === 'string' ? getPaneFenceSession(sessionId, dir)?.on === true : false;
  }
  const sessions = load(dir);
  const was = sessions.get(sessionId);
  sessions.set(sessionId, { ...(was ?? {}), on, at: now });
  save(dir, sessions);
  return on;
}

/** The temp folders and settings files the records name (startup prune). */
export function paneFenceNamedPaths(dir: string = getWmuxDir()): { tempDirs: Set<string>; files: Set<string> } {
  const tempDirs = new Set<string>();
  const files = new Set<string>();
  for (const r of load(dir).values()) {
    if (r.tempDir) tempDirs.add(r.tempDir);
    if (r.settingsFile) files.add(r.settingsFile);
  }
  return { tempDirs, files };
}

/** Test-only. */
export function __resetPaneFenceSessionsForTesting(): void {
  cache.clear();
}
