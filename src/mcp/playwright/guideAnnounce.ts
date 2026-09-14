import { getConnectionScope } from '../connectionScope';
import { snapshotSurfaceKey } from './snapshotCache';
import {
  guideSetKey,
  renderGuideHintBlock,
  selectRenderableGuides,
} from '../../shared/browserGuides/siteGuides';
import type { SiteMemoryRecord } from '../../shared/browserMemory/siteMemory';

// ---------------------------------------------------------------------------
// When a `[guide]` line is worth repeating.
//
// Per surface, the SET of guide paths last matched is remembered. A landing
// announces when the matched set (after ranking, at most two) differs from it,
// or on the surface's first landing. Same-page SPA navigations therefore stay
// silent, a more specific guide that starts matching deeper into a site still
// appears, and leaving for a site with no guide and coming back re-announces —
// which is also how a hint dropped by browser_repl's elision comes back.
//
// Stored per connection (broker) with a module fallback (single child), keyed
// the way snapshot baselines are, so two agents on one surface never silence
// each other. A call that names no surface is keyed by workspace: on a backend
// where the browser is not a wmux surface, no caller can name one, and skipping
// the dedupe there would repeat the line on every landing.
// ---------------------------------------------------------------------------

const MAX_SURFACES = 64;

let moduleState: Map<string, string> | undefined;

function getState(): Map<string, string> {
  const scope = getConnectionScope();
  if (scope) {
    const existing = scope.siteGuideAnnounce as Map<string, string> | undefined;
    if (existing) return existing;
    const fresh = new Map<string, string>();
    scope.siteGuideAnnounce = fresh;
    return fresh;
  }
  if (!moduleState) moduleState = new Map();
  return moduleState;
}

/**
 * The `[guide]` block for this landing, or '' when it should stay silent.
 * The remembered set is updated only after rendering succeeded, so a render
 * failure never swallows the next announcement.
 */
export function takeGuideAnnouncement(
  workspaceId: string | undefined,
  surfaceId: string | undefined,
  guides: unknown,
  memory: SiteMemoryRecord | null,
): string {
  const shown = selectRenderableGuides(guides);
  const key = guideSetKey(shown);
  const state = getState();
  const surface = snapshotSurfaceKey(workspaceId, surfaceId);
  const previous = state.get(surface);
  const block = shown.length > 0 && previous !== key ? renderGuideHintBlock(shown, memory) : '';
  state.delete(surface);
  state.set(surface, key);
  if (state.size > MAX_SURFACES) {
    const oldest = state.keys().next().value;
    if (oldest !== undefined) state.delete(oldest);
  }
  return block;
}

/** Test seam: forget every surface's announced set (module fallback only). */
export function __resetGuideAnnounceForTesting(): void {
  moduleState = undefined;
}
