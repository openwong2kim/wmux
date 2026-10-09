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
  /** A pending hand-off notice (`PhoneSidebarWorkspace.moaHandoff`). */
  moaHandoffTitle: 80,
  moaHandoffAgentName: 64,
  /** Moa's delegated jobs (`PhoneSidebarSnapshot.moaDelegations`). */
  moaDelegations: 20,
  moaDelegationTitle: 80,
  moaDelegationAgentName: 64,
  /** Upper bound for counts and ahead/behind; anything larger is not a real value. */
  count: 1_000_000,
  /**
   * Per-workspace split tree (`PhoneSidebarWorkspace.layout`). A tree over any
   * bound is not projected (producer) and not accepted (parsers); the flat
   * `panes` list still carries every session.
   */
  layout: {
    /** Nesting depth, the root counting as 1. */
    depth: 16,
    /** Splits plus leaves. */
    nodes: 512,
    leaves: 64,
    /** Children of one split. */
    children: 64,
    surfacesPerLeaf: 64,
    /** Surfaces over the whole tree. */
    surfaces: 512,
  },
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
  /**
   * Where inside the owner the desktop files this nested task (#1581's
   * per-pane split): under the owner's pane that requested it, or in the
   * owner's trailing "From closed pane" group. Present only on a nested task.
   */
  paneGroup?: PhoneSidebarPaneGroup;
  /** Desktop pane id of the requesting pane; present iff `paneGroup` is 'pane'. */
  requesterPaneId?: string;
}

export type PhoneSidebarPaneGroup = 'pane' | 'closedPane';

/** Where the phone draws a nested task, as `/api/workspaces` states it. */
export type PhoneTaskNestedUnder = 'pane' | 'closedPane';

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
  /** The workspace's visible split tree; absent when not projected or cut for size. */
  layout?: PhoneSidebarLayout;
  /**
   * A hand-off Moa proposed is waiting in this workspace's decision slot.
   * Read-only notice: never the body, never anything that answers the card.
   * Absent when no hand-off card is pending (or it was cut for size).
   */
  moaHandoff?: PhoneSidebarMoaHandoff;
}

export interface PhoneSidebarMoaHandoff {
  /** The target agent's display name. */
  agentName: string;
  /** The body's first line, single-line and bounded. */
  title: string;
  /** Epoch ms the card was raised. */
  raisedAt: number;
}

/** A delegated job's state as the phone sees it. */
export const PHONE_MOA_DELEGATION_STATES = ['working', 'blocked', 'done', 'failed'] as const;
export type PhoneMoaDelegationState = (typeof PHONE_MOA_DELEGATION_STATES)[number];

/** How long a finished (done / failed) delegation stays listed. */
export const PHONE_MOA_DELEGATION_RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * One job Moa handed to an agent: the desktop Fleet's ticket for it, reduced
 * to what the phone may show. Never the request, the result or a transcript.
 */
export interface PhoneMoaDelegation {
  /** The A2A task carrying the job. */
  taskId: string;
  /** The workspace doing the work; it may since have been closed. */
  workspaceId: string;
  /** The receiving agent's display name. */
  agentName: string;
  /** The job's title, single-line and bounded. */
  title: string;
  state: PhoneMoaDelegationState;
  /** Epoch ms the job last changed on the desktop's record. */
  since: number;
}

/**
 * Surface kinds the phone may see: the desktop's surface types, plus 'other'
 * for anything newer. A parser maps an unknown kind to 'other' rather than
 * refusing the tree, so an older reader still draws the tab.
 */
export const PHONE_LAYOUT_SURFACE_KINDS = ['terminal', 'browser', 'editor', 'diff', 'git', 'review', 'remote-terminal', 'other'] as const;
export type PhoneLayoutSurfaceKind = (typeof PHONE_LAYOUT_SURFACE_KINDS)[number];

/**
 * One tab of a pane. A terminal tab carries its session id only (its title is
 * already `panes[].surfaceTitle`); any other tab carries its clamped title
 * only. A terminal without `ptyId` is a slot with no listable session (still
 * spawning, or the orchestrator brain) — kept so tab order and `activeIndex`
 * stay the desktop's.
 */
export interface PhoneLayoutSurface {
  /** Desktop surface id: stable across polls while the tab exists, unique in the tree. */
  surfaceId: string;
  kind: PhoneLayoutSurfaceKind;
  ptyId?: string;
  title?: string;
}

export interface PhoneLayoutLeaf {
  kind: 'leaf';
  /** Desktop pane id, the same value `panes[].paneId` carries. */
  paneId: string;
  /** Tabs in the desktop's order. */
  surfaces: PhoneLayoutSurface[];
  /** Index into `surfaces` of the tab the pane shows; present iff `surfaces` is non-empty. */
  activeIndex?: number;
}

export interface PhoneLayoutSplit {
  kind: 'split';
  /** The desktop's own word: 'horizontal' lays the children side by side. */
  direction: 'horizontal' | 'vertical';
  /** One share per child, in percent: finite, > 0, summing to 100 within rounding. */
  sizes: number[];
  children: PhoneLayoutNode[];
}

export type PhoneLayoutNode = PhoneLayoutLeaf | PhoneLayoutSplit;

export interface PhoneSidebarLayout {
  root: PhoneLayoutNode;
  /** The workspace's focused pane, present only when it is a leaf of `root`. */
  activePaneId?: string;
}

export interface PhoneSidebarPane {
  ptyId: string;
  workspaceId: string;
  /** Desktop pane id of the pane holding this surface (stable across PTY rebinds). */
  paneId?: string;
  surfaceTitle?: string;
  paneName?: string;
}

export interface PhoneSidebarSnapshot {
  activeWorkspaceId: string | null;
  workspaces: PhoneSidebarWorkspace[];
  panes: PhoneSidebarPane[];
  /**
   * The Moa HQ workspace's id, whenever the desktop has one designated —
   * whether or not Moa is on, because the desktop keeps that workspace out of
   * its list either way. One id for the whole snapshot, so at most one
   * workspace can ever be marked; the daemon stamps `role: "hq"` from it.
   */
  hqWorkspaceId?: string;
  /** Moa is on and its HQ workspace exists. Absent otherwise. */
  moa?: true;
  /**
   * Why a wake of Moa from the phone would be refused right now, though Moa is
   * on: `'moa-mode-off'` while the HQ workspace's agent mode is off (main
   * refuses every brain turn there). Only beside `moa`. Absent when nothing
   * blocks a wake, when the mode could not be read, and from an older desktop
   * — all of which leave the daemon advertising `moaWake` as before.
   */
  moaWakeBlocked?: 'moa-mode-off';
  /**
   * Moa's delegated jobs, newest first: every open one plus those that ended
   * within PHONE_MOA_DELEGATION_RECENT_MS, at most `moaDelegations`. Present
   * (possibly empty) whenever the desktop computed it; absent from an older
   * desktop, on a failed read, or when cut for size.
   */
  moaDelegations?: PhoneMoaDelegation[];
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

/** True when the parsers accept `value` as an id; the producer checks with this. */
export function isSidebarId(value: unknown): value is string {
  return idString(value) !== undefined;
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
  // The pane placement rides only on a nested task, and 'pane' only with the
  // pane it names; anything else is dropped as a pair.
  let paneGroup: PhoneSidebarPaneGroup | undefined;
  let requesterPaneId: string | undefined;
  if (nested && value.paneGroup === 'pane') {
    requesterPaneId = idString(value.requesterPaneId);
    if (requesterPaneId !== undefined) paneGroup = 'pane';
  } else if (nested && value.paneGroup === 'closedPane' && value.requesterPaneId === undefined) {
    paneGroup = 'closedPane';
  }
  if (paneGroup === undefined && (value.paneGroup !== undefined || value.requesterPaneId !== undefined)) {
    requesterPaneId = undefined;
    drop('workspace.task.paneGroup');
  }
  return {
    ownerWorkspaceId,
    detached: value.detached,
    ...(createdAt !== undefined ? { createdAt } : {}),
    nested,
    ...(state ? { state } : {}),
    ...(paneGroup ? { paneGroup } : {}),
    ...(requesterPaneId !== undefined ? { requesterPaneId } : {}),
  };
}

function parseGitSync(value: unknown): PhoneSidebarWorkspace['gitSync'] {
  if (!isRecord(value) || typeof value.hasUpstream !== 'boolean') return undefined;
  const ahead = count(value.ahead);
  const behind = count(value.behind);
  if (ahead === undefined || behind === undefined) return undefined;
  return { ahead, behind, hasUpstream: value.hasUpstream };
}

function parseMoaHandoff(value: unknown): PhoneSidebarMoaHandoff | undefined {
  if (!isRecord(value)) return undefined;
  const agentName = boundedString(value.agentName, PHONE_SIDEBAR_LIMITS.moaHandoffAgentName);
  const title = boundedString(value.title, PHONE_SIDEBAR_LIMITS.moaHandoffTitle);
  const raisedAt = timestamp(value.raisedAt);
  if (agentName === undefined || title === undefined || raisedAt === undefined) return undefined;
  return { agentName, title, raisedAt };
}

function parseMoaDelegation(value: unknown): PhoneMoaDelegation | undefined {
  if (!isRecord(value)) return undefined;
  const taskId = idString(value.taskId);
  const workspaceId = idString(value.workspaceId);
  const agentName = boundedString(value.agentName, PHONE_SIDEBAR_LIMITS.moaDelegationAgentName);
  const title = boundedString(value.title, PHONE_SIDEBAR_LIMITS.moaDelegationTitle);
  const since = timestamp(value.since);
  const state = (PHONE_MOA_DELEGATION_STATES as readonly unknown[]).includes(value.state) ? value.state as PhoneMoaDelegationState : undefined;
  if (taskId === undefined || workspaceId === undefined || agentName === undefined || title === undefined || since === undefined || state === undefined) return undefined;
  return { taskId, workspaceId, agentName, title, state, since };
}

function parseMoaDelegations(value: unknown[], drop: SidebarDropReporter): PhoneMoaDelegation[] {
  const out: PhoneMoaDelegation[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= PHONE_SIDEBAR_LIMITS.moaDelegations) { drop('moaDelegations.overLimit'); break; }
    const row = parseMoaDelegation(raw);
    if (!row) { drop('moaDelegations.row'); continue; }
    if (seen.has(row.taskId)) { drop('moaDelegations.duplicate'); continue; }
    seen.add(row.taskId);
    out.push(row);
  }
  // Newest first, whatever order the producer used.
  return out.sort((a, b) => b.since - a.since);
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
  if (value.layout !== undefined) {
    const layout = parsePhoneSidebarLayout(value.layout, drop);
    if (layout) row.layout = layout;
  }
  const moaHandoff = parseMoaHandoff(value.moaHandoff);
  if (moaHandoff) row.moaHandoff = moaHandoff;
  else if (value.moaHandoff !== undefined) drop('workspace.moaHandoff');
  return row;
}

/** Hundredths of a percent: split shares are whole units of 0.01. */
const SIZE_UNITS = 10_000;

/**
 * Positive weights as percent shares in whole hundredths that sum to exactly
 * 100 (10 000 hundredths), each at least 0.01. Largest remainder: floor every
 * share, then hand the leftover hundredths to the largest fractions; when the
 * 0.01 floor overshoots, take the excess back from the largest shares.
 */
function distributeSizes(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (weight / total) * SIZE_UNITS);
  const units = exact.map((share) => Math.max(1, Math.floor(share)));
  let left = SIZE_UNITS - units.reduce((sum, unit) => sum + unit, 0);
  const byFraction = exact.map((share, i) => ({ i, fraction: share - Math.floor(share) })).sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % byFraction.length, left -= 1) units[byFraction[k].i] += 1;
  while (left < 0) {
    let largest = 0;
    for (let i = 1; i < units.length; i += 1) if (units[i] > units[largest]) largest = i;
    units[largest] -= 1;
    left += 1;
  }
  return units.map((unit) => unit / 100);
}

/** An equal split of `count` children, in the same units as `normalizeLayoutSizes`. */
export function equalLayoutSizes(count: number): number[] {
  return distributeSizes(Array.from({ length: count }, () => 1));
}

/**
 * Split shares as the phone reads them: one positive percent per child, in
 * whole hundredths that sum to exactly 100, none below 0.01. Null when
 * `sizes` is not one finite, positive number per child.
 */
export function normalizeLayoutSizes(sizes: unknown, count: number): number[] | null {
  if (!Array.isArray(sizes) || count === 0 || count > SIZE_UNITS || sizes.length !== count) return null;
  if (!sizes.every((size) => typeof size === 'number' && Number.isFinite(size) && size > 0)) return null;
  const total = (sizes as number[]).reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(total)) return null;
  return distributeSizes(sizes as number[]);
}

class LayoutRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Strict parse of one workspace's split tree. All or nothing: a tree over a
 * bound, with bad sizes, a missing or duplicate pane, tab or session id, an unsafe title or an
 * out-of-range `activeIndex` is refused whole (the row and the flat `panes`
 * list stay), because a partial tree would draw a layout the desktop does not
 * have. Two things degrade instead: an unknown surface kind reads as 'other',
 * and an `activePaneId` that is not a leaf of the tree is dropped alone.
 */
export function parsePhoneSidebarLayout(value: unknown, drop: SidebarDropReporter): PhoneSidebarLayout | undefined {
  const bounds = PHONE_SIDEBAR_LIMITS.layout;
  let nodes = 0;
  let leaves = 0;
  let surfaceCount = 0;
  const paneIds = new Set<string>();
  const ptyIds = new Set<string>();
  const surfaceIds = new Set<string>();
  const refuse = (reason: string): never => {
    throw new LayoutRefusal(reason);
  };

  const parseSurface = (raw: unknown): PhoneLayoutSurface => {
    if (!isRecord(raw) || typeof raw.kind !== 'string') return refuse('surface');
    const kind: PhoneLayoutSurfaceKind = (PHONE_LAYOUT_SURFACE_KINDS as readonly string[]).includes(raw.kind)
      ? (raw.kind as PhoneLayoutSurfaceKind)
      : 'other';
    const surfaceId = idString(raw.surfaceId);
    if (surfaceId === undefined || surfaceIds.has(surfaceId)) return refuse('surfaceId');
    surfaceIds.add(surfaceId);
    if (kind === 'terminal') {
      if (raw.ptyId === undefined) return { surfaceId, kind };
      const ptyId = idString(raw.ptyId);
      if (ptyId === undefined || ptyIds.has(ptyId)) return refuse('ptyId');
      ptyIds.add(ptyId);
      return { surfaceId, kind, ptyId };
    }
    if (raw.title === undefined) return { surfaceId, kind };
    const title = boundedString(raw.title, PHONE_SIDEBAR_LIMITS.surfaceTitle);
    return title !== undefined ? { surfaceId, kind, title } : refuse('title');
  };

  const parseNode = (raw: unknown, depth: number): PhoneLayoutNode => {
    // Bounds are checked before descending, so a depth or width bomb costs
    // at most the bound in work and stack.
    if (depth > bounds.depth) return refuse('depth');
    if (++nodes > bounds.nodes) return refuse('nodes');
    if (!isRecord(raw)) return refuse('node');
    if (raw.kind === 'leaf') {
      if (++leaves > bounds.leaves) return refuse('leaves');
      const paneId = idString(raw.paneId);
      if (paneId === undefined || paneIds.has(paneId)) return refuse('paneId');
      paneIds.add(paneId);
      if (!Array.isArray(raw.surfaces) || raw.surfaces.length > bounds.surfacesPerLeaf) return refuse('surfaces');
      surfaceCount += raw.surfaces.length;
      if (surfaceCount > bounds.surfaces) return refuse('surfaces');
      const surfaces = raw.surfaces.map(parseSurface);
      const leaf: PhoneLayoutLeaf = { kind: 'leaf', paneId, surfaces };
      if (surfaces.length > 0) {
        const index = raw.activeIndex;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= surfaces.length) return refuse('activeIndex');
        leaf.activeIndex = index;
      } else if (raw.activeIndex !== undefined) return refuse('activeIndex');
      return leaf;
    }
    if (raw.kind === 'split') {
      if (raw.direction !== 'horizontal' && raw.direction !== 'vertical') return refuse('direction');
      if (!Array.isArray(raw.children) || raw.children.length === 0 || raw.children.length > bounds.children) return refuse('children');
      const sizes = normalizeLayoutSizes(raw.sizes, raw.children.length);
      if (!sizes) return refuse('sizes');
      const children = raw.children.map((child) => parseNode(child, depth + 1));
      return { kind: 'split', direction: raw.direction, sizes, children };
    }
    return refuse('kind');
  };

  try {
    if (!isRecord(value)) return refuse('envelope');
    const layout: PhoneSidebarLayout = { root: parseNode(value.root, 1) };
    if (value.activePaneId !== undefined) {
      const activePaneId = idString(value.activePaneId);
      if (activePaneId !== undefined && paneIds.has(activePaneId)) layout.activePaneId = activePaneId;
      else drop('workspace.layout.activePaneId');
    }
    return layout;
  } catch (error) {
    if (!(error instanceof LayoutRefusal)) throw error;
    drop(`workspace.layout.${error.reason}`);
    return undefined;
  }
}

function parsePane(value: unknown, drop: SidebarDropReporter): PhoneSidebarPane | null {
  if (!isRecord(value)) return null;
  const ptyId = idString(value.ptyId);
  const workspaceId = idString(value.workspaceId);
  if (ptyId === undefined || workspaceId === undefined) return null;
  const row: PhoneSidebarPane = { ptyId, workspaceId };
  const paneId = idString(value.paneId);
  if (paneId !== undefined) row.paneId = paneId;
  else if (value.paneId !== undefined) drop('pane.paneId');
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
  const snapshot: PhoneSidebarSnapshot = { activeWorkspaceId, workspaces, panes };
  const hqWorkspaceId = idString(value.hqWorkspaceId);
  if (hqWorkspaceId !== undefined) snapshot.hqWorkspaceId = hqWorkspaceId;
  else if (value.hqWorkspaceId !== undefined) drop('hqWorkspaceId');
  if (value.moa === true) snapshot.moa = true;
  else if (value.moa !== undefined) drop('moa');
  if (value.moaWakeBlocked === 'moa-mode-off') snapshot.moaWakeBlocked = 'moa-mode-off';
  else if (value.moaWakeBlocked !== undefined) drop('moaWakeBlocked');
  if (Array.isArray(value.moaDelegations)) snapshot.moaDelegations = parseMoaDelegations(value.moaDelegations, drop);
  else if (value.moaDelegations !== undefined) drop('moaDelegations');
  return snapshot;
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

/** A workspace's layout as `/api/workspaces` carries it. */
export interface PhoneWorkspaceLayout extends PhoneSidebarLayout {
  /**
   * Session ids this row lists that no leaf of `root` holds — a stashed pane's
   * tab, or a session the desktop has not placed yet — in `panes[]` order.
   */
  unplaced: string[];
}

/**
 * The desktop's tree narrowed to what one `/api/workspaces` row can show.
 * `listed` is the row's own session ids: live, non-brain, and running in this
 * workspace by the daemon's own record. A terminal tab naming any other
 * session keeps its slot but loses the id (the phone draws a placeholder), so
 * the tree can never point at a pane the row does not list.
 */
export function phoneWorkspaceLayout(layout: PhoneSidebarLayout, listed: readonly string[]): PhoneWorkspaceLayout {
  const live = new Set(listed);
  const placed = new Set<string>();
  const narrow = (node: PhoneLayoutNode): PhoneLayoutNode => {
    if (node.kind === 'split') return { ...node, children: node.children.map(narrow) };
    return {
      ...node,
      surfaces: node.surfaces.map((surface) => {
        if (surface.ptyId === undefined) return surface;
        if (!live.has(surface.ptyId)) return { surfaceId: surface.surfaceId, kind: surface.kind };
        placed.add(surface.ptyId);
        return surface;
      }),
    };
  };
  return {
    root: narrow(layout.root),
    ...(layout.activePaneId !== undefined ? { activePaneId: layout.activePaneId } : {}),
    unplaced: listed.filter((id) => !placed.has(id)),
  };
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
  /**
   * Desktop pane id → the workspace the daemon lists it under, for the panes
   * whose sessions this same reply lists. A task is drawn under a pane only
   * when that pane is here and belongs to the task's owner.
   */
  listedPanes: ReadonlyMap<string, string> = new Map(),
): {
  nested: Map<string, boolean>;
  summaries: Map<string, PhoneSidebarTaskSummary>;
  placement: Map<string, { nestedUnder: PhoneTaskNestedUnder; requesterPaneId?: string }>;
} {
  const nested = new Map<string, boolean>();
  const summaries = new Map<string, PhoneSidebarTaskSummary>();
  const placement = new Map<string, { nestedUnder: PhoneTaskNestedUnder; requesterPaneId?: string }>();
  for (const row of workspaces) {
    const task = row.task;
    if (!task || !listedIds.has(row.id)) continue;
    const owner = task.ownerWorkspaceId;
    const isNested = task.nested && owner !== null && owner !== row.id && listedIds.has(owner);
    nested.set(row.id, isNested);
    if (!isNested || owner === null) continue;
    // The desktop's pane split, narrowed to what this reply can show. A
    // requesting pane the phone cannot see (no listed session of the owner's
    // carries it — a pane of browser tabs only, or panes cut for size) states
    // nothing, and neither does a desktop build without the split: the phone
    // then draws the task at workspace level, as `nested` alone says.
    if (task.paneGroup === 'closedPane') placement.set(row.id, { nestedUnder: 'closedPane' });
    else if (task.paneGroup === 'pane' && task.requesterPaneId !== undefined && listedPanes.get(task.requesterPaneId) === owner) {
      placement.set(row.id, { nestedUnder: 'pane', requesterPaneId: task.requesterPaneId });
    }
    const summary = summaries.get(owner) ?? { tasks: 0, needYou: 0, toReview: 0, finished: 0 };
    summary.tasks += 1;
    if (task.state?.needYou) summary.needYou += 1;
    if (task.state?.toReview) summary.toReview += 1;
    if (task.state?.finished) summary.finished += 1;
    summaries.set(owner, summary);
  }
  return { nested, summaries, placement };
}
