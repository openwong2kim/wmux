// The sidebar's workspace filter: facet checks behind the header's filter
// icon, on top of the text search. Pure — the sidebar derives each
// workspace's facets from the store and asks here whether it shows.
//
// Within a group the checks are alternatives (OR); groups narrow each other
// (AND). An empty group does not narrow at all.
import {
  fleetAttentionClass, selectAllWorkspaceAgentStatus, selectAllWorkspaceUnverifiableMinutes,
} from '../../stores/selectors/fleet';
import type { StoreState } from '../../stores';
import type { AgentStatus } from '../../../shared/types';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';
import { resolveTaskLink } from '../../utils/fanoutProvenance';
import { workspaceHasUsageLimitWaiting } from '../../stores/slices/usageLimitSlice';
import { listedWorkspaces } from '../../../shared/pcRail';
import { selectBotTaskOwners, withoutBotTasks } from './botTasks';

export type StatusFacet = 'needsYou' | 'running' | 'usageWaiting' | 'idle';
export type KindFacet = 'agent' | 'terminal';
export type AgentFacet = 'claude' | 'codex' | 'other';
export type OtherFacet = 'pr' | 'changes' | 'tasks';

export interface WorkspaceFilter {
  status: StatusFacet[];
  kind: KindFacet[];
  agent: AgentFacet[];
  /** PR, changes and fan-out tasks: any of them (OR). */
  other: OtherFacet[];
  /** Hide fan-out task workspaces (applies on its own, like a group). */
  hideTasks: boolean;
  /** Show only bookmarked workspaces (applies on its own, like a group). */
  bookmarked: boolean;
}

export const EMPTY_FILTER: WorkspaceFilter = { status: [], kind: [], agent: [], other: [], hideTasks: false, bookmarked: false };

export function isFilterActive(f: WorkspaceFilter): boolean {
  return f.status.length + f.kind.length + f.agent.length + f.other.length > 0 || f.hideTasks || f.bookmarked;
}

/** What a workspace is, for the filter. */
export interface WorkspaceFacts {
  status: StatusFacet;
  hasAgent: boolean;
  agents: AgentFacet[];
  hasPr: boolean;
  hasChanges: boolean;
  isTask: boolean;
  /** Bookmarked itself, or a nested fan-out task of a bookmarked owner (the
   *  tasks travel with the row they nest under). */
  isBookmarked: boolean;
}

/**
 * The status facet of a workspace's rolled-up agent status (the sidebar's own).
 * `usageWaiting`: a pane of the workspace is waiting out a usage limit. Like
 * the row's clock mark, it shows only where the row would otherwise be idle;
 * a louder status keeps its own facet.
 */
export function statusFacet(agentStatus: AgentStatus, unverifiable: boolean, usageWaiting = false): StatusFacet {
  const cls = fleetAttentionClass({ agentStatus, unverifiable });
  if (cls === 'running') return 'running';
  if (cls === 'idle') return usageWaiting ? 'usageWaiting' : 'idle';
  // Needs you, finished and unconfirmed all want a look.
  return 'needsYou';
}

/** The agent facet of a detected agent slug. */
export function agentFacet(slug: string | undefined): AgentFacet {
  return slug === 'claude' ? 'claude' : slug === 'codex' ? 'codex' : 'other';
}

export function matchesFilter(f: WorkspaceFilter, facts: WorkspaceFacts): boolean {
  if (f.status.length > 0 && !f.status.includes(facts.status)) return false;
  if (f.kind.length > 0 && !f.kind.includes(facts.hasAgent ? 'agent' : 'terminal')) return false;
  if (f.agent.length > 0 && !facts.agents.some((a) => f.agent.includes(a))) return false;
  if (f.other.length > 0 && !f.other.some((o) =>
    (o === 'pr' && facts.hasPr) || (o === 'changes' && facts.hasChanges) || (o === 'tasks' && facts.isTask))) return false;
  if (f.hideTasks && facts.isTask) return false;
  if (f.bookmarked && !facts.isBookmarked) return false;
  return true;
}

/** One active check, as a removable chip. */
export type FilterChip =
  | { group: 'status'; value: StatusFacet }
  | { group: 'kind'; value: KindFacet }
  | { group: 'agent'; value: AgentFacet }
  | { group: 'other'; value: OtherFacet }
  | { group: 'hideTasks'; value: true }
  | { group: 'bookmarked'; value: true };

export function filterChips(f: WorkspaceFilter): FilterChip[] {
  return [
    ...(f.bookmarked ? [{ group: 'bookmarked' as const, value: true as const }] : []),
    ...f.status.map((value) => ({ group: 'status' as const, value })),
    ...f.kind.map((value) => ({ group: 'kind' as const, value })),
    ...f.agent.map((value) => ({ group: 'agent' as const, value })),
    ...f.other.map((value) => ({ group: 'other' as const, value })),
    ...(f.hideTasks ? [{ group: 'hideTasks' as const, value: true as const }] : []),
  ];
}

/** The filter with one check turned on or off. */
export function toggleFacet(f: WorkspaceFilter, chip: FilterChip): WorkspaceFilter {
  if (chip.group === 'bookmarked') return { ...f, bookmarked: !f.bookmarked };
  if (chip.group === 'hideTasks') {
    // Hiding tasks and showing only tasks cannot both hold.
    return { ...f, hideTasks: !f.hideTasks, other: f.hideTasks ? f.other : f.other.filter((o) => o !== 'tasks') };
  }
  const list = f[chip.group] as string[];
  const next = list.includes(chip.value) ? list.filter((v) => v !== chip.value) : [...list, chip.value];
  const out = { ...f, [chip.group]: next } as WorkspaceFilter;
  if (chip.group === 'other' && chip.value === 'tasks' && next.includes('tasks')) out.hideTasks = false;
  return out;
}

// ─── Facts from the store ───────────────────────────────────────────────────

/** Each workspace's facts as one string, so a shallow compare holds between unrelated updates. */
export function selectWorkspaceFactKeys(state: StoreState): Record<string, string> {
  const status = selectAllWorkspaceAgentStatus(state);
  const silent = selectAllWorkspaceUnverifiableMinutes(state);
  const bookmarked = new Set(state.sidebarBookmarkedIds ?? []);
  const out: Record<string, string> = {};
  for (const ws of state.workspaces) {
    const agents = [...new Set(getWorkspacePtyIds(ws)
      .map((id) => state.surfaceAgent[id])
      .filter((a): a is NonNullable<typeof a> => Boolean(a?.name))
      .map((a) => agentFacet(a.slug)))].sort();
    const sync = ws.metadata?.gitSync;
    const link = resolveTaskLink(state.missionByPaneGroup[ws.id], state.fanoutLineage[ws.id], state.fanoutSpawnOwner[ws.id]);
    const isTask = link !== null;
    const nestedOwner = link && !link.detached ? link.ownerId : undefined;
    const isBookmarked = bookmarked.has(ws.id) || (!!nestedOwner && bookmarked.has(nestedOwner));
    out[ws.id] = [
      statusFacet(status[ws.id] ?? 'idle', (silent[ws.id] ?? 0) > 0, workspaceHasUsageLimitWaiting(state, ws.id)),
      agents.join(','),
      ws.metadata?.pr ? 1 : 0,
      sync && (sync.dirty > 0 || sync.ahead > 0) ? 1 : 0,
      isTask ? 1 : 0,
      isBookmarked ? 1 : 0,
    ].join('|');
  }
  return out;
}

export function factsFromKey(key: string): WorkspaceFacts {
  const [status, agents, pr, changes, task, bookmarked] = key.split('|');
  const list = agents ? (agents.split(',') as AgentFacet[]) : [];
  return {
    status: status as StatusFacet,
    hasAgent: list.length > 0,
    agents: list,
    hasPr: pr === '1',
    hasChanges: changes === '1',
    isTask: task === '1',
    isBookmarked: bookmarked === '1',
  };
}

/** The rows a narrowed sidebar keeps, in stored order: the search text
 *  matches the name, and an active filter matches the workspace's facts. */
export function narrowWorkspaces<T extends { id: string; name: string }>(
  listed: readonly T[],
  search: string,
  filter: WorkspaceFilter,
  factKeys: Readonly<Record<string, string>>,
): T[] {
  const q = search.trim().toLowerCase();
  const filterOn = isFilterActive(filter);
  return listed.filter((ws) => (!q || ws.name.toLowerCase().includes(q))
    && (!filterOn || (factKeys[ws.id] !== undefined && matchesFilter(filter, factsFromKey(factKeys[ws.id])))));
}

/** The workspaces the Ctrl+N digits reach, in stored order: what the open
 *  sidebar lists, so a filtered list numbers its rows 1, 2, … The collapsed
 *  rail lists every workspace, so there the digits reach all of them. */
export function selectShortcutWorkspaces(state: StoreState): StoreState['workspaces'] {
  // A bot worker is never listed, so never numbered (botTasks.ts).
  const listed = withoutBotTasks(listedWorkspaces(state.workspaces), selectBotTaskOwners(state));
  if (!state.sidebarVisible) return listed;
  const filterOn = isFilterActive(state.sidebarFilter);
  if (!filterOn && state.sidebarSearch.trim() === '') return listed;
  return narrowWorkspaces(listed, state.sidebarSearch, state.sidebarFilter, filterOn ? selectWorkspaceFactKeys(state) : {});
}
