import type { FleetRow } from '../../stores/selectors/fleet';

// fleetTitle lives beside the board selector so the fleet.triage RPC titles
// rows exactly as this overlay does; re-exported for the existing imports.
export { fleetTitle } from '../../stores/selectors/fleet';

export type FleetFilter = 'all' | 'attention' | 'running' | 'complete' | 'idle';

/** Status filters narrow the attention-board sections; they never re-derive
 * a status of their own, so a chip count always matches its section. */
export function matchesFleetFilter(row: FleetRow, filter: FleetFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return row.section === 'needsYou';
  if (filter === 'complete') return row.pane.agentStatus === 'complete';
  return row.section === filter;
}
