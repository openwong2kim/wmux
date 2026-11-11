// Workspace and tab names are addresses: `#backend` and `api.#w1-2` resolve
// through them (paneNameResolver.ts), and two of the same name resolve to
// neither, as ambiguous. So a rename that would make a name ambiguous, or
// read as an automatic pane tag (w1-2), is refused before it is stored.
//
// The comparisons are the resolver's own: workspace names trimmed and
// case-insensitive (its `Workspace.name` prefix), tab names flattened and
// case-insensitive, pane labels normalized. PC rail shadows are another
// computer's workspaces and never resolve here, so they never clash.

import type { Workspace } from '../../shared/types';
import { flattenName } from '../../shared/a2aNameSanitize';
import { APP_ACTION_NAME_MAX } from '../../shared/appActions';
import { normalizePaneLabel } from '../../shared/paneLabelRules';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { isShadowWorkspaceId } from '../../shared/pcRail';
import { isAutoNameShape } from './paneNaming';

export type NameRefusal = 'empty' | 'too-long' | 'pane-tag' | 'taken';

export const ADDRESSABLE_NAME_MAX = APP_ACTION_NAME_MAX;

const MESSAGES: Record<NameRefusal, string> = {
  empty: 'the name is empty',
  'too-long': `the name is longer than ${ADDRESSABLE_NAME_MAX} characters`,
  'pane-tag': 'the name looks like an automatic pane tag (w<n>-<n>), which it would shadow',
  taken: 'another one already has this name, so neither would resolve by it',
};

export function nameRefusalMessage(reason: NameRefusal): string {
  return MESSAGES[reason];
}

function shapeRefusal(name: string): NameRefusal | null {
  // Flattened first, so a hidden format or bidi character cannot smuggle the
  // tag shape past the check (`w<zwsp>1-2`).
  const flat = flattenName(name);
  if (!flat) return 'empty';
  if (name.trim().length > ADDRESSABLE_NAME_MAX) return 'too-long';
  if (isAutoNameShape(flat)) return 'pane-tag';
  return null;
}

type NamedWorkspace = Pick<Workspace, 'id' | 'name'>;

/** Why `name` cannot be workspace `id`'s name, or null. Its own current name is fine. */
export function workspaceNameRefusal(
  workspaces: ReadonlyArray<NamedWorkspace>,
  id: string,
  name: string,
): NameRefusal | null {
  const shape = shapeRefusal(name);
  if (shape) return shape;
  const wanted = name.trim().toLowerCase();
  const taken = workspaces.some(
    (w) => w.id !== id && !isShadowWorkspaceId(w.id) && w.name.trim().toLowerCase() === wanted,
  );
  return taken ? 'taken' : null;
}

/**
 * Why `name` cannot be tab `surfaceId`'s name, or null. A tab name resolves
 * across every workspace (`#name`), so it clashes with another tab's name or
 * another pane's label anywhere. Its own pane's label is not a clash: the
 * resolver reads the two as one target.
 */
export function tabNameRefusal(
  workspaces: ReadonlyArray<Workspace>,
  paneLabel: Record<string, string> | undefined,
  surfaceId: string,
  name: string,
): NameRefusal | null {
  const shape = shapeRefusal(name);
  if (shape) return shape;
  const wanted = flattenName(name).toLowerCase();
  const wantedLabel = normalizePaneLabel(flattenName(name));
  for (const ws of workspaces) {
    if (isShadowWorkspaceId(ws.id)) continue;
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      const own = leaf.surfaces.some((s) => s.id === surfaceId);
      const label = (paneLabel?.[leaf.id] ?? leaf.metadata?.label)?.trim();
      if (!own && label && normalizePaneLabel(label) === wantedLabel) return 'taken';
      for (const s of leaf.surfaces) {
        if (s.id === surfaceId || !s.userName) continue;
        if (flattenName(s.userName).toLowerCase() === wanted) return 'taken';
      }
    }
  }
  return null;
}
