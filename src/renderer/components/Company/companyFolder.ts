import type { PaneLeaf, Workspace } from '../../../shared/types';

/** The folder the company works in: the one it was made in, else where its CEO works. */
export function companyFolder(ws: Workspace, ceo: PaneLeaf | undefined): string | undefined {
  return ws.profile?.startupCwd || ceo?.surfaces.find((sf) => (sf.surfaceType ?? 'terminal') === 'terminal' && sf.cwd)?.cwd || undefined;
}
