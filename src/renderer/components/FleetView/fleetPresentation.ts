import type { FleetPane } from '../../stores/selectors/fleet';
import type { WorkTask } from '../../../shared/workTask';

export type FleetFilter = 'all' | 'attention' | 'running' | 'complete' | 'idle';

/** A terminal's application name is context, not a task title. Never invent
 * a task from output; use the user's label, mission, or terminal title. */
export function fleetTitle(pane: FleetPane, mission?: WorkTask): string {
  if (pane.paneLabel?.trim()) return pane.paneLabel.trim();
  if (mission?.title.trim()) return mission.title.trim();
  const title = pane.title.replace(/^[✳✻✽✶✢*]\s*/, '').trim();
  const generic = /^(claude(?: code)?|codex(?: cli)?|gemini(?: cli)?|terminal|shell|zsh|bash|pwsh|powershell|cmd(?:\.exe)?)$/i;
  if (title && !generic.test(title) && title.toLowerCase() !== pane.agentName?.toLowerCase()) return title;
  return pane.workspaceName;
}

export function fleetNeedsAttention(pane: FleetPane): boolean {
  return pane.agentStatus === 'awaiting_input' || pane.agentStatus === 'waiting'
    || pane.agentStatus === 'error' || pane.unverifiable || pane.supervision?.status === 'stopped';
}

export function matchesFleetFilter(pane: FleetPane, filter: FleetFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return fleetNeedsAttention(pane);
  return pane.agentStatus === filter && !fleetNeedsAttention(pane);
}
