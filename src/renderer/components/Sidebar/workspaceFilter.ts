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

export type StatusFacet = 'needsYou' | 'running' | 'idle';
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
}

export const EMPTY_FILTER: WorkspaceFilter = { status: [], kind: [], agent: [], other: [], hideTasks: false };

export function isFilterActive(f: WorkspaceFilter): boolean {
  return f.status.length + f.kind.length + f.agent.length + f.other.length > 0 || f.hideTasks;
}

/** What a workspace is, for the filter. */
export interface WorkspaceFacts {
  status: StatusFacet;
  hasAgent: boolean;
  agents: AgentFacet[];
  hasPr: boolean;
  hasChanges: boolean;
  isTask: boolean;
}

/** The status facet of a workspace's rolled-up agent status (the sidebar's own). */
export function statusFacet(agentStatus: AgentStatus, unverifiable: boolean): StatusFacet {
  const cls = fleetAttentionClass({ agentStatus, unverifiable });
  if (cls === 'running') return 'running';
  if (cls === 'idle') return 'idle';
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
  return true;
}

/** One active check, as a removable chip. */
export type FilterChip =
  | { group: 'status'; value: StatusFacet }
  | { group: 'kind'; value: KindFacet }
  | { group: 'agent'; value: AgentFacet }
  | { group: 'other'; value: OtherFacet }
  | { group: 'hideTasks'; value: true };

export function filterChips(f: WorkspaceFilter): FilterChip[] {
  return [
    ...f.status.map((value) => ({ group: 'status' as const, value })),
    ...f.kind.map((value) => ({ group: 'kind' as const, value })),
    ...f.agent.map((value) => ({ group: 'agent' as const, value })),
    ...f.other.map((value) => ({ group: 'other' as const, value })),
    ...(f.hideTasks ? [{ group: 'hideTasks' as const, value: true as const }] : []),
  ];
}

/** The filter with one check turned on or off. */
export function toggleFacet(f: WorkspaceFilter, chip: FilterChip): WorkspaceFilter {
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
  const out: Record<string, string> = {};
  for (const ws of state.workspaces) {
    const agents = [...new Set(getWorkspacePtyIds(ws)
      .map((id) => state.surfaceAgent[id])
      .filter((a): a is NonNullable<typeof a> => Boolean(a?.name))
      .map((a) => agentFacet(a.slug)))].sort();
    const sync = ws.metadata?.gitSync;
    const isTask = resolveTaskLink(state.missionByPaneGroup[ws.id], state.fanoutLineage[ws.id], state.fanoutSpawnOwner[ws.id]) !== null;
    out[ws.id] = [
      statusFacet(status[ws.id] ?? 'idle', (silent[ws.id] ?? 0) > 0),
      agents.join(','),
      ws.metadata?.pr ? 1 : 0,
      sync && (sync.dirty > 0 || sync.ahead > 0) ? 1 : 0,
      isTask ? 1 : 0,
    ].join('|');
  }
  return out;
}

export function factsFromKey(key: string): WorkspaceFacts {
  const [status, agents, pr, changes, task] = key.split('|');
  const list = agents ? (agents.split(',') as AgentFacet[]) : [];
  return {
    status: status as StatusFacet,
    hasAgent: list.length > 0,
    agents: list,
    hasPr: pr === '1',
    hasChanges: changes === '1',
    isTask: task === '1',
  };
}
