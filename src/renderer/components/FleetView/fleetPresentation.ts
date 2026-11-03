import type { FleetRow } from '../../stores/selectors/fleet';

// fleetTitle lives beside the board selector so the fleet.triage RPC titles
// rows exactly as this overlay does; re-exported for the existing imports.
export { fleetTitle } from '../../stores/selectors/fleet';

export type FleetFilter = 'all' | 'attention' | 'running' | 'finished' | 'idle' | 'handOut' | 'tickets';

/** Status filters narrow the attention-board sections; they never re-derive
 * a status of their own, so a chip count always matches its section. */
export function matchesFleetFilter(row: FleetRow, filter: FleetFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return row.section === 'needsYou';
  // Tickets and To hand out items are not agent rows: those filters list them instead.
  if (filter === 'tickets' || filter === 'handOut') return false;
  return row.section === filter;
}
