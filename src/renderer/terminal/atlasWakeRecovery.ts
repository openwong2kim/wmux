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
// The two triggers routinely fire together on a real wake; the throttle
// collapses them into one rebuild.
//
// THE VISIBILITY TRIGGER IS ARMED BY RESUME, NOT FIRED ON ITS OWN (#1234).
//
// A previous measurement on Electron 41 concluded that Windows never fires
// `visibilitychange` while the window is covered or minimized, and the trigger
// above was written on that assumption — a harmless macOS-only backstop. The
// #1234 field log falsifies it: on Windows 10.0.19045 the renderer logged
// `recover (visibility)` 18 times in 15 minutes of ordinary alt-tabbing, 12 of
// them 13-26 ms after a `[wmux:glyph-repaint] focus`. Chromium's native window
// occlusion does flip `visibilityState` on that build, so on Windows the
// visibility trigger IS the window-focus trigger — the one trigger this module
// deliberately refuses to have, because wiping the shared atlas while output is
// flowing re-arms xterm's page-merge race (11 of those 18 wipes landed within
// 1 s of a live output burst).
//
// So visibility alone no longer recovers. Its stated job is narrow: cover the
// unlock-screen gap where main's `resume` lands while the window is still
// hidden. That job needs a resume to exist. The trigger now fires only when a
// `system-resumed` push arrived within `RESUME_ARM_MS` — i.e. the machine
// really did sleep and texture memory really is suspect. Without a resume
// nothing invalidated the GPU's texture memory, so there is nothing to rebuild
// and a wipe is pure risk. A build whose main has no resume push at all
// (`hasSystemResumeSignal: false`) keeps the old unconditional behaviour,
// because for it visibility is the only wake signal there is.
//
// Anything that needs to know whether the window can be seen must still ask
// main instead of reading `visibilityState` (see main/window/windowDisplayed.ts,
// which is how the #766 viewer-visibility report gets its answer since #882).

import { atlasGuard } from './atlasGuard';

/** Minimum gap between rebuilds. Resume + visibilitychange arrive within
 *  milliseconds of each other on a real wake; one rebuild covers both. */
export const WAKE_RECOVER_THROTTLE_MS = 1_000;

/** How long a `system-resumed` push keeps the visibility trigger armed. A real
 *  wake delivers resume and the first `visibilitychange` within milliseconds of
 *  each other; the unlock-screen gap this backstop exists for can stretch that
 *  to however long the user takes to type a password. Ten seconds covers the
 *  gap without leaving the trigger armed for the next alt-tab. */
export const RESUME_ARM_MS = 10_000;

export interface AtlasWakeRecoveryDeps {
  /** Subscribe to main's system-resumed push; returns the unsubscribe. */
  onSystemResumed(callback: () => void): () => void;
  /** False when main exposes no resume push (an older build). Visibility is
   *  then the only wake signal available and recovers unconditionally, as it
   *  did before #1234. Defaults to true. */
  hasSystemResumeSignal?: boolean;
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
    hasSystemResumeSignal = true,
    recoverNow = (reason) => atlasGuard.recoverNow(reason),
    documentRef = document,
    now = Date.now,
  } = deps;

  let lastRecoverAt = -Infinity;
  let lastResumeAt = -Infinity;
  const recover = (reason: string): void => {
    const t = now();
    if (t - lastRecoverAt < WAKE_RECOVER_THROTTLE_MS) return;
    lastRecoverAt = t;
    recoverNow(reason);
  };

  const unsubscribeResumed = onSystemResumed(() => {
    lastResumeAt = now();
    recover('system-resumed');
  });
  const onVisibilityChange = (): void => {
    if (documentRef.visibilityState !== 'visible') return;
    // #1234: on Windows this fires on every alt-tab. Only a recent resume makes
    // the GPU's texture memory suspect; without one, skip the wipe. Logged at
    // Verbose so the next field report can tell "the guard never ran" from "the
    // guard ran and did not repair it".
    if (hasSystemResumeSignal && now() - lastResumeAt >= RESUME_ARM_MS) {
      console.debug('[wmux:atlas-wake] visibility ignored — no recent system-resumed');
      return;
    }
    recover('visibility');
  };
  documentRef.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    unsubscribeResumed();
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
