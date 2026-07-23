// ─── Command Deck — briefing config + last-viewed snapshot store ─────────────
//
// Holds the two "welcome home" briefing knobs (enabled / autoShow) AND the
// per-workspace last-VIEWED status snapshot the builder diffs against. Same
// storage shape and never-throw posture as deckHeartbeatStore (atomic JSON in
// the wmux data dir, WMUX_DATA_SUFFIX isolated) — config and snapshots share ONE
// file so a partial write of either preserves the other.
//
// The snapshot is written when the operator VIEWS the briefing (the get handler
// persists it after building the delta), so the next open diffs against "what
// you last saw", not "what main last pushed". Status-only per pane (ptyId→status
// + decisionId) keeps the file tiny even at 30+ sessions.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import type { BriefedSnapshot } from './deckBriefing';
import type { AgentStatus } from '../../shared/types';

export interface DeckBriefingConfig {
  /** Master switch — OFF makes the get handler return no briefing at all. */
  enabled: boolean;
  /** Auto-expand on a real delta / cold start (vs. always collapsed). */
  autoShow: boolean;
}

export const DEFAULT_BRIEFING: DeckBriefingConfig = { enabled: true, autoShow: true };

interface DeckBriefingFile {
  config: DeckBriefingConfig;
  snapshots: Record<string, BriefedSnapshot>;
}

export function getDeckBriefingPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-briefing.json');
}

const VALID_STATUS: ReadonlySet<string> = new Set([
  'running',
  'complete',
  'error',
  'waiting',
  'awaiting_input',
  'idle',
]);

/** Read + sanitize the whole file. Anything uncertain (missing file, torn JSON,
 *  wrong shape) resolves to defaults. Never throws. */
function loadFile(dir?: string): DeckBriefingFile {
  try {
    const raw = atomicReadJSONSync<unknown>(getDeckBriefingPath(dir));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { config: { ...DEFAULT_BRIEFING }, snapshots: {} };
    }
    const o = raw as Record<string, unknown>;
    const config = sanitizeConfig(o.config);
    const snapshots = sanitizeSnapshots(o.snapshots);
    return { config, snapshots };
  } catch {
    return { config: { ...DEFAULT_BRIEFING }, snapshots: {} };
  }
}

function sanitizeConfig(raw: unknown): DeckBriefingConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_BRIEFING };
  const o = raw as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_BRIEFING.enabled,
    autoShow: typeof o.autoShow === 'boolean' ? o.autoShow : DEFAULT_BRIEFING.autoShow,
  };
}

function sanitizeSnapshots(raw: unknown): Record<string, BriefedSnapshot> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, BriefedSnapshot> = {};
  for (const [wsId, snap] of Object.entries(raw as Record<string, unknown>)) {
    const s = sanitizeSnapshot(snap);
    if (s) out[wsId] = s;
  }
  return out;
}

function sanitizeSnapshot(raw: unknown): BriefedSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const panes = Array.isArray(o.panes)
    ? o.panes
        .filter(
          (p): p is { ptyId: string; agentStatus: string } =>
            !!p &&
            typeof p === 'object' &&
            typeof (p as { ptyId?: unknown }).ptyId === 'string' &&
            typeof (p as { agentStatus?: unknown }).agentStatus === 'string' &&
            VALID_STATUS.has((p as { agentStatus: string }).agentStatus),
        )
        .map((p) => ({ ptyId: p.ptyId, agentStatus: p.agentStatus as AgentStatus }))
    : [];
  return {
    panes,
    decisionId: typeof o.decisionId === 'string' ? o.decisionId : null,
    at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
  };
}

/** The current briefing config. Never throws (fail-open to the default). */
export function loadDeckBriefingConfig(dir?: string): DeckBriefingConfig {
  return loadFile(dir).config;
}

/** Persist a config patch, merging over the current value (a partial update
 *  keeps the other field) and preserving all stored snapshots. Returns the
 *  config now in force. */
export async function saveDeckBriefingConfig(
  patch: Partial<DeckBriefingConfig>,
  dir?: string,
): Promise<DeckBriefingConfig> {
  const file = loadFile(dir);
  const next: DeckBriefingConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : file.config.enabled,
    autoShow: typeof patch.autoShow === 'boolean' ? patch.autoShow : file.config.autoShow,
  };
  await atomicWriteJSON(getDeckBriefingPath(dir), { config: next, snapshots: file.snapshots });
  return next;
}

/** The last-viewed snapshot for a workspace, or null if none was ever stored. */
export function loadBriefedSnapshot(workspaceId: string, dir?: string): BriefedSnapshot | null {
  return loadFile(dir).snapshots[workspaceId] ?? null;
}

/** Persist one workspace's last-viewed snapshot, preserving config + the other
 *  workspaces' snapshots. Fire-and-forget from the handler (a failed persist
 *  only costs a slightly-stale delta on the next open). */
export async function saveBriefedSnapshot(
  workspaceId: string,
  snapshot: BriefedSnapshot,
  dir?: string,
): Promise<void> {
  const file = loadFile(dir);
  file.snapshots[workspaceId] = snapshot;
  await atomicWriteJSON(getDeckBriefingPath(dir), file);
}
