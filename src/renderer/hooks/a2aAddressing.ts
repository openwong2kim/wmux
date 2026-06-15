// Pure pane-address resolution for A2A delivery (Part A). Extracted from
// useRpcBridge so it can be unit-tested directly (useRpcBridge itself pulls in
// the store/window and can't be imported under vitest). No React/window deps —
// operates only on the pane-leaf list the caller passes in.

import type { PaneLeaf } from '../../shared/types';

export type PaneAddress = { ptyId: string; paneId: string; surfaceId: string };

/**
 * The historical active-pane delivery target: the active leaf's first terminal
 * surface with a pty, falling back to the first leaf that has one. Used when no
 * explicit pane address is supplied.
 */
export function activePaneTerminalPty(leaves: PaneLeaf[], activePaneId: string): string | null {
  // Fallback (active pane not found) must land on a leaf that actually has a
  // deliverable terminal — require `s.ptyId` in the predicate, else a leaf whose
  // only non-browser surface lacks a pty would be picked and yield null even
  // when a later leaf has a live terminal.
  const activeLeaf = leaves.find((l) => l.id === activePaneId)
    ?? leaves.find((l) => l.surfaces.some((s) => s.surfaceType !== 'browser' && s.ptyId));
  const termSurface = activeLeaf?.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
  return termSurface?.ptyId ?? null;
}

/**
 * Resolve an optional pane-level address (paneId/surfaceId) to a concrete ptyId
 * WITHIN the given leaves (which must be the target workspace's own tree).
 * Cross-ws safety is structural: only the target's leaves are searched, so a
 * foreign id is simply "not found" (fail-closed). Returns an error string when
 * the address is missing or inconsistent — the caller must NOT fall back to the
 * active pane (that would deliver to the wrong agent on a typo).
 *
 *   - surfaceId given → that surface (must be a terminal with a pty); if paneId
 *     is also given it MUST be that surface's leaf, else reject.
 *   - paneId only → that leaf's active terminal surface, else its first one.
 */
export function resolvePaneAddress(
  leaves: PaneLeaf[],
  paneId: string,
  surfaceId: string,
): PaneAddress | { error: string } {
  if (surfaceId) {
    for (const leaf of leaves) {
      const s = leaf.surfaces.find((su) => su.id === surfaceId);
      if (!s) continue;
      if (paneId && leaf.id !== paneId) {
        return { error: `surface_id "${surfaceId}" does not belong to pane_id "${paneId}"` };
      }
      if (s.surfaceType === 'browser' || !s.ptyId) {
        return { error: `surface_id "${surfaceId}" is not a terminal surface` };
      }
      return { ptyId: s.ptyId, paneId: leaf.id, surfaceId: s.id };
    }
    return { error: `surface_id "${surfaceId}" not found in target workspace` };
  }
  const leaf = leaves.find((l) => l.id === paneId);
  if (!leaf) return { error: `pane_id "${paneId}" not found in target workspace` };
  const active = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId && s.surfaceType !== 'browser' && s.ptyId);
  const term = active ?? leaf.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
  if (!term) return { error: `pane_id "${paneId}" has no terminal surface` };
  return { ptyId: term.ptyId, paneId: leaf.id, surfaceId: term.id };
}
