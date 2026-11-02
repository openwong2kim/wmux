import { isAbsoluteFolder, normalizeFolder } from '../../../shared/handOut';
import type { PaneLeaf, Workspace } from '../../../shared/types';

/** The folder when it is an absolute path, normalized as To hand out keeps one;
 *  a relative path or `~` names no folder here. */
const absoluteFolder = (folder: string | undefined): string | undefined => {
  const normal = folder ? normalizeFolder(folder) : '';
  return normal && isAbsoluteFolder(normal) ? normal : undefined;
};

/**
 * The folder the company works in: the one it was made in, else where its CEO
 * works (the CEO pane's active terminal first, then its other terminals).
 */
export function companyFolder(ws: Workspace, ceo: PaneLeaf | undefined): string | undefined {
  const made = absoluteFolder(ws.profile?.startupCwd);
  if (made) return made;
  const terminals = (ceo?.surfaces ?? []).filter((sf) => (sf.surfaceType ?? 'terminal') === 'terminal');
  const ordered = [...terminals.filter((sf) => sf.id === ceo?.activeSurfaceId), ...terminals.filter((sf) => sf.id !== ceo?.activeSurfaceId)];
  for (const sf of ordered) {
    const folder = absoluteFolder(sf.cwd);
    if (folder) return folder;
  }
  return undefined;
}
