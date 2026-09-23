// fleet.triage — the Fleet attention board as an RPC answer.
//
// The rows come from selectFleetBoard, the selector the Fleet overlay renders,
// in its default 'attention' order, so an agent asking "who needs me?" gets
// exactly what a human sees on that screen. Kept out of useRpcBridge (which
// cannot be imported under vitest) so the payload can be tested directly.

import type { StoreState } from '../stores';
import {
  selectFleetBoard,
  fleetTargetPtyId,
  fleetTitle,
  type FleetRow,
} from '../stores/selectors/fleet';
import type { AgentStatus } from '../../shared/types';
import { en } from '../i18n/locales/en';

export interface FleetTriageRow {
  /** The tab to act on: the background tab whose status won the row, else
   *  the active surface. A remote row carries its synthetic remote key. */
  ptyId: string;
  paneId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  agentName?: string;
  status: AgentStatus;
  /** Reported text (question, last message, activity), else the English
   *  fallback the overlay would show. Never the user's UI locale. */
  detail: string;
  idleMs?: number;
  stashed?: boolean;
  remote?: { hostLabel: string };
}

export interface FleetTriageResult {
  generatedAt: number;
  needsYou: FleetTriageRow[];
  running: FleetTriageRow[];
  idle: { count: number; oldestIdleMs?: number; rows?: FleetTriageRow[] };
}

export interface FleetTriageParams {
  /** Narrow to one workspace; omitted means the whole fleet. */
  workspaceId?: string;
  /** Include the idle rows themselves, not only their count. */
  includeIdle?: boolean;
}

export function buildFleetTriage(
  state: StoreState,
  params: FleetTriageParams,
  now: number,
): FleetTriageResult {
  const { groups } = selectFleetBoard(state, { now, sortMode: 'attention' });
  const inScope = (row: FleetRow) => !params.workspaceId || row.pane.workspaceId === params.workspaceId;
  const toRow = ({ pane, detail, detailKey, idleForMs }: FleetRow): FleetTriageRow => ({
    ptyId: fleetTargetPtyId(pane),
    paneId: pane.paneId,
    workspaceId: pane.workspaceId,
    workspaceName: pane.workspaceName,
    title: fleetTitle(pane, state.missionByPaneGroup[pane.workspaceId]),
    ...(pane.agentName ? { agentName: pane.agentName } : {}),
    status: pane.agentStatus,
    detail: detail ?? en[detailKey],
    ...(idleForMs !== undefined ? { idleMs: idleForMs } : {}),
    ...(pane.stashed ? { stashed: true } : {}),
    ...(pane.remote ? { remote: { hostLabel: pane.remote.hostLabel } } : {}),
  });
  const idle = groups.idle.filter(inScope);
  const oldestIdleMs = idle.reduce<number | undefined>(
    (max, row) => (row.idleForMs !== undefined && (max === undefined || row.idleForMs > max) ? row.idleForMs : max),
    undefined,
  );
  return {
    generatedAt: now,
    needsYou: groups.needsYou.filter(inScope).map(toRow),
    running: groups.running.filter(inScope).map(toRow),
    idle: {
      count: idle.length,
      ...(oldestIdleMs !== undefined ? { oldestIdleMs } : {}),
      ...(params.includeIdle ? { rows: idle.map(toRow) } : {}),
    },
  };
}
