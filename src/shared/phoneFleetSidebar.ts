// Desktop sidebar fields for the phone Fleet (read-only, additive).
//
// The renderer owns the sidebar's view of each workspace — manual order, pin,
// color tag, git badge, fan-out task link — and of each pane — its tab title
// and its display name. None of it exists in the daemon. The phone asks the
// daemon, the daemon asks the desktop over the named `workspaces.list`
// request, main asks the renderer for `workspace.phoneSidebar`, and the reply
// crosses two process boundaries on the way back.
//
// This module is the single allowlist for that reply. Main parses what the
// renderer produced and the daemon parses what main forwarded, with the same
// function: every field is typed and bounded, a malformed optional field is
// dropped on its own, a row without a valid id is dropped whole, and a key
// that is not listed here never survives a parse.

import { WORKSPACE_COLOR_IDS, type WorkspaceColorId } from './workspaceColors';

/** Row and string bounds. The renderer truncates to them; parsers enforce them. */
export const PHONE_SIDEBAR_LIMITS = {
  workspaces: 256,
  panes: 512,
  id: 128,
  surfaceTitle: 100,
  paneName: 64,
  gitBranch: 200,
  /** Upper bound for counts and ahead/behind; anything larger is not a real value. */
  count: 1_000_000,
} as const;

export interface PhoneSidebarTaskLink {
  /** Null when no source names an owner (the desktop's "From closed workspace" case). */
  ownerWorkspaceId: string | null;
  detached: boolean;
  /** Epoch ms: the fan-out audit record's time, else the task record's creation time. */
  createdAt?: number;
}

export interface PhoneSidebarTaskSummary {
  /** Tasks nested under this workspace in the desktop sidebar. */
  tasks: number;
  /** Tasks whose agent is waiting on the user. */
  needYou: number;
  /** Open tasks whose every agent pane reported complete (Fleet's "Ready to review"). */
  toReview: number;
  /** Tasks whose every agent pane reported complete, regardless of the record. */
  finished: number;
}

export interface PhoneSidebarWorkspace {
  id: string;
  /** Position in the desktop's manual (unsorted, unfiltered) workspace list. */
  order: number;
  pinned: boolean;
  color?: WorkspaceColorId;
  gitBranch?: string;
  gitIsWorktree?: boolean;
  gitSync?: { ahead: number; behind: number; hasUpstream: boolean };
  task?: PhoneSidebarTaskLink;
  taskSummary?: PhoneSidebarTaskSummary;
}

export interface PhoneSidebarPane {
  ptyId: string;
  workspaceId: string;
  surfaceTitle?: string;
  paneName?: string;
}

export interface PhoneSidebarSnapshot {
  activeWorkspaceId: string | null;
  workspaces: PhoneSidebarWorkspace[];
  panes: PhoneSidebarPane[];
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A bounded, single-line, non-empty string, or undefined. */
function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > max || CONTROL_CHARS.test(value)) return undefined;
  if (value.trim() !== value || value.trim().length === 0) return undefined;
  return value;
}

function idString(value: unknown): string | undefined {
  const id = boundedString(value, PHONE_SIDEBAR_LIMITS.id);
  return id !== undefined && !RESERVED_KEYS.has(id) ? id : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= PHONE_SIDEBAR_LIMITS.count
    ? value
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isColorId(value: unknown): value is WorkspaceColorId {
  return typeof value === 'string' && (WORKSPACE_COLOR_IDS as readonly string[]).includes(value);
}

function parseTask(value: unknown): PhoneSidebarTaskLink | undefined {
  if (!isRecord(value) || typeof value.detached !== 'boolean') return undefined;
  let ownerWorkspaceId: string | null;
  if (value.ownerWorkspaceId === null) ownerWorkspaceId = null;
  else {
    const owner = idString(value.ownerWorkspaceId);
    if (owner === undefined) return undefined;
    ownerWorkspaceId = owner;
  }
  const createdAt = timestamp(value.createdAt);
  return { ownerWorkspaceId, detached: value.detached, ...(createdAt !== undefined ? { createdAt } : {}) };
}

function parseTaskSummary(value: unknown): PhoneSidebarTaskSummary | undefined {
  if (!isRecord(value)) return undefined;
  const tasks = count(value.tasks);
  const needYou = count(value.needYou);
  const toReview = count(value.toReview);
  const finished = count(value.finished);
  if (tasks === undefined || needYou === undefined || toReview === undefined || finished === undefined) return undefined;
  if (tasks === 0 || needYou > tasks || toReview > tasks || finished > tasks) return undefined;
  return { tasks, needYou, toReview, finished };
}

function parseGitSync(value: unknown): PhoneSidebarWorkspace['gitSync'] {
  if (!isRecord(value) || typeof value.hasUpstream !== 'boolean') return undefined;
  const ahead = count(value.ahead);
  const behind = count(value.behind);
  if (ahead === undefined || behind === undefined) return undefined;
  return { ahead, behind, hasUpstream: value.hasUpstream };
}

function parseWorkspace(value: unknown): PhoneSidebarWorkspace | null {
  if (!isRecord(value)) return null;
  const id = idString(value.id);
  const order = count(value.order);
  if (id === undefined || order === undefined || typeof value.pinned !== 'boolean') return null;
  const row: PhoneSidebarWorkspace = { id, order, pinned: value.pinned };
  if (isColorId(value.color)) row.color = value.color;
  const gitBranch = boundedString(value.gitBranch, PHONE_SIDEBAR_LIMITS.gitBranch);
  if (gitBranch !== undefined) row.gitBranch = gitBranch;
  if (typeof value.gitIsWorktree === 'boolean') row.gitIsWorktree = value.gitIsWorktree;
  const gitSync = parseGitSync(value.gitSync);
  if (gitSync) row.gitSync = gitSync;
  const task = parseTask(value.task);
  if (task) row.task = task;
  const taskSummary = parseTaskSummary(value.taskSummary);
  if (taskSummary) row.taskSummary = taskSummary;
  return row;
}

function parsePane(value: unknown): PhoneSidebarPane | null {
  if (!isRecord(value)) return null;
  const ptyId = idString(value.ptyId);
  const workspaceId = idString(value.workspaceId);
  if (ptyId === undefined || workspaceId === undefined) return null;
  const row: PhoneSidebarPane = { ptyId, workspaceId };
  const surfaceTitle = boundedString(value.surfaceTitle, PHONE_SIDEBAR_LIMITS.surfaceTitle);
  if (surfaceTitle !== undefined) row.surfaceTitle = surfaceTitle;
  const paneName = boundedString(value.paneName, PHONE_SIDEBAR_LIMITS.paneName);
  if (paneName !== undefined) row.paneName = paneName;
  return row;
}

/**
 * Strict parse of a sidebar snapshot. Null when the envelope itself is not
 * one (absent, wrong type, a renderer error object); otherwise every row and
 * field that survives the allowlist, deduplicated by id (first wins).
 */
export function parsePhoneSidebarSnapshot(value: unknown): PhoneSidebarSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.workspaces) || !Array.isArray(value.panes)) return null;
  const workspaces: PhoneSidebarWorkspace[] = [];
  const seenWorkspaces = new Set<string>();
  for (const raw of value.workspaces) {
    if (workspaces.length >= PHONE_SIDEBAR_LIMITS.workspaces) break;
    const row = parseWorkspace(raw);
    if (!row || seenWorkspaces.has(row.id)) continue;
    seenWorkspaces.add(row.id);
    workspaces.push(row);
  }
  const panes: PhoneSidebarPane[] = [];
  const seenPanes = new Set<string>();
  for (const raw of value.panes) {
    if (panes.length >= PHONE_SIDEBAR_LIMITS.panes) break;
    const row = parsePane(raw);
    if (!row || seenPanes.has(row.ptyId)) continue;
    seenPanes.add(row.ptyId);
    panes.push(row);
  }
  const activeWorkspaceId = idString(value.activeWorkspaceId) ?? null;
  return { activeWorkspaceId, workspaces, panes };
}

/**
 * Cut a display string to the bound without splitting a surrogate pair, and
 * flatten it to one line. Undefined when nothing readable is left.
 */
export function clampSidebarString(value: string | undefined | null, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  let out = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (out.length > max) {
    out = out.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out.length > 0 ? out : undefined;
}
