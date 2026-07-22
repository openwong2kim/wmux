// WORKSPACE_MIRROR_PUSH handler — the renderer fire-and-forget push that keeps
// the main-process WorkspaceMirror warm (see WorkspaceMirror.ts). Registered
// with `ipcMain.on` (not `handle`) because it is one-way: the renderer never
// awaits a reply, it just streams the latest full snapshot on structural / status
// change.
//
// Trust basis: the renderer is a first-party surface (same process boundary as
// deck/fanout handlers), so the payload is renderer-trusted. We still
// format-check it defensively — a stale preload, a partial test mock, or a
// renderer mid-teardown could send something malformed, and a bad snapshot must
// be DROPPED (leaving the last-good one in place), never stored or thrown.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { getWorkspaceMirror } from '../../workspace/WorkspaceMirror';
import type {
  WorkspaceListEntry,
  FleetSnapshot,
  FleetSnapshotPane,
  WorkspaceMirrorPushPayload,
} from '../../../shared/workspaceMirror';
import type { AgentStatus } from '../../../shared/types';

// Ids key maps / route hooks — reject anything that isn't a plausible id token
// (mirrors deck.handler.ts WORKSPACE_ID_RE). Applied to workspace ids and, more
// loosely, to pty ids below.
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
// PTY ids are daemon session ids — a superset alphabet, but still bounded and
// character-restricted so a malformed id can never become a routing key.
const PTY_ID_RE = /^[A-Za-z0-9._:@/-]{1,120}$/;

// The renderer fleet selector's status union — accept only these so a bad status
// string can't leak into a routing consumer. Kept in sync with AgentStatus.
const VALID_AGENT_STATUS: ReadonlySet<string> = new Set<AgentStatus>([
  'running',
  'complete',
  'error',
  'idle',
  'waiting',
  'awaiting_input',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate + normalize one workspace entry. Returns null to drop a bad entry. */
function parseEntry(raw: unknown): WorkspaceListEntry | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  const name = raw.name;
  if (typeof id !== 'string' || !WORKSPACE_ID_RE.test(id)) return null;
  if (typeof name !== 'string') return null;

  const entry: WorkspaceListEntry = { id, name };

  if (isRecord(raw.metadata)) {
    const m = raw.metadata;
    entry.metadata = {
      cwd: typeof m.cwd === 'string' ? m.cwd : null,
      gitBranch: typeof m.gitBranch === 'string' ? m.gitBranch : null,
      agentName: typeof m.agentName === 'string' ? m.agentName : null,
      agentStatus: typeof m.agentStatus === 'string' ? m.agentStatus : null,
      status: typeof m.status === 'string' ? m.status : null,
      progress: typeof m.progress === 'number' ? m.progress : null,
    };
  }

  if (typeof raw.activePtyId === 'string' && PTY_ID_RE.test(raw.activePtyId)) {
    entry.activePtyId = raw.activePtyId;
  } else {
    entry.activePtyId = null;
  }

  if (Array.isArray(raw.ptyIds)) {
    entry.ptyIds = raw.ptyIds.filter(
      (p): p is string => typeof p === 'string' && PTY_ID_RE.test(p),
    );
  }

  return entry;
}

/** Validate + normalize one fleet-snapshot pane. Returns null to drop it. */
function parsePane(raw: unknown): FleetSnapshotPane | null {
  if (!isRecord(raw)) return null;
  // An unspawned surface reports ptyId '' — allowed (empty string is a valid,
  // if unroutable, pane), so only reject a non-string.
  const ptyId = raw.ptyId;
  if (typeof ptyId !== 'string') return null;
  if (ptyId !== '' && !PTY_ID_RE.test(ptyId)) return null;
  const agentStatus = raw.agentStatus;
  if (typeof agentStatus !== 'string' || !VALID_AGENT_STATUS.has(agentStatus)) return null;

  const pane: FleetSnapshotPane = {
    ptyId,
    agentName: typeof raw.agentName === 'string' ? raw.agentName : null,
    agentStatus: agentStatus as AgentStatus,
    isActivePane: raw.isActivePane === true,
  };
  if (typeof raw.cwd === 'string') pane.cwd = raw.cwd;
  return pane;
}

/** Validate one per-workspace fleet snapshot. Returns null to drop it. */
function parseFleet(raw: unknown): FleetSnapshot | null {
  if (!isRecord(raw)) return null;
  const workspaceId = raw.workspaceId;
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) return null;
  const ts = typeof raw.ts === 'number' ? raw.ts : 0;
  const panesRaw = Array.isArray(raw.panes) ? raw.panes : [];
  const panes = panesRaw
    .map(parsePane)
    .filter((p): p is FleetSnapshotPane => p !== null);
  return { workspaceId, ts, panes };
}

/**
 * Parse the full push payload. Returns null when it is unusable (not an object /
 * missing entries array) so the caller drops it and keeps the last-good
 * snapshot. Individual malformed entries/panes are filtered, not fatal.
 */
export function parseWorkspaceMirrorPayload(raw: unknown): WorkspaceMirrorPushPayload | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.fleets)) return null;
  const entries = raw.entries
    .map(parseEntry)
    .filter((e): e is WorkspaceListEntry => e !== null);
  const fleets = raw.fleets
    .map(parseFleet)
    .filter((f): f is FleetSnapshot => f !== null);
  const ts = typeof raw.ts === 'number' ? raw.ts : 0;
  return { ts, entries, fleets };
}

/**
 * Register the fire-and-forget WORKSPACE_MIRROR_PUSH listener. Idempotent
 * (removeAllListeners first) so an HMR reload / re-registration never
 * double-stores. Returns a disposer for symmetric teardown.
 */
export function registerWorkspaceMirrorHandler(): () => void {
  const onPush = (_event: Electron.IpcMainEvent, raw: unknown): void => {
    const payload = parseWorkspaceMirrorPayload(raw);
    // Drop a structurally-unusable push — never overwrite last-good with junk.
    if (!payload) return;
    getWorkspaceMirror().setSnapshot(payload);
  };
  ipcMain.removeAllListeners(IPC.WORKSPACE_MIRROR_PUSH);
  ipcMain.on(IPC.WORKSPACE_MIRROR_PUSH, onPush);

  return () => {
    ipcMain.removeAllListeners(IPC.WORKSPACE_MIRROR_PUSH);
  };
}
