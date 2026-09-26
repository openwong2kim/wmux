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
  /**
   * The desktop draws this task indented under its owner — straight from
   * `buildSidebarTree`, so false for a detached task, a task whose owner is
   * closed, and a task whose owner is itself a nested task (depth-1 only).
   */
  nested: boolean;
  /**
   * The per-task bits the owner's rollup line counts, present only on a nested
   * task. Internal to the desktop → daemon hop: the daemon folds them into the
   * owner's `taskSummary` over the rows it actually lists, so the summary
   * counts exactly the tasks the phone shows nested.
   */
  state?: PhoneSidebarTaskState;
}

export interface PhoneSidebarTaskState {
  /** The task's agent is waiting on the user. */
  needYou: boolean;
  /** Open task whose every agent pane reported complete (Fleet's "Ready to review"). */
  toReview: boolean;
  /** Every agent pane reported complete, regardless of the task record. */
  finished: boolean;
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
  /** Position in the desktop's manual (unsorted, unfiltered) workspace list.
   *  Pinned rows lead that list, so they carry the lowest values. */
  order: number;
  /** Pinned to the top of the desktop sidebar. */
  pinned: boolean;
  color?: WorkspaceColorId;
  gitBranch?: string;
  gitIsWorktree?: boolean;
  gitSync?: { ahead: number; behind: number; hasUpstream: boolean };
  task?: PhoneSidebarTaskLink;
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

/**
 * Characters no sidebar string may carry across a boundary. A tab title is set
 * by whatever runs in the pane (OSC 0/2), so it is untrusted text that ends up
 * in a phone UI:
 *   - line and format breakers: C0, DEL, C1 (including NEL, U+0085), and the
 *     Unicode line / paragraph separators U+2028 / U+2029;
 *   - bidi controls that can reorder what is displayed: the embeddings and
 *     overrides U+202A–U+202E, the isolates U+2066–U+2069, and the implicit
 *     marks U+200E / U+200F / U+061C.
 * The renderer strips them (`clampSidebarString`); every parser refuses a
 * string that still carries one, so the rule is the same at each hop.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/;
// eslint-disable-next-line no-control-regex
const LINE_BREAKERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

/** True when a string carries any character `UNSAFE_TEXT` names. */
export function hasUnsafeSidebarText(value: string): boolean {
  return UNSAFE_TEXT.test(value);
}
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A bounded, single-line, non-empty string, or undefined. */
function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > max || UNSAFE_TEXT.test(value)) return undefined;
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

function parseTaskState(value: unknown): PhoneSidebarTaskState | undefined {
  if (!isRecord(value)) return undefined;
  const { needYou, toReview, finished } = value;
  if (typeof needYou !== 'boolean' || typeof toReview !== 'boolean' || typeof finished !== 'boolean') return undefined;
  return { needYou, toReview, finished };
}

/** Receives why an item was dropped — a fixed reason tag, never the value. */
export type SidebarDropReporter = (reason: string) => void;

function parseTask(value: unknown, drop: SidebarDropReporter): PhoneSidebarTaskLink | undefined {
  if (!isRecord(value) || typeof value.detached !== 'boolean' || typeof value.nested !== 'boolean') return undefined;
  let ownerWorkspaceId: string | null;
  if (value.ownerWorkspaceId === null) ownerWorkspaceId = null;
  else {
    const owner = idString(value.ownerWorkspaceId);
    if (owner === undefined) return undefined;
    ownerWorkspaceId = owner;
  }
  const createdAt = timestamp(value.createdAt);
  // A nested task needs an owner to sit under; the state bits ride only there.
  const nested = value.nested && ownerWorkspaceId !== null;
  const state = nested ? parseTaskState(value.state) : undefined;
  if (nested && value.state !== undefined && !state) drop('workspace.task.state');
  return {
    ownerWorkspaceId,
    detached: value.detached,
    ...(createdAt !== undefined ? { createdAt } : {}),
    nested,
    ...(state ? { state } : {}),
  };
}

function parseGitSync(value: unknown): PhoneSidebarWorkspace['gitSync'] {
  if (!isRecord(value) || typeof value.hasUpstream !== 'boolean') return undefined;
  const ahead = count(value.ahead);
  const behind = count(value.behind);
  if (ahead === undefined || behind === undefined) return undefined;
  return { ahead, behind, hasUpstream: value.hasUpstream };
}

function parseWorkspace(value: unknown, drop: SidebarDropReporter): PhoneSidebarWorkspace | null {
  if (!isRecord(value)) return null;
  const id = idString(value.id);
  const order = count(value.order);
  if (id === undefined || order === undefined || typeof value.pinned !== 'boolean') return null;
  const row: PhoneSidebarWorkspace = { id, order, pinned: value.pinned };
  // An optional field that is present but invalid is dropped on its own and
  // reported; the row stays.
  if (isColorId(value.color)) row.color = value.color;
  else if (value.color !== undefined) drop('workspace.color');
  const gitBranch = boundedString(value.gitBranch, PHONE_SIDEBAR_LIMITS.gitBranch);
  if (gitBranch !== undefined) row.gitBranch = gitBranch;
  else if (value.gitBranch !== undefined) drop('workspace.gitBranch');
  if (typeof value.gitIsWorktree === 'boolean') row.gitIsWorktree = value.gitIsWorktree;
  else if (value.gitIsWorktree !== undefined) drop('workspace.gitIsWorktree');
  const gitSync = parseGitSync(value.gitSync);
  if (gitSync) row.gitSync = gitSync;
  else if (value.gitSync !== undefined) drop('workspace.gitSync');
  const task = parseTask(value.task, drop);
  if (task) row.task = task;
  else if (value.task !== undefined) drop('workspace.task');
  return row;
}

function parsePane(value: unknown, drop: SidebarDropReporter): PhoneSidebarPane | null {
  if (!isRecord(value)) return null;
  const ptyId = idString(value.ptyId);
  const workspaceId = idString(value.workspaceId);
  if (ptyId === undefined || workspaceId === undefined) return null;
  const row: PhoneSidebarPane = { ptyId, workspaceId };
  const surfaceTitle = boundedString(value.surfaceTitle, PHONE_SIDEBAR_LIMITS.surfaceTitle);
  if (surfaceTitle !== undefined) row.surfaceTitle = surfaceTitle;
  else if (value.surfaceTitle !== undefined) drop('pane.surfaceTitle');
  const paneName = boundedString(value.paneName, PHONE_SIDEBAR_LIMITS.paneName);
  if (paneName !== undefined) row.paneName = paneName;
  else if (value.paneName !== undefined) drop('pane.paneName');
  return row;
}

/**
 * Strict parse of a sidebar snapshot. Null when the envelope itself is not
 * one (absent, wrong type, a renderer error object); otherwise every row and
 * field that survives the allowlist, deduplicated by id (first wins). A bad
 * row or field never costs more than itself: it is dropped alone, and
 * `onDrop` hears a reason tag for it (never the value — a title is pane
 * output and does not belong in a log).
 */
export function parsePhoneSidebarSnapshot(value: unknown, onDrop?: SidebarDropReporter): PhoneSidebarSnapshot | null {
  const drop: SidebarDropReporter = onDrop ?? (() => undefined);
  if (!isRecord(value) || !Array.isArray(value.workspaces) || !Array.isArray(value.panes)) return null;
  const workspaces: PhoneSidebarWorkspace[] = [];
  const seenWorkspaces = new Set<string>();
  for (const raw of value.workspaces) {
    if (workspaces.length >= PHONE_SIDEBAR_LIMITS.workspaces) { drop('workspace.overLimit'); break; }
    const row = parseWorkspace(raw, drop);
    if (!row) { drop('workspace.row'); continue; }
    if (seenWorkspaces.has(row.id)) { drop('workspace.duplicate'); continue; }
    seenWorkspaces.add(row.id);
    workspaces.push(row);
  }
  const panes: PhoneSidebarPane[] = [];
  const seenPanes = new Set<string>();
  for (const raw of value.panes) {
    if (panes.length >= PHONE_SIDEBAR_LIMITS.panes) { drop('pane.overLimit'); break; }
    const row = parsePane(raw, drop);
    if (!row) { drop('pane.row'); continue; }
    if (seenPanes.has(row.ptyId)) { drop('pane.duplicate'); continue; }
    seenPanes.add(row.ptyId);
    panes.push(row);
  }
  let activeWorkspaceId: string | null = null;
  if (value.activeWorkspaceId !== null && value.activeWorkspaceId !== undefined) {
    activeWorkspaceId = idString(value.activeWorkspaceId) ?? null;
    if (activeWorkspaceId === null) drop('activeWorkspaceId');
  }
  return { activeWorkspaceId, workspaces, panes };
}

/**
 * Collects drop reasons over one parse and renders them as one log line body
 * (`workspace.task×2, pane.surfaceTitle×1`), sorted so the same problem
 * always reads the same — callers log only when the line changes.
 */
export function createSidebarDropLog(): { report: SidebarDropReporter; summary: () => string } {
  const counts = new Map<string, number>();
  return {
    report: (reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1),
    summary: () => [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, n]) => `${reason}×${n}`).join(', '),
  };
}

/**
 * Cut a display string to the bound without splitting a surrogate pair, strip
 * the characters `UNSAFE_TEXT` names, and flatten it to one line. Undefined
 * when nothing readable is left. Its output always passes the parsers.
 */
export function clampSidebarString(value: string | undefined | null, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Bidi controls are removed outright (they draw nothing); anything that
  // breaks a line becomes one space.
  let out = value.replace(BIDI_CONTROLS, '').replace(LINE_BREAKERS, ' ').trim();
  if (out.length > max) {
    out = out.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The nesting and owner rollups as the phone can draw them, over the rows the
 * daemon actually lists (`listedIds`). A task is nested iff the desktop nests
 * it AND its owner is a listed row — the desktop may nest under an owner the
 * phone cannot show (one with no live pane). Each owner's summary counts
 * exactly its tasks that come out nested here, so the rollup line and the rows
 * under it can never disagree.
 */
export function phoneTaskNesting(
  workspaces: readonly PhoneSidebarWorkspace[],
  listedIds: ReadonlySet<string>,
): { nested: Map<string, boolean>; summaries: Map<string, PhoneSidebarTaskSummary> } {
  const nested = new Map<string, boolean>();
  const summaries = new Map<string, PhoneSidebarTaskSummary>();
  for (const row of workspaces) {
    const task = row.task;
    if (!task || !listedIds.has(row.id)) continue;
    const owner = task.ownerWorkspaceId;
    const isNested = task.nested && owner !== null && owner !== row.id && listedIds.has(owner);
    nested.set(row.id, isNested);
    if (!isNested || owner === null) continue;
    const summary = summaries.get(owner) ?? { tasks: 0, needYou: 0, toReview: 0, finished: 0 };
    summary.tasks += 1;
    if (task.state?.needYou) summary.needYou += 1;
    if (task.state?.toReview) summary.toReview += 1;
    if (task.state?.finished) summary.finished += 1;
    summaries.set(owner, summary);
  }
  return { nested, summaries };
}
