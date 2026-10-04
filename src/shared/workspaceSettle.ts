// Workspace settle / snooze — the shared contract between main (which owns and
// decides the state, so it keeps working while the window is closed) and the
// renderer (which only displays it and sends the user's verbs).
//
// Visibility only: a settled or snoozed workspace is never closed, archived or
// killed. It just leaves the main sidebar list (and, when settled, the Fleet
// default view) until something happens in it.
//
// Naming: "settled" here means "this workspace's work is finished". It is
// unrelated to the sidebar's `useSettledOrder` / GLANCE_SETTLE_MS, where
// "settle" means "the list order has stopped moving".

/** Why a workspace is settled. */
export type WorkspaceSettleReason = 'idle' | 'pr' | 'manual';

/** One workspace's settle/snooze state. Absent fields = not settled / not snoozed. */
export interface WorkspaceSettleState {
  settled?: { at: number; reason: WorkspaceSettleReason };
  /** Epoch ms the snooze ends. */
  snoozedUntil?: number;
}

/** Only workspaces with a settled or snoozed state appear. */
export type WorkspaceSettleMap = Record<string, WorkspaceSettleState>;

export interface WorkspaceSettleSnapshot {
  states: WorkspaceSettleMap;
  /** Days without an agent turn or input before a workspace settles. */
  idleDays: number;
  /** The HQ workspace, which never settles or snoozes; null when none. */
  hqWorkspaceId: string | null;
}

export type WorkspaceSettleChangeKind = 'settled' | 'unsettled' | 'snoozed' | 'unsnoozed';

/**
 * What caused a change:
 *  - manual    the user's own verb (context menu)
 *  - idle | pr the automatic settle rules
 *  - activity  an agent turn, input, PR reopened or new commits
 *  - expired   the snooze time ran out
 *  - attention the workspace needs the user (awaiting input, approval, CI failure)
 *  - exempt    the workspace became pinned or the HQ
 *  - undo      an undo of an earlier change
 */
export type WorkspaceSettleCause =
  | 'manual'
  | 'idle'
  | 'pr'
  | 'activity'
  | 'expired'
  | 'attention'
  | 'exempt'
  | 'undo';

export interface WorkspaceSettleChange {
  /** Pass to `{ op: 'undo', changeId }` while `undoable`. */
  id: string;
  workspaceId: string;
  kind: WorkspaceSettleChangeKind;
  cause: WorkspaceSettleCause;
  /** True for the changes the renderer shows an Undo toast for. */
  undoable: boolean;
  at: number;
}

/** Main → renderer push (IPC.WORKSPACE_SETTLE_CHANGED). */
export interface WorkspaceSettleChangedPayload {
  snapshot: WorkspaceSettleSnapshot;
  changes: WorkspaceSettleChange[];
}

/** Renderer → main verbs (IPC.WORKSPACE_SETTLE_COMMAND). */
export type WorkspaceSettleCommand =
  | { op: 'settle'; workspaceId: string }
  | { op: 'unsettle'; workspaceId: string }
  | { op: 'snooze'; workspaceId: string; until: number }
  | { op: 'unsnooze'; workspaceId: string }
  | { op: 'undo'; changeId: string }
  | { op: 'setIdleDays'; days: number };

export type WorkspaceSettleCommandResult =
  | { ok: true; snapshot: WorkspaceSettleSnapshot }
  /** `refused`: the rules forbid it (a running, waiting or pinned workspace);
   *  `hq`: the HQ workspace always stays in view. */
  | { ok: false; error: 'invalid' | 'refused' | 'hq' | 'unknown-change' };

export const DEFAULT_WORKSPACE_IDLE_DAYS = 3;
export const MIN_WORKSPACE_IDLE_DAYS = 1;
export const MAX_WORKSPACE_IDLE_DAYS = 90;
/** How long an Undo toast (and the undo record behind it) lives. */
export const WORKSPACE_SETTLE_UNDO_MS = 5_000;

export function clampIdleDays(days: unknown): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return DEFAULT_WORKSPACE_IDLE_DAYS;
  return Math.min(MAX_WORKSPACE_IDLE_DAYS, Math.max(MIN_WORKSPACE_IDLE_DAYS, Math.round(days)));
}

// ─── Snooze presets ─────────────────────────────────────────────────────────

export type WorkspaceSnoozePreset = '1h' | 'tonight' | 'tomorrow' | 'nextWeek';
export const WORKSPACE_SNOOZE_PRESETS: readonly WorkspaceSnoozePreset[] = ['1h', 'tonight', 'tomorrow', 'nextWeek'];

/** Local hour "tonight" means; "tomorrow" and "next week" start at the morning hour. */
const TONIGHT_HOUR = 20;
const MORNING_HOUR = 9;

/**
 * When a snooze preset ends, in the local time zone of `now`. Returns null when
 * the preset makes no sense right now — "tonight" from TONIGHT_HOUR - 1 on,
 * where it would be under an hour away or already past.
 */
export function workspaceSnoozeUntil(preset: WorkspaceSnoozePreset, now: Date): number | null {
  const at = (dayOffset: number, hour: number): number =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, 0, 0, 0).getTime();
  switch (preset) {
    case '1h':
      return now.getTime() + 60 * 60 * 1000;
    case 'tonight':
      return now.getHours() >= TONIGHT_HOUR - 1 ? null : at(0, TONIGHT_HOUR);
    case 'tomorrow':
      return at(1, MORNING_HOUR);
    case 'nextWeek': {
      // The next Monday, never today: from a Monday that is a week out.
      const daysToMonday = ((8 - now.getDay()) % 7) || 7;
      return at(daysToMonday, MORNING_HOUR);
    }
  }
}
