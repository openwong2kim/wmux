// PC rail, "This computer only": Git, Schedules, Fleet, the dock and the
// browser read this computer only. These selectors say when the user is
// looking at another computer, and its name, from the rail's own state: the
// selected computer and main's host roster. A remote id never names a local
// folder, so nothing here reads from disk.
import type { StoreState } from '../../stores';
import { LOCAL_PC_ID, parseShadowWorkspaceId, isShadowWorkspaceId } from '../../../shared/pcRail';

function hostLabel(s: Pick<StoreState, 'pcRailHosts'>, hostId: string): string {
  return s.pcRailHosts.find((h) => h.id === hostId)?.label.trim() ?? '';
}

/**
 * The computer selected in the PC rail when it is not this one: its name, ''
 * while the roster does not know it yet, or null for this computer. Rail pages
 * show their one muted line from this.
 */
export function selectSelectedRemotePcName(s: Pick<StoreState, 'pcRail' | 'pcRailHosts'>): string | null {
  const id = s.pcRail.activePcId;
  return id === LOCAL_PC_ID ? null : hostLabel(s, id);
}

/**
 * The other computer the workspace on screen belongs to: the selected remote
 * computer, or the host of a shadow workspace (PR4) left active. '' when it is
 * remote but unnamed, null when it is this computer. Anything non-null means
 * "do not read the active workspace's folders from this disk".
 */
export function selectRemoteScopeName(s: Pick<StoreState, 'pcRail' | 'pcRailHosts' | 'activeWorkspaceId'>): string | null {
  const selected = selectSelectedRemotePcName(s);
  if (selected !== null) return selected;
  if (!isShadowWorkspaceId(s.activeWorkspaceId)) return null;
  const ref = parseShadowWorkspaceId(s.activeWorkspaceId);
  return ref ? hostLabel(s, ref.hostId) : '';
}
