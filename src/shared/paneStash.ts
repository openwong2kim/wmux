// === Pane stash — shared rules ===
//
// Taking a pane out of the layout without killing it. The daemon holds the PTY
// and replays it on the way back, so a stashed pane is still running, still
// addressable, and still counted against everything the workspace owns.
//
// This module holds only the parts BOTH the renderer and the RPC surface need:
// what may be stashed, whether a stashed pane is still alive, and the shape of
// the refusal an agent gets when it aims a layout operation at one. Everything
// stateful lives in paneSlice.

import type { PaneLeaf, StashedPane, Surface } from './types';

/**
 * Surface types a stashed pane may hold.
 *
 * The daemon ring preserves PTY bytes and nothing else. A browser surface is
 * safe because cold-park already unmounts webviews and restores them from their
 * URL. An editor / diff / git / review surface is NOT: unmounting it drops
 * unsaved local edits with no ring to replay them from, so the pane is refused
 * rather than quietly losing the user's work.
 */
export const STASHABLE_SURFACE_TYPES: ReadonlySet<string> = new Set(['terminal', 'browser']);

export type StashRefusal =
  | { ok: true }
  | { ok: false; reason: 'surface'; surfaceType: string };

/** Whether this pane's contents survive being unmounted. */
export function canStashPaneSurfaces(pane: PaneLeaf): StashRefusal {
  for (const s of pane.surfaces) {
    const type = s.surfaceType ?? 'terminal';
    if (!STASHABLE_SURFACE_TYPES.has(type)) {
      return { ok: false, reason: 'surface', surfaceType: type };
    }
  }
  return { ok: true };
}

export type StashedLiveness = 'alive' | 'exited';

function isTerminalSurface(s: Surface): boolean {
  return (s.surfaceType ?? 'terminal') === 'terminal';
}

/**
 * Whether a stashed pane's session is still there — DERIVED, never stored.
 *
 * Reconcile clears `ptyId` when the daemon confirms a session is gone (twice
 * over: the 2-strike re-query), so ptyId presence is the same structural signal
 * the visible panes already use. A pane with ANY live terminal surface counts
 * as alive, matching how a multi-tab visible pane is treated; only when every
 * terminal surface has lost its pty is it `exited`.
 *
 * A pane with no terminal surfaces at all (a lone browser) is `alive` — there
 * is no session to lose, and calling it exited would offer a shell recovery for
 * something that never had a shell.
 */
export function stashedPaneLiveness(pane: PaneLeaf): StashedLiveness {
  const terminals = pane.surfaces.filter(isTerminalSurface);
  if (terminals.length === 0) return 'alive';
  return terminals.some((s) => !!s.ptyId) ? 'alive' : 'exited';
}

/** Locate a stashed entry by pane id. */
export function findStashedEntry(
  stashed: readonly StashedPane[] | undefined,
  paneId: string,
): StashedPane | undefined {
  return stashed?.find((entry) => entry?.pane?.id === paneId);
}

// ─── RPC refusal ─────────────────────────────────────────────────────────────

/**
 * Error code for "this pane exists and is running, but it is not in the layout,
 * so a position-dependent operation has nothing to act on".
 *
 * Address operations (input.send, input.readScreen, A2A delivery, pane.close)
 * deliberately do NOT raise this — a stashed PTY is reachable. Only operations
 * that need coordinates do: focus / split / resize / swap, and surface creation
 * (there is nowhere to render the new tab).
 */
export const PANE_STASHED = 'PANE_STASHED';

export interface PaneStashedError {
  error: string;
  code: typeof PANE_STASHED;
  recovery: { method: 'pane.unstash'; params: { id: string } };
}

/**
 * Build the refusal an agent can act on without parsing prose.
 *
 * English, `method: subject — reason`, and a machine-readable `recovery` the
 * caller can invoke verbatim. RPC errors never pass through i18n: the reader is
 * an agent, and an agent has no locale.
 */
export function paneStashedError(method: string, paneId: string): PaneStashedError {
  return {
    error:
      `${method}: pane ${paneId} is stashed (not in the layout). `
      + `Call pane.unstash({ id: "${paneId}" }) to bring it back, then retry — `
      + 'or read/write it in place with input.readScreen / input.send, which work while stashed.',
    code: PANE_STASHED,
    recovery: { method: 'pane.unstash', params: { id: paneId } },
  };
}
