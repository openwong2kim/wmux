// Wake-boundary glyph-atlas recovery — the corruption class atlasGuard's poll
// cannot see.
//
// atlasGuard (#741) watches the shared atlas's PAGE STRUCTURES (count, fill)
// and repairs the page-merge corruption class. But macOS sleep→wake can trash
// the atlas's TEXTURE CONTENT on the GPU without firing webglcontextlost and
// without touching any page structure the poll reads: every pane then samples
// garbage pixels for perfectly consistent-looking pages, and no existing
// repair path fires (refresh() re-rasters from the same corrupted texture;
// PREVENT/CURE see nothing wrong). Observed in the field on v3.38.4, which
// already ships #741 — this module covers the residual class.
//
// Strategy (boundary-driven rebuild, adapted from Orca's wake-recovery design
// — idea only, no code imported; github.com/stablyai/orca,
// use-terminal-window-wake-recovery.ts): at the moments GPU state is suspect,
// unconditionally rebuild the shared atlas via atlasGuard.recoverNow — the
// same coherent clear+refresh-all PREVENT/CURE performs, so the #191
// stale-sibling hazard cannot occur.
//
// Triggers:
//   - system resume  — main's powerMonitor 'resume' over IPC. The decisive
//                      signal: texture memory is invalidated by sleep.
//   - visibility     — document became visible again. Backstop for the
//                      unlock-screen gap where the resume event can land
//                      while the window is still hidden and Chromium may
//                      re-jig GPU memory before first present.
//
// Window FOCUS is deliberately NOT a trigger: plain refocus (alt-tab) is
// frequent and often lands mid-stream, and wiping the shared atlas while
// output is flowing re-arms xterm's page-merge race (xterm.js #4480) — the
// same reason glyphRepaint's focus path never touches the atlas.
//
// ON WINDOWS THE VISIBILITY TRIGGER NEVER FIRES (#879). Measured on Electron
// 41: `document.visibilityState` stays 'visible' when the window is fully
// covered by another app AND when it is minimized, with or without Chromium's
// CalculateNativeWinOcclusion feature — `visibilitychange` fires once per
// window, at teardown. So on Windows `system-resumed` is the only live trigger
// here, and the plain "came back from alt-tab" case is covered by
// windowWakeRepaint.ts instead, which repaints (never touches the atlas, for
// the reason above).
//
// The two triggers routinely fire together on a real wake; the throttle
// collapses them into one rebuild.

import { atlasGuard } from './atlasGuard';

/** Minimum gap between rebuilds. Resume + visibilitychange arrive within
 *  milliseconds of each other on a real wake; one rebuild covers both. */
export const WAKE_RECOVER_THROTTLE_MS = 1_000;

export interface AtlasWakeRecoveryDeps {
  /** Subscribe to main's system-resumed push; returns the unsubscribe. */
  onSystemResumed(callback: () => void): () => void;
  recoverNow?: (reason: string) => void;
  documentRef?: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    visibilityState: DocumentVisibilityState;
  };
  now?: () => number;
}

/** Wire the wake triggers; returns the teardown. Called once from App. */
export function initAtlasWakeRecovery(deps: AtlasWakeRecoveryDeps): () => void {
  const {
    onSystemResumed,
    recoverNow = (reason) => atlasGuard.recoverNow(reason),
    documentRef = document,
    now = Date.now,
  } = deps;

  let lastRecoverAt = -Infinity;
  const recover = (reason: string): void => {
    const t = now();
    if (t - lastRecoverAt < WAKE_RECOVER_THROTTLE_MS) return;
    lastRecoverAt = t;
    recoverNow(reason);
  };

  const unsubscribeResumed = onSystemResumed(() => recover('system-resumed'));
  const onVisibilityChange = (): void => {
    if (documentRef.visibilityState === 'visible') recover('visibility');
  };
  documentRef.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    unsubscribeResumed();
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
