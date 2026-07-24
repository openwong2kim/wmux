// ─── Command Deck — briefing config + last-viewed snapshot store ─────────────
//
// Holds the two "welcome home" briefing knobs (enabled / autoShow) AND the
// per-workspace last-VIEWED status snapshot the builder diffs against. Same
// storage shape and never-throw posture as deckHeartbeatStore (atomic JSON in
// the wmux data dir, WMUX_DATA_SUFFIX isolated) — config and snapshots share ONE
// file so a partial write of either preserves the other.
//
// The snapshot is written when the operator actually SEES the briefing (the
// acknowledge handler, NOT the get handler), so the next open diffs against
// "what you last saw", not "what main last pushed" and not "what the card
// happened to fetch while collapsed". Status-only per pane (ptyId→status +
// decisionId) keeps the file tiny even at 30+ sessions.
//
// Every mutation runs through ONE per-process promise chain (the
// deckDecisionStore precedent): loadFile is sync but `await atomicWriteJSON` is
// an async boundary, so two unserialized read-modify-writes could each start
// from the same snapshot and the later write would silently revert the earlier
// one — losing a workspace's snapshot or, worse, reverting the operator's
// Settings toggle. atomicWriteJSON prevents torn reads, not lost updates.

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

// Single-writer serialization for every mutation of this file — config saves and
// snapshot saves share one chain, because they share one file: an unserialized
// snapshot save that read the file before a Settings toggle landed would write
// the OLD config back and silently re-enable a briefing the operator turned off.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  // Keep the chain alive even if a write rejects (never wedge future mutates).
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The current briefing config. Never throws (fail-open to the default). */
export function loadDeckBriefingConfig(dir?: string): DeckBriefingConfig {
  return loadFile(dir).config;
}

/**
 * Chain-ordered reads. The sync loaders above see the file as it is on DISK, so
 * a read issued while an acknowledge write is still queued computes from
 * pre-write state — the briefing then reports a delta the operator already
 * consumed until the next refresh corrects it. No data is lost either way, but
 * a deterministic feature should not depend on which promise ticks first, and
 * joining the chain costs only the in-flight write (one atomic JSON write).
 */
export function readDeckBriefingConfig(dir?: string): Promise<DeckBriefingConfig> {
  return serialize(async () => loadDeckBriefingConfig(dir));
}

export function readBriefedSnapshot(
  workspaceId: string,
  dir?: string,
): Promise<BriefedSnapshot | null> {
  return serialize(async () => loadBriefedSnapshot(workspaceId, dir));
}

/** Persist a config patch, merging over the current value (a partial update
 *  keeps the other field) and preserving all stored snapshots. Returns the
 *  config now in force. */
export async function saveDeckBriefingConfig(
  patch: Partial<DeckBriefingConfig>,
  dir?: string,
): Promise<DeckBriefingConfig> {
  return serialize(async () => {
    const file = loadFile(dir);
    const next: DeckBriefingConfig = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : file.config.enabled,
      autoShow: typeof patch.autoShow === 'boolean' ? patch.autoShow : file.config.autoShow,
    };
    await atomicWriteJSON(getDeckBriefingPath(dir), { config: next, snapshots: file.snapshots });
    return next;
  });
}

/** The last-viewed snapshot for a workspace, or null if none was ever stored. */
export function loadBriefedSnapshot(workspaceId: string, dir?: string): BriefedSnapshot | null {
  return loadFile(dir).snapshots[workspaceId] ?? null;
}

/** How long an untouched snapshot survives. A workspace nobody has briefed in a
 *  month is either gone or so stale its delta would be meaningless, and this map
 *  is read synchronously on every briefing GET — it must not grow forever. */
export const BRIEFED_SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Drop snapshots for workspaces that no longer exist (`liveWorkspaceIds`, when
 *  the caller can supply a trustworthy list) and any that aged past the TTL.
 *  `liveWorkspaceIds` is IGNORED when empty — an unpopulated mirror must not be
 *  read as "every workspace was deleted". */
function pruneSnapshots(
  snapshots: Record<string, BriefedSnapshot>,
  liveWorkspaceIds: readonly string[] | undefined,
  now: number,
): void {
  const live = liveWorkspaceIds && liveWorkspaceIds.length > 0 ? new Set(liveWorkspaceIds) : null;
  for (const [wsId, snap] of Object.entries(snapshots)) {
    if (live && !live.has(wsId)) {
      delete snapshots[wsId];
      continue;
    }
    if (snap.at > 0 && now - snap.at > BRIEFED_SNAPSHOT_TTL_MS) delete snapshots[wsId];
  }
}

/** Whether two baselines describe the SAME observed state — same pending
 *  decision and the same ptyId→status map. `at` is deliberately excluded: it is
 *  the write clock, not part of what the operator saw. */
function sameBriefedState(prev: BriefedSnapshot | undefined, next: BriefedSnapshot): boolean {
  if (!prev) return false;
  if (prev.decisionId !== next.decisionId) return false;
  if (prev.panes.length !== next.panes.length) return false;
  const before = new Map(prev.panes.map((p) => [p.ptyId, p.agentStatus]));
  return next.panes.every((p) => before.get(p.ptyId) === p.agentStatus);
}

/** Persist one workspace's last-viewed snapshot, preserving config + the other
 *  workspaces' snapshots. Fire-and-forget from the handler (a failed persist
 *  only costs a slightly-stale delta on the next open).
 *
 *  Returns whether anything was written. The acknowledge path fires on EVERY
 *  briefing the operator genuinely sees — it has to, or a workspace that goes
 *  blocked → running → blocked never re-baselines and the second block reads as
 *  old news — so the "don't hammer the disk on a no-news refresh" property is
 *  enforced HERE instead: an acknowledge whose snapshot matches what is already
 *  stored costs no IO. The stored `at` therefore only advances when the state
 *  did, which is fine for the 30-day TTL (a workspace nobody's fleet changed in
 *  a month re-seeds its baseline on the next view). */
export async function saveBriefedSnapshot(
  workspaceId: string,
  snapshot: BriefedSnapshot,
  dir?: string,
  opts?: { liveWorkspaceIds?: readonly string[]; now?: number },
): Promise<boolean> {
  return serialize(async () => {
    const file = loadFile(dir);
    if (sameBriefedState(file.snapshots[workspaceId], snapshot)) return false;
    pruneSnapshots(file.snapshots, opts?.liveWorkspaceIds, opts?.now ?? Date.now());
    file.snapshots[workspaceId] = snapshot;
    await atomicWriteJSON(getDeckBriefingPath(dir), file);
    return true;
  });
}
