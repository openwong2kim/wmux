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
  type FleetDetailKey,
} from '../stores/selectors/fleet';
import type { AgentStatus } from '../../shared/types';
import { en } from '../i18n/locales/en';

/** Why a row sits where it does, for callers that should not parse `detail`. */
export type FleetTriageReason =
  | 'input' | 'error' | 'unconfirmed' | 'supervisionStopped' | 'complete' | 'running' | 'idle';

const REASON_BY_DETAIL_KEY: Record<FleetDetailKey, FleetTriageReason> = {
  'fleet.needsYourInput': 'input',
  'fleet.detail.error': 'error',
  'fleet.detail.unconfirmed': 'unconfirmed',
  'fleet.detail.supervisionStopped': 'supervisionStopped',
  'fleet.detail.complete': 'complete',
  'fleet.detail.running': 'running',
  'fleet.detail.idle': 'idle',
};

/** Rows returned across all sections, most urgent first. Keeps the JSON well
 *  under the 64 KiB MCP result cap, which would otherwise cut an object mid-way
 *  and leave the caller with text it cannot parse. */
export const FLEET_TRIAGE_MAX_ROWS = 80;
/** Characters of `detail` per row; a pending question can run to 600. */
export const FLEET_TRIAGE_MAX_DETAIL = 280;
/** UTF-8 bytes of the answer as the MCP server sends it (pretty-printed JSON,
 *  see callRpc), kept well under the 64 KiB result cap. Hangul details are
 *  three bytes a character, so the row cap alone does not guarantee this. */
export const FLEET_TRIAGE_MAX_BYTES = 56 * 1024;

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length <= FLEET_TRIAGE_MAX_DETAIL ? text : `${chars.slice(0, FLEET_TRIAGE_MAX_DETAIL - 1).join('')}…`;
}

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
  /** Why the row is in its section; the same for every locale. */
  reason: FleetTriageReason;
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
  /** What was asked about: one workspace id, or 'fleet'. A hosted plugin's
   *  request is bound to its own workspace, so this is the scope actually read. */
  scope: string;
  /** Rows left out per section once the row or byte budget was reached. */
  omitted?: { needsYou?: number; running?: number; idle?: number };
}

export interface FleetTriageParams {
  /** Narrow to one workspace; omitted means the whole fleet. */
  workspaceId?: string;
  /** Include the idle rows themselves, not only their count. */
  includeIdle?: boolean;
}

/**
 * The error for a workspaceId the fleet does not have, or null when the scope
 * is fine. An empty board for a stale or mistyped id would read as "nobody
 * needs you" to a polling agent, so it is refused instead.
 */
export function fleetTriageScopeError(
  state: Pick<StoreState, 'workspaces'>,
  workspaceId: string | undefined,
): string | null {
  if (workspaceId === undefined) return null;
  if (!workspaceId || !state.workspaces.some((ws) => ws.id === workspaceId)) {
    return `fleet.triage: unknown workspaceId "${workspaceId}"`;
  }
  return null;
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
    reason: REASON_BY_DETAIL_KEY[detailKey],
    detail: clip(detail ?? en[detailKey]),
    ...(idleForMs !== undefined ? { idleMs: idleForMs } : {}),
    ...(pane.stashed ? { stashed: true } : {}),
    ...(pane.remote ? { remote: { hostLabel: pane.remote.hostLabel } } : {}),
  });
  const idle = groups.idle.filter(inScope);
  const oldestIdleMs = idle.reduce<number | undefined>(
    (max, row) => (row.idleForMs !== undefined && (max === undefined || row.idleForMs > max) ? row.idleForMs : max),
    undefined,
  );
  // Spend the row budget most-urgent first: needs you, then running, then idle.
  let budget = FLEET_TRIAGE_MAX_ROWS;
  const omitted: NonNullable<FleetTriageResult['omitted']> = {};
  const take = (rows: FleetRow[], section: 'needsYou' | 'running' | 'idle'): FleetTriageRow[] => {
    const kept = rows.slice(0, Math.max(0, budget));
    budget -= kept.length;
    if (kept.length < rows.length) omitted[section] = rows.length - kept.length;
    return kept.map(toRow);
  };
  const needsYou = take(groups.needsYou.filter(inScope), 'needsYou');
  const running = take(groups.running.filter(inScope), 'running');
  const idleRows = params.includeIdle ? take(idle, 'idle') : undefined;
  const build = (): FleetTriageResult => ({
    generatedAt: now,
    scope: params.workspaceId ?? 'fleet',
    needsYou,
    running,
    idle: {
      count: idle.length,
      ...(oldestIdleMs !== undefined ? { oldestIdleMs } : {}),
      ...(idleRows ? { rows: idleRows } : {}),
    },
    ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
  });
  // Then the byte budget, least urgent rows first, so the answer always
  // arrives as whole JSON with an honest omitted count.
  const bytes = (r: FleetTriageResult) => new TextEncoder().encode(JSON.stringify(r, null, 2)).length;
  let result = build();
  const order: Array<['idle' | 'running' | 'needsYou', FleetTriageRow[]]> = [
    ['idle', idleRows ?? []], ['running', running], ['needsYou', needsYou],
  ];
  for (const [section, rows] of order) {
    while (rows.length > 0 && bytes(result) > FLEET_TRIAGE_MAX_BYTES) {
      rows.pop();
      omitted[section] = (omitted[section] ?? 0) + 1;
      result = build();
    }
  }
  return result;
}
