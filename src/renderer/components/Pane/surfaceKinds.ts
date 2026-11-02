// Which column of a pane each surface draws in, and which surface each column
// shows. Pure (no React, no store) so the store's "is this surface on screen"
// selector (stores/selectors/surfaceShown.ts) reads the same rules Pane draws
// by. Re-exported from Pane.tsx and SurfaceTabs.tsx, where they used to live.

/** D2 — only a terminal surface can launch an agent, so only a terminal surface
 *  may claim a role-enforced model. An undefined `surfaceType` is a legacy
 *  terminal (the field postdates the original Surface shape). */
export function isTerminalSurfaceType(surfaceType: string | undefined): boolean {
  return surfaceType === undefined || surfaceType === 'terminal';
}

/**
 * A pane is a terminal column plus a work area (DESIGN.md "Pane: terminals and
 * work area"). Terminal surfaces — local, remote and placeholders — stay on
 * the pane tab strip and draw on the left; work surfaces draw on the right under their own
 * tab strip. `git` / `review` surfaces are retired and belong to neither.
 */
export function isTerminalKindSurfaceType(surfaceType: string | undefined): boolean {
  // A placeholder stands in for a surface a mirror cannot draw — most often a
  // terminal slot (open elsewhere, not listed) — so it stays in the terminal
  // column and never splits a pane on its own.
  return isTerminalSurfaceType(surfaceType) || surfaceType === 'remote-terminal'
    || surfaceType === 'placeholder';
}

export function isWorkSurfaceType(surfaceType: string | undefined): boolean {
  return surfaceType === 'browser' || surfaceType === 'editor' || surfaceType === 'preview' || surfaceType === 'diff'
    || surfaceType === 'board';
}

/**
 * Choose which terminal and which work surface is SHOWN on each side of the
 * split. Both sides stay visible, but a pane has a single `activeSurfaceId`, so
 * visibility (what renders on each side) must be decoupled from focus (which
 * side `activeSurfaceId` points at). Each side shows its active surface when
 * the active surface is on that side; otherwise the terminal side shows its
 * first surface and the work side the one last shown there (`lastWorkId`), so
 * focusing a terminal never swaps the page or file beside it.
 * (Bug: each surface gated `display` on `surface.id === activeSurfaceId`, so
 * focusing one side display:none'd the other.)
 *
 * Pure so it is unit-testable without mounting the split (which pulls in xterm).
 */
export function pickSplitShownSurfaces(
  terminals: ReadonlyArray<{ id: string }>,
  works: ReadonlyArray<{ id: string }>,
  activeSurfaceId: string,
  lastWorkId?: string,
): { shownTerminalId: string | undefined; shownWorkId: string | undefined } {
  return {
    shownTerminalId: terminals.find((s) => s.id === activeSurfaceId)?.id ?? terminals[0]?.id,
    shownWorkId: works.find((s) => s.id === activeSurfaceId)?.id
      ?? works.find((s) => s.id === lastWorkId)?.id
      ?? works[0]?.id,
  };
}
